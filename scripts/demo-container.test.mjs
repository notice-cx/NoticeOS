import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import http from 'node:http';
import { demoPreparationConfig, prepareDemo } from '../deploy/demo/prepare.mjs';
import { demoHealth } from '../deploy/demo/health.mjs';
const ROOT = path.resolve(import.meta.dirname, '..');
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'n-demo-container-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const names = ['bootstrap', 'state', 'dolt', 'source', 'artifact'];
  for (const name of names) fs.mkdirSync(path.join(base, name), { mode: 0o700 });
  const config = { version: 1, publicOrigin: 'https://demo.example.test:18443', seed: 'fixture', cutoff: '2026-01-01T00:00:00.000Z', release: 'a'.repeat(40), serviceExpiresAt: new Date(Date.now() + 86400000).toISOString() };
  fs.writeFileSync(path.join(base, 'source/source-commit'), config.release + '\n');
  const configFile = path.join(base, 'config.json'); fs.writeFileSync(configFile, JSON.stringify(config));
  const binaryPath = path.join(base, 'bd'), doltBinaryPath = path.join(base, 'dolt-bin');
  fs.writeFileSync(binaryPath, 'synthetic pinned bd'); fs.writeFileSync(doltBinaryPath, 'synthetic pinned dolt');
  fs.writeFileSync(path.join(base, 'artifact/manifest.json'), JSON.stringify({ version: 1, release: 'b'.repeat(64) }));
  return { base, config, configFile, bootstrapRoot: path.join(base, 'bootstrap'), stateRoot: path.join(base, 'state'), doltRoot: path.join(base, 'dolt'), sourceRoot: path.join(base, 'source'), artifactRoot: path.join(base, 'artifact'), binaryPath, doltBinaryPath, uid: process.getuid(), gid: process.getgid() };
}
test('offline preparation separates admin inputs from empty app state and pins artifact/tools', t => {
  const own = fixture(t); const receipt = prepareDemo(own);
  assert.equal(receipt.artifactRelease, 'b'.repeat(64));
  assert.deepEqual(fs.readdirSync(own.stateRoot), []);
  const request = JSON.parse(fs.readFileSync(path.join(own.bootstrapRoot, 'bootstrap.json')));
  assert.equal(request.dolt.host, '127.0.0.1'); assert.equal(request.dolt.adminUser, 'noticeos_owner');
  assert.equal(new URL(request.postgres.adminUrl).hostname, 'postgres');
  assert.equal(new URL(request.postgres.adminUrl).searchParams.get('sslmode'), 'disable');
  assert.equal(request.release, 'a'.repeat(40)); assert.equal(request.serviceExpiresAt, own.config.serviceExpiresAt);
  assert.equal(request.binary.sha256.length, 64); assert.equal(request.doltBinary.sha256.length, 64);
  for (const file of fs.readdirSync(own.bootstrapRoot)) assert.equal(fs.statSync(path.join(own.bootstrapRoot, file)).mode & 0o777, 0o600);
  const before = fs.readFileSync(path.join(own.bootstrapRoot, 'bootstrap.json'));
  assert.deepEqual(prepareDemo(own), receipt); assert.deepEqual(fs.readFileSync(path.join(own.bootstrapRoot, 'bootstrap.json')), before);
});
test('changed preparation, partial volumes and symlink aliases refuse without overwriting', t => {
  const own = fixture(t); prepareDemo(own);
  const before = fs.readFileSync(path.join(own.bootstrapRoot, 'bootstrap.json'));
  fs.writeFileSync(own.configFile, JSON.stringify({ ...own.config, seed: 'changed' }));
  assert.throws(() => prepareDemo(own), /refused/); assert.deepEqual(fs.readFileSync(path.join(own.bootstrapRoot, 'bootstrap.json')), before);
  const wrongRelease = fixture(t); fs.writeFileSync(path.join(wrongRelease.sourceRoot, 'source-commit'), 'c'.repeat(40));
  assert.throws(() => prepareDemo(wrongRelease), /refused/); assert.deepEqual(fs.readdirSync(wrongRelease.bootstrapRoot), []);
  const partial = fixture(t); fs.writeFileSync(path.join(partial.stateRoot, 'partial'), 'preserve');
  assert.throws(() => prepareDemo(partial), /refused/); assert.equal(fs.readFileSync(path.join(partial.stateRoot, 'partial'), 'utf8'), 'preserve');
  const alias = fixture(t); const link = path.join(alias.base, 'alias'); fs.symlinkSync(alias.bootstrapRoot, link);
  assert.throws(() => prepareDemo({ ...alias, bootstrapRoot: link }), /refused/); assert.deepEqual(fs.readdirSync(alias.bootstrapRoot), []);
});
test('configuration demands canonical HTTPS, exact source commit and finite reviewed expiry', t => {
  const { config } = fixture(t);
  for (const change of [{ publicOrigin: 'http://demo.example.test' }, { publicOrigin: 'https://demo.example.test/' }, { release: 'main' }, { serviceExpiresAt: '2020-01-01T00:00:00.000Z' }, { serviceExpiresAt: new Date(Date.now() + 367 * 86400000).toISOString() }, { extra: true }]) assert.throws(() => demoPreparationConfig({ ...config, ...change }));
});
test('app health uses fixed Host and bounded request, and refuses unhealthy or malformed results', async t => {
  const own = fixture(t), file = path.join(own.stateRoot, 'runtime.json');
  fs.writeFileSync(file, JSON.stringify({ publicOrigin: own.config.publicOrigin, listen: { port: 8080 } }));
  assert.equal(await demoHealth(file, async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:8080/__noticeos_health'); assert.equal(options.headers.host, 'demo.example.test:18443'); assert.ok(options.signal);
    return Response.json({ ok: true });
  }), true);
  assert.equal(await demoHealth(file, async () => Response.json({ ok: false })), false);
  assert.equal(await demoHealth(file, async () => Response.json({ ok: true }, { status: 503 })), false);
});
test('native health dials loopback with the canonical public Host and bounds body completion', { timeout: 10000 }, async t => {
  const own = fixture(t), file = path.join(own.stateRoot, 'runtime.json');
  const seen = []; let reply = 'healthy';
  const sockets = new Set(), closed = [];
  const server = http.createServer((request, response) => {
    seen.push({ host: request.headers.host, url: request.url });
    if (request.headers.host !== 'demo.example.test:18443') { response.writeHead(400).end(); return; }
    if (reply === 'unhealthy') { response.writeHead(503).end('{"ok":true}'); return; }
    if (reply === 'redirect') { response.writeHead(302, { location: 'https://outside.example.test/' }).end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    if (reply === 'stalled') { response.flushHeaders(); return; }
    response.end(reply === 'malformed' ? 'not JSON' : reply === 'large' ? 'x'.repeat(16385) : '{"ok":true}');
  });
  server.on('connection', socket => {
    sockets.add(socket);
    closed.push(new Promise(resolve => socket.once('close', () => { sockets.delete(socket); resolve(); })));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  t.diagnostic(`Owned native health fixture: 127.0.0.1:${port}`);
  try {
    fs.writeFileSync(file, JSON.stringify({ publicOrigin: own.config.publicOrigin, listen: { port } }));
    assert.equal(await demoHealth(file), true);
    for (reply of ['unhealthy', 'redirect', 'malformed', 'large', 'stalled']) assert.equal(await demoHealth(file), false, reply);
    assert.equal(seen.length, 6);
    assert.ok(seen.every(request => request.host === 'demo.example.test:18443' && request.url === '/__noticeos_health'));
    await Promise.all(closed);
    assert.equal(sockets.size, 0, 'each native probe retires its socket before fixture cleanup');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.equal(server.listening, false);
    t.diagnostic(`Owned native health fixture closed: 127.0.0.1:${port}`);
  }
});
test('Compose exposes only loopback HTTP and gives no bootstrap volume to the app', () => {
  const text = fs.readFileSync(path.join(ROOT, 'deploy/demo/compose.yaml'), 'utf8');
  const section = name => text.split(`  ${name}:\n`)[1].split(/\n  [a-z]+:\n|\nnetworks:/u)[0];
  assert.match(section('app'), /network_mode: service:dolt/u); assert.match(section('setup'), /network_mode: service:dolt/u);
  assert.doesNotMatch(section('app'), /bootstrap|setup\/bootstrap|adminUrl|POSTGRES_PASSWORD/u);
  assert.doesNotMatch(section('postgres'), /ports:/u); assert.doesNotMatch(section('app'), /ports:/u);
  assert.match(section('postgres'), /networks: \[private\]/u);
  assert.match(section('dolt'), /networks: \[private, ingress\]/u);
  assert.match(text, /ingress:\n    driver: bridge/u);
  assert.match(section('dolt'), /127\.0\.0\.1:\$\{NOTICEOS_DEMO_HTTP_PORT/u);
  assert.match(text, /internal: true/u); assert.match(fs.readFileSync(path.join(ROOT, 'deploy/demo/dolt.yaml'), 'utf8'), /host: 127\.0\.0\.1/u);
  const doltStart = fs.readFileSync(path.join(ROOT, 'deploy/demo/dolt-start.mjs'), 'utf8');
  const globalConfig = JSON.parse(doltStart.match(/'(\{"metrics\.disabled"[^']+\})\\n'/u)[1]);
  assert.deepEqual(globalConfig, { 'metrics.disabled': 'true', 'versioncheck.disabled': 'true' });
  const image = fs.readFileSync(path.join(ROOT, 'deploy/demo/Dockerfile'), 'utf8');
  assert.match(image, /hosted-demo-build\.mjs --out/u); assert.doesNotMatch(image, /vite dev|COPY installation|os-supervisor/u);
  const ignore = fs.readFileSync(path.join(ROOT, 'deploy/demo/Dockerfile.dockerignore'), 'utf8');
  assert.equal(ignore.split('\n')[0], '**'); assert.match(ignore, /\*\*\/\.\*/u); assert.doesNotMatch(ignore, /!installation/u);
  // No documentation enters the image: the Tower embeds none of it.
  assert.doesNotMatch(ignore, /^!docs\//mu);
});

test('the update script keeps the README invariants: exact commit, dolt before app, fresh generations never purge, no raw store writes', () => {
  const file = path.join(ROOT, 'deploy/demo/update.sh');
  assert.ok(fs.statSync(file).mode & 0o100, 'update.sh is executable');
  const script = fs.readFileSync(file, 'utf8');
  assert.match(script, /^#!\/bin\/sh\n/u); assert.match(script, /^set -eu$/mu);
  assert.match(script, /\^\[0-9a-f\]\{40\}\$/u);
  assert.match(script, /NOTICEOS_SOURCE_COMMIT=\$COMMIT/u);
  const dolt = script.indexOf('--force-recreate dolt'), app = script.indexOf('--force-recreate app');
  assert.ok(dolt > 0 && app > dolt, 'dolt is recreated before app on a compatible swap');
  // A fresh generation follows the README's fresh-setup order on a NEW project; the old one is only stopped.
  assert.match(script, /run --rm --no-deps prepare[\s\S]*stop app dolt postgres[\s\S]*up -d --wait postgres dolt[\s\S]*run --rm setup[\s\S]*up -d --wait app/u);
  // `compose <env> <project> <file> <subcommand> …`: the subcommand is never down or rm.
  assert.ok(!script.split('\n').some(line => /^\s*compose\s+(?:"[^"]*"\s+){3}(?:down|rm)\b/u.test(line)), 'no generation is ever removed by the script');
  assert.doesNotMatch(script, /hosted-demo-setup|prepare\.mjs|psql|dolt sql/u);
  assert.match(script, /__noticeos_health/u);
  // Deploy semantics live in scripts/demo-update.test.mjs against stubbed docker and curl.
});
