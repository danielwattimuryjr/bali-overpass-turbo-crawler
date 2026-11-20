import { describe, expect, it } from "vitest";
import { toRow, toWkt } from "../src/transform.js";

describe("toRow", () => {
  it("uses lon/lat order and rounds to 7 decimals", () => {
    const row = toRow({
      type: "way",
      id: 42,
      tags: { name: " Jalan Bali " },
      geometry: [
        { lat: -8.123456789, lon: 115.123456789 },
        { lat: -8.223456789, lon: 115.223456789 },
      ],
    });
    expect(row?.points).toEqual([
      [115.1234568, -8.1234568],
      [115.2234568, -8.2234568],
    ]);
    expect(row?.name).toBe("Jalan Bali");
    expect(toWkt(row!)).toBe(
      "LINESTRING(115.1234568 -8.1234568,115.2234568 -8.2234568)",
    );
  });

  it("drops ways with fewer than two unique points", () => {
    expect(
      toRow({
        type: "way",
        id: 1,
        geometry: [{ lat: -8, lon: 115 }, { lat: -8, lon: 115 }, null],
      }),
    ).toBeNull();
  });

  it("normalizes empty names to null", () => {
    expect(
      toRow({
        type: "way",
        id: 2,
        tags: { name: "   " },
        geometry: [
          { lat: -8, lon: 115 },
          { lat: -8.1, lon: 115.1 },
        ],
      })?.name,
    ).toBeNull();
  });

  it("truncates names by Unicode code points", () => {
    const name = "é".repeat(151);
    const warnings: unknown[] = [];
    const row = toRow(
      {
        type: "way",
        id: 3,
        tags: { name },
        geometry: [
          { lat: -8, lon: 115 },
          { lat: -8.1, lon: 115.1 },
        ],
      },
      { warn: (value) => warnings.push(value) },
    );
    expect(row?.name).toHaveLength(150);
    expect(warnings).toHaveLength(1);
  });
});
