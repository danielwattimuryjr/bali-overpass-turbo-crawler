# Configuration

All configuration goes through the `.env` file in the repo root (copy it from `.env.example`). The `.env` file **must not be committed**.

## 1. `.env.example`

```dotenv
# ───────────── Source data (bali-extract service) ─────────────
# Geofabrik extract that covers Bali Province. Geofabrik publishes no Indonesian
# sub-regions, so the full Indonesia extract (~1.7 GB) is the smallest source available.
SOURCE_PBF_URL=https://download.geofabrik.de/asia/indonesia-latest.osm.pbf
# Leave empty = auto-detect (boundary=administrative + admin_level=4 + name=Bali)
BALI_RELATION_ID=
FORCE_REEXTRACT=false
KEEP_SOURCE=false
# Anti-world-data safeguards (see ARCHITECTURE.md §3.3)
MAX_SOURCE_SIZE_MB=2500
MAX_EXTRACT_SIZE_MB=300
ALLOW_ANY_SOURCE=false

# ───────────── Overpass ─────────────
OVERPASS_IMAGE_TAG=latest
OVERPASS_HOST_PORT=12345

# ───────────── Output ─────────────
# db   = upsert directly into Supabase public.streets
# json = write a JSON file to ./output (DATABASE_URL is not used)
OUTPUT_MODE=db
OUTPUT_FILENAME=
OUTPUT_OVERWRITE=false
OUTPUT_PRETTY=false

# ───────────── Database (Supabase, only for OUTPUT_MODE=db) ─────────────
# Local (Supabase CLI, reached from the container):
DATABASE_URL=postgresql://postgres:postgres@host.docker.internal:54322/postgres
DATABASE_SSL=disable
# Cloud (Session Pooler) — example:
# DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
# DATABASE_SSL=require

# ───────────── Crawler ─────────────
TILE_SIZE_DEG=0.1
CONCURRENCY=2
BATCH_SIZE=500
CRAWLER_USE_AREA=true
CRAWLER_PRUNE=false
CRAWLER_DRY_RUN=false
LOG_LEVEL=info
```

## 2. Variable Reference

### 2.1 `bali-extract`

| Variable | Default | Description |
|---|---|---|
| `SOURCE_PBF_URL` | Geofabrik `indonesia-latest.osm.pbf` | Source `.osm.pbf` URL. Must cover all of Bali Province. Geofabrik has no Indonesian sub-region extracts (e.g. `indonesia/nusa-tenggara-latest.osm.pbf` returns 404). |
| `BALI_RELATION_ID` | *(empty)* | OSM relation ID of Bali Province (digits only). Empty = auto-detect. |
| `FORCE_REEXTRACT` | `false` | `true` = redo download & extract even if `bali.osm.bz2` already exists. |
| `KEEP_SOURCE` | `false` | `true` = keep `source.osm.pbf` in the volume (saves the next download). |
| `MAX_SOURCE_SIZE_MB` | `2500` | Source file size limit; checked via HEAD before download and via `curl --max-filesize`. Large enough for the full Indonesia extract, rejects planet/large regions. |
| `MAX_EXTRACT_SIZE_MB` | `300` | Size limit of the clipped Bali result (roads only). Anything larger suggests a wrong polygon. |
| `ALLOW_ANY_SOURCE` | `false` | `true` = disable the Geofabrik `asia/indonesia*` URL allowlist (the `planet` blocklist & size limits **stay** active). Use only for other mirrors you trust. |

Overpass variables that are **deliberately not available** in `.env` (hardcoded in compose as a safeguard): `OVERPASS_MODE`, `OVERPASS_PLANET_URL`, `OVERPASS_DIFF_URL`.

### 2.2 `overpass`

| Variable | Default | Description |
|---|---|---|
| `OVERPASS_IMAGE_TAG` | `latest` | `wiktorn/overpass-api` image tag. Pin to a specific tag once tested. |
| `OVERPASS_HOST_PORT` | `12345` | Host port for the Overpass API (`http://localhost:12345/api/interpreter`). |

