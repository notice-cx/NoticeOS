import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  classifyRunnerState,
  codeLine,
  disabledLabelHint,
  ENABLE_TARGETS,
  enableLeftServiceEnabled,
  inspectCode,
  inspectRunner,
  installLoadFailedMessage,
  installRuntimeRefusal,
  LABEL,
  listingShowsLabelDisabled,
  parseLaunchctlPrint,
  powerUp,
  renderLaunchAgent,
  reinstallTaskStoreRefusal,
  replaceService,
  resolveStartAction,
  resolveStartResult,
  resolveStopAction,
  resolveStopResult,
  restartAndWait,
  statusLines,
  storeLine,
  STOP_WAIT_MS,
  waitForHealthy,
} from './os-control.mjs';
import { redactLogText } from './os-log.mjs';
import { plistRunsFrom, runtimeLayout } from './os-runtime.mjs';
import { lateWritingCommand, withPathOf } from './test-late-command.mjs';
import { runCommand } from './run-command.mjs';

// The service's label depends on this Mac: the pre-rename label where a service
// from before the NoticeOS rename is installed, com.noticeos.local elsewhere
// (scripts/resource-names.mts). Every expectation below reads it.
const LABEL_RE = LABEL.replaceAll('.', '\\.');

const NOW = Date.parse('2026-08-04T12:00:00.000Z');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const healthyInputs = {
  service: { loaded: true, state: 'running', pid: 42, lastExitCode: 0 },
  ingest: { ok: true, status: 200 },
  tower: { ok: true, status: 200 },
  heartbeat: { status: 'healthy', updatedAt: '2026-08-04T11:59:30.000Z' },
  dependencies: { postgres: { state: 'ready' }, dolt: { state: 'ready' } },
  nowMs: NOW,
};

test('status distinguishes all five operator states', () => {
  assert.equal(classifyRunnerState(healthyInputs).state, 'healthy');
  assert.equal(
    classifyRunnerState({
      ...healthyInputs,
      ingest: { ok: false },
      tower: { ok: false },
      heartbeat: { status: 'starting', updatedAt: '2026-08-04T11:59:59.000Z' },
    }).state,
    'starting',
  );
  assert.equal(
    classifyRunnerState({
      ...healthyInputs,
      heartbeat: { status: 'healthy', updatedAt: '2026-08-04T11:57:00.000Z' },
    }).state,
    'stale',
  );
  assert.equal(
    classifyRunnerState({ ...healthyInputs, service: { loaded: false }, heartbeat: null }).state,
    'unhealthy',
    'an answering but unsupervised runtime is not healthy',
  );
  assert.equal(
    classifyRunnerState({
      ...healthyInputs,
      service: { loaded: false },
      ingest: { ok: false },
      tower: { ok: false },
      heartbeat: null,
    }).state,
    'stopped',
  );
});

test('status output makes the classified state the first readable fact', () => {
  const status = {
    ...classifyRunnerState(healthyInputs),
    checkedAt: new Date(NOW).toISOString(),
    service: healthyInputs.service,
    ingest: healthyInputs.ingest,
    tower: healthyInputs.tower,
    heartbeat: healthyInputs.heartbeat,
  };
  const lines = statusLines(status);
  assert.match(lines[0], /^● NoticeOS HEALTHY/u);
  assert.match(lines.join('\n'), /supervisor\s+running · pid 42/u);
});

test('answering processes remain live while either database is down, unknown, or timed out', async () => {
  for (const [postgres, dolt] of [
    ['unavailable', 'unavailable'], ['ready', 'unavailable'], ['unavailable', 'ready'],
    ['timeout', 'ready'], ['ready', 'timeout'], ['unknown', 'ready'], ['ready', 'unknown'],
  ]) {
    const dependencies = { postgres: { state: postgres }, dolt: { state: dolt } };
    const status = await inspectRunner(NOW, {
      readService: async () => healthyInputs.service,
      probeHttp: async () => ({ ok: true, status: 200 }),
      readHeartbeat: async () => healthyInputs.heartbeat,
      readDependencies: async () => dependencies,
    });
    assert.equal(status.state, 'unhealthy');
    assert.equal(status.liveness.state, 'healthy');
    assert.deepEqual(status.dependencies, dependencies);
    assert.match(statusLines(status).join('\n'), new RegExp(`PostgreSQL  ${postgres}`));
    assert.match(statusLines(status).join('\n'), new RegExp(`tasks       ${dolt}`));
  }
  assert.equal(classifyRunnerState({ ...healthyInputs, dependencies: undefined }).state, 'unhealthy');
  assert.equal(classifyRunnerState(healthyInputs).state, 'healthy', 'a later ready read recovers without sticky failures');
});

test('database readiness does not overwrite stopped, starting, or stale process evidence', () => {
  const dependencies = { postgres: { state: 'unavailable' }, dolt: { state: 'timeout' } };
  assert.equal(classifyRunnerState({ ...healthyInputs, dependencies,
    service: { loaded: false }, ingest: { ok: false }, tower: { ok: false } }).state, 'stopped');
  assert.equal(classifyRunnerState({ ...healthyInputs, dependencies,
    heartbeat: { status: 'starting' } }).state, 'starting');
  assert.equal(classifyRunnerState({ ...healthyInputs, dependencies,
    heartbeat: { status: 'healthy', updatedAt: '2026-08-04T11:57:00.000Z' } }).state, 'stale');
});

test('start/restart/deploy health waits require database recovery as well as a new live runner', async () => {
  let checks = 0;
  const inputs = { ...healthyInputs, heartbeat: { ...healthyInputs.heartbeat, pid: 43 } };
  const recovered = await waitForHealthy('restart', { previousPid: 42, timeoutMs: 500, pollMs: 1,
    readLog: async () => assert.fail('successful recovery needs no log read'),
    inspect: async () => {
      checks += 1;
      const dependencies = checks === 1
        ? { postgres: { state: 'ready' }, dolt: { state: 'timeout' } } : healthyInputs.dependencies;
      return { ...classifyRunnerState({ ...inputs, dependencies }), heartbeat: inputs.heartbeat, dependencies };
    },
  });
  assert.equal(checks, 2);
  assert.equal(recovered.state, 'healthy');
  assert.deepEqual(recovered.dependencies, healthyInputs.dependencies);
});

test('launchctl state is parsed without exposing the raw service dump', () => {
  assert.deepEqual(
    parseLaunchctlPrint(`gui/501/${LABEL} = {\n\tstate = running\n\truns = 3\n\tpid = 321\n\tlast exit code = 0\n}`),
    { loaded: true, state: 'running', pid: 321, runs: 3, lastExitCode: 0 },
  );
});

