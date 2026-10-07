import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';

/**
 * Texturas PBR CC0 (Poly Haven, `npm run fetch-assets`).
 *  - conjuntos avulsos (chão, ruas, casca): UV em METROS, repeat = 1/tamanho
 *  - atlas de prédios: DataArrayTexture com uma camada por material de
 *    parede/telhado (cor + normal); o shader escolhe a camada por vértice
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

export type TexKey = 'asphalt' | 'pavement' | 'grass' | 'soil' | 'bark';

/** índices das camadas do atlas (mesma ordem de scripts/fetch-assets.ts) */
export const Layer = {
  plaster: 0,
  brickRed: 1,
  brickYellow: 2,
  concrete: 3,
  panels: 4,
  tiles: 5,
  metal: 6,
  wood: 7,
  roofClay: 8,
  roofGrey: 9,
  roofSlate: 10,
  roofConcrete: 11,
  roofMetal: 12,
  patio: 13,
} as const;
export const LAYER_COUNT = 14;

export interface LayerAtlas {
  albedo: THREE.DataArrayTexture;
  normal: THREE.DataArrayTexture;
  /** cor média (linear) por camada — p/ normalizar camadas tingíveis */
  avg: THREE.Vector3[];
  /** 1 / tamanho físico (m) por camada */
  scale: number[];
}

interface Manifest {
  size: number;
  textures: Record<string, { size: number; maps: Record<string, string> }>;
  layers: { key: string; size: number; diff: string; nor: string }[];
  hdri: Record<string, { file: string }>;
}

export class TextureLibrary {
  readonly sets = new Map<TexKey, PbrSet>();
  envMap: THREE.Texture | null = null;
  atlas: LayerAtlas | null = null;
  available = false;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly base: string,
    private readonly opts: { normalMaps: boolean; anisotropy: number },
  ) {}

  get(key: TexKey): PbrSet | undefined {
    return this.sets.get(key);
  }

  private loadImage(rel: string): Promise<HTMLImageElement> {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = `${this.base}assets/${rel}`;
    });
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
    let done = 0;
    const total = Object.keys(manifest.textures ?? {}).length + (manifest.layers?.length ?? 0) + 1;
    const tick = () => onProgress?.(++done / total);
    const toTex = (img: HTMLImageElement, srgb: boolean, size: number) => {
      const t = new THREE.Texture(img);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = this.opts.anisotropy;
      t.repeat.set(1 / size, 1 / size);
      t.needsUpdate = true;
      return t;
    };

    const jobs: Promise<void>[] = [];
    for (const [key, t] of Object.entries(manifest.textures ?? {})) {
      jobs.push(
        (async () => {
          const diff = await this.loadImage(t.maps.diff);
          const set: PbrSet = { map: toTex(diff, true, t.size), size: t.size, avg: averageColor(diff) };
          if (t.maps.nor && this.opts.normalMaps) set.normalMap = toTex(await this.loadImage(t.maps.nor), false, t.size);
          if (t.maps.arm) set.armMap = toTex(await this.loadImage(t.maps.arm), false, t.size);
          this.sets.set(key as TexKey, set);
          tick();
        })(),
      );
    }
    if (manifest.layers?.length) jobs.push(this.buildAtlas(manifest, tick));
    const sky = manifest.hdri?.sky;
    if (sky)
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
    await Promise.all(jobs);
    this.available = this.sets.size > 0 || !!this.atlas;
  }

  /** empilha as camadas num DataArrayTexture (cor e normal) */
  private async buildAtlas(manifest: Manifest, tick: () => void) {
    const S = manifest.size || 512;
    const n = manifest.layers.length;
    const albedo = new Uint8Array(S * S * 4 * n);
    const normal = new Uint8Array(S * S * 4 * n);
    const avg: THREE.Vector3[] = [];
    const scale: number[] = [];
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    const pixels = (img: HTMLImageElement) => {
      g.clearRect(0, 0, S, S);
      g.drawImage(img, 0, 0, S, S);
      return g.getImageData(0, 0, S, S).data;
    };
    for (let i = 0; i < n; i++) {
      const l = manifest.layers[i];
      const [di, ni] = await Promise.all([this.loadImage(l.diff), this.loadImage(l.nor)]);
      const dp = pixels(di);
      albedo.set(dp, i * S * S * 4);
      normal.set(pixels(ni), i * S * S * 4);
      let r = 0;
      let gg = 0;
      let b = 0;
      for (let k = 0; k < dp.length; k += 16) {
        r += (dp[k] / 255) ** 2.2;
        gg += (dp[k + 1] / 255) ** 2.2;
        b += (dp[k + 2] / 255) ** 2.2;
      }
      const cnt = dp.length / 16;
      avg.push(new THREE.Vector3(r / cnt, gg / cnt, b / cnt));
      scale.push(1 / l.size);
      tick();
    }
    const mk = (data: Uint8Array<ArrayBuffer>, srgb: boolean) => {
      const t = new THREE.DataArrayTexture(data, S, S, n);
      t.format = THREE.RGBAFormat;
      t.type = THREE.UnsignedByteType;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = true;
      t.anisotropy = this.opts.anisotropy;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.needsUpdate = true;
      return t;
    };
    this.atlas = { albedo: mk(albedo, true), normal: mk(normal, false), avg, scale };
  }

  /**
   * Aplica um conjunto PBR a um material padrão. `normalize` divide pela cor
   * média da textura: ela dá o detalhe e a cor final vem do vertex color.
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

/** cor média de uma imagem (amostrada a 32x32), em espaço linear */
function averageColor(img: CanvasImageSource): THREE.Color {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, 32, 32);
  const d = g.getImageData(0, 0, 32, 32).data;
  let r = 0;
  let gg = 0;
  let b = 0;
  for (let i = 0; i < d.length; i += 4) {
    r += Math.pow(d[i] / 255, 2.2);
    gg += Math.pow(d[i + 1] / 255, 2.2);
    b += Math.pow(d[i + 2] / 255, 2.2);
  }
  const n = d.length / 4;
  return new THREE.Color(r / n, gg / n, b / n);
}
