import { Game } from './core/Game';
import { StaticJsonWorldSource } from './data/WorldSource';
import { Hud } from './ui/Hud';
import { LoadingScreen } from './ui/LoadingScreen';
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

    const game = new Game({
      canvas,
      world,
      mobile: isMobile,
      onProgress: (f, label) => loading.set(0.28 + f * 0.7, label),
    });
    await game.init();
    new Hud(ui, game);
    game.start();
    loading.set(1, 'Bem-vindo a Itabirito!');
    loading.hide();
    console.info(`[boot] cidade pronta em ${Math.round(performance.now())} ms`);
    // acesso para depuração no console
    (window as unknown as { game: Game }).game = game;
  } catch (e) {
    console.error(e);
    loading.error((e as Error).message);
  }
}

boot();
