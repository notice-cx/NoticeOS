// @vitest-environment node
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, symlinkSync, statfsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer, type Plugin, type ViteDevServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { appReleaseLane, sourceAppRelease } from '../vite/app-release';
import { APP_RELEASE_HEADER } from '../shared/app-release';
import { createTestViteServer } from '../../../scripts/test-vite-server.mjs';

const roots: string[] = [];
const servers: ViteDevServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const space = statfsSync(os.tmpdir());
  if (space.bavail * space.bsize < 8 * 1024 ** 3 + 16 * 1024 ** 2) throw new Error('Insufficient test space');
  const root = mkdtempSync(path.join(os.tmpdir(), 'noticeos-release-test-')); roots.push(root);
  const put = (name: string, text: string) => { mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), text); };
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json']) put(name, '{}');
  for (const name of ['apps/tower/client.ts', 'workers/ingest/worker.ts', 'packages/contract/schema.ts', 'scripts/server.mts']) put(name, 'export const version = 1;');
  return { root, put };
}

describe('release identity from source', () => {
  it('keeps mounted development modules compatible across independent hot updates', () => {
    const { root, put } = fixture();
    const deployed = sourceAppRelease(root);
    const development = sourceAppRelease(root, { liveSource: true });
    expect(development).toMatch(/^[a-f0-9]{64}$/u);
    expect(development).not.toBe(deployed);
    put('apps/tower/client.ts', 'export const version = 2;');
    expect(sourceAppRelease(root, { liveSource: true })).toBe(development);
    expect(sourceAppRelease(root)).not.toBe(deployed);
    put('workers/ingest/worker.ts', 'export const version = 3;');
    expect(sourceAppRelease(root, { liveSource: true })).toBe(development);
  });
  it('is reproducible across locations/timestamps and ignores configuration, tests, dependencies and build output', () => {
    const a = fixture(), b = fixture();
    const release = sourceAppRelease(a.root);
    expect(release).toMatch(/^[a-f0-9]{64}$/u);
    utimesSync(path.join(b.root, 'apps/tower/client.ts'), new Date(0), new Date(0));
    expect(sourceAppRelease(b.root)).toBe(release);
    for (const name of ['config/values.json', 'installation/private.json', 'apps/tower/.dev.vars',
      'apps/tower/test/check.ts', 'apps/tower/client.test.ts', 'apps/tower/dist/built.js',
      'apps/tower/node_modules/package/index.js']) b.put(name, 'not a release input');
    expect(sourceAppRelease(b.root)).toBe(release);
    b.put('packages/contract/schema.ts', 'export const version = 2;');
    expect(sourceAppRelease(b.root)).not.toBe(release);
    b.put('packages/contract/schema.ts', 'export const version = 1;');
    b.put('pnpm-lock.yaml', 'changed dependency graph');
    expect(sourceAppRelease(b.root)).not.toBe(release);
  });
  it('refuses a missing source root and a source-file link outside its inventory', () => {
    const { root } = fixture();
    rmSync(path.join(root, 'packages'), { recursive: true });
    expect(() => sourceAppRelease(root)).toThrow();
    mkdirSync(path.join(root, 'packages'));
    symlinkSync(path.join(root, 'package.json'), path.join(root, 'packages/linked.ts'));
    expect(() => sourceAppRelease(root)).toThrow('regular files');
  });
});

describe('real Vite native lanes', () => {
  it('checks release before an earlier registered native effect lane and labels every API response', async () => {
    const { root } = fixture();
    const release = sourceAppRelease(root);
    let effects = 0;
    const native: Plugin = { name: 'synthetic-native-tasks', enforce: 'pre', configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith('/api/tasks')) return next();
        effects++;
        response.statusCode = 403; response.end('authority still refused');
      });
    } };
    const server = await createTestViteServer(createServer, { root, configFile: false, envDir: false,
      logLevel: 'silent', plugins: [native, appReleaseLane(release)], server: { host: '127.0.0.1', port: 0, hmr: false } }, { pages: false });
    servers.push(server);
    await server.listen();
    const address = server.httpServer?.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    for (const value of ['malformed', '0'.repeat(64)]) {
      const reply = await fetch(origin + '/api/tasks', { method: 'POST', headers: { [APP_RELEASE_HEADER]: value } });
      expect(reply.status).toBe(409); expect(reply.headers.get(APP_RELEASE_HEADER)).toBe(release);
      await reply.body?.cancel();
    }
    expect(effects).toBe(0);
    for (const headers of [new Headers(), new Headers({ [APP_RELEASE_HEADER]: release })]) {
      const reply = await fetch(origin + '/api/tasks', { method: 'POST', headers });
      expect(reply.status).toBe(403); expect(await reply.text()).toBe('authority still refused');
      expect(reply.headers.get(APP_RELEASE_HEADER)).toBe(release);
    }
    expect(effects).toBe(2);
    const metadata = await fetch(origin + '/api/app-release');
    expect(await metadata.json()).toEqual({ release }); expect(effects).toBe(2);
  });
});
