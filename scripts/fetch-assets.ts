/**
 * Baixa texturas PBR e HDRI CC0 do Poly Haven para public/assets/ e gera
 * public/assets/manifest.json (escala física em metros + créditos).
 *
 * Uso: npm run fetch-assets  [-- --res 1k] [-- --refresh] [-- --textures]
 *   (padrão: só o HDRI de iluminação; --textures baixa também as texturas PBR)
 *
 * Todos os assets do Poly Haven são CC0 (domínio público): https://polyhaven.com/license
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'assets');
const API = 'https://api.polyhaven.com';
const UA = { 'User-Agent': 'mini-town-itabirito/0.1 (asset fetch script)' };

function arg(name: string, def: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const RES = arg('res', '1k');
const REFRESH = process.argv.includes('--refresh');
/** texturas PBR só sob demanda (o estilo atual é diorama, cores sólidas) */
const WITH_TEXTURES = process.argv.includes('--textures');

/** chave usada no jogo -> id no Poly Haven */
const TEXTURES: Record<string, { id: string; maps: ('diff' | 'nor' | 'arm')[] }> = {
  plaster: { id: 'white_plaster_02', maps: ['diff', 'nor', 'arm'] },
  roofClay: { id: 'clay_roof_tiles', maps: ['diff', 'nor', 'arm'] },
  roofGrey: { id: 'grey_roof_tiles', maps: ['diff', 'nor', 'arm'] },
  concrete: { id: 'rough_concrete', maps: ['diff', 'nor', 'arm'] },
  asphalt: { id: 'asphalt_02', maps: ['diff', 'nor', 'arm'] },
  pavement: { id: 'concrete_pavement', maps: ['diff', 'nor', 'arm'] },
  grass: { id: 'aerial_grass_rock', maps: ['diff', 'nor'] },
  soil: { id: 'red_laterite_soil_stones', maps: ['diff', 'nor'] },
  bark: { id: 'bark_brown_02', maps: ['diff', 'nor'] },
};
const HDRI = { key: 'sky', id: 'kloofendal_48d_partly_cloudy_puresky' };

const MAP_KEY: Record<string, string> = { diff: 'Diffuse', nor: 'nor_gl', arm: 'arm' };

async function json(url: string) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

async function download(url: string, file: string) {
  if (!REFRESH && existsSync(file)) return false;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return true;
}

interface ManifestTexture {
  id: string;
  name: string;
  authors: string[];
  /** lado da textura em metros (escala UV) */
  size: number;
  maps: Record<string, string>;
}

async function main() {
  const manifest: { license: string; source: string; textures: Record<string, ManifestTexture>; hdri: Record<string, unknown> } = {
    license: 'CC0 1.0 (Poly Haven)',
    source: 'https://polyhaven.com',
    textures: {},
    hdri: {},
  };

  for (const [key, t] of Object.entries(WITH_TEXTURES ? TEXTURES : {})) {
    const [info, files] = await Promise.all([json(`${API}/info/${t.id}`), json(`${API}/files/${t.id}`)]);
    const maps: Record<string, string> = {};
    for (const m of t.maps) {
      const f = files[MAP_KEY[m]]?.[RES]?.jpg;
      if (!f) throw new Error(`${t.id}: mapa ${m} ${RES} indisponível`);
      const rel = `textures/${t.id}/${m}_${RES}.jpg`;
      const fresh = await download(f.url, join(OUT, rel));
      maps[m] = rel;
      console.log(`${fresh ? '↓' : '='} ${rel} (${(f.size / 1024).toFixed(0)} KB)`);
    }
    manifest.textures[key] = {
      id: t.id,
      name: info.name,
      authors: Object.keys(info.authors ?? {}),
      size: Math.round(((info.dimensions?.[0] ?? 2000) / 1000) * 100) / 100,
      maps,
    };
  }

  const [hInfo, hFiles] = await Promise.all([json(`${API}/info/${HDRI.id}`), json(`${API}/files/${HDRI.id}`)]);
  const hf = hFiles.hdri[RES].hdr;
  const rel = `hdri/${HDRI.id}_${RES}.hdr`;
  const fresh = await download(hf.url, join(OUT, rel));
  console.log(`${fresh ? '↓' : '='} ${rel} (${(hf.size / 1024).toFixed(0)} KB)`);
  manifest.hdri[HDRI.key] = { id: HDRI.id, name: hInfo.name, authors: Object.keys(hInfo.authors ?? {}), file: rel };

  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`✔ ${join(OUT, 'manifest.json')}`);
}

main().catch((e) => {
  console.error('✖', e);
  process.exit(1);
});
