"use strict";
/*
  NWPS rip-current probability — pure-Node GRIB2 module
  =====================================================
  Returns a 0-100 rip-current occurrence probability for the Seaview Pier cell
  at the forecast hour nearest "now", or null. Replaces the wgrib2-dependent
  version: this one decodes the GRIB2 itself, so it has NO external dependency.

  WHY NO wgrib2:
    Discovery (node grib-inventory.js) confirmed MHX's CG1 file carries the
    standard NCEP field 10.1.4 = "Rip Current Occurrence Probability" (RIPCOP, %),
    that the grid is a regular lat/lon grid (template 3.0), and that every field
    uses simple packing (data representation template 5.0). Simple packing on a
    regular grid is decodable in a few lines of JS:
        Y = (R + X * 2^E) / 10^D
    where R is the reference value, E/D the binary/decimal scale factors, and X
    the packed integer for the grid point. So we download the (~50 MB) file once
    per hour, pull the single RIPCOP value at our point, and return it.

  HONEST CAVEATS (unchanged):
    NOAA rip-current guidance is experimental. NWPS runs are on-demand, so a
    fresh run isn't guaranteed; we walk back through recent cycles and return
    null on any miss, and the dashboard falls back to the categorical SRF risk.

  PATH (confirmed against NOMADS, NWS SCN 17-84):
    {base}/er.YYYYMMDD/mhx/CC/CG1/mhx_nwps_CG1_YYYYMMDD_HH00.grib2

  CLI:  node rip-model.js --discover   (lists fields + confirms RIPCOP presence)
*/

const fs = require("fs");
const os = require("os");
const path = require("path");

const CFG = {
  base: "https://nomads.ncep.noaa.gov/pub/data/nccf/com/nwps/prod",
  region: "er",                 // Eastern Region (MHX)
  wfo: "mhx",
  grid: "CG1",                  // rip-current field lives in the CG1 file
  cycles: [18, 12, 6, 0],       // try newest analysis cycle first
  point: { lon: -77.43, lat: 34.49 },   // Seaview Pier / New River Inlet end
  // The field we want, by GRIB2 identity (discipline, parameter category, number).
  // 10.1.4 = Rip Current Occurrence Probability (RIPCOP), units %.
  target: { discipline: 10, category: 1, number: 4 },
  targetLabel: "RIPCOP (rip current occurrence probability, %)",
  fetchTimeoutMs: 60000,
  cacheMs: 60 * 60 * 1000,
  downloadCacheMs: 60 * 60 * 1000      // reuse the on-disk GRIB for an hour
};

function pad(n, w) { return String(n).padStart(w || 2, "0"); }
function stamp(d) { return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()); }

/* ---------- run discovery (which file to fetch) ------------------------ */

async function httpGet(url, range) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CFG.fetchTimeoutMs);
  try {
    const res = await fetch(url, { headers: range ? { Range: "bytes=" + range } : {}, signal: ctrl.signal });
    if (!res.ok && res.status !== 206) throw new Error("HTTP " + res.status);
    return res;
  } finally { clearTimeout(timer); }
}
async function exists(url) {
  try { const r = await httpGet(url, "0-0"); return r.ok || r.status === 206; } catch (_) { return false; }
}
function fileName(run) { return CFG.wfo + "_nwps_" + run.grid + "_" + run.date + "_" + pad(run.cycle) + "00.grib2"; }
function gribUrl(run) {
  return [CFG.base, CFG.region + "." + run.date, CFG.wfo, pad(run.cycle), run.grid, fileName(run)].join("/");
}
function* candidates(now) {
  for (let back = 0; back <= 1; back++) {
    const d = new Date(now.getTime() - back * 86400000);
    const date = stamp(d);
    for (const cycle of CFG.cycles) {
      if (back === 0 && cycle > now.getUTCHours()) continue;
      yield { date, cycle, grid: CFG.grid };
    }
  }
}
async function resolveRun(now) {
  for (const run of candidates(now)) if (await exists(gribUrl(run))) return run;
  return null;
}

/* ---------- download (cached on disk) ---------------------------------- */

async function downloadGrib(run) {
  const cache = path.join(os.tmpdir(), "rip-" + fileName(run));
  try {
    const st = fs.statSync(cache);
    if (st.size > 1e6 && (Date.now() - st.mtimeMs) < CFG.downloadCacheMs) return fs.readFileSync(cache);
  } catch (_) {}
  const res = await httpGet(gribUrl(run));
  const buf = Buffer.from(await res.arrayBuffer());
  try { fs.writeFileSync(cache, buf); } catch (_) {}
  return buf;
}

/* ---------- minimal GRIB2 reader: simple packing + regular lat/lon ------ */

