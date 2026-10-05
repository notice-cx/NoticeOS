const DAY_MS = 86_400_000;

export function validateBackupRetention(value) {
  if (value === undefined) return null; // Existing hosts retain their age policy.
  if (!value || !Number.isInteger(value.daily) || value.daily < 1 || value.daily > 365
    || !Number.isInteger(value.weekly) || value.weekly < 1 || value.weekly > 52) {
    throw new Error('retention needs daily (1–365) and weekly (1–52) counts');
  }
  return value;
}

export function backupDate(name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) return null;
  const date = Date.parse(`${name}T00:00:00Z`);
  return Number.isFinite(date) && new Date(date).toISOString().slice(0, 10) === name ? date : null;
}

/** Read the generated format, not the product name in its title: old backups
 * keep the branding they were created with. Null means unrecognized, never
 * permission to delete a manual or malformed report. */
export function backupReportComplete(report, day) {
  if (backupDate(day) === null || !report.split('\n', 1)[0].endsWith(` backup — ${day}`)
    || !report.startsWith('# ')) return null;
  if (report.includes('by `scripts/host-backup.mjs`') && report.includes('## Backup set\n')) {
    const operational = ['D1', 'Postgres'].filter((label) => new RegExp(`^- ${label}:`, 'm').test(report));
    if (operational.length !== 1) return null;
    const labels = [...operational, 'R2', 'Task hub', ...['Asset databases', 'Analytical history']
      .filter(label => new RegExp(`^- ${label}:`, 'm').test(report))];
    const results = labels.map((label) =>
      new RegExp(`^- ${label}: (completed|not_configured|failed); (\\d+)\\/(\\d+|unknown) copied$`, 'm').exec(report));
    if (results.some((result) => !result)) return null;
    return results.every(([, status, copied, expected]) => status === 'not_configured'
      ? copied === '0' && ['0', 'unknown'].includes(expected)
      : status === 'completed' && expected !== 'unknown' && copied === expected);
  }
  if (report.includes('Written by `scripts/os-up.mjs`') && report.includes('## This run\n')) {
    const results = [
      /^- D1: (\d+)\/(\d+) database\(s\)$/m,
      /^- R2: (\d+)\/(\d+) database\(s\) \+ \d+ blob\(s\)$/m,
      /^- task hub: (\d+)\/(\d+) database\(s\)$/m,
    ].map((pattern) => pattern.exec(report));
    if (results.some((result) => !result)) return null;
    if (results.some(([, copied, expected]) => copied !== expected)) return false;
    // That generator omitted blob-copy failures from its report. Equal DB
    // counts cannot prove the R2 store complete. Preserve this history until
    // an explicitly complete week-old set can replace its recovery role.
    return 'legacy_unverified';
  }
  return null;
}

/** Keep recent complete days and the first complete set of each recent UTC
 * Monday week. Keeping the first preserves an anchor as daily copies rotate. */
export function retainedBackupDates(dates, { daily, weekly }) {
  const sorted = [...new Set(dates)].filter((day) => backupDate(day) !== null).sort();
  const anchors = new Map();
  for (const day of sorted) {
    const date = backupDate(day);
    const week = date - ((new Date(date).getUTCDay() + 6) % 7) * DAY_MS;
    if (!anchors.has(week)) anchors.set(week, day);
  }
  const weeklyDates = [...anchors.values()].slice(-weekly);
  // A missed Monday can make last week's first copy only a day or two old.
  // Keep an older anchor in that slot until its replacement is a week old.
  if (weekly > 1 && sorted.length) {
    const cutoff = backupDate(sorted.at(-1)) - 7 * DAY_MS;
    const older = [...anchors.values()].filter((day) => backupDate(day) <= cutoff).at(-1);
    if (older && !weeklyDates.some((day) => backupDate(day) <= cutoff)) weeklyDates[0] = older;
  }
  return new Set([...sorted.slice(-daily), ...weeklyDates]);
}
