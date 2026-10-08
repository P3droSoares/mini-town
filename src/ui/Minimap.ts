import type { Game } from '../core/Game';
import type { Vec2 } from '../data/types';
import type { GpsInfo } from '../systems/DeliverySystem';
import { h } from './dom';
import { MONO } from '../world/render/style';

/** cores do minimapa (no modo monocromático: tons de #2f3246 + amarelo) */
const MM = MONO
  ? { bg: '#2f3246', wood: '#363a52', green: '#3b3f58', water: '#24263a', foot: '#45496a', street: '#6a6f96', building: '#535878', buildingOsm: '#535878', accent: '#ffc04a', view: 'rgba(255, 192, 74, 0.16)' }
  : { bg: '#e9e4d4', wood: '#9cc58a', green: '#b9dba0', water: '#8ec5e3', foot: '#d8cbb0', street: '#ffffff', building: '#d8b7a0', buildingOsm: '#c98f6d', accent: '#c2633a', view: 'rgba(194, 99, 58, 0.18)' };
/** linha do GPS: contorno escuro + cor de destaque */
const ROUTE_EDGE = MONO ? '#1b1d2b' : '#ffffff';

/** largura da janela do GPS aproximado (m) */
const GPS_SPAN = 440;

/**
 * Minimapa 2D: base pré-renderizada uma vez (água, verde, ruas, prédios);
 * por frame só desenha o marcador do jogador/câmera. Clique = ir até lá.
 * Com corrida em andamento vira GPS: rota restante, destino e mapa
 * aproximado girando com a câmera (clique alterna para a cidade inteira).
 */
export class Minimap {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement;
  private readonly px = 360; // resolução interna
  /** base em resolução maior: nítida no zoom do GPS */
  private readonly baseScale = 3;
  private readonly range: number;
  private acc = 0;
  private highlight: Vec2[][] | null = null;
  private highlightUntil = 0;
  private zoom = true;
  onPick: ((x: number, z: number) => void) | null = null;
  /** rota atual (corrida) */
  gps: (() => GpsInfo | null) | null = null;

