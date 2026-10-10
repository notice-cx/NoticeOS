// The store's capacity inventory, for `pnpm os:doctor` and `pnpm os:capacity`.
// It measures the live store without opening it: GET /api/capacity over the
// loopback door, with the operator bearer, answers metadata only (names,
// counts, byte totals and arrival dates; workers/ingest/src/capacity.ts). The
// backup line stats the newest nightly backup's files; it never opens one.
// What the numbers are for: docs/26-storage-capacity.md.

import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_DOOR, doorRequest, doorUrl, operatorToken } from './ingest-door.mjs';

/** Ask the store for its inventory. Throws with a sentence an operator can act on. */
export async function readCapacity({ door = DEFAULT_DOOR, token, fetchImpl = fetch } = {}) {
  const response = await doorRequest(fetchImpl, doorUrl(door, '/api/capacity'), {
    token,
    method: 'GET',
    signal: AbortSignal.timeout(120_000),
  });
  return response.json();
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** 1,536 → "1.5 KB". Binary multiples, one decimal from KB up. */
export function formatBytes(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unknown';
  let n = Math.max(0, value);
  let unit = 0;
  while (n >= 1024 && unit < UNITS.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${Math.round(n)} B` : `${n.toFixed(1)} ${UNITS[unit]}`;
}

export function formatCount(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Math.round(value) === value
    ? value.toLocaleString('en-US')
    : value.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function formatMs(value) {
  if (value === null || value === undefined) return '—';
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`;
}

function pad(text, width) {
  const s = String(text);
  return s.length >= width ? `${s} ` : s + ' '.repeat(width - s.length);
}

/** The inventory as report lines. Pure: no I/O, so the format is testable. */
export function capacityLines(inventory) {
  const lines = [];
  const { store, windows } = inventory;
  lines.push(
    `  measured    ${inventory.generatedAt} · windows: last ${windows.shortDays} days (from ${windows.shortSince}), last ${windows.longDays} days (from ${windows.longSince})`,
    `  store       ${formatBytes(store.bytes)} on disk · ${formatBytes(store.valueBytes)} in stored values · ${formatBytes(store.unattributedBytes)} indexes, page overhead and free space`,
    `  growth      ${formatCount(store.rows)} rows · +${formatCount(store.historyRowsPerDay)} rows/day and +${formatBytes(store.historyBytesPerDay)}/day into tables that keep every row (≈ ${formatBytes(store.historyBytesPerDay * 365)}/year at this rate)`,
    `  schema      ${store.tables} tables, ${store.views.length} views${store.missingTables.length > 0 ? ` · not in this store (migration not applied): ${store.missingTables.join(', ')}` : ''}`,
    `  scan        ${formatMs(store.scanMs)} to read every table once`,
    '',
    `  ${pad('table', 30)}${pad('kind', 9)}${pad('rows', 12)}${pad('values', 11)}${pad('+rows/day', 11)}${pad('+bytes/day', 12)}${pad('largest column', 22)}first row`,
  );
  for (const table of inventory.tables) {
    lines.push(
      `  ${pad(table.name, 30)}${pad(table.shape, 9)}${pad(formatCount(table.rows), 12)}${pad(formatBytes(table.valueBytes), 11)}` +
        `${pad(table.rowsPerDay === null ? '—' : formatCount(table.rowsPerDay), 11)}` +
        `${pad(table.bytesPerDay === null ? '—' : formatBytes(table.bytesPerDay), 12)}` +
        `${pad(table.largestColumn ? `${table.largestColumn.name} ${formatBytes(table.largestColumn.bytes)}` : '—', 22)}` +
        `${table.firstAt ? table.firstAt.slice(0, 10) : '—'}`,
    );
  }

  const snapshots = inventory.insightSnapshots;
  lines.push('');
  if (snapshots) {
    lines.push(
      `  snapshots   ${formatCount(snapshots.rows)} rows · ${formatBytes(snapshots.payloadBytes)} · largest ${formatBytes(snapshots.maxPayloadBytes)} · +${formatCount(snapshots.rowsPerDay)} rows/day · +${formatBytes(snapshots.bytesPerDay)}/day`,
      `              read: the two newest per site, ${formatCount(snapshots.readRows)} rows (${formatBytes(snapshots.readBytes)}) · kept but unread: ${formatCount(snapshots.supersededRows)} rows (${formatBytes(snapshots.supersededBytes)})`,
    );
    for (const site of snapshots.byAsset) {
      lines.push(
        `              ${pad(site.asset, 28)}${pad(`${formatCount(site.rows)} rows`, 12)}${pad(formatBytes(site.payloadBytes), 11)}` +
          `${site.rowsLongWindow} new on ${site.publishDaysLongWindow} days in the last ${windows.longDays}`,
      );
    }
  } else {
    lines.push('  snapshots   this store has no insight-snapshot table');
  }

  const archive = inventory.archive;
  lines.push('');
  if (archive) {
    const m = archive.manifests;
    lines.push(
      `  archive     manifests: ${formatCount(m.runs)} runs · ${formatCount(m.objects)} objects · ${formatBytes(m.objectBytes)} · +${formatCount(m.objectsPerDay)} objects/day · +${formatBytes(m.bytesPerDay)}/day`,
    );
    for (const row of m.byIntegration) {
      lines.push(
        `              ${pad(row.integration, 16)}${pad(`${formatCount(row.runs)} runs`, 13)}${pad(`${formatCount(row.objects)} objects`, 16)}${pad(formatBytes(row.objectBytes), 11)}` +
          `${row.success} stored, ${row.unchanged} unchanged, ${row.error} failed`,
      );
    }
    const bucket = archive.bucket;
    if ('error' in bucket) {
      lines.push(`              bucket listing failed: ${bucket.error}`);
    } else {
      lines.push(
        `              bucket: ${formatCount(bucket.objects)} objects · ${formatBytes(bucket.bytes)}${bucket.truncated ? ' · listing stopped early; the true total is larger' : ''}`,
      );
      for (const prefix of bucket.byPrefix) {
        lines.push(`              ${pad(prefix.prefix, 36)}${pad(`${formatCount(prefix.objects)} objects`, 16)}${formatBytes(prefix.bytes)}`);
      }
    }
  } else {
    lines.push('  archive     this store has no archive manifest table');
  }

  const lanes = inventory.lanes;
  lines.push('');
  if (lanes && lanes.length > 0) {
    lines.push(`  lanes       last ${windows.longDays} days, duration of one firing end to end`);
    lines.push(`              ${pad('lane', 28)}${pad('runs', 8)}${pad('failed', 8)}${pad('p50', 10)}${pad('p95', 10)}max`);
    const ordered = [...lanes].sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0) || a.job.localeCompare(b.job));
    for (const lane of ordered) {
      lines.push(
        `              ${pad(lane.job, 28)}${pad(formatCount(lane.runs), 8)}${pad(formatCount(lane.failed), 8)}${pad(formatMs(lane.p50Ms), 10)}${pad(formatMs(lane.p95Ms), 10)}${formatMs(lane.maxMs)}`,
      );
    }
  } else {
    lines.push('  lanes       no recorded firings in this store');
  }
  return lines;
}

