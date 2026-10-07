/**
 * Pré-processamento: baixa dados do OpenStreetMap (Overpass API) e elevação
 * (tiles Terrarium/SRTM) e gera `public/data/itabirito.json`.
 *
 * O jogo NUNCA consulta a Overpass em tempo de execução — só este script.
 *
 * Uso:
 *   npm run fetch-osm
 *   npm run fetch-osm -- --lat -20.253 --lon -43.801 --size 1500 --margin 450
 *   npm run fetch-osm -- --refresh          (ignora cache local)
 *
 * Dados: © OpenStreetMap contributors (ODbL). Elevação: Mapzen Terrarium
 * (SRTM/NASA e outros) via AWS Open Data.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import type {
  Address,
  Building,
  CityData,
  GreenArea,
  GreenKind,
  Heightmap,
  LandUse,
  LandUseKind,
  Lot,
  Poi,
  Railway,
  Ring,
  RoadKind,
  Street,
  Vec2,
  WaterArea,
  WaterKind,
  WaterLine,
} from '../src/data/types';
import {
  centroid,
  distSqToSegment,
  hashId,
  LocalProjection,
  mulberry32,
  pointInPolygon,
  polygonArea,
  signedArea,
  simplify,
} from '../src/world/geo';
import { generateInfill } from './infill';
import { ZONING_BY_CATEGORY, classifyBuilding } from '../src/world/classify';

// ---------------------------------------------------------------- config ---

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, '.cache');

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const CONFIG = {
  name: arg('name', 'Itabirito'),
  lat: Number(arg('lat', '-20.253')),
  // levemente a oeste de -43.801 para incluir a Matriz da Boa Viagem e a estação
  lon: Number(arg('lon', '-43.803')),
  /** lado da área com dados OSM, em metros */
  size: Number(arg('size', '1500')),
  /** borda extra de terreno (névoa esconde o limite) */
  margin: Number(arg('margin', '450')),
  /** resolução da grade de elevação (m) */
  cellSize: Number(arg('cell', '10')),
  terrariumZoom: Number(arg('zoom', '14')),
  out: arg('out', join(ROOT, 'public', 'data', 'itabirito.json')),
  refresh: process.argv.includes('--refresh'),
  noTerrain: process.argv.includes('--no-terrain'),
  /** desliga o preenchimento procedural de quadras */
  noInfill: process.argv.includes('--no-infill'),
};

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const TERRARIUM_URL = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

// ----------------------------------------------------------------- tipos ---

interface LatLon {
  lat: number;
  lon: number;
}
interface OsmNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}
interface OsmWay {
  type: 'way';
  id: number;
  nodes: number[];
  geometry: LatLon[];
  tags?: Record<string, string>;
}
interface OsmMember {
  type: 'way' | 'node' | 'relation';
  ref: number;
  role: string;
  geometry?: LatLon[];
}
interface OsmRelation {
  type: 'relation';
  id: number;
  members: OsmMember[];
  tags?: Record<string, string>;
}
type OsmElement = OsmNode | OsmWay | OsmRelation;

// ------------------------------------------------------------- download ---

async function fetchWithRetry(url: string, init?: RequestInit, tries = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status} ${res.statusText}`);
      if (res.status === 429 || res.status >= 500) await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
      else break;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw lastErr;
}

function buildQuery(s: number, w: number, n: number, e: number): string {
  const bb = `${s},${w},${n},${e}`;
  return `
