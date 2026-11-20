# PRD — Bali Streets Crawler (Overpass → Supabase)

| Item | Value |
|---|---|
| Status | Draft v1.1 — added 2 output modes (DB / JSON file) |
| Date | 2026-11-20 |
| Components | Local Overpass API (Docker), Node.js/TypeScript crawler, Supabase (local/cloud) |
| Related documents | [ARCHITECTURE.md](ARCHITECTURE.md), [DATA_MODEL.md](DATA_MODEL.md), [SETUP.md](SETUP.md), [CONFIGURATION.md](CONFIGURATION.md), [OVERPASS_QUERIES.md](OVERPASS_QUERIES.md), [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |

---

## 1. Background

We need the **Bali Province** road network from OpenStreetMap (OSM) in a Supabase database (PostgreSQL + PostGIS) so applications can use it (street search, maps, spatial analysis).

Fetching data from the public Overpass server (`overpass-api.de`) comes with quotas, rate limits, and timeouts. So Overpass runs **locally in Docker** and contains only Bali data. A crawler then fetches road data from that local instance and emits it as one of **two output types**:

1. **Database** — upserted directly into the `public.streets` table in Supabase.
2. **JSON file** — written to a `.json` file (structure follows the `streets` table columns) to share, archive, inspect, or import later.

> **A note on terms.** *Overpass Turbo* is a web UI for writing and testing queries. What actually stores and serves the data is the *Overpass API*. This project runs a local **Overpass API**; Overpass Turbo is used as the UI to try queries against that local server (see [OVERPASS_QUERIES.md](OVERPASS_QUERIES.md)). The crawler talks to the Overpass API directly.

## 2. Goals

| ID | Goal |
|---|---|
| G1 | Provide a local Overpass API instance via Docker that holds **only** OSM data inside the administrative boundary of Bali Province. |
| G2 | The crawler fetches **only vehicle roads** (ways with specific `highway=*` values). |
| G3 | The crawler supports **2 output types**, selected via the `OUTPUT_MODE` setting: `db` (directly into `public.streets`) or `json` (JSON file). |
| G4 | `db` mode can write to **local Supabase** (Supabase CLI) or **Supabase cloud** just by changing configuration. |
| G5 | `db` mode is **idempotent**: repeated runs create no duplicates and only update rows that changed. `json` mode is **deterministic**: same source data → same `streets` contents (sorted by `osm_way_id`). |
| G6 | The whole stack runs with a few `docker compose` commands and is fully documented. |

## 3. Non-Goals (Out of Scope)

- Data outside Bali Province (East Java, Lombok/NTB, etc.).
- Objects other than vehicle roads: buildings, POIs, footway/path/track/cycleway/steps, rivers, administrative boundaries as output data, etc.
- Route relations (`type=route`), intersection nodes, graph/routing topology.
- Real-time sync (minutely diffs). Data is refreshed by **re-importing the extract** manually or on a schedule.
- Storing other OSM tags (ref, maxspeed, oneway, etc.) — the table only stores `osm_way_id`, `name`, `coordinates`.
- Self-hosting the Overpass Turbo UI (optional, not required).
- Writing to the DB **and** a JSON file in one run (run the crawler twice with different modes if you need both).
- Other file formats (CSV, GeoJSON FeatureCollection, Shapefile, GeoPackage) and a command to import the JSON file into the DB — candidates for a later version.

## 4. Users & Personas

| Persona | Needs |
|---|---|
| Data/Backend Engineer | Runs the crawl, loads data into Supabase, schedules refreshes. |
| App Developer | Consumes the `streets` table (via Supabase API/SQL) for map and search features, or the JSON file for seeding/testing without DB access. |
| GIS Analyst | Verifies data completeness via Overpass Turbo and PostGIS queries. |

## 5. User Stories

1. As an engineer, I want to run `docker compose up -d overpass` and get a local Overpass API containing only Bali data, so I don't depend on public servers.
2. As an engineer, I want to run `docker compose run --rm crawler` to populate the `streets` table in local or cloud Supabase.
3. As an engineer, I want to rerun the crawler at any time without duplicating data, with `dt_updated` changing only for roads that actually changed.
4. As a GIS analyst, I want to open Overpass Turbo pointed at the local server to try the same queries the crawler uses.
5. As an engineer, I want a result summary (inserted/updated/unchanged/skipped counts) at the end of the run, and a non-zero exit code when something fails.
6. As an engineer, I want to run `docker compose run --rm -e OUTPUT_MODE=json crawler` and get a JSON file in `./output` without needing Supabase at all.
7. As an app developer, I want a JSON file whose structure matches the `streets` table columns, so I can use it as seed data or import it later.

## 6. Product Decisions (agreed)

| Topic | Decision |
|---|---|
| Crawler language | **Node.js (LTS) + TypeScript** |
| Road types | **Vehicle roads**: `motorway`, `trunk`, `primary`, `secondary`, `tertiary`, `motorway_link`, `trunk_link`, `primary_link`, `secondary_link`, `tertiary_link`, `unclassified`, `residential`, `living_street`, `service`, `road`. Excludes `footway`, `path`, `track`, `cycleway`, `steps`, `pedestrian`, `bridleway`, `construction`, `proposed`, etc. |
| Unnamed roads | **Kept**, with `name = NULL`. |
| Region boundary | **Bali Province administrative polygon** (`boundary=administrative`, `admin_level=4`, `name=Bali`), including Nusa Penida, Nusa Lembongan, Nusa Ceningan, and other small islands in the province. |
| Infrastructure | Docker / Docker Compose. |
| Output type | **2 modes**, selected via `OUTPUT_MODE`: `db` (default) or `json`. One mode per run. |
| Target DB (`db` mode) | Local Supabase (Supabase CLI) or Supabase cloud, selected via `DATABASE_URL`. |
| File format (`json` mode) | A single UTF-8 JSON file: `{"streets": [...], "meta": {...}}`; each item has `osm_way_id`, `name`, `coordinates` (GeoJSON `LineString`). Details in [DATA_MODEL.md §7](DATA_MODEL.md#7-json-output-file-format). |

## 7. Functional Requirements

### 7.1 Local Overpass Data

| ID | Requirement |
|---|---|
| FR-01 | The system downloads the source OSM extract (default: Geofabrik, a region that covers Bali) in `.osm.pbf` format. |
| FR-02 | The system finds the Bali Province boundary relation automatically (tags `boundary=administrative` + `admin_level=4` + `name=Bali`), or uses `BALI_RELATION_ID` if set. |
| FR-03 | The system clips the extract with the Bali polygon (`osmium extract`, `complete_ways` strategy so boundary-crossing ways stay whole), then keeps only `highway=*` ways with their nodes, plus the Bali boundary relation (for Overpass *areas*). |
| FR-04 | The clipped result is imported into the local Overpass API (`wiktorn/overpass-api`) with areas enabled. |
| FR-05 | The Overpass API is reachable at `http://localhost:12345/api/interpreter` and usable from Overpass Turbo. |
| FR-06 | The import fails with a clear message if the Bali relation is not found or the extract result is empty. |
| FR-07 | **Anti-world-data safeguard (before download):** `SOURCE_PBF_URL` is rejected if it contains `planet` or a large region, and must match the Geofabrik `asia/indonesia*` allowlist (explicit bypass: `ALLOW_ANY_SOURCE=true`). The file size is checked via HTTP HEAD and rejected if > `MAX_SOURCE_SIZE_MB` (default 2500 MB). The download is also capped with `curl --max-filesize`. |
| FR-08 | **Extract result safeguard:** the bbox of the clipped data must lie inside the Bali fence (lon 114.0–116.0, lat −9.2 to −7.8) and its size must be ≤ `MAX_EXTRACT_SIZE_MB` (default 300 MB); otherwise the process fails and Overpass imports nothing. |
| FR-09 | **Locked Overpass mode:** `OVERPASS_MODE=init`, `OVERPASS_PLANET_URL=file:///data/bali.osm.bz2`, and an empty `OVERPASS_DIFF_URL` are written directly in `docker-compose.yml` (cannot be changed via `.env`). `clone` mode and planet diffs are forbidden. |

### 7.2 Crawler

| ID | Requirement |
|---|---|
| FR-10 | **Preflight**: the crawler checks that Overpass is ready (`/api/status`), finds the Bali relation, reads its bounding box, and makes sure the Bali area is available (with retries). |
| FR-10a | **Outside-Bali data guard** (cannot be disabled): before writing output, the crawler checks that control points outside Bali (Surabaya, Mataram, Jakarta, Singapore) return 0 ways, and that the Bali relation bbox lies inside the Bali fence. Failure → exit 2, no data is written. |
| FR-11 | The crawler splits the Bali bounding box into **tiles** (default 0.1° × 0.1°) and queries each tile with the `(area.bali)` filter + the road type filter + `area!=yes`. |
| FR-12 | Queries use `out body geom qt;` so the full way geometry is available without separate node queries. |
| FR-13 | Ways that appear in several tiles are **deduplicated** by `osm_way_id` (within a run and within a batch). |
| FR-14 | Geometry is normalized into a list of `[lon, lat]` points (7 decimals, SRID 4326). Ways with < 2 unique points are **skipped** and counted as `skipped`. This normalization is the same for both output modes. |
| FR-15 | `name` comes from the `name` tag, trimmed; empty string → `NULL`; longer than 150 characters → truncated to 150 and logged as a warning. |
| FR-16 | The crawler picks the **writer** based on `OUTPUT_MODE` (`db` \| `json`). Any other value → configuration error (exit 1). Preflight, tiling, fetch, dedupe, and transform stages are identical for both modes. |
| FR-17 | Failed Overpass requests (timeout, HTTP 429/5xx, network error) are retried with exponential backoff (default max 5 times). Tiles that still fail are logged and the run ends with exit code `3`. |
| FR-18 | **Dry-run** mode (`CRAWLER_DRY_RUN=true`): crawl and transform without writing any output (neither DB nor file); only print the summary. |
| FR-19 | A final summary is printed (JSON log): output mode, tile count, ways received, unique ways, skipped, failed tiles, duration, plus mode-specific metrics (see §7.3 and §7.4). |

### 7.3 `db` Output Mode

| ID | Requirement |
|---|---|
| FR-20 | `DATABASE_URL` is required; preflight checks the DB connection and that the `public.streets` table exists (failure → exit 2). |
| FR-21 | Writes use **UPSERT** (`ON CONFLICT (osm_way_id)`) per batch (default 500 rows). Geometry is sent as WKT `LINESTRING(lon lat, ...)`. An update only happens when `name` or the geometry changed; in that case `dt_updated = NOW()`. `dt_created` is never changed. |
| FR-22 | Optional **prune** mode (`CRAWLER_PRUNE=true`): after a fully successful run (0 failed tiles), rows whose `osm_way_id` was not seen in this run are deleted. **Off** by default. |
| FR-23 | The summary adds `inserted`, `updated`, `unchanged`, `pruned`. |

### 7.4 `json` Output Mode

| ID | Requirement |
|---|---|
| FR-30 | `DATABASE_URL` is **not** required and not used; the crawler opens no DB connection. |
| FR-31 | The file is written to `OUTPUT_DIR` (default `/output` in the container, mounted to `./output` on the host) named `OUTPUT_FILENAME` (default `bali-streets-<YYYYMMDDTHHmmssZ>.json`). |
| FR-32 | File structure: an object `{"streets": [...], "meta": {...}}`. Each `streets` item has `osm_way_id` (number), `name` (string \| null), `coordinates` (GeoJSON `LineString`, `[lon, lat]`). The `uuid`, `dt_created`, `dt_updated` columns are **not** included because the DB generates them. |
| FR-33 | `meta` contains: source & license (ODbL), region, Bali relation ID, list of `highway` values used, `generated_at` (UTC ISO-8601), `osm_base_timestamp` (from the Overpass response), `count`, `skipped`, `tiles_failed`. |
| FR-34 | `streets` items are **sorted ascending by `osm_way_id`** and unique, so the file is deterministic and easy to diff. |
| FR-35 | **Atomic** write: write to `<name>.json.tmp`, then rename to `<name>.json` when done. An existing file with the same name is not overwritten unless `OUTPUT_OVERWRITE=true` (otherwise → exit 1 before crawling). |
| FR-36 | **Streaming** write (no giant JSON string built in memory); *compact* format by default, `OUTPUT_PRETTY=true` for 2-space indentation. |
| FR-37 | If any tile fails, the file is **still written** (with `meta.tiles_failed > 0`) and the run ends with exit code `3`, so partial data isn't lost but the failure stays visible. |
| FR-38 | `CRAWLER_PRUNE` is ignored (with a warning) in `json` mode. The summary adds `written` and `outputFile`. |

### 7.5 Database (Schema)

| ID | Requirement |
|---|---|
| FR-40 | The SQL migration creates the PostGIS extension (if missing) and the `public.streets` table per the defined schema. |
| FR-41 | The migration adds a GIST index on `coordinates` and a `dt_updated` trigger for manual updates outside the crawler. |
| FR-42 | RLS is enabled on `public.streets` with a read (SELECT) policy for `anon`/`authenticated`; writes only by the crawler (`postgres` role via a direct connection). |

## 8. Non-Functional Requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-01 | Reproducibility | All components run in Docker; image versions are pinned (see [ARCHITECTURE.md](ARCHITECTURE.md)). |
| NFR-02 | Idempotency / Determinism | `db` mode: a second run with no source data changes yields `inserted = 0`, `updated = 0`. `json` mode: two runs with the same source data produce identical `streets` arrays. |
| NFR-09 | Memory | `json` mode writes as a stream; crawler memory use does not grow with the size of the output file string. |
| NFR-03 | Performance | A full Bali crawl from local Overpass finishes in minutes on a laptop with ≥ 8 GB RAM (target: < 15 minutes, excluding Overpass import time). |
| NFR-04 | Resilience | One tile failing does not stop the other tiles. |
| NFR-05 | Security | DB credentials only via `.env` (not committed). Connections to Supabase cloud must use SSL. |
| NFR-06 | Observability | Structured logs (JSON, `pino`), level configurable via `LOG_LEVEL`. |
| NFR-07 | Portability | Runs on Windows (Docker Desktop + WSL2), macOS, and Linux. |
| NFR-08 | Region accuracy | 100% of rows lie inside (or intersect) the Bali Province polygon. |
| NFR-10 | Bandwidth & disk use | Only a regional extract is downloaded (default Geofabrik `indonesia`, ~1.7 GB, capped at 2.5 GB); planet/world data is **never** downloaded. After extraction the source file is deleted (unless `KEEP_SOURCE=true`). The crawler does not use the internet at all. |

## 9. Acceptance Criteria

1. `docker compose up -d overpass` on a clean machine completes download → extract → import, and `curl http://localhost:12345/api/status` responds.
2. The query `rel["boundary"="administrative"]["admin_level"="4"]["name"="Bali"]; out ids;` on the local server returns exactly 1 relation.
3. A road query outside Bali (e.g. a Surabaya or Mataram bbox) on the local server returns **0 elements**.
3a. Setting `SOURCE_PBF_URL` to a planet URL (e.g. `https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf`) or another region's extract (e.g. `https://download.geofabrik.de/asia-latest.osm.pbf`) makes `bali-extract` fail (exit 1) **before** the download starts — not a single byte of data is downloaded.
3b. Setting `MAX_SOURCE_SIZE_MB=10` with the default URL makes `bali-extract` fail before the download (the size safeguard works).

**`db` mode**

4. `docker compose run --rm crawler` (default `OUTPUT_MODE=db`) ends with exit code `0` and the `public.streets` table is populated.
5. No duplicate `osm_way_id`; all `coordinates` are valid (`ST_IsValid`) with `ST_SRID = 4326` and `ST_NPoints >= 2`.
6. No rows with road types outside the list (verified by sampling against Overpass, since the `highway` tag is not stored).
7. Running the crawler a second time with no data changes yields `inserted=0, updated=0`.
8. The region validation query in [DATA_MODEL.md §6](DATA_MODEL.md#6-validation-queries) returns no rows outside the Bali bbox.
9. Switching `DATABASE_URL` to Supabase cloud and running the crawler succeeds without code changes.

**`json` mode**

10. `docker compose run --rm -e OUTPUT_MODE=json crawler` succeeds (exit `0`) **without** Supabase running and without `DATABASE_URL`, and produces a single `.json` file in `./output` (no leftover `.tmp` file).
11. The file is valid JSON matching the schema in [DATA_MODEL.md §7](DATA_MODEL.md#7-json-output-file-format): `meta.count` = length of `streets`, `osm_way_id` unique and ascending, each `coordinates.type = "LineString"` with ≥ 2 `[lon, lat]` points inside the Bali bbox.
12. For the same Overpass data, `json` mode `meta.count` = row count in the table after a `db` mode crawl (no prune, starting from an empty table), and the set of `osm_way_id` values is the same.
13. Two consecutive `json` runs with no data changes produce identical `streets` arrays (only `meta.generated_at` and the file name differ).
14. A `json` run with an existing file name and `OUTPUT_OVERWRITE=false` fails with exit `1` before crawling starts.

## 10. Success Metrics

- Number of ways in `streets` (table or JSON file) = number of unique ways from the Overpass query for the Bali area (the difference is only `skipped`, logged).
- Tile error rate = 0 on a normal run.
- Full crawl duration meets NFR-03.

## 11. Assumptions

- The developer machine has Docker Desktop/Engine with Compose v2, ≥ 4 GB RAM allocated to Docker, and ≥ 10 GB free disk space.
- The Geofabrik Indonesia extract covers all of Bali Province (verified by FR-06). Geofabrik publishes no smaller Indonesian sub-region extracts.
- The Bali Province boundary relation in OSM is tagged `name=Bali` and `admin_level=4`. If the tags change in OSM, use the `BALI_RELATION_ID` override.
- Local Supabase runs via the Supabase CLI (which also uses Docker).

## 12. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| The source extract does not cover Bali / the URL changes | Import fails | `SOURCE_PBF_URL` is configurable; the script fails fast with a clear message. |
| A misconfiguration causes world/large-region data to be downloaded or imported | Bandwidth & disk exhausted (planet ~80 GB, world Overpass DB hundreds of GB), non-Bali data in the output | Layered safeguards FR-07, FR-08, FR-09, FR-10a: URL blocklist + allowlist, size limits before & during download, bbox & size checks on the extract result, hardcoded Overpass mode, control-point guard in the crawler. |
| Overpass *area* generation not finished when the crawler runs | `(area.bali)` query returns nothing | Preflight waits for the area (retries); fallback `CRAWLER_USE_AREA=false` (data is already clipped to the polygon, a bbox filter is enough). |
| Ways crossing the province boundary (e.g. roads near ports) | Part of the geometry lies outside Bali | The `complete_ways` extract strategy keeps ways whole; this is expected behavior (ways are not cut). Documented. |
| `ON CONFLICT ... cannot affect row a second time` | Batch fails | Dedupe within the batch before upserting (FR-13). |
| Supabase cloud direct connection is IPv6-only | Crawler can't connect | Use the Supabase **Session Pooler** (IPv4). |
| Name > 150 characters | Insert error | Truncate + warning (FR-15). |
| Large JSON file (hundreds of MB) | Out of memory / hard to open | Streaming write (FR-36), compact format by default; use streaming tools for analysis (`jq --stream`, etc.). |
| Crawler dies mid-write | Corrupt/truncated JSON file | Atomic `.tmp` → rename write (FR-35); leftover `.tmp` files can be deleted. |
| The `./output` folder is not writable by the container's `node` user | Error exit on write | Document permissions; crawler checks writability in preflight (exit 2). |
| OSM data deleted at the source | Stale rows in the DB | `CRAWLER_PRUNE=true` mode (optional, only on a fully successful run). |

## 13. Milestones

| Phase | Deliverable | Done when |
|---|---|---|
| M1 — Data | `docker/bali-extract` + `overpass` service in compose | Acceptance 1–3 |
| M2 — Schema | Migration `supabase/migrations/*_create_streets.sql` | Table + index + trigger + RLS exist locally |
| M3 — Core crawler | Preflight, tiling, fetch, transform, `db` writer (upsert) | Acceptance 4–6 |
| M4 — JSON output | `json` writer (streaming, atomic, sorted), `./output` volume | Acceptance 10–14 |
| M5 — Robustness | Retry/backoff, dry-run, prune, summary, exit codes | Acceptance 7–8 |
| M6 — Cloud & Docs | Test against Supabase cloud, finalize docs | Acceptance 9 |

## 14. Open Questions

1. Will extra columns be needed later (e.g. `highway` type, `ref`, `oneway`)? Currently **no**, per the given schema.
2. Data refresh frequency (weekly/monthly) and whether it is scheduled (cron/CI) — currently manual.
3. Should all of `highway=service` (including driveways & parking aisles) be included, or should the `service=parking_aisle|driveway` subtypes be excluded? Default: **all service roads included**.
4. Is an `import` command needed to load the `json` mode file into the DB ("crawl once, load into many environments")? Currently out of scope.
5. Does the file format need a GeoJSON `FeatureCollection` variant (opens directly in QGIS/geojson.io)? Currently only the JSON format that mirrors the table columns.