test('persistent and diagnostic logs redact common credential shapes', () => {
  const input = [
    'Authorization: Bearer abc.def-123',
    'https://provider.test/x?api_key=visible&safe=yes',
    'password="hunter2" token: abc123 cookie=session-value',
    '{"skippedNoToken":0,"tokensPerDay":{"consumed":5}}',
    '-----BEGIN PRIVATE KEY-----\nsecret bytes\n-----END PRIVATE KEY-----',
    'connecting to postgresql://noticeos_app:url-pass-1@127.0.0.1:5432/noticeos?sslmode=disable',
    '{"DATABASE_URL":"postgres://noticeos_app:url-pass-2@db.example.com/noticeos"}',
  ].join('\n');
  const output = redactLogText(input);
  for (const secret of ['abc.def-123', 'visible', 'hunter2', 'abc123', 'session-value', 'secret bytes', 'url-pass-1', 'url-pass-2']) {
    assert.doesNotMatch(output, new RegExp(secret, 'u'));
  }
  assert.match(output, /postgresql:\/\/noticeos_app:\[REDACTED\]@127\.0\.0\.1:5432\/noticeos\?sslmode=disable/u);
  assert.match(output, /https:\/\/provider\.test\/x\?/u, 'a URL with no password is left alone');
  assert.match(output, /safe=yes/u);
  assert.match(output, /"skippedNoToken":0/u);
  assert.match(output, /"tokensPerDay":\{"consumed":5\}/u);
});

test('launch-agent generation resolves every path and keeps stdout duplication disabled', () => {
  const template = [
    '<string>__NODE_PATH__</string>',
    '<string>__NODE_BIN_DIR__</string>',
    '<string>__RUNTIME_ROOT__/scripts/os-up.mjs</string>',
    '<string>__HOME_ROOT__</string>',
    '<string>/dev/null</string>',
  ].join('\n');
  const output = renderLaunchAgent(template, {
    nodePath: '/opt/homebrew/bin/node',
    nodeBinDir: '/opt/homebrew/bin',
    runtimeRoot: '/Users/operator/Reindex & OS/.local/runtime/current',
    homeRoot: '/Users/operator/Reindex & OS',
  });
  assert.doesNotMatch(output, /__[A-Z0-9_]+__/u);
  assert.match(output, /\/opt\/homebrew\/bin\/node/u);
  assert.match(output, /Reindex &amp; OS\/\.local\/runtime\/current\/scripts\/os-up\.mjs/u);
  assert.match(output, /<string>\/Users\/operator\/Reindex &amp; OS<\/string>/u);
  assert.match(output, /\/dev\/null/u);
});

// The real template: launchd runs the runtime copy through its `current` link,
// so a deploy moves the service without rewriting the plist, and names the
// home checkout so the runner keeps home's state.
test('the installed service runs the runtime copy and is told where home is', () => {
  const template = readFileSync(path.join(REPO_ROOT, 'scripts', 'launchd', 'local-service.plist'), 'utf8');
  const home = '/Users/operator/dev/reindex-os';
  const output = renderLaunchAgent(template, {
    nodePath: '/opt/homebrew/bin/node',
    nodeBinDir: '/opt/homebrew/bin',
    runtimeRoot: runtimeLayout(home).current,
    homeRoot: home,
  });
  assert.match(output, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/opt\/homebrew\/bin\/node<\/string>\s*<string>\/Users\/operator\/dev\/reindex-os\/\.local\/runtime\/current\/scripts\/os-up\.mjs<\/string>/u);
  assert.match(output, /<key>WorkingDirectory<\/key>\s*<string>\/Users\/operator\/dev\/reindex-os\/\.local\/runtime\/current<\/string>/u);
  assert.match(output, /<key>NOTICEOS_HOME<\/key>\s*<string>\/Users\/operator\/dev\/reindex-os<\/string>/u);
  assert.match(output, /<key>NOTICEOS_MANAGED<\/key>\s*<string>1<\/string>/u);
  // Rendered under this Mac's label, so a reinstall of a pre-rename service
  // keeps its label (scripts/resource-names.mts).
  assert.match(output, new RegExp(String.raw`<key>Label</key>\s*<string>${LABEL_RE}</string>`, 'u'));
  assert.equal(plistRunsFrom(output, home), 'runtime');
});

test('launch-agent task-store selection is omitted unless explicitly declared and rejects invalid paths', () => {
  const template = readFileSync(path.join(REPO_ROOT, 'scripts', 'launchd', 'local-service.plist'), 'utf8');
  const options = { nodePath: '/tools/bin/node', nodeBinDir: '/tools/bin', runtimeRoot: '/installation/.local/runtime/current', homeRoot: '/installation' };
  assert.doesNotMatch(renderLaunchAgent(template, options), /<key>NOTICEOS_DOLT_HOME<\/key>/u);
  for (const doltHome of ['', 'relative/tasks', null, '/tasks\u0000invalid', '/tasks\ninvalid']) {
    assert.throws(() => renderLaunchAgent(template, { ...options, doltHome }), /absolute installation folder/u);
  }
  const selected = renderLaunchAgent(template, { ...options, doltHome: '/installation/Tasks & Work' });
  assert.match(selected, /<key>NOTICEOS_DOLT_HOME<\/key>\s*<string>\/installation\/Tasks &amp; Work<\/string>/u);
  assert.equal(selected.match(/<key>NOTICEOS_DOLT_HOME<\/key>/gu)?.length, 1);
  assert.doesNotMatch(selected, /BEADS_DOLT_SERVER_|BEADS_CREDENTIALS_FILE|NOTICEOS_TASK_CLIENT_PROFILE/u);
  assert.ok(renderLaunchAgent(template, { ...options, doltHome: "/installation/$& $` $' $$" })
    .includes("<string>/installation/$&amp; $` $&apos; $$</string>"), 'valid dollar characters remain literal during rendering');
});

test('repeat installation refuses to erase an installed task-store selection when its env is unset', () => {
  const template = readFileSync(path.join(REPO_ROOT, 'scripts', 'launchd', 'local-service.plist'), 'utf8');
  const options = { nodePath: '/tools/bin/node', nodeBinDir: '/tools/bin', runtimeRoot: '/installation/.local/runtime/current', homeRoot: '/installation' };
  const selected = renderLaunchAgent(template, { ...options, doltHome: '/installation/.local/task-compose' });
  assert.match(reinstallTaskStoreRefusal(selected, undefined), /approved NOTICEOS_DOLT_HOME; nothing was changed/u);
  assert.equal(reinstallTaskStoreRefusal(selected, '/installation/.local/task-compose'), null);
  assert.equal(reinstallTaskStoreRefusal(renderLaunchAgent(template, options), undefined), null);
  assert.equal(reinstallTaskStoreRefusal(null, undefined), null);
});

