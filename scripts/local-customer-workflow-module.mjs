import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadCustomerWorkflowModule(sourceRoot, privateRoot, contents, configurationRoot) {
  const buildRoot = await mkdtemp(path.join(privateRoot, 'workflow-code-'));
  try {
    const ingest = createRequire(path.join(sourceRoot, 'workers/ingest/package.json'));
    const { build } = createRequire(ingest.resolve('wrangler/package.json'))('esbuild');
    const outfile = path.join(buildRoot, 'workflow.mjs');
    await build({ absWorkingDir: sourceRoot, outfile, bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent',
      plugins: configurationRoot ? [{ name: 'workflow-defaults', setup(builder) {
        builder.onResolve({ filter: /config\/[^/]+\.json$/ }, args => {
          const resolved = path.resolve(args.resolveDir, args.path);
          if (path.dirname(resolved) === path.join(sourceRoot, 'config')) return { path: path.join(configurationRoot, path.basename(resolved)) };
        });
      } }] : [],
      stdin: { resolveDir: path.join(sourceRoot, 'workers/ingest/src'), loader: 'ts', contents },
      banner: { js: 'import { createRequire as workflowRequire } from "node:module"; const require = workflowRequire(import.meta.url);' },
    });
    return await import(pathToFileURL(outfile));
  } finally { await rm(buildRoot, { recursive: true, force: true }); }
}
