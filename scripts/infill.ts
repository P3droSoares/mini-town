/**
 * Preenchimento procedural de quadras.
 *
 * O OSM de cidades pequenas costuma ter poucos prédios mapeados. Para a
 * cidade não parecer vazia, geramos casas/lojas retangulares ao longo das
 * ruas, recuadas da calçada, evitando ruas, rios, praças e prédios reais.
 *
 * Tudo é determinístico (seed = id OSM da rua), então os lotes gerados têm
 * ids estáveis entre execuções com os mesmos dados de entrada.
 */
import type { GreenArea, LandUse, LandUseKind, Ring, Street, Vec2, WaterArea, WaterLine } from '../src/data/types';
import { distSqToSegment, hashId, mulberry32, pointInPolygon, ringBounds } from '../src/world/geo';

export interface GeneratedHouse {
  id: string;
  lotId: string;
  streetName?: string;
  outer: Ring;
  levels: number;
  type: string;
  /** terreno vago reservado (sem construção) */
  vacant?: boolean;
  /** polígono do lote (casa + quintal); ausente = lote igual ao prédio */
  lotOuter?: Ring;
}

interface Obstacle {
  ring: Ring;
  bounds: ReturnType<typeof ringBounds>;
}

const INFILL_KINDS = new Set(['residential', 'tertiary', 'secondary', 'primary', 'unclassified', 'living_street']);
const SIDEWALK = 1.6;

class SpatialHash<T> {
  private cells = new Map<number, T[]>();
  constructor(private cell: number) {}
  private key(gx: number, gz: number) {
    return (gx + 32768) * 65536 + (gz + 32768);
  }
  insert(item: T, minX: number, minZ: number, maxX: number, maxZ: number) {
    const c = this.cell;
    for (let gx = Math.floor(minX / c); gx <= Math.floor(maxX / c); gx++)
      for (let gz = Math.floor(minZ / c); gz <= Math.floor(maxZ / c); gz++) {
        const k = this.key(gx, gz);
        let arr = this.cells.get(k);
        if (!arr) this.cells.set(k, (arr = []));
        arr.push(item);
      }
  }
  query(minX: number, minZ: number, maxX: number, maxZ: number): Set<T> {
    const out = new Set<T>();
    const c = this.cell;
    for (let gx = Math.floor(minX / c); gx <= Math.floor(maxX / c); gx++)
      for (let gz = Math.floor(minZ / c); gz <= Math.floor(maxZ / c); gz++)
        for (const it of this.cells.get(this.key(gx, gz)) ?? []) out.add(it);
    return out;
  }
}

function segIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function polysOverlap(a: Ring, b: Ring): boolean {
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++)
      if (segIntersect(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
  return pointInPolygon(a[0][0], a[0][1], b) || pointInPolygon(b[0][0], b[0][1], a);
}

export function generateInfill(opts: {
  streets: Street[];
  buildings: Ring[];
  waterLines: WaterLine[];
  waterAreas: WaterArea[];
  greens: GreenArea[];
  half: number;
  /** área central com mais comércio e prédios mais altos */
  downtownRadius: number;
  /** zonas de uso do solo (industrial gera galpões maiores) */
  landuse: LandUse[];
}): GeneratedHouse[] {
  const { streets, half } = opts;
  const zoneAt = (x: number, z: number): LandUseKind | undefined => opts.landuse.find((l) => pointInPolygon(x, z, l.outer, l.holes))?.kind;

  // obstáculos poligonais (prédios reais, água, praças) e linhas (ruas, rios)
  const polys = new SpatialHash<Obstacle>(25);
  const addPoly = (ring: Ring) => {
    const b = ringBounds(ring);
    polys.insert({ ring, bounds: b }, b.minX, b.minZ, b.maxX, b.maxZ);
  };
  opts.buildings.forEach(addPoly);
  opts.waterAreas.forEach((w) => addPoly(w.outer));
  opts.greens.filter((g) => g.kind !== 'grass' && g.kind !== 'scrub' && g.kind !== 'meadow').forEach((g) => addPoly(g.outer));

  interface Line {
    a: Vec2;
    b: Vec2;
    clearance: number;
  }
  const lines = new SpatialHash<Line>(25);
  const addLine = (pts: Vec2[], clearance: number) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      lines.insert(
        { a, b, clearance },
        Math.min(a[0], b[0]) - clearance,
        Math.min(a[1], b[1]) - clearance,
        Math.max(a[0], b[0]) + clearance,
        Math.max(a[1], b[1]) + clearance,
      );
    }
  };
  for (const s of streets) {
    const footish = ['footway', 'path', 'steps', 'cycleway'].includes(s.kind);
    addLine(s.points, s.width / 2 + (footish ? 0.6 : SIDEWALK + 0.4));
  }
  for (const w of opts.waterLines) addLine(w.points, w.width / 2 + 5);

  const clearOfLines = (ring: Ring): boolean => {
    const b = ringBounds(ring);
    const cand = lines.query(b.minX - 15, b.minZ - 15, b.maxX + 15, b.maxZ + 15);
    // amostra cantos, meios das arestas e centro
    const samples: Vec2[] = [...ring];
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      samples.push([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
    }
    samples.push([(b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2]);
    for (const l of cand) {
      const c2 = l.clearance * l.clearance;
      for (const s of samples) if (distSqToSegment(s[0], s[1], l.a[0], l.a[1], l.b[0], l.b[1]).d2 < c2) return false;
      // linha atravessando o retângulo
      for (let i = 0; i < ring.length; i++) if (segIntersect(ring[i], ring[(i + 1) % ring.length], l.a, l.b)) return false;
    }
    return true;
  };
  const clearOfPolys = (ring: Ring): boolean => {
    const b = ringBounds(ring);
    for (const o of polys.query(b.minX, b.minZ, b.maxX, b.maxZ)) {
      if (o.bounds.maxX < b.minX || o.bounds.minX > b.maxX || o.bounds.maxZ < b.minZ || o.bounds.minZ > b.maxZ) continue;
      if (polysOverlap(ring, o.ring)) return false;
    }
    return true;
  };

  const out: GeneratedHouse[] = [];
  // ruas maiores primeiro: ganham as fachadas de esquina
  const ordered = streets
    .filter((s) => INFILL_KINDS.has(s.kind))
    .slice()
    .sort((a, b) => b.width - a.width || a.osmId - b.osmId);

  for (const s of ordered) {
    const rng = mulberry32(hashId(s.osmId) ^ 0x9e3779b9);
    for (const side of [1, -1] as const) {
      let idx = 0;
      for (let i = 0; i < s.points.length - 1; i++) {
        const [ax, az] = s.points[i];
        const [bx, bz] = s.points[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 6) continue;
        const ux = (bx - ax) / len;
        const uz = (bz - az) / len;
        // normal à direita (side=1) ou esquerda (side=-1)
        const nx = -uz * side;
        const nz = ux * side;
        let t = 2 + rng() * 2;
        while (t < len - 4) {
          // zona do ponto da fachada (aproximada pelo eixo da rua)
          const zone = zoneAt(ax + ux * t - uz * side * 12, az + uz * t + ux * side * 12);
          // galpões/oficinas: zona industrial ou vias principais na periferia
          const farOut = Math.hypot(ax, az) > 520;
          const industrial = zone === 'industrial' || (farOut && ['primary', 'trunk', 'secondary'].includes(s.kind) && zone !== 'residential' && rng() < 0.35);
          const front = industrial ? 14 + rng() * 14 : 7 + rng() * 6;
          const depth = industrial ? 16 + rng() * 16 : 9 + rng() * 9;
          const gap = 0.4 + rng() * 1.2;
          const w = Math.min(front, len - t - 1);
          if (w < 5.5) break;
          const setback = s.width / 2 + SIDEWALK + 0.6 + (rng() < 0.3 ? rng() * 3 : 0);
          const cx = ax + ux * (t + w / 2);
          const cz = az + uz * (t + w / 2);
          const fx = cx + nx * setback;
          const fz = cz + nz * setback;
          const hw = w / 2 - gap / 2;
          const p = (a: number, d: number): Vec2 => [
            Math.round((fx + ux * a + nx * d) * 10) / 10,
            Math.round((fz + uz * a + nz * d) * 10) / 10,
          ];
          let ring: Ring = [p(-hw, 0), p(hw, 0), p(hw, depth), p(-hw, depth)];
          // garante orientação positiva
          const area2 = ring.reduce((acc, q, k) => {
            const r = ring[(k + 1) % 4];
            return acc + q[0] * r[1] - r[0] * q[1];
          }, 0);
          if (area2 < 0) ring = ring.reverse();

          const inBounds = ring.every(([x, z]) => Math.abs(x) < half - 2 && Math.abs(z) < half - 2);
          let ok = inBounds && clearOfLines(ring) && clearOfPolys(ring);
          if (!ok && inBounds) {
            // tenta uma casa mais rasa antes de desistir
            ring = [p(-hw, 0), p(hw, 0), p(hw, depth * 0.6), p(-hw, depth * 0.6)];
            if (area2 < 0) ring = ring.reverse();
            ok = depth * 0.6 > 6 && clearOfLines(ring) && clearOfPolys(ring);
          }
          // quintal nos fundos (casas): lote mais fundo que a construção
          let lotRing: Ring | undefined;
          const houseLike = !industrial && !(Math.hypot(fx, fz) < opts.downtownRadius && s.width >= 7);
          if (ok && houseLike) {
            const yard = 4 + rng() * 9;
            const curDepth = Math.max(...ring.map(([x, z]) => (x - fx) * nx + (z - fz) * nz));
            let lr: Ring = [p(-hw - gap / 2, 0), p(hw + gap / 2, 0), p(hw + gap / 2, curDepth + yard), p(-hw - gap / 2, curDepth + yard)];
            if (area2 < 0) lr = lr.reverse();
            if (lr.every(([x, z]) => Math.abs(x) < half - 2 && Math.abs(z) < half - 2) && clearOfLines(lr) && clearOfPolys(lr)) lotRing = lr;
          }
          if (ok) {
            const dist = Math.hypot(fx, fz);
            const downtown = dist < opts.downtownRadius;
            const major = s.width >= 7;
            const r = rng();
            let levels = r < 0.6 ? 1 : r < 0.9 ? 2 : 3;
            if (downtown && major) levels = r < 0.3 ? 2 : r < 0.75 ? 3 : 4;
            else if (downtown || major) levels = r < 0.4 ? 1 : r < 0.85 ? 2 : 3;
            const commercial = zone === 'commercial' || zone === 'retail' || (downtown && major && rng() < 0.7) || (major && rng() < 0.25);
            // terrenos vagos reservados (futuro mercado imobiliário)
            const vacant = !industrial && rng() < 0.07;
            // prédios de apartamentos (estilo maquete) no centro
            const tower = !industrial && !vacant && downtown && rng() < (major ? 0.12 : 0.05);
            if (industrial) levels = r < 0.75 ? 1 : 2;
            if (tower) levels = 5 + Math.floor(rng() * 6);
            const type = vacant ? 'vacant' : industrial ? 'industrial' : tower ? 'apartments' : commercial ? 'commercial' : 'house';
            const sideTag = side === 1 ? 'D' : 'E';
            out.push({
              id: `gen/${s.id}/${sideTag}${idx}`,
              lotId: `ITB-G${s.id.replace('way/', '').replace('#', '-')}-${sideTag}${idx}`,
              streetName: s.name,
              outer: ring,
              levels: vacant ? 0 : levels,
              type,
              ...(vacant ? { vacant: true } : {}),
              ...(lotRing ? { lotOuter: lotRing } : {}),
            });
            const occupied = lotRing ?? ring;
            const rb = ringBounds(occupied);
            polys.insert({ ring: occupied, bounds: rb }, rb.minX, rb.minZ, rb.maxX, rb.maxZ);
            idx++;
          }
          t += w;
        }
      }
    }
  }
  return out;
}
