import type { Config } from "./config.js";
import type { BBox, PreflightResult } from "./types.js";
import {
  buildAreaQuery,
  buildControlQuery,
  buildRelationQuery,
  postOverpass,
  waysFrom,
} from "./overpass.js";

function statusUrl(overpassUrl: string): string {
  return overpassUrl.replace(/\/api\/interpreter\/?$/, "/api/status");
}

async function waitForStatus(config: Config): Promise<void> {
  const url = statusUrl(config.OVERPASS_URL);
  const deadline = Date.now() + config.PREFLIGHT_TIMEOUT_S * 1000;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    if (Date.now() >= deadline)
      throw new Error("Overpass tidak siap sebelum PREFLIGHT_TIMEOUT_S");
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

function toBBox(bounds: {
  minlat: number;
  minlon: number;
  maxlat: number;
  maxlon: number;
}): BBox {
  return {
    south: bounds.minlat,
    west: bounds.minlon,
    north: bounds.maxlat,
    east: bounds.maxlon,
  };
}

export async function preflight(config: Config): Promise<PreflightResult> {
  await waitForStatus(config);

  const relationPayload = await postOverpass(
    config.OVERPASS_URL,
    buildRelationQuery(config.BALI_RELATION_ID || undefined),
    config.HTTP_TIMEOUT_S * 1000,
  );
  const relations = (relationPayload.elements ?? []).filter(
    (element: any) => element.type === "relation",
  );
  if (relations.length !== 1)
    throw new Error(`Relasi Bali harus tepat 1; ditemukan ${relations.length}`);
  const relation = relations[0] as any;
  if (!relation.bounds) throw new Error("Relasi Bali tidak memiliki bounds");

  const bbox = toBBox(relation.bounds);
  if (
    bbox.west < 114.0 ||
    bbox.south < -9.2 ||
    bbox.east > 116.0 ||
    bbox.north > -7.8
  ) {
    throw new Error(
      `BBox relasi Bali keluar dari pagar Bali: ${JSON.stringify(bbox)}`,
    );
  }

  if (config.CRAWLER_USE_AREA) {
    const areaId = 3600000000 + Number(relation.id);
    const deadline = Date.now() + config.AREA_WAIT_TIMEOUT_S * 1000;
    for (;;) {
      try {
        await postOverpass(
          config.OVERPASS_URL,
          buildAreaQuery(areaId),
          config.HTTP_TIMEOUT_S * 1000,
        );
        break;
      } catch (error) {
        if (Date.now() >= deadline) {
          throw new Error(
            `Area Bali belum tersedia: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 30000));
      }
    }
  }

  const controlPayload = await postOverpass(
    config.OVERPASS_URL,
    buildControlQuery(),
    config.HTTP_TIMEOUT_S * 1000,
  );
  const outsideWays = waysFrom(controlPayload);
  if (outsideWays.length > 0) {
    throw new Error(
      `Data di luar Bali terdeteksi pada titik kontrol: ${outsideWays.length} way`,
    );
  }

  return {
    relationId: String(relation.id),
    bbox,
    osmBase: relationPayload.osm3s?.timestamp_osm_base,
  };
}
