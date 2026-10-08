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
import { installMono } from './world/render/mono';
import { OwnershipOverlay } from './world/render/OwnershipOverlay';
import { OnlineStore } from './net/store';
import type { AuthDialog } from './ui/AuthDialog';
import { EconomyHud } from './ui/EconomyHud';
import type { MarketPanel } from './ui/MarketPanel';
import { closeAllModals, setSessionUserProvider } from './ui/modal';
import { PropertySection } from './ui/PropertySection';

// modo monocromático: precisa remendar os shaders antes de qualquer compilação
installMono();

const isMobile = matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad/i.test(navigator.userAgent);

async function boot() {
  const ui = document.getElementById('ui')!;
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const loading = new LoadingScreen(document.body);

  // ---- sessão online em paralelo com o mapa (sem backend: só exploração)
  const store = new OnlineStore();
  setSessionUserProvider(() => store.user?.id ?? null);
  let ready = () => {};
  const gameReady = new Promise<void>((r) => (ready = r));
  // login concluído (mesmo durante o carregamento): age quando o jogo estiver pronto
  const hooks = { loggedIn: null as (() => void) | null };
  // tela de conta sob demanda (import dinâmico: só quem tem servidor e não tem sessão baixa)
  let auth: AuthDialog | null = null;
  let authP: Promise<AuthDialog> | null = null;
  const getAuth = () =>
    (authP ??= import('./ui/AuthDialog').then((m) => {
      auth = new m.AuthDialog(store);
      auth.onDone = () => void gameReady.then(() => hooks.loggedIn?.());
      return auth;
    }));
  const openAuth = (msg?: string | null) =>
    void getAuth().then(
      (a) => a.open('login', msg),
      (e) => console.error('[online] falha ao carregar a tela de conta', e),
    );
  void store.connect().then(() => {
    if (store.status === 'anonymous') openAuth();
  });
  // sessão encerrada ou outra conta: nenhum diálogo/confirmação da anterior sobrevive
  let sessionUser = store.user?.id ?? null;
  store.on('status', () => {
    const id = store.user?.id ?? null;
    if (sessionUser !== null && id !== sessionUser) closeAllModals();
    sessionUser = id;
    // sessão expirou no meio do jogo: volta para a tela de login
    if (store.status === 'anonymous' && store.expiredMessage && !auth?.opened) openAuth(store.expiredMessage);
  });

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
    const econHud = new EconomyHud(ui, store);
    const propertySection = new PropertySection(store);
    const panel = new InfoPanel(ui, world, propertySection);
    const minimap = new Minimap(ui, game);
    game.addSystem(minimap);
    const ownership = new OwnershipOverlay(world);
    game.scene.add(ownership.lines);
    game.onResizeHooks.push((w, h) => ownership.resize(w, h));
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

    // ---- camada online
    const buildingByLot = new Map(world.data.buildings.map((b) => [b.lotId, b]));
    const goToLot = (lotId: string) => {
      const b = buildingByLot.get(lotId);
      if (b) {
        game.goTo(b.centroid[0], b.centroid[1], 140);
        selection.select(b);
        return;
      }
      const lot = world.lotsById.get(lotId);
      if (lot?.outer) {
        game.goTo(lot.centroid[0], lot.centroid[1], 140);
        selection.selectLot(lot);
      } else hud.toast('Imóvel não encontrado no mapa', 'error');
    };
    const toast = (m: string, error?: boolean) => hud.toast(m, error ? 'error' : 'info');
    // mercado sob demanda (import dinâmico no primeiro clique)
    let marketP: Promise<MarketPanel> | null = null;
    const getMarket = () =>
      (marketP ??= Promise.all([import('./ui/MarketPanel'), import('./net/cityCatalog')]).then(([m, c]) => {
        const market = new m.MarketPanel(store, () => c.buildCityCatalog(world.data));
        market.onToast = toast;
        market.onGoTo = goToLot;
        return market;
      }));
    const openMarket = (tab?: Parameters<MarketPanel['open']>[0]) =>
      void getMarket().then(
        (m) => m.open(tab),
        (e) => {
          marketP = null;
          toast(`Não foi possível abrir o mercado: ${(e as Error).message}`, true);
        },
      );
    econHud.onToast = toast;
    econHud.onMarket = () => openMarket();
    econHud.onLogin = () => openAuth();
    propertySection.onToast = toast;
    propertySection.onLogin = () => openAuth();
    const syncOwnership = () => {
      ownership.set(store.mine, store.listed);
      minimap.setOwnership(store.mine, store.listed);
    };
    // legenda/alternância do destaque no minimapa
    minimap.onHighlight = (on) => ownership.setEnabled(on);
    store.on('ownership', syncOwnership);
    syncOwnership();
    let offlineWarned = false;
    const warnOffline = () => {
      if (store.status !== 'offline' || offlineWarned) return;
      offlineWarned = true;
      hud.toast('Servidor offline — modo exploração');
    };
    store.on('status', warnOffline);
    warnOffline();
    hooks.loggedIn = () => {
      hud.toast(`Olá, ${store.user?.displayName ?? 'jogador'}!`);
      // primeira vez: sugere a casa inicial
      if (store.wallet?.starterAvailable) openMarket('starter');
    };
    search.onChoose = (g) => {
      game.goTo(g.center[0], g.center[1], 260);
      highlight.show(g.streets);
      minimap.flash(g.streets.map((s) => s.points));
      hud.toast(g.name);
    };

    game.start();
    loading.set(1, 'Bem-vindo a Itabirito!');
    loading.hide();
    ready();
    console.info(`[boot] cidade pronta em ${Math.round(performance.now())} ms`);
    // acesso para depuração no console
    Object.assign(window as object, { game, time, traffic, selection, panel, postfx });
  } catch (e) {
    console.error(e);
    loading.error((e as Error).message);
  }
}

boot();
