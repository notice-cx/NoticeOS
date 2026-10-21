import { javascriptInstant, type WorkspaceStore } from '@noticeos/postgres';
import type { PosthogAssetSettings } from '@noticeos/contract';

export interface PosthogQueryCooldown {
  reason: 'budget-exhausted' | 'rate-limited';
  detail: string;
  nextAttemptAt: string;
}

const HOUR_MS = 3_600_000;

/** PostHog meters query reads per project, independently of which key is used. */
export function posthogBudgetKey(settings: Pick<PosthogAssetSettings, 'host' | 'projectId'>): string {
  return `posthog-query-budget:${settings.host}:${settings.projectId}`;
}

/** Retry-After may be seconds or an HTTP date. An absent delay waits one hour. */
export function posthogRetryAt(response: Response, nowMs: number): string {
  const raw = response.headers.get('retry-after')?.trim();
  const seconds = raw && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : null;
  const date = raw && /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), /.test(raw) ? Date.parse(raw) : NaN;
  const requested = seconds !== null && Number.isFinite(seconds) ? nowMs + seconds * 1_000 : date;
  const safe = Number.isFinite(requested) && Math.abs(requested) <= 8.64e15 ? requested : nowMs + HOUR_MS;
  return new Date(Math.max(nowMs + 1_000, safe)).toISOString();
}

export async function posthogCooldown(
  store: WorkspaceStore,
  settings: Pick<PosthogAssetSettings, 'host' | 'projectId'>,
  nowMs: number,
): Promise<PosthogQueryCooldown | null> {
  const [row] = await store.read(tx => tx.query<{ cooldown_until: string | null; last_error: string | null }>(
    'SELECT cooldown_until, last_error FROM noticeos.integration_leases WHERE lease_key = $1', [posthogBudgetKey(settings)]));
  if (!row?.cooldown_until || Date.parse(javascriptInstant(row.cooldown_until)) <= nowMs) return null;
  const reason = row.last_error === 'posthog_rate_limit' ? 'rate-limited' : 'budget-exhausted';
  return {
    reason,
    detail: reason === 'rate-limited' ? 'Waiting for PostHog’s request limit to reset.' : 'Waiting for PostHog’s query read budget to refill.',
    nextAttemptAt: javascriptInstant(row.cooldown_until),
  };
}

/** Keep only a fixed code and deadline; never persist provider text or a key. */
export async function savePosthogCooldown(
  store: WorkspaceStore,
  settings: Pick<PosthogAssetSettings, 'host' | 'projectId'>,
  cooldown: PosthogQueryCooldown,
): Promise<void> {
  await store.write(tx => tx.execute(
    `INSERT INTO noticeos.integration_leases AS l
       (workspace_id, lease_key, owner, expires_at, cooldown_until, last_error)
     VALUES ($1::uuid, $2, 'posthog-query-budget', $3::timestamptz, $4::timestamptz, $5)
     ON CONFLICT (workspace_id, lease_key) DO UPDATE
       SET cooldown_until = excluded.cooldown_until, last_error = excluded.last_error
       WHERE l.cooldown_until IS NULL OR l.cooldown_until <= excluded.cooldown_until`,
    [tx.workspaceId, posthogBudgetKey(settings), new Date(0), cooldown.nextAttemptAt,
      cooldown.reason === 'rate-limited' ? 'posthog_rate_limit' : 'posthog_query_budget_exceeded']));
}
