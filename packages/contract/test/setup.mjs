import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installOwnerConfigReadGuard } from '../../../scripts/test-config-isolation.mjs';

// Tests run on fixture configuration: test code reading the checkout's own
// config/ with node:fs is refused before the file is touched. Imports are
// answered by vitest.config.ts. Plain JS: this package carries no Node types.
installOwnerConfigReadGuard({ testDir: path.dirname(fileURLToPath(import.meta.url)) });
