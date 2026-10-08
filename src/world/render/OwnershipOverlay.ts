import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { WorldState } from '../WorldState';
import { ownershipUniforms } from './materials';
import { MONO_LIGHT } from './style';

const FLAG_MINE = 255;
const FLAG_LISTED = 96;
const TEX_W = 256;

/**
 * Destaque dos imóveis do jogador no 3D sem material por prédio:
 *  - prédios: textura R8 (1 texel por prédio) lida pelo shader dos prédios
 *    via atributo `bidx` — atualizar = reenviar ~4 KB, nenhum draw call extra
 *  - terrenos vagos: contorno TRACEJADO (meu = grosso; à venda = fino), para
 *    não confundir com a seleção (linha cheia)
 * Só refaz o que mudou; `setEnabled(false)` desliga tudo (legenda do minimapa).
 */
export class OwnershipOverlay {
  /** grupo com as linhas dos terrenos (adicionado à cena) */
  readonly lines = new THREE.Group();
  private readonly mineLines: LineSegments2;
  private readonly listedLines: LineSegments2;
  private readonly data: Uint8Array<ArrayBuffer>;
  private readonly texture: THREE.DataTexture;
  /** lotId -> índices dos prédios (normalmente 1) */
  private readonly lotBuildings = new Map<string, number[]>();
  private enabled = true;
  private any = false;
  private lastMine = '';
  private lastListed = '';

  constructor(private readonly world: WorldState) {
    const n = Math.max(1, world.data.buildings.length);
    const h = Math.ceil(n / TEX_W);
    this.data = new Uint8Array(TEX_W * h);
    this.texture = new THREE.DataTexture(this.data, TEX_W, h, THREE.RedFormat, THREE.UnsignedByteType);
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
    ownershipUniforms.uOwnFlags.value = this.texture;
    ownershipUniforms.uOwnWidth.value = TEX_W;
    ownershipUniforms.uOwnAny.value = 0;
    world.data.buildings.forEach((b, i) => {
      const arr = this.lotBuildings.get(b.lotId);
      if (arr) arr.push(i);
      else this.lotBuildings.set(b.lotId, [i]);
    });

    this.mineLines = this.makeLines(3, 0.95, 1.6, 0.9);
    this.listedLines = this.makeLines(1.5, 0.7, 0.8, 1.2);
    this.lines.name = 'ownership-lots';
    this.lines.add(this.mineLines, this.listedLines);
  }

  private makeLines(width: number, opacity: number, dash: number, gap: number): LineSegments2 {
    const mat = new LineMaterial({ color: MONO_LIGHT, linewidth: width, transparent: true, opacity, dashed: true, dashSize: dash, gapSize: gap });
    mat.resolution.set(window.innerWidth, window.innerHeight);
    const l = new LineSegments2(new LineSegmentsGeometry(), mat);
    l.renderOrder = 3;
    l.visible = false;
    return l;
  }

  resize(w: number, h: number) {
    for (const l of [this.mineLines, this.listedLines]) (l.material as LineMaterial).resolution.set(w, h);
  }

  /** liga/desliga o destaque (prédios e terrenos) */
  setEnabled(on: boolean) {
    this.enabled = on;
    this.lines.visible = on;
    ownershipUniforms.uOwnAny.value = on && this.any ? 1 : 0;
  }

  /** aplica o mapa de donos (meus têm prioridade sobre "à venda") */
  set(mine: Iterable<string>, listed: Iterable<string>) {
    this.data.fill(0);
    let count = 0;
    const mark = (lotId: string, v: number) => {
      for (const i of this.lotBuildings.get(lotId) ?? []) {
        this.data[i] = Math.max(this.data[i], v);
        count++;
      }
    };
    const mineSet = new Set(mine);
    const listedSet = new Set(listed);
    for (const id of listedSet) mark(id, FLAG_LISTED);
    for (const id of mineSet) mark(id, FLAG_MINE);
    this.texture.needsUpdate = true;
    this.any = count > 0;
    ownershipUniforms.uOwnAny.value = this.enabled && this.any ? 1 : 0;
    // terrenos vagos: refaz as linhas só se o conjunto mudou
    const vacant = (ids: Set<string>, skip?: Set<string>) => [...ids].filter((id) => !this.lotBuildings.has(id) && !skip?.has(id)).sort();
    const mineLots = vacant(mineSet);
    const listedLots = vacant(listedSet, mineSet);
    const km = mineLots.join(',');
    const kl = listedLots.join(',');
    if (km !== this.lastMine) {
      this.lastMine = km;
      this.updateLots(this.mineLines, mineLots);
    }
    if (kl !== this.lastListed) {
      this.lastListed = kl;
      this.updateLots(this.listedLines, listedLots);
    }
  }

  /** contorno dos terrenos, rente ao relevo */
  private updateLots(lines: LineSegments2, ids: string[]) {
    const hf = this.world.height;
    const pos: number[] = [];
    for (const id of ids) {
      const ring = this.world.lotsById.get(id)?.outer;
      if (!ring) continue;
      for (let i = 0; i < ring.length; i++) {
        const [ax, az] = ring[i];
        const [bx, bz] = ring[(i + 1) % ring.length];
        pos.push(ax, hf.sample(ax, az) + 0.4, az, bx, hf.sample(bx, bz) + 0.4, bz);
      }
    }
    lines.geometry.dispose();
    const g = new LineSegmentsGeometry();
    if (pos.length) g.setPositions(pos);
    lines.geometry = g;
    if (pos.length) lines.computeLineDistances();
    lines.visible = pos.length > 0;
  }
}
