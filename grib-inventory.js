"use strict";
/*
  grib-inventory.js — dependency-free GRIB2 inventory
  ===================================================
  wgrib2 isn't available on this box and NWPS on-demand runs ship no .idx,
  so we decode the file's structure ourselves. GRIB2 identifies every field by
  numeric codes in fixed header positions (no plain-text names), so we walk the
  sections and map (discipline, category, number) to WMO/NCEP table 4.2 names.

  Goal: settle whether MHX's CG1 carries an (experimental) rip-current field.
  Anything in the oceanographic discipline that isn't a standard wave/current/
  water-level field — especially local categories/params (>=192) — is the flag.

  Usage:  node grib-inventory.js [gribUrlOrLocalPath]
  Default URL is the run discovered by rip-model.js.
*/

const fs = require("fs");
const os = require("os");
const path = require("path");

const DRT = { 0: "simple", 2: "complex", 3: "complex+spatial", 4: "IEEE float", 40: "JPEG2000", 41: "PNG", 42: "CCSDS/AEC" };

const DEFAULT_URL =
  "https://nomads.ncep.noaa.gov/pub/data/nccf/com/nwps/prod/er.20260617/mhx/12/CG1/mhx_nwps_CG1_20260617_1200.grib2";

const DISCIPLINE = { 0: "Meteorological", 1: "Hydrological", 2: "Land", 10: "Oceanographic" };

// WMO/NCEP table 4.2 names, keyed "discipline.category.number".
const NAMES = {
  // Meteorological (disc 0)
  "0.2.2": "UGRD (u-wind)", "0.2.3": "VGRD (v-wind)",
  "0.2.0": "WDIR (wind dir)", "0.2.1": "WIND (wind speed)",
  "0.2.22": "WIND gust", "0.2.17": "U-component of wind stress",
  // Oceanographic waves (disc 10, cat 0)
  "10.0.0": "WVSP1", "10.0.3": "HTSGW (sig wave height)",
  "10.0.4": "WVDIR (wind-wave dir)", "10.0.5": "WVHGT (wind-wave height)",
  "10.0.6": "WVPER (wind-wave period)", "10.0.7": "SWDIR (swell dir)",
  "10.0.8": "SWELL (swell height)", "10.0.9": "SWPER (swell period)",
  "10.0.10": "DIRPW (primary wave dir)", "10.0.11": "PERPW (primary wave period)",
  "10.0.12": "DIRSW (secondary wave dir)", "10.0.13": "PERSW (secondary wave period)",
  "10.0.14": "WVDIR combined", "10.0.45": "Wave steepness",
  "10.0.46": "Wave length", "10.0.48": "Peak wave period",
  // Oceanographic currents (disc 10, cat 1)
  "10.1.0": "DIRC (current dir)", "10.1.1": "SPC (current speed)",
  "10.1.2": "UOGRD (u-current)", "10.1.3": "VOGRD (v-current)",
  // Oceanographic surface (disc 10, cat 3)
  "10.3.0": "WTMP (water temp)", "10.3.1": "DSLM (sea level deviation)",
  "10.4.2": "WTMP subsurface",
  // Sea ice etc.
  "10.2.0": "ICEC (ice cover)",
};

function fhUnit(u) {
  return { 0: "min", 1: "hr", 2: "day", 10: "3hr", 11: "6hr", 12: "12hr", 13: "sec" }[u] || ("u" + u);
}
function surface(type, scale, val) {
  const TYPES = { 1: "surface", 8: "top of atmosphere", 101: "mean sea level", 160: "depth below sea surface", 255: "n/a" };
  if (type === 255 || val === 0xffffffff) return TYPES[type] || ("type" + type);
  let v = val;
  if (scale && scale !== 0 && scale !== 0xff) v = val / Math.pow(10, scale > 127 ? scale - 256 : scale);
  return (TYPES[type] || ("type" + type)) + (v ? " " + v : "");
}

async function load(src) {
  if (!/^https?:/i.test(src)) return fs.readFileSync(src);
  // Cache the 52 MB download in the OS temp dir so reruns are instant.
  const cache = path.join(os.tmpdir(), "rip-" + src.split("/").pop());
  if (fs.existsSync(cache) && fs.statSync(cache).size > 1e6) {
    process.stderr.write("Using cached " + cache + "\n");
    return fs.readFileSync(cache);
  }
  process.stderr.write("Downloading " + src + " ...\n");
  const res = await fetch(src);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(cache, buf);
  process.stderr.write("Got " + (buf.length / 1e6).toFixed(1) + " MB -> cached " + cache + "\n");
  return buf;
}

