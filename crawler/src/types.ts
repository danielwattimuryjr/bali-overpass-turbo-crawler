export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface OverpassWay {
  type: "way";
  id: number;
  tags?: Record<string, string>;
  geometry?: ({ lat: number; lon: number } | null)[];
}

export interface OverpassResponse {
  elements?: unknown[];
  remark?: string;
  osm3s?: { timestamp_osm_base?: string };
}

export interface StreetRow {
  osmWayId: string;
  name: string | null;
  points: [number, number][];
}

export interface PreflightResult {
  relationId: string;
  bbox: BBox;
  osmBase?: string;
}

export interface RunContext {
  relationId: string;
  osmBase?: string;
  failedTiles: number;
  skipped: number;
  tilesTotal: number;
}

export interface StreetWriter {
  preflight(): Promise<void>;
  write(rows: StreetRow[]): Promise<void>;
  finish(ctx: RunContext): Promise<void>;
  stats(): Record<string, number | string>;
  close(): Promise<void>;
}
