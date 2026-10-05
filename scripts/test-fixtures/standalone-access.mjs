// Disposable OpenSSH access proof. Never reads the user's SSH configuration,
// keys or authorized_keys, and never starts the system SSH service.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { userInfo } from 'node:os';
import path from 'node:path';
import { processTree } from '../test-planted-address.mjs';

function command(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

function start(binary, args, children) {
  const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  const state = { child, output: '', exited: null };
  state.exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  child.stderr.on('data', bytes => { state.output += bytes.toString(); });
  children.push(state);
  return state;
}

function ready(state, pattern) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      state.child.stderr.off('data', check);
      state.child.off('close', closed);
      state.child.off('error', finish);
      error ? reject(error) : resolve();
    };
    const check = () => { if (pattern.test(state.output)) finish(); };
    const closed = () => finish(new Error(`SSH fixture exited before readiness: ${state.output}`));
    const timer = setTimeout(() => finish(new Error(`SSH fixture readiness timed out: ${state.output}`)), 10_000);
    state.child.stderr.on('data', check);
    state.child.once('close', closed);
    state.child.once('error', finish);
    check();
  });
}

async function stop(state) {
  if (state.child.exitCode !== null || state.child.signalCode !== null) return state.exited;
  state.child.kill('SIGTERM');
  const timer = setTimeout(() => state.child.kill('SIGKILL'), 5_000);
  try { return await state.exited; } finally { clearTimeout(timer); }
}

