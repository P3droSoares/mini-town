import { Game } from './core/Game';
import { PRESETS, autoQuality } from './core/quality';
import { PostFX } from './core/PostFX';
import { StaticJsonWorldSource } from './data/WorldSource';
import { PlayerProfile } from './economy/PlayerProfile';
import { setupRestaurants } from './economy/places';
import { DeliverySystem } from './systems/DeliverySystem';
import { DayNightSystem } from './systems/DayNightSystem';
import { SelectionSystem } from './systems/SelectionSystem';
import { TimeSystem } from './systems/TimeSystem';
import { TrafficSystem } from './systems/TrafficSystem';
import { DeliveryApp } from './ui/DeliveryApp';
import { DeliveryHud } from './ui/DeliveryHud';
import { Hud } from './ui/Hud';
import { InfoPanel } from './ui/InfoPanel';
import { LoadingScreen } from './ui/LoadingScreen';
import { Menu } from './ui/Menu';
import { Minimap } from './ui/Minimap';
import { loadSettings } from './ui/settings';
import { StreetSearch } from './ui/StreetSearch';
import { WorldState } from './world/WorldState';
import { Router } from './world/routing';
import { StreetHighlight } from './world/render/StreetHighlight';
import { installMono } from './world/render/mono';

// modo monocromático: precisa remendar os shaders antes de qualquer compilação
installMono();

const isMobile = matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad/i.test(navigator.userAgent);

async function boot() {
  const ui = document.getElementById('ui')!;
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const loading = new LoadingScreen(document.body);
  try {
    // ---- dados do mundo (hoje JSON estático; amanhã, servidor)
    loading.set(0, 'Baixando mapa da cidade…');
    const source = new StaticJsonWorldSource(`${import.meta.env.BASE_URL}data/cidade.json`);
    const data = await source.load((loaded, total) => {
      const f = total ? loaded / total : 0.5;
      loading.set(f * 0.25, `Baixando mapa da cidade… ${(loaded / 1048576).toFixed(1)} MB`);
    });
    loading.set(0.27, 'Organizando ruas e lotes…');
    await new Promise((r) => setTimeout(r, 0));
    const world = new WorldState(data);
    // restaurantes parceiros do app ganham nome antes de montar a cena (letreiros)
    const router = new Router(world.graph);
    const restaurants = setupRestaurants(world, router);
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
    const profile = new PlayerProfile();
    const delivery = new DeliverySystem(game, profile, router, restaurants);
    game.addSystem(delivery);
    game.player.obstacles = () => traffic.nearPlayer;
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
    const app = new DeliveryApp(ui, game, profile, delivery);
    hud.topbar.insertBefore(app.button, hud.topbar.lastElementChild);
    const deliveryHud = new DeliveryHud(ui, game, delivery, profile);
    game.addSystem(deliveryHud);

    // ---- ligações
    menu.onNpcDensity = (v) => (traffic.density = v);
    selection.onSelect = (b) => {
      if (b) {
        panel.show(b);
        app.close();
      } else panel.close();
    };
    panel.onClose = () => selection.clearSelection();
    selection.onSelectLot = (lot) => panel.showLot(lot);
    panel.onToast = (m) => hud.toast(m);
    const noTeleport = () => hud.toast('Durante a corrida não dá para se teletransportar: siga a rota.');
    panel.onWalkHere = (b) => {
      if (game.positionLocked) return noTeleport();
      if (game.mode === 'city') {
        game.cityCam.jumpTo(b.centroid[0], b.centroid[1]);
        game.setMode('walk');
      } else game.player.spawn(b.centroid[0], b.centroid[1]);
    };
    minimap.onPick = (x, z) => {
      if (!game.goTo(x, z)) noTeleport();
    };
    minimap.gps = () => delivery.gps();
    const syncMinimapRect = () => {
      const r = minimap.el.getBoundingClientRect();
      deliveryHud.minimapRect = r.width && r.bottom > window.innerHeight / 2 ? r : null;
    };
    game.onResizeHooks.push(syncMinimapRect);
    game.onModeChange.push(() => requestAnimationFrame(syncMinimapRect));
    delivery.onChange.push(() => requestAnimationFrame(syncMinimapRect));
    syncMinimapRect();
    // entregas: app, ofertas, veículo
    delivery.onToast = (m) => hud.toast(m);
    app.onToast = (m) => hud.toast(m);
    app.onOpen = () => {
      panel.close();
      selection.clearSelection();
    };
    // clique de mouse não deixa foco em botões/caixas: Espaço e Enter são comandos do jogo
    ui.addEventListener('click', (e) => {
      const a = document.activeElement as HTMLInputElement | null;
      if (e.detail > 0 && a && (a.tagName === 'BUTTON' || a.type === 'checkbox')) a.blur();
    });
    game.input.on('KeyF', () => delivery.toggleRide());
    game.input.on('KeyE', () => app.toggle());
    game.input.on('Enter', () => delivery.accept());
    game.input.on('NumpadEnter', () => delivery.accept());
    search.onChoose = (g) => {
      if (!game.goTo(g.center[0], g.center[1], 260)) noTeleport();
      highlight.show(g.streets);
      minimap.flash(g.streets.map((s) => s.points));
      hud.toast(g.name);
    };

    game.start();
    loading.set(1, 'Bem-vindo a Vila Aurora!');
    loading.hide();
    console.info(`[boot] cidade pronta em ${Math.round(performance.now())} ms`);
    // acesso para depuração no console
    Object.assign(window as object, { game, time, traffic, selection, panel, postfx, delivery, profile });
  } catch (e) {
    console.error(e);
    loading.error((e as Error).message);
  }
}

boot();
