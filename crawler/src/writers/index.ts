import type { Config } from "../config.js";
import type { StreetWriter } from "../types.js";
import { DbWriter } from "./db-writer.js";
import { JsonWriter } from "./json-writer.js";

export { JsonOutputConflictError } from "./json-writer.js";

class NoopWriter implements StreetWriter {
  private count = 0;
  async preflight(): Promise<void> {}
  async write(rows: any[]): Promise<void> {
    this.count += rows.length;
  }
  async finish(): Promise<void> {}
  stats(): Record<string, number | string> {
    return { written: this.count };
  }
  async close(): Promise<void> {}
}

export function createWriter(config: Config): StreetWriter {
  if (config.CRAWLER_DRY_RUN) return new NoopWriter();
  if (config.OUTPUT_MODE === "db") return new DbWriter(config);
  if (config.OUTPUT_MODE === "json") return new JsonWriter(config);
  throw new Error("OUTPUT_MODE harus db atau json");
}
