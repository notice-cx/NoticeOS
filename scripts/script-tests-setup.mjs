// Preloaded into every root script test process by `pnpm test:scripts`
// (`node --import ./scripts/script-tests-setup.mjs --test scripts/*.test.mjs`).
// node --test forwards --import to each test file's own process, where this arms
// the config guard for that file (bead ro-ujb9.97): no test — and no script a
// test drives — reads the checkout's config/, bar the seed-validation tests
// listed in scripts/test-config-isolation.mjs.
import { installScriptTestConfigGuard } from './test-config-isolation.mjs';

installScriptTestConfigGuard();
