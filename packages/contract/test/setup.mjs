import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installOwnerConfigReadGuard } from '../../../scripts/test-config-isolation.mjs';

// Tests run on fixture configuration (beads ro-ujb9.92, ro-ujb9.97): test code
// reading the checkout's own config/ with node:fs is refused before the file is
// touched. Imports are answered by vitest.config.ts. Plain JS on purpose: this
// package carries no Node types, and this file is the only one that needs them.
installOwnerConfigReadGuard({ testDir: path.dirname(fileURLToPath(import.meta.url)) });
