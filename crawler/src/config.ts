import { z } from "zod";

export const HIGHWAY_TYPES_DEFAULT = [
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "motorway_link",
  "trunk_link",
  "primary_link",
  "secondary_link",
  "tertiary_link",
  "unclassified",
  "residential",
  "living_street",
  "service",
  "road",
] as const;

const bool = z.preprocess(
  (v) => (typeof v === "string" ? v.toLowerCase() === "true" : v),
  z.boolean(),
);

const envSchema = z.object({
  OVERPASS_URL: z.string().url().default("http://overpass/api/interpreter"),
  OUTPUT_MODE: z.enum(["db", "json"]).default("db"),
  OUTPUT_DIR: z.string().default("/output"),
  OUTPUT_FILENAME: z.string().default(""),
  OUTPUT_OVERWRITE: bool.default(false),
  OUTPUT_PRETTY: bool.default(false),
  DATABASE_URL: z.string().optional(),
  DATABASE_SSL: z
    .enum(["disable", "require", "verify-full"])
    .default("disable"),
  DATABASE_SSL_CA: z.string().optional(),
  DB_POOL_MAX: z.coerce.number().int().min(1).default(4),
  BALI_RELATION_ID: z.string().default(""),
  TILE_SIZE_DEG: z.coerce.number().min(0.01).max(1).default(0.1),
  CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  BATCH_SIZE: z.coerce.number().int().min(50).max(2000).default(500),
  HIGHWAY_TYPES: z.string().optional(),
  CRAWLER_USE_AREA: bool.default(true),
  AREA_WAIT_TIMEOUT_S: z.coerce.number().int().positive().default(1800),
  PREFLIGHT_TIMEOUT_S: z.coerce.number().int().positive().default(600),
  OVERPASS_QUERY_TIMEOUT_S: z.coerce.number().int().positive().default(180),
  HTTP_TIMEOUT_S: z.coerce.number().int().positive().default(240),
  MAX_RETRIES: z.coerce.number().int().min(0).default(5),
  BASE_DELAY_MS: z.coerce.number().int().positive().default(1000),
  CRAWLER_PRUNE: bool.default(false),
  CRAWLER_DRY_RUN: bool.default(false),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
});

export type Config = z.infer<typeof envSchema> & { highwayTypes: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `Konfigurasi tidak valid: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  const cfg = parsed.data;
  const highwayTypes = cfg.HIGHWAY_TYPES
    ? cfg.HIGHWAY_TYPES.split(",")
        .map((v) => v.trim())
        .filter(Boolean)
    : [...HIGHWAY_TYPES_DEFAULT];
  if (!highwayTypes.length || highwayTypes.some((v) => !/^[a-z_]+$/.test(v))) {
    throw new Error(
      "Konfigurasi HIGHWAY_TYPES hanya boleh berisi huruf kecil dan underscore",
    );
  }
  if (cfg.OUTPUT_MODE === "db" && !cfg.DATABASE_URL) {
    throw new Error("DATABASE_URL wajib diisi untuk OUTPUT_MODE=db");
  }
  if (cfg.DATABASE_SSL === "verify-full" && !cfg.DATABASE_SSL_CA) {
    throw new Error(
      "DATABASE_SSL_CA wajib diisi untuk DATABASE_SSL=verify-full",
    );
  }
  if (cfg.HTTP_TIMEOUT_S <= cfg.OVERPASS_QUERY_TIMEOUT_S) {
    throw new Error(
      "HTTP_TIMEOUT_S harus lebih besar dari OVERPASS_QUERY_TIMEOUT_S",
    );
  }
  return { ...cfg, highwayTypes };
}
