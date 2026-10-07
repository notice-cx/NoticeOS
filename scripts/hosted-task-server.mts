/** Explicit Node/Vite hosted entry. It never uses standalone host setup.
 * Worker profiles must agree with the private server composition before any
 * identity connection or HTTP listener opens. Remote deployment is separate.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { readFileSync, openSync, closeSync, fstatSync, constants, realpathSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { stripJsonc } from './jsonc.mjs';
import { PRODUCT_ENV } from './product-env.mjs';
import { openHostedTaskRuntime, captureHostedTaskRuntimeOptions, type HostedTaskRuntimeOptions, type HostedTaskRuntime } from './hosted-task-runtime.mjs';
import { MCP_PATH, READ_MODELS_HEADER } from './hosted-mcp.mjs';

interface ViteServer {
  listen(): Promise<unknown>;
  close(): Promise<void>;
}
export interface HostedTaskViteOptions {
  readonly root: string;
  readonly configFile: string;
  readonly plugins: readonly ReturnType<typeof hostedTasksPlugin>[];
  readonly logLevel: 'error';
  readonly server: { readonly host: '127.0.0.1'; readonly port: number; readonly strictPort: true; readonly open: false };
}
interface MiddlewareServer {
  middlewares: { use(work: (request: IncomingMessage, response: ServerResponse, next: () => void) => void): void };
}
function refused(): never { throw new Error('Hosted Tasks server configuration refused'); }
/** Resolve the same public Wrangler variables as the final Vite binding. The
 * native executor and Worker bootstrap must never authenticate different
 * sessions while appearing to be one entry. Values stay inside this process. */
async function checkWorkerIdentity(configRoot: string, runtime: HostedTaskRuntimeOptions): Promise<void> {
  const require = createRequire(new URL('../apps/tower/package.json', import.meta.url));
  const loader = await import(require.resolve('wrangler')) as {
    unstable_getVarsForDev(configPath: string, files: undefined, vars: Record<string, unknown>, environment: string | undefined, silent: boolean): Record<string, { value: unknown }>;
  };
  for (const relative of ['apps/tower/wrangler.jsonc', 'workers/ingest/wrangler.jsonc']) {
    const filename = path.join(configRoot, relative);
    const config = JSON.parse(stripJsonc(readFileSync(filename, 'utf8'))) as Record<string, unknown>;
    const environment = process.env.CLOUDFLARE_ENV;
    const selected = environment === undefined ? config
      : (config.env as Record<string, Record<string, unknown>> | undefined)?.[environment];
    if (!selected || !selected.vars || typeof selected.vars !== 'object' || Array.isArray(selected.vars)) refused();
    const resolved = loader.unstable_getVarsForDev(filename, undefined, selected.vars as Record<string, unknown>, environment, true);
    for (const [key, expected] of [
      [PRODUCT_ENV.workspaceOrigin.name, runtime.trustedOrigin],
      [PRODUCT_ENV.identityDatabase.name, runtime.identity.connectionString],
      [PRODUCT_ENV.identitySecret.name, runtime.identity.sessionSecret],
      ...(runtime.profile === 'demo' ? [[PRODUCT_ENV.demoWorkspace.name, runtime.demoWorkspaceId]] : []),
    ]) if (resolved[key!]?.value !== expected) refused();
  }
}
/** The actual native middleware never delegates a recognized task request to
 * a Worker or standalone lane. Host/target comes from the real native request;
 * forwarded Host/profile/actor/context headers confer no authority. */
