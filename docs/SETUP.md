# Setup & Run Guide

This guide assumes every file in [ARCHITECTURE.md §2](ARCHITECTURE.md#2-repository-structure-target) has been implemented.

Commands are shown for **PowerShell** (Windows) and **bash/zsh** (Linux, macOS, WSL). `docker compose ...` and `npx supabase ...` commands are identical on every OS, so they are shown once; only shell-specific commands (copying files, environment variables, HTTP requests, exit codes) get a separate bash version.

---

## 1. Prerequisites

| Requirement | Version / Notes |
|---|---|
| Docker Desktop (Windows/macOS) or Docker Engine (Linux) | Compose v2 (`docker compose`, not `docker-compose`) |
| Windows | WSL2 backend enabled in Docker Desktop |
| Docker resources | RAM ≥ 4 GB (6–8 GB recommended), ≥ 10 GB free disk |
| Node.js | 22 LTS — only for the Supabase CLI via `npx` & crawler development |
| Supabase CLI | Via `npx supabase` (no global install needed) — only for local Supabase |
| Internet connection | To download the OSM extract the first time |

All images used (`wiktorn/overpass-api`, `node:22-bookworm-slim`, `debian:bookworm-slim`) are published for `linux/amd64` and `linux/arm64`, so the stack runs natively on Intel/AMD machines and on Apple Silicon Macs (no emulation).

Platform notes:

| Platform | Notes |
|---|---|
| Windows | Docker Desktop with the WSL2 backend. Use PowerShell commands, or bash commands inside WSL. |
| Linux | Docker Engine + Compose plugin. If `docker` needs `sudo`, add yourself to the `docker` group: `sudo usermod -aG docker $USER`, then log out and back in. `host.docker.internal` is provided by `extra_hosts: host-gateway` in compose. |
| macOS | Docker Desktop (or OrbStack/Colima). Give Docker ≥ 6 GB RAM under Settings → Resources. `host.docker.internal` works out of the box. |

Check (same on every OS):

```powershell
docker version
```

```powershell
docker compose version
```

```powershell
node --version
```

---

## 2. Prepare the Configuration

PowerShell:

```powershell
Copy-Item .env.example .env
```

bash/zsh:

```bash
cp .env.example .env
```

Edit `.env` for your target DB (see [CONFIGURATION.md](CONFIGURATION.md)).

---

## 3. Prepare the Database

> **Skip this section if you only use the JSON file output** (`OUTPUT_MODE=json`) — Supabase is not needed. Go straight to §4, then §5.2.

Pick **one**.

### 3A. Local Supabase

1. Initialize (once; skip if the `supabase/` folder with `config.toml` already exists):

   ```powershell
   npx supabase init
   ```

2. Start local Supabase (pulls Docker images, takes a few minutes the first time):

   ```powershell
   npx supabase start
   ```

   Note the output: `DB URL` (default `postgresql://postgres:postgres@127.0.0.1:54322/postgres`) and `Studio URL` (default `http://127.0.0.1:54323`).

3. Apply the migration `supabase/migrations/20261120000000_create_streets.sql`:

   ```powershell
   npx supabase migration up
   ```

   (Alternative that wipes all local data and reapplies every migration: `npx supabase db reset`.)

4. In `.env`:

   ```dotenv
   DATABASE_URL=postgresql://postgres:postgres@host.docker.internal:54322/postgres
   DATABASE_SSL=disable
   ```

### 3B. Supabase Cloud

1. Create a project in the Supabase dashboard.
2. Apply the migration — either:
   - **SQL Editor**: paste the migration file contents ([DATA_MODEL.md §3](DATA_MODEL.md#3-migration-file)) and Run; or
   - **CLI**:

     ```powershell
     npx supabase login
     ```

     ```powershell
     npx supabase link --project-ref <project-ref>
     ```

     ```powershell
     npx supabase db push
     ```

3. Get the connection string: Dashboard → **Connect** → **Session pooler**. Fill in `.env`:

   ```dotenv
   DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
   DATABASE_SSL=require
   ```

   If the password contains special characters (`@`, `:`, `/`, `#`, `%`), URL-encode it first.

---

## 4. Run Local Overpass (Bali Data)

```powershell
docker compose up -d --build overpass
```

What happens:
1. `bali-extract` runs first: safeguard checks (URL & size) → download the regional extract → detect the Bali relation → clip to the polygon → filter `highway` → check the result's bbox & size → write `bali.osm.bz2`, then exit.
2. `overpass` imports that file (once), builds areas, then serves queries.

> **No world data is downloaded.** Only the Geofabrik Indonesia extract (~1.7 GB; Geofabrik offers nothing smaller that covers Bali) is downloaded and then clipped to Bali. If the source URL points to the planet/a large region or its size exceeds `MAX_SOURCE_SIZE_MB`, the process stops **before** downloading. Make sure the log has a `Ukuran sumber: ... MB` ("source size") line with a reasonable number. Details: [ARCHITECTURE.md §3.3](ARCHITECTURE.md#33-anti-world-data-safeguards).

Watch progress:

```powershell
docker compose logs -f bali-extract overpass
```

Check status until it is `healthy`:

```powershell
docker compose ps
```

Test the API, check that the Bali relation exists (must be 1 element), and check that there is no data outside Bali, e.g. a Surabaya bbox (must be empty / `0`).

PowerShell:

```powershell
curl.exe "http://localhost:12345/api/status"
```

```powershell
(Invoke-RestMethod -Method Post -Uri "http://localhost:12345/api/interpreter" -Body @{ data = '[out:json];rel["boundary"="administrative"]["admin_level"="4"]["name"="Bali"];out ids;' }).elements
```

```powershell
(Invoke-RestMethod -Method Post -Uri "http://localhost:12345/api/interpreter" -Body @{ data = '[out:json];way["highway"](-7.35,112.6,-7.2,112.8);out ids;' }).elements.Count
```

> `Invoke-RestMethod` is used because Windows PowerShell 5.1 drops double quotes when passing arguments to `curl.exe`.

bash/zsh:

```bash
curl -sS http://localhost:12345/api/status
```

```bash
curl -sS http://localhost:12345/api/interpreter \
  --data-urlencode 'data=[out:json];rel["boundary"="administrative"]["admin_level"="4"]["name"="Bali"];out ids;'
```

```bash
curl -sS http://localhost:12345/api/interpreter \
  --data-urlencode 'data=[out:json];way["highway"](-7.35,112.6,-7.2,112.8);out ids;'
```

The second command must list exactly one element with `"type": "relation"`; in the last one the `"elements"` list must be empty. `-sS` keeps the output quiet but still prints connection errors, so a stopped server shows up as an error (e.g. `Failed to connect to localhost port 12345`) instead of looking like an empty, passing result. With `jq` installed you can append `| jq '.elements | length'` to get the count directly (`1` and `0`).

---

## 5. Run the Crawler

The crawler has **2 output types**, selected with `OUTPUT_MODE` (in `.env` or via `-e` at run time):

| Mode | Result | Needs Supabase |
|---|---|---|
| `db` (default) | Upsert into `public.streets` | Yes |
| `json` | File `./output/bali-streets-<timestamp>.json` | No |

`crawler` is in the `crawl` profile, so it is not started by `docker compose up`. `docker compose run` automatically waits for `overpass` to be healthy.

Dry-run (writes no output at all, works for both modes):

```powershell
docker compose run --rm --build -e CRAWLER_DRY_RUN=true crawler
```

### 5.1 Output to the Database

Make sure Supabase (local/cloud) is ready (§3) and `DATABASE_URL` in `.env` is correct.

```powershell
docker compose run --rm -e OUTPUT_MODE=db crawler
```

The final summary contains `inserted`, `updated`, `unchanged`, `skipped`, `tilesFailed`.

With prune (delete roads that no longer exist in OSM):

```powershell
docker compose run --rm -e OUTPUT_MODE=db -e CRAWLER_PRUNE=true crawler
```

### 5.2 Output to a JSON File

Create the output folder (once).

PowerShell:

```powershell
New-Item -ItemType Directory -Force output
```

bash/zsh:

```bash
mkdir -p output
```

Run (same on every OS):

```powershell
docker compose run --rm -e OUTPUT_MODE=json crawler
```

With a fixed file name and indented format (overwrites the old file):

```powershell
docker compose run --rm -e OUTPUT_MODE=json -e OUTPUT_FILENAME=bali-streets.json -e OUTPUT_OVERWRITE=true -e OUTPUT_PRETTY=true crawler
```

Check the result.

PowerShell:

```powershell
Get-ChildItem output
```

bash/zsh:

```bash
ls -la output
```

File format & how to validate it: [DATA_MODEL.md §7](DATA_MODEL.md#7-json-output-file-format). The final summary contains `written`, `outputFile`, `bytes`.

> Linux: the container runs as the `node` user (UID 1000). If the `output` folder is owned by another user, run `sudo chown 1000:1000 output` so it is writable.

### 5.3 Exit Codes

Right after the crawler finishes, read its exit code.

PowerShell:

```powershell
$LASTEXITCODE
```

bash/zsh:

```bash
echo $?
```

| Exit code | Meaning |
|---|---|
| 0 | Success |
| 1 | Bad configuration (including the JSON file already existing without `OUTPUT_OVERWRITE=true`) |
| 2 | Preflight failed (Overpass/area not ready; DB not ready for `db`; output folder not writable for `json`) |
| 3 | Some tiles/batches failed — rerun (`db` mode is idempotent; `json` mode still writes the file with `meta.tiles_failed > 0`) |

---

## 6. Verify the Data

**`json` mode:** run the validation command in [DATA_MODEL.md §7.4](DATA_MODEL.md#74-file-validation); make sure `meta.tiles_failed = 0` and there are no leftover `.tmp` files in `output/`.

**`db` mode:**

- **Supabase Studio** (local `http://127.0.0.1:54323` / cloud dashboard) → Table Editor → `streets`.
- Run the validation queries in [DATA_MODEL.md §6](DATA_MODEL.md#6-validation-queries).
- Via local `psql`:

  ```powershell
  docker exec -it supabase_db_overpass-turbo-crawler psql -U postgres -c "SELECT COUNT(*) FROM public.streets;"
  ```

  (The container name follows `project_id` in `supabase/config.toml`; check with `docker ps`.)

- Run the crawler once more → it must report `inserted=0` and `updated=0` (idempotent).

---

## 7. Refreshing OSM Data

Overpass data does not update on its own. To update to the latest extract:

```powershell
docker compose down
```

```powershell
docker volume rm bali-streets_overpass-db
```

Then rebuild with `FORCE_REEXTRACT=true`, and once `overpass` is healthy, run the crawler again without it.

PowerShell (the variable stays set in the session, so remove it afterwards):

```powershell
$env:FORCE_REEXTRACT = "true"; docker compose up -d overpass
```

```powershell
Remove-Item Env:FORCE_REEXTRACT; docker compose run --rm crawler
```

bash/zsh (an inline variable applies to that one command only, nothing to unset):

```bash
FORCE_REEXTRACT=true docker compose up -d overpass
```

```bash
docker compose run --rm crawler
```

> Volume names are prefixed with the compose project name (`bali-streets`). Check with `docker volume ls`.

---

## 8. Overpass Turbo with the Local Server

1. Open https://overpass-turbo.eu in your browser.
2. **Settings → General → Server**: enter `http://localhost:12345/api/` → Save.
3. Try the queries from [OVERPASS_QUERIES.md](OVERPASS_QUERIES.md).

Browsers treat `http://localhost` as a trustworthy origin, so an HTTPS page may call it. If your browser blocks it, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

---

## 9. Crawler Development (without Docker)

Install dependencies (same on every OS):

```bash
cd crawler
```

```bash
npm ci
```

Run in `db` mode, then in `json` mode.

PowerShell:

```powershell
$env:OVERPASS_URL = "http://localhost:12345/api/interpreter"; $env:DATABASE_URL = "postgresql://postgres:postgres@localhost:54322/postgres"; npm run dev
```

```powershell
$env:OVERPASS_URL = "http://localhost:12345/api/interpreter"; $env:OUTPUT_MODE = "json"; $env:OUTPUT_DIR = "../output"; npm run dev
```

bash/zsh:

```bash
OVERPASS_URL=http://localhost:12345/api/interpreter DATABASE_URL=postgresql://postgres:postgres@localhost:54322/postgres npm run dev
```

```bash
OVERPASS_URL=http://localhost:12345/api/interpreter OUTPUT_MODE=json OUTPUT_DIR=../output npm run dev
```

> The crawler reads variables from the process environment only; it does not load `.env` by itself. When running without Docker, pass the variables as shown (or export them in your shell).

Tests (same on every OS):

```powershell
npm test
```

Expected `package.json` scripts:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "lint": "tsc --noEmit"
  }
}
```

---

## 10. Stopping & Cleaning Up

Stop Overpass (data stays in the volume):

```powershell
docker compose down
```

Remove everything, including OSM data & the Overpass DB:

```powershell
docker compose down -v
```

Stop local Supabase:

```powershell
npx supabase stop
```
