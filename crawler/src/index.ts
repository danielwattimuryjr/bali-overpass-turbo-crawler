import pLimit from "p-limit";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { preflight } from "./preflight.js";
import { makeTiles } from "./tiles.js";
import { buildStreetsQuery, queryWithRetry, waysFrom } from "./overpass.js";
import { toRow } from "./transform.js";
import { createWriter, JsonOutputConflictError } from "./writers/index.js";

const EXIT_CONFIG = 1;
const EXIT_PREFLIGHT = 2;
const EXIT_PARTIAL = 3;

async function main(): Promise<number> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: error instanceof Error ? error.message : String(error),
      }),
    );
    return EXIT_CONFIG;
  }

  const log = createLogger(config.LOG_LEVEL);
  if (config.OUTPUT_MODE === "json" && config.CRAWLER_PRUNE) {
    log.warn("CRAWLER_PRUNE diabaikan pada mode JSON");
  }
  const started = Date.now();
  let writer;
  try {
    writer = createWriter(config);
  } catch (error) {
    log.error({ err: error }, "Konfigurasi writer gagal");
    return EXIT_CONFIG;
  }

  let preflightResult;
  try {
    preflightResult = await preflight(config);
    await writer.preflight();
  } catch (error) {
    if (error instanceof JsonOutputConflictError) {
      log.error({ err: error }, "Konfigurasi output JSON gagal");
      await writer.close().catch(() => {});
      return EXIT_CONFIG;
    }
    log.error({ err: error }, "Preflight gagal");
    await writer.close().catch(() => {});
    return EXIT_PREFLIGHT;
  }

  const tiles = makeTiles(preflightResult.bbox, config.TILE_SIZE_DEG);
  const seen = new Set<string>();
  let waysReceived = 0;
  let waysUnique = 0;
  let skipped = 0;
  let failedTiles = 0;
  const areaId = 3600000000 + Number(preflightResult.relationId);
  const limit = pLimit(config.CONCURRENCY);

  await Promise.all(
    tiles.map((tile) =>
      limit(async () => {
        try {
          const payload = await queryWithRetry(
            config.OVERPASS_URL,
            buildStreetsQuery(tile, areaId, config),
            config,
          );
          const ways = waysFrom(payload);
          waysReceived += ways.length;
          const rows = [];
          for (const way of ways) {
            const row = toRow(way, log);
            if (!row) {
              skipped += 1;
              continue;
            }
            if (seen.has(row.osmWayId)) continue;
            seen.add(row.osmWayId);
            waysUnique += 1;
            rows.push(row);
          }
          await writer.write(rows);
        } catch (error) {
          failedTiles += 1;
          log.error({ err: error, tile }, "Tile gagal");
        }
      }),
    ),
  );

  let finishFailed = false;
  try {
    await writer.finish({
      relationId: preflightResult.relationId,
      osmBase: preflightResult.osmBase,
      failedTiles,
      skipped,
      tilesTotal: tiles.length,
    });
  } catch (error) {
    finishFailed = true;
    failedTiles += 1;
    log.error({ err: error }, "Batch atau finishing gagal");
  }

  await writer.close();
  const durationMs = Date.now() - started;
  log.info({
    msg: "crawl finished",
    outputMode: config.OUTPUT_MODE,
    relationId: preflightResult.relationId,
    tiles: tiles.length,
    tilesFailed: failedTiles,
    waysReceived,
    waysUnique,
    skipped,
    durationMs,
    ...writer.stats(),
  });

  return failedTiles > 0 || finishFailed ? EXIT_PARTIAL : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(
      JSON.stringify({
        level: "fatal",
        msg: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  });
