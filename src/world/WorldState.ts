import type { Building, CityData, Lot, Street, Vec2 } from '../data/types';
import { HeightField } from './HeightField';
import { RoadGraph } from './RoadGraph';
import { LocalProjection, distSqToSegment, normalizeText, pointInPolygon, polylineLength, ringBounds } from './geo';

export interface StreetGroup {
  name: string;
  key: string;
  streets: Street[];
  /** ponto central aproximado (para "voar até a rua") */
  center: Vec2;
  length: number;
}

/**
 * Estado do mundo, separado da renderização.
 *
 * Contém apenas dados e índices de consulta. Hoje vem do JSON estático;
 * no jogo multiplayer virá do servidor com o mesmo formato (`CityData`).
 */
export class WorldState {
  readonly data: CityData;
  readonly height: HeightField;
  readonly graph: RoadGraph;
  readonly projection: LocalProjection;
  readonly buildingsById = new Map<string, Building>();
  readonly lotsById = new Map<string, Lot>();
  readonly streetGroups: StreetGroup[];

  /** grade espacial de prédios para colisão/consulta rápida */
  private readonly gridCell = 20;
  private readonly grid = new Map<number, Building[]>();

  constructor(data: CityData) {
    this.data = data;
    this.height = new HeightField(data.heightmap);
    this.graph = new RoadGraph(data.streets);
    this.projection = new LocalProjection(data.origin.lat, data.origin.lon);

    for (const b of data.buildings) {
      this.buildingsById.set(b.id, b);
      const r = ringBounds(b.outer);
      for (let gx = Math.floor(r.minX / this.gridCell); gx <= Math.floor(r.maxX / this.gridCell); gx++)
        for (let gz = Math.floor(r.minZ / this.gridCell); gz <= Math.floor(r.maxZ / this.gridCell); gz++) {
          const k = this.key(gx, gz);
          let arr = this.grid.get(k);
          if (!arr) this.grid.set(k, (arr = []));
          arr.push(b);
        }
    }
    for (const l of data.lots) this.lotsById.set(l.lotId, l);

    const groups = new Map<string, StreetGroup>();
    for (const s of data.streets) {
      if (!s.name) continue;
      const key = normalizeText(s.name);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { name: s.name, key, streets: [], center: [0, 0], length: 0 }));
      g.streets.push(s);
    }
    for (const g of groups.values()) {
      // centro = ponto médio da polilinha mais longa
      let best = g.streets[0];
      let bestLen = 0;
      for (const s of g.streets) {
        const l = polylineLength(s.points);
        g.length += l;
        if (l > bestLen) {
          bestLen = l;
          best = s;
        }
      }
      g.center = best.points[Math.floor(best.points.length / 2)];
    }
    this.streetGroups = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }

  /** grade de segmentos de vias de veículos (fachadas frontais, spawn...) */
  private segGrid: Map<number, { ax: number; az: number; bx: number; bz: number; hw: number }[]> | null = null;
  private readonly segCell = 25;

  /** distância (m) do ponto até a borda da via de veículos mais próxima (≤ maxR) */
  distanceToStreet(x: number, z: number, maxR = 40): number {
    if (!this.segGrid) {
      this.segGrid = new Map();
      const c = this.segCell;
      for (const s of this.data.streets) {
        if (['footway', 'path', 'steps', 'cycleway', 'track'].includes(s.kind)) continue;
        for (let i = 0; i < s.points.length - 1; i++) {
          const [ax, az] = s.points[i];
          const [bx, bz] = s.points[i + 1];
          const seg = { ax, az, bx, bz, hw: s.width / 2 };
          for (let gx = Math.floor(Math.min(ax, bx) / c); gx <= Math.floor(Math.max(ax, bx) / c); gx++)
            for (let gz = Math.floor(Math.min(az, bz) / c); gz <= Math.floor(Math.max(az, bz) / c); gz++) {
              const k = this.key(gx, gz);
              let arr = this.segGrid.get(k);
              if (!arr) this.segGrid.set(k, (arr = []));
              arr.push(seg);
            }
        }
      }
    }
    const c = this.segCell;
    let best = maxR;
    const r = Math.ceil(maxR / c);
    const gx0 = Math.floor(x / c);
    const gz0 = Math.floor(z / c);
    for (let gx = gx0 - r; gx <= gx0 + r; gx++)
      for (let gz = gz0 - r; gz <= gz0 + r; gz++)
        for (const s of this.segGrid.get(this.key(gx, gz)) ?? []) {
          const { d2 } = distSqToSegment(x, z, s.ax, s.az, s.bx, s.bz);
          const d = Math.sqrt(d2) - s.hw;
          if (d < best) best = d;
        }
    return Math.max(0, best);
  }

  private key(gx: number, gz: number) {
    return (gx + 32768) * 65536 + (gz + 32768);
  }

  /** prédios cujo bbox toca a célula do ponto (x, z) e vizinhas no raio */
  buildingsNear(x: number, z: number, radius: number): Building[] {
    const out = new Set<Building>();
    const c = this.gridCell;
    for (let gx = Math.floor((x - radius) / c); gx <= Math.floor((x + radius) / c); gx++)
      for (let gz = Math.floor((z - radius) / c); gz <= Math.floor((z + radius) / c); gz++)
        for (const b of this.grid.get(this.key(gx, gz)) ?? []) out.add(b);
    return [...out];
  }

  /** terrenos vagos reservados (sem construção) */
  get vacantLots(): Lot[] {
    return (this._vacant ??= this.data.lots.filter((l) => l.vacant && l.outer));
  }
  private _vacant: Lot[] | null = null;

  vacantLotAt(x: number, z: number): Lot | undefined {
    return this.vacantLots.find((l) => pointInPolygon(x, z, l.outer!));
  }

  buildingAt(x: number, z: number): Building | undefined {
    return this.buildingsNear(x, z, 0).find((b) => pointInPolygon(x, z, b.outer, b.holes));
  }

  lotOf(b: Building): Lot | undefined {
    return this.lotsById.get(b.lotId);
  }

  searchStreets(query: string, limit = 8): StreetGroup[] {
    const q = normalizeText(query);
    if (!q) return [];
    const starts: StreetGroup[] = [];
    const contains: StreetGroup[] = [];
    for (const g of this.streetGroups) {
      if (g.key.startsWith(q) || g.key.split(' ').some((w) => w.startsWith(q))) starts.push(g);
      else if (g.key.includes(q)) contains.push(g);
    }
    return [...starts, ...contains].slice(0, limit);
  }

  isInsideBounds(x: number, z: number, margin = 0): boolean {
    const b = this.data.bounds;
    return x >= b.minX - margin && x <= b.maxX + margin && z >= b.minZ - margin && z <= b.maxZ + margin;
  }
}
