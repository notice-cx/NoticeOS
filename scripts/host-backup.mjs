// One host backup operation. Scheduling and recording belong to the runner;
// copy completeness, publication and handoff belong here. See ../CONTEXT.md.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { claimBackup, BACKUP_OWNER_FAILURE } from './backup-claim.mjs';
import { beadsDatabaseName, readTaskHost, taskHostFile } from './task-project-config.mjs';
import { redactLogText } from './os-log.mjs';
import { HOST_BACKUP_FILE, checkoutRelative, readablePath, installationDir } from './installation.mjs';
import { dumpPostgres, POSTGRES_DUMP_FILE } from './postgres-backup.mjs';
import { readDoltProfile } from './dolt-host.mjs';
import { backupDolt } from './dolt-backup.mjs';
import { backupAsset, validateAssetBackups } from './asset-backup.mjs';
import { createCloudflareD1BackupClient, cloudflareD1InventoryKey, copyCloudflareD1 } from './cloudflare-d1-backup.mjs';
import { backupDate, backupReportComplete, retainedBackupDates, validateBackupRetention } from './backup-retention.mjs';
import { BACKUP_PATHS, readBackupWorker, privateBackupFile } from './container-backup-profile.mjs';
import { dumpContainerPostgres, backupContainerDolt, copyContainerRecovery, verifyContainerRecovery, ownContainerBackup } from './container-backup-transport.mjs';
import { analyticalHistoryDirectory, backupAnalyticalHistory, verifyAnalyticalHistoryBackup,
  assertAnalyticalHistoryReplacement, retainedAnalyticalHistoryDates } from './analytical-history-backup.mjs';

const LABELS = {
  preparation: 'Preparation', postgres: 'Postgres', r2: 'R2', taskHub: 'Task hub', assets: 'Asset databases', history: 'Analytical history',
  instructions: 'Restore instructions', publication: 'Local publication',
  offsite: 'Offsite handoff', retention: 'Retention', cleanup: 'Cleanup',
  recovery: 'Recovery credentials',
};

function stage(status = 'completed') {
  return { status, expected: null, copied: 0, failureCount: 0, errors: [] };
}

function fail(result, item, error) {
  result.status = 'failed';
  result.failureCount += 1;
  if (result.errors.length < 8) result.errors.push({
    item: redactLogText(item).slice(0, 200),
    detail: redactLogText(error?.message ?? error).slice(0, 300),
  });
}

function summary(stages) {
  // Failures go first: the existing job ledger bounds the length of detail.
  return Object.entries(stages).sort(([, a], [, b]) =>
    Number(['failed', 'blocked'].includes(b.status)) - Number(['failed', 'blocked'].includes(a.status)),
  ).map(([key, result]) => `${LABELS[key]}: ${result.status}`
    + (result.expected === null ? '' : ` (${result.copied}/${result.expected})`)
    + (result.errors.length ? ` — ${result.errors[0].detail}` : '')).join(' · ');
}

function containerSummary(stages, claimIssue) {
  if (claimIssue) return BACKUP_OWNER_FAILURE.detail;
  const failed = Object.entries(stages).find(([, result]) => result.status === 'failed')
    ?? Object.entries(stages).find(([, result]) => result.status === 'blocked');
  if (failed?.[0] === 'preparation') return 'Preparation: failed. Check the backup worker configuration and saved locks before retrying.';
  if (failed) return `${LABELS[failed[0]]}: failed. Review the private backup report before retrying.`;
  return stages.offsite.status === 'completed'
    ? 'All configured stores backed up; declared offsite handoff completed.'
    : 'All configured stores backed up.';
}

/** Only an explicitly complete operation can become a successful job record. */
export function backupRunOutcome(result) {
  return {
    outcome: result?.ok === true ? 'ran' : 'failed',
    detail: result?.detail ?? 'Backup returned no complete result',
  };
}

/** This host's backup settings for the checkout at `repoRoot`: the
 * installation's `host-backup.json`, else the product's default, which names no
 * folder (config/host-backup.README.md). The home checkout for the live runner. */
export function hostBackupFile(repoRoot) {
  return readablePath(HOST_BACKUP_FILE, { root: repoRoot });
}

