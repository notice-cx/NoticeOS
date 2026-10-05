// Pure public-source identity checks shared by setup and the read-only viewer.
import { runCommand } from './run-command.mjs';
import { devNull } from 'node:os';

export const PUBLIC_RUNTIME = ['scripts', 'apps', 'workers', 'packages', 'db', 'config', '.githooks', '.gitignore', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig*.json'];
export const REQUIRED_DEMO_ENTRIES = Object.freeze(['scripts/demo-replay.mjs', 'scripts/demo-replay-gateway.mjs', 'scripts/demo-visit.mts', 'scripts/demo-visit.mjs', 'scripts/demo-visit.d.mts', 'apps/tower/src/lib/demo-visit.ts', 'scripts/demo-release.mjs', 'scripts/demo-seed.mjs', 'scripts/demo-scenario.mjs', 'scripts/demo-store.mjs', 'scripts/demo-tasks.mjs', 'scripts/demo-evaluator.mjs', 'scripts/demo-display.mjs', 'scripts/demo-task-facts.mjs', 'scripts/demo-workflows.mjs', 'packages/contract/src/rules.ts', 'packages/contract/src/poisson.ts', 'workers/ingest/src/watch-windows.ts', 'workers/ingest/src/beads-snapshots.ts', 'workers/ingest/src/config-store.ts', 'workers/ingest/src/job-runs.ts', 'workers/ingest/src/db.ts', 'scripts/demo-viewer.mjs', 'scripts/demo-viewer-installation.mjs', 'scripts/demo-viewer-policy.mjs', 'apps/tower/vite.config.ts', 'apps/tower/vite/demo-viewer-lane.ts', 'apps/tower/vite/task-lane.ts', 'apps/tower/shared/demo-viewer.ts', 'apps/tower/worker/demo-viewer-route.ts', 'apps/tower/worker/index.ts', 'apps/tower/worker/mcp-route.ts', 'db/postgres/frozen-migrations.sha256']);
export async function verifyDemoRelease(root, release, { env = process.env } = {}) {
    // Git selectors and caller configuration cannot redirect the source check
    // or run a filesystem-monitor command while reading its declared checkout.
    const clean = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT']
        .flatMap(key => typeof env[key] === 'string' ? [[key, env[key]]] : []));
    Object.assign(clean, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull });
    const execute = args => runCommand('git', ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${devNull}`, '-C', root, ...args], { env: clean, timeoutMs: 5000 });
    const head = await execute(['rev-parse', 'HEAD']);
    if (head.code !== 0 || head.stdout.trim() !== release)
        throw new Error('The demo release differs from this checkout.');
    const tracked = await execute(['ls-files', '--error-unmatch', '--', ...REQUIRED_DEMO_ENTRIES]);
    const dirty = await execute(['status', '--porcelain=v1', '--untracked-files=all', '--', ...PUBLIC_RUNTIME]);
    if (tracked.code !== 0 || dirty.code !== 0 || dirty.stdout.trim())
        throw new Error('Demo setup needs clean, committed public runtime inputs.');
    const tree = await execute(['rev-parse', 'HEAD^{tree}']);
    if (tree.code !== 0 || !/^[a-f0-9]{40}$/u.test(tree.stdout.trim()))
        throw new Error('The demo source tree could not be verified.');
    return { release, tree: tree.stdout.trim() };
}
