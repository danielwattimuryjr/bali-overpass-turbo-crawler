#!/usr/bin/env bash
set -euo pipefail

OUT=/data/bali.osm.bz2
SRC=/data/source.osm.pbf

MAX_SOURCE_SIZE_MB=${MAX_SOURCE_SIZE_MB:-2500}
MAX_EXTRACT_SIZE_MB=${MAX_EXTRACT_SIZE_MB:-300}
BALI_FENCE_MINLON=114.0
BALI_FENCE_MINLAT=-9.2
BALI_FENCE_MAXLON=116.0
BALI_FENCE_MAXLAT=-7.8

fail() { echo "[extract] ERROR: $*" >&2; exit 1; }

if [[ -f "$OUT" && "${FORCE_REEXTRACT:-false}" != "true" ]]; then
  echo "[extract] $OUT sudah ada, dilewati (set FORCE_REEXTRACT=true untuk ulang)."
  exit 0
fi

# 0. ANTI-WORLD-DATA SAFEGUARDS (before any download)
# 0a. Reject planet / large-region URLs
case "${SOURCE_PBF_URL,,}" in
  *planet*|*.osm.bz2|*/asia-latest*|*/asia.osm*)
    fail "SOURCE_PBF_URL terlihat seperti planet/region besar: $SOURCE_PBF_URL" ;;
esac

