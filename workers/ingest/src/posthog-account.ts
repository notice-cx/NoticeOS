// ONE POSTHOG KEY FOR THE ACCOUNT: which region answers for it, which projects
// it can read, and each project's saved funnels (bead `ro-ujb9.96.7.8`, epic
// `ro-ujb9.96.7`).
//
// The connect panel used to ask for a key per site, then the site's region,
// project id and every funnel step typed by hand. PostHog already knows all of
// it: a personal API key belongs to one Cloud region, the region's
// `/api/projects/` lists the projects the key can read, each project records
// the domains it serves (`app_urls`, `recording_domains`) and its saved funnel
// insights hold the steps. So the panel asks for the key alone and this module
// finds the rest.
//
// WHEN IT CALLS POSTHOG. Only after the operator presses Connect (the
// save-and-test in credential-connect.ts) and when the panel lists the
// account's sites (site-discovery.ts) — never on a page load, never on a
// schedule. Every call is bounded by its own timeout and the whole discovery
// by one deadline, and every answer is read against a byte cap.
//
// WHAT IT RETURNS: a verdict and public identities (a project's id, name,
// domain and funnel steps). Never the key, never PostHog's own error text.

import type { DiscoveredSite } from '@noticeos/contract';
import {
  POSTHOG_FUNNEL_LIMITS,
  POSTHOG_HOSTS,
  posthogFunnelsRefusal,
  siteHost,
  type PosthogFunnel,
  type PosthogFunnelStep,
  type PosthogHost,
} from '@noticeos/contract';
import { POSTHOG_FUNNEL_ID_SOURCE } from '@noticeos/contract/configuration';

/** The credential field that holds the account's one personal API key. */
export const POSTHOG_ACCOUNT_KEY_SLOT = 'POSTHOG_API_KEY';

/** How long one PostHog read may take while a person watches a spinner. */
export const POSTHOG_ACCOUNT_TIMEOUT_MS = 10_000;
/** The most projects one discovery reads the details and funnels of. */
export const POSTHOG_DISCOVERY_MAX_PROJECTS = 20;
/** A project list or an insight list larger than this is not read. */
const RESPONSE_BYTE_LIMIT = 2 * 1024 * 1024;

const ORIGIN: Readonly<Record<PosthogHost, string>> = {
  us: 'https://us.posthog.com',
  eu: 'https://eu.posthog.com',
};

/** One project the key can read. */
export interface PosthogProjectRow {
  id: number;
  name: string;
}

/** What PostHog said about a key: the region that accepted it and its projects,
 * a refusal from every region, or no usable answer. */
export type PosthogAccountRead =
  | { verdict: 'accepted'; region: PosthogHost; projects: PosthogProjectRow[] }
  | { verdict: 'refused' }
  | { verdict: 'unreachable' };

/**
 * Show one key to BOTH PostHog Cloud regions at once and keep the one that
 * accepts it. A personal API key lives in exactly one region, so the other
 * answers 401; both refusing is a refusal, and anything else without an
 * acceptance (a timeout, a 5xx, a malformed list) is no answer.
 */
export async function readPosthogAccount(
  key: string,
  fetchImpl: typeof fetch,
  timeoutMs = POSTHOG_ACCOUNT_TIMEOUT_MS,
): Promise<PosthogAccountRead> {
  if (key.trim() === '') return { verdict: 'refused' };
  const answers = await Promise.all(POSTHOG_HOSTS.map(async (region) => ({ region, answer: await listProjects(region, key, fetchImpl, timeoutMs) })));
  const accepted = answers.find((entry) => entry.answer.kind === 'projects');
  if (accepted && accepted.answer.kind === 'projects') {
    return { verdict: 'accepted', region: accepted.region, projects: accepted.answer.projects };
  }
  return answers.every((entry) => entry.answer.kind === 'refused') ? { verdict: 'refused' } : { verdict: 'unreachable' };
}

type ProjectsAnswer = { kind: 'projects'; projects: PosthogProjectRow[] } | { kind: 'refused' } | { kind: 'unreachable' };

