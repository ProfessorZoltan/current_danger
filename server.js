"use strict";
/*
  North Topsail / Seaview Pier — conditions aggregator
  ====================================================
  Polls public NOAA/NWS sources, normalizes them into the JSON the dashboard
  expects, and serves it at GET /conditions. No external dependencies.

  RUN:  node server.js          (requires Node 18+ for global fetch)
  THEN: in seaview-pier-dashboard.html set
        CONFIG.dataEndpoint = "http://localhost:8787/conditions"

  WHY A BACKEND EXISTS AT ALL
  - NDBC buoy files send no CORS headers, so a browser can't fetch them.
  - The NOAA rip-current *model* probability ships as GRIB2, not JSON.
  - Server-side we have neither restriction, and we can cache + fail safe.

  SOURCING (honest about what each field is)
  - Rip risk LEVEL  -> NWS Surf Zone Forecast text, zone NCZ199 (forecast)
  - Rip PROBABILITY -> NWPS model field 10.1.4 (RIPCOP, %) decoded from GRIB2
                       in pure Node by ./rip-model. Null when no recent on-demand
                       run is published; dashboard then shows just the SRF level.
  - Surf / period / water temp -> NDBC Waverider buoy (live observation)
  - Wind -> Surf Zone Forecast text (forecast; Waverider buoys have no wind)
  - Tide series -> CO-OPS predictions, station 8657167 New River Inlet
*/

const http = require("http");
const fs = require("fs");
const nodePath = require("path");

// GRIB2 rip-current module (pure Node, no external deps). A missing module or
// no recent NWPS run -> null, and the dashboard falls back to the categorical
// SRF risk. Never fatal.
let ripModel = null;
try { ripModel = require("./rip-model"); } catch (_) { /* module absent */ }

const CONFIG = {
  host: "0.0.0.0",
  port: Number(process.env.PORT) || 8787,   // cloud hosts inject PORT; 8787 locally
  allowOrigin: "*",                 // tighten to your site's origin in production
  refreshMs: 5 * 60 * 1000,
  fetchTimeoutMs: 10000,
  srf: {
    url: "https://tgftp.nws.noaa.gov/data/raw/fz/fzus52.kmhx.srf.mhx.txt",
    zone: "NCZ199"
  },
  buoyIds: ["41109", "41159", "41037"],   // New River Inlet -> Onslow Bay -> Wrightsville
  buoyStaleMinutes: 120,
  // New River Inlet (8657167) is a water-level station with NO harmonic tide
  // predictions, so datagetter returns a datum error. Use the nearest harmonic
  // ocean station that does support predictions, as a labeled proxy.
  tideStation: "8658163",                 // Wrightsville Beach, NC (~30 mi SW)
  tideStationName: "Wrightsville Beach (proxy)",
  cam: {
    check: true,
    m3u8: "https://www.surfchex.com/hls/svfp/index.m3u8"
  }
};

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

