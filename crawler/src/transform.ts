import type { OverpassWay, StreetRow } from "./types.js";
import { round7 } from "./tiles.js";

export function toRow(
  element: OverpassWay,
  logger?: { warn: (obj: object, msg: string) => void },
): StreetRow | null {
  const points = (element.geometry ?? [])
    .filter((point): point is { lat: number; lon: number } => point !== null)
    .map((point) => [round7(point.lon), round7(point.lat)] as [number, number]);
  const unique = new Set(points.map((point) => `${point[0]} ${point[1]}`));
  if (unique.size < 2) return null;

  let name = element.tags?.name?.trim() || null;
  if (name) {
    const characters = [...name];
    if (characters.length > 150) {
      name = characters.slice(0, 150).join("");
      logger?.warn(
        { osmWayId: String(element.id) },
        "Nama jalan dipotong menjadi 150 karakter",
      );
    }
  }
  return { osmWayId: String(element.id), name, points };
}

export function toWkt(row: StreetRow): string {
  return `LINESTRING(${row.points.map(([lon, lat]) => `${lon} ${lat}`).join(",")})`;
}
