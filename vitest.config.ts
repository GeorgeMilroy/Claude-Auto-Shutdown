import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 20_000,
    // Belt and braces: no test may ever run a real power command on the machine it runs on.
    env: { CLAUDE_AUTOSHUTDOWN_NO_POWER: '1' },
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
});
