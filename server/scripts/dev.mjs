// `npm run dev`: tsx watch com polling (bind mount do Windows não emite
// eventos de arquivo dentro do container). Recarrega em src/ e migrations/.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');

const env = { ...process.env };
env.CHOKIDAR_USEPOLLING ??= '1';
env.CHOKIDAR_INTERVAL ??= '500';

const child = spawn(
  process.execPath,
  [tsxCli, 'watch', '--clear-screen=false', '--include', 'migrations/**/*.sql', 'src/index.ts'],
  { stdio: 'inherit', env },
);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
