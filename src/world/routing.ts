import type { Vec2 } from '../data/types';
import type { GraphEdge, GraphNode, RoadGraph } from './RoadGraph';
import { distSqToSegment } from './geo';

/** Ponto mais próximo numa aresta: distância ao longo dela e coordenadas. */
export interface EdgeHit {
  edge: GraphEdge;
  dist: number;
  x: number;
  z: number;
  d2: number;
}

/** Caminho pronto para seguir (polilinha com comprimento acumulado). */
export interface Route {
  points: Vec2[];
  cum: number[];
  length: number;
}

/** trecho da aresta entre as distâncias d0 e d1 (d1 < d0 = sentido contrário) */
function slice(e: GraphEdge, d0: number, d1: number): Vec2[] {
  const at = (d: number): Vec2 => {
    let i = 1;
    while (i < e.cum.length - 1 && e.cum[i] < d) i++;
    const a = e.points[i - 1];
    const b = e.points[i];
    const t = (d - e.cum[i - 1]) / (e.cum[i] - e.cum[i - 1] || 1);
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  const lo = Math.max(0, Math.min(d0, d1));
  const hi = Math.min(e.length, Math.max(d0, d1));
  const out: Vec2[] = [at(lo)];
  for (let i = 0; i < e.points.length; i++) if (e.cum[i] > lo && e.cum[i] < hi) out.push(e.points[i]);
  out.push(at(hi));
  return d1 < d0 ? out.reverse() : out;
}

/** heap binário mínimo (fila de prioridade do A*) */
class Heap<T> {
  private items: { k: number; v: T }[] = [];
  get size() {
    return this.items.length;
  }
  push(k: number, v: T) {
    const a = this.items;
    a.push({ k, v });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].k <= a[i].k) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): { k: number; v: T } {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].k < a[m].k) m = l;
        if (r < a.length && a[r].k < a[m].k) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Rotas de veículo no grafo viário (A*), entre pontos quaisquer: origem e
 * destino são projetados na rua transitável mais próxima. Respeita mão única.
 * Só usa o maior componente conexo (ruas soltas não "prendem" o GPS).
 */
export class Router {
  private readonly edges: GraphEdge[];

  constructor(graph: RoadGraph) {
    // maior componente conexo (ignorando sentido)
    const comp = new Map<GraphNode, number>();
    const sizes: number[] = [];
    const undirected = new Map<GraphNode, GraphNode[]>();
    const link = (a: GraphNode, b: GraphNode) => {
      let l = undirected.get(a);
      if (!l) undirected.set(a, (l = []));
      l.push(b);
    };
    for (const e of graph.edges) {
      if (!e.drivable) continue;
      link(e.from, e.to);
      link(e.to, e.from);
    }
    for (const n of undirected.keys()) {
      if (comp.has(n)) continue;
      const id = sizes.length;
      let size = 0;
      const stack = [n];
      comp.set(n, id);
      while (stack.length) {
        const x = stack.pop()!;
        size++;
        for (const y of undirected.get(x) ?? [])
          if (!comp.has(y)) {
            comp.set(y, id);
            stack.push(y);
          }
      }
      sizes.push(size);
    }
    const main = sizes.indexOf(Math.max(...sizes));
    this.edges = graph.edges.filter((e) => e.drivable && e.length > 0.5 && comp.get(e.from) === main);
  }

