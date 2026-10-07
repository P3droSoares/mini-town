import type * as THREE from 'three';
import type { Game } from '../core/Game';
import type { PostFX } from '../core/PostFX';
import type { DayNightSystem } from '../systems/DayNightSystem';
import type { TimeSystem } from '../systems/TimeSystem';
import { ICONS, h, svgIcon } from './dom';
import { type Settings, saveSettings } from './settings';

/** Relógio + menu de configurações (hora, tilt-shift, sombras, NPCs, FPS). */
export class Menu {
  readonly el: HTMLElement;
  private clockText: HTMLElement;
  private clockIcon: HTMLElement;
  private hourInput: HTMLInputElement;
  private hourLabel: HTMLElement;
  private realInput: HTMLInputElement;
  private speedSelect: HTMLSelectElement;
  private fpsEl: HTMLElement;
  private frames = 0;
  private fpsAcc = 0;
  /** chamado quando a densidade de NPCs muda */
  onNpcDensity: ((v: number) => void) | null = null;

  constructor(
    root: HTMLElement,
    controls: HTMLElement,
    private readonly game: Game,
    private readonly time: TimeSystem,
    private readonly dayNight: DayNightSystem,
    postfx: PostFX,
    private readonly settings: Settings,
  ) {
    this.clockIcon = h('span', { html: svgIcon(ICONS.sun) });
    this.clockText = h('span', {}, '--:--');
    const clockBtn = h(
      'button',
      { class: 'clock card iconbtn', title: 'Hora em Brasília — abrir configurações', 'aria-label': 'Hora e configurações', onclick: () => this.toggle() },
      this.clockIcon,
      this.clockText,
      h('small', {}, 'BRT'),
    );
    const menuBtn = h('button', {
      class: 'iconbtn card',
      title: 'Configurações',
      'aria-label': 'Configurações',
      html: svgIcon(ICONS.menu),
      onclick: () => this.toggle(),
    });
    controls.append(clockBtn, menuBtn);

    this.realInput = h('input', { type: 'checkbox' }) as HTMLInputElement;
    this.realInput.checked = time.mode === 'real';
    this.realInput.addEventListener('change', () => {
      if (this.realInput.checked) time.useRealTime();
      else time.setHours(Number(this.hourInput.value));
      this.sync();
    });
    this.hourInput = h('input', { type: 'range', min: '0', max: '23.99', step: '0.05', 'aria-label': 'Hora do dia' }) as HTMLInputElement;
    this.hourLabel = h('span', {}, '');
    this.hourInput.addEventListener('input', () => {
      time.setHours(Number(this.hourInput.value));
      this.realInput.checked = false;
      this.sync();
    });
    this.speedSelect = h(
      'select',
      { 'aria-label': 'Velocidade do tempo' },
      h('option', { value: '1' }, '1× (real)'),
      h('option', { value: '60' }, '60× (1 min/s)'),
      h('option', { value: '600' }, '600× (10 min/s)'),
    ) as HTMLSelectElement;
    this.speedSelect.addEventListener('change', () => {
      if (time.mode === 'real') time.setHours(time.hours());
      time.speed = Number(this.speedSelect.value);
      this.realInput.checked = false;
    });

    const check = (label: string, value: boolean, on: (v: boolean) => void) => {
      const i = h('input', { type: 'checkbox' }) as HTMLInputElement;
      i.checked = value;
      i.addEventListener('change', () => on(i.checked));
      return h('label', {}, label, i);
    };
    const density = h('input', { type: 'range', min: '0', max: '1', step: '0.05', 'aria-label': 'Movimento nas ruas' }) as HTMLInputElement;
    density.value = String(settings.npcDensity);
    density.addEventListener('input', () => {
      settings.npcDensity = Number(density.value);
      saveSettings(settings);
      this.onNpcDensity?.(settings.npcDensity);
    });

    const qualitySelect = h(
      'select',
      { 'aria-label': 'Qualidade gráfica' },
      h('option', { value: 'auto' }, `Automática (${game.quality.level === 'high' ? 'alta' : game.quality.level === 'medium' ? 'média' : 'baixa'})`),
      h('option', { value: 'high' }, 'Alta (SSAO, sombras 4K)'),
      h('option', { value: 'medium' }, 'Média'),
      h('option', { value: 'low' }, 'Baixa (celular simples)'),
    ) as HTMLSelectElement;
    qualitySelect.value = settings.quality;
    const qualityNote = h('div', { class: 'credits', hidden: true }, 'Recarregue a página para aplicar. ', h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); location.reload(); } }, 'Recarregar agora'));
    qualitySelect.addEventListener('change', () => {
      settings.quality = qualitySelect.value as Settings['quality'];
      saveSettings(settings);
      qualityNote.hidden = false;
    });
    this.fpsEl = h('div', { class: 'fps card' }, '-- FPS');
    root.append(this.fpsEl);

    this.el = h(
      'div',
      { class: 'menu card', role: 'dialog', 'aria-label': 'Configurações' },
      h('h3', {}, 'Hora do dia'),
      h('label', {}, 'Horário real de Brasília', this.realInput),
      h('div', { class: 'row' }, this.hourInput, this.hourLabel),
      h('label', {}, 'Velocidade', this.speedSelect),
      h('hr'),
      h('h3', {}, 'Visual'),
      h('label', {}, 'Qualidade gráfica', qualitySelect),
      qualityNote,
      check('Efeito maquete (tilt-shift)', settings.tiltShift, (v) => {
        settings.tiltShift = v;
        postfx.setTiltShift(v);
        saveSettings(settings);
      }),
      check('Sombras', settings.shadows, (v) => {
        settings.shadows = v;
        this.applyShadows();
        saveSettings(settings);
      }),
      check('Mostrar FPS', settings.showFps, (v) => {
        settings.showFps = v;
        this.fpsEl.classList.toggle('show', v);
        saveSettings(settings);
      }),
      h('hr'),
      h('h3', {}, 'Movimento nas ruas'),
      density,
      h('hr'),
      h(
        'div',
        {
          class: 'credits',
          html:
            'Mapa: © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> (ODbL). ' +
            'Relevo: Mapzen Terrarium / SRTM. Prédios sem mapeamento são gerados proceduralmente.',
        },
      ),
    );
    root.append(this.el);

    postfx.tiltShift = settings.tiltShift;
    postfx.rebuild();
    this.applyShadows();
    this.fpsEl.classList.toggle('show', settings.showFps);
    time.onChange(() => this.sync());
    this.sync();
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.el.classList.remove('open');
    });
  }

  private applyShadows() {
    const r = this.game.renderer;
    r.shadowMap.enabled = this.settings.shadows;
    this.game.sun.castShadow = this.settings.shadows;
    // força recompilar materiais com/sem sombra
    this.game.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      (Array.isArray(m) ? m : [m]).forEach((mm) => (mm.needsUpdate = true));
    });
  }

  toggle() {
    this.el.classList.toggle('open');
    this.sync();
  }

  private sync() {
    const hours = this.time.hours();
    this.hourInput.value = String(hours);
    this.hourLabel.textContent = this.time.label();
    this.speedSelect.value = String(this.time.mode === 'real' ? 1 : this.time.speed);
  }

  /** atualiza relógio e FPS (chamado pelo loop) */
  update(dt: number) {
    this.frames++;
    this.fpsAcc += dt;
    if (this.fpsAcc >= 0.5) {
      const fps = Math.round(this.frames / this.fpsAcc);
      const info = this.game.renderer.info.render;
      this.fpsEl.textContent = `${fps} FPS · ${info.calls} draws · ${(info.triangles / 1000).toFixed(0)}k tris`;
      this.frames = 0;
      this.fpsAcc = 0;
      this.clockText.textContent = this.time.label();
      this.clockIcon.innerHTML = svgIcon(this.dayNight.night > 0.5 ? ICONS.moon : ICONS.sun);
      if (this.el.classList.contains('open')) this.sync();
    }
  }
}
