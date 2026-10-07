import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';

/**
 * Biblioteca de materiais PBR (texturas CC0 do Poly Haven, baixadas por
 * `npm run fetch-assets`). UVs da geometria estão em METROS; cada textura
 * recebe `repeat = 1 / tamanhoFísico` para manter a escala real.
 */
export interface PbrSet {
  map: THREE.Texture;
  normalMap?: THREE.Texture;
  /** AO (r), roughness (g), metalness (b) */
  armMap?: THREE.Texture;
  size: number;
  /** cor média (linear) do mapa difuso — para normalizar */
  avg: THREE.Color;
}

export type TexKey = 'plaster' | 'roofClay' | 'roofGrey' | 'concrete' | 'asphalt' | 'pavement' | 'grass' | 'soil' | 'bark';

interface Manifest {
  textures: Record<string, { size: number; maps: Record<string, string> }>;
  hdri: Record<string, { file: string }>;
}

export class TextureLibrary {
  readonly sets = new Map<TexKey, PbrSet>();
  envMap: THREE.Texture | null = null;
  /** sem assets (fetch-assets não rodado): materiais caem para cor sólida */
  available = false;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly base: string,
    private readonly opts: { normalMaps: boolean; anisotropy: number },
  ) {}

  get(key: TexKey): PbrSet | undefined {
    return this.sets.get(key);
  }

  async load(onProgress?: (f: number) => void): Promise<void> {
    let manifest: Manifest;
    try {
      const r = await fetch(`${this.base}assets/manifest.json`);
      if (!r.ok) throw new Error(String(r.status));
      manifest = await r.json();
    } catch {
      console.warn('[textures] manifest ausente — rode "npm run fetch-assets". Usando cores sólidas.');
      return;
    }
    const loader = new THREE.TextureLoader();
    const jobs: Promise<void>[] = [];
    let done = 0;
    let total = 0;
    const tick = () => onProgress?.(++done / total);
    const loadTex = (rel: string, srgb: boolean) =>
      new Promise<THREE.Texture>((res, rej) =>
        loader.load(
          `${this.base}assets/${rel}`,
          (t) => {
            t.wrapS = t.wrapT = THREE.RepeatWrapping;
            t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
            t.anisotropy = this.opts.anisotropy;
            tick();
            res(t);
          },
          undefined,
          rej,
        ),
      );

    for (const [key, t] of Object.entries(manifest.textures)) {
      const maps = t.maps;
      total += 1 + (maps.nor && this.opts.normalMaps ? 1 : 0) + (maps.arm ? 1 : 0);
      jobs.push(
        (async () => {
          const map = await loadTex(maps.diff, true);
          const set: PbrSet = { map, size: t.size, avg: averageColor(map) };
          if (maps.nor && this.opts.normalMaps) set.normalMap = await loadTex(maps.nor, false);
          if (maps.arm) set.armMap = await loadTex(maps.arm, false);
          const rep = 1 / t.size;
          for (const tx of [set.map, set.normalMap, set.armMap]) tx?.repeat.set(rep, rep);
          this.sets.set(key as TexKey, set);
        })(),
      );
    }
    const sky = manifest.hdri.sky;
    if (sky) {
      total++;
      jobs.push(
        new RGBELoader().loadAsync(`${this.base}assets/${sky.file}`).then((hdr) => {
          hdr.mapping = THREE.EquirectangularReflectionMapping;
          const pmrem = new THREE.PMREMGenerator(this.renderer);
          this.envMap = pmrem.fromEquirectangular(hdr).texture;
          hdr.dispose();
          pmrem.dispose();
          tick();
        }),
      );
    }
    await Promise.all(jobs);
    this.available = this.sets.size > 0;
  }

  /**
   * Aplica um conjunto PBR a um material padrão. `normalize` divide pela cor
   * média da textura: ela passa a dar só o detalhe, e a cor final vem do
   * vertex color (paleta) — controle total do visual.
   */
  apply(m: THREE.MeshStandardMaterial, key: TexKey, normalScale = 1, normalize = false) {
    const s = this.get(key);
    if (!s) return m;
    m.map = s.map;
    if (normalize) m.color.setRGB(1 / Math.max(0.02, s.avg.r), 1 / Math.max(0.02, s.avg.g), 1 / Math.max(0.02, s.avg.b));
    if (s.normalMap) {
      m.normalMap = s.normalMap;
      m.normalScale.set(normalScale, normalScale);
    }
    if (s.armMap) {
      m.aoMap = s.armMap;
      m.aoMapIntensity = 0.8;
      m.roughnessMap = s.armMap;
      m.roughness = 1;
    }
    m.needsUpdate = true;
    return m;
  }
}

/** cor média de uma textura (amostrada a 32x32), em espaço linear */
function averageColor(t: THREE.Texture): THREE.Color {
  const img = t.image as CanvasImageSource;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, 32, 32);
  const d = g.getImageData(0, 0, 32, 32).data;
  let r = 0;
  let gg = 0;
  let b = 0;
  for (let i = 0; i < d.length; i += 4) {
    // média em linear (mais correta para multiplicação no shader)
    r += Math.pow(d[i] / 255, 2.2);
    gg += Math.pow(d[i + 1] / 255, 2.2);
    b += Math.pow(d[i + 2] / 255, 2.2);
  }
  const n = d.length / 4;
  return new THREE.Color(r / n, gg / n, b / n);
}
