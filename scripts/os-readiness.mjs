// Bounded, read-only checks of the managed service's two database dependencies.
// HTTP health routes prove liveness; these checks require an actual store read.
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { MANAGED_DOOR, localDoorFetch, operatorToken } from './ingest-door.mjs';
import { CONFIG_DOCUMENTS_PATH } from './config-store-client.mjs';
import { doltComposeArgs, doltExecutor, readDoltProfile } from './dolt-host.mjs';
import { runCommand } from './run-command.mjs';

export const READINESS_TIMEOUT_MS = 2_000;
const answer = (state) => ({ state });
function budget(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > READINESS_TIMEOUT_MS) {
    throw new Error('Readiness checks require a positive budget of at most two seconds.');
  }
  return performance.now() + timeoutMs;
}

export async function probePostgresReadiness({
  fetchImpl = localDoorFetch, readToken = operatorToken, timeoutMs = READINESS_TIMEOUT_MS,
} = {}) {
  budget(timeoutMs);
  const controller = new AbortController();
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(answer('timeout')); }, timeoutMs);
  });
  let authenticated = false;
  const read = async () => {
    try {
      const token = await readToken();
      if (controller.signal.aborted) return answer('timeout');
      if (typeof token !== 'string' || token.trim() === '') return answer('unknown');
      authenticated = true;
      const response = await fetchImpl(`${MANAGED_DOOR}/${CONFIG_DOCUMENTS_PATH}`, {
        method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) return answer('unknown');
      const body = await response.json();
      if (controller.signal.aborted) return answer('timeout');
      return answer(response.status === 200 && body?.ready === true ? 'ready' : 'unavailable');
    } catch {
      return answer(controller.signal.aborted ? 'timeout' : authenticated ? 'unavailable' : 'unknown');
    }
  };
  try {
    return await Promise.race([read(), expired]);
  } finally {
    clearTimeout(timer);
  }
}

export async function probeDoltReadiness({
  plistFile, run = runCommand, env = process.env, readProfile = readDoltProfile,
  timeoutMs = READINESS_TIMEOUT_MS,
} = {}) {
  const deadline = budget(timeoutMs);
  let timedOut = false;
  let declared = false;
  const boundedRun = async (command, args, options = {}) => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) {
      timedOut = true;
      throw new Error('Readiness budget ended.');
    }
    const result = await run(command, args, { ...options, timeoutMs: remaining });
    timedOut ||= result.timedOut === true || result.code === 124 || performance.now() >= deadline;
    if (timedOut) throw new Error('Readiness budget ended.');
    return result;
  };
  try {
    if (typeof plistFile !== 'string' || !path.isAbsolute(plistFile)) return answer('unknown');
    // The installed service's selector wins over the caller's shell environment.
    const selected = await boundedRun('/usr/bin/plutil', [
      '-extract', 'EnvironmentVariables.NOTICEOS_DOLT_HOME', 'raw', '-expect', 'string', '-o', '-', plistFile,
    ], { env: { PATH: '/usr/bin:/bin' } });
    if (selected.code !== 0) return answer('unknown');
    const home = selected.stdout.replace(/\n$/u, '');
    if (!path.isAbsolute(home) || /[\r\n\0]/u.test(home)) return answer('unknown');
    const profile = readProfile(home);
    if (!profile) return answer('unknown');
    declared = true;
    const execute = await doltExecutor(profile, { run: boundedRun, env });
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 100) return answer('timeout');
    // Killing the local Docker client does not cancel its remote exec. Bound
    // that SQL process too, leaving a margin for TERM followed by forced KILL.
    const sqlBudget = `${((remaining - 100) / 1000).toFixed(3)}s`;
    const result = await execute([
      ...doltComposeArgs(profile), 'exec', '--no-TTY', 'dolt',
      '/usr/bin/timeout', '--kill-after=0.05s', sqlBudget,
      '/bin/bash', '/etc/noticeos/sql.sh', 'noticeos', 'SELECT 1 AS ready',
    ]);
    if (result.code === 137) return answer('timeout');
    if (result.code !== 0) return answer('unavailable');
    const body = JSON.parse(result.stdout);
    const value = body?.rows?.[0]?.ready;
    // Dolt's SQL client can encode MySQL numeric results as JSON strings.
    return answer(Array.isArray(body?.rows) && body.rows.length === 1 && (value === 1 || value === '1') ? 'ready' : 'unavailable');
  } catch {
    return answer(timedOut ? 'timeout' : declared ? 'unavailable' : 'unknown');
  }
}

export async function inspectDependencies({ postgres = {}, dolt = {} } = {}) {
  const [postgresState, doltState] = await Promise.all([
    probePostgresReadiness(postgres), probeDoltReadiness(dolt),
  ]);
  return { postgres: postgresState, dolt: doltState };
}
