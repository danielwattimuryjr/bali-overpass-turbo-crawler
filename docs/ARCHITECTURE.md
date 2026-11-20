# Architecture & Technical Design

This document describes **how** the system is built. The requirements (what & why) are in [PRD.md](PRD.md).

---

## 1. Overview

```
                 ┌──────────────────────────── docker compose ────────────────────────────┐
                 │                                                                         │
  Geofabrik ───► │  [1] bali-extract  ──(osm-data volume)──►  [2] overpass  ◄── [3] crawler│ ─┬─► OUTPUT_MODE=db
  (.osm.pbf)     │   osmium: find Bali relation,           wiktorn/overpass-api   Node/TS  │  │   Supabase (local/cloud)
                 │   clip to polygon, filter highway       :12345/api/interpreter          │  │   public.streets
                 │                                                ▲                        │  │
                 └────────────────────────────────────────────────┼────────────────────────┘  └─► OUTPUT_MODE=json
                                                                  │                                ./output/bali-streets-*.json
                                                     Overpass Turbo (browser)
                                                     Settings → Server = http://localhost:12345/api/
```

| #   | Service        | Role                                                                                                                               | Lifecycle                                                        |
| --- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | `bali-extract` | Download the OSM extract, clip it to the Bali Province polygon, keep only `highway=*` + the Bali boundary relation → `/data/bali.osm.bz2`. | One-shot, exits after success. Skipped if the file already exists. |
| 2   | `overpass`     | Local Overpass API. Imports `/data/bali.osm.bz2` once (`init` mode), builds _areas_, then serves queries.                          | Long-running.                                                    |
| 3   | `crawler`      | Query Overpass per tile → transform → **writer** per `OUTPUT_MODE`: `db` (upsert into Supabase) or `json` (file in `./output`).    | One-shot (`docker compose run --rm crawler`), `crawl` profile.   |

**Two layers guaranteeing "Bali only":**

1. **Data layer** — local Overpass only holds data clipped to the Bali polygon. Physically there is no data outside Bali (except parts of ways that cross the boundary, see §3.4).
2. **Query layer** — every crawler query still uses the `(area.bali)` filter.

**"Roads only" guarantees:**

1. The extract only keeps `highway=*` ways (plus their member nodes and the Bali boundary relation).
2. Crawler queries filter `highway` values down to the vehicle road list and exclude `area=yes`.

---

## 2. Repository Structure (target)

```
overpass-turbo-crawler/
├── README.md
├── docker-compose.yml
├── .env.example
├── .gitignore                     # .env, node_modules, dist, output/*.json
├── output/                        # OUTPUT_MODE=json results (mounted to /output)
│   └── .gitkeep
├── docs/
│   ├── PRD.md
│   ├── ARCHITECTURE.md
│   ├── DATA_MODEL.md
│   ├── SETUP.md
│   ├── CONFIGURATION.md
│   ├── OVERPASS_QUERIES.md
│   └── TROUBLESHOOTING.md
├── docker/
│   └── bali-extract/
│       ├── Dockerfile
│       └── extract.sh
├── supabase/
│   ├── config.toml                # created by `supabase init`
│   └── migrations/
│       └── 20261120000000_create_streets.sql
└── crawler/
    ├── Dockerfile
    ├── package.json
    ├── tsconfig.json
    ├── src/
    │   ├── index.ts               # entrypoint: orchestrates the run
    │   ├── config.ts              # env parsing & validation (zod)
    │   ├── logger.ts              # pino
    │   ├── preflight.ts           # status check, find Bali relation, bbox, area
    │   ├── tiles.ts               # split bbox → tiles
    │   ├── overpass.ts            # HTTP client + retry/backoff + query builders
    │   ├── transform.ts           # OSM element → StreetRow ([lon,lat] points, name)
    │   ├── writers/
    │   │   ├── index.ts           # createWriter(OUTPUT_MODE) → StreetWriter
    │   │   ├── db-writer.ts       # pg Pool, batch upsert (WKT), prune
    │   │   └── json-writer.ts     # collect, sort, streaming + atomic write
    │   └── types.ts
    └── test/
        ├── tiles.test.ts
        ├── transform.test.ts
        └── json-writer.test.ts
```

---

## 3. `bali-extract` Service

### 3.1 Dockerfile

```dockerfile
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends osmium-tool curl ca-certificates bzip2 python3 \
 && rm -rf /var/lib/apt/lists/*
COPY extract.sh /usr/local/bin/extract.sh
RUN chmod +x /usr/local/bin/extract.sh
WORKDIR /data
ENTRYPOINT ["/usr/local/bin/extract.sh"]
```