export function hostedTasksPlugin(runtime: HostedTaskRuntime) {
  if (!runtime || !['hosted', 'demo'].includes(runtime.profile) || typeof runtime.handle !== 'function') refused();
  return {
    name: 'noticeos:hosted-tasks', enforce: 'pre' as const, apply: 'serve' as const,
    configureServer(server: MiddlewareServer) {
      server.middlewares.use((incoming, outgoing, next) => {
        const route = incoming.url?.split('?')[0] ?? '';
        // The one MCP endpoint is answered here; its own forwarded read-model
        // call goes on to the Worker.
        const mcp = route === MCP_PATH && incoming.headers[READ_MODELS_HEADER] === undefined;
        if (!mcp && route !== '/api/tasks' && !route.startsWith('/api/tasks/') && !route.startsWith('/api/gates/')) { next(); return; }
        const abort = new AbortController();
        const stop = () => abort.abort();
        const disconnected = () => { if (!outgoing.writableEnded) stop(); };
        incoming.once('aborted', stop); outgoing.once('close', disconnected);
        void (async () => {
          try {
            // Native HTTPS uses its socket; an unqualified proxy cannot assert
            // transport using X-Forwarded-* headers. Initially proof is loopback.
            const tls = 'encrypted' in incoming.socket && incoming.socket.encrypted === true;
            const target = new URL(incoming.url ?? '', `${tls ? 'https' : 'http'}://${incoming.headers.host ?? ''}`);
            const headers = new Headers();
            for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
            const method = incoming.method ?? '';
            const original = new Request(target, { method, headers, signal: abort.signal,
              ...(['GET', 'HEAD'].includes(method) ? {} : { body: Readable.toWeb(incoming), duplex: 'half' }) } as RequestInit);
            const response = await runtime.handle(original);
            if (abort.signal.aborted || outgoing.destroyed) { await response.body?.cancel(); return; }
            outgoing.writeHead(response.status, Object.fromEntries(response.headers));
            outgoing.end(await response.text());
          } catch {
            if (abort.signal.aborted || outgoing.destroyed) return;
            if (!outgoing.headersSent) outgoing.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            if (!outgoing.writableEnded) outgoing.end('{"error":"invalid_hosted_task_request"}');
          } finally { incoming.off('aborted', stop); outgoing.off('close', disconnected); }
        })();
      });
    },
  };
}

/** Private file is operator-supplied composition, not tenant input or a secret
 * fallback. Regular canonical owner-only files prevent accidental public use. */
