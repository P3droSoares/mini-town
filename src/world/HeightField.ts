import type { Heightmap } from '../data/types';

/**
 * Consulta de altura do terreno (pura, sem Three.js).
 * Se não há heightmap, o mundo é plano (y = 0) — a estrutura continua igual.
 */
export class HeightField {
  private readonly heights: Float32Array | null;
  readonly size: number;
  readonly cell: number;
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;

  constructor(hm: Heightmap | null) {
    if (!hm) {
      this.heights = null;
      this.size = 2;
      this.cell = 1e6;
      this.minX = this.minZ = -1e6;
      this.maxX = this.maxZ = 1e6;
      return;
    }
    this.heights = Float32Array.from(hm.data, (d) => d / 10);
    this.size = hm.size;
    this.cell = hm.cellSize;
    this.minX = hm.minX;
    this.minZ = hm.minZ;
    this.maxX = hm.minX + (hm.size - 1) * hm.cellSize;
    this.maxZ = hm.minZ + (hm.size - 1) * hm.cellSize;
  }

  get isFlat(): boolean {
    return this.heights === null;
  }

  /** altura da grade (i, j) já limitada às bordas */
  at(i: number, j: number): number {
    if (!this.heights) return 0;
    const n = this.size;
    i = i < 0 ? 0 : i >= n ? n - 1 : i;
    j = j < 0 ? 0 : j >= n ? n - 1 : j;
    return this.heights[j * n + i];
  }

  /** altura interpolada no ponto (x, z) — mesma triangulação do mesh do terreno */
  sample(x: number, z: number): number {
    if (!this.heights) return 0;
    const fx = (x - this.minX) / this.cell;
    const fz = (z - this.minZ) / this.cell;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const h00 = this.at(i, j);
    const h10 = this.at(i + 1, j);
    const h01 = this.at(i, j + 1);
    const h11 = this.at(i + 1, j + 1);
    // triangulação igual à PlaneGeometry do Three (diagonal de (i,j+1) a (i+1,j))
    if (u + v <= 1) return h00 + (h10 - h00) * u + (h01 - h00) * v;
    return h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
  }

  /** normal aproximada (para inclinação) */
  slope(x: number, z: number): number {
    const d = this.isFlat ? 1 : this.cell;
    const dx = (this.sample(x + d, z) - this.sample(x - d, z)) / (2 * d);
    const dz = (this.sample(x, z + d) - this.sample(x, z - d)) / (2 * d);
    return Math.hypot(dx, dz);
  }
}
