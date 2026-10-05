import * as fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readDeclaredTaskClient } from '../../scripts/task-client.mjs';
import { probeTcp } from '../../scripts/runner/host-tools.mjs';

export function containerEnvironment(env = process.env, { fs: io = fs, readClient = readDeclaredTaskClient } = {}) {
  const home = '/state';
  const profileFile = path.join(home, 'task-client.json');
  const profile = readClient(profileFile);
  if (profile.host !== 'dolt' || profile.port !== 3306 || profile.credentialsFile !== '/state/dolt/credentials' || profile.clientHome !== '/state/dolt/client-home') throw new Error('The container needs its declared internal task service.');
  for (const dir of [home, '/spokes', '/state/installation', '/state/.local', '/state/.wrangler', '/state/workers/ingest']) {
    const stat = io.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The prepared installation mount is incomplete.');
  }
  const file = '/state/workers/ingest/.dev.secrets.json';
  const stat = io.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > 16384) throw new Error('Bootstrap secrets must be a private regular file.');
  const bindings = JSON.parse(io.readFileSync(file, 'utf8'));
  const database = new URL(bindings.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || database.hostname !== 'postgres' || (database.port || '5432') !== '5432' || !database.password) throw new Error('The container needs its declared internal database.');
  // A new installation may have no asset tokens yet (doc 06).
  if (typeof bindings.CREDENTIALS_KEY !== 'string' || !bindings.CREDENTIALS_KEY.trim() ||
    typeof bindings.OPERATOR_TOKEN !== 'string' || !bindings.OPERATOR_TOKEN.trim()) throw new Error('The prepared bootstrap credentials are incomplete.');
  const selected = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TOWER_ALLOWED_HOSTS']) if (env[key] !== undefined) selected[key] = env[key];
  // The standalone runtime serves through Vite; its React transforms need development mode.
  return { ...selected, HOME: '/state/dolt/client-home', TMPDIR: '/tmp', NODE_ENV: 'development',
    // Docker forwards published ports to the container interface, not its loopback.
    // Host exposure remains controlled by the Compose port binding.
    OS_UP_HOST: '1',
    NOTICEOS_HOME: home, NOTICEOS_INSTALLATION_DIR: '/state/installation', NOTICEOS_TASK_CLIENT_PROFILE: profileFile,
    NOTICEOS_BACKUP_CLIENT_PROFILE: '/state/backup-client.json',
    BEADS_BD_BIN: '/usr/local/bin/bd', NOTICEOS_VITE_CACHE_DIR: '/state/.local/vite-cache', WRANGLER_SEND_METRICS: 'false',
    CLOUDFLARE_CF_FETCH_ENABLED: 'false',
    WRANGLER_CACHE_DIR: '/state/.wrangler/cache',
    GIT_TERMINAL_PROMPT: '0' };
}

export async function main() {
  let env;
  try {
    env = containerEnvironment();
    if (!await probeTcp('dolt', 3306, 5000)) throw new Error('The declared task service is unavailable.');
  }
  catch { process.stderr.write('NoticeOS container refused: prepare its mounted installation and internal service credentials.\n'); return 1; }
  const child = spawn(process.execPath, ['scripts/os-up.mjs'], { cwd: '/opt/noticeos', env, stdio: 'inherit' });
  const forward = signal => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
  const onTerm = () => forward('SIGTERM');
  const onInt = () => forward('SIGINT');
  process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
  try {
    return await new Promise(resolve => { child.once('error', () => resolve(1)); child.once('exit', code => resolve(code ?? 1)); });
  } finally { process.off('SIGTERM', onTerm); process.off('SIGINT', onInt); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