export function readHostedTaskRuntimeFile(filename: string): HostedTaskRuntimeOptions {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) refused();
  if (realpathSync(filename) !== path.resolve(filename)) refused();
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 1024 * 1024) refused();
    return JSON.parse(readFileSync(fd, 'utf8')) as HostedTaskRuntimeOptions;
  } catch { refused(); } finally { closeSync(fd); }
}
export async function startHostedTaskServer(options: {
  readonly runtime: HostedTaskRuntimeOptions;
  /** Explicit trusted configs; no installation/default root fallback. */
  readonly workerConfigRoot: string;
  /** Trusted composition seam for local fixture config rebinding. Not read
   * from runtime JSON, environment, requests, or the command-line interface. */
  readonly createViteServer?: (options: HostedTaskViteOptions) => Promise<ViteServer>;
}): Promise<{ readonly runtime: HostedTaskRuntime; close(): Promise<void> }> {
  const root = path.resolve(import.meta.dirname, '..');
  if (!options || typeof options.workerConfigRoot !== 'string' || !path.isAbsolute(options.workerConfigRoot)
    || !options.runtime || !['hosted', 'demo'].includes(options.runtime.profile)) refused();
  const configuration = captureHostedTaskRuntimeOptions(options.runtime);
  const configRoot = realpathSync(options.workerConfigRoot);
  if (configRoot !== path.resolve(options.workerConfigRoot)) refused();
  // Use the same actual selector implementation as Vite's final Worker binding.
  const profileModule = await import(new URL('../apps/tower/vite/workspace-profile.ts', import.meta.url).href) as {
    serverWorkspaceProfile(configs: readonly unknown[], env: Readonly<Record<string, string | undefined>>): string;
    workspaceDevSecretKeys(configPath: string, profile: 'hosted' | 'demo', environment?: string): string[];
  };
  const configs = ['apps/tower/wrangler.jsonc', 'workers/ingest/wrangler.jsonc'].map(relative =>
    JSON.parse(stripJsonc(readFileSync(path.join(configRoot, relative), 'utf8'))) as unknown);
  const profile = profileModule.serverWorkspaceProfile(configs, process.env);
  if (profile !== configuration.profile) refused();
  for (const relative of ['apps/tower/wrangler.jsonc', 'workers/ingest/wrangler.jsonc']) {
    profileModule.workspaceDevSecretKeys(path.join(configRoot, relative), configuration.profile, process.env.CLOUDFLARE_ENV);
  }
  await checkWorkerIdentity(configRoot, configuration);
  const url = new URL(configuration.trustedOrigin);
  // The currently qualified executor's plaintext path is native adjacent only.
  // This entry does not silently claim remote proxy/TLS deployment support.
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) refused();
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) refused();
  const configSelector = PRODUCT_ENV.workerConfigRoot.name;
  if (process.env[configSelector] !== undefined && path.resolve(process.env[configSelector]!) !== configRoot) refused();
  // The operator's private runtime scratch owns Worker state too. Never use
  // the checkout's default .wrangler tree or adopt an unknown prior selector.
  const persistSelector = 'OS_UP_PERSIST_STATE';
  const persistRoot = path.join(configuration.scratchRoot, 'worker-state');
  if (process.env[persistSelector] !== undefined && process.env[persistSelector] !== persistRoot) refused();
  const profileSelector = PRODUCT_ENV.workspaceProfile.name;
  const previousConfig = process.env[configSelector], previousProfile = process.env[profileSelector], previousPersist = process.env[persistSelector];
  process.env[configSelector] = configRoot;
  process.env[profileSelector] = profile;
  process.env[persistSelector] = persistRoot;
  const restoreSelectors = () => {
    // A second independent composition cannot be silently overwritten.
    if (process.env[configSelector] === configRoot) {
      if (previousConfig === undefined) delete process.env[configSelector]; else process.env[configSelector] = previousConfig;
    }
    if (process.env[profileSelector] === profile) {
      if (previousProfile === undefined) delete process.env[profileSelector]; else process.env[profileSelector] = previousProfile;
    }
    if (process.env[persistSelector] === persistRoot) {
      if (previousPersist === undefined) delete process.env[persistSelector]; else process.env[persistSelector] = previousPersist;
    }
  };
  let runtime: HostedTaskRuntime | undefined, server: ViteServer | undefined;
  try {
    // Read-model MCP calls reach the Worker through this same server.
    runtime = await openHostedTaskRuntime(configuration, { readModels: request => fetch(request) });
    const createViteServer = options.createViteServer ?? (async (inline: HostedTaskViteOptions) => {
      const require = createRequire(path.join(root, 'apps/tower/package.json'));
      const vite = await import(require.resolve('vite')) as { createServer(options: object): Promise<ViteServer> };
      return vite.createServer(inline);
    });
    server = await createViteServer({ root: path.join(root, 'apps/tower'), configFile: path.join(root, 'apps/tower/vite.config.ts'),
      plugins: [hostedTasksPlugin(runtime)], logLevel: 'error',
      server: { host: '127.0.0.1', port, strictPort: true, open: false } });
    await server.listen();
    const startedRuntime = runtime, startedServer = server;
    let closing: Promise<void> | undefined;
    return Object.freeze({ runtime: startedRuntime, close() {
      closing ??= (async () => {
        // Stop native requests first; then await admitted work and owned pools.
        try { await startedServer.close(); } finally { try { await startedRuntime.close(); } finally { restoreSelectors(); } }
      })(); return closing;
    } });
  } catch {
    // A synchronous close failure must not prevent the other owned resource
    // from closing or the private selector restoration.
    await Promise.allSettled([Promise.resolve().then(() => server?.close()), Promise.resolve().then(() => runtime?.close())]);
    restoreSelectors(); refused();
  }
}
