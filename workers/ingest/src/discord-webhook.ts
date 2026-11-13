import type { ProbeResult } from '@noticeos/contract';

export const DISCORD_WEBHOOK_FIELD = 'DISCORD_WEBHOOK_URL';

export interface DiscordMessage {
  content: string;
  embeds?: { title: string; description: string }[];
}

export function discordWebhookUrl(value: string | undefined): URL | null {
  const url = URL.parse(value ?? '');
  return url?.protocol === 'https:' ? url : null;
}

export async function postDiscordWebhook(
  webhook: string | undefined,
  message: DiscordMessage,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Response | null> {
  const url = discordWebhookUrl(webhook);
  if (url === null) return null;
  return fetchImpl(url.href, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...message, allowed_mentions: { parse: [] } }),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** Connection tests and deliveries use the same verdict without echoing the URL or response body. */
export function discordWebhookAnswer(status: number | null): { ok: boolean; result: ProbeResult } {
  if (status === null) return { ok: false, result: { outcome: 'invalid', failing: ['HTTPS webhook URL'], fix: { kind: 'replace' } } };
  if (status >= 200 && status < 300) return { ok: true, result: { outcome: 'answered' } };
  if (status === 401 || status === 403 || status === 404) {
    return { ok: false, result: { outcome: 'refused', status, fix: { kind: 'replace' } } };
  }
  if (status === 429) return { ok: false, result: { outcome: 'rate-limited', status, fix: { kind: 'wait' } } };
  return { ok: false, result: { outcome: 'unreachable', status } };
}
