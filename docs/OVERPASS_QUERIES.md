# Overpass Queries (for Overpass Turbo & the Crawler)

All queries below target the **local server** (`http://localhost:12345/api/`). Set it in Overpass Turbo under **Settings → General → Server**. See [SETUP.md §8](SETUP.md#8-overpass-turbo-with-the-local-server).

`{{bbox}}` is an Overpass Turbo placeholder (the visible map area). The crawler replaces the bbox part with tile coordinates.

---

## 1. Bali Province Relation

```
[out:json][timeout:60];
rel["boundary"="administrative"]["admin_level"="4"]["name"="Bali"];
out bb tags;
```

Shows the relation ID and bounding box. Area ID = `3600000000 + relation id`.

## 2. All Vehicle Roads in Bali (same as the crawler, without tiling)

> Heavy to render in a browser. Use `out count;` to just count.

```
[out:json][timeout:300];
rel["boundary"="administrative"]["admin_level"="4"]["name"="Bali"];
map_to_area->.bali;
way["highway"~"^(motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|unclassified|residential|living_street|service|road)$"]["area"!="yes"](area.bali);
out count;
```

## 3. Roads in the Visible Map Area

```
[out:json][timeout:120];
rel["boundary"="administrative"]["admin_level"="4"]["name"="Bali"];
map_to_area->.bali;
way["highway"~"^(motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|unclassified|residential|living_street|service|road)$"]["area"!="yes"]({{bbox}})(area.bali);
out body geom qt;
```

## 4. Crawler Tile Query (exact form)

```
[out:json][timeout:180];
area(id:{AREA_ID})->.bali;
way["highway"~"^(motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|unclassified|residential|living_street|service|road)$"]["area"!="yes"]({SOUTH},{WEST},{NORTH},{EAST})(area.bali);
out body geom qt;
```

Example Denpasar tile: `(-8.7,115.2,-8.6,115.3)`.

## 5. Unnamed Roads

```
[out:json][timeout:120];
rel["boundary"="administrative"]["admin_level"="4"]["name"="Bali"];
map_to_area->.bali;
way["highway"~"^(residential|service|unclassified)$"][!"name"]({{bbox}})(area.bali);
out body geom qt;
```

## 6. Find Roads by Name

```
[out:json][timeout:60];
rel["boundary"="administrative"]["admin_level"="4"]["name"="Bali"];
map_to_area->.bali;
way["highway"]["name"~"Bypass Ngurah Rai",i](area.bali);
out body geom;
```

## 7. Check Excluded Road Types (filter verification)

These objects **do exist** in local Overpass (because the extract keeps all `highway=*`) but must **not** be in the `streets` table:

```
[out:json][timeout:120];
way["highway"~"^(footway|path|track|cycleway|steps|pedestrian|bridleway|construction|proposed)$"]({{bbox}});
out ids tags;
```

Take a few `id` values from the result and make sure they are not in the DB:

```sql
SELECT * FROM public.streets WHERE osm_way_id IN (<id1>, <id2>, <id3>);
```

## 8. Check for Data Outside Bali (must be empty)

```
[out:json][timeout:60];
way["highway"](-8.75,116.0,-8.45,116.2);   // Lombok (Mataram)
out ids;
```

```
[out:json][timeout:60];
way["highway"](-8.25,114.3,-8.10,114.39);  // Banyuwangi, East Java
out ids;
```

Note: a few ways that cross the province boundary (usually around ports) may show up in a bbox very close to the boundary line — see [ARCHITECTURE.md §3.4](ARCHITECTURE.md#34-behavior-at-region-boundaries).

These control points are also checked automatically by the crawler before it writes output ([ARCHITECTURE.md §6.4](ARCHITECTURE.md#64-preflight)).
