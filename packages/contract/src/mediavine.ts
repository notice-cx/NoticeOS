export interface MediavineSite { id: string; title: string; domain: string }
export type RevenueHolidayCalendar = 'none' | 'US' | 'CA' | 'US,CA';
export interface MediavineStatus {
  availableThrough: string;
  asset: string; connected: boolean; enabled: boolean; siteId: string | null;
  lastAttemptAt: string | null; lastSuccessAt: string | null; reportedThrough: string | null;
  error: string | null; nextAttemptAt: string | null;
  summaryMinor: number | null; dailyMinor: number | null; differenceMinor: number | null;
  comparisonStart: string | null; comparisonEnd: string | null;
  daily: { date: string; amountMinor: number }[];
  holidayCalendar?: RevenueHolidayCalendar;
}
/** A site's Mediavine settings save. `enabled: true` starts its sync; `false`
 * is accepted only where the sync is already off — stopping one is the Ad
 * revenue row's Not using, which records why. */
export interface MediavineSettings { asset: string; siteId: string; enabled: boolean; holidayCalendar?: RevenueHolidayCalendar }
export interface MediavineSync { asset: string; start?: string; end?: string }
export type MediavineResult<T> = { ok: true; value: T } | { ok: false; message: string };
export interface ScheduledRunResult {
  outcome: 'ran' | 'skipped' | 'failed'; detail: string; steps?: import('./workflows.js').WorkflowStepRun[];
  /** Set when the dispatch refused the fire and ran nothing: `unknown_cron`,
   * no scheduled job runs on the expression. */
  refused?: 'unknown_cron';
}

/**
 * Is this site's Mediavine revenue collected? The one rule the sync, the
 * site's Data sources row and the monitoring read: a site whose ad-revenue
 * entry names a Mediavine site is collected unless the entry says Not using
 * (`skipped`) or Doesn't apply. `mediavineEnabled` is an older switch whose
 * every value came paired with the same posture, so the posture alone answers.
 */
export function mediavineSyncOn(cell: { mediavineSiteId?: unknown; status?: unknown } | null | undefined): boolean {
  return typeof cell?.mediavineSiteId === 'string' && cell.mediavineSiteId !== ''
    && cell.status !== 'skipped' && cell.status !== 'not-applicable';
}