test('a declared task-store selector survives service reload and reaches its Node child', async () => {
  const template = readFileSync(path.join(REPO_ROOT, 'scripts', 'launchd', 'local-service.plist'), 'utf8');
  const doltHome = '/synthetic-installation/.local/task-compose';
  const rendered = renderLaunchAgent(template, { nodePath: process.execPath, nodeBinDir: path.dirname(process.execPath), runtimeRoot: '/synthetic-installation/.local/runtime/current', homeRoot: '/synthetic-installation', doltHome });
  const launchd = asyncBootoutLaunchd({ lingerPolls: 0 });
  let persisted;
  const children = [];
  const reload = async (args) => {
    const result = await launchd.launchctl(args);
    if (args[0] === 'bootstrap' && result.code === 0) {
      const value = persisted.match(/<key>NOTICEOS_DOLT_HOME<\/key>\s*<string>([^<]*)<\/string>/u)?.[1];
      children.push(await runCommand(process.execPath, ['--input-type=module', '-e', 'process.stdout.write(process.env.NOTICEOS_DOLT_HOME ?? "")'], { cwd: REPO_ROOT, env: { ...process.env, NOTICEOS_DOLT_HOME: value }, timeoutMs: 5_000 }));
    }
    return result;
  };
  assert.equal((await replaceService({ launchctl: reload, loaded: true, writePlist: async () => { persisted = rendered; }, ...launchd.timing })).code, 0);
  await reload(['bootout']);
  await reload(['print']);
  assert.equal((await powerUp('bootstrap', reload)).launchctl.code, 0);
  assert.equal(children.length, 2, 'both installation and a later reload use the persisted setting');
  for (const child of children) {
    assert.equal(child.code, 0, child.stderr);
    assert.equal(child.stdout, doltHome);
  }
});

test('install refuses until a runtime copy exists, and names the step that makes one', () => {
  const none = installRuntimeRefusal({ live: { slot: null }, runnerPresent: false });
  assert.match(none, /pnpm os:deploy prepares one from main without touching the running service/u);
  assert.match(installRuntimeRefusal({ insideRuntime: true, live: { slot: null } }), /from the main folder/u);
  assert.equal(installRuntimeRefusal({ live: { slot: { name: 'runtime-a' } }, runnerPresent: true }), null);
  assert.equal(installRuntimeRefusal({ live: { problem: 'current is a real directory' } }), 'current is a real directory');
});

// --- stop / start ------------------------------------------------------------
//
// "Stop for maintenance" and "remove from launchd" are different verbs. The
// decision logic is pure and tested here; no test spawns launchctl.

test('stop refuses when no plist is installed, and names the verb that installs one', () => {
  const decision = resolveStopAction({ plistExists: false, serviceLoaded: false, doorHeld: false });
  assert.equal(decision.action, 'refuse');
  assert.notEqual(decision.code, 0);
  assert.match(decision.message, /pnpm os:install/u);
  assert.match(decision.message, /pnpm os:up/u, 'a foreground runtime is the other thing it could be');
});

test('stop on an already-stopped service says so plainly and succeeds', () => {
  const decision = resolveStopAction({ plistExists: true, serviceLoaded: false, doorHeld: false });
  assert.equal(decision.action, 'already-stopped');
  assert.equal(decision.code, 0);
  assert.match(decision.message, /already stopped/u);
  assert.match(decision.message, /plist stays installed/u);
});

test('stop reports an orphan holding the door instead of claiming the OS is stopped', () => {
  // Nothing to boot out, yet the port answers: not the managed service, so the
  // store is still open and migrate:local would still refuse.
  const before = resolveStopAction({ plistExists: true, serviceLoaded: false, doorHeld: true });
  assert.equal(before.action, 'refuse-orphan');
  assert.notEqual(before.code, 0);

  // Same fact after a bootout that launchd accepted — this is the case the whole
  // verb exists for: launchd let go, something still holds the sqlite file.
  const after = resolveStopResult({ bootout: { code: 0, stderr: '' }, doorHeld: true });
  assert.notEqual(after.code, 0);
  for (const message of [before.message, after.message]) {
    assert.match(message, /127\.0\.0\.1:8791/u);
    assert.match(message, /lsof -nP -iTCP:8791 -sTCP:LISTEN/u);
    assert.match(message, /Find the owner/u);
  }
  assert.match(after.message, new RegExp(String.raw`booted ${LABEL_RE} out of launchd`, 'u'));
});

test('stop succeeds only once the door is free, and says the refusal will not fire', () => {
  const result = resolveStopResult({ bootout: { code: 0, stderr: '' }, doorHeld: false });
  assert.equal(result.code, 0);
  assert.match(result.message, new RegExp(String.raw`Stopped ${LABEL_RE}`, 'u'));
  assert.match(result.message, /127\.0\.0\.1:8791 is free/u);
  assert.match(result.message, /plist stays installed/u);
});

test('a bootout of a service launchd had already dropped still proves the door free', () => {
  // The idempotence race: `print` said loaded, bootout says "No such process".
  // That is the outcome asked for, not an error to leak at the operator.
  for (const bootout of [
    { code: 3, stderr: 'Boot-out failed: 3: No such process' },
    { code: 113, stderr: `Could not find service "${LABEL}" in domain for gui` },
  ]) {
    assert.equal(resolveStopResult({ bootout, doorHeld: false }).code, 0);
    assert.equal(resolveStopResult({ bootout, doorHeld: true }).code, 1);
  }
});

test('a failed bootout is the exit code, not a claim that the service stopped', () => {
  const result = resolveStopResult({
    bootout: { code: 5, stderr: 'Boot-out failed: 5: Input/output error' },
    doorHeld: null,
  });
  assert.notEqual(result.code, 0);
  assert.match(result.message, /still loaded/u);
  assert.match(result.message, /Input\/output error/u);
  assert.doesNotMatch(result.message, /Stopped/u);
});

test('start refuses without a plist and points at the verb that writes one', () => {
  const decision = resolveStartAction({ plistExists: false, serviceLoaded: false, serviceState: null });
  assert.equal(decision.action, 'refuse');
  assert.notEqual(decision.code, 0);
  assert.match(decision.message, /pnpm os:install/u);
});

test('start on a running service says so plainly and succeeds', () => {
  const decision = resolveStartAction({ plistExists: true, serviceLoaded: true, serviceState: 'running' });
  assert.equal(decision.action, 'already-running');
  assert.equal(decision.code, 0);
  assert.match(decision.message, /already loaded and running/u);
  assert.match(decision.message, /pnpm os:status/u);
});