async function listProjects(region: PosthogHost, key: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<ProjectsAnswer> {
  const read = await getJson(`${ORIGIN[region]}/api/projects/?limit=100`, key, fetchImpl, timeoutMs);
  if (read.kind !== 'json') return read;
  const results = asRecord(read.body)?.results;
  if (!Array.isArray(results)) return { kind: 'unreachable' };
  const projects: PosthogProjectRow[] = [];
  for (const row of results) {
    const record = asRecord(row);
    const id = record?.id;
    const name = record?.name;
    if (typeof id === 'number' && Number.isInteger(id) && id > 0) {
      projects.push({ id, name: typeof name === 'string' && name.trim() !== '' ? name.trim() : `Project ${id}` });
    }
  }
  return { kind: 'projects', projects };
}

/**
 * What the key can see, as the connect panel's site list: every project in
 * the region that accepted it (the first {@link POSTHOG_DISCOVERY_MAX_PROJECTS}),
 * each with the domain it serves and its saved funnels. A project whose
 * details cannot be read is still listed — with no domain it simply matches no
 * site — and one whose funnels cannot be read carries none.
 */
export async function discoverPosthogProjects(
  key: string,
  fetchImpl: typeof fetch,
  timeoutMs = POSTHOG_ACCOUNT_TIMEOUT_MS,
): Promise<{ ok: true; region: PosthogHost; sites: DiscoveredSite[] } | { ok: false; reason: 'refused' | 'unreachable' }> {
  const account = await readPosthogAccount(key, fetchImpl, timeoutMs);
  if (account.verdict !== 'accepted') return { ok: false, reason: account.verdict };
  const origin = ORIGIN[account.region];
  const projects = account.projects.slice(0, POSTHOG_DISCOVERY_MAX_PROJECTS);
  const sites = await Promise.all(projects.map(async (project): Promise<DiscoveredSite> => {
    const [detail, insights] = await Promise.all([
      getJson(`${origin}/api/projects/${project.id}/`, key, fetchImpl, timeoutMs),
      getJson(`${origin}/api/projects/${project.id}/insights/?saved=true&basic=true&limit=100`, key, fetchImpl, timeoutMs),
    ]);
    const funnels = insights.kind === 'json' ? savedFunnels(asRecord(insights.body)?.results) : [];
    return {
      lane: 'posthog',
      ref: `${account.region}:${project.id}`,
      label: project.name,
      host: projectHost(detail.kind === 'json' ? asRecord(detail.body) : null, project.name),
      mapping: { host: account.region, projectId: String(project.id) },
      ready: true,
      ...(funnels.length > 0 ? { funnels } : {}),
    };
  }));
  return { ok: true, region: account.region, sites };
}

/**
 * The one domain a project answers for: the first of its authorized app URLs,
 * then its recording domains, then its name when the name IS a domain (a
 * project called "example.com"). Read by `siteHost`, the one host rule the
 * panel matches sites with.
 */
export function projectHost(detail: Record<string, unknown> | null, name: string): string | null {
  for (const list of [detail?.app_urls, detail?.recording_domains]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const host = typeof entry === 'string' ? siteHost(entry) : null;
      if (host !== null) return host;
    }
  }
  const named = siteHost(name);
  return named !== null && named.includes('.') ? named : null;
}

/**
 * A project's saved funnel insights, as the register's funnels: each one whose
 * every step is a named event (optionally pinned to one exact page path) —
 * the two things the archive's funnel query counts. A funnel filtered on
 * anything else is left out rather than counted differently from PostHog, and
 * the list stops at the register's limit.
 */
export function savedFunnels(results: unknown): PosthogFunnel[] {
  if (!Array.isArray(results)) return [];
  const funnels: PosthogFunnel[] = [];
  const ids = new Set<string>();
  for (const insight of results) {
    if (funnels.length >= POSTHOG_FUNNEL_LIMITS.maxFunnels) break;
    const funnel = insightFunnel(asRecord(insight), ids);
    if (funnel === null) continue;
    ids.add(funnel.id);
    funnels.push(funnel);
  }
  return funnels;
}

