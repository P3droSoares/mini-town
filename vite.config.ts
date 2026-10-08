import { defineConfig, type ServerOptions } from 'vite';

// Dentro do Docker (DOCKER=1): o navegador fala com o Caddy em APP_ORIGIN, e o
// bind mount do Windows não emite eventos de arquivo — daí o polling.
function dockerServer(): ServerOptions {
  const origin = new URL(process.env.APP_ORIGIN ?? 'https://localhost:8443');
  const clientPort = Number(origin.port || (origin.protocol === 'https:' ? 443 : 80));
  return {
    // o Caddy aponta fixo para web:5173
    strictPort: true,
    allowedHosts: [origin.hostname, 'web'],
    hmr: {
      protocol: origin.protocol === 'https:' ? 'wss' : 'ws',
      host: origin.hostname,
      clientPort,
    },
    // o compose só monta src/, public/ e os arquivos de config; a lista é
    // defesa extra (inclui os padrões do Vite, que ela substitui)
    fs: {
      strict: true,
      deny: ['.env', '.env.*', '*.{crt,pem,key}', '**/.git/**', '**/server/**', '**/docker/**', '**/backups/**'],
    },
    watch: {
      usePolling: true,
      interval: 300,
      // backend, build e infra não fazem parte do grafo do front
      ignored: ['**/server/**', '**/dist/**', '**/docker/**', '**/docs/**', '**/backups/**', '**/.cache/**'],
    },
  };
}

export default defineConfig({
  server: {
    port: 5173,
    host: true,
    ...(process.env.DOCKER === '1' ? dockerServer() : {}),
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: { manualChunks: { three: ['three'] } },
    },
  },
});