// GRIB2 templates encode signed scale factors as sign-magnitude, not two's complement.
function sm16(u) { return (u & 0x8000) ? -(u & 0x7fff) : u; }

// Walk every message, returning a light record per field with byte offsets into
// the sections we need (grid, packing, bitmap, data) so we can decode one point.
function parseMessages(buf) {
  const msgs = [];
  let pos = 0;
  while (pos + 16 <= buf.length) {
    if (buf.toString("latin1", pos, pos + 4) !== "GRIB") { pos++; continue; }
    const discipline = buf[pos + 6];
    const msgLen = Number(buf.readBigUInt64BE(pos + 8));
    const msgEnd = pos + msgLen;
    const m = { discipline, ref: null, fh: 0, category: null, number: null,
                grid: null, drt: null, packOff: null, bmpOff: null, dataOff: null };
    let sp = pos + 16;
    while (sp + 5 <= msgEnd) {
      if (buf.toString("latin1", sp, sp + 4) === "7777") break;
      const secLen = buf.readUInt32BE(sp);
      const secNum = buf[sp + 4];
      if (secLen < 5 || sp + secLen > msgEnd) break;
      switch (secNum) {
        case 1: {                                  // Identification: reference time
          m.ref = Date.UTC(buf.readUInt16BE(sp + 12), buf[sp + 14] - 1, buf[sp + 15],
                           buf[sp + 16], buf[sp + 17], buf[sp + 18]);
          break;
        }
        case 3: {                                  // Grid definition
          if (buf.readUInt16BE(sp + 12) === 0) {   // template 3.0: regular lat/lon
            m.grid = {
              ni: buf.readUInt32BE(sp + 30), nj: buf.readUInt32BE(sp + 34),
              la1: buf.readInt32BE(sp + 46) / 1e6, lo1: buf.readUInt32BE(sp + 50) / 1e6,
              la2: buf.readInt32BE(sp + 55) / 1e6, lo2: buf.readUInt32BE(sp + 59) / 1e6,
              di: buf.readUInt32BE(sp + 63) / 1e6, dj: buf.readUInt32BE(sp + 67) / 1e6,
              scan: buf[sp + 71]
            };
          }
          break;
        }
        case 4: {                                  // Product definition: which field + forecast time
          m.category = buf[sp + 9];
          m.number = buf[sp + 10];
          const unit = buf[sp + 17], ft = buf.readUInt32BE(sp + 18);
          const HRS = { 0: 1 / 60, 1: 1, 2: 24, 10: 3, 11: 6, 12: 12, 13: 1 / 3600 };
          m.fh = ft * (HRS[unit] != null ? HRS[unit] : 1);   // hours
          break;
        }
        case 5: {                                  // Data representation: simple packing params
          m.drt = buf.readUInt16BE(sp + 9);
          if (m.drt === 0) {
            m.packOff = {
              R: buf.readFloatBE(sp + 11),
              E: sm16(buf.readUInt16BE(sp + 15)),
              D: sm16(buf.readUInt16BE(sp + 17)),
              nbits: buf[sp + 19]
            };
          }
          break;
        }
        case 6: {                                  // Bitmap (land/sea mask), if present
          m.bmpOff = (buf[sp + 5] === 0) ? sp + 6 : (buf[sp + 5] === 255 ? null : -1);
          break;
        }
        case 7: {                                  // Data
          m.dataOff = sp + 5;
          break;
        }
      }
      sp += secLen;
    }
    if (m.ref != null) m.valid = m.ref + m.fh * 3600000;
    msgs.push(m);
    pos = msgEnd;
  }
  return msgs;
}

function readBits(buf, bitStart, n) {
  let v = 0;
  for (let i = 0; i < n; i++) {
    const bit = bitStart + i;
    v = v * 2 + ((buf[bit >> 3] >> (7 - (bit & 7))) & 1);
  }
  return v;
}

// Linear grid index for a lon/lat on a regular lat/lon grid, honoring scan mode.
function gridIndex(grid, lon, lat) {
  const lonE = ((lon % 360) + 360) % 360;          // file uses 0..360
  const lo1 = ((grid.lo1 % 360) + 360) % 360;
  let i = Math.round((lonE - lo1) / grid.di);
  let jFromLa1 = Math.round((lat - grid.la1) / grid.dj);
  if (i < 0 || i >= grid.ni || jFromLa1 < 0 || jFromLa1 >= grid.nj) return null;
  if (grid.scan & 0x80) i = grid.ni - 1 - i;        // i scans E->W
  const jUp = (grid.scan & 0x40) !== 0;             // j scans S->N (la1 is south)
  const j = jUp ? jFromLa1 : grid.nj - 1 - jFromLa1;
  return j * grid.ni + i;                            // i-consecutive (scan bit 0x20 = 0)
}

