import type { Street, Vec2 } from '../data/types';

/**
 * Grafo viário (puro). Nós = nós OSM onde ruas se cruzam ou terminam.
 * Arestas = trechos de polilinha entre dois nós. Usado pelo tráfego NPC
 * e, no futuro, por rotas de entrega/logística da economia.
 */
export interface GraphNode {
  id: number;
  x: number;
  z: number;
  /** arestas que saem deste nó (direcionadas) */
  out: GraphEdge[];
}

export interface GraphEdge {
  id: number;
  from: GraphNode;
  to: GraphNode;
  street: Street;
  points: Vec2[];
  /** comprimento acumulado em cada ponto */
  cum: number[];
  length: number;
  /** aresta oposta (mesma geometria, sentido contrário) se existir */
  reverse?: GraphEdge;
  drivable: boolean;
}

const DRIVABLE = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'residential',
  'unclassified',
  'living_street',
  'service',
]);

export class RoadGraph {
  readonly nodes = new Map<number, GraphNode>();
  readonly edges: GraphEdge[] = [];

  constructor(streets: Street[]) {
    // conta quantas vezes cada nó OSM aparece -> nós de interseção
    const usage = new Map<number, number>();
    for (const s of streets) for (const n of s.nodes) usage.set(n, (usage.get(n) ?? 0) + 1);

    let edgeId = 0;
    for (const s of streets) {
      const drivable = DRIVABLE.has(s.kind);
      let startIdx = 0;
      for (let i = 1; i < s.points.length; i++) {
        const isEnd = i === s.points.length - 1;
        if (!isEnd && (usage.get(s.nodes[i]) ?? 0) < 2) continue;
        const pts = s.points.slice(startIdx, i + 1);
        const a = this.node(s.nodes[startIdx], s.points[startIdx]);
        const b = this.node(s.nodes[i], s.points[i]);
        const fwd = this.makeEdge(edgeId++, a, b, s, pts, drivable);
        if (!s.oneway || !drivable) {
          const back = this.makeEdge(edgeId++, b, a, s, pts.slice().reverse(), drivable);
          fwd.reverse = back;
          back.reverse = fwd;
        }
        startIdx = i;
      }
    }
  }

  private node(id: number, p: Vec2): GraphNode {
    let n = this.nodes.get(id);
    if (!n) {
      n = { id, x: p[0], z: p[1], out: [] };
      this.nodes.set(id, n);
    }
    return n;
  }

  private makeEdge(id: number, from: GraphNode, to: GraphNode, street: Street, points: Vec2[], drivable: boolean): GraphEdge {
    const cum = [0];
    for (let i = 1; i < points.length; i++)
      cum.push(cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
    const e: GraphEdge = { id, from, to, street, points, cum, length: cum[cum.length - 1], drivable };
    from.out.push(e);
    this.edges.push(e);
    return e;
  }

  /** posição e direção a uma distância `d` ao longo da aresta */
  static pointAt(e: GraphEdge, d: number, out: { x: number; z: number; dx: number; dz: number }) {
    const cum = e.cum;
    if (d <= 0) d = 0;
    if (d >= e.length) d = e.length;
    // busca linear curta (arestas têm poucos pontos)
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const a = e.points[i - 1];
    const b = e.points[i];
    const segLen = cum[i] - cum[i - 1] || 1;
    const t = (d - cum[i - 1]) / segLen;
    out.dx = (b[0] - a[0]) / segLen;
    out.dz = (b[1] - a[1]) / segLen;
    out.x = a[0] + (b[0] - a[0]) * t;
    out.z = a[1] + (b[1] - a[1]) * t;
    return out;
  }
}
