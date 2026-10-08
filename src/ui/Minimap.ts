import type { Game } from '../core/Game';
import type { Ring, Vec2 } from '../data/types';
import { ICONS, h, svgIcon } from './dom';
import { MONO } from '../world/render/style';

/**
 * Cores do minimapa (no modo monocromático: tons de #2f3246 + amarelo).
 * Uma forma por significado: jogador = seta clara com contorno amarelo;
 * meu = quadrado amarelo cheio; à venda = anel amarelo vazado.
 */
const MM = MONO
  ? { bg: '#2f3246', wood: '#363a52', green: '#3b3f58', water: '#24263a', foot: '#45496a', street: '#6a6f96', building: '#535878', buildingOsm: '#535878', accent: '#ffc04a', me: '#e6e7f0', view: 'rgba(230, 231, 240, 0.14)', ink: '#1b1d2a' }
  : { bg: '#e9e4d4', wood: '#9cc58a', green: '#b9dba0', water: '#8ec5e3', foot: '#d8cbb0', street: '#ffffff', building: '#d8b7a0', buildingOsm: '#c98f6d', accent: '#c2633a', me: '#ffffff', view: 'rgba(194, 99, 58, 0.18)', ink: '#3a2a20' };

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
  /** camada de imóveis (meus / à venda), redesenhada só quando muda */
  private owned: HTMLCanvasElement | null = null;
  private lotGeo: Map<string, { rings: Ring[]; c: Vec2 }> | null = null;
  private highlightUntil = 0;
  /** legenda + liga/desliga do destaque (só aparece quando há imóveis marcados) */
  private readonly legend: HTMLElement;
  private readonly toggleBtn: HTMLButtonElement;
  private showOwned = true;
  onPick: ((x: number, z: number) => void) | null = null;
  /** destaque ligado/desligado (o 3D acompanha) */
  onHighlight: ((on: boolean) => void) | null = null;

  constructor(
    parent: HTMLElement,
    private readonly game: Game,
  ) {
    const b = game.world.data.bounds;
    this.range = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 2 + 60;
    this.canvas = h('canvas', { width: String(this.px), height: String(this.px), 'aria-label': 'Minimapa — clique para ir até o local', role: 'img' }) as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    this.toggleBtn = h('button', {
      type: 'button',
      class: 'mm-toggle',
      'aria-pressed': 'true',
      title: 'Mostrar/ocultar destaque dos imóveis',
      'aria-label': 'Destaque dos imóveis no mapa',
      html: svgIcon(ICONS.eye),
      onclick: () => this.toggleOwned(),
    }) as HTMLButtonElement;
    this.legend = h(
      'div',
      { class: 'mm-legend', hidden: true },
      h('span', { class: 'lg-mine', 'aria-hidden': 'true' }),
      h('span', {}, 'seus'),
      h('span', { class: 'lg-listed', 'aria-hidden': 'true' }),
      h('span', {}, 'à venda'),
      this.toggleBtn,
    );
    this.el = h('div', { class: 'minimap card' }, this.canvas, this.legend);
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

  private toggleOwned() {
    this.showOwned = !this.showOwned;
    this.toggleBtn.setAttribute('aria-pressed', String(this.showOwned));
    this.toggleBtn.innerHTML = svgIcon(this.showOwned ? ICONS.eye : ICONS.eyeOff);
    this.el.classList.toggle('owned-off', !this.showOwned);
    this.onHighlight?.(this.showOwned);
  }

  /** imóveis do jogador (quadrado amarelo) e à venda (anel); só é chamado quando muda */
  setOwnership(mine: Set<string>, listed: Set<string>) {
    this.legend.hidden = !mine.size && !listed.size;
    if (!mine.size && !listed.size) {
      this.owned = null;
      return;
    }
    if (!this.lotGeo) {
      const geo = (this.lotGeo = new Map<string, { rings: Ring[]; c: Vec2 }>());
      const add = (id: string, r: Ring, c: Vec2) => {
        const g = geo.get(id);
        if (g) g.rings.push(r);
        else geo.set(id, { rings: [r], c });
      };
      for (const b of this.game.world.data.buildings) add(b.lotId, b.outer, b.centroid);
      for (const l of this.game.world.vacantLots) add(l.lotId, l.outer!, l.centroid);
    }
    const lots = this.lotGeo;
    let c = this.owned;
    if (!c) {
      // aloca uma vez; depois só limpa
      c = this.owned = document.createElement('canvas');
      c.width = c.height = this.px;
    }
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, this.px, this.px);
    const trace = (ring: Ring) => {
      g.beginPath();
      ring.forEach(([x, z], i) => {
        const [px, pz] = this.toPx(x, z);
        if (i) g.lineTo(px, pz);
        else g.moveTo(px, pz);
      });
      g.closePath();
    };
    // à venda (de outros): anel vazado
    g.strokeStyle = MM.accent;
    g.lineWidth = 1.5;
    for (const id of listed) {
      const l = lots.get(id);
      if (!l || mine.has(id)) continue;
      const [px, pz] = this.toPx(l.c[0], l.c[1]);
      g.beginPath();
      g.arc(px, pz, 4, 0, Math.PI * 2);
      g.stroke();
    }
    // meus: polígono + quadrado cheio com borda escura (prédios têm ~1 px nesta escala)
    g.fillStyle = MM.accent;
    for (const id of mine) {
      const l = lots.get(id);
      if (!l) continue;
      for (const r of l.rings) {
        trace(r);
        g.fill();
      }
      const [px, pz] = this.toPx(l.c[0], l.c[1]);
      g.lineWidth = 1.5;
      g.strokeStyle = MM.ink;
      g.fillRect(px - 4, pz - 4, 8, 8);
      g.strokeRect(px - 4, pz - 4, 8, 8);
    }
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
    if (this.owned && this.showOwned) g.drawImage(this.owned, 0, 0);
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
    // seta: clara com contorno amarelo (o amarelo cheio é "meu")
    g.fillStyle = MM.me;
    g.strokeStyle = MM.accent;
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
