import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { launchAuditBrowser, resolveAuditBrowser, withAuditBrowser } from './audit-browser.mjs';
import { JOURNEY_BROWSERS } from '../apps/tower/e2e/journey-browsers.mjs';

function present(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function drain(pid) {
  if (!present(pid)) return;
  try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  const deadline = Date.now() + 3000;
  while (present(pid)) {
    if (Date.now() >= deadline) throw new Error(`Owned fixture group ${pid} remains; evidence retained.`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function fixture(t, mode = 'ready') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-audit-proof-'));
  const binary = path.join(root, 'browser');
  const trace = path.join(root, 'trace.json');
  t.after(async () => {
    try { await drain(JSON.parse(await fs.readFile(trace, 'utf8')).pid); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(binary, `#!${process.execPath}
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
const profile = process.argv.find(a => a.startsWith('--user-data-dir=')).split('=').slice(1).join('=');
fs.writeFileSync(${JSON.stringify(trace)}, JSON.stringify({ pid: process.pid, profile }));
${mode === 'exit' ? 'process.exit(7);' : ''}
${mode === 'ignore' ? "process.on('SIGTERM', () => {});" : ''}
${mode === 'refuse-tab' ? `const server = http.createServer((req, res) => { res.statusCode = 503; res.end(); });
server.listen(0, '127.0.0.1', () => fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), String(server.address().port)));` : ''}
${['ready', 'ignore'].includes(mode) ? "fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), '12345\\n');" : ''}
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  return { binary, trace, root };
}

async function retired(trace) {
  const { pid, profile } = JSON.parse(await fs.readFile(trace, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await assert.rejects(fs.stat(profile), { code: 'ENOENT' });
}

test('defaults use the shared cache and refuse a missing browser without fallback', async () => {
  let given;
  await assert.rejects(resolveAuditBrowser(null, { cache: JOURNEY_BROWSERS, lookup: async cache => {
    given = cache; return path.join(cache, 'missing-browser');
  } }), /testing browser is missing/);
  assert.equal(given, JOURNEY_BROWSERS);
  await assert.rejects(resolveAuditBrowser(null, { lookup: async () => process.execPath }), /testing browser is missing/);
});

test('an explicit installed cache is honored and --chrome is a deliberate override', async t => {
  const { root, binary } = await fixture(t);
  assert.equal(await resolveAuditBrowser(null, { cache: root, lookup: async cache => {
    assert.equal(cache, root); return binary;
  } }), binary);
  assert.equal(await resolveAuditBrowser('/explicit/browser', { lookup: () => { throw new Error('must not resolve'); } }), '/explicit/browser');
  await assert.rejects(resolveAuditBrowser(null, { cache: 'relative-cache', lookup: () => { throw new Error('must not resolve'); } }), /testing browser is missing/);
});

for (const mode of ['exit', 'timeout']) {
  test(`startup ${mode} awaits process retirement and removes only its profile`, async t => {
    const { binary, trace, root } = await fixture(t, mode);
    await assert.rejects(launchAuditBrowser(binary, { width: 390, height: 844 }, { launchMs: 400, stopMs: 500 }), /never opened/);
    await retired(trace);
    assert.equal((await fs.stat(root)).isDirectory(), true);
  });
}

test('a child ignoring TERM is escalated once, awaited, and repeated cleanup is idempotent', async t => {
  const { binary, trace } = await fixture(t, 'ignore');
  const probe = await launchAuditBrowser(binary, { width: 390, height: 844 }, { stopMs: 200 });
  const first = probe.kill();
  assert.equal(probe.kill(), first);
  await first;
  await retired(trace);
});

test('a missing launcher with no PID removes its newly created profile', async t => {
  const { root } = await fixture(t);
  const before = (await fs.readdir(os.tmpdir())).filter(name => name.startsWith('noticeos-audit-browser-'));
  await assert.rejects(launchAuditBrowser(path.join(root, 'missing'), { width: 390, height: 844 }), /never opened/);
  assert.deepEqual((await fs.readdir(os.tmpdir())).filter(name => name.startsWith('noticeos-audit-browser-')), before);
});

test('a signal during startup drains the newly acquired child', async t => {
  const { binary, trace, root } = await fixture(t, 'timeout');
  const signals = new EventEmitter();
  const previousExitCode = process.exitCode;
  const watching = setInterval(() => { fs.access(trace).then(() => signals.emit('SIGTERM'), () => {}); }, 20);
  try {
    await assert.rejects(withAuditBrowser(binary, { width: 390, height: 844 }, async () => {},
      { signals, attach: async () => { throw new Error('must not attach'); } }), /interrupted by SIGTERM/);
    await retired(trace);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
  } finally { clearInterval(watching); process.exitCode = previousExitCode; }
});

test('a signal during attachment retires once and closes a late attachment', async () => {
  const signals = new EventEmitter();
  const previousExitCode = process.exitCode;
  let finish, killed = 0, closed = 0;
  try {
    await assert.rejects(withAuditBrowser('fixture', {}, async () => { throw new Error('must not read'); }, {
      signals,
      launch: async () => ({ port: 1234, kill: async () => { killed++; } }),
      attach: async () => { signals.emit('SIGINT'); return new Promise(resolve => { finish = resolve; }); },
    }), /interrupted by SIGINT/);
    finish({ close() { closed++; } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, 1);
    assert.equal(killed, 1);
    assert.equal(signals.listenerCount('SIGINT'), 0);
  } finally { process.exitCode = previousExitCode; }
});

for (const fail of [false, true]) {
  test(`successful launch with ${fail ? 'failed' : 'successful'} measurement awaits cleanup`, async t => {
    const { binary, trace } = await fixture(t);
    const run = withAuditBrowser(binary, { width: 390, height: 844 }, async () => {
      if (fail) throw new Error('measurement failed');
      return 42;
    }, { attach: async () => ({ close() {} }) });
    if (fail) await assert.rejects(run, /measurement failed/);
    else assert.equal(await run, 42);
    await retired(trace);
  });
}

test('interruption retires the exact browser and removes its signal listeners', async t => {
  const { binary, trace } = await fixture(t);
  const signals = new EventEmitter();
  const previousExitCode = process.exitCode;
  try {
    await assert.rejects(withAuditBrowser(binary, { width: 390, height: 844 }, async () => {
      signals.emit('SIGTERM');
      return new Promise(() => {});
    }, { signals, attach: async () => ({ close() {} }) }), /interrupted by SIGTERM/);
    assert.equal(process.exitCode, 143);
    assert.equal(signals.listenerCount('SIGINT'), 0);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
    await retired(trace);
  } finally { process.exitCode = previousExitCode; }
});

test('repeated interruption remains handled until the single cleanup completes', async () => {
  const signals = new EventEmitter();
  const previousExitCode = process.exitCode;
  let cleanups = 0;
  try {
    await assert.rejects(withAuditBrowser('fixture', {}, async () => {
      signals.emit('SIGTERM');
      return new Promise(() => {});
    }, {
      signals, attach: async () => ({ close() {} }),
      launch: async () => ({ port: 1234, async kill() {
        cleanups++;
        assert.equal(signals.listenerCount('SIGTERM'), 1, 'interruption remains caught during awaited cleanup');
        signals.emit('SIGTERM');
        await new Promise(resolve => setImmediate(resolve));
      } }),
    }), /interrupted by SIGTERM/);
    assert.equal(cleanups, 1);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
  } finally { process.exitCode = previousExitCode; }
});

for (const tool of ['surface-audit.mjs', 'wall-fit-check.mjs']) {
  test(`${tool} uses awaited cleanup after a real child refuses DevTools attachment`, async t => {
    const { binary, trace } = await fixture(t, 'refuse-tab');
    const child = spawn(process.execPath, [new URL(tool, import.meta.url).pathname, '--chrome', binary],
      { detached: true, env: { PATH: process.env.PATH, TMPDIR: os.tmpdir(), NODE_OPTIONS: process.env.NODE_OPTIONS ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    let timer;
    try {
      const [code] = await Promise.race([
        new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (...args) => resolve(args)); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned audit CLI did not finish within 5000ms')), 5000); }),
      ]);
      assert.equal(code, 2, stderr);
      assert.match(stderr, /Chrome refused a new tab: 503/);
      await retired(trace);
    } finally { clearTimeout(timer); if (child.pid) await drain(child.pid); }
  });
}