[out:json][timeout:180];
(
  way["highway"](${bb});
  way["building"](${bb});
  relation["building"](${bb});
  way["waterway"~"river|stream|canal|drain|ditch"](${bb});
  way["natural"="water"](${bb});
  relation["natural"="water"](${bb});
  way["water"](${bb});
  way["leisure"~"park|garden|pitch"](${bb});
  relation["leisure"="park"](${bb});
  way["landuse"~"grass|meadow|forest|cemetery|recreation_ground|village_green"](${bb});
  relation["landuse"~"grass|meadow|forest"](${bb});
  way["natural"~"wood|scrub|grassland"](${bb});
  relation["natural"~"wood|scrub"](${bb});
  way["railway"="rail"](${bb});
  way["landuse"~"^(residential|commercial|retail|industrial)$"](${bb});
  relation["landuse"~"^(residential|commercial|retail|industrial)$"](${bb});
  node["name"]["amenity"](${bb});
  node["name"]["shop"](${bb});
  node["name"]["office"](${bb});
  node["name"]["tourism"](${bb});
  node["name"]["historic"](${bb});
  node["name"]["craft"](${bb});
);
out body geom;`;
}

async function fetchOverpass(query: string, cacheFile: string): Promise<OsmElement[]> {
  if (!CONFIG.refresh && existsSync(cacheFile)) {
    console.log(`• Overpass: usando cache ${cacheFile}`);
    return JSON.parse(readFileSync(cacheFile, 'utf8')).elements;
  }
  let lastErr: unknown;
  for (const ep of OVERPASS_ENDPOINTS) {
    try {
      console.log(`• Overpass: consultando ${ep} ...`);
      const res = await fetchWithRetry(
        ep,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'mini-town-itabirito/0.1 (preprocess script)',
          },
          body: 'data=' + encodeURIComponent(query),
        },
        2,
      );
      const text = await res.text();
      const json = JSON.parse(text);
      writeFileSync(cacheFile, text);
      return json.elements;
    } catch (e) {
      console.warn(`  falhou: ${(e as Error).message}`);
      lastErr = e;
    }
  }
  throw lastErr;
}

// --------------------------------------------------------------- terreno ---

function lonToTileX(lon: number, z: number) {
  return ((lon + 180) / 360) * 2 ** z;
}
function latToTileY(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

async function loadTerrariumTile(z: number, x: number, y: number): Promise<PNG> {
  const file = join(CACHE_DIR, `terrarium_${z}_${x}_${y}.png`);
  let buf: Buffer;
  if (!CONFIG.refresh && existsSync(file)) buf = readFileSync(file);
  else {
    const res = await fetchWithRetry(TERRARIUM_URL(z, x, y));
    buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(file, buf);
  }
  return PNG.sync.read(buf);
}

async function buildHeightmap(proj: LocalProjection, half: number): Promise<{ hm: Heightmap; base: number }> {
  const z = CONFIG.terrariumZoom;
  const cell = CONFIG.cellSize;
  const size = Math.ceil((half * 2) / cell) + 1;
  const minX = -half;
  const minZ = -half;

  const corners = [proj.toLatLon(minX, minZ), proj.toLatLon(-minX, -minZ)];
  // margem de 2 px para o vizinho da interpolação bilinear
  const pad = 2 / 256;
  const tx0 = Math.floor(lonToTileX(Math.min(corners[0].lon, corners[1].lon), z) - pad);
  const tx1 = Math.floor(lonToTileX(Math.max(corners[0].lon, corners[1].lon), z) + pad);
  const ty0 = Math.floor(latToTileY(Math.max(corners[0].lat, corners[1].lat), z) - pad);
  const ty1 = Math.floor(latToTileY(Math.min(corners[0].lat, corners[1].lat), z) + pad);

  const tiles = new Map<string, PNG>();
  console.log(`• Elevação: ${(tx1 - tx0 + 1) * (ty1 - ty0 + 1)} tile(s) Terrarium z${z}`);
  for (let ty = ty0; ty <= ty1; ty++)
    for (let tx = tx0; tx <= tx1; tx++) tiles.set(`${tx}/${ty}`, await loadTerrariumTile(z, tx, ty));

  const pixelElev = (gx: number, gy: number): number => {
    const tx = Math.floor(gx / 256);
    const ty = Math.floor(gy / 256);
    const png = tiles.get(`${tx}/${ty}`);
    if (!png) return NaN;
    const px = Math.min(255, Math.max(0, gx - tx * 256));
    const py = Math.min(255, Math.max(0, gy - ty * 256));
    const i = (py * 256 + px) * 4;
    return png.data[i] * 256 + png.data[i + 1] + png.data[i + 2] / 256 - 32768;
  };
  const sample = (lat: number, lon: number): number => {
    const fx = lonToTileX(lon, z) * 256 - 0.5;
    const fy = latToTileY(lat, z) * 256 - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const ax = fx - x0;
    const ay = fy - y0;
    const h00 = pixelElev(x0, y0);
    const h10 = pixelElev(x0 + 1, y0);
    const h01 = pixelElev(x0, y0 + 1);
    const h11 = pixelElev(x0 + 1, y0 + 1);
    return (h00 * (1 - ax) + h10 * ax) * (1 - ay) + (h01 * (1 - ax) + h11 * ax) * ay;
  };

  let raw = new Float32Array(size * size);
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      const { lat, lon } = proj.toLatLon(minX + i * cell, minZ + j * cell);
      raw[j * size + i] = sample(lat, lon);
    }
  // suaviza (2 passadas de box blur 3x3) para tirar degraus do SRTM
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(raw.length);
    for (let j = 0; j < size; j++)
      for (let i = 0; i < size; i++) {
        let s = 0;
        let c = 0;
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            const jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= size || jj >= size) continue;
            s += raw[jj * size + ii];
            c++;
          }
        out[j * size + i] = s / c;
      }
    raw = out;
  }
  const mid = Math.floor(size / 2);
  const base = Math.round(raw[mid * size + mid]);
  const data = Array.from(raw, (h) => Math.round((h - base) * 10));
  const min = Math.min(...raw);
  const max = Math.max(...raw);
  console.log(`  altitude ${min.toFixed(0)}–${max.toFixed(0)} m (base ${base} m), grade ${size}x${size}`);
  return { hm: { size, cellSize: cell, minX, minZ, data }, base };
}

// ------------------------------------------------------------ helpers OSM ---

const round1 = (v: number) => Math.round(v * 10) / 10;

function toRing(geom: LatLon[], proj: LocalProjection): Ring {
  const pts: Vec2[] = geom.map((g) => {
    const [x, z] = proj.toLocal(g.lat, g.lon);
    return [round1(x), round1(z)];
  });
  // remove ponto de fechamento e duplicados consecutivos
  if (pts.length > 1) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) pts.pop();
  }
  return pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
}

/** Orienta: externo com área positiva, buracos negativa. */
function orient(ring: Ring, positive: boolean): Ring {
  const a = signedArea(ring);
  return (a > 0) === positive ? ring : ring.slice().reverse();
}

/** Junta segmentos de multipolígono em anéis fechados. */
function assembleRings(parts: LatLon[][]): LatLon[][] {
  const key = (p: LatLon) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;
  const pending = parts.filter((p) => p.length >= 2).map((p) => p.slice());
  const rings: LatLon[][] = [];
  while (pending.length) {
    let cur = pending.shift()!;
    let guard = 0;
    while (key(cur[0]) !== key(cur[cur.length - 1]) && guard++ < 1000) {
      const end = key(cur[cur.length - 1]);
      const idx = pending.findIndex((p) => key(p[0]) === end || key(p[p.length - 1]) === end);
      if (idx < 0) break;
      const next = pending.splice(idx, 1)[0];
      if (key(next[0]) !== end) next.reverse();
      cur = cur.concat(next.slice(1));
    }
    if (cur.length >= 4 && key(cur[0]) === key(cur[cur.length - 1])) rings.push(cur);
  }
  return rings;
}

interface Poly {
  outer: Ring;
  holes: Ring[];
}

function relationPolys(rel: OsmRelation, proj: LocalProjection): Poly[] {
  const outerParts = rel.members.filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry).map((m) => m.geometry!);
  const innerParts = rel.members.filter((m) => m.type === 'way' && m.role === 'inner' && m.geometry).map((m) => m.geometry!);
  const outers = assembleRings(outerParts).map((r) => orient(toRing(r, proj), true));
  const inners = assembleRings(innerParts).map((r) => orient(toRing(r, proj), false));
  return outers
    .filter((o) => o.length >= 3)
    .map((outer) => ({
      outer,
      holes: inners.filter((h) => h.length >= 3 && pointInPolygon(h[0][0], h[0][1], outer)),
    }));
}

function wayPoly(way: OsmWay, proj: LocalProjection): Poly | null {
  if (way.nodes.length < 4 || way.nodes[0] !== way.nodes[way.nodes.length - 1]) return null;
  const outer = orient(toRing(way.geometry, proj), true);
  return outer.length >= 3 ? { outer, holes: [] } : null;
}

function parseMeters(v?: string): number | undefined {
  if (!v) return undefined;
  const m = /^\s*([\d.,]+)\s*(m|ft|')?/.exec(v);
  if (!m) return undefined;
  let n = parseFloat(m[1].replace(',', '.'));
  if (m[2] === 'ft' || m[2] === "'") n *= 0.3048;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const ROAD_WIDTH: Record<RoadKind, number> = {
  motorway: 12,
  trunk: 11,
  primary: 9,
  secondary: 8,
  tertiary: 7,
  residential: 6,
  unclassified: 6,
  living_street: 5,
  service: 4,
  pedestrian: 5,
  track: 3,
  footway: 2,
  cycleway: 2,
  path: 1.5,
  steps: 2,
};

function roadKind(hw: string): RoadKind | null {
  const base = hw.replace(/_link$/, '');
  if (base in ROAD_WIDTH) return base as RoadKind;
  if (base === 'road') return 'unclassified';
  if (base === 'bridleway' || base === 'corridor') return 'path';
  return null;
}

const WATER_WIDTH: Record<WaterKind, number> = { river: 14, stream: 3, canal: 5, drain: 2, ditch: 1.5, water: 0 };

function greenKind(t: Record<string, string>): GreenKind | null {
  const l = t.leisure;
  const lu = t.landuse;
  const n = t.natural;
  if (n === 'wood' || lu === 'forest') return 'wood';
  if (n === 'scrub') return 'scrub';
  if (n === 'grassland' || lu === 'meadow') return 'meadow';
  if (lu === 'cemetery') return 'cemetery';
  if (l === 'pitch') return 'pitch';
  if (l === 'garden') return 'garden';
  if (l === 'park' || lu === 'recreation_ground') return 'park';
  if (lu === 'grass' || lu === 'village_green') return 'grass';
  return null;
}

/** Corta polilinha em trechos que ficam dentro do retângulo. */
function splitInside(points: Vec2[], nodes: number[], lim: number): { points: Vec2[]; nodes: number[] }[] {
  const out: { points: Vec2[]; nodes: number[] }[] = [];
  let cur: { points: Vec2[]; nodes: number[] } = { points: [], nodes: [] };
  for (let i = 0; i < points.length; i++) {
    const [x, z] = points[i];
    if (Math.abs(x) <= lim && Math.abs(z) <= lim) {
      cur.points.push(points[i]);
      cur.nodes.push(nodes[i]);
    } else {
      if (cur.points.length >= 2) out.push(cur);
      cur = { points: [], nodes: [] };
    }
  }
  if (cur.points.length >= 2) out.push(cur);
  return out;
}

// ------------------------------------------------------------------ main ---

async function main() {
  mkdirSync(CACHE_DIR, { recursive: true });
  mkdirSync(dirname(CONFIG.out), { recursive: true });

  const proj = new LocalProjection(CONFIG.lat, CONFIG.lon);
  const half = CONFIG.size / 2;
  const sw = proj.toLatLon(-half, half);
  const ne = proj.toLatLon(half, -half);
  const bbox = { south: sw.lat, west: sw.lon, north: ne.lat, east: ne.lon };
  const fmt = (v: number) => v.toFixed(5);
  console.log(`Área: ${CONFIG.name} ${CONFIG.size} m — bbox ${fmt(bbox.south)},${fmt(bbox.west)},${fmt(bbox.north)},${fmt(bbox.east)}`);

  const cacheKey = `overpass_${fmt(bbox.south)}_${fmt(bbox.west)}_${fmt(bbox.north)}_${fmt(bbox.east)}.json`.replace(/-/g, 'm');
  const elements = await fetchOverpass(buildQuery(bbox.south, bbox.west, bbox.north, bbox.east), join(CACHE_DIR, cacheKey));
  console.log(`  ${elements.length} elementos OSM`);

  // ---- terreno
  const terrainHalf = half + CONFIG.margin;
  let heightmap: Heightmap | null = null;
  let baseElevation = 0;
  if (!CONFIG.noTerrain) {
    try {
      const r = await buildHeightmap(proj, terrainHalf);
      heightmap = r.hm;
      baseElevation = r.base;
    } catch (e) {
      console.warn(`! Elevação indisponível (${(e as Error).message}) — terreno plano.`);
    }
  }

  // ---- ruas
  const streets: Street[] = [];
  const streetLimit = terrainHalf - 20;
  for (const el of elements) {
    if (el.type !== 'way' || !el.tags?.highway) continue;
    const t = el.tags;
    if (t.area === 'yes') continue;
    const kind = roadKind(t.highway);
    if (!kind) continue;
    const pts = el.geometry.map((g) => {
      const [x, z] = proj.toLocal(g.lat, g.lon);
      return [round1(x), round1(z)] as Vec2;
    });
    const lanes = Number(t.lanes);
    const width =
      parseMeters(t.width) ??
      (Number.isFinite(lanes) && lanes > 0 && !['footway', 'path', 'steps', 'cycleway'].includes(kind)
        ? Math.max(ROAD_WIDTH[kind], lanes * 3.2)
        : ROAD_WIDTH[kind]);
    const pieces = splitInside(pts, el.nodes, streetLimit);
    pieces.forEach((p, k) => {
      streets.push({
        id: pieces.length > 1 ? `way/${el.id}#${k}` : `way/${el.id}`,
        osmId: el.id,
        name: t.name,
        kind,
        width: round1(width),
        oneway: t.oneway === 'yes' || t.oneway === '1' || t.junction === 'roundabout',
        points: p.points,
        nodes: p.nodes,
        ...(t.bridge && t.bridge !== 'no' ? { bridge: true } : {}),
        ...(t.tunnel && t.tunnel !== 'no' ? { tunnel: true } : {}),
        ...(t.surface ? { surface: t.surface } : {}),
      });
    });
  }

  // grade espacial de segmentos de ruas nomeadas (endereço inferido)
  const GRID = 50;
  const segGrid = new Map<string, { s: Street; i: number }[]>();
  for (const s of streets) {
    if (!s.name) continue;
    for (let i = 0; i < s.points.length - 1; i++) {
      const [ax, az] = s.points[i];
      const [bx, bz] = s.points[i + 1];
      const gx0 = Math.floor(Math.min(ax, bx) / GRID);
      const gx1 = Math.floor(Math.max(ax, bx) / GRID);
      const gz0 = Math.floor(Math.min(az, bz) / GRID);
      const gz1 = Math.floor(Math.max(az, bz) / GRID);
      for (let gx = gx0; gx <= gx1; gx++)
        for (let gz = gz0; gz <= gz1; gz++) {
          const k = `${gx},${gz}`;
          if (!segGrid.has(k)) segGrid.set(k, []);
          segGrid.get(k)!.push({ s, i });
        }
    }
  }
  const nearestStreetName = (x: number, z: number, maxDist = 80): string | undefined => {
    const gx = Math.floor(x / GRID);
    const gz = Math.floor(z / GRID);
    let best: string | undefined;
    let bestD = maxDist * maxDist;
    for (let dx = -2; dx <= 2; dx++)
      for (let dz = -2; dz <= 2; dz++) {
        for (const { s, i } of segGrid.get(`${gx + dx},${gz + dz}`) ?? []) {
          const [ax, az] = s.points[i];
          const [bx, bz] = s.points[i + 1];
          const { d2 } = distSqToSegment(x, z, ax, az, bx, bz);
          if (d2 < bestD) {
            bestD = d2;
            best = s.name;
          }
        }
      }
    return best;
  };

  // ---- POIs (nós)
  const pois: (Poi & { x: number; z: number })[] = [];
  for (const el of elements) {
    if (el.type !== 'node' || !el.tags?.name) continue;
    const cat = ['amenity', 'shop', 'office', 'tourism', 'historic', 'craft'].find((c) => el.tags![c]);
    if (!cat) continue;
    const [x, z] = proj.toLocal(el.lat, el.lon);
    pois.push({ osmId: el.id, name: el.tags.name, category: cat, value: el.tags[cat], x, z });
  }

  // ---- prédios
  // ---- zonas de uso do solo (antes dos prédios: usadas na classificação)
  const landuse: LandUse[] = [];
  for (const el of elements) {
    const k = el.tags?.landuse;
    if (!k || !['residential', 'commercial', 'retail', 'industrial'].includes(k) || el.tags?.building) continue;
    const polys = el.type === 'way' ? [wayPoly(el, proj)].filter(Boolean) as Poly[] : el.type === 'relation' ? relationPolys(el, proj) : [];
    polys.forEach((p, i) =>
      landuse.push({ id: `${el.type}/${el.id}${polys.length > 1 ? '#' + i : ''}`, kind: k as LandUseKind, name: el.tags?.name, outer: p.outer, ...(p.holes.length ? { holes: p.holes } : {}) }),
    );
  }
  // zonas menores primeiro (mais específicas)
  landuse.sort((a, b) => polygonArea(a.outer) - polygonArea(b.outer));
  const zoneAt = (x: number, z: number) => landuse.find((l) => pointInPolygon(x, z, l.outer, l.holes))?.kind;

  const buildings: Building[] = [];
  const addBuilding = (osmType: 'way' | 'relation', id: number, t: Record<string, string>, poly: Poly, part = 0) => {
    const outer = simplify(poly.outer, 0.15);
    if (outer.length < 3) return;
    const area = polygonArea(outer);
    if (area < 6) return; // ruído
    const c = centroid(outer);
    if (Math.abs(c[0]) > half || Math.abs(c[1]) > half) return;

    const rng = mulberry32(hashId(id));
    const tagHeight = parseMeters(t.height);
    const tagLevels = Number.parseFloat(t['building:levels']);
    let levels: number;
    let height: number;
    let fromTag = true;
    const type =
      t.building !== 'yes'
        ? t.building
        : t.amenity === 'place_of_worship'
          ? 'church'
          : (t.amenity ?? (t.shop ? 'commercial' : (t.tourism ?? 'yes')));
    if (tagHeight) {
      height = tagHeight;
      levels = Number.isFinite(tagLevels) ? tagLevels : Math.max(1, Math.round(height / 3));
    } else if (Number.isFinite(tagLevels) && tagLevels > 0) {
      levels = tagLevels;
      height = levels * 3;
    } else {
      fromTag = false;
      if (['church', 'cathedral', 'chapel'].includes(t.building) || t.amenity === 'place_of_worship') {
        levels = 3;
        height = t.building === 'chapel' ? 8 : 14;
      } else if (['shed', 'garage', 'garages', 'roof', 'hut', 'carport'].includes(t.building)) {
        levels = 1;
        height = 2.6;
      } else {
        // 1–3 andares, determinístico pelo id OSM (pesa para 1–2: cidade baixa)
        const r = rng();
        levels = r < 0.55 ? 1 : r < 0.88 ? 2 : 3;
        if (area > 800 && levels < 2) levels = 2;
        height = levels * 3;
      }
    }
    const housenumber = t['addr:housenumber'];
    let address: Address | undefined;
    if (t['addr:street'] || housenumber) {
      address = {
        street: t['addr:street'] ?? nearestStreetName(c[0], c[1]),
        housenumber,
        suburb: t['addr:suburb'],
        postcode: t['addr:postcode'],
      };
    } else {
      const sn = nearestStreetName(c[0], c[1]);
      if (sn) address = { street: sn, inferred: true };
    }
    const idStr = `${osmType}/${id}${part ? `#${part}` : ''}`;
    const lotId = `ITB-${osmType === 'way' ? 'W' : 'R'}${id}${part ? `-${part}` : ''}`;
    const inside = pois.filter((p) => pointInPolygon(p.x, p.z, outer, poly.holes));
    const category = classifyBuilding(type, inside, zoneAt(c[0], c[1]));
    buildings.push({
      id: idStr,
      osmId: id,
      osmType,
      lotId,
      name: t.name ?? (inside.length === 1 ? inside[0].name : undefined),
      type,
      category,
      levels: Math.round(levels * 10) / 10,
      height: round1(height),
      heightFromTag: fromTag,
      outer,
      ...(poly.holes.length ? { holes: poly.holes } : {}),
      ...(address ? { address } : {}),
      ...(inside.length ? { pois: inside.map(({ x: _x, z: _z, ...p }) => p) } : {}),
      ...(t['roof:colour'] ? { roofColour: t['roof:colour'] } : {}),
      ...(t['roof:shape'] ? { roofShape: t['roof:shape'] } : {}),
      area: round1(area),
      centroid: [round1(c[0]), round1(c[1])],
    });
  };

  const waterLines: WaterLine[] = [];
  const waterAreas: WaterArea[] = [];
  const greens: GreenArea[] = [];
  const railways: Railway[] = [];

  for (const el of elements) {
    const t = el.tags ?? {};
    if (el.type === 'way') {
      if (t.building && t.building !== 'no') {
        const poly = wayPoly(el, proj);
        if (poly) addBuilding('way', el.id, t, poly);
        continue;
      }
      if (t.waterway && t.waterway in WATER_WIDTH && !t.tunnel) {
        const pts = el.geometry.map((g) => proj.toLocal(g.lat, g.lon).map(round1) as Vec2);
        for (const p of splitInside(pts, el.nodes, streetLimit)) {
          waterLines.push({
            id: `way/${el.id}`,
            name: t.name,
            kind: t.waterway as WaterKind,
            width: parseMeters(t.width) ?? WATER_WIDTH[t.waterway as WaterKind],
            points: p.points,
          });
        }
        continue;
      }
      if (t.natural === 'water' || (t.water && t.natural !== 'wetland')) {
        const poly = wayPoly(el, proj);
        if (poly) waterAreas.push({ id: `way/${el.id}`, name: t.name, outer: poly.outer });
        continue;
      }
      const gk = greenKind(t);
      if (gk) {
        const poly = wayPoly(el, proj);
        if (poly) greens.push({ id: `way/${el.id}`, name: t.name, kind: gk, outer: poly.outer });
        continue;
      }
      if (t.railway === 'rail') {
        const pts = el.geometry.map((g) => proj.toLocal(g.lat, g.lon).map(round1) as Vec2);
        for (const p of splitInside(pts, el.nodes, streetLimit)) railways.push({ id: `way/${el.id}`, name: t.name, points: p.points });
      }
    } else if (el.type === 'relation') {
      const polys = relationPolys(el, proj);
      if (t.building) polys.forEach((p, i) => addBuilding('relation', el.id, t, p, polys.length > 1 ? i + 1 : 0));
      else if (t.natural === 'water')
        polys.forEach((p, i) => waterAreas.push({ id: `relation/${el.id}#${i}`, name: t.name, outer: p.outer, holes: p.holes }));
      else {
        const gk = greenKind(t);
        if (gk) polys.forEach((p, i) => greens.push({ id: `relation/${el.id}#${i}`, name: t.name, kind: gk, outer: p.outer, holes: p.holes }));
      }
    }
  }

  // ---- preenchimento procedural das quadras sem prédios mapeados
  const osmCount = buildings.length;
  const vacantLots: Lot[] = [];
  if (!CONFIG.noInfill) {
    const houses = generateInfill({
      streets,
      buildings: buildings.map((b) => b.outer),
      waterLines,
      waterAreas,
      greens,
      half,
      downtownRadius: 420,
      landuse,
    });
    const usedPois = new Set(buildings.flatMap((b) => b.pois?.map((p) => p.osmId) ?? []));
    for (const h of houses) {
      const c = centroid(h.outer);
      const area = polygonArea(h.outer);
      if (h.vacant) {
        vacantLots.push({
          lotId: h.lotId,
          buildingId: null,
          vacant: true,
          outer: h.outer,
          area: round1(area),
          centroid: [round1(c[0]), round1(c[1])],
          ...(h.streetName ? { address: { street: h.streetName, inferred: true } } : {}),
          ownerId: null,
          price: null,
          zoning: ZONING_BY_CATEGORY[classifyBuilding('house', undefined, zoneAt(c[0], c[1]))],
        });
        continue;
      }
      const inside = pois.filter((p) => !usedPois.has(p.osmId) && pointInPolygon(p.x, p.z, h.outer));
      inside.forEach((p) => usedPois.add(p.osmId));
      buildings.push({
        id: h.id,
        osmId: 0,
        osmType: 'way',
        lotId: h.lotId,
        name: inside.length === 1 ? inside[0].name : undefined,
        type: inside.length ? 'commercial' : h.type,
        category: classifyBuilding(inside.length ? 'commercial' : h.type, inside, zoneAt(c[0], c[1])),
        levels: h.levels,
        height: h.levels * 3,
        heightFromTag: false,
        generated: true,
        outer: h.outer,
        ...(h.streetName ? { address: { street: h.streetName, inferred: true } } : {}),
        ...(inside.length ? { pois: inside.map(({ x: _x, z: _z, ...p }) => p) } : {}),
        area: round1(area),
        centroid: [round1(c[0]), round1(c[1])],
      });
    }
  }

  const lots: Lot[] = buildings.map((b) => ({
    lotId: b.lotId,
    buildingId: b.id,
    area: b.area,
    centroid: b.centroid,
    ...(b.address ? { address: b.address } : {}),
    ownerId: null,
    price: null,
    zoning: ZONING_BY_CATEGORY[b.category],
  }));
  lots.push(...vacantLots);

  const data: CityData = {
    version: 1,
    name: CONFIG.name,
    generatedAt: new Date().toISOString(),
    attribution: '© OpenStreetMap contributors (ODbL). Elevação: Mapzen Terrarium / SRTM (AWS Open Data).',
    origin: { lat: CONFIG.lat, lon: CONFIG.lon, elevation: baseElevation },
    bounds: { minX: -half, minZ: -half, maxX: half, maxZ: half },
    bbox,
    heightmap,
    streets,
    buildings,
    lots,
    waterLines,
    waterAreas,
    greens,
    railways,
    landuse,
  };
  const json = JSON.stringify(data);
  writeFileSync(CONFIG.out, json);
  console.log(
    `✔ ${CONFIG.out}\n  ${streets.length} ruas, ${buildings.length} prédios (${osmCount} OSM + ${buildings.length - osmCount} gerados), ${vacantLots.length} lotes vagos, ${landuse.length} zonas de uso, ${waterLines.length + waterAreas.length} água, ` +
      `${greens.length} áreas verdes, ${railways.length} ferrovias, ${pois.length} POIs — ${(json.length / 1024).toFixed(0)} KB`,
  );
}

main().catch((e) => {
  console.error('✖ Falhou:', e);
  process.exit(1);
});
