import { describe, expect, it } from "vitest";
import { makeTiles } from "../src/tiles.js";

describe("makeTiles", () => {
  it("covers the bbox without overlap or gaps", () => {
    const tiles = makeTiles(
      { south: -8.2, west: 114.4, north: -8.0, east: 114.6 },
      0.1,
    );
    expect(tiles).toHaveLength(4);
    expect(tiles[0]).toEqual({
      south: -8.2,
      west: 114.4,
      north: -8.1,
      east: 114.5,
    });
    expect(tiles.at(-1)).toEqual({
      south: -8.1,
      west: 114.5,
      north: -8.0,
      east: 114.6,
    });
  });

  it("clips the final tile at the exact bbox edge", () => {
    const tiles = makeTiles(
      { south: -8.25, west: 114.41, north: -8.0, east: 114.62 },
      0.1,
    );
    expect(
      tiles.every((tile) => tile.east <= 114.62 && tile.north <= -8.0),
    ).toBe(true);
  });
});
