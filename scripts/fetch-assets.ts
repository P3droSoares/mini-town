/**
 * Baixa texturas PBR e HDRI CC0 do Poly Haven para public/assets/, reduz
 * para 512 px (jpeg-js, sem dependência nativa) e gera manifest.json com a
 * escala física (m) e os créditos.
 *
 *  - `textures`: conjuntos avulsos (chão, ruas, casca de árvore)
 *  - `layers`:   camadas do atlas de prédios (paredes e telhados), montadas
 *                no navegador num DataArrayTexture (uma amostra por fragmento)
 *
 * Uso: npm run fetch-assets  [-- --size 512] [-- --refresh]
 * Licença: CC0 1.0 — https://polyhaven.com/license
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'assets');
const CACHE = join(ROOT, '.cache', 'polyhaven');
const API = 'https://api.polyhaven.com';
const UA = { 'User-Agent': 'mini-town-itabirito/0.1 (asset fetch script)' };

function arg(name: string, def: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const SIZE = Number(arg('size', '512'));
const REFRESH = process.argv.includes('--refresh');

type MapKind = 'diff' | 'nor' | 'arm';

/** conjuntos avulsos */
const TEXTURES: Record<string, { id: string; maps: MapKind[] }> = {
  asphalt: { id: 'asphalt_02', maps: ['diff', 'nor', 'arm'] },
  pavement: { id: 'concrete_pavement', maps: ['diff', 'nor', 'arm'] },
  grass: { id: 'aerial_grass_rock', maps: ['diff', 'nor'] },
  soil: { id: 'red_laterite_soil_stones', maps: ['diff', 'nor'] },
  bark: { id: 'bark_brown_02', maps: ['diff', 'nor'] },
};

/**
 * Camadas do atlas de prédios — a ORDEM é o índice usado na geometria
 * (ver src/world/render/buildingMaterials.ts).
 */
const LAYERS: { key: string; id: string }[] = [
  { key: 'plaster', id: 'white_plaster_02' },
  { key: 'brickRed', id: 'red_brick_03' },
  { key: 'brickYellow', id: 'yellow_bricks' },
  { key: 'concrete', id: 'concrete_wall_008' },
  { key: 'panels', id: 'concrete_panels' },
  { key: 'tiles', id: 'rectangular_facade_tiles' },
  { key: 'metal', id: 'corrugated_iron' },
  { key: 'wood', id: 'wood_planks_grey' },
  { key: 'roofClay', id: 'clay_roof_tiles' },
  { key: 'roofGrey', id: 'grey_roof_tiles' },
  { key: 'roofSlate', id: 'roof_slates_02' },
  { key: 'roofConcrete', id: 'rough_concrete' },
  { key: 'roofMetal', id: 'box_profile_metal_sheet' },
  { key: 'patio', id: 'patio_tiles' },
];

const HDRI = { key: 'sky', id: 'kloofendal_48d_partly_cloudy_puresky' };
const MAP_KEY: Record<MapKind, string> = { diff: 'Diffuse', nor: 'nor_gl', arm: 'arm' };

async function json(url: string) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

async function getBytes(url: string, cacheFile: string): Promise<Buffer> {
  if (!REFRESH && existsSync(cacheFile)) return readFileSync(cacheFile);
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, buf);
  return buf;
}

/** reduz um JPEG para size x size (média de caixa) e recomprime */
function downscale(buf: Buffer, size: number): Buffer {
  const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024 });
  if (img.width === size && img.height === size) return buf;
  const out = new Uint8Array(size * size * 4);
  const sx = img.width / size;
  const sy = img.height / size;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      const x0 = Math.floor(x * sx);
      const y0 = Math.floor(y * sy);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.width + xx) * 4;
          r += img.data[i];
          g += img.data[i + 1];
          b += img.data[i + 2];
          n++;
        }
      const o = (y * size + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  return Buffer.from(jpeg.encode({ data: out, width: size, height: size }, 86).data);
}

async function fetchMap(id: string, files: Record<string, Record<string, { jpg?: { url: string } }>>, m: MapKind, rel: string) {
  const f = files[MAP_KEY[m]]?.['1k']?.jpg ?? files[MAP_KEY[m]]?.['2k']?.jpg;
  if (!f) throw new Error(`${id}: mapa ${m} indisponível`);
  const raw = await getBytes(f.url, join(CACHE, `${id}_${m}_1k.jpg`));
  const small = downscale(raw, SIZE);
  mkdirSync(dirname(join(OUT, rel)), { recursive: true });
  writeFileSync(join(OUT, rel), small);
  console.log(`✓ ${rel} (${(small.length / 1024).toFixed(0)} KB)`);
}

async function main() {
  const manifest = {
    license: 'CC0 1.0 (Poly Haven)',
    source: 'https://polyhaven.com',
    size: SIZE,
    textures: {} as Record<string, { id: string; name: string; authors: string[]; size: number; maps: Record<string, string> }>,
    layers: [] as { key: string; id: string; name: string; authors: string[]; size: number; diff: string; nor: string }[],
    hdri: {} as Record<string, unknown>,
  };
  const physical = (info: { dimensions?: number[] }) => Math.round(((info.dimensions?.[0] ?? 2000) / 1000) * 100) / 100;

  for (const [key, t] of Object.entries(TEXTURES)) {
    const [info, files] = await Promise.all([json(`${API}/info/${t.id}`), json(`${API}/files/${t.id}`)]);
    const maps: Record<string, string> = {};
    for (const m of t.maps) {
      const rel = `textures/${t.id}/${m}.jpg`;
      await fetchMap(t.id, files, m, rel);
      maps[m] = rel;
    }
    manifest.textures[key] = { id: t.id, name: info.name, authors: Object.keys(info.authors ?? {}), size: physical(info), maps };
  }

  for (const l of LAYERS) {
    const [info, files] = await Promise.all([json(`${API}/info/${l.id}`), json(`${API}/files/${l.id}`)]);
    const diff = `layers/${l.id}/diff.jpg`;
    const nor = `layers/${l.id}/nor.jpg`;
    await fetchMap(l.id, files, 'diff', diff);
    await fetchMap(l.id, files, 'nor', nor);
    manifest.layers.push({ key: l.key, id: l.id, name: info.name, authors: Object.keys(info.authors ?? {}), size: physical(info), diff, nor });
  }

  const [hInfo, hFiles] = await Promise.all([json(`${API}/info/${HDRI.id}`), json(`${API}/files/${HDRI.id}`)]);
  const hf = hFiles.hdri['1k'].hdr;
  const rel = `hdri/${HDRI.id}_1k.hdr`;
  const buf = await getBytes(hf.url, join(CACHE, `${HDRI.id}_1k.hdr`));
  mkdirSync(join(OUT, 'hdri'), { recursive: true });
  writeFileSync(join(OUT, rel), buf);
  manifest.hdri[HDRI.key] = { id: HDRI.id, name: hInfo.name, authors: Object.keys(hInfo.authors ?? {}), file: rel };

  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`✔ ${join(OUT, 'manifest.json')}`);
}

main().catch((e) => {
  console.error('✖', e);
  process.exit(1);
});
