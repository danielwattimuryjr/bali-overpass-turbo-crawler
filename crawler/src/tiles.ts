import type { BBox } from "./types.js";

export function round7(value: number): number {
  return Math.round(value * 10_000_000) / 10_000_000;
}

export function makeTiles(bbox: BBox, size: number): BBox[] {
  if (!(size >= 0.01 && size <= 1))
    throw new Error("Ukuran tile harus 0.01–1 derajat");
  const tiles: BBox[] = [];
  for (let south = bbox.south; south < bbox.north; south += size) {
    for (let west = bbox.west; west < bbox.east; west += size) {
      tiles.push({
        south: round7(south),
        west: round7(west),
        north: round7(Math.min(south + size, bbox.north)),
        east: round7(Math.min(west + size, bbox.east)),
      });
    }
  }
  return tiles;
}
