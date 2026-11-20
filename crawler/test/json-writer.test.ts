import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../src/config.js";
import {
  JsonWriter,
  JsonOutputConflictError,
} from "../src/writers/json-writer.js";

function tempConfig(outputDir: string, extra: Record<string, string> = {}) {
  return loadConfig({
    OUTPUT_MODE: "json",
    OUTPUT_DIR: outputDir,
    OUTPUT_FILENAME: "test.json",
    OUTPUT_OVERWRITE: "false",
    OUTPUT_PRETTY: "false",
    CRAWLER_USE_AREA: "false",
    ...extra,
  });
}

describe("JsonWriter", () => {
  it("writes sorted unique streets atomically with valid meta", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "bali-json-"));
    const writer = new JsonWriter(tempConfig(dir));
    await writer.preflight();
    await writer.write([
      {
        osmWayId: "200",
        name: "B",
        points: [
          [115.2, -8.2],
          [115.21, -8.21],
        ],
      },
      {
        osmWayId: "100",
        name: null,
        points: [
          [115.1, -8.1],
          [115.11, -8.11],
        ],
      },
    ]);
    await writer.finish({
      relationId: "1615621",
      osmBase: "2026-11-19T14:54:19Z",
      failedTiles: 0,
      skipped: 0,
      tilesTotal: 195,
    });

    const finalPath = path.join(dir, "test.json");
    const result = JSON.parse(await fs.promises.readFile(finalPath, "utf8"));
    expect(
      result.streets.map((row: { osm_way_id: number }) => row.osm_way_id),
    ).toEqual([100, 200]);
    expect(result.meta.count).toBe(2);
    expect(result.meta.format_version).toBe(1);
    expect(result.meta.tiles_failed).toBe(0);
    await expect(fs.promises.access(`${finalPath}.tmp`)).rejects.toThrow();
  });

  it("rejects an existing file unless overwrite is true", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "bali-json-"));
    await fs.promises.writeFile(path.join(dir, "test.json"), "{}");

    const writer = new JsonWriter(tempConfig(dir));
    await expect(writer.preflight()).rejects.toBeInstanceOf(
      JsonOutputConflictError,
    );

    const overwriteWriter = new JsonWriter(
      tempConfig(dir, { OUTPUT_OVERWRITE: "true" }),
    );
    await expect(overwriteWriter.preflight()).resolves.toBeUndefined();
  });

  it("deduplicates osm_way_id and writes LineString coordinates", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "bali-json-"));
    const writer = new JsonWriter(tempConfig(dir));
    await writer.preflight();
    await writer.write([
      {
        osmWayId: "10",
        name: "A",
        points: [
          [115, -8],
          [115.01, -8.01],
        ],
      },
      {
        osmWayId: "10",
        name: "Duplicate",
        points: [
          [115, -8],
          [115.02, -8.02],
        ],
      },
    ]);
    await writer.finish({
      relationId: "1615621",
      failedTiles: 0,
      skipped: 0,
      tilesTotal: 1,
    });
    const result = JSON.parse(
      await fs.promises.readFile(path.join(dir, "test.json"), "utf8"),
    );
    expect(result.streets).toHaveLength(1);
    expect(result.streets[0].coordinates.type).toBe("LineString");
  });
});