Internal Overpass variables (`OVERPASS_MODE`, `OVERPASS_USE_AREAS`, etc.) are set in `docker-compose.yml`; see [ARCHITECTURE.md §4](ARCHITECTURE.md#4-overpass-service).

### 2.3 `crawler`

| Variable | Default | Type | Description |
|---|---|---|---|
| `OVERPASS_URL` | `http://overpass/api/interpreter` | URL | Set by compose. Change to `http://localhost:12345/api/interpreter` when running the crawler outside Docker. |
| `OUTPUT_MODE` | `db` | `db` \| `json` | Output type. Any other value → exit 1. |
| `OUTPUT_DIR` | `/output` | path | *(json)* Output folder. Set by compose; mounted to `./output` on the host. Outside Docker, e.g. `./output`. |
| `OUTPUT_FILENAME` | *(empty)* | string | *(json)* File name. Empty = `bali-streets-<YYYYMMDDTHHmmssZ>.json`. File name only, no `/` or `\`. |
| `OUTPUT_OVERWRITE` | `false` | bool | *(json)* `true` = overwrite a file with the same name. |
| `OUTPUT_PRETTY` | `false` | bool | *(json)* `true` = indented JSON (larger). |
| `DATABASE_URL` | — | URL | *(db)* **Required** when `OUTPUT_MODE=db`; ignored in `json` mode. Supabase PostgreSQL connection string. |
| `DATABASE_SSL` | `disable` | `disable` \| `require` \| `verify-full` | `require` = SSL without CA verification; `verify-full` = requires `DATABASE_SSL_CA`. |
| `DATABASE_SSL_CA` | *(empty)* | path | Path to the Supabase CA certificate file (for `verify-full`), mounted into the container. |
| `DB_POOL_MAX` | `4` | int | Max pool connections. |
| `BALI_RELATION_ID` | *(empty)* | int | Override relation detection in preflight. |
| `TILE_SIZE_DEG` | `0.1` | float 0.01–1 | Tile size (degrees). Smaller = lighter queries, more requests. |
| `CONCURRENCY` | `2` | int 1–8 | Number of tiles queried in parallel. |
| `BATCH_SIZE` | `500` | int 50–2000 | Rows per upsert statement. |
| `HIGHWAY_TYPES` | vehicle road list | CSV | Override the list of `highway` values. Only `[a-z_]`. |
| `CRAWLER_USE_AREA` | `true` | bool | `false` = no `(area.bali)` filter (relies on the already-clipped data). |
| `AREA_WAIT_TIMEOUT_S` | `1800` | int | How long preflight waits for the Bali area to become available. |
| `PREFLIGHT_TIMEOUT_S` | `600` | int | How long to wait for `/api/status` to be ready. |
| `OVERPASS_QUERY_TIMEOUT_S` | `180` | int | The `[timeout:..]` value in queries. |
| `HTTP_TIMEOUT_S` | `240` | int | HTTP client timeout (must be > query timeout). |
| `MAX_RETRIES` | `5` | int | Retries per tile. |
| `BASE_DELAY_MS` | `1000` | int | Initial backoff delay. |
| `CRAWLER_PRUNE` | `false` | bool | *(db)* Delete rows not seen in a fully successful run. Ignored (warning) in `json` mode. |
| `CRAWLER_DRY_RUN` | `false` | bool | Write no output at all (neither DB nor file). |
| `LOG_LEVEL` | `info` | `trace`…`fatal` | pino log level. |

`DATABASE_SSL`, `DATABASE_SSL_CA`, `DB_POOL_MAX` only apply to `db` mode.

Default `HIGHWAY_TYPES`:

```
motorway,trunk,primary,secondary,tertiary,motorway_link,trunk_link,primary_link,secondary_link,tertiary_link,unclassified,residential,living_street,service,road
```

## 3. Common Profiles

| Scenario | Settings |
|---|---|
| JSON file output only (no Supabase) | `OUTPUT_MODE=json` (optionally `OUTPUT_PRETTY=true`) |
| Local Supabase, Docker Desktop (Windows/macOS) | `OUTPUT_MODE=db`, `DATABASE_URL=...@host.docker.internal:54322/postgres`, `DATABASE_SSL=disable` |
| Local Supabase, Linux | Same; `extra_hosts: host-gateway` in compose already handles `host.docker.internal`. |
| Supabase cloud | `OUTPUT_MODE=db`, Session Pooler URL, `DATABASE_SSL=require` |
| Crawler running directly on the host (no Docker) | `OVERPASS_URL=http://localhost:12345/api/interpreter`, `DATABASE_URL=...@localhost:54322/postgres` |
| Weak machine / Overpass often times out | `TILE_SIZE_DEG=0.05`, `CONCURRENCY=1` |