async function httpGet(url, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.fetchTimeoutMs);
  try {
    const res = await fetch(url, { headers: headers || {}, signal: ctrl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function compass(deg) {
  if (deg == null || isNaN(deg)) return "";
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
}

function etDateString(d) {
  // YYYYMMDD in America/New_York, so "today" matches the station's local day
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(d).reduce((o, p) => (o[p.type] = p.value, o), {});
  return parts.year + parts.month + parts.day;
}

const DIR_WORDS = {
  north:"N", south:"S", east:"E", west:"W",
  northeast:"NE", northwest:"NW", southeast:"SE", southwest:"SW",
  "north-northeast":"NNE","north-northwest":"NNW","south-southeast":"SSE","south-southwest":"SSW",
  "east-northeast":"ENE","east-southeast":"ESE","west-northwest":"WNW","west-southwest":"WSW"
};
function shortWind(phrase) {
  if (!phrase) return "—";
  const m = phrase.match(/\b(north|south|east|west|northeast|northwest|southeast|southwest|north-northeast|north-northwest|south-southeast|south-southwest|east-northeast|east-southeast|west-northwest|west-southwest)\b\s+winds?\s+(?:around\s+|up to\s+|at\s+|near\s+)?(\d+)/i);
  if (m) return DIR_WORDS[m[1].toLowerCase()] + " " + m[2];
  if (/light|variable|calm/i.test(phrase)) return phrase.replace(/\s+/g, " ").trim().slice(0, 22);
  return phrase.replace(/\s+/g, " ").trim().slice(0, 22);
}

/* ------------------------------------------------------------------ */
/* sources                                                            */
/* ------------------------------------------------------------------ */

async function fetchSurfZoneForecast() {
  const text = await httpGet(CONFIG.srf.url);
  const segments = text.split("$$");
  const seg = segments.find(s => s.indexOf(CONFIG.srf.zone) !== -1);
  if (!seg) throw new Error("Zone " + CONFIG.srf.zone + " not found in SRF");

  const rip = (seg.match(/Rip Current Risk[^A-Za-z]*?(High|Moderate|Low)/i) || [])[1] || null;
  const surfM = seg.match(/Surf Height[.\s]*([0-9][^.\n]*?feet)/i);
  const surf = surfM ? surfM[1].replace(/feet/i, "ft").replace(/\s+/g, " ").trim() : null;
  const windM = seg.match(/Winds?[.\s]*([^.\n]+)/i);
  const wind = windM ? shortWind(windM[1]) : "—";

  return {
    rip: rip ? (rip.charAt(0).toUpperCase() + rip.slice(1).toLowerCase()) : null,
    surf, wind
  };
}

function parseBuoy(text) {
  const rows = text.split("\n").filter(l => l && l[0] !== "#");
  if (!rows.length) throw new Error("no data rows");
  const f = rows[0].trim().split(/\s+/);
  const num = i => (f[i] === "MM" || f[i] === undefined ? null : parseFloat(f[i]));

  const ts = Date.UTC(+f[0], (+f[1]) - 1, +f[2], +f[3], +f[4]);
  const ageMin = Math.round((Date.now() - ts) / 60000);

  const wvht = num(8), dpd = num(9), wtmp = num(14);
  return {
    ageMin,
    surf: wvht != null ? Math.round(wvht * 3.28084) + " ft" : null,
    period: dpd != null ? Math.round(dpd) + " s" : null,
    water: wtmp != null ? Math.round(wtmp * 9 / 5 + 32) + "\u00B0F" : null
  };
}

async function fetchBuoy() {
  let best = null, bestId = null, usedFallback = false, firstTried = CONFIG.buoyIds[0];
  for (const id of CONFIG.buoyIds) {
    try {
      const text = await httpGet("https://www.ndbc.noaa.gov/data/realtime2/" + id + ".txt");
      const p = parseBuoy(text);
      if (p.surf == null && p.water == null) continue;       // station online but empty
      if (p.ageMin <= CONFIG.buoyStaleMinutes) {
        return { id, usedFallback: id !== firstTried, ageMin: p.ageMin, surf: p.surf, period: p.period, water: p.water };
      }
      if (!best || p.ageMin < best.ageMin) { best = p; bestId = id; usedFallback = id !== firstTried; }
    } catch (_) { /* try next */ }
  }
  if (best) return { id: bestId, usedFallback, stale: true, ageMin: best.ageMin, surf: best.surf, period: best.period, water: best.water };
  throw new Error("no buoy returned usable data");
}

async function fetchTides() {
  const day = etDateString(new Date());
  const url = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
    + "?product=predictions&application=northtopsail-safety"
    + "&station=" + CONFIG.tideStation
    + "&begin_date=" + day + "&end_date=" + day
    + "&datum=MLLW&time_zone=lst_ldt&units=english&interval=h&format=json";
  const text = await httpGet(url);
  const data = JSON.parse(text);
  if (!data.predictions || !data.predictions.length) throw new Error("no tide predictions");
  const series = data.predictions.map(p => ({
    t: p.t.replace(" ", "T") + ":00",   // local naive ISO; browser parses as local (ET users)
    h: Math.round(parseFloat(p.v) * 100) / 100
  }));
  return { datum: "MLLW", station: CONFIG.tideStationName, series };
}

async function fetchCamStatus() {
  if (!CONFIG.cam.check) return "warn";
  try {
    await httpGet(CONFIG.cam.m3u8, { "User-Agent": "Mozilla/5.0 (northtopsail-safety health check)" });
    return "ok";
  } catch (_) {
    return "warn";   // unknown rather than down — avoid false alarms on a feed we don't own
  }
}

async function fetchRipModelProb() {
  // Delegated to ./rip-model (NWPS GRIB2, decoded in pure Node). Returns 0-100
  // or null. Null when MHX has no recent on-demand run; the dashboard then
  // shows the categorical SRF risk only.
  if (!ripModel) return null;
  return await ripModel.getRipProbability({ when: new Date() });
}

/* ------------------------------------------------------------------ */
/* swim-safety windows (derived from the NWPS hourly model series)    */
/* ------------------------------------------------------------------ */

const SWIM = {
  bands: [                                                       // score -> relative risk
    { key: "lower",    label: "Lower risk",    max: 34 },
    { key: "moderate", label: "Moderate risk", max: 67 },
    { key: "higher",   label: "Higher risk",   max: Infinity }
  ],
  horizonH: 48,      // hourly strip length
  windowDays: 4,     // search this far ahead for best windows
  maxWindows: 5
};

// Sun altitude (degrees above horizon) at a UTC instant — robust at all hours,
// no day-boundary issues. Daylight when the sun is above the standard -0.833°.
function sunAltitudeDeg(ms, lat, lon) {
  const rad = Math.PI / 180;
  const dDays = ms / 86400000 - 10957.5;                 // days since 2000-01-01T12:00Z
  const g = (357.529 + 0.98560028 * dDays) % 360;        // mean anomaly
  const q = (280.459 + 0.98564736 * dDays) % 360;        // mean longitude
  const L = (q + 1.915 * Math.sin(g * rad) + 0.020 * Math.sin(2 * g * rad)) % 360;  // ecliptic lon
  const e = 23.439 - 0.00000036 * dDays;                 // obliquity
  const RA = Math.atan2(Math.cos(e * rad) * Math.sin(L * rad), Math.cos(L * rad));
  const dec = Math.asin(Math.sin(e * rad) * Math.sin(L * rad));
  const GMST = (280.46061837 + 360.98564736629 * dDays) % 360;
  const ha = (GMST + lon) * rad - RA;                    // local hour angle
  const alt = Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha));
  return alt / rad;
}
function isDaylight(ms, lat, lon) { return sunAltitudeDeg(ms, lat, lon) > -0.833; }

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
// Rip-current probability (%) is the spine of the score; surf, wind, and
// nearshore current are additive bumps that can only raise the risk. This lets
// a high rip probability reach the top band on its own, as it should.
function swimScore(h) {
  let s = h.ripPct || 0;
  if (h.waveFt != null) s += clamp((h.waveFt - 2) * 5, 0, 20);   // surf:  2 ft -> 0, 6 ft -> +20
  if (h.windKt != null) s += clamp((h.windKt - 12) * 1, 0, 10);  // wind:  12 kt -> 0, 22 kt -> +10
  if (h.currKt != null) s += clamp((h.currKt - 1) * 10, 0, 15);  // curr:  1 kt -> 0, 2.5 kt -> +15
  return Math.round(clamp(s, 0, 100));
}
function swimBand(score) { return SWIM.bands.find(b => score < b.max) || SWIM.bands[2]; }
function swimReason(h) {
  const p = [];
  if (h.ripPct != null) p.push((h.ripPct >= 50 ? "high" : h.ripPct >= 25 ? "moderate" : "low") + " rip " + Math.round(h.ripPct) + "%");
  if (h.waveFt != null) p.push(Math.round(h.waveFt) + " ft surf");
  if (h.windKt != null && h.windKt >= 15) p.push(Math.round(h.windKt) + " kt wind");
  if (h.currKt != null && h.currKt >= 1) p.push("strong current");
  return p.join(" · ");
}

const SWIM_NOTE = "Relative risk from the NWPS model (rip, surf, wind, nearshore current) at " +
  "Seaview Pier, daylight hours only. Planning guidance — not a guarantee. Excludes " +
  "thunderstorms/lightning and water quality. Never swim alone; always heed posted flags and signs.";

function buildSwim(series) {
  if (!series || !series.hours || !series.hours.length || !ripModel) return null;
  const now = Date.now();
  const lat = ripModel.CFG.point.lat, lon = ripModel.CFG.point.lon;

  const scored = series.hours.map(h => {
    const score = swimScore(h);
    return {
      valid: h.valid, score, band: swimBand(score).key, day: isDaylight(h.valid, lat, lon),
      rip: h.ripPct == null ? null : Math.round(h.ripPct),
      waveFt: h.waveFt == null ? null : Math.round(h.waveFt * 10) / 10,
      windKt: h.windKt == null ? null : Math.round(h.windKt),
      reason: swimReason(h)
    };
  });

  const horizonEnd = now + SWIM.horizonH * 3600000;
  const hourly = scored
    .filter(h => h.valid >= now - 3600000 && h.valid <= horizonEnd)
    .map(h => ({ t: new Date(h.valid).toISOString(), score: h.score, band: h.band, day: h.day, rip: h.rip, waveFt: h.waveFt, windKt: h.windKt }));

  // Contiguous daylight runs of one band, within the search horizon.
  const limit = now + SWIM.windowDays * 86400000;
  const segs = [];
  let cur = null;
  for (const h of scored) {
    if (h.valid < now || h.valid > limit) continue;
    if (!h.day) { cur = null; continue; }                       // never span a night
    if (cur && cur.band === h.band) {
      cur.end = h.valid; cur.minScore = Math.min(cur.minScore, h.score);
      if (h.score >= cur.worst) { cur.worst = h.score; cur.reason = h.reason; }
    } else {
      cur = { start: h.valid, end: h.valid, band: h.band, label: swimBand(h.score).label, minScore: h.score, worst: h.score, reason: h.reason };
      segs.push(cur);
    }
  }
  // Prefer windows of at least 2 hours; fall back to all if fragmented.
  let cand = segs.filter(s => s.end > s.start);
  if (!cand.length) cand = segs;
  // Surface the genuinely safest upcoming stretches: lowest min-score first.
  const windows = cand.slice().sort((a, b) => a.minScore - b.minScore)
    .slice(0, SWIM.maxWindows)
    .sort((a, b) => a.start - b.start)
    .map(s => ({ start: new Date(s.start).toISOString(), end: new Date(s.end + 3600000).toISOString(), band: s.band, label: s.label, score: s.minScore, reason: s.reason }));

  return { generated: new Date(series.runValid || now).toISOString(), windows, hourly, note: SWIM_NOTE };
}

async function fetchSwim() {
  if (!ripModel || !ripModel.getSwimSeries) return null;
  return buildSwim(await ripModel.getSwimSeries());
}

/* ------------------------------------------------------------------ */
/* aggregate (with per-source last-good cache)                        */
/* ------------------------------------------------------------------ */

const lastGood = { srf: null, buoy: null, tide: null, swim: null };
let cache = null;

async function refresh() {
  const [srfR, buoyR, tideR, camStatus, ripProb, swimR] = await Promise.allSettled([
    fetchSurfZoneForecast(), fetchBuoy(), fetchTides(), fetchCamStatus(), fetchRipModelProb(), fetchSwim()
  ]);

  const sources = [];

  // cam
  const cam = camStatus.status === "fulfilled" ? camStatus.value : "warn";
  sources.push({ name: "Cam", status: cam, detail: cam === "ok" ? "live" : "status unknown" });

  // rip risk (SRF)
  let srf = lastGood.srf;
  if (srfR.status === "fulfilled" && srfR.value.rip) {
    srf = srfR.value; lastGood.srf = srf;
    sources.push({ name: "Rip risk \u00B7 NWS SRF", status: "ok", detail: "latest issuance" });
  } else {
    sources.push({ name: "Rip risk \u00B7 NWS SRF", status: srf ? "warn" : "down", detail: srf ? "using last good" : "unavailable" });
  }

  // buoy
  let buoy = lastGood.buoy;
  if (buoyR.status === "fulfilled") {
    buoy = buoyR.value; lastGood.buoy = buoy;
    const note = (buoy.usedFallback ? "using " + buoy.id : buoy.id) + " \u00B7 " + buoy.ageMin + " min";
    sources.push({ name: "Waves/temp \u00B7 buoy", status: buoy.stale ? "warn" : "ok", detail: buoy.stale ? note + " (stale)" : note });
  } else {
    sources.push({ name: "Waves/temp \u00B7 buoy", status: buoy ? "warn" : "down", detail: buoy ? "using last good" : "all offline" });
  }

  // tide
  let tide = lastGood.tide;
  let tideProb = tideR;
  if (tideR.status === "fulfilled") {
    tide = tideR.value; lastGood.tide = tide;
    sources.push({ name: "Tide \u00B7 CO-OPS", status: "ok", detail: "predictions" });
  } else {
    sources.push({ name: "Tide \u00B7 CO-OPS", status: tide ? "warn" : "down", detail: tide ? "using last good" : "unavailable" });
  }

  // wind source label
  sources.push({ name: "Wind \u00B7 NWS forecast", status: srf ? "ok" : "down", detail: srf ? "zone NCZ199" : "unavailable" });

  // swim windows (NWPS model series)
  let swim = lastGood.swim;
  if (swimR.status === "fulfilled" && swimR.value) {
    swim = swimR.value; lastGood.swim = swim;
    sources.push({ name: "Swim windows \u00B7 NWPS model", status: "ok", detail: swim.windows.length + " window" + (swim.windows.length === 1 ? "" : "s") + " ahead" });
  } else {
    sources.push({ name: "Swim windows \u00B7 NWPS model", status: swim ? "warn" : "down", detail: swim ? "using last good" : "no model run" });
  }

  const json = {
    updated: new Date().toISOString(),
    rip: {
      level: srf && srf.rip ? srf.rip : "Unknown",
      prob: ripProb.status === "fulfilled" ? ripProb.value : null
    },
    conditions: {
      surf: (buoy && buoy.surf) || (srf && srf.surf) || "—",
      period: (buoy && buoy.period) || "—",
      wind: (srf && srf.wind) || "—",
      water: (buoy && buoy.water) || "—"
    },
    tide: tide || { datum: "MLLW", station: CONFIG.tideStationName, series: [] },
    swim: swim || null,
    sources
  };

  cache = json;
  return json;
}

/* ------------------------------------------------------------------ */
/* server                                                             */
/* ------------------------------------------------------------------ */

function send(res, code, body) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": CONFIG.allowOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS"
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function serveStatic(res, urlPath) {
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  if (rel.indexOf("..") !== -1) return send(res, 404, { error: "not found" });
  const file = nodePath.join(__dirname, "public", rel);
  fs.readFile(file, function (err, data) {
    if (err) return send(res, 404, { error: "not found" });
    const ext = nodePath.extname(file).toLowerCase();
    const type = ext === ".html" ? "text/html"
      : ext === ".js" ? "text/javascript"
      : ext === ".css" ? "text/css"
      : ext === ".svg" ? "image/svg+xml"
      : "application/octet-stream";
    res.writeHead(200, { "Content-Type": type + "; charset=utf-8", "Cache-Control": "no-store" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const path = (req.url || "").split("?")[0];
  if (req.method === "OPTIONS") return send(res, 204, "");
  if (path === "/health") return send(res, 200, { ok: true, updated: cache && cache.updated });
  if (path === "/conditions") {
    if (!cache) return send(res, 503, { error: "warming up" });
    return send(res, 200, cache);
  }
  return serveStatic(res, path);
});

(function start() {
  // Open the port immediately so cloud health checks pass and the page loads
  // right away; the first data refresh (incl. the 52 MB GRIB) runs in the
  // background. /conditions returns 503 "warming up" until it completes.
  server.listen(CONFIG.port, CONFIG.host, () => {
    console.log("current_danger running:");
    console.log("  dashboard  http://localhost:" + CONFIG.port + "/");
    console.log("  data       http://localhost:" + CONFIG.port + "/conditions");
    refresh().catch(e => console.error("initial refresh failed:", e.message));
    setInterval(() => refresh().catch(e => console.error("refresh error:", e.message)), CONFIG.refreshMs);
  });
})();