  constructor(
    parent: HTMLElement,
    private readonly game: Game,
  ) {
    const b = game.world.data.bounds;
    this.range = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 2 + 60;
    this.canvas = h('canvas', { width: String(this.px), height: String(this.px), 'aria-label': 'Minimapa — clique para ir até o local', role: 'img' }) as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    this.el = h('div', { class: 'minimap card' }, this.canvas);
    parent.append(this.el);
    this.base = this.renderBase();
    this.canvas.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      // durante a corrida o clique só alterna o zoom do GPS
      if (this.gps?.()) {
        this.zoom = !this.zoom;
        return;
      }
      const r = this.canvas.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * 2 * this.range - this.range;
      const z = ((e.clientY - r.top) / r.height) * 2 * this.range - this.range;
      this.onPick?.(x, z);
    });
    game.onModeChange.push((m) => this.el.classList.toggle('walk', m === 'walk'));
  }

  private renderBase(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    const size = this.px * this.baseScale;
    c.width = c.height = size;
    const g = c.getContext('2d')!;
    const d = this.game.world.data;
    const s = size / (2 * this.range);
    const toB = (x: number, z: number): [number, number] => [(x + this.range) * s, (z + this.range) * s];
    g.fillStyle = MM.bg;
    g.fillRect(0, 0, size, size);
    const poly = (ring: Vec2[], fill: string) => {
      g.beginPath();
      ring.forEach(([x, z], i) => {
        const [px, pz] = toB(x, z);
        if (i) g.lineTo(px, pz);
        else g.moveTo(px, pz);
      });
      g.closePath();
      g.fillStyle = fill;
      g.fill();
    };
    const line = (pts: Vec2[], width: number, color: string) => {
      g.beginPath();
      pts.forEach(([x, z], i) => {
        const [px, pz] = toB(x, z);
        if (i) g.lineTo(px, pz);
        else g.moveTo(px, pz);
      });
      g.strokeStyle = color;
      g.lineWidth = width;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.stroke();
    };
    const k = this.baseScale;
    for (const gr of d.greens) poly(gr.outer, gr.kind === 'wood' ? MM.wood : MM.green);
    for (const w of d.waterAreas) poly(w.outer, MM.water);
    for (const w of d.waterLines) line(w.points, Math.max(1.5 * k, w.width * s), MM.water);
    for (const st of d.streets) {
      const foot = ['footway', 'path', 'steps', 'cycleway', 'track'].includes(st.kind);
      line(st.points, Math.max((foot ? 0.6 : 1.2) * k, st.width * s * 1.1), foot ? MM.foot : MM.street);
    }
    for (const b of d.buildings) poly(b.outer, b.generated ? MM.building : MM.buildingOsm);
    return c;
  }

  /** destaca polilinhas (ex.: rua buscada) por alguns segundos */
  flash(lines: Vec2[][]) {
    this.highlight = lines;
    this.highlightUntil = performance.now() + 8000;
  }

  update(dt: number) {
    this.acc += dt;
    if (this.acc < 1 / 20) return; // 20 Hz basta
    this.acc = 0;
    const g = this.ctx;
    const game = this.game;
    const gps = this.gps?.() ?? null;
    this.el.classList.toggle('gps', !!gps);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.imageSmoothingQuality = 'high';
    const f = game.focus;
    const cam = game.camera.position;
    if (gps && this.zoom && game.mode === 'walk') return this.drawGps(gps);

    g.drawImage(this.base, 0, 0, this.px, this.px);
    const s = this.px / (2 * this.range);
    if (this.highlight && performance.now() < this.highlightUntil) {
      g.save();
      g.scale(s, s);
      g.translate(this.range, this.range);
      g.strokeStyle = MM.accent;
      g.lineWidth = 4 / s;
      g.lineCap = 'round';
      for (const l of this.highlight) {
        g.beginPath();
        l.forEach(([x, z], i) => (i ? g.lineTo(x, z) : g.moveTo(x, z)));
        g.stroke();
      }
      g.restore();
    }
    if (gps) {
      g.save();
      g.scale(s, s);
      g.translate(this.range, this.range);
      this.drawRoute(gps, 1 / s);
      g.restore();
      this.drawTarget(...this.toPx(gps.target[0], gps.target[1]), gps);
    }
    const [px, pz] = this.toPx(f.x, f.z);
    this.drawPlayer(px, pz, Math.atan2(f.x - cam.x, f.z - cam.z), game.mode === 'walk' ? 40 : 60);
  }

  private toPx(x: number, z: number): [number, number] {
    const s = this.px / (2 * this.range);
    return [(x + this.range) * s, (z + this.range) * s];
  }

  /** GPS aproximado: centrado no jogador, "para cima" = para onde a câmera olha */
  private drawGps(gps: GpsInfo) {
    const g = this.ctx;
    const game = this.game;
    const f = game.focus;
    const cam = game.camera.position;
    const half = this.px / 2;
    const k = this.px / GPS_SPAN;
    const rot = -Math.PI / 2 - Math.atan2(f.z - cam.z, f.x - cam.x);
    g.fillStyle = MM.bg;
    g.fillRect(0, 0, this.px, this.px);
    g.save();
    g.translate(half, half);
    g.rotate(rot);
    g.scale(k, k);
    g.translate(-f.x, -f.z);
    g.drawImage(this.base, -this.range, -this.range, 2 * this.range, 2 * this.range);
    this.drawRoute(gps, 1 / k);
    g.restore();
    // mundo -> tela com a mesma transformação
    const c = Math.cos(rot);
    const sn = Math.sin(rot);
    const toScreen = (x: number, z: number): [number, number] => {
      const dx = (x - f.x) * k;
      const dz = (z - f.z) * k;
      return [half + dx * c - dz * sn, half + dx * sn + dz * c];
    };
    // norte
    const [nx, nz] = toScreen(f.x, f.z - 1e6);
    const na = Math.atan2(nz - half, nx - half);
    g.font = 'bold 22px Nunito, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = MONO ? '#c9cbe0' : '#6b767c';
    g.fillText('N', half + Math.cos(na) * (half - 18), half + Math.sin(na) * (half - 18));
    // destino (preso à borda quando fora da janela)
    const [tx, tz] = toScreen(gps.target[0], gps.target[1]);
    const m = 16;
    this.drawTarget(Math.min(this.px - m, Math.max(m, tx)), Math.min(this.px - m, Math.max(m, tz)), gps);
    // jogador: rumo relativo à câmera
    const hd = game.player.state.heading;
    const vx = Math.sin(hd) * c - Math.cos(hd) * sn;
    const vz = Math.sin(hd) * sn + Math.cos(hd) * c;
    this.drawPlayer(half, half, Math.atan2(vx, vz), 46, Math.PI);
  }

  /** rota restante (a partir do progresso), em coordenadas do mundo */
  private drawRoute(gps: GpsInfo, unit: number) {
    const r = gps.route;
    if (!r) return;
    const g = this.ctx;
    let i = 1;
    while (i < r.cum.length - 1 && r.cum[i] < gps.progress) i++;
    const a = r.points[i - 1];
    const b = r.points[i];
    const t = Math.min(1, Math.max(0, (gps.progress - r.cum[i - 1]) / (r.cum[i] - r.cum[i - 1] || 1)));
    g.beginPath();
    g.moveTo(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
    for (let k = i; k < r.points.length; k++) g.lineTo(r.points[k][0], r.points[k][1]);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = ROUTE_EDGE;
    g.lineWidth = 9 * unit;
    g.stroke();
    g.strokeStyle = MM.accent;
    g.lineWidth = 5 * unit;
    g.stroke();
  }

  /** destino: restaurante (quadrado) ou cliente (círculo) */
  private drawTarget(x: number, y: number, gps: GpsInfo) {
    const g = this.ctx;
    g.fillStyle = MM.accent;
    g.strokeStyle = ROUTE_EDGE;
    g.lineWidth = 3;
    g.beginPath();
    if (gps.phase === 'pickup') g.rect(x - 9, y - 9, 18, 18);
    else g.arc(x, y, 10, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.fillStyle = ROUTE_EDGE;
    g.beginPath();
    g.arc(x, y, 3.5, 0, Math.PI * 2);
    g.fill();
  }

  /** seta do jogador/câmera com cone de visão */
  private drawPlayer(x: number, y: number, ang: number, cone: number, coneAng?: number) {
    const g = this.ctx;
    g.save();
    g.translate(x, y);
    // cone de visão (no GPS aponta sempre para cima)
    g.save();
    g.rotate(coneAng ?? -ang);
    g.fillStyle = MM.view;
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, cone, Math.PI / 2 - 0.5, Math.PI / 2 + 0.5);
    g.closePath();
    g.fill();
    g.restore();
    // seta
    g.rotate(-ang);
    g.fillStyle = MM.accent;
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, 9);
    g.lineTo(6, -6);
    g.lineTo(0, -2);
    g.lineTo(-6, -6);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }
}
