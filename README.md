# current_danger

A current-safety dashboard for the **Seaview Pier / New River Inlet end of North Topsail Beach, NC** — the stretch where a fishing pier and a tidal inlet stack the two features most associated with dangerous currents.

It shows a live pier cam, the official rip-current risk, an inlet tidal-current level computed from the tide stage, the tide curve, and current ocean conditions — each labeled with where it came from and how fresh it is.

> ## Safety, first and plainly
> This is **forecast and observation guidance, not a detector and not a warning service.** It does not measure where currents are, and conditions can be deadly even when the water looks calm and the dashboard looks quiet. It is not a substitute for lifeguard flags, posted signs, or official National Weather Service products. If you build on it or share it, keep that framing intact. If someone is caught in a current: don't fight it — stay calm, float, signal for help; from shore, call 911 and throw something that floats rather than swimming out.

## What's real vs. what needs wiring

- **Live cam** — real HLS stream from Seaview Pier (via SurfChex). Plays natively in Safari; uses hls.js elsewhere. Cross-origin playback depends on the host's CORS headers / your having permission; otherwise it falls back to a link out. See "Cam permission" below.
- **Inlet tidal-current level** — computed live from the tide curve and the current time. Real logic, clearly labeled as inferred from tide stage (not a measured current).
- **Rip risk (category)** — parsed from the NWS Surf Zone Forecast for zone NCZ199. Live as soon as the server runs.
- **Rip probability (number)** — from the experimental NOAA NWPS model (GRIB2). Off by default; returns `null` unless you run discovery and the field exists for MHX. The dashboard shows the category alone when there's no number.
- **Waves / water temp / wind** — from an NDBC buoy and the forecast; live when the server runs.

Until the server is running, the dashboard renders on clearly-labeled **sample data** with a banner so sample is never mistaken for live.

## Architecture

```
public/index.html   the dashboard (cam + hazards + tide + conditions)
       |  fetch /conditions (same origin)
       v
server.js           aggregator: polls the sources below every 5 min,
       |            normalizes to one JSON, fails per-source with status flags,
       |            and also serves the dashboard
       +-- rip-model.js   optional NWPS GRIB2 rip-probability (needs wgrib2)
```

## Data sources

Each field is sourced independently; one source failing does not blank the others. The source is listed in its own column below.

| Field | What it provides | Update cadence | Status if unavailable | Source |
|---|---|---|---|---|
| Rip risk (category) | Low / Moderate / High for zone NCZ199 | ~2×/day + updates | last-good, then "down" | NWS Surf Zone Forecast (office MHX) |
| Rip probability (0–100) | Hourly model probability at the pier cell | hourly when published | omitted; category shown | NOAA NWPS rip-current model (GRIB2, experimental) |
| Surf height, period | Live wave observations | ~30–60 min | falls back to forecast surf | NDBC buoy 41109 → 41159 → 41037 |
| Water temp | Live sea-surface temperature | ~30–60 min | shown as "—" | NDBC buoy (as above) |
| Wind | Forecast wind for the zone | ~2×/day | shown as "—" | NWS Surf Zone Forecast (office MHX) |
| Tide curve + stage | Hourly tide predictions, local day | daily | last-good, then "down" | NOAA CO-OPS station 8657167 (New River Inlet) |
| Live view | Pier surf cam (HLS) | continuous | link-out fallback | SeaView Fishing Pier via SurfChex |

Note: buoys 41109/41159 are Waverider buoys (waves + sea temp only, no anemometer), which is why wind comes from the forecast text rather than the buoy.

## Requirements

- **Node.js 18+** (uses built-in `fetch`; no npm dependencies)
- **wgrib2** — *optional*, only for the rip-probability number. Without it, everything else still works and the dashboard shows the rip category. Install: https://www.cpc.ncep.noaa.gov/products/wesley/wgrib2/

## Quick start

```bash
git clone https://github.com/ProfessorZoltan/current_danger.git
cd current_danger
npm start
```

Then open http://localhost:8787/ . The page is served same-origin with the data API, so it goes live immediately (no CORS setup). Opening `public/index.html` directly from disk instead will show sample data with a banner — that's expected.

## Configuration

- **server.js → `CONFIG`** — port, refresh interval, the SRF zone (`NCZ199`) and feed URL, buoy fallback order, the CO-OPS tide station (`8657167`), and the cam stream URL.
- **public/index.html → `CONFIG`** — `dataEndpoint` defaults to `/conditions`; set to `""` to force sample mode. Cam stream and fallback page also live here.
- **rip-model.js → `CFG`** — NOMADS region/office/grid, the Seaview Pier point, and the `.idx` match patterns used to find the rip record.

## Enabling the rip-probability number (optional, experimental)

The NOAA rip-current field is experimental, produced at only a few pilot WFOs, and its GRIB2 distribution is a recent NWPS v1.5.0 addition — so it may not exist for MHX yet, and the exact variable name is unconfirmed. Find out in one command:

```bash
npm run discover
```

This prints the live inventory of the latest MHX NWPS file and highlights any rip-current records. Three outcomes:

1. **A rip record is listed** — set `CFG.ripMatchers` in `rip-model.js` to that exact name, install `wgrib2`, restart. The number appears.
2. **Inventory shows, no rip field** — MHX isn't publishing it yet. Do nothing; the category remains the best signal.
3. **No index found** — adjust `CFG.region`/`wfo`/`grid`, or the office serves NWPS differently.

The module returns `null` in every failure case, so the dashboard is never blocked by it.

## Cam permission

The live cam belongs to SurfChex (sponsored by SeaView Fishing Pier). A person watching it in a browser is fine; pulling the stream into a public product of your own is something to clear with them, and is also what typically resolves the cross-origin playback so it works outside Safari. The zero-permission option is to set the dashboard's cam `streamUrl` to `""`, which turns the panel into a button that links out to their page.

## Known limitations

- The inlet-current level is tide-only; wind-against-tide and river discharge through the inlet both worsen the real current and are not modeled.
- Forecast wind is a forecast, not an observation.
- Parsers target the documented feed formats; if NWS wording or a buoy's columns drift, the regex/column index in `server.js` is where to adjust. Watch the console and the source chips on first live run.

## Pushing this into the repo

From the unzipped folder, on a machine signed in to GitHub:

```bash
git init
git add .
git commit -m "Initial dashboard, aggregator, and rip-model"
git branch -M main
git remote add origin https://github.com/ProfessorZoltan/current_danger.git
git pull --rebase origin main   # keep the existing README commit, or skip and overwrite
git push -u origin main
```

If you'd rather keep this README, rename it before adding, or merge the two by hand.

## License

MIT — see [LICENSE](LICENSE).
