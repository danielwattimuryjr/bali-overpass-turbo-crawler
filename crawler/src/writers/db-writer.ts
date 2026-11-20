import pg from "pg";
import fs from "node:fs";
import type { Config } from "../config.js";
import type { RunContext, StreetRow, StreetWriter } from "../types.js";
import { toWkt } from "../transform.js";

const { Pool } = pg;

export class DbWriter implements StreetWriter {
  private pool: pg.Pool;
  private buffer: StreetRow[] = [];
  private seen = new Set<string>();
  private inserted = 0;
  private updated = 0;
  private unchanged = 0;
  private pruned = 0;

  constructor(private config: Config) {
    const ssl =
      config.DATABASE_SSL === "disable"
        ? false
        : config.DATABASE_SSL === "verify-full"
          ? {
              ca: fs.readFileSync(config.DATABASE_SSL_CA!),
              rejectUnauthorized: true,
            }
          : { rejectUnauthorized: false };
    this.pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: config.DB_POOL_MAX,
      ssl,
    });
  }

  async preflight(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT 1");
      await client.query("SELECT to_regclass('public.streets') AS table_name");
      const result = await client.query(
        "SELECT to_regclass('public.streets') AS table_name",
      );
      if (!result.rows[0]?.table_name)
        throw new Error("Tabel public.streets tidak ditemukan");
    } finally {
      client.release();
    }
  }

  async write(rows: StreetRow[]): Promise<void> {
    const batchMap = new Map<string, StreetRow>();
    for (const row of rows) {
      this.seen.add(row.osmWayId);
      batchMap.set(row.osmWayId, row);
    }
    this.buffer.push(...batchMap.values());
    while (this.buffer.length >= this.config.BATCH_SIZE) {
      const flushRows = this.buffer.splice(0, this.config.BATCH_SIZE);
      await this.flushBatch(flushRows);
    }
  }

  private async flushBatch(rows: StreetRow[]): Promise<void> {
    const deduped = new Map<string, StreetRow>();
    for (const row of rows) deduped.set(row.osmWayId, row);
    const values: unknown[] = [];
    const tuples: string[] = [];
    [...deduped.values()].forEach((row, index) => {
      const offset = index * 3;
      values.push(row.osmWayId, row.name, toWkt(row));
      tuples.push(
        `($${offset + 1}::bigint,$${offset + 2},ST_GeomFromText($${offset + 3},4326))`,
      );
    });

    const sql = `INSERT INTO public.streets (osm_way_id,name,coordinates)
VALUES ${tuples.join(",")}
ON CONFLICT (osm_way_id) DO UPDATE
SET name=EXCLUDED.name,
    coordinates=EXCLUDED.coordinates,
    dt_updated=NOW()
WHERE public.streets.name IS DISTINCT FROM EXCLUDED.name
   OR NOT ST_Equals(public.streets.coordinates,EXCLUDED.coordinates)
   OR ST_NPoints(public.streets.coordinates) <> ST_NPoints(EXCLUDED.coordinates)
RETURNING (xmax = 0) AS inserted`;

    const run = async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query(sql, values);
        await client.query("COMMIT");
        let inserted = 0;
        let updated = 0;
        for (const row of result.rows) {
          if (row.inserted) inserted += 1;
          else updated += 1;
        }
        this.inserted += inserted;
        this.updated += updated;
        this.unchanged += deduped.size - (result.rowCount ?? 0);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    };

    try {
      await run();
    } catch (error) {
      await run().catch(() => {
        throw error;
      });
    }
  }

  async finish(ctx: RunContext): Promise<void> {
    if (this.buffer.length) {
      const remaining = this.buffer.splice(0);
      await this.flushBatch(remaining);
    }
    if (this.config.CRAWLER_PRUNE && ctx.failedTiles === 0) {
      const ids = [...this.seen];
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "CREATE TEMP TABLE seen_ids (osm_way_id BIGINT PRIMARY KEY) ON COMMIT DROP",
        );
        for (let i = 0; i < ids.length; i += 10000) {
          await client.query(
            "INSERT INTO seen_ids SELECT unnest($1::bigint[])",
            [ids.slice(i, i + 10000)],
          );
        }
        const result = await client.query(`DELETE FROM public.streets s
WHERE NOT EXISTS (SELECT 1 FROM seen_ids x WHERE x.osm_way_id=s.osm_way_id)`);
        this.pruned = result.rowCount ?? 0;
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
  }

  stats(): Record<string, number | string> {
    return {
      inserted: this.inserted,
      updated: this.updated,
      unchanged: this.unchanged,
      pruned: this.pruned,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
