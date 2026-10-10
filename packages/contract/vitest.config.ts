import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { fixtureConfigPlugin } from '../../scripts/test-config-isolation.mjs';

// No test reads the checkout's own config/: the contract's compiled clock is
// answered with test/fixture-config/'s copy, a test importing a repo config
// file is refused, and test/setup.mjs refuses reading one, so a saved setting
// exported back into config/ cannot change a result here.
export default defineConfig({
  plugins: [
    fixtureConfigPlugin({
      fixtureDir: fileURLToPath(new URL('./test/fixture-config', import.meta.url)),
      testDir: fileURLToPath(new URL('./test', import.meta.url)),
    }),
  ],
  test: {
    setupFiles: ['./test/setup.mjs'],
  },
});
