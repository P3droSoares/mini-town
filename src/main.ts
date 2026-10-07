import { Game } from './core/Game';
import { PostFX } from './core/PostFX';
import { StaticJsonWorldSource } from './data/WorldSource';
import { DayNightSystem } from './systems/DayNightSystem';
import { TimeSystem } from './systems/TimeSystem';
import { Hud } from './ui/Hud';
import { LoadingScreen } from './ui/LoadingScreen';
import { Menu } from './ui/Menu';
import { loadSettings } from './ui/settings';
import { WorldState } from './world/WorldState';

const isMobile = matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad/i.test(navigator.userAgent);

async function boot() {
  const ui = document.getElementById('ui')!;
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const loading = new LoadingScreen(document.body);
  try {
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

    const game = new Game({
      canvas,
      world,
      mobile: isMobile,
      onProgress: (f, label) => loading.set(0.28 + f * 0.7, label),
    });
    await game.init();

    // sistemas
    const time = new TimeSystem();
    const dayNight = new DayNightSystem(game, time);
    game.addSystem(dayNight);

    // UI
    const hud = new Hud(ui, game);
    const postfx = new PostFX(game);
    const menu = new Menu(ui, hud.controls, game, time, dayNight, postfx, settings);
    game.addSystem(menu);

    game.start();
    loading.set(1, 'Bem-vindo a Itabirito!');
    loading.hide();
    console.info(`[boot] cidade pronta em ${Math.round(performance.now())} ms`);
    // acesso para depuração no console
    Object.assign(window as object, { game, time });
  } catch (e) {
    console.error(e);
    loading.error((e as Error).message);
  }
}

boot();