// Decode a single grid point of a simple-packed message.
function decodePoint(buf, m, lon, lat) {
  if (m.drt !== 0 || !m.grid || !m.packOff || m.dataOff == null) return null;
  if (m.bmpOff === -1) return null;                  // pre-defined bitmap: unsupported, bail safely
  const gi = gridIndex(m.grid, lon, lat);
  if (gi == null) return null;

  let dataIdx = gi;
  if (m.bmpOff != null) {                            // bitmap present: remap to packed index
    const present = (buf[m.bmpOff + (gi >> 3)] >> (7 - (gi & 7))) & 1;
    if (!present) return null;                       // masked (land / missing) at our point
    dataIdx = 0;
    for (let k = 0; k < gi; k++) dataIdx += (buf[m.bmpOff + (k >> 3)] >> (7 - (k & 7))) & 1;
  }

  const { R, E, D, nbits } = m.packOff;
  const X = nbits === 0 ? 0 : readBits(buf, m.dataOff * 8 + dataIdx * nbits, nbits);
  return (R + X * Math.pow(2, E)) / Math.pow(10, D);
}

function nearest(list, when) {
  const t = when.getTime();
  return list.slice().sort((a, b) => Math.abs((a.valid || 0) - t) - Math.abs((b.valid || 0) - t))[0];
}
function normalize(val) {
  if (val == null || !isFinite(val) || val > 1e19) return null;   // 9.999e20 = missing
  const pct = val <= 1.5 ? val * 100 : val;                       // accept 0-1 or 0-100
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/* ---------- public API -------------------------------------------------- */

let cache = null;
async function getRipProbability(opts) {
  const when = (opts && opts.when) || new Date();
  if (cache && (Date.now() - cache.ts) < CFG.cacheMs) return cache.val;

  const run = await resolveRun(new Date());
  if (!run) { cache = { val: null, ts: Date.now() }; return null; }

  let buf;
  try { buf = await downloadGrib(run); }
  catch (e) { console.warn("[rip-model] download failed: " + e.message); cache = { val: null, ts: Date.now() }; return null; }

  const T = CFG.target;
  const rips = parseMessages(buf).filter(m =>
    m.discipline === T.discipline && m.category === T.category && m.number === T.number && m.valid != null);
  if (!rips.length) {
    console.warn("[rip-model] " + fileName(run) + " has no " + CFG.targetLabel +
      " record — run `node rip-model.js --discover` to re-check.");
    cache = { val: null, ts: Date.now() }; return null;
  }
  const raw = decodePoint(buf, nearest(rips, when), CFG.point.lon, CFG.point.lat);
  const val = normalize(raw);
  cache = { val, ts: Date.now() };
  return val;
}

/* ---------- discovery CLI ---------------------------------------------- */

async function discover() {
  const run = await resolveRun(new Date());
  if (!run) {
    console.log("No NWPS run file found for " + CFG.region + "/" + CFG.wfo + "/" + CFG.grid +
      " in the last ~2 days (runs are on-demand, so gaps are normal).");
    return;
  }
  console.log("Found run file:\n  " + gribUrl(run) + "\n");
  const buf = await downloadGrib(run);
  const msgs = parseMessages(buf);

  const distinct = new Map();
  msgs.forEach(m => {
    const k = m.discipline + "." + m.category + "." + m.number;
    distinct.set(k, (distinct.get(k) || 0) + 1);
  });
  console.log("Distinct fields (discipline.category.number x count):");
  [...distinct.entries()].sort().forEach(([k, n]) => console.log("  " + k.padEnd(12) + " x" + n));

  const T = CFG.target, key = T.discipline + "." + T.category + "." + T.number;
  console.log("\nTarget " + key + " = " + CFG.targetLabel + ": " + (distinct.has(key) ? "PRESENT" : "ABSENT"));
  if (distinct.has(key)) {
    const rips = msgs.filter(m => m.discipline === T.discipline && m.category === T.category && m.number === T.number && m.valid);
    const m = nearest(rips, new Date());
    const raw = decodePoint(buf, m, CFG.point.lon, CFG.point.lat);
    console.log("  nearest forecast hour value at Seaview Pier (" + CFG.point.lon + "," + CFG.point.lat + "): " +
      "raw=" + raw + "  ->  " + normalize(raw) + "%  (valid " + new Date(m.valid).toISOString() + ")");
  }
}

module.exports = { getRipProbability, discover, CFG, parseMessages, decodePoint };

if (require.main === module && process.argv.includes("--discover")) {
  discover().catch(e => console.error(e.message));
}
