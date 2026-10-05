import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PANEL_REPORTS_DIRECTORY = '.local/signal-dumps/reports';
export const PANEL_REPORTS_ROOT = path.join(REPO_ROOT, PANEL_REPORTS_DIRECTORY);
export const PANEL_HISTORY_ROOT = path.join(REPO_ROOT, '.local/signal-dumps/history');

/** Completed DuckDB reports. Legacy plain analysis folders stay untouched. */
export function panelReportPath(asset, root = PANEL_REPORTS_ROOT) {
  if (typeof asset !== 'string' || !/^[a-z0-9.-]+$/.test(asset)) {
    throw new Error('asset must be a site id such as example.com.');
  }
  return path.join(root, asset);
}

export function panelReportRelativePath(asset) {
  return path.relative(REPO_ROOT, panelReportPath(asset));
}
