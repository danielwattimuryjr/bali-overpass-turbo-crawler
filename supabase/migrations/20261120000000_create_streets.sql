-- PostGIS (in Supabase, extensions live in the "extensions" schema)
CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.streets (
    uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    osm_way_id BIGINT NOT NULL UNIQUE,
    name VARCHAR(150),
    coordinates GEOMETRY(LINESTRING, 4326) NOT NULL,
    dt_created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    dt_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.streets IS 'Jalan kendaraan Provinsi Bali dari OpenStreetMap (via Overpass lokal).';
COMMENT ON COLUMN public.streets.osm_way_id  IS 'OSM way id';
COMMENT ON COLUMN public.streets.coordinates IS 'Geometri way, LINESTRING WGS84 (lon lat)';

-- Spatial index
CREATE INDEX IF NOT EXISTS streets_coordinates_gix
    ON public.streets USING GIST (coordinates);

-- Name search index (optional, for ILIKE/prefix)
CREATE INDEX IF NOT EXISTS streets_name_idx
    ON public.streets (name);

-- dt_updated trigger for manual updates outside the crawler
CREATE OR REPLACE FUNCTION public.set_dt_updated()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF NEW.name IS DISTINCT FROM OLD.name
       OR extensions.ST_AsEWKB(NEW.coordinates) IS DISTINCT FROM extensions.ST_AsEWKB(OLD.coordinates)
    THEN
        NEW.dt_updated := NOW();
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS streets_set_dt_updated ON public.streets;
CREATE TRIGGER streets_set_dt_updated
    BEFORE UPDATE ON public.streets
    FOR EACH ROW EXECUTE FUNCTION public.set_dt_updated();

-- Row Level Security: public read, writes only by the postgres role (crawler)
ALTER TABLE public.streets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "streets are readable" ON public.streets;
CREATE POLICY "streets are readable"
    ON public.streets FOR SELECT
    TO anon, authenticated
    USING (true);