test('start kickstarts a loaded-but-exited service rather than bootstrapping it twice', () => {
  // launchd still owns the label in this state, so bootstrap would only answer
  // EALREADY; kickstart is what powers it up (the choice restart already makes).
  assert.equal(
    resolveStartAction({ plistExists: true, serviceLoaded: true, serviceState: 'waiting' }).action,
    'kickstart',
  );
  assert.equal(
    resolveStartAction({ plistExists: true, serviceLoaded: false, serviceState: null }).action,
    'bootstrap',
  );
});

test('start reports the boot without waiting for health, and names the health check', () => {
  for (const action of ['bootstrap', 'kickstart']) {
    const result = resolveStartResult({ action, launchctl: { code: 0, stderr: '' } });
    assert.equal(result.code, 0);
    assert.match(result.message, /pnpm os:status is the health check/u);
    assert.match(result.message, /does not wait for health/u);
  }
});

test('a bootstrap that races an already-loaded label is success, not a raw launchctl error', () => {
  const raced = resolveStartResult({
    action: 'bootstrap',
    launchctl: { code: 37, stderr: 'Bootstrap failed: 37: Operation already in progress' },
  });
  assert.equal(raced.code, 0);
  assert.match(raced.message, /already loaded/u);
  assert.doesNotMatch(raced.message, /37/u);

  const failed = resolveStartResult({
    action: 'bootstrap',
    launchctl: { code: 5, stderr: 'Bootstrap failed: 5: Input/output error' },
  });
  assert.notEqual(failed.code, 0);
  assert.match(failed.message, /launchctl bootstrap failed/u);
});

test('the stop wait outlasts the runner’s own shutdown budget', () => {
  // The door is free only once os-up's vite group is gone, and os-up gives that
  // group SIGTERM + 5s then SIGKILL + 2s. A shorter wait here would report a
  // perfectly healthy stop as an orphan on the sanctioned migration path.
  const runner = readFileSync(path.join(REPO_ROOT, 'scripts', 'os-up.mjs'), 'utf8');
  const waits = [...runner.matchAll(/await waitForExit\(children,\s*(\d+)\)/gu)].map((m) =>
    Number(m[1]),
  );
  assert.equal(waits.length, 2, "os-up's shutdown no longer has exactly two child-exit waits");
  const budget = waits.reduce((total, wait) => total + wait, 0);
  assert.ok(
    STOP_WAIT_MS > budget,
    `os:stop waits ${STOP_WAIT_MS}ms for the door, but the runner may take ${budget}ms to release it`,
  );
});

test('an occupied door after stop identifies its listener without guessing a process', () => {
  const lsof = /lsof -nP -iTCP:8791 -sTCP:LISTEN/u;
  assert.match(resolveStopResult({ bootout: { code: 0 }, doorHeld: true }).message, lsof);
});

// --- enable-before-bootstrap, in every domain ----------------------------------
//
// A label anyone once `launchctl disable`d refuses the bootstrap, so an enable
// ordered after a successful bootstrap never runs in the one case it exists for.
// launchd keeps those overrides per domain, and the plist loads into gui/<uid>,
// but an override armed in user/<uid> is the same trap. Nothing here may spawn
// launchctl: powerUp takes the launchctl runner, and these tests hand it a fake
// launchd that keeps per-domain overrides.

const UID = process.getuid();
const GUI_TARGET = `gui/${UID}/${LABEL}`;
const USER_TARGET = `user/${UID}/${LABEL}`;

