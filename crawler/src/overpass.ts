import type { Config } from "./config.js";
import type { BBox, OverpassResponse, OverpassWay } from "./types.js";

export function buildRelationQuery(relationId?: string): string {
  const selector = relationId
    ? `rel(${relationId})`
    : 'rel["boundary"="administrative"]["admin_level"="4"]["name"="Bali"]';
  return `[out:json][timeout:60];${selector};out ids bb;`;
}

export function buildAreaQuery(areaId: number): string {
  return `[out:json][timeout:60];area(id:${areaId});out ids;`;
}

export function buildControlQuery(): string {
  return `[out:json][timeout:60];
(
  way["highway"](-7.30,112.70,-7.24,112.78);
  way["highway"](-8.60,116.08,-8.56,116.14);
  way["highway"](-6.22,106.80,-6.16,106.86);
  way["highway"](1.27,103.82,1.31,103.88);
);
out ids;`;
}

export function buildStreetsQuery(
  tile: BBox,
  areaId: number,
  config: Config,
): string {
  const alternatives = config.highwayTypes.join("|");
  const areaStart = config.CRAWLER_USE_AREA
    ? `area(id:${areaId})->.bali;\n`
    : "";
  const areaFilter = config.CRAWLER_USE_AREA ? "(area.bali)" : "";
  return `[out:json][timeout:${config.OVERPASS_QUERY_TIMEOUT_S}];
${areaStart}way["highway"~"^(${alternatives})$"]["area"!="yes"](${tile.south},${tile.west},${tile.north},${tile.east})${areaFilter};
out body geom qt;`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class OverpassHttp400Error extends Error {}
export class OverpassRuntimeResponseError extends Error {}

export async function postOverpass(
  url: string,
  query: string,
  timeoutMs: number,
): Promise<OverpassResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data: query }),
      signal: controller.signal,
    });
    if (response.status === 400)
      throw new OverpassHttp400Error(`Overpass HTTP 400: query bermasalah`);
    if (response.status === 429 || response.status >= 500) {
      throw new Error(`Overpass HTTP ${response.status}`);
    }
    if (!response.ok) throw new Error(`Overpass HTTP ${response.status}`);
    const text = await response.text();
    let payload: OverpassResponse;
    try {
      payload = JSON.parse(text) as OverpassResponse;
    } catch {
      if (/runtime error|timed out/i.test(text)) {
        throw new OverpassRuntimeResponseError(text.slice(0, 500));
      }
      throw new Error("Overpass mengembalikan respons non-JSON");
    }
    if (payload.remark && /runtime error|timed out/i.test(payload.remark)) {
      throw new Error(`Overpass runtime error: ${payload.remark}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

export async function queryWithRetry(
  url: string,
  query: string,
  config: Config,
): Promise<OverpassResponse> {
  let attempt = 0;
  for (;;) {
    try {
      return await postOverpass(url, query, config.HTTP_TIMEOUT_S * 1000);
    } catch (error) {
      if (error instanceof OverpassHttp400Error) throw error;
      if (attempt >= config.MAX_RETRIES) throw error;
      const jitter = Math.floor(Math.random() * 500);
      const delay =
        Math.min(config.BASE_DELAY_MS * 2 ** attempt, 60000) + jitter;
      await sleep(delay);
      attempt += 1;
    }
  }
}

export function waysFrom(payload: OverpassResponse): OverpassWay[] {
  return (payload.elements ?? []).filter((element): element is OverpassWay => {
    const candidate = element as Partial<OverpassWay>;
    return candidate.type === "way" && typeof candidate.id === "number";
  });
}