  /** ponto de rua transitável mais próximo de (x, z) */
  nearest(x: number, z: number): EdgeHit | null {
    let best: EdgeHit | null = null;
    for (const e of this.edges) {
      // cada mão dupla aparece duas vezes: basta uma
      if (e.reverse && e.reverse.id < e.id) continue;
      const p = e.points;
      for (let i = 1; i < p.length; i++) {
        const r = distSqToSegment(x, z, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]);
        if (!best || r.d2 < best.d2) best = { edge: e, dist: e.cum[i - 1] + r.t * (e.cum[i] - e.cum[i - 1]), x: r.cx, z: r.cz, d2: r.d2 };
      }
    }
    return best;
  }

  /** menor caminho entre dois pontos (null se não há ligação) */
  route(from: Vec2, to: Vec2): Route | null {
    const s = this.nearest(from[0], from[1]);
    const g = this.nearest(to[0], to[1]);
    if (!s || !g) return null;
    const pts = this.search(s, g);
    return pts ? makeRoute(pts) : null;
  }

  private search(s: EdgeHit, g: EdgeHit): Vec2[] | null {
    const E = s.edge;
    const F = g.edge;
    // mesma rua: segue direto se o sentido permitir
    if (E === F && (g.dist >= s.dist || E.reverse)) return slice(E, s.dist, g.dist);

    // saídas da origem (nó, custo, pontos até o nó)
    type Leg = { node: GraphNode; cost: number; pts: Vec2[] };
    const starts: Leg[] = [{ node: E.to, cost: E.length - s.dist, pts: slice(E, s.dist, E.length) }];
    if (E.reverse) starts.push({ node: E.from, cost: s.dist, pts: slice(E, s.dist, 0) });
    // chegadas ao destino (nó, custo restante, pontos do nó ao destino)
    const goals = new Map<GraphNode, Leg>();
    goals.set(F.from, { node: F.from, cost: g.dist, pts: slice(F, 0, g.dist) });
    if (F.reverse) {
      const leg = { node: F.to, cost: F.length - g.dist, pts: slice(F, F.length, g.dist) };
      const cur = goals.get(F.to);
      if (!cur || leg.cost < cur.cost) goals.set(F.to, leg);
    }

    const h = (n: GraphNode) => Math.hypot(n.x - g.x, n.z - g.z);
    const dist = new Map<GraphNode, number>();
    // como chegou em cada nó: por uma aresta ou direto da origem
    const prev = new Map<GraphNode, { edge: GraphEdge } | { leg: Leg }>();
    const open = new Heap<GraphNode>();
    for (const st of starts) {
      if ((dist.get(st.node) ?? Infinity) <= st.cost) continue;
      dist.set(st.node, st.cost);
      prev.set(st.node, { leg: st });
      open.push(st.cost + h(st.node), st.node);
    }
    let best = Infinity;
    let bestGoal: GraphNode | null = null;
    const done = new Set<GraphNode>();
    while (open.size) {
      const { k, v: n } = open.pop();
      if (k >= best) break;
      if (done.has(n)) continue;
      done.add(n);
      const d = dist.get(n)!;
      const goal = goals.get(n);
      if (goal && d + goal.cost < best) {
        best = d + goal.cost;
        bestGoal = n;
      }
      for (const e of n.out) {
        if (!e.drivable || e.length <= 0.5) continue;
        const nd = d + e.length;
        if (nd < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, nd);
          prev.set(e.to, { edge: e });
          open.push(nd + h(e.to), e.to);
        }
      }
    }
    if (!bestGoal) return null;

    // reconstrói: origem -> arestas -> destino
    const chain: Vec2[][] = [goals.get(bestGoal)!.pts];
    let n: GraphNode = bestGoal;
    for (let guard = 0; guard < 100000; guard++) {
      const p = prev.get(n)!;
      if ('leg' in p) {
        chain.push(p.leg.pts);
        break;
      }
      chain.push(p.edge.points);
      n = p.edge.from;
    }
    chain.reverse();
    return chain.flat();
  }
}

/** remove pontos repetidos e calcula o comprimento acumulado */
export function makeRoute(raw: Vec2[]): Route {
  const points: Vec2[] = [];
  for (const p of raw) {
    const q = points[points.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.05) points.push(p);
  }
  if (points.length === 1) points.push([points[0][0] + 0.01, points[0][1]]);
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  return { points, cum, length: cum[cum.length - 1] };
}

/**
 * Acompanha o progresso do jogador ao longo da rota (como um GPS): projeta a
 * posição numa janela em volta do último progresso e mede o desvio.
 */
export class RouteProgress {
  /** metros percorridos ao longo da rota */
  progress = 0;
  /** distância do jogador até a rota */
  offset = 0;

  constructor(readonly route: Route) {}

  get remaining() {
    return Math.max(0, this.route.length - this.progress);
  }

  update(x: number, z: number) {
    const { points, cum } = this.route;
    let bestD2 = Infinity;
    let bestS = this.progress;
    // janela: um pouco para trás (ré) e bem para frente (atalhos)
    const lo = this.progress - 40;
    const hi = this.progress + 120;
    for (let i = 1; i < points.length; i++) {
      if (cum[i] < lo || cum[i - 1] > hi) continue;
      const r = distSqToSegment(x, z, points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
      if (r.d2 < bestD2) {
        bestD2 = r.d2;
        bestS = cum[i - 1] + r.t * (cum[i] - cum[i - 1]);
      }
    }
    this.progress = bestS;
    this.offset = Math.sqrt(bestD2);
  }
}