const DATED = /^\d{4}-\d{2}-\d{2}/u;

/**
 * The newest nightly backup: its folder name, file count and total bytes.
 * Sizes come from stat; no file is opened. Bounded to 10,000 entries.
 */
export async function newestBackup(backupsDir, { fsp = fs } = {}) {
  let names;
  try {
    names = await fsp.readdir(backupsDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const newest = names.filter((name) => DATED.test(name)).sort().at(-1);
  if (!newest) return null;
  let files = 0;
  let bytes = 0;
  let truncated = false;
  const stack = [path.join(backupsDir, newest)];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      if (files >= 10_000) {
        truncated = true;
        break;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        files += 1;
        bytes += (await fsp.stat(full)).size;
      }
    }
  }
  return { name: newest, files, bytes, truncated };
}

export function backupLine(backup) {
  if (backup === null) return '  backup      no nightly backup folder yet';
  return `  backup      newest ${backup.name}: ${formatCount(backup.files)} files, ${formatBytes(backup.bytes)}${backup.truncated ? ' (stopped counting at 10,000 files)' : ''} · sizes only; a restore drill measures restore time`;
}

/**
 * The doctor's capacity section. Never throws: a store that cannot be asked
 * is reported as the one line that says why.
 */
export async function capacitySection({
  door = DEFAULT_DOOR,
  token = operatorToken,
  fetchImpl = fetch,
  backupsDir = null,
  fsp = fs,
} = {}) {
  const lines = ['## Capacity (metadata only, asked through the ingest door)'];
  try {
    const inventory = await readCapacity({ door, token: await token(), fetchImpl });
    lines.push(...capacityLines(inventory));
  } catch (error) {
    lines.push(`  unavailable — ${error instanceof Error ? error.message : String(error)}`);
  }
  if (backupsDir !== null) {
    lines.push('');
    try {
      lines.push(backupLine(await newestBackup(backupsDir, { fsp })));
    } catch (error) {
      lines.push(`  backup      could not be read (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return lines;
}
