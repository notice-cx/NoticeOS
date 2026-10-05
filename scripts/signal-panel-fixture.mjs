import fs from 'node:fs/promises';
import path from 'node:path';

/** Lightweight analyzer double for archive/door tests. Atomic publication is
 * proven separately against the real bounded history analyzer. */
export function fixtureRefreshDeps(deps) {
  return {
    ...deps,
    writeHistory: deps.writeHistory ?? (async () => ({ generation: 1 })),
    analyze: async (input) => {
      const result = await deps.analyze(input);
      await fs.mkdir(input.output, { recursive: true });
      for (const [name, text] of Object.entries(input.reportFiles)) {
        await fs.writeFile(path.join(input.output, name), text);
      }
      return result;
    },
  };
}
