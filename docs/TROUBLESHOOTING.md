# Troubleshooting

> Error messages from `extract.sh` and the crawler are currently printed in Indonesian. They are quoted below exactly as they appear in the logs.

## Data & Overpass

| Symptom | Cause | Fix |
|---|---|---|
| `bali-extract`: `SOURCE_PBF_URL terlihat seperti planet/region besar` | Planet/large-region URL | Use the Geofabrik Indonesia extract or one of its sub-regions. **Do not** bypass. |
| `bali-extract`: `SOURCE_PBF_URL di luar allowlist` | URL is not Geofabrik `asia/indonesia*` | Fix the URL; use `ALLOW_ANY_SOURCE=true` only for trusted mirrors. |
| `bali-extract`: `melebihi MAX_SOURCE_SIZE_MB` | Source file too large (wrong region) | Check the URL. Raise the limit only if you are sure the file really is an Indonesia extract. |
| `bali-extract`: `tidak bisa membaca ukuran file sumber` | URL returns an HTTP error (e.g. 404 for the non-existent `indonesia/nusa-tenggara-latest.osm.pbf`), or the server/mirror does not send `Content-Length` | Use `https://download.geofabrik.de/asia/indonesia-latest.osm.pbf`. |
| `bali-extract`: `bbox data ... keluar dari pagar Bali` / `melebihi MAX_EXTRACT_SIZE_MB` | Wrong relation/polygon (not Bali Province) | Check `BALI_RELATION_ID`; leave it empty for auto-detection. |
| Crawler exit 2: `Data di luar Bali terdeteksi` | The `overpass-db` volume holds old/other data | `docker compose down`, delete the `bali-streets_overpass-db` volume, re-import. |
| `bali-extract` fails: `relasi Provinsi Bali tidak ditemukan` | The source extract doesn't contain Bali, or the relation's tags in OSM differ | Switch `SOURCE_PBF_URL` to `https://download.geofabrik.de/asia/indonesia-latest.osm.pbf`, or set `BALI_RELATION_ID` manually (search "Bali" on openstreetmap.org and pick the Province relation). |
| `bali-extract`: `extract.sh: not found` / `bad interpreter` | CRLF line endings on Windows | Convert `extract.sh` to LF; add `*.sh text eol=lf` to `.gitattributes`. |
| `bali-extract` fails: `hasil extract kosong` | Wrong polygon/relation | Check `BALI_RELATION_ID`; see the logs for steps 3–5. |
| Download interrupted | Connection | Run it again; `curl -C -` resumes the download. Set `KEEP_SOURCE=true` to avoid re-downloading. |
| `overpass` takes a long time to become `healthy` | First import still running | `docker compose logs -f overpass`. A few minutes is normal; `start_period` is 30 minutes. |
| `overpass` keeps exiting/restarting, memory errors in logs | Not enough Docker RAM | Increase RAM in Docker Desktop → Settings → Resources (≥ 6 GB). |
| Old data even after re-extracting | Overpass imports only once per volume | Delete the `bali-streets_overpass-db` volume (see [SETUP.md §7](SETUP.md#7-refreshing-osm-data)). |
| `(area.bali)` query returns nothing | Areas not generated yet | Wait; crawler preflight waits automatically. Or set `CRAWLER_USE_AREA=false`. |
| Overpass logs about failed diffs/updates | `OVERPASS_DIFF_URL` not set (on purpose) | Ignore it if the API still serves queries; refreshes are done by re-importing. |
| Port 12345 already in use | Port conflict | Change `OVERPASS_HOST_PORT`. |

## Crawler

| Symptom | Cause | Fix |
|---|---|---|
| Exit 1 | Invalid `.env` | Read the zod validation message in the log. |
| Exit 2: Bali relation `0` or `>1` | Relation tags differ | Set `BALI_RELATION_ID`. |
| Exit 2: `ECONNREFUSED host.docker.internal:54322` | Local Supabase not running | `npx supabase start`; check the DB port in its output (`54322`). |
| `getaddrinfo ENOTFOUND db.<ref>.supabase.co` / timeout | Cloud direct connection is IPv6-only | Use the Session Pooler URL. |
| `self-signed certificate in certificate chain` | `DATABASE_SSL=verify-full` without a CA | Use `require`, or download the Supabase CA (Dashboard → Database settings) and set `DATABASE_SSL_CA`. |
| `password authentication failed` | Wrong password / not URL-encoded | URL-encode special characters in the password. |
| `type "geometry" does not exist` | PostGIS not enabled / `search_path` | Run the migration; make sure `extensions` is in the role's `search_path`. |
| `relation "public.streets" does not exist` | Migration not applied | `npx supabase migration up` (local) / `db push` (cloud). |
| `ON CONFLICT DO UPDATE command cannot affect row a second time` | Duplicate id within one batch | Bug — per-batch dedupe is required ([ARCHITECTURE.md §6.9](ARCHITECTURE.md#69-db-writer--batch-upsert)). |
| `value too long for type character varying(150)` | Truncation not working | Bug — truncation must count characters (code points), not bytes. |
| Many tile timeouts (exit 3) | Slow machine / tiles too large | `TILE_SIZE_DEG=0.05`, `CONCURRENCY=1`, then rerun. |
| Second run still shows many `updated` | Inconsistent coordinate rounding | Make sure 7 decimals are used and point order matches Overpass. |

## JSON File Output

| Symptom | Cause | Fix |
|---|---|---|
| Exit 1: output file already exists | Same file name (fixed `OUTPUT_FILENAME`) | Set `OUTPUT_OVERWRITE=true` or leave `OUTPUT_FILENAME` empty (timestamped name). |
| Exit 2: `EACCES` / folder not writable | `./output` folder permissions (Linux) | `sudo chown 1000:1000 output`. |
| File does not appear in `./output` | Volume not mounted / `OUTPUT_DIR` changed | Make sure compose has `./output:/output` and `OUTPUT_DIR=/output`. |
| Leftover `*.json.tmp` file | Crawler died before finishing | Delete the `.tmp` file and rerun. |
| `JavaScript heap out of memory` | Data too large for the default heap | Raise `NODE_OPTIONS=--max-old-space-size=4096`. |
| `meta.tiles_failed > 0` | Some tiles failed (exit 3) | Partial file; rerun after fixing the cause of the timeouts. |
| `json` mode still tries to connect to the DB | Bug — the `json` writer must not open a DB connection | Check `createWriter`; `DATABASE_URL` must be ignored. |

## Overpass Turbo

| Symptom | Fix |
|---|---|
| "could not connect" error | Make sure the server URL ends with `/api/` (not `/api/interpreter`) and `overpass` is healthy. |
| Blocked as mixed content | Use a recent Chrome/Edge/Firefox (localhost is allowed), or run Overpass Turbo locally (HTTP). |
| Browser hangs | Query too large; limit it with `({{bbox}})` or `out count;`. |