> Save `extract.sh` with **LF** line endings (not CRLF) — important on Windows. Add `*.sh text eol=lf` to `.gitattributes`.

### 3.2 `extract.sh` Flow

Log and error messages are quoted exactly as the script prints them (currently in Indonesian).

```bash
#!/usr/bin/env bash
set -euo pipefail

OUT=/data/bali.osm.bz2
SRC=/data/source.osm.pbf

MAX_SOURCE_SIZE_MB=${MAX_SOURCE_SIZE_MB:-2500}
MAX_EXTRACT_SIZE_MB=${MAX_EXTRACT_SIZE_MB:-300}
# Bali bbox fence (lon/lat) — same as the JSON Schema in DATA_MODEL.md §7.3
BALI_FENCE_MINLON=114.0; BALI_FENCE_MINLAT=-9.2; BALI_FENCE_MAXLON=116.0; BALI_FENCE_MAXLAT=-7.8

fail() { echo "[extract] ERROR: $*" >&2; exit 1; }

if [[ -f "$OUT" && "${FORCE_REEXTRACT:-false}" != "true" ]]; then
  echo "[extract] $OUT sudah ada, dilewati (set FORCE_REEXTRACT=true untuk ulang)."
  exit 0
fi

# 0. ANTI-WORLD-DATA SAFEGUARDS (before any download)
# 0a. Reject planet / large-region URLs
case "${SOURCE_PBF_URL,,}" in
  *planet*|*.osm.bz2|*/asia-latest*|*/asia.osm*)
    fail "SOURCE_PBF_URL terlihat seperti planet/region besar: $SOURCE_PBF_URL" ;;
esac
# 0b. Allowlist: only the Indonesia extract (or its sub-regions) from Geofabrik
if [[ "${ALLOW_ANY_SOURCE:-false}" != "true" ]]; then
  [[ "$SOURCE_PBF_URL" =~ ^https://download\.geofabrik\.de/asia/indonesia(-latest\.osm\.pbf|/[a-z-]+-latest\.osm\.pbf)$ ]] \
    || fail "SOURCE_PBF_URL di luar allowlist (Geofabrik asia/indonesia*). Set ALLOW_ANY_SOURCE=true bila sengaja."
fi
# 0c. Check the size via HEAD before downloading
# "|| true" keeps set -e/pipefail from exiting silently on an HTTP error (e.g. 404),
# so the clear message below is printed instead.
SIZE_BYTES=$( { curl -sfIL "$SOURCE_PBF_URL" || true; } | tr -d '\r' \
  | awk 'tolower($1)=="content-length:"{v=$2} END{print v}')
[[ -n "$SIZE_BYTES" ]] || fail "tidak bisa membaca ukuran file sumber (Content-Length)."
SIZE_MB=$(( SIZE_BYTES / 1024 / 1024 ))
echo "[extract] Ukuran sumber: ${SIZE_MB} MB (batas ${MAX_SOURCE_SIZE_MB} MB)"
(( SIZE_MB <= MAX_SOURCE_SIZE_MB )) || fail "file sumber ${SIZE_MB} MB melebihi MAX_SOURCE_SIZE_MB=${MAX_SOURCE_SIZE_MB}."

# 1. Download the source (resumes if interrupted; --max-filesize as a second fence)
echo "[extract] Download $SOURCE_PBF_URL"
curl -fL --retry 5 -C - --max-filesize $(( MAX_SOURCE_SIZE_MB * 1024 * 1024 )) \
  -o "$SRC" "$SOURCE_PBF_URL"

# 2. Extract all administrative boundary relations (with their member ways/nodes)
osmium tags-filter "$SRC" r/boundary=administrative -o /data/boundaries.osm.pbf --overwrite

# 3. Determine the Bali Province relation ID
if [[ -z "${BALI_RELATION_ID:-}" ]]; then
  BALI_RELATION_ID=$(osmium cat /data/boundaries.osm.pbf -t relation -f opl \
    | grep -E '(^|[ ,T])admin_level=4(,| |$)' \
    | grep -E '(^|[ ,T])name=Bali(,| |$)' \
    | awk '{print substr($1,2)}' | head -n1)
fi
[[ -n "$BALI_RELATION_ID" ]] || { echo "[extract] ERROR: relasi Provinsi Bali tidak ditemukan"; exit 1; }
echo "[extract] Relasi Bali: r$BALI_RELATION_ID"
echo "$BALI_RELATION_ID" > /data/bali-relation-id.txt

# 4. Extract the Bali polygon
osmium getid -r /data/boundaries.osm.pbf "r$BALI_RELATION_ID" -o /data/bali-boundary.osm --overwrite
osmium cat /data/bali-boundary.osm -f xml -o /data/bali-boundary.osm.xml --overwrite
# The implementation builds a .poly file and a complete synthetic boundary relation from the
# outer ways, then uses them for the fence and the Overpass area.

# 5. Clip the source to the Bali bbox fence, then to the Bali polygon.
#    The polygon step uses complete_ways so roads crossing the boundary keep all their
#    nodes (one osm_way_id = one whole OSM way). The bbox fence can stay "simple": ways it
#    cuts lie in Java/Lombok and are dropped by the polygon step anyway.
osmium extract -b 114.0,-9.2,116.0,-7.8 -s simple \
  "$SRC" -o /data/bali-fenced.osm.pbf --overwrite
osmium extract -p /data/bali.poly -s complete_ways \
  /data/bali-fenced.osm.pbf -o /data/bali-full.osm.pbf --overwrite

# 6. Keep only roads + the synthetic Bali boundary relation (for the Overpass area)
osmium tags-filter /data/bali-full.osm.pbf w/highway \
  -o /data/bali-highways-only.osm.pbf --overwrite
osmium merge /data/bali-highways-only.osm.pbf /data/bali-synthetic.osm.pbf \
  -o /data/bali-with-boundary.osm.pbf --overwrite
osmium tags-filter /data/bali-with-boundary.osm.pbf w/highway "r/boundary=administrative" \
  -o /data/bali-filtered.osm.pbf --overwrite

# 7. Validate the result: not empty, bbox inside the Bali fence, reasonable size
WAYS=$(osmium fileinfo -e -g data.count.ways /data/bali-filtered.osm.pbf)
[[ "$WAYS" -gt 0 ]] || fail "hasil extract kosong"
echo "[extract] Jumlah way: $WAYS"

# data.bbox → "(minlon,minlat,maxlon,maxlat)"
BBOX=$(osmium fileinfo -e -g data.bbox /data/bali-filtered.osm.pbf | tr -d '()')
echo "[extract] BBox data: $BBOX"
awk -F, -v a="$BALI_FENCE_MINLON" -v b="$BALI_FENCE_MINLAT" -v c="$BALI_FENCE_MAXLON" -v d="$BALI_FENCE_MAXLAT" \
  '{ exit !($1>=a && $2>=b && $3<=c && $4<=d) }' <<< "$BBOX" \
  || fail "bbox data ($BBOX) keluar dari pagar Bali — kemungkinan polygon/relasi salah."

OUT_MB=$(( $(stat -c %s /data/bali-filtered.osm.pbf) / 1024 / 1024 ))
(( OUT_MB <= MAX_EXTRACT_SIZE_MB )) || fail "hasil extract ${OUT_MB} MB melebihi MAX_EXTRACT_SIZE_MB=${MAX_EXTRACT_SIZE_MB} — bukan data Bali saja?"

# 8. Convert to .osm.bz2 (the format accepted by overpass init)
osmium cat /data/bali-filtered.osm.pbf -o "$OUT.tmp.osm.bz2" --overwrite
mv "$OUT.tmp.osm.bz2" "$OUT"

# 9. Clean up intermediate files (the source is kept if KEEP_SOURCE=true)
rm -f /data/boundaries.osm.pbf /data/bali-full.osm.pbf /data/bali-filtered.osm.pbf
[[ "${KEEP_SOURCE:-false}" == "true" ]] || rm -f "$SRC"
echo "[extract] Selesai → $OUT"
```

