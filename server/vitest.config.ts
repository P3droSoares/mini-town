import { defineConfig } from 'vitest/config';

// Testes de integração usam um Postgres descartável (ver test/db.ts).
// UNIT_ONLY=1 roda só os testes puros, sem banco.
const unitOnly = process.env.UNIT_ONLY === '1';

export default defineConfig({
  test: {
    // UNIT_ONLY = testes puros (unitários + ataques puros do red team); sem banco.
    include: unitOnly ? ['test/unit.test.ts', 'test/attack/pure*.test.ts'] : ['test/**/*.test.ts'],
    globalSetup: unitOnly ? [] : ['test/global-setup.ts'],
    // um arquivo por vez: os testes compartilham banco e catálogo
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
