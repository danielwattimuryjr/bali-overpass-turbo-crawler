# Bali Streets Crawler

A crawler that fetches **vehicle roads in Bali Province** from a **local Overpass API** (Docker) with **2 output types**:

- **`db`** — upserted directly into the `public.streets` table in **Supabase** (local or cloud).
- **`json`** — written to a JSON file in `./output` (no Supabase needed).

```
Geofabrik .pbf ─► bali-extract (osmium, Bali polygon) ─► local Overpass API ─► crawler (Node/TS) ─┬─► Supabase public.streets   (OUTPUT_MODE=db)
                                                               ▲                                  └─► ./output/*.json           (OUTPUT_MODE=json)
                                                     Overpass Turbo (UI)
```

- **Bali only**: OSM data is clipped to the Bali Province administrative polygon before being imported into Overpass, and every query still uses the Bali `area` filter.
- **Roads only**: `highway` = motorway, trunk, primary, secondary, tertiary (+ `_link`), unclassified, residential, living_street, service, road. Footway/path/track/cycleway are excluded.
- **Idempotent** (`db` mode): upsert keyed on `osm_way_id`; `dt_updated` only changes when the name/geometry changes.
- **Deterministic** (`json` mode): `streets` entries are unique and sorted by `osm_way_id`; written atomically (`.tmp` → rename).

## Quick Start

Runs on Windows, Linux, and macOS (Intel and Apple Silicon). Every `docker compose` / `npx supabase` command is the same on all of them; only the first two setup steps differ by shell.

Copy the config and create the output folder.

PowerShell (Windows):

```powershell
Copy-Item .env.example .env
```

```powershell
New-Item -ItemType Directory -Force output
```

bash/zsh (Linux, macOS, WSL):

```bash
cp .env.example .env
```

```bash
mkdir -p output
```

Start local Overpass with Bali data:

```bash
docker compose up -d --build overpass
```

**Output to a JSON file** (no Supabase):

```bash
docker compose run --rm --build -e OUTPUT_MODE=json crawler
```

**Output to the database** (local Supabase):

```bash
npx supabase start
```

```bash
npx supabase migration up
```

```bash
docker compose run --rm --build -e OUTPUT_MODE=db crawler
```

Full details, including platform notes, are in [docs/SETUP.md](docs/SETUP.md).

## Documentation

| Document | Contents |
|---|---|
| [docs/PRD.md](docs/PRD.md) | Product requirements: goals, scope, functional/non-functional requirements, acceptance criteria, milestones. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Technical design: repo structure, Docker Compose, extract script, crawler design (tiling, queries, retry, upsert). |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Table schema, migration file, OSM → column mapping, validation queries, output file format & JSON Schema. |
| [docs/SETUP.md](docs/SETUP.md) | Installation and run steps (local/cloud Supabase, Overpass, crawler, data refresh). |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | All `.env` variables. |
| [docs/OVERPASS_QUERIES.md](docs/OVERPASS_QUERIES.md) | Ready-to-use queries for Overpass Turbo and verification. |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common problems and their fixes. |

## Stack

Docker Compose · `wiktorn/overpass-api` · osmium-tool · Node.js 22 + TypeScript (`pg`, `zod`, `pino`) · Supabase (PostgreSQL + PostGIS)

## Data License

Road data comes from © OpenStreetMap contributors, licensed under the [ODbL](https://opendatacommons.org/licenses/odbl/). Applications that display this data must include OpenStreetMap attribution.
