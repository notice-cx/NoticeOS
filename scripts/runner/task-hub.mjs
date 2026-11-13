// runner/task-hub.mjs — the saved task projects as the runner's task lanes
// read them.

import { taskDatabaseName } from '../task-project-config.mjs';

/** The runner's resolved project roster; relative repo paths remain
 * supported for injected fixtures. */
export function parseTaskProjects(raw) {
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(cfg?.spokes)) return [];
  const seen = new Set();
  const projects = [];
  for (const spoke of cfg.spokes) {
    const asset = spoke?.asset;
    const prefix = spoke?.prefix;
    const repo = spoke?.repo ?? '';
    const database = spoke?.database;
    if (typeof asset !== 'string' || asset.trim() === '') continue;
    if (typeof prefix !== 'string' || prefix.trim() === '') continue;
    if (typeof repo !== 'string') continue;
    if (seen.has(asset)) continue;
    seen.add(asset);
    projects.push({
      asset: asset.trim(),
      prefix: prefix.trim(),
      repo: repo.trim(),
      ...(typeof spoke.unavailableReason === 'string' ? { unavailableReason: spoke.unavailableReason } : {}),
      // "the backup would use this" and "this is a usable name" are one
      // question with one answer, and it is spelled out in exactly one place.
      database: taskDatabaseName(database),
    });
  }
  return projects;
}

/** The saved projects, or the skip reason a lane logs when the store could not
 * be read. An empty list is an answer, not a failure: each lane names it. */
export async function readTaskProjectList(readConfig) {
  try {
    return { projects: parseTaskProjects(await readConfig()) };
  } catch (err) {
    return { unreadable: `the task map is unreadable (${err.message})` };
  }
}