/**
 * The folder this host hands each finished set to, or null when it names none.
 * A file that is present but unreadable, or a value that is not an absolute
 * path, throws naming the file: a typo must fail the handoff it would otherwise
 * switch off in silence.
 */
async function readHostBackupSettings({ repoRoot, readHost }) {
  const file = hostBackupFile(repoRoot);
  let raw;
  try {
    raw = await (readHost ?? (() => fs.readFile(file, 'utf8')))();
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
  const where = checkoutRelative(file, { root: repoRoot });
  let settings;
  try {
    settings = JSON.parse(raw);
  } catch {
    throw new Error(`${where} is not valid JSON`);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`${where} must be an object`);
  return settings;
}

export async function readOffsiteBackupDir(options) {
  const settings = await readHostBackupSettings(options);
  const where = checkoutRelative(hostBackupFile(options.repoRoot), { root: options.repoRoot });
  return offsiteDirectory(settings, where);
}

function offsiteDirectory(settings, where) {
  const dir = settings.offsiteBackupDir;
  if (dir === null || dir === undefined) return null;
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
    throw new Error(`${where}: offsiteBackupDir must be an absolute folder path, or null for no offsite copy`);
  }
  return dir;
}

/**
 * Produce a fresh dated set, then hand it to the configured sync folder.
 * Every store and every independent item is attempted after failures elsewhere.
 * Only complete required-store sets are published; failed attempts keep the
 * previous dated set. Failed outputs never enter a set.
 * Filesystem/process adapters let tests exercise this same operation on scratch
 * stores. No adapter supplies a verdict or replaces an entire backup stage.
 *
 * `offsiteBackupDir` left out is read from this host's `host-backup.json`;
 * `null` means no offsite copy.
 *
 * `taskHub` says whose task hub this is. `required` — the NoticeOS stack's
 * host runs the hub, so an empty inventory is a failure and every database is
 * copied through the checkout at `repoRoot`. `linked` — an installation
 * `pnpm start` runs backs up only the task databases its
 * host links, each through its own linked checkout; linking none is
 * `not_configured`, like an offsite folder nobody named.
 */
