import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import type { RunContext, StreetRow, StreetWriter } from "../types.js";

export class JsonOutputConflictError extends Error {}

export class JsonWriter implements StreetWriter {
  private rows = new Map<string, StreetRow>();
  private finalPath = "";
  private tmpPath = "";
  private written = 0;
  private bytes = 0;
  private startedAt = new Date();

  constructor(private config: Config) {}

  async preflight(): Promise<void> {
    await fs.promises.mkdir(this.config.OUTPUT_DIR, { recursive: true });

    const filename =
      this.config.OUTPUT_FILENAME ||
      `bali-streets-${this.startedAt
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}Z$/, "Z")}.json`;
    if (
      !filename ||
      filename.includes("/") ||
      filename.includes("\\") ||
      !filename.endsWith(".json")
    ) {
      throw new Error(
        "OUTPUT_FILENAME hanya boleh berupa nama file JSON tanpa / atau \\",
      );
    }

    this.finalPath = path.join(this.config.OUTPUT_DIR, filename);
    try {
      await fs.promises.access(
        this.config.OUTPUT_DIR,
        fs.constants.R_OK | fs.constants.W_OK,
      );
      const probe = path.join(
        this.config.OUTPUT_DIR,
        `.bali-write-probe-${process.pid}`,
      );
      await fs.promises.writeFile(probe, "", { flag: "wx" });
      await fs.promises.rm(probe, { force: true });
    } catch (error) {
      throw new Error(
        `Folder output tidak writable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      await fs.promises.access(this.finalPath);
      if (!this.config.OUTPUT_OVERWRITE) {
        throw new JsonOutputConflictError(
          `File output sudah ada: ${this.finalPath}`,
        );
      }
    } catch (error) {
      if (error instanceof JsonOutputConflictError) throw error;
    }
  }

  async write(rows: StreetRow[]): Promise<void> {
    for (const row of rows) this.rows.set(row.osmWayId, row);
  }

  private async writeChunk(
    stream: fs.WriteStream,
    chunk: string,
  ): Promise<void> {
    if (stream.write(chunk, "utf8")) return;
    await new Promise<void>((resolve) => {
      stream.once("drain", resolve);
    });
  }

  async finish(ctx: RunContext): Promise<void> {
    this.tmpPath = `${this.finalPath}.tmp`;
    await fs.promises.rm(this.tmpPath, { force: true });

    const stream = fs.createWriteStream(this.tmpPath, {
      encoding: "utf8",
      flags: "wx",
    });
    try {
      await new Promise<void>((resolve, reject) => {
        stream.once("open", () => resolve());
        stream.once("error", reject);
      });

      const ids = [...this.rows.keys()].sort((a, b) => {
        const left = BigInt(a);
        const right = BigInt(b);
        return left < right ? -1 : left > right ? 1 : 0;
      });

      await this.writeChunk(stream, '{"streets":[');
      for (let i = 0; i < ids.length; i++) {
        const row = this.rows.get(ids[i])!;
        const item = {
          osm_way_id: Number(row.osmWayId),
          name: row.name,
          coordinates: { type: "LineString", coordinates: row.points },
        };
        const prefix = i === 0 ? "" : ",";
        const prettyPrefix = this.config.OUTPUT_PRETTY ? "\n    " : "";
        await this.writeChunk(
          stream,
          prefix + prettyPrefix + JSON.stringify(item),
        );
      }

      const meta = {
        format_version: 1,
        source: "OpenStreetMap via Overpass API (local)",
        license: "ODbL 1.0 — © OpenStreetMap contributors",
        region: "Provinsi Bali",
        bali_relation_id: Number(ctx.relationId),
        highway_types: this.config.highwayTypes,
        srid: 4326,
        coordinate_order: "lon,lat",
        generated_at: this.startedAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
        osm_base_timestamp: ctx.osmBase ?? "",
        count: ids.length,
        skipped: ctx.skipped,
        tiles_total: ctx.tilesTotal,
        tiles_failed: ctx.failedTiles,
      };

      await this.writeChunk(
        stream,
        '],"meta":' +
          (this.config.OUTPUT_PRETTY
            ? "\n  " + JSON.stringify(meta, null, 2).replace(/\n/g, "\n  ")
            : JSON.stringify(meta)) +
          "}",
      );

      await new Promise<void>((resolve, reject) => {
        stream.end(() => resolve());
        stream.once("error", reject);
      });

      const handle = await fs.promises.open(this.tmpPath, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.promises.rename(this.tmpPath, this.finalPath);

      const stat = await fs.promises.stat(this.finalPath);
      this.written = ids.length;
      this.bytes = stat.size;
    } catch (error) {
      await fs.promises.rm(this.tmpPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  stats(): Record<string, number | string> {
    return {
      written: this.written,
      outputFile: this.finalPath,
      bytes: this.bytes,
    };
  }

  async close(): Promise<void> {
    await fs.promises.rm(this.tmpPath, { force: true }).catch(() => {});
  }
}