function fakeLaunchd({ disabled = [] } = {}) {
  const overrides = new Set(disabled);
  const calls = [];
  const launchctl = async (args) => {
    calls.push(args.join(' '));
    const [verb, target] = args;
    if (verb === 'enable') {
      overrides.delete(target);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (verb === 'bootstrap' || verb === 'kickstart') {
      // What launchd prints for a label disabled in any domain.
      return overrides.size
        ? { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' }
        : { code: 0, stdout: '', stderr: '' };
    }
    throw new Error(`the fake launchd does not model \`launchctl ${args.join(' ')}\``);
  };
  return { launchctl, calls, overrides };
}

test('a disable armed in the user domain no longer blocks start: every domain is enabled first', async () => {
  for (const armed of [GUI_TARGET, USER_TARGET, GUI_TARGET + ' ' + USER_TARGET]) {
    const launchd = fakeLaunchd({ disabled: armed.split(' ') });
    const { enable, launchctl } = await powerUp('bootstrap', launchd.launchctl);
    const result = resolveStartResult({ action: 'bootstrap', launchctl, enable });
    assert.equal(result.code, 0, `start stays refused with ${armed} disabled: ${result.message}`);
    assert.equal(launchd.overrides.size, 0);
  }
});

test('power-up enables each domain exactly once, before the load, for install and start alike', async () => {
  assert.deepEqual(ENABLE_TARGETS, [GUI_TARGET, USER_TARGET]);
  for (const action of ['bootstrap', 'kickstart']) {
    const launchd = fakeLaunchd();
    await powerUp(action, launchd.launchctl);
    assert.deepEqual(launchd.calls.slice(0, 2), [`enable ${GUI_TARGET}`, `enable ${USER_TARGET}`]);
    assert.equal(launchd.calls.length, 3, 'one load after the enables, and no enable after it');
    assert.match(launchd.calls[2], action === 'kickstart'
      ? new RegExp(`^kickstart ${GUI_TARGET}$`, 'u')
      : new RegExp(`^bootstrap gui/${UID} .+/${LABEL_RE}\\.plist$`, 'u'));
  }
});

test('install and start reach launchctl enable/bootstrap only through powerUp', () => {
  // The two verbs are not runnable in a test (they read the real launchd state),
  // so this pins that neither can grow a private enable or bootstrap again.
  const source = readFileSync(path.join(REPO_ROOT, 'scripts', 'os-control.mjs'), 'utf8');
  const body = (name) => {
    const start = source.indexOf(`async function ${name}(`);
    return source.slice(start, source.indexOf('\n}\n', start));
  };
  // install loads through replaceService, which is tested below with a fake
  // launchd; start loads directly.
  assert.match(body('installService'), /await replaceService\(/u, 'installService no longer loads through replaceService');
  for (const verb of ['installService', 'replaceService', 'startService']) {
    if (verb !== 'installService') assert.match(body(verb), /await powerUp\(/u, `${verb} no longer powers up through powerUp`);
    assert.doesNotMatch(body(verb), /\['(enable|bootstrap)'/u, `${verb} runs its own enable or bootstrap`);
  }
});

test('an enable on a label launchd has never loaded still counts as enabled', () => {
  // This is what makes ordering-first safe: install enables before the plist has
  // ever been bootstrapped, and start enables a label that may be unknown to
  // launchd, so neither "not found" answer is a failure.
  assert.equal(enableLeftServiceEnabled({ code: 0, stderr: '' }), true);
  assert.equal(enableLeftServiceEnabled({ code: 3, stderr: 'Enable failed: 3: No such process' }), true);
  assert.equal(
    enableLeftServiceEnabled({
      code: 113,
      stderr: `Could not find service "${LABEL}" in domain for gui`,
    }),
    true,
  );
  // A domain or permission failure is a different animal: nothing was enabled.
  assert.equal(enableLeftServiceEnabled({ code: 112, stderr: 'Could not find domain for gui/501' }), false);
  assert.equal(enableLeftServiceEnabled({ code: 1, stderr: 'Operation not permitted' }), false);
});

test('the disabled-label hint needs print-disabled to show the label disabled — a bare I/O error is no evidence', () => {
  // "Bootstrap failed: 5: Input/output error" is what launchd says for a disabled
  // label, an unloadable plist and a label still leaving the domain alike, so a
  // hint built on it would blame a label that is enabled.
  const enable = { code: 0, stderr: '' };
  assert.equal(disabledLabelHint({ enable, disabledIn: null }), null, 'print-disabled could not be read');
  assert.equal(disabledLabelHint({ enable, disabledIn: [] }), null, 'print-disabled shows it enabled');
  const hint = disabledLabelHint({ enable, disabledIn: [`user/${UID}`] });
  assert.equal(
    hint,
    `launchctl print-disabled shows ${LABEL} disabled in user/${UID}, and a disabled label refuses every bootstrap.`,
  );
});

test('print-disabled listings are read in both the current and the older macOS format', () => {
  const listing = (value) => `disabled services = {\n\t"com.apple.x" => disabled\n\t"${LABEL}" => ${value}\n}\n`;
  assert.equal(listingShowsLabelDisabled(listing('disabled')), true);
  assert.equal(listingShowsLabelDisabled(listing('true')), true);
  assert.equal(listingShowsLabelDisabled(listing('enabled')), false);
  assert.equal(listingShowsLabelDisabled(listing('false')), false);
  assert.equal(listingShowsLabelDisabled('disabled services = {\n\t"com.apple.x" => disabled\n}\n'), false, 'not named');
  assert.equal(listingShowsLabelDisabled(`"${LABEL}x" => disabled`), false, 'another label');
});

test('a failed user-domain enable is named with its own target when the label really is disabled', async () => {
  const launchctl = async ([verb, target]) => verb === 'enable' && target === USER_TARGET
    ? { code: 1, stdout: '', stderr: 'Operation not permitted' }
    : verb === 'enable'
      ? { code: 0, stdout: '', stderr: '' }
      : { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
  const { enable, launchctl: loaded } = await powerUp('bootstrap', launchctl);
  const result = resolveStartResult({ action: 'bootstrap', launchctl: loaded, enable, disabledIn: [`user/${UID}`] });
  assert.notEqual(result.code, 0);
  assert.match(result.message, new RegExp(`launchctl enable ${USER_TARGET}\` this ran first failed`, 'u'));
  assert.match(result.message, /Operation not permitted/u);
});

test('start keeps its own failure line, with the hint underneath only when the label is disabled', () => {
  const failure = { action: 'bootstrap', launchctl: { code: 5, stderr: 'Bootstrap failed: 5: Input/output error' }, enable: { code: 0, stderr: '' } };
  const disabled = resolveStartResult({ ...failure, disabledIn: [`gui/${UID}`] });
  assert.notEqual(disabled.code, 0);
  assert.match(disabled.message.split('\n')[0], /^launchctl bootstrap failed: Bootstrap failed: 5/u);
  assert.match(disabled.message, new RegExp(String.raw`print-disabled shows ${LABEL_RE} disabled in gui\/\d+`, 'u'));
  const enabled = resolveStartResult({ ...failure, disabledIn: [] });
  assert.equal(enabled.message, 'launchctl bootstrap failed: Bootstrap failed: 5: Input/output error');
});

// --- install: out of the domain before back in ----------------------------------
//
// A fake launchd whose bootout returns at once while the label stays in the
// domain for `lingerPolls` more `print`s — as a KeepAlive service with Vite and
// workerd children does — and refuses a bootstrap with EIO until it is gone.
// Time is a fake clock that only a wait's sleep moves, so nothing here waits.

function asyncBootoutLaunchd({
  loadedAtStart = true,
  lingerPolls = 3,
  bootout = { code: 0, stdout: '', stderr: '' },
  disabled = [],
  enableFails = false,
} = {}) {
  let loaded = loadedAtStart;
  let linger = null;
  const calls = [];
  const clock = { t: 0 };
  const events = [];
  const launchctl = async (args) => {
    calls.push(args[0]);
    events.push(args[0]);
    const [verb, target] = args;
    if (verb === 'bootout') {
      if (bootout.code === 0) linger = lingerPolls;
      return bootout;
    }
    if (verb === 'print') {
      if (loaded && linger !== null) {
        if (linger <= 0) loaded = false;
        else linger -= 1;
      }
      return loaded
        ? { code: 0, stdout: 'state = running\n', stderr: '' }
        : { code: 113, stdout: '', stderr: `Could not find service "${LABEL}" in domain for user gui: ${UID}` };
    }
    if (verb === 'enable') {
      return enableFails ? { code: 1, stdout: '', stderr: 'Operation not permitted' } : { code: 0, stdout: '', stderr: '' };
    }
    if (verb === 'bootstrap') {
      if (loaded || disabled.length > 0) return { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
      loaded = true;
      linger = null;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (verb === 'print-disabled') {
      const value = disabled.includes(target) ? 'disabled' : 'enabled';
      return { code: 0, stdout: `disabled services = {\n\t"${LABEL}" => ${value}\n}\n`, stderr: '' };
    }
    throw new Error(`the fake launchd does not model \`launchctl ${args.join(' ')}\``);
  };
  const timing = { pollMs: 250, now: () => clock.t, sleep: async (ms) => { clock.t += ms; } };
  const writePlist = async () => {
    events.push('write-plist');
  };
  return { launchctl, calls, events, clock, timing, writePlist };
}

test('install waits for the old label to leave launchd before it writes and loads the new plist', async () => {
  const launchd = asyncBootoutLaunchd({ lingerPolls: 3 });
  const result = await replaceService({ launchctl: launchd.launchctl, loaded: true, writePlist: launchd.writePlist, ...launchd.timing });

  assert.deepEqual(result, { code: 0, attempts: 1 });
  assert.deepEqual(launchd.events, [
    'bootout',
    'print', 'print', 'print', 'print', // still there ×3, then gone
    'write-plist',
    'enable', 'enable', 'bootstrap',
  ]);
  assert.ok(launchd.clock.t < STOP_WAIT_MS, 'it waited only as long as the label lingered');
});

test('a bootstrap refused with EIO after the bounded wait waits once more and is retried once', async () => {
  // The label outlasts the whole first wait (12s at 250ms polls), then leaves.
  const polls = STOP_WAIT_MS / 250;
  const launchd = asyncBootoutLaunchd({ lingerPolls: polls + 5 });
  const result = await replaceService({ launchctl: launchd.launchctl, loaded: true, writePlist: launchd.writePlist, ...launchd.timing });

  assert.deepEqual(result, { code: 0, attempts: 2 });
  assert.equal(launchd.calls.filter((verb) => verb === 'bootstrap').length, 2);
  assert.equal(launchd.calls.filter((verb) => verb === 'enable').length, 4, 'each load is still enabled first');
  const firstBootstrap = launchd.events.indexOf('bootstrap');
  assert.ok(launchd.events.slice(firstBootstrap + 1).includes('print'), 'the retry came after a second wait');
});

test('an install that still cannot load says the OS is STOPPED and names the one recovery command, with no false hint', async () => {
  const launchd = asyncBootoutLaunchd({ lingerPolls: Infinity });
  const result = await replaceService({ launchctl: launchd.launchctl, loaded: true, writePlist: launchd.writePlist, ...launchd.timing });

  assert.equal(result.code, 1);
  assert.equal(launchd.calls.filter((verb) => verb === 'bootstrap').length, 2, 'retried once, never more');
  assert.equal(
    result.message,
    [
      'the old service was removed and the new one did not load, so the OS is STOPPED.',
      '  launchctl bootstrap failed 2 times: Bootstrap failed: 5: Input/output error',
      '  Recover: pnpm os:start',
    ].join('\n'),
    'print-disabled shows the label enabled, so no disabled-label hint',
  );
  assert.equal(
    installLoadFailedMessage({ launchctl: { code: 5, stderr: 'x' }, bootedOut: false, attempts: 1 }).split('\n')[0],
    'the service did not load, so the OS is STOPPED.',
  );
});

test('an install refused by a label that really is disabled says so, from print-disabled', async () => {
  const launchd = asyncBootoutLaunchd({ lingerPolls: 0, disabled: [`gui/${UID}`], enableFails: true });
  const result = await replaceService({ launchctl: launchd.launchctl, loaded: true, writePlist: launchd.writePlist, ...launchd.timing });

  assert.equal(result.code, 1);
  assert.match(result.message, /^the old service was removed and the new one did not load, so the OS is STOPPED\./u);
  assert.match(result.message, new RegExp(`print-disabled shows ${LABEL_RE} disabled in gui/${UID}`, 'u'));
  assert.match(result.message, /Operation not permitted/u);
  assert.match(result.message, /\n {2}Recover: pnpm os:start$/u);
});

test('a bootout that leaves the old service loaded writes nothing and loads nothing', async () => {
  const launchd = asyncBootoutLaunchd({ bootout: { code: 1, stdout: '', stderr: 'Boot-out failed: 1: Operation not permitted' } });
  const result = await replaceService({ launchctl: launchd.launchctl, loaded: true, writePlist: launchd.writePlist, ...launchd.timing });

  assert.equal(result.code, 1);
  assert.match(result.message, new RegExp(String.raw`launchctl bootout failed, so ${LABEL_RE} is still loaded: .*Operation not permitted\. The new plist was not written; nothing changed\.`, 'u'));
  assert.deepEqual(launchd.events, ['bootout']);
});

test('a first install with nothing loaded bootstraps without a bootout or a wait', async () => {
  const launchd = asyncBootoutLaunchd({ loadedAtStart: false });
  const result = await replaceService({ launchctl: launchd.launchctl, loaded: false, writePlist: launchd.writePlist, ...launchd.timing });
  assert.deepEqual(result, { code: 0, attempts: 1 });
  assert.deepEqual(launchd.events, ['write-plist', 'enable', 'enable', 'bootstrap']);
});

test('package scripts and the agent pack expose one stable operating vocabulary', () => {
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(
    Object.fromEntries(
      [
        'os:status',
        'os:logs',
        'os:restart',
        'os:deploy',
        'os:doctor',
        'os:stop',
        'os:start',
        'os:install',
        'os:uninstall',
      ].map((name) => [name, manifest.scripts[name]]),
    ),
    {
      'os:status': 'node scripts/os-control.mjs status',
      'os:logs': 'node scripts/os-control.mjs logs',
      'os:restart': 'node scripts/os-control.mjs restart',
      'os:deploy': 'node scripts/os-control.mjs deploy',
      'os:doctor': 'node scripts/os-control.mjs doctor',
      'os:stop': 'node scripts/os-control.mjs stop',
      'os:start': 'node scripts/os-control.mjs start',
      'os:install': 'node scripts/os-control.mjs install',
      'os:uninstall': 'node scripts/os-control.mjs uninstall',
    },
  );
  const agents = readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf8');
  for (const command of ['pnpm os:status', 'pnpm os:logs', 'pnpm os:doctor', 'pnpm os:restart', 'pnpm os:deploy']) {
    assert.equal(agents.includes(command), true, `${command} is absent from AGENTS.md`);
  }
});

// The drill is written down in three places and executed from one. A doc still
// prescribing uninstall → migrate → install is a doc that sends an operator to
// rewrite the login service's plist to apply a migration.
test('the sanctioned maintenance sequence reads the same in both docs', () => {
  for (const file of ['AGENTS.md', path.join('scripts', 'README.md')]) {
    const text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    for (const command of ['pnpm os:stop', 'pnpm postgres:migrate apply', 'pnpm os:start']) {
      assert.equal(text.includes(command), true, `${command} is absent from ${file}`);
    }
  }
});

// --- one restart + health wait, shared by os:restart and os:deploy -------------
//
// A deploy restarts through the same function os:restart does, so it waits the
// same way and fails the same way: classified status plus the recent redacted
// runner log. A fake launchd and a scripted status stand in for the real ones.

function scripted(states) {
  let index = 0;
  return async () => states[Math.min(index++, states.length - 1)];
}
const runnerStatus = (state, pid, loaded = true, service = 'running') => ({
  state,
  reason: state === 'healthy' ? 'launchd, runner heartbeat, ingest, and Tower all answer' : 'Tower does not answer',
  checkedAt: new Date(NOW).toISOString(),
  service: { loaded, state: service, pid },
  ingest: { ok: state === 'healthy', status: 200 },
  tower: { ok: state === 'healthy', status: 200 },
  heartbeat: { pid, status: state, updatedAt: new Date(NOW).toISOString() },
});

test('a restart is ONE launchctl call and returns once a NEW runner is healthy', async () => {
  const calls = [];
  const after = await restartAndWait({
    launchctl: async (args) => {
      calls.push(args.join(' '));
      return { code: 0, stdout: '', stderr: '' };
    },
    inspect: scripted([
      runnerStatus('healthy', 101), // before
      runnerStatus('healthy', 101), // the old runner, still answering: not good enough
      runnerStatus('starting', 202),
      runnerStatus('healthy', 202),
    ]),
    pollMs: 1,
    timeoutMs: 5_000,
  });
  assert.equal(after.heartbeat.pid, 202);
  assert.deepEqual(calls, [`kill SIGTERM ${GUI_TARGET}`]);

  const kick = [];
  await restartAndWait({
    launchctl: async (args) => {
      kick.push(args[0]);
      return { code: 0, stdout: '', stderr: '' };
    },
    inspect: scripted([runnerStatus('unhealthy', 5, true, 'waiting'), runnerStatus('healthy', 6)]),
    pollMs: 1,
  });
  assert.deepEqual(kick, ['kickstart'], 'an exited service is kickstarted, never killed');
});

test('a restart that never returns to healthy fails with status and the recent redacted log', async () => {
  await assert.rejects(
    waitForHealthy('deploy', {
      previousPid: 7,
      inspect: async () => runnerStatus('unhealthy', 8),
      timeoutMs: 20,
      pollMs: 1,
      readLog: async () => ['[tower] Error: boom', redactLogText('Authorization: Bearer leaked-token')],
    }),
    (error) => {
      assert.match(error.message, /^deploy did not return NoticeOS to healthy within 0s/u);
      assert.match(error.message, /! NoticeOS UNHEALTHY/u);
      assert.match(error.message, /--- recent redacted runner log ---\n\[tower\] Error: boom/u);
      assert.doesNotMatch(error.message, /leaked-token/u);
      return true;
    },
  );
  await assert.rejects(
    restartAndWait({
      inspect: async () => runnerStatus('stopped', null, false),
      launchctl: async () => assert.fail('a service that is not loaded is never restarted'),
    }),
    /the managed service is not loaded; restart refuses/u,
  );
});

test('os:restart and os:deploy restart through the one shared restart-and-wait', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'scripts', 'os-control.mjs'), 'utf8');
  const body = (name) => {
    const start = source.indexOf(`async function ${name}(`);
    return source.slice(start, source.indexOf('\n}\n', start));
  };
  assert.match(body('restartService'), /await restartAndWait\(/u);
  // The deploy's restart and its automatic rollback's both come here.
  assert.match(body('deployService'), /restart: \(\{ timeoutMs, action = 'deploy' \}\) => restartAndWait\(\{ action, timeoutMs \}\)/u);
  for (const name of ['restartService', 'deployService']) {
    assert.doesNotMatch(body(name), /\['kill'|\['kickstart'/u, `${name} restarts launchd on its own`);
  }
});

// --- which code runs, in one line ---------------------------------------------

test('status says in one line which commit the OS runs and whether main is ahead', () => {
  const commit = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  assert.equal(codeLine({ mode: 'runtime', commit, onMain: true, behind: 0 }), '  code        a1b2c3d4 · same as main');
  assert.equal(
    codeLine({ mode: 'runtime', commit, onMain: true, behind: 3 }),
    '  code        a1b2c3d4 · main is 3 commits ahead — pnpm os:deploy',
  );
  assert.match(codeLine({ mode: 'runtime', commit, onMain: true, behind: 1 }), /main is 1 commit ahead/u);
  assert.equal(codeLine({ mode: 'runtime', commit, onMain: false, behind: null }), '  code        a1b2c3d4 · not on main');
  assert.match(
    codeLine({ mode: 'checkout' }),
    /runs from this folder, so every merge reloads it — pnpm os:deploy, then pnpm os:install/u,
  );

  const status = {
    ...classifyRunnerState(healthyInputs),
    checkedAt: new Date(NOW).toISOString(),
    service: healthyInputs.service,
    ingest: healthyInputs.ingest,
    tower: healthyInputs.tower,
    heartbeat: healthyInputs.heartbeat,
  };
  assert.equal(statusLines(status).some((line) => line.startsWith('  code')), false, 'no line without a code reading');
  assert.equal(
    statusLines({ ...status, code: { mode: 'runtime', commit, onMain: true, behind: 0 } }).at(-1),
    '  code        a1b2c3d4 · same as main',
  );
});

test('the running runner’s own report is what status reads first', async () => {
  const home = '/Users/operator/dev/reindex-os';
  const main = 'b'.repeat(40);
  const asked = [];
  const git = async (cwd, args) => {
    asked.push(`${cwd} ${args.join(' ')}`);
    if (args[0] === 'rev-parse') return args.includes('main^{commit}') ? main : 'c'.repeat(40);
    return null;
  };
  const fromHeartbeat = await inspectCode({
    homeRoot: home,
    heartbeat: { codeRoot: path.join(home, '.local', 'runtime', 'runtime-b'), commit: 'a'.repeat(40) },
    git,
    readPlist: async () => assert.fail('the heartbeat answers first'),
  });
  assert.equal(fromHeartbeat.mode, 'runtime');
  assert.equal(fromHeartbeat.commit, 'a'.repeat(40));
  assert.equal(fromHeartbeat.main, main);

  // A runner from before the runtime copy says nothing; the plist says where it runs.
  const legacy = await inspectCode({
    homeRoot: home,
    heartbeat: { pid: 1, status: 'healthy' },
    git,
    readPlist: async () => `<string>${home}/scripts/os-up.mjs</string>`,
  });
  assert.deepEqual(legacy, { mode: 'checkout', commit: null, main, behind: null, onMain: null });

  const plistOnly = await inspectCode({
    homeRoot: home,
    heartbeat: null,
    git,
    readPlist: async () => `<string>${runtimeLayout(home).current}/scripts/os-up.mjs</string>`,
  });
  assert.equal(plistOnly.mode, 'runtime');
  assert.equal(plistOnly.commit, 'c'.repeat(40), 'read from the current copy when no runner reports');
  assert.ok(asked.includes(`${runtimeLayout(home).current} rev-parse HEAD`));
});

// Every command os:status and os:deploy run (git, launchctl, pnpm install)
// goes through scripts/run-command.mjs, so an answer still in the pipe when
// the command exits is read in full, never cut short.
test('status reads a git answer that is still arriving after git exited', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'os-control-late-'));
  const late = lateWritingCommand('git', { early: 'b'.repeat(20), late: `${'b'.repeat(20)}\n` });
  try {
    const code = await withPathOf(late.dir, () =>
      inspectCode({
        homeRoot: home,
        heartbeat: { codeRoot: path.join(home, '.local', 'runtime', 'runtime-b'), commit: 'a'.repeat(40) },
      }),
    );
    assert.equal(code.main, 'b'.repeat(40));
    assert.equal(code.onMain, true);
  } finally {
    late.remove();
    rmSync(home, { recursive: true, force: true });
  }
});

const POSTGRES_DOCTOR_FILES = {
  '0001_base.sql': '-- first migration\n',
  '0002_more.sql': '-- second migration\n',
  '0003_latest.sql': '-- third migration\n',
};
const postgresRecord = (filename) => ({
  version: Number(filename.slice(0, 4)),
  name: filename.replace(/\.sql$/u, ''),
  sha256: createHash('sha256').update(POSTGRES_DOCTOR_FILES[filename]).digest('hex'),
});

function postgresDoctor({ homeRoot = '/tmp/noticeos-doctor-fixture', filenames = Object.keys(POSTGRES_DOCTOR_FILES), records = [], recorded, git } = {}) {
  return {
    homeRoot,
    code: { mode: 'runtime' },
    fsp: { readFile: async (file) => {
      assert.ok(['workers/ingest/wrangler.jsonc', 'apps/tower/wrangler.jsonc'].some((relative) => file === path.join(runtimeLayout(homeRoot).current, relative)));
      return JSON.stringify({ hyperdrive: [{ binding: 'POSTGRES', id: 'fixture' }] });
    } },
    readPostgresMigrations: async () => recorded ?? { ok: true, records, address: 'never-display-the-database-address' },
    git: git ?? (async (home, args, options) => {
      assert.equal(home, homeRoot);
      assert.deepEqual(options, { trim: false }, 'migration hashes include the committed trailing newline');
      if (args[0] === 'ls-tree') {
        assert.deepEqual(args, ['ls-tree', '--name-only', 'main:db/postgres/migrations']);
        return `${filenames.join('\n')}\nREADME.md\n`;
      }
      assert.equal(args[0], 'cat-file');
      assert.equal(args[1], 'blob');
      const name = args[2].replace('main:db/postgres/migrations/', '');
      assert.ok(filenames.includes(name));
      return POSTGRES_DOCTOR_FILES[name];
    }),
  };
}

test('doctor shows recorded Postgres migrations and pending files from main, using their committed hashes', async () => {
  const line = await storeLine(postgresDoctor({ records: [postgresRecord('0001_base.sql')] }));
  assert.equal(line,
    '  store       1 Postgres migration recorded · main: 2 not applied: 0002_more.sql, 0003_latest.sql ' +
    '(operator-only: pnpm os:stop, pnpm postgres:migrate apply --database <name> [<connection>] --confirm <name>, pnpm os:start)');
  assert.doesNotMatch(line, /never-display/u);
  assert.equal(await storeLine(postgresDoctor({
    records: Object.keys(POSTGRES_DOCTOR_FILES).map(postgresRecord),
  })), '  store       3 Postgres migrations recorded · none pending on main');
});

test('doctor preserves a migration blob trailing newline through its default git command reader', async () => {
  const bin = mkdtempSync(path.join(tmpdir(), 'doctor-git-fixture-'));
  writeFileSync(path.join(bin, 'git'), '#!/bin/sh\n' +
    'case "$1" in\n' +
    '  ls-tree) printf "0001_base.sql\\n" ;;\n' +
    '  cat-file) printf "%s\\n" "-- first migration" ;;\n' +
    '  *) exit 1 ;;\n' +
    'esac\n', { mode: 0o755 });
  try {
    const deps = postgresDoctor({ homeRoot: bin, records: [postgresRecord('0001_base.sql')] });
    delete deps.git;
    assert.equal(await withPathOf(bin, () => storeLine(deps)),
      '  store       1 Postgres migration recorded · none pending on main');
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test('doctor names a Postgres file whose committed bytes differ from the applied record', async () => {
  const recorded = { ...postgresRecord('0001_base.sql'), sha256: 'another-hash' };
  assert.equal(await storeLine(postgresDoctor({ filenames: ['0001_base.sql'], records: [recorded] })),
    '  store       1 Postgres migration recorded · main: 1 changed since apply: 0001_base.sql');
});

test('doctor names migrations recorded in Postgres but absent from main', async () => {
  assert.equal(await storeLine(postgresDoctor({
    filenames: ['0001_base.sql'],
    records: ['0001_base.sql', '0002_more.sql'].map(postgresRecord),
  })), '  store       2 Postgres migrations recorded · main: 1 recorded but absent from main: 0002_more.sql');
});

test('doctor distinguishes an out-of-order Postgres file from a pending one', async () => {
  assert.equal(await storeLine(postgresDoctor({ records: ['0001_base.sql', '0003_latest.sql'].map(postgresRecord) })),
    '  store       2 Postgres migrations recorded · main: 1 out of order: 0002_more.sql');
});

test('doctor reports an unreadable Postgres record or main migration tree without falling back to D1', async () => {
  assert.equal(await storeLine(postgresDoctor({ recorded: { ok: false, line: 'database unavailable', address: 'never-display' } })),
    '  store       Postgres migrations unknown — database unavailable');
  assert.equal(await storeLine(postgresDoctor({ records: [postgresRecord('0001_base.sql')], git: async () => null })),
    "  store       1 Postgres migration recorded · could not list main's Postgres migrations");
});

test('doctor refuses legacy, mixed or unknown Worker configs without opening a store', async () => {
  const postgres = { hyperdrive: [{ binding: 'POSTGRES', id: 'fixture' }] };
  const d1 = { d1_databases: [{ binding: 'DB', database_id: 'legacy' }] };
  for (const bad of [d1, { ...postgres, ...d1 }, {}, 'not json']) {
    for (const badFile of ['workers/ingest/wrangler.jsonc', 'apps/tower/wrangler.jsonc']) {
      const deps = postgresDoctor();
      deps.fsp = { readFile: async (file) => {
        const config = file.endsWith(badFile) ? bad : postgres;
        return typeof config === 'string' ? config : JSON.stringify(config);
      } };
      deps.readPostgresMigrations = async () => assert.fail('unsupported runtime contacted Postgres');
      deps.git = async () => assert.fail('unsupported runtime checked migration files');
      assert.match(await storeLine(deps), /unknown —.*Postgres runtime/);
    }
  }
});