export async function runBackup({ repoRoot, retentionDays, offsiteBackupDir, bdBinary = 'bd', taskHub = 'required', doltHome, transport }, adapters = {}) {
  const io = adapters.fs ?? fs;
  const launch = adapters.spawn ?? spawn;
  const now = adapters.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const day = startedAt.slice(0, 10);
  const root = path.join(repoRoot, '.local', 'backups');
  const destination = path.join(root, day);
  const r2Root = path.join(repoRoot, '.wrangler/state/v3/r2');
  const containerMode = transport === 'container';
  const stores = ['postgres', 'r2', 'taskHub', 'assets', 'history', ...(containerMode ? ['recovery'] : [])];
  const stages = Object.fromEntries(Object.keys(LABELS).filter(key => key !== 'recovery' || containerMode).map((key) => [key, stage('blocked')]));
  const requiredComplete = () => [...stores, 'instructions']
    .every((key) => ['completed', 'not_configured'].includes(stages[key].status));
  stages.cleanup = stage();
  let settings = {};
  let composeTaskHub = false;
  let settingsError;
  let assetBackups = [];
  let historyDirectory = null;
  let historyCustody = null;
  const cloudflareCustody = [];
  let retention = null;
  let preparationError;
  let worker;
  try {
    if (transport !== undefined && !containerMode) throw new Error('Unknown backup transport; no fallback was selected.');
    if (containerMode) {
      if (repoRoot !== '/state' || doltHome !== undefined) throw new Error('Container backup requires its fixed worker installation.');
      worker = readBackupWorker();
    }
  } catch (error) { preparationError = error; }
  try {
    settings = await readHostBackupSettings({ repoRoot, readHost: () => containerMode
      ? privateBackupFile('/run/backup-worker/host-backup.json').text
      : io.readFile(hostBackupFile(repoRoot), 'utf8') });
  } catch (error) { settingsError = error; }
  try {
    if (settingsError) throw settingsError;
    assetBackups = validateAssetBackups(settings.assetBackups);
  } catch (error) { fail(stages.assets, 'Settings', error); }
  try {
    if (settingsError) throw settingsError;
    historyDirectory = analyticalHistoryDirectory(settings);
  } catch (error) { fail(stages.history, 'Settings', error); }
  try { retention = validateBackupRetention(settings.retention); }
  catch (error) { fail(stages.retention, 'Settings', error); }
  if (offsiteBackupDir === undefined) {
    try {
      if (settingsError) throw settingsError;
      offsiteBackupDir = offsiteDirectory(settings, checkoutRelative(hostBackupFile(repoRoot), { root: repoRoot }));
      if (containerMode && offsiteBackupDir !== null && offsiteBackupDir !== BACKUP_PATHS.offsite) {
        throw new Error('The backup worker requires its declared offsite mount.');
      }
    } catch (error) {
      // The local set is still taken; the handoff it cannot find fails the run.
      offsiteBackupDir = null;
      stages.offsite = stage();
      fail(stages.offsite, 'Setting', error);
    }
  }
  if (!offsiteBackupDir && stages.offsite.status === 'blocked') stages.offsite = stage('not_configured');
  let working = null;
  let published = false;
  let cleanOutputs = true;
  let claim = null;
  let ownsClaim = false;
  let claimIssue = false;
  const temporary = new Set();

  async function claimRun() {
    try { claim = await claimBackup(root, { fs: io, namespace: adapters.claimNamespace }); }
    catch (error) { claimIssue = error?.code === BACKUP_OWNER_FAILURE.code; throw error; }
    ownsClaim = true;
  }

  async function attempt(key, operation) {
    const result = stages[key] = stage();
    try { await operation(result); }
    catch (error) { fail(result, key, error); }
    return result;
  }

  async function removePartial(output, result) {
    try { await io.rm(output, { recursive: true, force: true }); }
    catch (error) {
      cleanOutputs = false;
      fail(result, 'Remove partial output', error);
    }
  }

  function command(binary, args, { cwd = repoRoot, processGroup = false, env } = {}) {
    return new Promise((resolve, reject) => {
      // Discard process output: backup commands can echo connection details.
      const child = launch(binary, args, { cwd, stdio: ['ignore', 'ignore', 'ignore'],
        ...(processGroup ? { detached: true } : {}), ...(env ? { env: containerMode && binary === 'npm'
          ? { ...env, HOME: BACKUP_PATHS.exporterHome, XDG_CONFIG_HOME: path.join(BACKUP_PATHS.exporterHome, '.config'),
            npm_config_cache: path.join(BACKUP_PATHS.exporterHome, '.npm') } : env } : {}),
        ...(containerMode && binary === 'npm' ? { uid: worker.clientUid, gid: worker.clientGid } : {}) });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (processGroup && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch { /* Already exited. */ }
      }, adapters.commandTimeoutMs ?? (processGroup ? 30 * 60_000 : 120_000));
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (!timedOut && code === 0) resolve();
        else reject(new Error(timedOut ? 'Backup command timed out' : `Backup command failed (${signal ?? code})`));
      });
    });
  }

  async function copyItem(result, name, output, copy, sqlite = false) {
    try {
      await io.mkdir(path.dirname(output), { recursive: true });
      await copy();
      const copied = await io.lstat(output);
      if (sqlite) {
        if (!copied.isFile() || copied.size === 0) throw new Error('SQLite snapshot is missing or empty');
        for (const suffix of ['-wal', '-shm']) await io.rm(output + suffix, { force: true });
      }
      result.copied += 1;
    } catch (error) {
      fail(result, name, error);
      await removePartial(output, result);
      if (sqlite) {
        for (const suffix of ['-wal', '-shm']) await removePartial(output + suffix, result);
      }
    }
  }

  // SQLite's online-backup API only reads the source, but the connection is
  // deliberately read-write: a WAL database cannot be read without its -shm
  // index, and a read-only connection may not create one. `persist_wal 0`
  // overrides Apple's default so the last connection to close removes the
  // sidecars again; a live writer's stay untouched. URI `mode=rw` never
  // creates a missing source and works with older Linux CLIs that lack
  // `-ifexists`. Never `?immutable=1`: it skips locking and the WAL, so a
  // live source loses committed data.
  const snapshot = (source, output) => command('sqlite3', [
    '-bail', `${pathToFileURL(source).href}?mode=rw`, '.timeout 5000', '.filectrl persist_wal 0', `.backup ${JSON.stringify(output)}`,
  ]);

  async function freshDirectory(base) {
    const dir = await io.mkdtemp(path.join(base, '.backup-'));
    temporary.add(dir);
    return dir;
  }

  async function recoverPrevious(base) {
    for (const name of await io.readdir(base)) {
      const match = /^\.backup-previous-(\d{4}-\d{2}-\d{2})$/.exec(name);
      if (!match) continue;
      const previous = path.join(base, name);
      const target = path.join(base, match[1]);
      try { await io.lstat(target); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await io.rename(previous, target);
        continue;
      }
      // The new tree can exist only after the completed set's rename. A kill
      // between that rename and cleanup leaves two good copies, never partial.
      // Verify held coverage before retiring custody left by that interruption.
      await assertAnalyticalHistoryReplacement(previous, target, { io });
      await io.rm(previous, { recursive: true, force: true });
    }
  }

  async function replaceDirectory(source, target) {
    // Two renames with rollback, not an atomic directory exchange. Keep the
    // previous set until the new tree is ready; never merge same-day contents.
    // A deterministic recovery path survives an abrupt process exit. It is
    // never in `temporary`, so cleanup cannot delete the only previous copy.
    await recoverPrevious(path.dirname(target));
    await assertAnalyticalHistoryReplacement(target, source, { io });
    const previous = path.join(path.dirname(target), `.backup-previous-${path.basename(target)}`);
    let movedPrevious = false;
    try {
      await io.rename(target, previous);
      movedPrevious = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try { await io.rename(source, target); }
    catch (error) {
      if (movedPrevious) {
        try { await io.rename(previous, target); }
        catch (rollbackError) {
          // Never delete the only remaining old copy after a failed rollback.
          throw new Error(`Publication failed; previous set retained at ${previous}: ${rollbackError.message}`);
        }
      }
      throw error;
    }
    temporary.delete(source);
    if (movedPrevious) await io.rm(previous, { recursive: true, force: true });
  }

  async function prune(base, result) {
    const entries = await io.readdir(base, { withFileTypes: true });
    const dates = entries.filter(entry => entry.isDirectory() && backupDate(entry.name) !== null
      && backupDate(entry.name) <= Date.parse(`${day}T00:00:00Z`)).map(entry => entry.name);
    if (retention) {
      const known = [];
      const complete = [];
      const unverified = [];
      for (const entry of entries) {
        const date = backupDate(entry.name);
        if (!entry.isDirectory() || date === null || date > Date.parse(`${day}T00:00:00Z`)) continue;
        const verdict = await setComplete(path.join(base, entry.name));
        // Never delete unrelated or unrecognized directories in a sync folder.
        if (verdict === null) continue;
        if (verdict === 'legacy_unverified') unverified.push(entry.name);
        else known.push(entry.name);
        if (verdict === true) complete.push(entry.name);
      }
      if (complete.some((name) => backupDate(name) <= Date.parse(`${day}T00:00:00Z`) - 7 * 86_400_000)) known.push(...unverified);
      const keep = await retainedAnalyticalHistoryDates(base, dates, retainedBackupDates(complete, retention), { io });
      for (const name of known.filter((name) => !keep.has(name))) {
        try { await io.rm(path.join(base, name), { recursive: true, force: true }); }
        catch (error) { fail(result, name, error); }
      }
      return;
    }
    const keep = await retainedAnalyticalHistoryDates(base, dates,
      new Set(dates.filter(date => backupDate(date) >= now() - retentionDays * 86_400_000)), { io });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
      const date = Date.parse(`${entry.name}T00:00:00Z`);
      if (Number.isFinite(date) && date < now() - retentionDays * 86_400_000 && !keep.has(entry.name)) {
        try { await io.rm(path.join(base, entry.name), { recursive: true, force: true }); }
        catch (error) { fail(result, entry.name, error); }
      }
    }
  }

  async function setComplete(directory) {
    try {
      const manifest = JSON.parse(await io.readFile(path.join(directory, 'backup.json'), 'utf8'));
      return manifest.format === 'noticeos-backup-v1' && typeof manifest.complete === 'boolean' ? manifest.complete : null;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Recognize older sets by the existing generated restore report.
    try {
      const instructions = await io.readFile(path.join(directory, 'RESTORE.md'), 'utf8');
      return backupReportComplete(instructions, path.basename(directory));
    } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
  }

  const storesComplete = () => stores.every((key) =>
    ['completed', 'not_configured'].includes(stages[key].status));

  try {
    await attempt('preparation', async () => {
      if (preparationError) throw preparationError;
      await io.mkdir(root, { recursive: true });
      if (containerMode) {
        const directory = await io.lstat(root);
        if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Backup storage must be a private regular folder.');
        await io.chmod(root, 0o700);
        await io.chown(root, worker.operatorUid, worker.operatorGid);
      }
      await claimRun();
      await recoverPrevious(root);
      working = await freshDirectory(root);
    });
    if (working) {
      if (containerMode) await attempt('recovery', async result => {
        const copied = await copyContainerRecovery(path.join(working, 'recovery'));
        result.expected = copied.files; result.copied = copied.files;
      });
      await attempt('postgres', async (result) => {
        result.expected = 1;
        const output = path.join(working, POSTGRES_DUMP_FILE);
        await copyItem(result, 'Operational database', output,
          () => containerMode ? dumpContainerPostgres(output) : dumpPostgres(repoRoot, output, { ...adapters, fs: io, spawn: launch }));
      });

      await attempt('r2', async (result) => {
        const names = (await io.readdir(r2Root, { recursive: true })).sort();
        result.expected = 0; // An existing, readable, empty R2 store is valid.
        await io.mkdir(path.join(working, 'r2'), { recursive: true });
        for (const name of names) {
          if (name.endsWith('-wal') || name.endsWith('-shm')) continue;
          const source = path.join(r2Root, name);
          const output = path.join(working, 'r2', name);
          try {
            if (!(await io.lstat(source)).isFile()) continue;
          } catch (error) {
            result.expected += 1;
            fail(result, name, error);
            continue;
          }
          result.expected += 1;
          const sqlite = name.endsWith('.sqlite');
          await copyItem(result, name, output,
            () => sqlite ? snapshot(source, output) : io.copyFile(source, output), sqlite);
        }
      });

      await attempt('taskHub', async (result) => {
        // A declared container profile owns its storage boundary. A malformed
        // profile fails this stage; it must never fall back to another hub.
        if (doltHome !== undefined && (typeof doltHome !== 'string' || !path.isAbsolute(doltHome))) {
          throw new Error('The selected task backup home must be an absolute declared installation folder.');
        }
        const profile = containerMode ? null : await readDoltProfile(doltHome ?? repoRoot);
        if (doltHome !== undefined && !profile) throw new Error('The selected task backup home has no declared Dolt profile; legacy capture was refused.');
        composeTaskHub = containerMode || profile !== null;
        const host = await readTaskHost({
          repoRoot, readHost: () => io.readFile(taskHostFile(repoRoot), 'utf8'), absentLinksNone: taskHub === 'linked',
        });
        // Each database, and the checkout `bd` reads it through.
        const databases = new Map();
        result.expected = 0;
        for (const row of host.repositories) {
          const database = beadsDatabaseName(row?.database);
          if (database) {
            if (!databases.has(database)) databases.set(database, taskHub === 'linked' ? path.resolve(repoRoot, String(row?.repo ?? '')) : repoRoot);
          } else {
            result.expected += 1;
            fail(result, 'Inventory', 'Invalid task database name');
          }
        }
        result.expected += databases.size;
        if (!result.expected) {
          if (taskHub === 'linked' && !composeTaskHub) {
            stages.taskHub = stage('not_configured');
            return;
          }
          fail(result, 'Inventory', 'No task databases configured');
        }
        if (containerMode || profile) {
          if (!databases.size) return;
          const failures = result.failureCount;
          await copyItem(result, 'Task hub', path.join(working, 'beads'), () =>
            containerMode ? backupContainerDolt([...databases.keys()], path.join(working, 'beads')) : backupDolt(profile, [...databases.keys()], path.join(working, 'beads'), {
              run: adapters.runDolt,
              env: adapters.env ?? process.env,
            }));
          // The transport verifies the whole declared set, including server
          // metadata. Count its databases only after every part succeeds.
          if (result.failureCount === failures) result.copied = databases.size;
          return;
        }
        for (const [database, checkout] of databases) {
          const output = path.join(working, 'beads', database);
          const url = `file://${output}`.replaceAll('\\', '\\\\').replaceAll("'", "''");
          await copyItem(result, database, output, async () => {
            await command(bdBinary, [
              '-C', checkout, '--quiet', 'sql', `USE ${database}; CALL DOLT_BACKUP('sync-url', '${url}')`,
            ]);
            if (!(await io.readdir(output)).length) throw new Error('Task database backup is empty');
          });
        }
      });

      if (stages.assets.status !== 'failed') {
        await attempt('assets', async (result) => {
          const client = adapters.cloudflareD1 ?? createCloudflareD1BackupClient({ repoRoot, transport, env: adapters.env ?? process.env });
          const selection = await client.inventory();
          const inventoryKey = cloudflareD1InventoryKey(selection);
          const targets = selection?.targets ?? [];
          result.expected = assetBackups.length + targets.length;
          const nativeAssets = new Set(targets.map(target => target.asset));
          if (assetBackups.some(source => nativeAssets.has(source.asset))) throw new Error('An asset has both legacy and native D1 backup declarations; choose one before retrying.');
          for (const source of assetBackups) {
            const output = path.join(working, 'assets', source.asset);
            await copyItem(result, source.asset, output, async () => {
              const directory = await freshDirectory(root);
              if (containerMode) await io.chown(directory, worker.clientUid, worker.clientGid);
              await backupAsset({ source, repoRoot, output, directory, io, command });
            });
          }
          for (const target of targets) {
            const relative = path.posix.join('cloudflare-d1', selection.accountId, target.databaseId);
            const output = path.join(working, relative);
            await copyItem(result, target.databaseId, output, async () => {
              const custody = await copyCloudflareD1({ client, selection, target, output, io });
              cloudflareCustody.push({ directory: relative, ...custody });
            });
          }
          if (cloudflareD1InventoryKey(await client.inventory()) !== inventoryKey) throw new Error('Cloudflare D1 selection changed during backup; the previous complete set is preserved.');
          if (!result.expected) stages.assets = stage('not_configured');
        });
      }

      if (stages.history.status !== 'failed') {
        if (historyDirectory === null) stages.history = stage('not_configured');
        else await attempt('history', async result => {
          result.expected = 1;
          await copyItem(result, 'Published analytical generations', path.join(working, 'history'), async () => {
            historyCustody = await backupAnalyticalHistory({
              installation: installationDir({ root: repoRoot, env: adapters.env ?? process.env }),
              relative: historyDirectory, output: path.join(working, 'history'), io,
            });
          });
        });
      }

      if (containerMode && stages.recovery.status === 'completed') {
        try { await verifyContainerRecovery(path.join(working, 'recovery')); }
        catch (error) { fail(stages.recovery, 'Credential generation', error); }
      }

      await attempt('instructions', async () => {
        await io.writeFile(path.join(working, 'RESTORE.md'), restoreInstructions(startedAt, stages, retentionDays, retention, composeTaskHub, containerMode));
        await io.writeFile(path.join(working, 'backup.json'), JSON.stringify({
          format: 'noticeos-backup-v1', startedAt, complete: storesComplete(),
          ...(historyCustody ? { analyticalHistory: historyCustody } : {}),
          ...(cloudflareCustody.length ? { cloudflareD1: cloudflareCustody } : {}),
        }, null, 2) + '\n');
      });
      // A failed required store never reaches publication. Keep the existing
      // explicit preservation check as a second guard for the dated local set.
      if (cleanOutputs && requiredComplete()) {
        await attempt('publication', async () => {
          if (containerMode) await ownContainerBackup(working, worker);
          if (!storesComplete() && [true, 'legacy_unverified'].includes(await setComplete(destination))) {
            throw new Error('Incomplete rerun: preserving the existing backup');
          }
          await replaceDirectory(working, destination);
          published = true;
        });
      }
      if (offsiteBackupDir && published) {
        await attempt('offsite', async () => {
          // The existing synchronization parent must exist. Never fabricate a
          // local replacement for an unavailable sync mount.
          await io.access(path.dirname(offsiteBackupDir));
          await io.mkdir(offsiteBackupDir, { recursive: true });
          if (containerMode) {
            const directory = await io.lstat(offsiteBackupDir);
            if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Backup handoff must be a private regular folder.');
            await io.chmod(offsiteBackupDir, 0o700);
            await io.chown(offsiteBackupDir, worker.operatorUid, worker.operatorGid);
          }
          await recoverPrevious(offsiteBackupDir);
          if (!storesComplete() && [true, 'legacy_unverified'].includes(await setComplete(path.join(offsiteBackupDir, day)))) {
            throw new Error('Incomplete rerun: preserving the existing offsite backup');
          }
          const offsiteWorking = await freshDirectory(offsiteBackupDir);
          await io.cp(destination, offsiteWorking, { recursive: true });
          if (historyCustody) await verifyAnalyticalHistoryBackup(path.join(offsiteWorking, 'history'), { io, expected: historyCustody });
          if (containerMode) await ownContainerBackup(offsiteWorking, worker, { offsite: true });
          await replaceDirectory(offsiteWorking, path.join(offsiteBackupDir, day));
        });
      }
    }

    if (ownsClaim && stages.retention.status !== 'failed' && published && storesComplete()
      && ['completed', 'not_configured'].includes(stages.offsite.status)) await attempt('retention', async (result) => {
      for (const base of [root, ...(offsiteBackupDir ? [offsiteBackupDir] : [])]) {
        try { await prune(base, result); }
        catch (error) { fail(result, base, error); }
      }
    });
    for (const dir of temporary) {
      try { await io.rm(dir, { recursive: true, force: true }); }
      catch (error) { fail(stages.cleanup, dir, error); }
    }
  } finally {
    if (claim) {
      try { await claim.release(); }
      catch (error) { fail(stages.cleanup, claim.directory, error); }
    }
  }
  // A task hub this installation does not link (`linked`) is not missing.
  const complete = storesComplete() && stages.instructions.status === 'completed';
  return {
    ok: Object.values(stages).every((result) => ['completed', 'not_configured'].includes(result.status)),
    // Container jobs return only a bounded verdict to the Tower. Full stage
    // diagnostics remain in the operator's private restore report.
    detail: containerMode ? containerSummary(stages, claimIssue) : summary(stages), day, startedAt,
    backupSet: { path: published ? destination : null, complete: published && complete },
    stages,
    // Existing workflow recording projects outcomes, never arbitrary objects.
    // Keep store counts and stage verdicts visible without exposing raw errors.
    outcomes: Object.entries(stages).map(([id, result]) => ({
      id,
      ...(result.status === 'not_configured' ? { status: 'skipped' } : { ok: result.status === 'completed' }),
      ...(result.expected === null ? {} : {
        attempted: result.expected, succeeded: result.copied, failed: result.expected - result.copied,
      }),
    })),
  };
}

