// start-host-lanes.mjs — the host lanes an installation `pnpm start` runs,
// once it has set them up.
//
// The managed service runs every host lane on the host it owns
// (scripts/os-up.mjs). A started installation runs the two a stranger's
// installation can set up from its own Tower and folder, each only once it is
// set up:
//
//   Task board refresh (`beads-snapshot`) — once a task project is saved
//     (`config/beads.json` in its store, Settings → Task projects). Fresh
//     startup creates the OS's core project even with no portfolio sites. It reads the
//     projects through the checkouts its folder's `installation/task-host.json`
//     links and files the snapshot at ITS door with ITS token, which is what
//     turns its task screens on (apps/tower/shared/task-source.ts).
//   Backups (`backup`) — once its folder's `installation/host-backup.json` names
//     an offsite folder: its own store, and the task databases it links.
//
// Until then a lane is off: never fired, never recorded and not in the
// schedule's status, so the Tower does not list it
// (apps/tower/shared/workflows.ts installedWorkflows). This module is the host
// adapter: a cloud installation replaces it with its own.

import fs from 'node:fs/promises';
import path from 'node:path';
import { backupRunOutcome, readOffsiteBackupDir, runBackup } from './host-backup.mjs';
import { doorUrl } from './ingest-door.mjs';
import { HOST_BACKUP_FILE } from './installation.mjs';
import { SCHEDULED_JOBS } from './scheduled-jobs.mjs';
import { readTaskProjectConfig } from './task-project-config.mjs';

export const TASK_BOARD_LANE = 'beads-snapshot';
export const BACKUP_LANE = 'backup';
/** The host lanes a started installation can run, as scheduled jobs. */
export const STARTED_HOST_JOBS = SCHEDULED_JOBS.filter((job) => job.id === TASK_BOARD_LANE || job.id === BACKUP_LANE);

const HOUR_MS = 60 * 60 * 1000;
/** A started installation is down whenever its person is not running it, so a
 * missed night's backup is paid at the next start, as the managed service does
 * (scripts/runner/scheduler.mjs STARTUP_CATCHUP_POLICIES). */
export const BACKUP_CATCHUP = Object.freeze({
  job: BACKUP_LANE,
  expression: STARTED_HOST_JOBS.find((job) => job.id === BACKUP_LANE).cron,
  kind: 'backup',
  maxAgeMs: 36 * HOUR_MS,
});

/** The saved task projects' hub and whether any project is saved, from the
 * config documents the schedule reads. */
export function savedTaskProjects(documents) {
  const body = Array.isArray(documents) ? documents.find((row) => row?.file === 'config/beads.json')?.body : undefined;
  const spokes = Array.isArray(body?.spokes) ? body.spokes : [];
  const hub = body?.hub;
  return {
    saved: spokes.length > 0,
    hub: typeof hub?.host === 'string' && Number.isInteger(hub?.port) ? { host: hub.host, port: hub.port } : null,
  };
}

/**
 * The started installation's host lanes. `observe` takes the config documents
 * the schedule just read (the task projects live there), `refresh` reads the
 * folder's own backup setting; `runs(id)` is then whether a lane is on, and
 * `run(id)` its body. Every dependency that touches the world is injectable.
 */
export function createStartedHostLanes({
  home,
  installation = path.join(home, 'installation'),
  door,
  token,
  emit = () => {},
  now = Date.now,
  fetchImpl = fetch,
  stopped = () => false,
  readBackupSetting = () => fs.readFile(path.join(installation, HOST_BACKUP_FILE), 'utf8'),
  runner = () => import('./os-up.mjs'),
  backup = runBackup,
  taskRun = null,
}) {
  let taskProjects = { saved: false, hub: null };
  // `undefined`: a setting is there but unreadable — the lane stays on and
  // the backup reads it again, failing its offsite stage where the operator
  // sees it (scripts/host-backup.mjs runBackup).
  let offsiteBackupDir = null;
  const pollState = { skipping: null };

  async function taskBoard() {
    const managed = await runner();
    return managed.runBeadsPoll({ running: true, ready: true }, {
      probe: () => (taskProjects.hub ? managed.probeTcp(taskProjects.hub.host, taskProjects.hub.port) : Promise.resolve(true)),
      readConfig: () => readTaskProjectConfig({ repoRoot: home, door, token, fetchImpl }),
      readToken: async () => token,
      run: taskRun ?? managed.runBd,
      post: fetchImpl,
      now,
      state: pollState,
      emit,
      stopped,
      url: doorUrl(door, 'api/beads-snapshot'),
      repoRoot: home,
    });
  }

  async function backUp() {
    const managed = await runner();
    const result = await backup({
      repoRoot: home,
      retentionDays: managed.CONFIG.backupRetentionDays,
      offsiteBackupDir,
      bdBinary: managed.bdBin(),
      taskHub: 'linked',
    });
    emit(result.ok ? 'INFO' : 'ERROR', `backup: ${result.detail}`);
    return result;
  }

  return {
    observe(documents) {
      if (Array.isArray(documents)) taskProjects = savedTaskProjects(documents);
    },
    async refresh() {
      try {
        offsiteBackupDir = await readOffsiteBackupDir({ repoRoot: home, readHost: readBackupSetting });
      } catch {
        offsiteBackupDir = undefined;
      }
    },
    runs(id) {
      if (id === TASK_BOARD_LANE) return taskProjects.saved;
      if (id === BACKUP_LANE) return offsiteBackupDir !== null;
      return false;
    },
    /** The lane's body and how its result becomes a job-run outcome — the
     * managed service's own mapping for each (scripts/os-up.mjs hostLanes). */
    run(id) {
      if (id === TASK_BOARD_LANE) return { fn: taskBoard, outcomeOf: (result) => (result === null ? 'skipped' : 'ran') };
      if (id === BACKUP_LANE) return { fn: backUp, outcomeOf: backupRunOutcome };
      return null;
    },
  };
}
