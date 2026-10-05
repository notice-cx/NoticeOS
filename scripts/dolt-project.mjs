#!/usr/bin/env node
// Initialize one NEW external Beads project on an explicitly declared hub.
// This is shared by first startup and the operator's copied project command.
import * as fs from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { doltComposeArgs, doltEnvironment, doltExecutor, readDoltCredentials, readDoltProfile } from './dolt-host.mjs';
import { runCommand } from './run-command.mjs';

export const BEADS_VERSION = '1.3.1';
const refusal = line => ({ ok: false, line });

async function cleanCheckout(repo, run, env) {
  const root = await run('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { cwd: repo, env });
  if (root.code !== 0 || root.stdout.trim() !== fs.realpathSync(repo)) return false;
  const status = await run('git', ['-C', repo, 'status', '--porcelain=v1', '--untracked-files=all'], { cwd: repo, env });
  return status.code === 0 && status.stdout.trim() === '';
}

/** Check the CLI outside any repo/config before installing anything. */
export async function checkBeadsCli({ env = process.env, run = runCommand, binary = null } = {}) {
  const candidates = binary ? [binary] : [
    ...(env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, 'bd')),
    ...(env.HOME ? [path.join(env.HOME, '.local', 'bin', 'bd')] : []),
  ];
  const selected = candidates.find(file => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } });
  if (!selected) return refusal(`Task setup needs the bundled Beads CLI ${BEADS_VERSION}; use the supported application image.`);
  const scratch = fs.mkdtempSync(path.join(tmpdir(), 'noticeos-bd-prerequisite-'));
  try {
    const clean = { PATH: env.PATH ?? '', HOME: scratch, XDG_CONFIG_HOME: path.join(scratch, '.config'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull,
      BD_DISABLE_METRICS: '1', DO_NOT_TRACK: '1' };
    const result = await run(selected, ['version'], { cwd: scratch, env: clean });
    if (result.code !== 0 || !new RegExp(`^bd version ${BEADS_VERSION.replaceAll('.', '\\.')}(?:\\s|$)`, 'u').test(result.stdout.trim())) {
      return refusal(`Task setup needs Beads CLI ${BEADS_VERSION}; no installation files were created.`);
    }
    return { ok: true, binary: selected };
  } catch { return refusal('The Beads CLI could not be checked; nothing was set up.'); }
  finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

/** No adoption, reinit or migration path: both the local spoke and its exact
 * database must be absent. The lock serializes initializers on this own hub. */
export async function initDoltProject({ home, repo, prefix, database }, { env = process.env, run = runCommand, binary = null, executor = doltExecutor } = {}) {
  let lock = null;
  try {
    if (typeof home !== 'string' || !path.isAbsolute(home) || typeof repo !== 'string' || !path.isAbsolute(repo)
      || !/^[a-z]{2,8}$/u.test(prefix) || !/^[a-z][a-z0-9_]{0,62}$/u.test(database)) return refusal('Task setup needs an explicit home, checkout, lowercase prefix and database.');
    for (const dir of [home, path.join(home, 'dolt'), repo]) {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return refusal('Task setup paths must be regular directories.');
    }
    if (fs.lstatSync(path.join(repo, '.beads'), { throwIfNoEntry: false })) return refusal('This checkout already has task setup; it was not changed.');
    const profile = readDoltProfile(home);
    if (!profile) return refusal('This installation has no declared task server.');
    // The operator may add a new project to a shared installation hub.
    // readDoltProfile binds credentials to this home; the atomic database
    // reservation below still forbids adopting or reinitializing any project.
    for (const dir of [profile.secretsDir, path.dirname(profile.credentialsFile)]) {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return refusal('Task credential paths must be own directories.');
    }
    const cli = await checkBeadsCli({ env, run, binary });
    if (!cli.ok) return cli;
    const ownEnv = { ...doltEnvironment(profile, env), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull };
    if (!await cleanCheckout(repo, run, ownEnv)) return refusal('Task setup needs a clean Git checkout; no files or databases were changed.');
    const reserved = path.join(home, 'dolt', '.project-init-lock');
    fs.mkdirSync(reserved, { mode: 0o700 });
    lock = reserved;
    const execute = await executor(profile, { env, run });
    const listed = await execute([...doltComposeArgs(profile), 'exec', '--no-TTY', 'dolt', '/bin/bash', '/etc/noticeos/sql.sh', 'noticeos', 'SHOW DATABASES']);
    if (listed.code !== 0) return refusal('The task server’s database inventory could not be checked; nothing was initialized.');
    const inventory = JSON.parse(listed.stdout);
    if (!Array.isArray(inventory.rows) || !inventory.rows.length || inventory.rows.some(row => typeof row.Database !== 'string')) {
      return refusal('The task server’s database inventory is unknown; nothing was initialized.');
    }
    if (inventory.rows.some(row => row.Database.toLowerCase() === database.toLowerCase())) return refusal('That task database already exists; initialization and migrations were refused.');
    // Atomic reservation closes the name race with other clients. Never use
    // IF NOT EXISTS: success proves this invocation made the empty database.
    const reservedDb = await execute([...doltComposeArgs(profile), 'exec', '--no-TTY', 'dolt', '/bin/bash', '/etc/noticeos/sql.sh', 'noticeos', `CREATE DATABASE \`${database}\``]);
    if (reservedDb.code !== 0) return refusal('The new task database could not be reserved; initialization and migrations were refused.');
    // Recheck after preflight: never replace a spoke created by another tool.
    if (fs.lstatSync(path.join(repo, '.beads'), { throwIfNoEntry: false })) return refusal('This checkout gained task setup; it was not changed.');
    if (!await cleanCheckout(repo, run, ownEnv)) return refusal('The checkout changed during setup; its empty task database was preserved and no initialization ran.');
    // Pinned init.go skips INI lookup. This one child receives the protected
    // own password in its environment; all normal calls keep using the file.
    const initEnv = { ...ownEnv, BEADS_DOLT_PASSWORD: readDoltCredentials(profile).noticeos.trim() };
    const args = ['init', '--server', '--external', '--server-host', '127.0.0.1', '--server-port', String(profile.port),
      '--server-user', 'noticeos', '--database', database, '--prefix', prefix, '--non-interactive', '--skip-hooks', '--skip-agents'];
    const initialized = await run(cli.binary, args, { cwd: repo, env: initEnv, timeoutMs: 90_000 });
    if (initialized.code !== 0) return refusal('Task initialization did not finish; any files were preserved for explicit recovery.');
    const configFile = path.join(repo, '.beads', 'config.yaml');
    const stat = fs.lstatSync(configFile);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid spoke config.');
    const config = fs.readFileSync(configFile, 'utf8').split('\n').filter(line => !/^\s*(?:sync\.remote|no-git-ops|import\.auto|export\.auto)\s*:/u.test(line)).join('\n');
    fs.writeFileSync(configFile, `${config.trimEnd()}\nno-git-ops: true\nimport.auto: false\nexport.auto: false\n`, { mode: 0o600 });
    return { ok: true };
  } catch { return refusal('Task initialization was refused or did not finish; any files were preserved for explicit recovery.'); }
  finally { if (lock) fs.rmSync(lock, { recursive: true, force: true }); }
}

export async function main(argv = process.argv.slice(2), { out = process.stdout, err = process.stderr, ...options } = {}) {
  const args = {};
  try {
    for (let i = 0; i < argv.length; i++) {
      const key = argv[i];
      if (!['--home', '--repo', '--prefix', '--database'].includes(key) || args[key.slice(2)] !== undefined || !argv[i + 1]) throw new Error('Invalid args.');
      args[key.slice(2)] = argv[++i];
    }
    if (!args.home || !args.repo || !args.prefix || !args.database) throw new Error('Missing explicit args.');
    const result = await initDoltProject({ ...args, home: path.resolve(args.home), repo: path.resolve(args.repo) }, options);
    if (!result.ok) { err.write(`Task setup: ${result.line}\n`); return 1; }
    out.write('Task project initialized. Add its mapping in Settings → Task projects.\n');
    return 0;
  } catch { err.write('Usage: dolt-project.mjs --home <installation> --repo <checkout> --prefix <prefix> --database <database>\n'); return 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