function restoreInstructions(startedAt, stages, retentionDays, retention, composeTaskHub = false, containerMode = false) {
  const stores = ['postgres', 'r2', 'taskHub', 'assets', 'history', ...(containerMode ? ['recovery'] : [])].map((key) => {
    const result = stages[key];
    return `- ${LABELS[key]}: ${result.status}; ${result.copied}/${result.expected ?? 'unknown'} copied`
      + result.errors.map((error) => `\n  - ${error.item}: ${error.detail}`).join('');
  }).join('\n');
  return `# NoticeOS backup — ${startedAt.slice(0, 10)}

Created at ${startedAt} by \`scripts/host-backup.mjs\` (nightly 04:00 UTC or
manual \`pnpm os:backup\`). ${retention
    ? `Retention keeps ${retention.daily} daily and ${retention.weekly} weekly complete sets (first successful set of each UTC Monday week).`
    : `Dated dirs are pruned after ${retentionDays} days.`}
Pruning runs only after all configured stores and the offsite handoff succeed.
With two or more weekly slots, an available week-old anchor stays until its replacement is a week old.

## Backup set

${stores}

This set contains every required store. Check the copy results before restoring.
The Postgres dump and each SQLite file are individually consistent; the stores are copied in sequence,
not at one shared instant. Copy completion does not establish restore verification.
The job-run record reports the final offsite handoff separately. A handoff into
the synchronization folder does not establish completed remote synchronization.

## Contents

- \`postgres/noticeos.dump\`: custom-format operational Postgres dump, taken on
  the declared Compose service's local socket. Schema ownership and ACLs are kept;
  ${containerMode ? 'protected role credentials and bootstrap secrets are kept separately in `recovery/`.' : 'role passwords and host bootstrap secrets are excluded.'}
- \`r2/\`: immutable blobs and online SQLite metadata snapshots from \`.wrangler/state/v3/r2/\`.
${composeTaskHub
    ? '- `beads/`: online Dolt database snapshots, server metadata and a complete-backup manifest for the declared Compose task hub.'
    : '- `beads/<db>/`: consistent Dolt backups of the physical databases in the installation\'s `task-host.json`.'}
- \`assets/<asset>/*.sql.gz\`: gzip-compressed exports from explicitly configured asset \`backup:prod\` tasks.
- \`cloudflare-d1/<account>/<database>/\`, when selected in Integrations:
  verified native \`export.sql.gz\` and \`receipt.json\` with asset mapping,
  SQL/compressed byte counts and SHA-256 hashes, and the D1 REST import pointer.
- \`history/\`, when configured: every generation published at snapshot start and
  all referenced Parquet files, including held table datasets. \`custody.json\`
  records their generation content fingerprints and file sizes/SHA-256 hashes.
- \`backup.json\`: copy completeness used by daily/weekly retention.
- \`RESTORE.md\`: these copy results and restore instructions.
${containerMode ? '- `recovery/`: private bootstrap credentials, Postgres role custody and task installation declarations, with a hashed manifest. Keep the whole set private.\n' : ''}

## Restore

Never restore over a RUNNING system. Restore into an isolated scratch copy first;
replacing an existing installation requires an explicitly approved maintenance window.

- Inspect SQLite files: \`sqlite3 <file>.sqlite "PRAGMA integrity_check;"\`.
- Postgres: prepare roles from \`db/postgres/roles.sql\` and a separate empty
  database owned by \`noticeos_owner\`. Inside its isolated Postgres container,
  as the operating-system user \`postgres\` (required by peer authentication), run
  \`pg_restore --host=/var/run/postgresql --username=postgres --no-password --dbname=<empty-db> --exit-on-error < noticeos.dump\`.
  Do not apply migrations before restoring; the dump includes the schema and
  recorded migration hashes. Reconcile rows, archive references and application
  reads/writes before accepting recovery. No existing database is replaced here.
- R2: copy \`r2/\` back over \`.wrangler/state/v3/r2/\`.
- Analytical history: copy the whole \`history/\` tree into a new scratch folder.
  Run \`verifyAnalyticalHistoryBackup\` from \`scripts/analytical-history-backup.mjs\`
  against that folder, then use the existing history readers with its published
  manifests to read retained rows. Parquet files and manifests must stay together;
  PostgreSQL does not contain rows held only in history. Byte custody does not
  authorize operational row deletion or establish analytical readback by itself.
- Asset SQL: \`gzip -t <export>.sql.gz\` checks the archive; \`gzip -dc <export>.sql.gz > restore.sql\`
  decompresses it. Verify against an isolated database before any separately approved production restore.
- Native D1: use the account/database and hashes in \`receipt.json\`, verify
  both the gzip and decompressed SQL, and test the SQL in an isolated database.
  The receipt links Cloudflare's REST import procedure. Import into a named
  remote database is a separate, explicitly approved operation; this backup
  performs no restore, database deletion or schema migration.
${composeTaskHub
    ? '- Task hub: follow `db/dolt/host/README.md` to restore `beads/` into a new, empty Compose project with the pinned Dolt image. Restore the database snapshots and server metadata together, then verify task records, history and access before accepting recovery. Database snapshots are taken sequentially while the source stays online; they are not one transaction across all projects.'
    : '- Task hub: from an empty scratch directory, run\n  `dolt backup restore file://<this-dir>/beads/<db> <db>`, then inspect with `dolt sql`.\n  Move it into the hub\'s data directory only with the hub service stopped.'}

Operational detail and the restore drill: scripts/README.md in the repo.
Cadence and retention: config/host-backup.README.md.
Terminology: CONTEXT.md in the repo.
`;
}
