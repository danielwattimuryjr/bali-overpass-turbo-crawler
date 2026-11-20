import { afterEach, describe, expect, it, vi } from "vitest";
import { buildStreetsQuery, queryWithRetry } from "../src/overpass.js";
import { loadConfig } from "../src/config.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildStreetsQuery", () => {
  it("uses Bali area and excludes area=yes", () => {
    const config = loadConfig({
      OUTPUT_MODE: "db",
      DATABASE_URL: "postgresql://x",
      CRAWLER_USE_AREA: "true",
      OVERPASS_URL: "http://localhost/api/interpreter",
      HTTP_TIMEOUT_S: "240",
      OVERPASS_QUERY_TIMEOUT_S: "180",
    });
    const query = buildStreetsQuery(
      { south: -8.2, west: 114.4, north: -8.1, east: 114.5 },
      3600000000 + 1615621,
      config,
    );
    expect(query).toContain("area(id:3601615621)->.bali");
    expect(query).toContain('["area"!="yes"]');
    expect(query).toContain("out body geom qt");
  });

  it("rejects invalid highway overrides", () => {
    expect(() =>
      loadConfig({
        OUTPUT_MODE: "db",
        DATABASE_URL: "postgresql://x",
        HIGHWAY_TYPES: "primary,footway!",
      }),
    ).toThrow();
  });
});

describe("queryWithRetry", () => {
  it("does not retry HTTP 400", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 400 }));
    const config = loadConfig({
      OUTPUT_MODE: "db",
      DATABASE_URL: "postgresql://x",
      MAX_RETRIES: "5",
      BASE_DELAY_MS: "1",
    });

    await expect(
      queryWithRetry("http://overpass/api/interpreter", "bad", config),
    ).rejects.toThrow("HTTP 400");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries HTTP 429 and then succeeds", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(
        new Response('{"elements":[]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const config = loadConfig({
      OUTPUT_MODE: "db",
      DATABASE_URL: "postgresql://x",
      MAX_RETRIES: "2",
      BASE_DELAY_MS: "1",
    });

    await expect(
      queryWithRetry("http://overpass/api/interpreter", "valid", config),
    ).resolves.toEqual({ elements: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries XML runtime response and then succeeds", async () => {
    const xml = '<?xml version="1.0"?><p>runtime error: example timed out</p>';
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(xml, {
          status: 200,
          headers: { "content-type": "application/xml" },
        }),
      )
      .mockResolvedValueOnce(
        new Response('{"elements":[]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const config = loadConfig({
      OUTPUT_MODE: "db",
      DATABASE_URL: "postgresql://x",
      MAX_RETRIES: "2",
      BASE_DELAY_MS: "1",
    });

    await expect(
      queryWithRetry("http://overpass/api/interpreter", "valid", config),
    ).resolves.toEqual({ elements: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