/** One saved insight as a funnel, or null when it is not one the archive can count. */
export function insightFunnel(insight: Record<string, unknown> | null, taken: ReadonlySet<string> = new Set()): PosthogFunnel | null {
  if (insight === null || insight.deleted === true) return null;
  const name = [insight.name, insight.derived_name].find((value): value is string => typeof value === 'string' && value.trim() !== '')?.trim();
  if (name === undefined) return null;
  const steps = querySteps(asRecord(insight.query)) ?? filterSteps(asRecord(insight.filters));
  if (steps === null) return null;
  const funnel: PosthogFunnel = {
    id: funnelId(name, typeof insight.short_id === 'string' ? insight.short_id : null, taken),
    name: name.slice(0, POSTHOG_FUNNEL_LIMITS.nameMaxLength),
    steps,
  };
  // The save's own rule decides, so a picked-up funnel is one the register
  // would accept from the Data sources tab.
  return posthogFunnelsRefusal([funnel]) === null ? funnel : null;
}

/** Steps of a query-based funnel (`FunnelsQuery`, bare or inside an
 * `InsightVizNode`). Null when it is not a funnel or a step is not a plain event. */
function querySteps(query: Record<string, unknown> | null): PosthogFunnelStep[] | null {
  const source = query?.kind === 'InsightVizNode' ? asRecord(query.source) : query;
  if (source?.kind !== 'FunnelsQuery' || !Array.isArray(source.series)) return null;
  const steps: PosthogFunnelStep[] = [];
  for (const node of source.series) {
    const record = asRecord(node);
    if (record?.kind !== 'EventsNode' || typeof record.event !== 'string') return null;
    const step = eventStep(record.event, record.properties);
    if (step === null) return null;
    steps.push(step);
  }
  return steps;
}

/** Steps of an older filter-based funnel (`insight: "FUNNELS"`, `events` in order). */
function filterSteps(filters: Record<string, unknown> | null): PosthogFunnelStep[] | null {
  if (filters?.insight !== 'FUNNELS' || !Array.isArray(filters.events)) return null;
  if (Array.isArray(filters.actions) && filters.actions.length > 0) return null;
  const events = filters.events
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
  const steps: PosthogFunnelStep[] = [];
  for (const entry of events) {
    if (typeof entry.id !== 'string') return null;
    const step = eventStep(entry.id, entry.properties);
    if (step === null) return null;
    steps.push(step);
  }
  return steps;
}

/** One step: the event, and a page path only when the step's one filter is an
 * exact `$pathname`. Any other filter makes it a step this archive cannot count. */
function eventStep(event: string, properties: unknown): PosthogFunnelStep | null {
  const filters = Array.isArray(properties) ? properties.map(asRecord) : [];
  if (filters.length === 0) return { event };
  if (filters.length > 1) return null;
  const only = filters[0];
  const value = Array.isArray(only?.value) && only.value.length === 1 ? only.value[0] : only?.value;
  if (only?.key !== '$pathname' || (only.operator ?? 'exact') !== 'exact' || typeof value !== 'string') return null;
  return { event, path: value };
}

/** A stable kebab-case id from the funnel's name (its short id when the name
 * has no letters or digits), unique within one project. */
function funnelId(name: string, shortId: string | null, taken: ReadonlySet<string>): string {
  const max = POSTHOG_FUNNEL_LIMITS.idMaxLength;
  const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
  const base = slug(name) || slug(shortId ?? '') || 'funnel';
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base.slice(0, max - String(n).length - 1)}-${n}`;
  return new RegExp(POSTHOG_FUNNEL_ID_SOURCE).test(id) ? id : 'funnel';
}

type JsonAnswer = { kind: 'json'; body: unknown } | { kind: 'refused' } | { kind: 'unreachable' };

/** One authorized GET, bounded in time and size. 401/403 is a refusal; every
 * other failure, and a body that is not JSON, is no answer. Never throws. */
async function getJson(url: string, key: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<JsonAnswer> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { kind: 'unreachable' };
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    return { kind: 'refused' };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { kind: 'unreachable' };
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > RESPONSE_BYTE_LIMIT) {
    await response.body?.cancel();
    return { kind: 'unreachable' };
  }
  try {
    const text = await response.text();
    if (text.length > RESPONSE_BYTE_LIMIT) return { kind: 'unreachable' };
    return { kind: 'json', body: JSON.parse(text) };
  } catch {
    return { kind: 'unreachable' };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
