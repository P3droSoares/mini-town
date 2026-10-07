import { Game } from './core/Game';
import { PRESETS, autoQuality } from './core/quality';
import { PostFX } from './core/PostFX';
import { StaticJsonWorldSource } from './data/WorldSource';
import { DayNightSystem } from './systems/DayNightSystem';
import { SelectionSystem } from './systems/SelectionSystem';
import { TimeSystem } from './systems/TimeSystem';
import { TrafficSystem } from './systems/TrafficSystem';
import { Hud } from './ui/Hud';
import { InfoPanel } from './ui/InfoPanel';
import { LoadingScreen } from './ui/LoadingScreen';
import { Menu } from './ui/Menu';
import { Minimap } from './ui/Minimap';
import { loadSettings } from './ui/settings';
import { StreetSearch } from './ui/StreetSearch';
import { WorldState } from './world/WorldState';
import { StreetHighlight } from './world/render/StreetHighlight';

const isMobile = matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad/i.test(navigator.userAgent);

async function boot() {
  const ui = document.getElementById('ui')!;
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const loading = new LoadingScreen(document.body);
  try {
    // ---- dados do mundo (hoje JSON estático; amanhã, servidor)
    loading.set(0, 'Baixando mapa da cidade…');
    const source = new StaticJsonWorldSource(`${import.meta.env.BASE_URL}data/itabirito.json`);
    const data = await source.load((loaded, total) => {
      const f = total ? loaded / total : 0.5;
      loading.set(f * 0.25, `Baixando mapa da cidade… ${(loaded / 1048576).toFixed(1)} MB`);
    });
    loading.set(0.27, 'Organizando ruas e lotes…');
    await new Promise((r) => setTimeout(r, 0));
    const world = new WorldState(data);
    const settings = loadSettings(isMobile);
    // cópia: a qualidade adaptativa pode desligar efeitos em tempo de execução
    const quality = { ...PRESETS[settings.quality === 'auto' ? autoQuality(isMobile) : settings.quality] };
    console.info(`[boot] qualidade: ${quality.level}`);

    // ---- renderização
    const game = new Game({
      canvas,
      world,
      mobile: isMobile,
      quality,
      onProgress: (f, label) => loading.set(0.28 + f * 0.7, label),
    });
    await game.init();

    // ---- sistemas
    const time = new TimeSystem();
    const dayNight = new DayNightSystem(game, time);
    game.addSystem(dayNight);
    const traffic = new TrafficSystem(game, time, dayNight);
    traffic.density = settings.npcDensity;
    game.addSystem(traffic);
    const selection = new SelectionSystem(game);
    game.addSystem(selection);
    const highlight = new StreetHighlight(world.height);
    game.scene.add(highlight.line);
    game.onResizeHooks.push((w, h) => highlight.resize(w, h));
    game.addSystem(highlight);

    // ---- UI
    const hud = new Hud(ui, game);
    const search = new StreetSearch(hud.topbar, world);
    hud.topbar.insertBefore(search.el, hud.topbar.children[1]);
    const panel = new InfoPanel(ui, world);
    const minimap = new Minimap(ui, game);
    game.addSystem(minimap);
    const postfx = new PostFX(game);
    const menu = new Menu(ui, hud.controls, game, time, dayNight, postfx, settings);
    game.addSystem(menu);

    // ---- ligações
    menu.onNpcDensity = (v) => (traffic.density = v);
    selection.onSelect = (b) => {
      if (b) panel.show(b);
      else panel.close();
    };
    panel.onClose = () => selection.clearSelection();
    selection.onSelectLot = (lot) => panel.showLot(lot);
    panel.onToast = (m) => hud.toast(m);
    panel.onWalkHere = (b) => {
      if (game.mode === 'city') {
        game.cityCam.jumpTo(b.centroid[0], b.centroid[1]);
        game.setMode('walk');
      } else game.player.spawn(b.centroid[0], b.centroid[1]);
    };
    minimap.onPick = (x, z) => game.goTo(x, z);
    search.onChoose = (g) => {
      game.goTo(g.center[0], g.center[1], 260);
      highlight.show(g.streets);
      minimap.flash(g.streets.map((s) => s.points));
      hud.toast(g.name);
    };

    game.start();
    loading.set(1, 'Bem-vindo a Itabirito!');
    loading.hide();
    console.info(`[boot] cidade pronta em ${Math.round(performance.now())} ms`);
    // acesso para depuração no console
    Object.assign(window as object, { game, time, traffic, selection, panel, postfx });
  } catch (e) {
    console.error(e);
    loading.error((e as Error).message);
  }
}

boot();