export function loopbackListeners(port) {
  const result = spawnSync('/usr/sbin/lsof', ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'], { encoding: 'utf8', timeout: 5_000 });
  assert.equal(result.status, 0, `listener ${port} could not be inspected: ${result.stderr}`);
  const addresses = result.stdout.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
  assert.ok(addresses.length > 0, `no listener at ${port}`);
  assert.ok(addresses.every(value => value === `127.0.0.1:${port}`), `non-loopback listener: ${addresses.join(', ')}`);
  return addresses;
}

/** Reuses the caller's real disposable Tower. Explicit opt-in requires the
 * maintained OpenSSH tools and an owned key directory with safe ancestors.
 * A shell is never allowed; only the selected Tower TCP destination is. */
export async function proveStandaloneTunnel({ origin, keysRoot, work }) {
  assert.ok(path.isAbsolute(keysRoot), 'NOTICEOS_TEST_SSH_ROOT must be an absolute owned directory');
  const target = new URL(origin);
  assert.equal(target.hostname, '127.0.0.1');
  const tools = { ssh: '/usr/bin/ssh', sshd: '/usr/sbin/sshd', keygen: '/usr/bin/ssh-keygen' };
  const base = mkdtempSync(path.join(keysRoot, 'ssh-access-'));
  chmodSync(base, 0o700);
  const children = [];
  let canary;
  let canaryRequests = 0;
  let result;
  let proofPorts = [];
  let ownedProcesses = [];
  try {
    for (const name of ['host', 'client', 'foreign']) command(tools.keygen, ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(base, name)]);
    writeFileSync(path.join(base, 'authorized_keys'), readFileSync(path.join(base, 'client.pub')), { mode: 0o600 });
    const sshPort = await freePort();
    const forwardPort = await freePort();
    const refusedPort = await freePort();
    canary = net.createServer(socket => {
      canaryRequests++;
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    });
    await new Promise((resolve, reject) => {
      canary.once('error', reject);
      canary.listen(0, '127.0.0.1', resolve);
    });
    const canaryPort = canary.address().port;
    proofPorts = [sshPort, forwardPort, refusedPort, canaryPort];
    const publicHost = readFileSync(path.join(base, 'host.pub'), 'utf8').trim().split(/\s+/u);
    const knownHosts = path.join(base, 'known_hosts');
    writeFileSync(knownHosts, `[127.0.0.1]:${sshPort} ${publicHost[0]} ${publicHost[1]}\n`, { mode: 0o600 });
    const config = path.join(base, 'sshd_config');
    writeFileSync(config, `Port ${sshPort}
ListenAddress 127.0.0.1
HostKey ${path.join(base, 'host')}
PidFile ${path.join(base, 'pid')}
AuthorizedKeysFile ${path.join(base, 'authorized_keys')}
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes yes
AllowUsers ${userInfo().username}
AllowTcpForwarding local
PermitOpen 127.0.0.1:${target.port}
MaxSessions 0
AllowStreamLocalForwarding no
AllowAgentForwarding no
X11Forwarding no
PermitTTY no
PermitUserRC no
GatewayPorts no
LogLevel VERBOSE
`, { mode: 0o600 });
    command(tools.sshd, ['-t', '-f', config]);
    const daemon = start(tools.sshd, ['-D', '-e', '-f', config], children);
    await ready(daemon, /Server listening on 127\.0\.0\.1/u);
    const common = ['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=2', '-p', String(sshPort)];
    const destination = `${userInfo().username}@127.0.0.1`;
    const foreign = spawnSync(tools.ssh, [...common, '-i', path.join(base, 'foreign'), '-T', destination, 'true'], { encoding: 'utf8', timeout: 5_000 });
    assert.equal(foreign.status, 255, foreign.stderr);
    assert.match(foreign.stderr, /Permission denied \(publickey\)/u);
    const client = start(tools.ssh, [...common, '-v', '-o', 'ExitOnForwardFailure=yes', '-i', path.join(base, 'client'), '-NT', '-L', `127.0.0.1:${forwardPort}:127.0.0.1:${target.port}`, '-L', `127.0.0.1:${refusedPort}:127.0.0.1:${canaryPort}`, destination], children);
    await ready(client, /Authenticated to 127\.0\.0\.1/u);
    ownedProcesses = children.flatMap(state => processTree(state.child.pid)).map(({ pid, ppid }) => ({ pid, ppid }));
    const listeners = [Number(target.port), sshPort, forwardPort, refusedPort].map(port => ({ port, addresses: loopbackListeners(port) }));
    let alternateInterfaceFailure;
    await assert.rejects(fetch(`http://127.0.0.2:${target.port}/api/settings`, {
      headers: { origin: target.origin, 'x-forwarded-for': '127.0.0.1' },
      signal: AbortSignal.timeout(3_000),
    }), error => {
      alternateInterfaceFailure = error.cause?.code ?? error.name;
      // macOS need not route every address in 127/8. Neither refusal nor a
      // bounded connect timeout is an HTTP answer; listener inspection above
      // independently pins the exact binding instead of inferring a firewall.
      return error.cause?.code === 'ECONNREFUSED' || error.name === 'TimeoutError';
    }, 'an alternate local interface cannot bypass the exact loopback bind');
    await assert.rejects(fetch(`http://127.0.0.1:${refusedPort}/`, { signal: AbortSignal.timeout(3_000) }));
    assert.equal(canaryRequests, 0, 'PermitOpen refuses the other origin before a connection');
    assert.match(client.output, /administratively prohibited/u);
    await work(`http://127.0.0.1:${forwardPort}/`);
    result = { fixture: base, tools, ports: { sshPort, forwardPort, refusedPort, canaryPort }, listeners, alternateInterfaceFailure, foreignKeyRefused: true, otherOriginRefused: true, authenticatedReadWrite: true, ownedProcesses };
  } finally {
    for (const state of children.slice().reverse()) await stop(state);
    if (canary) await new Promise(resolve => canary.close(resolve));
    for (const { pid } of ownedProcesses) {
      const inspected = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'pid='], { encoding: 'utf8', timeout: 5_000 });
      assert.equal(inspected.status, 1, `owned SSH process ${pid} remains or absence is unproven`);
      assert.equal(inspected.stdout, '');
      assert.equal(inspected.stderr, '');
    }
    for (const port of proofPorts) {
      const inspected = spawnSync('/usr/sbin/lsof', ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'], { encoding: 'utf8', timeout: 5_000 });
      assert.equal(inspected.status, 1, `SSH fixture listener remains or absence is unproven at ${port}: ${inspected.stdout}${inspected.stderr}`);
      assert.equal(inspected.stdout, '');
      assert.equal(inspected.stderr, '');
    }
    rmSync(base, { recursive: true, force: true });
  }
  return result;
}