# 0b. Allowlist: only the Indonesia extract (or its sub-regions) from Geofabrik
if [[ "${ALLOW_ANY_SOURCE:-false}" != "true" ]]; then
  [[ "$SOURCE_PBF_URL" =~ ^https://download\.geofabrik\.de/asia/indonesia(-latest\.osm\.pbf|/[a-z-]+-latest\.osm\.pbf)$ ]] \
    || fail "SOURCE_PBF_URL di luar allowlist (Geofabrik asia/indonesia*). Set ALLOW_ANY_SOURCE=true bila sengaja."
fi

# 0c. Check the size via HEAD before downloading
# "|| true" keeps set -e/pipefail from exiting silently on an HTTP error (e.g. 404),
# so the clear message below is printed instead.
SIZE_BYTES=$( { curl -sfIL "$SOURCE_PBF_URL" || true; } | tr -d '\r' \
  | awk 'tolower($1)=="content-length:"{v=$2} END{print v}')
[[ -n "$SIZE_BYTES" ]] || fail "tidak bisa membaca ukuran file sumber (Content-Length)."
SIZE_MB=$(( SIZE_BYTES / 1024 / 1024 ))
echo "[extract] Ukuran sumber: ${SIZE_MB} MB (batas ${MAX_SOURCE_SIZE_MB} MB)"
(( SIZE_MB <= MAX_SOURCE_SIZE_MB )) || fail "file sumber ${SIZE_MB} MB melebihi MAX_SOURCE_SIZE_MB=${MAX_SOURCE_SIZE_MB}."

# 1. Download the source (resumes if interrupted; --max-filesize as a second fence)
echo "[extract] Download $SOURCE_PBF_URL"
curl -fL --retry 5 -C - --max-filesize $(( MAX_SOURCE_SIZE_MB * 1024 * 1024 )) \
  -o "$SRC" "$SOURCE_PBF_URL"

# 2. Extract all administrative boundary relations (with their member ways/nodes)
osmium tags-filter "$SRC" r/boundary=administrative -o /data/boundaries.osm.pbf --overwrite

# 3. Determine the Bali Province relation ID
if [[ -z "${BALI_RELATION_ID:-}" ]]; then
  BALI_RELATION_ID=$(osmium cat /data/boundaries.osm.pbf -t relation -f opl \
    | grep -E '(^|[ ,T])admin_level=4(,| |$)' \
    | grep -E '(^|[ ,T])name=Bali(,| |$)' \
    | awk '{print substr($1,2)}' | head -n1)
fi
[[ -n "$BALI_RELATION_ID" ]] || { echo "[extract] ERROR: relasi Provinsi Bali tidak ditemukan" >&2; exit 1; }
echo "[extract] Relasi Bali: r$BALI_RELATION_ID"
echo "$BALI_RELATION_ID" > /data/bali-relation-id.txt

# 4. Extract the Bali polygon
osmium getid -r /data/boundaries.osm.pbf "r$BALI_RELATION_ID" -o /data/bali-boundary.osm --overwrite
osmium cat /data/bali-boundary.osm -f xml -o /data/bali-boundary.osm.xml --overwrite

python3 - <<'PY'
import xml.etree.ElementTree as ET

root = ET.parse('/data/bali-boundary.osm.xml').getroot()
relation_id = next(
    rel.attrib['id'] for rel in root.findall('relation')
    if any(t.attrib.get('k') == 'name' and t.attrib.get('v') == 'Bali' for t in rel.findall('tag'))
)
relation = next(rel for rel in root.findall('relation') if rel.attrib['id'] == relation_id)

nodes = {
    node.attrib['id']: (float(node.attrib['lon']), float(node.attrib['lat']))
    for node in root.findall('node')
}
ways = {}
for way in root.findall('way'):
    refs = [nd.attrib['ref'] for nd in way.findall('nd')]
    ways[way.attrib['id']] = refs

unused = []
for member in relation.findall('member'):
    if member.attrib.get('type') == 'way' and member.attrib.get('role') in ('outer', ''):
        if member.attrib.get('ref') in ways:
            unused.append(ways[member.attrib['ref']])

rings = []
while unused:
    ring = unused.pop(0)
    changed = True
    while changed:
        changed = False
        if ring[0] == ring[-1]:
            break
        for i, way in enumerate(unused):
            if ring[-1] == way[0]:
                ring.extend(way[1:]); unused.pop(i); changed = True; break
            if ring[-1] == way[-1]:
                ring.extend(reversed(way[:-1])); unused.pop(i); changed = True; break
            if ring[0] == way[-1]:
                ring = way[:-1] + ring; unused.pop(i); changed = True; break
            if ring[0] == way[0]:
                ring = list(reversed(way[1:])) + ring; unused.pop(i); changed = True; break
    if ring[0] != ring[-1]:
        raise RuntimeError('Bali boundary relation contains an open outer ring')
    rings.append(ring)

if not rings:
    raise RuntimeError('Bali boundary polygon has no outer ring')

clipped_rings = []
for ring in rings:
    coords = []
    for node_id in ring:
        if node_id not in nodes:
            raise RuntimeError(f'Missing polygon node {node_id}')
        lon, lat = nodes[node_id]
        lon = max(114.0, min(116.0, lon))
        lat = max(-9.2, min(-7.8, lat))
        coords.append((lon, lat))
    clipped_rings.append(coords)

with open('/data/bali.poly', 'w', encoding='utf-8') as f:
    f.write('Bali\n')
    for index, coords in enumerate(clipped_rings, 1):
        f.write(f'Polygon {index}\n')
        for lon, lat in coords:
            f.write(f'  {lon:.7f}  {lat:.7f}\n')
        f.write('END\n')
    f.write('END\n')

osm = ET.Element('osm', {'version': '0.6', 'generator': 'bali-extract'})
synthetic_node_id = 900000000000
synthetic_way_id = 900000000000
relation_members = []
for coords in clipped_rings:
    refs = []
    for lon, lat in coords:
        synthetic_node_id += 1
        node = ET.SubElement(osm, 'node', {
            'id': str(synthetic_node_id), 'lat': f'{lat:.7f}', 'lon': f'{lon:.7f}',
            'version': '1'
        })
        refs.append(str(synthetic_node_id))
    synthetic_way_id += 1
    way = ET.SubElement(osm, 'way', {'id': str(synthetic_way_id), 'version': '1'})
    for ref in refs:
        ET.SubElement(way, 'nd', {'ref': ref})
    relation_members.append(synthetic_way_id)

relation_el = ET.SubElement(osm, 'relation', {'id': relation_id, 'version': '1'})
for way_id in relation_members:
    ET.SubElement(relation_el, 'member', {'type': 'way', 'ref': str(way_id), 'role': 'outer'})
for key, value in (
    ('boundary', 'administrative'), ('admin_level', '4'), ('name', 'Bali'), ('type', 'boundary')
):
    ET.SubElement(relation_el, 'tag', {'k': key, 'v': value})

ET.ElementTree(osm).write('/data/bali-synthetic.osm.xml', encoding='utf-8', xml_declaration=True)
PY
osmium cat /data/bali-synthetic.osm.xml -o /data/bali-synthetic.osm.pbf --overwrite

# 5. Clip the source to the Bali bbox fence, then to the Bali polygon.
#    The polygon step uses complete_ways so roads crossing the boundary keep all their
#    nodes (one osm_way_id = one whole OSM way). The bbox fence can stay "simple": ways it
#    cuts lie in Java/Lombok and are dropped by the polygon step anyway.
osmium extract -b 114.0,-9.2,116.0,-7.8 -s simple \
  "$SRC" -o /data/bali-fenced.osm.pbf --overwrite
osmium extract -p /data/bali.poly -s complete_ways \
  /data/bali-fenced.osm.pbf -o /data/bali-full.osm.pbf --overwrite

# 6. Keep only roads + the Bali boundary relation (for the Overpass area)
osmium tags-filter /data/bali-full.osm.pbf w/highway \
  -o /data/bali-highways-only.osm.pbf --overwrite
osmium merge /data/bali-highways-only.osm.pbf /data/bali-synthetic.osm.pbf \
  -o /data/bali-with-boundary.osm.pbf --overwrite
osmium tags-filter /data/bali-with-boundary.osm.pbf w/highway "r/boundary=administrative" \
  -o /data/bali-filtered.osm.pbf --overwrite

# 7. Validate the result: not empty, bbox inside the Bali fence, reasonable size
WAYS=$(osmium fileinfo -e -g data.count.ways /data/bali-filtered.osm.pbf)
[[ "$WAYS" -gt 0 ]] || fail "hasil extract kosong"
echo "[extract] Jumlah way: $WAYS"

BBOX=$(osmium fileinfo -e -g data.bbox /data/bali-filtered.osm.pbf | tr -d '()')
echo "[extract] BBox data: $BBOX"
awk -F, -v a="$BALI_FENCE_MINLON" -v b="$BALI_FENCE_MINLAT" -v c="$BALI_FENCE_MAXLON" -v d="$BALI_FENCE_MAXLAT" \
  '{ exit !( $1>=a && $2>=b && $3<=c && $4<=d ) }' <<< "$BBOX" \
  || fail "bbox data ($BBOX) keluar dari pagar Bali — kemungkinan polygon/relasi salah."

OUT_MB=$(( $(stat -c %s /data/bali-filtered.osm.pbf) / 1024 / 1024 ))
(( OUT_MB <= MAX_EXTRACT_SIZE_MB )) || fail "hasil extract ${OUT_MB} MB melebihi MAX_EXTRACT_SIZE_MB=${MAX_EXTRACT_SIZE_MB} — bukan data Bali saja?"

# 8. Convert to .osm.bz2 (the format accepted by overpass init)
osmium cat /data/bali-filtered.osm.pbf -o "$OUT.tmp.osm.bz2" --overwrite
mv "$OUT.tmp.osm.bz2" "$OUT"

# 9. Clean up intermediate files (the source is kept if KEEP_SOURCE=true)
rm -f /data/boundaries.osm.pbf /data/bali-boundary.osm /data/bali-boundary.osm.xml \
  /data/bali-synthetic.osm.xml /data/bali-synthetic.osm.pbf /data/bali-with-boundary.osm.pbf \
  /data/bali.poly /data/bali-fenced.osm.pbf /data/bali-full.osm.pbf /data/bali-highways-only.osm.pbf /data/bali-filtered.osm.pbf
[[ "${KEEP_SOURCE:-false}" == "true" ]] || rm -f "$SRC"
echo "[extract] Selesai → $OUT"
