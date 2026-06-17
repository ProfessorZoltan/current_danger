"use strict";
/*
  NWPS rip-current probability — GRIB2 module
  ===========================================
  Returns a 0-100 number for the Seaview Pier cell at the forecast hour nearest
  "now", or null. Replaces the fetchRipModelProb() stub in server.js.

  ┌─ EXPERIMENTAL, AND POSSIBLY NOT PRESENT FOR MHX ───────────────────────┐
  │ NOAA's rip-current guidance is experimental, produced at a handful of   │
  │ pilot WFOs, and its GRIB2 delivery is a new NWPS v1.5.0 addition first  │
  │ called out for other regions. Whether MHX's CG1 file carries it — and   │
  │ under what name — is UNCONFIRMED. So this module discovers the variable │
  │ from the live file and returns null on any miss; the dashboard then     │
  │ shows the categorical SRF risk it already has. Never an authoritative   │
  │ number; always experimental guidance.                                   │
  └────────────────────────────────────────────────────────────────────────┘

  PATH (confirmed against NOMADS, NWS SCN 17-84):
    {base}/er.YYYYMMDD/mhx/CC/CG1/mhx_nwps_CG1_YYYYMMDD_HH00.grib2
    (only the CG0 "tracking" file carries the _Trkng_ infix; CG1 does not.)

  DEPENDENCY: wgrib2 (https://www.cpc.ncep.noaa.gov/products/wesley/wgrib2/).
  Needed to decode values. Two extraction paths:
    - fast: if a .idx sidecar exists, byte-range only the rip record.
    - fallback: no .idx -> download the (few-MB) CG1 file and inventory it.
  Run `node rip-model.js --discover` first to confirm availability + var name.
*/

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CFG = {
  base: "https://nomads.ncep.noaa.gov/pub/data/nccf/com/nwps/prod",
  region: "er",                 // Eastern Region (MHX)
  wfo: "mhx",
  grid: "CG1",                  // rip-current fields (v1.5) live in the CG1 file
  cycles: [18, 12, 6, 0],       // try newest analysis cycle first
  point: { lon: -77.43, lat: 34.49 },   // Seaview Pier / New River Inlet end
  // ERE/JS regex used both to filter the .idx and as wgrib2 -match. UNCONFIRMED
  // for MHX — run --discover to see the real inventory, then set this exactly.
  ripMatch: "[Rr][Ii][Pp]",
  wgrib2: "wgrib2",
  fetchTimeoutMs: 30000,
  cacheMs: 60 * 60 * 1000
};

function pad(n, w) { return String(n).padStart(w || 2, "0"); }
function stamp(d) { return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()); }

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

function fileName(run) {
  return run.grid === "CG0"
    ? CFG.wfo + "_nwps_CG0_Trkng_" + run.date + "_" + pad(run.cycle) + "00.grib2"
    : CFG.wfo + "_nwps_" + run.grid + "_" + run.date + "_" + pad(run.cycle) + "00.grib2";
}
function gribUrl(run) {
  return [CFG.base, CFG.region + "." + run.date, CFG.wfo, pad(run.cycle), run.grid, fileName(run)].join("/");
}
function idxUrl(run) { return gribUrl(run) + ".idx"; }

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
  for (const run of candidates(now)) {
    if (await exists(gribUrl(run))) return run;
  }
  return null;
}

function parseIdx(text) {
  const lines = text.trim().split("\n").filter(Boolean);
  const recs = lines.map(function (line) {
    const f = line.split(":");
    const dm = (f[2] || "").match(/d=(\d{10})/);
    const ref = dm ? Date.UTC(+dm[1].slice(0, 4), +dm[1].slice(4, 6) - 1, +dm[1].slice(6, 8), +dm[1].slice(8, 10)) : null;
    const fh = (f[5] || "").match(/(\d+)\s*hour/);
    const hours = (f[5] || "").indexOf("anl") > -1 ? 0 : (fh ? +fh[1] : 0);
    return { offset: +f[1], raw: line, valid: ref != null ? ref + hours * 3600000 : null };
  });
  for (let i = 0; i < recs.length; i++) recs[i].next = recs[i + 1] ? recs[i + 1].offset : null;
  return recs;
}
function nearest(list, when) {
  const t = when.getTime();
  return list.slice().sort((a, b) => Math.abs((a.valid || 0) - t) - Math.abs((b.valid || 0) - t))[0];
}

function wgrib2Available() {
  return new Promise(res => execFile(CFG.wgrib2, ["-version"], { timeout: 5000 }, err => res(!err)));
}
function wgrib2Run(args) {
  return new Promise((resolve, reject) =>
    execFile(CFG.wgrib2, args, { timeout: 60000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => err ? reject(err) : resolve(stdout)));
}
function tmpFile(buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rip-"));
  const file = path.join(dir, "f.grib2");
  if (buf) fs.writeFileSync(file, buf);
  return { dir, file };
}
function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }

function normalize(val) {
  if (val == null || !isFinite(val) || val > 1e19) return null;   // 9.999e20 = missing
  const pct = val <= 1.5 ? val * 100 : val;                       // 0-1 -> 0-100
  return Math.max(0, Math.min(100, Math.round(pct)));
}
function parseVals(stdout) {
  const out = [];
  stdout.split("\n").forEach(function (line) {
    const xm = line.match(/val=([\-\d.eE+]+)/);
    if (!xm) return;
    const vm = line.match(/vt=(\d{10})/);
    const valid = vm ? Date.UTC(+vm[1].slice(0, 4), +vm[1].slice(4, 6) - 1, +vm[1].slice(6, 8), +vm[1].slice(8, 10)) : null;
    out.push({ valid, val: parseFloat(xm[1]) });
  });
  return out;
}

async function viaIdx(run, when) {
  let res;
  try { res = await httpGet(idxUrl(run)); } catch (_) { return { noIdx: true }; }
  const recs = parseIdx(await res.text());
  const re = new RegExp(CFG.ripMatch);
  const rip = recs.filter(r => re.test(r.raw));
  if (!rip.length) return { noField: true };
  const rec = nearest(rip, when);
  const range = rec.offset + "-" + (rec.next != null ? rec.next - 1 : "");
  const gres = await httpGet(gribUrl(run), range);
  const buf = Buffer.from(await gres.arrayBuffer());
  const t = tmpFile(buf);
  try {
    const out = await wgrib2Run([t.file, "-lon", String(CFG.point.lon), String(CFG.point.lat)]);
    const vals = parseVals(out);
    return { val: vals.length ? vals[0].val : null };
  } finally { cleanup(t.dir); }
}

async function viaFull(run, when) {
  const gres = await httpGet(gribUrl(run));
  const buf = Buffer.from(await gres.arrayBuffer());
  const t = tmpFile(buf);
  try {
    const out = await wgrib2Run([t.file, "-match", CFG.ripMatch, "-vt", "-lon", String(CFG.point.lon), String(CFG.point.lat)]);
    const vals = parseVals(out).filter(v => v.val != null);
    if (!vals.length) return { noField: true };
    return { val: nearest(vals, when).val };
  } finally { cleanup(t.dir); }
}

let cache = null;
async function getRipProbability(opts) {
  const when = (opts && opts.when) || new Date();
  if (cache && (Date.now() - cache.ts) < CFG.cacheMs) return cache.val;

  const run = await resolveRun(new Date());
  if (!run) { cache = { val: null, ts: Date.now() }; return null; }

  let r = await viaIdx(run, when);
  if (r.noIdx) {
    if (!(await wgrib2Available())) {
      console.warn("[rip-model] no .idx and wgrib2 not installed; cannot extract.");
      cache = { val: null, ts: Date.now() }; return null;
    }
    r = await viaFull(run, when);
  }
  if (r.noField) {
    console.warn("[rip-model] no record matching /" + CFG.ripMatch + "/ in " + fileName(run) +
      " — run `node rip-model.js --discover` to find the real name or confirm absence.");
    cache = { val: null, ts: Date.now() }; return null;
  }
  const val = normalize(r.val);
  cache = { val: val, ts: Date.now() };
  return val;
}

async function discover() {
  const run = await resolveRun(new Date());
  if (!run) {
    console.log("No NWPS run file found for " + CFG.region + "/" + CFG.wfo + "/" + CFG.grid +
      " in the last ~2 days (runs are on-demand, so gaps are normal).");
    return;
  }
  console.log("Found run file:\n  " + gribUrl(run) + "\n");

  try {
    const res = await httpGet(idxUrl(run));
    const text = await res.text();
    console.log("Inventory (.idx):\n" + text.trim());
    reportMatches(text);
    return;
  } catch (_) {
    console.log("No .idx sidecar. Falling back to a wgrib2 inventory of the file...\n");
  }

  if (!(await wgrib2Available())) {
    console.log("The run file EXISTS (path is correct), but there's no .idx and wgrib2 isn't installed.");
    console.log("Install wgrib2 to inventory it, or browse it via the NOMADS grib filter:");
    console.log("  https://nomads.ncep.noaa.gov/gribfilter.php?ds=ernwps");
    return;
  }
  const gres = await httpGet(gribUrl(run));
  const buf = Buffer.from(await gres.arrayBuffer());
  const t = tmpFile(buf);
  try {
    const out = await wgrib2Run([t.file]);
    console.log("Inventory (wgrib2):\n" + out.trim());
    reportMatches(out);
  } finally { cleanup(t.dir); }
}

function reportMatches(text) {
  const re = new RegExp(CFG.ripMatch);
  const hits = text.trim().split("\n").filter(l => re.test(l));
  console.log("\nMatches for /" + CFG.ripMatch + "/ (" + hits.length + "):");
  hits.forEach(l => console.log("  " + l));
  if (!hits.length) console.log("  (none — adjust CFG.ripMatch to a name you see above, or MHX's CG1 doesn't carry the rip field yet)");
}

module.exports = { getRipProbability, discover, CFG };

if (require.main === module && process.argv.includes("--discover")) {
  discover().catch(e => console.error(e.message));
}
