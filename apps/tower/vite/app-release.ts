import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { APP_RELEASE_HEADER, APP_RELEASE_PATH, isAppApiPath, releaseMismatch } from '../shared/app-release';

const SOURCE_TREES = ['apps/tower', 'workers/ingest', 'packages', 'scripts'];
const ROOT_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json'];
const SKIP = new Set(['node_modules', 'dist', 'coverage', 'artifacts', 'test-results', 'playwright-report', 'test', 'tests', 'e2e', '__snapshots__']);
const SOURCE = /\.(?:[cm]?[jt]sx?|jsonc?|ya?ml|css|html)$/u;

/** Stable in a clone, source archive and container: no Git, settings/default
 * data, installation files, timestamps, dependency scan or random build ID.
 * Configuration values aren't a protocol version; their reader/types are. */
export function sourceAppRelease(root: string): string {
  const files = [...ROOT_FILES];
  function walk(relative: string) {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (SOURCE.test(entry.name) && !/\.(?:test|spec)\./u.test(entry.name)) {
        if (!entry.isFile()) throw new Error('Release source must contain regular files.');
        files.push(file);
      }
    }
  }
  for (const tree of SOURCE_TREES) walk(tree);
  const hash = createHash('sha256').update('noticeos-app-release/1\0');
  let bytes = 0;
  for (const file of files.sort()) {
    const target = path.join(root, file);
    const stat = lstatSync(target);
    bytes += stat.size;
    if (!stat.isFile() || bytes > 64 * 1024 * 1024) throw new Error('Release source exceeds its bounded inventory.');
    hash.update(file).update('\0').update(String(stat.size)).update('\0').update(readFileSync(target));
  }
  return hash.digest('hex');
}

/** The source-run Node lanes answer before the Worker, so they share the
 * exact same pre-effect check and server-owned response identity. */
export function appReleaseLane(release: string): Plugin {
  return {
    name: 'noticeos-app-release', enforce: 'pre', apply: 'serve',
    configureServer: { order: 'pre', handler(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
        if (!isAppApiPath(pathname)) return next();
        response.setHeader(APP_RELEASE_HEADER, release);
        const value = request.headers[APP_RELEASE_HEADER];
        const client = typeof value === 'string' ? value : value === undefined ? null : '';
        if (!releaseMismatch(client, release)) {
          if (pathname !== APP_RELEASE_PATH) return next();
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ release }));
          return;
        }
        response.statusCode = 409;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ error: 'app_release_changed' }));
      });
    } },
  };
}
