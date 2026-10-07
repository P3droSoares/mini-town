import type { Game } from '../core/Game';
import type { Vec2 } from '../data/types';
import { h } from './dom';
import { MONO } from '../world/render/style';

/** cores do minimapa (no modo monocromático: tons de #2f3246 + amarelo) */
const MM = MONO
  ? { bg: '#2f3246', wood: '#363a52', green: '#3b3f58', water: '#24263a', foot: '#45496a', street: '#6a6f96', building: '#535878', buildingOsm: '#535878', accent: '#ffc04a', view: 'rgba(255, 192, 74, 0.16)' }
  : { bg: '#e9e4d4', wood: '#9cc58a', green: '#b9dba0', water: '#8ec5e3', foot: '#d8cbb0', street: '#ffffff', building: '#d8b7a0', buildingOsm: '#c98f6d', accent: '#c2633a', view: 'rgba(194, 99, 58, 0.18)' };

/**
 * Minimapa 2D: base pré-renderizada uma vez (água, verde, ruas, prédios);
 * por frame só desenha o marcador do jogador/câmera. Clique = ir até lá.
 */
export class Minimap {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement;
  private readonly px = 360; // resolução interna
  private readonly range: number;
  private acc = 0;
  private highlight: Vec2[][] | null = null;
  private highlightUntil = 0;
  onPick: ((x: number, z: number) => void) | null = null;

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
      const r = this.canvas.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * 2 * this.range - this.range;
      const z = ((e.clientY - r.top) / r.height) * 2 * this.range - this.range;
      this.onPick?.(x, z);
    });
    game.onModeChange.push((m) => this.el.classList.toggle('walk', m === 'walk'));
  }

  private toPx(x: number, z: number): [number, number] {
    const s = this.px / (2 * this.range);
    return [(x + this.range) * s, (z + this.range) * s];
  }

  private renderBase(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = c.height = this.px;
    const g = c.getContext('2d')!;
    const d = this.game.world.data;
    g.fillStyle = MM.bg;
    g.fillRect(0, 0, this.px, this.px);
    const poly = (ring: Vec2[], fill: string) => {
      g.beginPath();
      ring.forEach(([x, z], i) => {
        const [px, pz] = this.toPx(x, z);
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
        const [px, pz] = this.toPx(x, z);
        if (i) g.lineTo(px, pz);
        else g.moveTo(px, pz);
      });
      g.strokeStyle = color;
      g.lineWidth = width;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.stroke();
    };
    const s = this.px / (2 * this.range);
    for (const gr of d.greens) poly(gr.outer, gr.kind === 'wood' ? MM.wood : MM.green);
    for (const w of d.waterAreas) poly(w.outer, MM.water);
    for (const w of d.waterLines) line(w.points, Math.max(1.5, w.width * s), MM.water);
    for (const st of d.streets) {
      const foot = ['footway', 'path', 'steps', 'cycleway', 'track'].includes(st.kind);
      line(st.points, Math.max(foot ? 0.6 : 1.2, st.width * s * 1.1), foot ? MM.foot : MM.street);
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
    g.drawImage(this.base, 0, 0);
    if (this.highlight && performance.now() < this.highlightUntil) {
      g.strokeStyle = MM.accent;
      g.lineWidth = 4;
      g.lineCap = 'round';
      for (const l of this.highlight) {
        g.beginPath();
        l.forEach(([x, z], i) => {
          const [px, pz] = this.toPx(x, z);
          if (i) g.lineTo(px, pz);
          else g.moveTo(px, pz);
        });
        g.stroke();
      }
    }
    const game = this.game;
    const f = game.focus;
    const [px, pz] = this.toPx(f.x, f.z);
    // direção da câmera
    const cam = game.camera.position;
    const ang = Math.atan2(f.x - cam.x, f.z - cam.z);
    g.save();
    g.translate(px, pz);
    g.rotate(-ang);
    // cone de visão
    g.fillStyle = MM.view;
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, game.mode === 'walk' ? 40 : 60, Math.PI / 2 - 0.5, Math.PI / 2 + 0.5);
    g.closePath();
    g.fill();
    // seta
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