function scan(buf) {
  const recs = [];
  let pos = 0, msg = 0;
  while (pos + 16 <= buf.length) {
    if (buf.toString("latin1", pos, pos + 4) !== "GRIB") { pos++; continue; }
    msg++;
    const discipline = buf[pos + 6];
    const msgLen = Number(buf.readBigUInt64BE(pos + 8));
    const msgEnd = pos + msgLen;
    let sp = pos + 16;
    let cur = { discipline, category: null, number: null, pdtn: null, fh: null, level: null, drt: null };
    while (sp + 4 <= msgEnd) {
      if (buf.toString("latin1", sp, sp + 4) === "7777") { sp += 4; break; }
      const secLen = buf.readUInt32BE(sp);
      const secNum = buf[sp + 4];
      if (secLen < 5 || sp + secLen > msgEnd) break;
      if (secNum === 4) {
        cur.pdtn = buf.readUInt16BE(sp + 7);
        cur.category = buf[sp + 9];
        cur.number = buf[sp + 10];
        // template 4.0/4.8 share this prefix layout
        cur.fh = buf.readUInt32BE(sp + 18) + fhUnit(buf[sp + 17]);
        cur.level = surface(buf[sp + 22], buf[sp + 23], buf.readUInt32BE(sp + 24));
      }
      if (secNum === 5) cur.drt = buf.readUInt16BE(sp + 9);   // data representation template number
      if (secNum === 3 && !global.__grid) {                    // grid definition (same for all fields)
        const gdt = buf.readUInt16BE(sp + 12);
        global.__grid = { gdt: gdt };
        if (gdt === 0) {                                        // lat/lon regular
          const g = global.__grid;
          g.ni = buf.readUInt32BE(sp + 30); g.nj = buf.readUInt32BE(sp + 34);
          g.la1 = buf.readInt32BE(sp + 46) / 1e6; g.lo1 = buf.readUInt32BE(sp + 50) / 1e6;
          g.la2 = buf.readInt32BE(sp + 55) / 1e6; g.lo2 = buf.readUInt32BE(sp + 59) / 1e6;
          g.di = buf.readUInt32BE(sp + 63) / 1e6; g.dj = buf.readUInt32BE(sp + 67) / 1e6;
          g.scan = buf[sp + 71];
        }
      }

      sp += secLen;
    }
    recs.push(cur);
    pos = msgEnd;
  }
  return recs;
}

(async function main() {
  const src = process.argv[2] || DEFAULT_URL;
  const buf = await load(src);
  const recs = scan(buf);

  console.log("\nMessages: " + recs.length + "\n");
  console.log("  # | disc.cat.num | pdtn | fhr   | level                | name");
  console.log("  --+--------------+------+-------+----------------------+----------------------------");
  const seen = new Map();
  recs.forEach((r, i) => {
    const key = r.discipline + "." + r.category + "." + r.number;
    seen.set(key, (seen.get(key) || 0) + 1);
    console.log(
      "  " + String(i + 1).padStart(2) + " | " +
      key.padEnd(12) + " | " + String(r.pdtn).padStart(4) + " | " +
      String(r.fh).padStart(5) + " | " + String(r.level).padEnd(20) + " | " +
      (NAMES[key] || "UNKNOWN"));
  });

  console.log("\nDistinct fields (discipline.category.number):");
  [...seen.entries()].sort().forEach(([k, n]) => {
    const d = DISCIPLINE[k.split(".")[0]] || "?";
    console.log("  " + k.padEnd(12) + " x" + n + "  [" + d + "]  " + (NAMES[k] || "UNKNOWN — candidate for inspection"));
  });

  // Packing per field (decides whether pure-Node value extraction is feasible).
  console.log("\nGrid definition: " + JSON.stringify(global.__grid));
  if (global.__grid && global.__grid.gdt === 0) {
    const g = global.__grid;
    const inLon = (-77.43 >= Math.min(g.lo1, g.lo2) - 360 * 0 && true);
    console.log("  point lon=-77.43 lat=34.49 within lon[" + g.lo1 + "," + g.lo2 + "] lat[" + g.la1 + "," + g.la2 + "]? " +
      (((-77.43 % 360 + 360) % 360 >= Math.min(g.lo1, g.lo2) && (-77.43 % 360 + 360) % 360 <= Math.max(g.lo1, g.lo2)) &&
        (34.49 >= Math.min(g.la1, g.la2) && 34.49 <= Math.max(g.la1, g.la2))));
  }
  console.log("\nData packing by field:");
  const pack = new Map();
  recs.forEach(r => {
    const k = r.discipline + "." + r.category + "." + r.number;
    if (!pack.has(k)) pack.set(k, r.drt);
  });
  [...pack.entries()].sort().forEach(([k, drt]) =>
    console.log("  " + k.padEnd(12) + " drt=" + drt + " (" + (DRT[drt] || "?") + ")" +
      (k === "10.1.4" ? "   <-- RIPCOP" : "")));

  // Rip analysis: oceanographic fields that are not standard waves/currents/water-level.
  const ocean = [...seen.keys()].filter(k => k.startsWith("10."));
  const standard = new Set(Object.keys(NAMES).filter(k => k.startsWith("10.")));
  const exotic = ocean.filter(k => {
    const [, cat, num] = k.split(".").map(Number);
    return !standard.has(k) || cat >= 192 || num >= 192;
  });
  console.log("\n--- Rip-current verdict ---");
  if (!ocean.length) {
    console.log("No oceanographic (discipline 10) fields at all. No rip field here.");
  } else if (!exotic.length) {
    console.log("Oceanographic fields are all standard waves/currents/water-level.");
    console.log("=> No experimental rip-current field in this CG1. Stay on the SRF category (Branch 2).");
  } else {
    console.log("Non-standard / local oceanographic field(s) present — possible rip candidate(s):");
    exotic.forEach(k => console.log("  " + k + (NAMES[k] ? "  " + NAMES[k] : "  (not in standard table)")));
    console.log("Inspect these to confirm; if one is rip probability, wire CFG.ripMatch to it.");
  }
})().catch(e => { console.error(e.message); process.exit(1); });