Notes:

- Step 6 keeps **all** `r/boundary=administrative` relations inside Bali (regencies, districts, villages). This is intentional: it makes exploring in Overpass Turbo easier and does not affect the crawler. Other relations outside Bali are already filtered out in step 5.
- `osmium tags-filter` keeps referenced objects (member nodes of ways) by default, so geometry stays complete.

### 3.3 Anti-World-Data Safeguards

Goal: make sure planet/large-region data is **never** downloaded or imported, whether through misconfiguration or a typo.

| Layer                                      | Where                                     | Check                                                                                                                                                         | On failure →                            |
| ------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1. URL blocklist                           | `extract.sh` step 0a                      | URL contains `planet`, `.osm.bz2`, `asia-latest`                                                                                                              | exit 1 before download                  |
| 2. URL allowlist                           | `extract.sh` step 0b                      | Only `https://download.geofabrik.de/asia/indonesia-latest.osm.pbf` or `.../asia/indonesia/<sub>-latest.osm.pbf` (bypass: `ALLOW_ANY_SOURCE=true`)             | exit 1 before download                  |
| 3. Size before download                    | `extract.sh` step 0c                      | `Content-Length` ≤ `MAX_SOURCE_SIZE_MB` (default 2500 MB; the full Indonesia extract is still below it, the ~80 GB planet is far above it)                     | exit 1 before download                  |
| 4. Size during download                    | `curl --max-filesize`                     | Second fence in case the server misreports the size                                                                                                           | download aborted                        |
| 5. Extract result bbox                     | `extract.sh` step 7                       | data bbox ⊂ Bali fence (lon 114.0–116.0, lat −9.2 to −7.8)                                                                                                    | exit 1, no file for Overpass            |
| 6. Extract result size                     | `extract.sh` step 7                       | ≤ `MAX_EXTRACT_SIZE_MB` (default 300 MB)                                                                                                                      | exit 1                                  |
| 7. Locked Overpass mode                    | `docker-compose.yml`                      | `OVERPASS_MODE=init`, `OVERPASS_PLANET_URL=file:///data/bali.osm.bz2`, empty `OVERPASS_DIFF_URL` — **written directly (hardcoded), not read from `.env`**      | — (cannot be overridden via `.env`)     |
| 8. Overpass has no access to other files   | `docker-compose.yml`                      | The `osm-data` volume is mounted **read-only**; the only input is `bali.osm.bz2`                                                                              | —                                       |
| 9. Data check in Overpass                  | Crawler preflight ([§6.4](#64-preflight)) | Control points outside Bali (Surabaya, Mataram, Jakarta, Singapore) must return 0 ways                                                                        | exit 2, nothing is written              |

Prohibitions (also noted as comments in `docker-compose.yml`):

- Never change `OVERPASS_MODE` to `clone` (downloads the world Overpass database, hundreds of GB).
- Never set `OVERPASS_DIFF_URL` to a planet replication URL (`planet.openstreetmap.org/replication/...`) — world diffs would be applied too.
- Never point `OVERPASS_PLANET_URL` directly at an internet URL; always go through `bali-extract`.

### 3.4 Behavior at Region Boundaries

(The Bali bbox fence in §3.3 already leaves a margin for this case.)

The polygon step uses the `complete_ways` strategy: a way is kept **whole** if some of its nodes are inside the polygon. So roads that cross the boundary line (usually around ports/coasts) are stored complete, with a few points possibly slightly outside the polygon. Ways are **not cut**, because `osm_way_id` must represent one whole OSM way.

Why not the other strategies:

- `simple` keeps only the nodes inside the polygon. A boundary-crossing way then loses its outside nodes; the crawler drops the missing (`null`) points and joins the remaining ones, which can draw straight segments that don't exist (a way that leaves and re-enters the polygon), or leave < 2 points so the way is skipped.
- `smart` gives the same result for ways as `complete_ways`; its extra work (completing multipolygon relations) is wasted here, because step 6 keeps only `highway` ways plus the synthetic Bali boundary relation built by the script.

The bbox fence step (first `osmium extract`) stays `simple`: ways it cuts lie in Java/Lombok, far from the Bali polygon, and are removed by the polygon step. Since the polygon step reads the fenced file, complete ways can never extend past the fence, so the bbox check in step 7 still holds.

---

## 4. `overpass` Service

Uses the `wiktorn/overpass-api` image (Overpass API + dispatcher + nginx/fcgi ready to use).

| Env                        | Value                       | Description                                        |
| -------------------------- | --------------------------- | -------------------------------------------------- |
| `OVERPASS_MODE`            | `init`                      | Import from the extract file (not a planet DB clone). |
| `OVERPASS_META`            | `no`                        | No metadata needed (user/version/timestamp).       |
| `OVERPASS_PLANET_URL`      | `file:///data/bali.osm.bz2` | Output of `bali-extract`.                          |
| `OVERPASS_USE_AREAS`       | `true`                      | Required for the `(area.bali)` filter.             |
| `OVERPASS_RULES_LOAD`      | `10`                        | Area generator load; Bali is small, so it's fast enough. |
| `OVERPASS_STOP_AFTER_INIT` | `false`                     | Keep running and serving queries after the import. |
| `OVERPASS_MAX_TIMEOUT`     | `600`                       | Query timeout limit (seconds).                     |
| `OVERPASS_SPACE`           | `4294967296`                | Memory limit per query (bytes, 4 GB).              |

`OVERPASS_DIFF_URL` is **not set** → no minutely updates. Data is refreshed by re-importing (see [SETUP.md §7](SETUP.md#7-refreshing-osm-data)).

The import happens only **once** per `overpass-db` volume. To re-import, delete that volume.

---

## 5. `docker-compose.yml`

```yaml
name: bali-streets

services:
  bali-extract:
    build: ./docker/bali-extract
    environment:
      SOURCE_PBF_URL: ${SOURCE_PBF_URL}
      BALI_RELATION_ID: ${BALI_RELATION_ID:-}
      FORCE_REEXTRACT: ${FORCE_REEXTRACT:-false}
      KEEP_SOURCE: ${KEEP_SOURCE:-false}
      MAX_SOURCE_SIZE_MB: ${MAX_SOURCE_SIZE_MB:-2500}
      MAX_EXTRACT_SIZE_MB: ${MAX_EXTRACT_SIZE_MB:-300}
      ALLOW_ANY_SOURCE: ${ALLOW_ANY_SOURCE:-false}
    volumes:
      - osm-data:/data
    restart: "no"

  overpass:
    image: wiktorn/overpass-api:${OVERPASS_IMAGE_TAG:-latest} # pin to a specific tag once tested
    depends_on:
      bali-extract:
        condition: service_completed_successfully
    environment:
      # ⚠ SAFEGUARD: the values below are deliberately hardcoded (not from .env).
      #   - DO NOT change OVERPASS_MODE to "clone" (downloads the world Overpass DB).
      #   - DO NOT set OVERPASS_DIFF_URL (planet diffs would be pulled in).
      #   - DO NOT point OVERPASS_PLANET_URL at an internet URL.
      OVERPASS_MODE: init
      OVERPASS_META: "no"
      OVERPASS_PLANET_URL: file:///data/bali.osm.bz2
      OVERPASS_USE_AREAS: "true"
      OVERPASS_RULES_LOAD: "10"
      OVERPASS_STOP_AFTER_INIT: "false"
      OVERPASS_MAX_TIMEOUT: "600"
      OVERPASS_SPACE: "4294967296"
    volumes:
      - osm-data:/data:ro
      - overpass-db:/db
    ports:
      - "${OVERPASS_HOST_PORT:-12345}:80"
    healthcheck:
      test:
        [
          "CMD-SHELL",
          "curl -fsS http://localhost/api/status >/dev/null || exit 1",
        ]
      interval: 15s
      timeout: 10s
      retries: 10
      start_period: 30m # the first import takes a while
    restart: unless-stopped

  crawler:
    build: ./crawler
    profiles: ["crawl"]
    depends_on:
      overpass:
        condition: service_healthy
    env_file: .env
    environment:
      OVERPASS_URL: http://overpass/api/interpreter
      OUTPUT_DIR: /output
    volumes:
      - ./output:/output # OUTPUT_MODE=json results
    extra_hosts:
      - "host.docker.internal:host-gateway" # reach local Supabase on the host (Linux)
    restart: "no"

volumes:
  osm-data:
  overpass-db:
```

---

## 6. Crawler (Node.js / TypeScript)

### 6.1 Stack

| Need              | Choice                                                          |
| ----------------- | --------------------------------------------------------------- |
| Runtime           | Node.js 22 LTS (built-in fetch)                                 |
| Language          | TypeScript (strict), built to `dist/` with `tsc`                |
| DB driver         | `pg` (node-postgres) — direct PostgreSQL connection, not REST   |
| Config validation | `zod`                                                           |
| Logging           | `pino` (JSON)                                                   |
| Concurrency       | `p-limit`                                                       |
| Tests             | `vitest`                                                        |

**Why `pg` and not `supabase-js`?** PostGIS geometry, conditional upserts (`WHERE ... IS DISTINCT FROM`), large batches, and transactions are much easier and more efficient with direct SQL. The `postgres` connection also bypasses RLS, so no `service_role` key is needed.

### 6.2 Dockerfile

```dockerfile
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=2048
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/index.js"]
```

### 6.3 Run Flow

```
index.ts
 ├─ loadConfig()                         → validate env (including OUTPUT_MODE), failure = exit 1
 ├─ writer = createWriter(config)        → DbWriter | JsonWriter (dry-run: NoopWriter)
 ├─ preflight()
 │   ├─ GET /api/status (retry until PREFLIGHT_TIMEOUT_S)
 │   ├─ find Bali relation  → relationId, bbox
 │   ├─ check area 3600000000+relationId (retry; fallback if CRAWLER_USE_AREA=false)
 │   ├─ guard: control points outside Bali must return 0 ways
 │   ├─ guard: Bali relation bbox ⊂ Bali fence (lon 114.0–116.0, lat −9.2 to −7.8)
 │   └─ writer.preflight()               → db: connection + table exists; json: folder writable, file absent
 │                                       → failure = exit 2 (file exists without OVERWRITE = exit 1)
 ├─ tiles = makeTiles(bbox, TILE_SIZE_DEG)
 ├─ seen = Set<string>()
 ├─ for each tile (in parallel, CONCURRENCY):
 │   ├─ elements = overpass.query(buildStreetsQuery(tile))   ← retry/backoff
 │   ├─ rows = elements.map(transform).filter(valid).filter(id ∉ seen)
 │   ├─ seen.add(...)
 │   └─ await writer.write(rows)
 ├─ await writer.finish({ relationId, osmBase, failedTiles, skipped })
 │     db  : flush buffer, prune if PRUNE && failedTiles == 0
 │     json: sort, stream to .tmp, rename
 ├─ log summary (common + writer.stats())
 └─ exit 0 (success) | 3 (some tile/batch failed)
```

Writer interface:

```ts
interface StreetWriter {
  preflight(): Promise<void>;
  write(rows: StreetRow[]): Promise<void>;
  finish(ctx: RunContext): Promise<void>;
  stats(): Record<string, number | string>;
  close(): Promise<void>;
}
```

The fetch, dedupe, and transform stages **do not know** the output mode; only `createWriter` reads `OUTPUT_MODE`. This guarantees both modes produce identical data (Acceptance 12 in the PRD).

### 6.4 Preflight

**Status:** `GET {OVERPASS_BASE}/api/status` must return `200`.

**Bali relation** (when `BALI_RELATION_ID` is empty):

```
[out:json][timeout:60];
rel["boundary"="administrative"]["admin_level"="4"]["name"="Bali"];
out ids bb;
```

Must return exactly 1 element; `bounds` → `{minlat, minlon, maxlat, maxlon}`. If 0 or >1 → exit 2 with a message.

**Area:** `areaId = 3600000000 + relationId`.

```
[out:json][timeout:60];
area(id:{areaId});
out ids;
```

Retried every 30 seconds until `AREA_WAIT_TIMEOUT_S` (default 1800). Overpass generates areas in the background after the import; on timeout with `CRAWLER_USE_AREA=false` → continue without the area filter (safe because the data layer is already clipped).

**Outside-Bali data guard** (always runs, cannot be disabled): query small bboxes at control points outside Bali; all must return 0 ways. If any returns > 0, Overpass contains data outside Bali → exit 2 before any output is written.

```
[out:json][timeout:60];
(
  way["highway"](-7.30,112.70,-7.24,112.78);   // Surabaya
  way["highway"](-8.60,116.08,-8.56,116.14);   // Mataram, Lombok
  way["highway"](-6.22,106.80,-6.16,106.86);   // Jakarta
  way["highway"](1.27,103.82,1.31,103.88);     // Singapore
);
out count;
```

### 6.5 Tiling

```ts
function makeTiles(b: BBox, size: number): BBox[] {
  const tiles: BBox[] = [];
  for (let s = b.south; s < b.north; s += size)
    for (let w = b.west; w < b.east; w += size)
      tiles.push({
        south: round7(s),
        west: round7(w),
        north: round7(Math.min(s + size, b.north)),
        east: round7(Math.min(w + size, b.east)),
      });
  return tiles;
}
```

The Bali bounding box is roughly lon 114.4–115.8, lat −8.9 to −8.0 → with 0.1° tiles that is about 130–150 tiles (tiles over the sea come back empty quickly).

### 6.6 Road Query per Tile

```
[out:json][timeout:{OVERPASS_QUERY_TIMEOUT_S}];
area(id:{areaId})->.bali;
way
  ["highway"~"^(motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|unclassified|residential|living_street|service|road)$"]
  ["area"!="yes"]
  ({south},{west},{north},{east})
  (area.bali);
out body geom qt;
```

Without the area (`CRAWLER_USE_AREA=false`): drop the `area(...)` line and `(area.bali)`.

The list of `highway` values can be changed via `HIGHWAY_TYPES` (see [CONFIGURATION.md](CONFIGURATION.md)); it is validated to lowercase letters/underscores only before being inserted into the regex.

Request: `POST {OVERPASS_URL}` with body `data=<query>` (`application/x-www-form-urlencoded`).

### 6.7 Retry & Backoff

| Condition                                                       | Action                                     |
| --------------------------------------------------------------- | ------------------------------------------ |
| HTTP 200 + valid JSON, no error `remark`                        | Success                                    |
| HTTP 200 with a `remark` containing `runtime error` / `timed out` | Retry                                    |
| HTTP 429, 500, 502, 503, 504                                    | Retry                                      |
| Network error / client timeout (`HTTP_TIMEOUT_S`)               | Retry                                      |
| HTTP 400 (bad query)                                            | Fail immediately (bug), tile marked failed |

Delay: `min(BASE_DELAY_MS * 2^attempt, 60000) + jitter(0–500ms)`, at most `MAX_RETRIES` times.

### 6.8 Transform

```ts
interface OverpassWay {
  type: "way";
  id: number;
  tags?: Record<string, string>;
  geometry?: ({ lat: number; lon: number } | null)[];
}

interface StreetRow {
  osmWayId: string;
  name: string | null;
  points: [number, number][];
} // [lon, lat]

function toRow(el: OverpassWay): StreetRow | null {
  const points = (el.geometry ?? [])
    .filter((p): p is { lat: number; lon: number } => p !== null)
    .map((p) => [round7(p.lon), round7(p.lat)] as [number, number]);
  if (new Set(points.map((p) => p.join(" "))).size < 2) return null; // skipped
  let name = el.tags?.name?.trim() || null;
  if (name && [...name].length > 150) name = [...name].slice(0, 150).join(""); // + warn
  return { osmWayId: String(el.id), name, points };
}

// used by DbWriter
const toWkt = (r: StreetRow) =>
  `LINESTRING(${r.points.map(([x, y]) => `${x} ${y}`).join(",")})`;
// used by JsonWriter
const toGeoJson = (r: StreetRow) => ({
  type: "LineString",
  coordinates: r.points,
});
```

- `StreetRow` is output-neutral; conversion to WKT/GeoJSON happens in each writer.
- Coordinate order (both WKT and GeoJSON): **lon lat** (x y).
- `osm_way_id` is handled as a string in JS (safe for BIGINT).
- Closed ways (roundabouts, `junction=roundabout`) remain valid LINESTRINGs (first point = last point).
- Elements whose `geometry` contains `null` (missing node) → null points are dropped; if < 2 unique points remain → skipped.

### 6.9 `db` Writer — Batch Upsert

Rows are buffered and flushed every `BATCH_SIZE`. Geometry is sent as WKT (`toWkt`).

```sql
INSERT INTO public.streets (osm_way_id, name, coordinates)
VALUES
  ($1::bigint, $2, ST_GeomFromText($3, 4326)),
  ($4::bigint, $5, ST_GeomFromText($6, 4326)),
  ...
ON CONFLICT (osm_way_id) DO UPDATE
SET name        = EXCLUDED.name,
    coordinates = EXCLUDED.coordinates,
    dt_updated  = NOW()
WHERE public.streets.name IS DISTINCT FROM EXCLUDED.name
   OR NOT ST_Equals(public.streets.coordinates, EXCLUDED.coordinates)
   OR ST_NPoints(public.streets.coordinates) <> ST_NPoints(EXCLUDED.coordinates)
RETURNING (xmax = 0) AS inserted;
```

- `inserted = true` → new row; `false` → updated; rows not returned = **unchanged** (`batchSize − returned`).
- `ST_NPoints` is added because `ST_Equals` treats two lines with a different direction/vertex count but the same shape as equal; we want vertex changes recorded.
- Each batch runs in its own transaction. A failed batch is retried once, then logged as an error (exit 3).
- Dedupe within the batch is required (a Map keyed by `osmWayId`) to avoid the error _"ON CONFLICT DO UPDATE command cannot affect row a second time"_.

### 6.10 `db` Writer — Prune (optional)

Only in `db` mode, when `CRAWLER_PRUNE=true` **and** no tile failed:

```sql
BEGIN;
CREATE TEMP TABLE seen_ids (osm_way_id BIGINT PRIMARY KEY) ON COMMIT DROP;
-- INSERT INTO seen_ids SELECT unnest($1::bigint[])   (in chunks of 10,000 ids)
DELETE FROM public.streets s
WHERE NOT EXISTS (SELECT 1 FROM seen_ids x WHERE x.osm_way_id = s.osm_way_id);
COMMIT;
```

Needs a **session** connection (not the transaction pooler) because it uses a temp table.

### 6.11 `json` Writer

The file format is described in [DATA_MODEL.md §7](DATA_MODEL.md#7-json-output-file-format).

**Preflight:**

- `OUTPUT_DIR` exists & is writable (write then delete a probe file) → exit 2 on failure.
- Final file name = `OUTPUT_FILENAME` or `bali-streets-<YYYYMMDDTHHmmssZ>.json` (run start time, UTC). If it already exists and `OUTPUT_OVERWRITE=false` → exit 1.

**write(rows):** store in a `Map<osmWayId, StreetRow>` (already deduplicated by `seen`). Sorting needs all the data, so rows are held in memory. For Bali (hundreds of thousands of ways) expect tens to hundreds of MB; the crawler image runs Node with `NODE_OPTIONS=--max-old-space-size=2048` as a safety margin.

**finish(ctx):**

```ts
const ids = [...rows.keys()].sort((a, b) =>
  BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0,
);
const tmp = `${finalPath}.tmp`;
const out = fs.createWriteStream(tmp, { encoding: "utf8" });

await writeChunk(out, '{"streets":[');
for (let i = 0; i < ids.length; i++) {
  const r = rows.get(ids[i])!;
  const item = {
    osm_way_id: Number(r.osmWayId),
    name: r.name,
    coordinates: toGeoJson(r),
  };
  // writeChunk respects backpressure: await 'drain' when out.write() returns false
  await writeChunk(
    out,
    (i ? "," : "") + (pretty ? "\n    " : "") + JSON.stringify(item),
  );
}
await writeChunk(
  out,
  '],"meta":' + JSON.stringify(buildMeta(ctx, ids.length)) + "}",
);
await closeStream(out); // fsync before rename
await fs.promises.rename(tmp, finalPath);
```

- `streets` is written **before** `meta` so `meta.count` is final without holding a large string.
- `osm_way_id` is written as a JSON number (OSM IDs are far below `Number.MAX_SAFE_INTEGER`).
- If any tile failed, the file is still written with `meta.tiles_failed > 0`, then exit 3.
- If the process errors before the rename, the `.tmp` file is deleted in `close()` (best effort).
- `OUTPUT_PRETTY=true` → 2-space indentation at the item level (~30–40% larger).

**Stats:** `written`, `outputFile`, `bytes`.

### 6.12 Dry-run

`CRAWLER_DRY_RUN=true` replaces any writer with a `NoopWriter` that only counts rows. No DB connection and no file is created.

### 6.13 Exit Codes

| Code | Meaning                                                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Full success                                                                                                                     |
| 1    | Invalid configuration (including a bad `OUTPUT_MODE`, or the output file existing without `OUTPUT_OVERWRITE`)                    |
| 2    | Preflight failed (Overpass/relation/area not ready; DB not ready for `db` mode; output folder not writable for `json` mode)      |
| 3    | Partially completed (some tile or batch failed; in `json` mode the file is still written)                                        |

### 6.14 Example Summary Logs

`db` mode:

```json
{
  "level": "info",
  "msg": "crawl finished",
  "outputMode": "db",
  "relationId": "<id>",
  "tiles": 142,
  "tilesFailed": 0,
  "waysReceived": 0,
  "waysUnique": 0,
  "skipped": 0,
  "inserted": 0,
  "updated": 0,
  "unchanged": 0,
  "pruned": 0,
  "durationMs": 0
}
```

`json` mode:

```json
{
  "level": "info",
  "msg": "crawl finished",
  "outputMode": "json",
  "relationId": "<id>",
  "tiles": 142,
  "tilesFailed": 0,
  "waysReceived": 0,
  "waysUnique": 0,
  "skipped": 0,
  "written": 0,
  "outputFile": "/output/bali-streets-20261120T080000Z.json",
  "bytes": 0,
  "durationMs": 0
}
```

---

## 7. Connecting to Supabase (`db` mode)

Not relevant for `json` mode.

| Target                                | `DATABASE_URL` from inside the crawler container                                                  | SSL       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- | --------- |
| Local Supabase (CLI)                  | `postgresql://postgres:postgres@host.docker.internal:54322/postgres`                              | `disable` |
| Supabase cloud (Session Pooler, IPv4) | `postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres` | `require` |
| Supabase cloud (Direct, IPv6)         | `postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres`                     | `require` |

Use the **Session Pooler (port 5432)** for cloud: IPv4-friendly and supports temp tables (prune). The transaction pooler (port 6543) is not recommended.

---

## 8. Testing

| Level                  | Coverage                                                                                                                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit (`vitest`)        | `makeTiles` (full bbox coverage, no overlap), `toRow` (lon/lat order, < 2 points, empty/long names, multibyte), query builders (escaping/validating `HIGHWAY_TYPES`), `JsonWriter` (id order, valid JSON, `meta.count`, atomic: no leftover `.tmp`, refuses overwrite). |
| `db` integration       | Run the full stack with local Supabase; run the crawler twice and check idempotency (inserted=0, updated=0 on the second run).                                                                                                                                               |
| `json` integration     | Run without Supabase; validate the file against the schema; run twice and compare the `streets` arrays (must be identical).                                                                                                                                                  |
| Cross-mode consistency | From an empty table: run `db` mode, then `json` → same set of `osm_way_id` values.                                                                                                                                                                                           |
| Data validation        | Queries in [DATA_MODEL.md §6](DATA_MODEL.md#6-validation-queries).                                                                                                                                                                                                           |
