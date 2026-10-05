// The operator's next meetings, read from secret ICS links (bead ro-c0d2).
//
// WHY THIS LIVES IN INGEST. A Google calendar's private ICS address is a bearer
// credential wearing a URL's clothes: whoever holds the link reads the whole
// calendar, forever, with no account and no way to take it back short of
// rotating the link — which invalidates it everywhere at once. So it lives where
// every other credential in this OS lives, in ingest's env, and the Tower — LAN
// served, deliberately credential-free — asks for the expanded window over the
// private Service Binding.
//
// WHY AN RPC AND NOT A LANE. Same reasoning as `ga4Realtime()`: this is current
// display state, not evidence. Nothing here writes `signal_runs`, an
// observation, a flag, or an R2 object. A meeting that was on the calendar this
// morning and is gone this afternoon is not an anomaly, and the store must never
// be asked to remember it as one.
//
// WHAT NEVER LEAVES THIS MODULE. The URLs. Not in the payload, not in a thrown
// message, not in a log line. A failure names the operator's LABEL and a coarse
// code, and the error object a failing `fetch` hands us is deliberately NOT
// copied into ours — workerd puts the request URL inside some transport errors,
// and that URL is the credential.
//
// WHY A CACHE, AND WHAT IT CACHES. The Wall polls its Tower API every 60s, and
// Google serves these links out of its own cache while throttling callers who
// ask faster than it refreshes. Five minutes is politer than the poll. The
// window caches the FETCH, not the answer: the 48-hour window is recomputed from
// the cached events on every call, so a meeting that ended two minutes ago
// leaves the list on the next poll instead of lingering until the fetch expires,
// and `fetchedAt` stays an honest statement about the bytes rather than about
// the request.
//
// ONLY WHAT THE OPERATOR ACCEPTED. An invitation sitting unanswered in a
// calendar is not a plan, and the operator asked not to be shown the ones they
// have not "actually Accepted" — so when this module can tell whose calendar a
// feed is, an event whose guest list has them as DECLINED, TENTATIVE or
// NEEDS-ACTION is not reported. When it cannot tell (see `deriveSelfEmail`), or
// when there is no guest list, nothing is filtered: a wrong identity would hide
// real meetings, which is the one failure worse than showing one too many.
//
// THE ICS PARSER IS HAND-ROLLED, and its recurrence support is a documented
// subset rather than RFC 5545 — see "Calendar RPC" in workers/ingest/README.md
// for the table, and `parseRecurrenceRule` below for the boundary. A rule
// outside the subset degrades to its base event; it never throws and never costs
// the feed its `feedsOk` credit.

import type {
  CalendarFeed,
  CalendarUpcoming,
  UpcomingMeeting,
} from '@noticeos/contract';
import { resolveCredential, type ResolvedCredential } from './credentials.js';
import { cachedProviderRead, ProviderReadCacheError, providerCacheScope } from './provider-read-cache.js';
import { observeIntegration, tryHealthConnection } from './integration-health-context.js';

/**
 * Who we say we are, same contract as `HYGIENE_USER_AGENT` and
 * `EGRESS_USER_AGENT`: honest identification with a contact URL, and a product
 * token distinct enough that a calendar operator reading their logs can tell
 * this dashboard read apart from anything else this OS does.
 */
export const CALENDAR_USER_AGENT =
  'NoticeOS-Calendar/1.0 (+https://www.notice.cx; operator dashboard read)';

/** Per-feed ceiling. One feed's slow origin must not hold the Wall's poll. */
const REQUEST_TIMEOUT_MS = 10_000;

/** How long one fetch round's bytes stand. See the header on why this exists. */
export const CALENDAR_CACHE_TTL_MS = 5 * 60_000;

/** How far ahead the Wall is asked to care about. */
export const UPCOMING_WINDOW_MS = 48 * 60 * 60_000;

/**
 * How far BACK a recurrence rule is expanded. Only in-progress occurrences live
 * behind `now`, and a meeting still running after 24 hours is not a meeting.
 * Non-recurring events are not bounded this way — they are a finite list in the
 * feed, so a multi-day all-day event that began last week can still be reported
 * as in progress.
 */
const IN_PROGRESS_LOOKBACK_MS = 24 * 60 * 60_000;

/** What the Wall can draw before the type size stops being a TV's business. */
const MEETING_LIMIT = 20;

/**
 * Response byte ceiling. A calendar past this is not a document to be expanding
 * inside a Worker's memory, and a feed URL pointed at something else entirely is
 * the likelier explanation.
 */
const RESPONSE_BYTE_LIMIT = 4 * 1024 * 1024;

/**
 * Hard stop on rule iteration. Expansion is already fast-forwarded to the window
 * for open-ended rules, so this only bounds the pathological cases: a `COUNT` in
 * the thousands, or a rule whose period never advances.
 */
const MAX_RECURRENCE_STEPS = 5_000;

/** What a client shows for an event with no SUMMARY. Better on a TV than blank. */
const UNTITLED = 'Busy';

const MS_PER_DAY = 86_400_000;

/** ICS weekday codes, indexed by `Date`'s 0=Sunday numbering. */
const ICS_WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

export interface CalendarUpcomingOptions {
  nowMs?: number;
  fetchImpl?: typeof fetch;
  /** Tests inject the feed map directly rather than through a Worker binding. */
  rawFeeds?: string;
  /** Request-local cache adapter for isolated tests; production uses caches.default. */
  cache?: Cache;
}

// --- the entry point --------------------------------------------------------

/**
 * The Tower's window onto the operator's calendars: every configured feed
 * fetched independently, expanded, and reported as plain instants.
 *
 * Failures are isolated per feed, exactly as `ga4Realtime()` isolates them per
 * property. One feed down costs its own events and one point of `feedsOk`; the
 * other feed's meetings still reach the Wall, because a dashboard that blanks
 * both calendars when one link rots has told the operator less than nothing.
 */
export async function calendarUpcoming(
  env: IngestEnv,
  options: CalendarUpcomingOptions = {},
): Promise<CalendarUpcoming> {
  const nowMs = options.nowMs ?? Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;
  // Store first, legacy env binding second (bead `ro-vu8d.1`). Deliberately no
  // `last_used_at` stamp: the Wall polls this every 60 seconds, and a status
  // column is not worth a write a minute. The connection test on the
  // Integrations page is what gives this credential its `last_ok_at`.
  const credential = await resolveCredential(env, 'calendar');
  const raw = options.rawFeeds ?? credential.fields.CALENDAR_FEEDS;
  const health = await tryHealthConnection(env, 'calendar', credential);
  const round = await feedRound(env, credential, raw, fetchImpl, nowMs, options.cache);
  const targets = parseFeedTargets(raw);
  const recorded = await Promise.all(round.calendars.map((feed) => observeIntegration(env, health, {
    capability: 'calendar-feed', target: targets.find((target) => target.label === feed.id)?.url ?? feed.id,
    family: feed.id, observedAt: new Date(round.fetchedAtMs).toISOString(), ok: feed.status === 'ok',
    code: round.errors[feed.id], evidenceSource: 'calendar',
  })));

  return {
    fetchedAt: new Date(round.fetchedAtMs).toISOString(),
    feedsConfigured: round.calendars.length,
    feedsOk: round.feedsOk,
    calendars: round.calendars,
    meetings: upcomingFrom(round.events, nowMs),
    ...(recorded.some((ok) => !ok) ? { monitoringAvailable: false } : {}),
  };
}

/** One fetch round's bytes, parsed. The cache holds exactly this. */
interface FeedRound {
  errors: Record<string, string>;
  fetchedAtMs: number;
  /** The feed map as configured, so a changed one cannot be served out of this
   * cache. Never the urls themselves — see where it is built. */
  signature: string;
  /**
   * Every configured calendar, in CONFIG order, present whether or not it has an
   * event in the window and whether or not its fetch worked. It is what the
   * surface keys an identity color off, so it cannot depend on today's meetings.
   */
  calendars: CalendarFeed[];
  feedsOk: number;
  events: CalendarEvent[];
}

/** A safe failure contains neither feed addresses nor provider diagnostics. */
export class CalendarReadError extends Error {
  constructor(readonly code: string, readonly observedAt: string, readonly nextAttemptAt: string) {
    super('Calendar is temporarily unavailable.');
  }
}

interface StoredFeedRound extends Omit<FeedRound, 'events'> {
  events: Array<Omit<CalendarEvent, 'excluded'> & { excluded: string[] }>;
}

async function feedRound(
  env: IngestEnv,
  credential: ResolvedCredential,
  raw: string | undefined,
  fetchImpl: typeof fetch,
  nowMs: number,
  cache?: Cache,
): Promise<FeedRound> {
  const targets = parseFeedTargets(raw);
  if (targets.length === 0) return fetchFeedRound(targets, '', fetchImpl, nowMs);
  // A resolved store/revision is captured before provider work. The full target
  // fingerprint invalidates label, URL, color and attendee changes immediately.
  // Only its opaque digest becomes a cache key, never an ICS bearer address.
  const scope = await providerCacheScope([
    credential.source, credential.provider, credential.revision ?? null,
    targets.map(target => [target.label, target.url, target.color, target.selfEmail]),
  ]);
  if (!env.STORE) throw new CalendarReadError('calendar_read_ownership_unavailable', new Date(nowMs).toISOString(), new Date(nowMs + CALENDAR_CACHE_TTL_MS).toISOString());
  try {
    const entry = await cachedProviderRead({ store: env.STORE, cache: cache ?? caches.default, scope }, {
      cacheNamespace: 'calendar/v1', leaseNamespace: 'calendar-read', capability: 'round',
      nowMs, ttlMs: CALENDAR_CACHE_TTL_MS, leaseMs: 30_000,
      allowEarlyRead: false, failureRetryMs: CALENDAR_CACHE_TTL_MS,
    }, async (): Promise<StoredFeedRound> => {
      const round = await fetchFeedRound(targets, scope, fetchImpl, nowMs);
      return { ...round, events: round.events.map(event => ({ ...event, excluded: [...event.excluded] })) };
    }, (_error, observedAt, refreshAt) => ({ ok: false as const, code: 'calendar_read_unavailable', observedAt, refreshAt }));
    if (!entry.ok) throw new CalendarReadError(entry.code, entry.observedAt, entry.refreshAt);
    // Hydration also gives every caller independent arrays and exclusion Sets.
    return { ...entry.value, events: entry.value.events.map(event => ({ ...event, excluded: new Set(event.excluded) })) };
  } catch (error) {
    if (error instanceof ProviderReadCacheError) {
      throw new CalendarReadError(`calendar_read_${error.code}`, error.observedAt, error.nextAttemptAt);
    }
    throw error;
  }
}

async function fetchFeedRound(
  targets: FeedTarget[],
  signature: string,
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<FeedRound> {
  // `Promise.all` preserves order, which is what keeps `calendars` in CONFIG
  // order — the Tower keys each calendar's identity colour off that position, so
  // a feed's slot must not move because of how its fetch went.
  const settled = await Promise.all(
    targets.map(async (target) => {
      // Configured but unfetchable: counted in `feedsConfigured`, never in
      // `feedsOk`, and already reported by label when the config was read.
      if (target.url === null) {
        return { target, status: 'misconfigured' as const, events: [], code: 'configuration' };
      }
      try {
        return {
          target,
          status: 'ok' as const,
          events: await fetchFeedEvents(target, fetchImpl),
        };
      } catch (error) {
        const code = feedErrorCode(error);
        warnFeedFailure(target.label, code);
        return { target, status: feedStatusForCode(code), events: [], code };
      }
    }),
  );

  const events: CalendarEvent[] = [];
  const calendars: CalendarFeed[] = [];
  let feedsOk = 0;
  for (const outcome of settled) {
    calendars.push({
      id: outcome.target.label,
      color: outcome.target.color,
      status: outcome.status,
    });
    if (outcome.status !== 'ok') continue;
    feedsOk += 1;
    events.push(...outcome.events);
  }

  // ONE aggregate line per feed per fetch round for the rules this parser
  // degrades, counted by frequency — never one line per event, and never from
  // the per-poll expansion path (ro-l2ji: a calendar of yearly birthdays once
  // wrote thousands of identical lines an hour). A round with nothing
  // unsupported logs nothing.
  for (const [calendar, byFreq] of unsupportedRuleCounts(events)) {
    console.warn(
      JSON.stringify({ event: 'calendar_rrule_unsupported', calendar, unsupported: byFreq }),
    );
  }

  const round: FeedRound = {
    errors: Object.fromEntries(settled.flatMap((outcome) => 'code' in outcome && typeof outcome.code === 'string' ? [[outcome.target.label, outcome.code]] : [])),
    fetchedAtMs: nowMs,
    signature,
    calendars,
    feedsOk,
    events,
  };
  return round;
}

/** Per-feed counts of series whose RRULE falls outside the supported subset,
 * keyed by the rule's FREQ (or 'unparseable'). Read once per fetch round, for
 * the aggregate log line above. */
function unsupportedRuleCounts(
  events: readonly CalendarEvent[],
): Map<string, Record<string, number>> {
  const byCalendar = new Map<string, Record<string, number>>();
  for (const event of events) {
    if (event.rrule === null || event.overrides !== null) continue;
    const parsed = parseRecurrenceRule(event.rrule, event.start);
    if (parsed.supported) continue;
    const counts = byCalendar.get(event.calendar) ?? {};
    const freq = parsed.freq ?? 'unparseable';
    counts[freq] = (counts[freq] ?? 0) + 1;
    byCalendar.set(event.calendar, counts);
  }
  return byCalendar;
}

// --- the feed map -----------------------------------------------------------

interface FeedTarget {
  label: string;
  /** `null` when the entry names no usable url — configured, never fetchable. */
  url: string | null;
  color: string | null;
  /** Whose calendar this is, for reading the operator's own RSVP. See
   * {@link deriveSelfEmail}; `null` means no invitation filtering happens. */
  selfEmail: string | null;
}

/**
 * What CSS notation a pinned color may use. Deliberately a charset and not a
 * grammar: this value is operator config that a rendering surface interpolates,
 * so `;` `{` `}` `<` `>` and quotes have no business in it whatever notation it
 * turns out to be. Escaping is still the surface's job; this is the second lock.
 */
const CSS_COLOR_CHARS = /^[a-zA-Z0-9#%.,\-/()\s]+$/;

/**
 * `CALENDAR_FEEDS` is `{ "<label>": <feed> }`, where a feed is either the secret
 * ICS url on its own or `{ "url": …, "color"?: …, "email"?: … }`. The url is the
 * credential; the color and the label are not, and the email never leaves either.
 * Parsing is lenient by design — unknown keys are ignored, and a bare string is
 * exactly `{ url }`.
 *
 * A named entry that carries no usable url is still COUNTED as configured. It
 * cannot contribute events, so it lands in `feedsConfigured` and never in
 * `feedsOk`: the operator's typo then reads as one degraded feed out of two,
 * which is visible. Not counting it would make a typo'd calendar indistinguish-
 * able from one that was never configured — invisible forever.
 *
 * An absent or unparseable secret is zero configured feeds and an empty list —
 * the Wall's "no calendars" state, which is a different fact from "every feed
 * failed" and has to stay distinguishable.
 */
export function parseFeedTargets(raw: string | undefined): FeedTarget[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnFeedFailure(null, 'config_unparseable');
    return [];
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnFeedFailure(null, 'config_not_a_map');
    return [];
  }

  const targets: FeedTarget[] = [];
  for (const [label, value] of Object.entries(parsed)) {
    const raw = typeof value === 'string' ? value : feedField(value, 'url');
    const url = raw === null || raw.trim() === '' ? null : raw.trim();
    if (url === null) warnFeedFailure(label, 'config_missing_url');

    const pinned = typeof value === 'string' ? null : feedField(value, 'color');
    const color = pinned?.trim() ?? '';
    if (color !== '' && !CSS_COLOR_CHARS.test(color)) {
      warnFeedFailure(label, 'config_unusable_color');
    }
    const declared = typeof value === 'string' ? null : feedField(value, 'email');

    targets.push({
      label,
      url,
      // An unusable color is dropped, not a reason to drop the calendar: the
      // meetings matter more than the swatch, and the surface has a fallback.
      color: color !== '' && CSS_COLOR_CHARS.test(color) ? color : null,
      // A declared address always wins — it is the only way to get invitation
      // filtering on a feed whose url says nothing about whose calendar it is.
      selfEmail:
        declared !== null && declared.trim() !== ''
          ? declared.trim().toLowerCase()
          : url === null
            ? null
            : deriveSelfEmail(url),
    });
  }
  return targets;
}

/**
 * Calendar ids that are Google's own machinery rather than a person: shared and
 * secondary calendars, imported feeds, and bookable resources. They contain an
 * `@` and would otherwise pass for an address.
 */
const SYNTHETIC_CALENDAR_DOMAINS = [
  'group.calendar.google.com',
  'group.v.calendar.google.com',
  'import.calendar.google.com',
  'resource.calendar.google.com',
  'calendar.google.com',
];

/**
 * Whose calendar a secret ICS url belongs to.
 *
 * Google's private address embeds the calendar id as a path segment —
 * `/calendar/ical/<id>/private-<key>/basic.ics` — and for a person's PRIMARY
 * calendar that id IS the account's email address. That is the whole derivation,
 * and it is worth doing because it means invitation filtering works with no
 * extra configuration for the common case.
 *
 * Its limits, honestly: a secondary, shared, holiday, or resource calendar has a
 * synthetic id (`…@group.calendar.google.com`), and a non-Google feed has no
 * `/ical/<id>/` segment at all. Both yield `null`, which turns invitation
 * filtering OFF for that feed rather than guessing — a wrong identity would hide
 * real meetings, and nothing about a calendar you were not invited to is
 * improved by filtering it. The operator can always name the address explicitly
 * with the `email` key.
 */
function deriveSelfEmail(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split('/').filter((segment) => segment !== '');
  const marker = segments.indexOf('ical');
  const encoded = marker < 0 ? undefined : segments[marker + 1];
  if (encoded === undefined) return null;

  let candidate: string;
  try {
    candidate = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  candidate = candidate.trim().toLowerCase();

  const at = candidate.indexOf('@');
  if (at <= 0 || at === candidate.length - 1) return null;
  const domain = candidate.slice(at + 1);
  if (
    SYNTHETIC_CALENDAR_DOMAINS.some(
      (synthetic) => domain === synthetic || domain.endsWith(`.${synthetic}`),
    )
  ) {
    return null;
  }
  return candidate;
}

function feedField(value: unknown, field: string): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const read = (value as Record<string, unknown>)[field];
  return typeof read === 'string' ? read : null;
}

// --- one feed ---------------------------------------------------------------

/**
 * A feed's failure, carrying the operator's LABEL and a coarse code and nothing
 * else. The message is assembled here rather than inherited from whatever threw,
 * because the thing that threw may well be holding the URL.
 */
class CalendarFeedError extends Error {
  constructor(
    readonly code: string,
    readonly label: string,
  ) {
    super(`calendar feed ${label} failed: ${code}`);
    this.name = 'CalendarFeedError';
  }
}

function feedErrorCode(error: unknown): string {
  return error instanceof CalendarFeedError ? error.code : 'internal_error';
}

/**
 * The failures the operator can only fix by editing the secret: the entry is
 * unusable as written, and this is knowable BEFORE the network is asked.
 */
const MISCONFIGURED_CODES = new Set([
  'config_missing_url',
  'invalid_url',
  'unsupported_scheme',
]);

/**
 * Which of the two failure classes a code belongs to — the whole point of
 * `CalendarFeed.status`, which exists so the Wall can say "this link needs
 * replacing" instead of one number for four different problems.
 *
 * The split is "could ingest tell without asking" and NOT "who has to act, and
 * that is worth being honest about: `http_403`, and an HTML sign-in page served
 * as `200` (`not_calendar`), most often mean the secret link was ROTATED and
 * needs the operator as much as a typo does. They are `unreachable` anyway,
 * because only the round could discover them — a code cannot tell a rotated link
 * from a calendar that is briefly refusing us, and guessing wrong in the
 * confident direction would send the operator to regenerate a link over what was
 * really a bad afternoon at Google.
 */
function feedStatusForCode(code: string): 'unreachable' | 'misconfigured' {
  return MISCONFIGURED_CODES.has(code) ? 'misconfigured' : 'unreachable';
}

function warnFeedFailure(label: string | null, code: string): void {
  console.warn(
    JSON.stringify({
      event: 'calendar_feed_failed',
      // The label is the operator's own word for the calendar. The URL is the
      // credential and is never a field here.
      calendar: label,
      code,
    }),
  );
}

async function fetchFeedEvents(
  target: FeedTarget,
  fetchImpl: typeof fetch,
): Promise<CalendarEvent[]> {
  let url: URL;
  try {
    url = new URL(target.url ?? '');
  } catch {
    throw new CalendarFeedError('invalid_url', target.label);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new CalendarFeedError('unsupported_scheme', target.label);
  }

  let response: Response;
  try {
    response = await fetchImpl(url.href, {
      headers: {
        accept: 'text/calendar, text/plain;q=0.5',
        'user-agent': CALENDAR_USER_AGENT,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // Deliberately not `error.message`: see the module header.
    const timedOut =
      error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new CalendarFeedError(timedOut ? 'timeout' : 'unreachable', target.label);
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new CalendarFeedError(`http_${response.status}`, target.label);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > RESPONSE_BYTE_LIMIT) {
    await response.body?.cancel();
    throw new CalendarFeedError('too_large', target.label);
  }

  const text = await response.text();
  if (text.length > RESPONSE_BYTE_LIMIT) {
    throw new CalendarFeedError('too_large', target.label);
  }
  return parseIcsEvents(text, target.label, target.selfEmail);
}

// --- the ICS document -------------------------------------------------------

/** One VEVENT, resolved to instants but still carrying its wall clock, because
 * recurrence has to step in the wall-clock domain to survive a DST boundary. */
interface CalendarEvent {
  calendar: string;
  uid: string;
  title: string;
  location: string | null;
  allDay: boolean;
  /** DTSTART as a wall clock plus the zone it is read in. */
  start: ZonedStamp;
  startMs: number;
  /** Exclusive, per ICS DTEND semantics. */
  endMs: number;
  cancelled: boolean;
  /**
   * The operator is on the guest list and has NOT accepted — declined, tentative,
   * or never answered. Kept as a flag rather than dropped at parse time because a
   * declined single instance still has to suppress the series instance it
   * replaces; see `upcomingFrom`.
   */
  notAccepted: boolean;
  rrule: string | null;
  /** Normalized occurrence keys this series drops (EXDATE). */
  excluded: Set<string>;
  /** Set when this VEVENT overrides one instance of its UID's series. */
  overrides: string | null;
}

/** A wall-clock reading and the zone that reads it. */
interface ZonedStamp {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** IANA zone name, or `UTC`. Always one `Intl` accepts. */
  zone: string;
  /** A DATE value: an all-day event, time fields zero. */
  dateOnly: boolean;
}

interface IcsProperty {
  name: string;
  params: Map<string, string>;
  value: string;
}

/**
 * Unfold an ICS document into logical lines.
 *
 * RFC 5545 folds a long line by inserting a break plus one space or tab; the
 * continuation belongs to the previous line with that single character removed.
 * Both CRLF and bare LF appear in the wild, so both are accepted.
 */
export function unfoldIcsLines(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (raw.startsWith(' ') || raw.startsWith('\t')) {
      const previous = lines.length - 1;
      // A continuation with nothing to continue is dropped rather than promoted
      // to a property line it was never meant to be.
      if (previous >= 0) lines[previous] += raw.slice(1);
      continue;
    }
    lines.push(raw);
  }
  return lines;
}

/**
 * Split one logical line into `NAME`, its parameters, and its value.
 *
 * The name/value boundary is the first colon OUTSIDE a quoted parameter value,
 * because a param may legitimately contain one (`ALTREP="http://x/y"`), and so
 * may the value of every date property that carries a TZID.
 */
function parseIcsProperty(line: string): IcsProperty | null {
  let cut = -1;
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === ':' && !quoted) {
      cut = i;
      break;
    }
  }
  if (cut < 0) return null;

  const segments = splitUnquoted(line.slice(0, cut), ';');
  const name = (segments[0] ?? '').trim().toUpperCase();
  if (name === '') return null;

  const params = new Map<string, string>();
  for (const segment of segments.slice(1)) {
    const equals = segment.indexOf('=');
    if (equals < 0) continue;
    const key = segment.slice(0, equals).trim().toUpperCase();
    const value = segment.slice(equals + 1).trim();
    params.set(key, value.replace(/^"(.*)"$/, '$1'));
  }
  return { name, params, value: line.slice(cut + 1) };
}

function splitUnquoted(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of text) {
    if (char === '"') {
      quoted = !quoted;
      current += char;
      continue;
    }
    if (char === separator && !quoted) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/**
 * Unescape a TEXT value: `\n`/`\N` are newlines, and `\,` `\;` `\\` are the
 * three characters ICS has to escape because they are its own punctuation.
 * Anything else after a backslash is kept verbatim rather than guessed at.
 */
export function unescapeIcsText(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== '\\') {
      out += value[i];
      continue;
    }
    const next = value[i + 1];
    if (next === undefined) break;
    out += next === 'n' || next === 'N' ? '\n' : next;
    i += 1;
  }
  return out;
}

interface EventDraft {
  uid: string | null;
  summary: string | null;
  location: string | null;
  status: string | null;
  dtstart: IcsProperty | null;
  dtend: IcsProperty | null;
  duration: string | null;
  rrule: string | null;
  exdates: IcsProperty[];
  recurrenceId: IcsProperty | null;
  attendees: IcsProperty[];
}

/**
 * Read every VEVENT out of one calendar.
 *
 * Two passes, because `X-WR-TIMEZONE` is what a floating or all-day value is
 * resolved against and nothing in the format promises it appears before the
 * events that need it. The component stack matters as much: VTIMEZONE carries
 * DTSTART lines of its own, and VALARM carries a TRIGGER — properties are
 * collected only while a VEVENT is the innermost open component.
 */
export function parseIcsEvents(
  text: string,
  calendar: string,
  selfEmail: string | null = null,
): CalendarEvent[] {
  const stack: string[] = [];
  const drafts: EventDraft[] = [];
  let draft: EventDraft | null = null;
  let feedZone = 'UTC';
  let sawCalendar = false;

  for (const line of unfoldIcsLines(text)) {
    const property = parseIcsProperty(line);
    if (property === null) continue;

    if (property.name === 'BEGIN') {
      const component = property.value.trim().toUpperCase();
      stack.push(component);
      if (component === 'VCALENDAR') sawCalendar = true;
      if (component === 'VEVENT') {
        draft = {
          uid: null,
          summary: null,
          location: null,
          status: null,
          dtstart: null,
          dtend: null,
          duration: null,
          rrule: null,
          exdates: [],
          recurrenceId: null,
          attendees: [],
        };
      }
      continue;
    }
    if (property.name === 'END') {
      const closed = stack.pop();
      if (closed === 'VEVENT' && draft !== null) {
        drafts.push(draft);
        draft = null;
      }
      continue;
    }

    const open = stack[stack.length - 1];
    if (open === 'VCALENDAR' && property.name === 'X-WR-TIMEZONE') {
      const zone = property.value.trim();
      if (isKnownZone(zone)) feedZone = zone;
      continue;
    }
    if (open !== 'VEVENT' || draft === null) continue;

    switch (property.name) {
      case 'UID':
        draft.uid = property.value.trim();
        break;
      case 'SUMMARY':
        draft.summary = property.value;
        break;
      case 'LOCATION':
        draft.location = property.value;
        break;
      case 'STATUS':
        draft.status = property.value.trim().toUpperCase();
        break;
      case 'DTSTART':
        draft.dtstart = property;
        break;
      case 'DTEND':
        draft.dtend = property;
        break;
      case 'DURATION':
        draft.duration = property.value.trim();
        break;
      case 'RRULE':
        draft.rrule = property.value.trim();
        break;
      case 'EXDATE':
        draft.exdates.push(property);
        break;
      case 'RECURRENCE-ID':
        draft.recurrenceId = property;
        break;
      case 'ATTENDEE':
        draft.attendees.push(property);
        break;
      default:
        break;
    }
  }

  if (!sawCalendar) {
    // A 200 that is not a calendar — an HTML sign-in page for a rotated link is
    // the common one. Fetched is not parsed, and only parsed earns `feedsOk`.
    throw new CalendarFeedError('not_calendar', calendar);
  }

  const events: CalendarEvent[] = [];
  for (const entry of drafts) {
    const event = buildEvent(entry, calendar, feedZone, selfEmail);
    if (event !== null) events.push(event);
  }
  return events;
}

/**
 * The operator's own answer to an invitation, or `null` when the question does
 * not apply — no identity for this feed, no guest list, or a guest list the
 * operator is not on (a solo block, or a calendar that is not theirs).
 *
 * `null` means SHOW: an event nobody was invited to cannot have been declined.
 */
function selfPartStat(
  attendees: IcsProperty[],
  selfEmail: string | null,
): string | null {
  if (selfEmail === null) return null;
  for (const attendee of attendees) {
    if (attendeeAddress(attendee.value) !== selfEmail) continue;
    // RFC 5545's default for an absent PARTSTAT is NEEDS-ACTION, so an
    // unanswered invitation reads as unanswered rather than as accepted.
    return (attendee.params.get('PARTSTAT') ?? 'NEEDS-ACTION').trim().toUpperCase();
  }
  return null;
}

/** An ATTENDEE's address. The value is a `mailto:` URI in every feed worth
 * naming, but a bare address is accepted too rather than missed. */
function attendeeAddress(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith('mailto:')) return trimmed.slice('mailto:'.length) || null;
  return trimmed.includes('@') ? trimmed : null;
}

function buildEvent(
  draft: EventDraft,
  calendar: string,
  feedZone: string,
  selfEmail: string | null,
): CalendarEvent | null {
  if (draft.dtstart === null) return null;
  const start = parseIcsStamp(draft.dtstart, feedZone);
  if (start === null) return null;

  const startMs = stampToUtcMs(start);
  const endMs = resolveEnd(draft, start, startMs, feedZone);
  const excluded = new Set<string>();
  for (const exdate of draft.exdates) {
    for (const value of exdate.value.split(',')) {
      const stamp = parseIcsStamp({ ...exdate, value }, feedZone);
      if (stamp !== null) excluded.add(occurrenceKey(stamp, stampToUtcMs(stamp)));
    }
  }
  const override =
    draft.recurrenceId === null
      ? null
      : parseIcsStamp(draft.recurrenceId, feedZone);

  return {
    calendar,
    uid: draft.uid ?? '',
    title:
      draft.summary === null || draft.summary.trim() === ''
        ? UNTITLED
        : unescapeIcsText(draft.summary).trim(),
    location:
      draft.location === null || draft.location.trim() === ''
        ? null
        : unescapeIcsText(draft.location).trim(),
    allDay: start.dateOnly,
    start,
    startMs,
    endMs,
    cancelled: draft.status === 'CANCELLED',
    notAccepted: (() => {
      const partStat = selfPartStat(draft.attendees, selfEmail);
      return partStat !== null && partStat !== 'ACCEPTED';
    })(),
    rrule: draft.rrule,
    excluded,
    overrides:
      override === null ? null : occurrenceKey(override, stampToUtcMs(override)),
  };
}

/**
 * DTEND, or DTSTART plus DURATION, or RFC 5545's default: one day for a DATE
 * start, zero for a DATE-TIME one. An end before its start is clamped — a
 * malformed feed must not mint an event that is in progress forever.
 */
function resolveEnd(
  draft: EventDraft,
  start: ZonedStamp,
  startMs: number,
  feedZone: string,
): number {
  if (draft.dtend !== null) {
    const end = parseIcsStamp(draft.dtend, feedZone);
    if (end !== null) return Math.max(startMs, stampToUtcMs(end));
  }
  if (draft.duration !== null) {
    const duration = parseIcsDuration(draft.duration);
    if (duration !== null) return startMs + Math.max(0, duration);
  }
  return start.dateOnly ? stampToUtcMs(addDays(start, 1)) : startMs;
}

/** The subset of ISO-8601 durations ICS uses: weeks, days, hours, minutes,
 * seconds. A negative duration is not a thing an event's length can be. */
function parseIcsDuration(value: string): number | null {
  const match =
    /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
      value.trim().toUpperCase(),
    );
  if (match === null || match[0] === 'P') return null;
  const [, sign, weeks, days, hours, minutes, seconds] = match;
  const total =
    (Number(weeks ?? 0) * 7 + Number(days ?? 0)) * MS_PER_DAY +
    Number(hours ?? 0) * 3_600_000 +
    Number(minutes ?? 0) * 60_000 +
    Number(seconds ?? 0) * 1_000;
  return sign === '-' ? -total : total;
}

/**
 * The four date forms a calendar actually emits:
 *
 * - `VALUE=DATE` (or a bare `YYYYMMDD`) — all-day. Resolved to midnight in the
 *   FEED's zone, not UTC: an all-day event is a statement about the operator's
 *   calendar day, and midnight UTC would move "today" by up to a day for
 *   everyone west of Greenwich.
 * - `…Z` — an absolute UTC instant, taken as given.
 * - `TZID=<zone>:…` — a wall clock in a named zone, converted below.
 * - neither — a floating time, resolved against `X-WR-TIMEZONE` when the feed
 *   declares one, else UTC. Floating means "whatever clock the reader is on",
 *   and the feed's own zone is the closest honest reading of the operator's.
 */
function parseIcsStamp(
  property: IcsProperty,
  feedZone: string,
): ZonedStamp | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(
    property.value.trim(),
  );
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, utc] = match;

  const dateOnly =
    hour === undefined || property.params.get('VALUE')?.toUpperCase() === 'DATE';
  const tzid = property.params.get('TZID');
  const zone = dateOnly
    ? feedZone
    : utc === 'Z'
      ? 'UTC'
      : tzid !== undefined && isKnownZone(tzid)
        ? tzid
        : feedZone;

  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: dateOnly ? 0 : Number(hour),
    minute: dateOnly ? 0 : Number(minute ?? 0),
    second: dateOnly ? 0 : Number(second ?? 0),
    zone,
    dateOnly,
  };
}

// --- zones, without a timezone database -------------------------------------

const zoneFormatters = new Map<string, Intl.DateTimeFormat | null>();

function zoneFormatter(zone: string): Intl.DateTimeFormat | null {
  const cached = zoneFormatters.get(zone);
  if (cached !== undefined) return cached;
  let formatter: Intl.DateTimeFormat | null = null;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      // h23 rather than `hour12: false`, which reports midnight as hour 24 on
      // some ICU builds.
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    formatter = null;
  }
  zoneFormatters.set(zone, formatter);
  return formatter;
}

function isKnownZone(zone: string): boolean {
  return zone !== '' && zoneFormatter(zone) !== null;
}

/**
 * The zone's offset from UTC at one instant, in milliseconds.
 *
 * There is no timezone database in this Worker and there is not going to be one.
 * `Intl` already ships the full IANA rules, so the offset is read back out of it:
 * format the instant into the zone's wall clock, then re-read those wall-clock
 * fields as if they were UTC. The difference between that and the instant IS the
 * offset, DST included, with no rule table of our own to go stale.
 */
function zoneOffsetMs(utcMs: number, zone: string): number {
  const formatter = zoneFormatter(zone);
  if (formatter === null) return 0;
  const fields = new Map<string, number>();
  for (const part of formatter.formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') fields.set(part.type, Number(part.value));
  }
  const wall = Date.UTC(
    fields.get('year') ?? 1970,
    (fields.get('month') ?? 1) - 1,
    fields.get('day') ?? 1,
    fields.get('hour') ?? 0,
    fields.get('minute') ?? 0,
    fields.get('second') ?? 0,
  );
  return wall - utcMs;
}

/**
 * A wall clock in a zone, as a UTC instant. Two passes, and the second one is
 * the whole point:
 *
 * The first pass asks for the offset at the instant the wall clock WOULD be if
 * it were UTC, which is up to a day off and — an hour either side of a DST
 * transition — the wrong offset. The second pass re-asks at the instant the
 * first pass produced, which is within seconds of the right one, so the offset
 * it returns is the one actually in force. That is what makes 09:30 stay 09:30
 * on both sides of a spring-forward.
 *
 * A wall clock the zone skipped (02:30 on a spring-forward morning) has no
 * instant; the two passes settle on the instant one offset later, which is the
 * same choice every calendar client makes.
 */
function stampToUtcMs(stamp: ZonedStamp): number {
  const naive = Date.UTC(
    stamp.year,
    stamp.month - 1,
    stamp.day,
    stamp.hour,
    stamp.minute,
    stamp.second,
  );
  if (stamp.zone === 'UTC') return naive;
  const firstPass = naive - zoneOffsetMs(naive, stamp.zone);
  return naive - zoneOffsetMs(firstPass, stamp.zone);
}

/** Civil-date arithmetic, done in UTC on purpose: UTC has no DST, so adding a
 * day to a wall-clock date can never land on a day that does not exist. */
function addDays(stamp: ZonedStamp, days: number): ZonedStamp {
  const shifted = new Date(
    Date.UTC(stamp.year, stamp.month - 1, stamp.day) + days * MS_PER_DAY,
  );
  return {
    ...stamp,
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function addMonths(stamp: ZonedStamp, months: number): ZonedStamp {
  const shifted = new Date(Date.UTC(stamp.year, stamp.month - 1 + months, 1));
  return {
    ...stamp,
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: 1,
  };
}

function weekdayOf(stamp: ZonedStamp): number {
  return new Date(Date.UTC(stamp.year, stamp.month - 1, stamp.day)).getUTCDay();
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function civilDayNumber(stamp: ZonedStamp): number {
  return Math.floor(Date.UTC(stamp.year, stamp.month - 1, stamp.day) / MS_PER_DAY);
}

/**
 * Occurrence identity, and the reason EXDATE and RECURRENCE-ID match at all.
 *
 * A timed occurrence is keyed by its UTC INSTANT, because a feed is free to
 * write the same moment three ways — a `TZID=` zone-local time,
 * the equivalent `20260810T163000Z`, or a floating value — and all three name
 * the same instance. An all-day occurrence has no instant to speak of, so it is
 * keyed by its civil date.
 */
function occurrenceKey(stamp: ZonedStamp, startMs: number): string {
  if (!stamp.dateOnly) return `t:${startMs}`;
  const month = String(stamp.month).padStart(2, '0');
  const day = String(stamp.day).padStart(2, '0');
  return `d:${stamp.year}${month}${day}`;
}

// --- recurrence -------------------------------------------------------------

interface ByDayTerm {
  /** `2` in `2TU`, `-1` in `-1FR`, `null` for a bare weekday. */
  ordinal: number | null;
  weekday: number;
}

interface RecurrenceRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  interval: number;
  count: number | null;
  untilMs: number | null;
  byDay: ByDayTerm[];
  byMonthDay: number[];
  weekStart: number;
}

/**
 * The supported RRULE subset — the shapes a calendar full of MEETINGS actually
 * contains, and nothing more:
 *
 * - `FREQ=DAILY` with INTERVAL, COUNT, UNTIL, and BYDAY read as a weekday filter
 *   (the "every weekday" rule some clients write as DAILY rather than WEEKLY).
 * - `FREQ=WEEKLY` with BYDAY, INTERVAL, COUNT, UNTIL, WKST.
 * - `FREQ=MONTHLY` with either BYMONTHDAY (positive or counted from the month's
 *   end) or ONE ordinal BYDAY such as `2TU` / `-1FR`.
 *
 * Everything else — FREQ=YEARLY or FREQ=SECONDLY, BYSETPOS, BYMONTH, BYWEEKNO,
 * BYYEARDAY, sub-day BY* parts, a MONTHLY BYDAY without an ordinal, a WEEKLY
 * BYDAY with one — is reported as unsupported, and the caller then draws the
 * series' base event alone. That is a visibly thin answer rather than a wrong
 * one, and it costs the feed nothing: an unsupported rule is not a broken feed.
 */
function parseRecurrenceRule(
  value: string,
  start: ZonedStamp,
): { supported: true; rule: RecurrenceRule } | { supported: false; freq: string } {
  const parts = new Map<string, string>();
  for (const segment of value.split(';')) {
    const equals = segment.indexOf('=');
    if (equals < 0) continue;
    parts.set(
      segment.slice(0, equals).trim().toUpperCase(),
      segment.slice(equals + 1).trim(),
    );
  }

  const freq = (parts.get('FREQ') ?? '').toUpperCase();
  const unsupported = { supported: false as const, freq: freq === '' ? 'none' : freq };
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') {
    return unsupported;
  }
  for (const narrowing of [
    'BYSETPOS',
    'BYMONTH',
    'BYWEEKNO',
    'BYYEARDAY',
    'BYHOUR',
    'BYMINUTE',
    'BYSECOND',
    'BYEASTER',
    'RSCALE',
  ]) {
    if (parts.has(narrowing)) return unsupported;
  }

  const interval = positiveInteger(parts.get('INTERVAL')) ?? 1;
  const count = positiveInteger(parts.get('COUNT'));
  if (parts.has('COUNT') && count === null) return unsupported;
  if (parts.has('INTERVAL') && positiveInteger(parts.get('INTERVAL')) === null) {
    return unsupported;
  }

  let untilMs: number | null = null;
  const until = parts.get('UNTIL');
  if (until !== undefined) {
    // UNTIL is inclusive, and its zone is its own: a `Z` value is an instant, a
    // bare DATE/DATE-TIME is read in the series' zone.
    const stamp = parseIcsStamp(
      { name: 'UNTIL', params: new Map(), value: until },
      start.zone,
    );
    if (stamp === null) return unsupported;
    untilMs = stampToUtcMs(stamp);
  }

  const byDay: ByDayTerm[] = [];
  const rawByDay = parts.get('BYDAY');
  if (rawByDay !== undefined && rawByDay !== '') {
    for (const term of rawByDay.split(',')) {
      const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(
        term.trim().toUpperCase(),
      );
      if (match === null) return unsupported;
      const ordinal = match[1] === undefined ? null : Number(match[1]);
      if (ordinal === 0) return unsupported;
      byDay.push({
        ordinal,
        weekday: ICS_WEEKDAYS.indexOf(match[2] as (typeof ICS_WEEKDAYS)[number]),
      });
    }
  }

  const byMonthDay: number[] = [];
  const rawByMonthDay = parts.get('BYMONTHDAY');
  if (rawByMonthDay !== undefined && rawByMonthDay !== '') {
    for (const term of rawByMonthDay.split(',')) {
      const day = Number(term.trim());
      if (!Number.isInteger(day) || day === 0 || day < -31 || day > 31) {
        return unsupported;
      }
      byMonthDay.push(day);
    }
  }

  const ordinals = byDay.filter((term) => term.ordinal !== null).length;
  if (freq === 'DAILY' || freq === 'WEEKLY') {
    if (byMonthDay.length > 0 || ordinals > 0) return unsupported;
  } else {
    const byOrdinalDay = byDay.length === 1 && ordinals === 1;
    if (byMonthDay.length > 0 ? byDay.length > 0 : !byOrdinalDay) {
      return unsupported;
    }
  }

  const weekStart = ICS_WEEKDAYS.indexOf(
    (parts.get('WKST') ?? 'MO').toUpperCase() as (typeof ICS_WEEKDAYS)[number],
  );
  return {
    supported: true,
    rule: {
      freq,
      interval,
      count,
      untilMs,
      byDay,
      byMonthDay,
      weekStart: weekStart < 0 ? 1 : weekStart,
    },
  };
}

function positiveInteger(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value > 0 ? value : null;
}

interface Occurrence {
  startMs: number;
  endMs: number;
  key: string;
}

/**
 * Expand one series into the occurrences that touch `[fromMs, toMs]`.
 *
 * Iteration happens in the WALL-CLOCK domain — dates step, the time of day is
 * carried, and each candidate is converted to an instant at the end. A weekly
 * 09:30 stays 09:30 across a DST boundary instead of sliding to 08:30, which is
 * the bug every "just add seven days of milliseconds" recurrence has.
 *
 * `COUNT` is the reason there are two paths. Without it the cursor jumps
 * straight to the window, so a daily meeting running since 2019 costs a handful
 * of steps. With it, every occurrence from DTSTART forward has to be counted to
 * know where the series stops, so the walk starts at the beginning — bounded by
 * COUNT itself and, past pathology, by {@link MAX_RECURRENCE_STEPS}.
 */
function expandSeries(
  event: CalendarEvent,
  rule: RecurrenceRule,
  fromMs: number,
  toMs: number,
): Occurrence[] {
  const found: Occurrence[] = [];
  const counting = rule.count !== null;
  let period = initialPeriod(event.start, rule);
  if (!counting) period = fastForward(period, rule, fromMs);
  let produced = 0;

  for (let step = 0; step < MAX_RECURRENCE_STEPS; step += 1) {
    // Every candidate a period contributes falls on or after the period's own
    // first day, so a period past the window ends the walk. Without this, a rule
    // whose candidates are ALL filtered out — an `INTERVAL=7` stride that can
    // never land on its own `BYDAY` — would spend the whole step budget on
    // every single call.
    if (stampToUtcMs(period) > toMs) return found;

    for (const stamp of periodCandidates(period, event.start, rule)) {
      const startMs = stampToUtcMs(stamp);
      // DTSTART is the series' floor; the caller adds it back explicitly, so a
      // candidate at or before it is never emitted here.
      if (startMs <= event.startMs) continue;
      if (rule.untilMs !== null && startMs > rule.untilMs) return found;
      // COUNT counts the whole series and DTSTART is its first member, so the
      // rule itself owns COUNT-1 occurrences.
      if (rule.count !== null && produced >= rule.count - 1) return found;
      produced += 1;
      if (startMs > toMs) return found;
      if (startMs >= fromMs) {
        found.push({
          startMs,
          endMs: occurrenceEnd(event, stamp, startMs),
          key: occurrenceKey(stamp, startMs),
        });
      }
    }
    period = advancePeriod(period, rule);
  }
  return found;
}

/**
 * A recurring instance's end. A timed series keeps the base event's exact
 * length; an all-day one keeps its length in WHOLE DAYS, so a three-day event
 * stays three days across a DST boundary instead of becoming 71 hours.
 */
function occurrenceEnd(
  event: CalendarEvent,
  stamp: ZonedStamp,
  startMs: number,
): number {
  if (!event.allDay) return startMs + (event.endMs - event.startMs);
  const days = Math.max(1, Math.round((event.endMs - event.startMs) / MS_PER_DAY));
  return stampToUtcMs(addDays(stamp, days));
}

function initialPeriod(start: ZonedStamp, rule: RecurrenceRule): ZonedStamp {
  if (rule.freq === 'MONTHLY') return addMonths(start, 0);
  if (rule.freq === 'WEEKLY') {
    const offset = (weekdayOf(start) - rule.weekStart + 7) % 7;
    return addDays(start, -offset);
  }
  return start;
}

/**
 * Skip whole periods until just before the window. One period of deliberate
 * slack absorbs both the period that straddles the window's start and the fact
 * that `fromMs` is measured against a UTC date while the cursor walks a
 * zone-local one.
 */
function fastForward(
  period: ZonedStamp,
  rule: RecurrenceRule,
  fromMs: number,
): ZonedStamp {
  const target = new Date(fromMs);
  if (rule.freq === 'MONTHLY') {
    const months =
      (target.getUTCFullYear() - period.year) * 12 +
      (target.getUTCMonth() + 1 - period.month);
    const skip = Math.floor(months / rule.interval) - 1;
    return skip > 0 ? addMonths(period, skip * rule.interval) : period;
  }
  const days = Math.floor(fromMs / MS_PER_DAY) - civilDayNumber(period);
  const stride = rule.freq === 'WEEKLY' ? 7 * rule.interval : rule.interval;
  const skip = Math.floor(days / stride) - 1;
  return skip > 0 ? addDays(period, skip * stride) : period;
}

function advancePeriod(period: ZonedStamp, rule: RecurrenceRule): ZonedStamp {
  if (rule.freq === 'MONTHLY') return addMonths(period, rule.interval);
  if (rule.freq === 'WEEKLY') return addDays(period, 7 * rule.interval);
  return addDays(period, rule.interval);
}

/** Every candidate date one period contributes, ascending, carrying DTSTART's
 * time of day and zone. */
function periodCandidates(
  period: ZonedStamp,
  start: ZonedStamp,
  rule: RecurrenceRule,
): ZonedStamp[] {
  if (rule.freq === 'DAILY') {
    const weekdays = rule.byDay.map((term) => term.weekday);
    if (weekdays.length > 0 && !weekdays.includes(weekdayOf(period))) return [];
    return [period];
  }

  if (rule.freq === 'WEEKLY') {
    const weekdays =
      rule.byDay.length > 0
        ? rule.byDay.map((term) => term.weekday)
        : [weekdayOf(start)];
    const offsets = [
      ...new Set(weekdays.map((weekday) => (weekday - rule.weekStart + 7) % 7)),
    ].sort((left, right) => left - right);
    return offsets.map((offset) => addDays(period, offset));
  }

  const total = daysInMonth(period.year, period.month);
  const days: number[] = [];
  if (rule.byMonthDay.length > 0) {
    for (const day of rule.byMonthDay) {
      const resolved = day > 0 ? day : total + 1 + day;
      // A rule asking for the 31st skips the months that have no 31st, which is
      // what RFC 5545 requires and what a calendar client shows.
      if (resolved >= 1 && resolved <= total) days.push(resolved);
    }
  } else {
    const term = rule.byDay[0];
    if (term === undefined || term.ordinal === null) return [];
    const firstWeekday = weekdayOf({ ...period, day: 1 });
    const first = 1 + ((term.weekday - firstWeekday + 7) % 7);
    const resolved =
      term.ordinal > 0
        ? first + (term.ordinal - 1) * 7
        : first + (Math.floor((total - first) / 7) + term.ordinal + 1) * 7;
    if (resolved >= 1 && resolved <= total) days.push(resolved);
  }
  return days
    .sort((left, right) => left - right)
    .map((day) => ({ ...start, year: period.year, month: period.month, day }));
}

// --- the window the Wall sees -----------------------------------------------

/**
 * Everything drawable right now: each event's own occurrence plus, for a series,
 * the instances its rule puts inside the window — minus EXDATEs, minus the
 * instances a RECURRENCE-ID replaces, minus anything cancelled.
 */
function upcomingFrom(
  events: CalendarEvent[],
  nowMs: number,
): UpcomingMeeting[] {
  const windowEndMs = nowMs + UPCOMING_WINDOW_MS;
  const expandFromMs = nowMs - IN_PROGRESS_LOOKBACK_MS;

  // A moved or retitled instance arrives as a second VEVENT sharing the series'
  // UID and naming the instance it replaces. Collected first, because the rule
  // must not also produce the instance it stands in for — and a CANCELLED
  // override belongs here too: it replaces that instance with nothing.
  const overridden = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.overrides === null) continue;
    const key = `${event.calendar}\0${event.uid}`;
    const keys = overridden.get(key) ?? new Set<string>();
    keys.add(event.overrides);
    overridden.set(key, keys);
  }

  const meetings: UpcomingMeeting[] = [];
  for (const event of events) {
    // Both suppressions happen AFTER the override map is built, and that order is
    // the point: declining one instance of a standup has to keep suppressing the
    // instance it replaced, or the original would reappear at its old time as if
    // the operator had never answered.
    if (event.cancelled || event.notAccepted) continue;

    const baseKey = occurrenceKey(event.start, event.startMs);
    const seen = new Set<string>([baseKey]);
    const candidates: Occurrence[] = [
      { startMs: event.startMs, endMs: event.endMs, key: baseKey },
    ];

    if (event.rrule !== null && event.overrides === null) {
      const parsed = parseRecurrenceRule(event.rrule, event.start);
      if (parsed.supported) {
        for (const occurrence of expandSeries(
          event,
          parsed.rule,
          expandFromMs,
          windowEndMs,
        )) {
          if (seen.has(occurrence.key)) continue;
          seen.add(occurrence.key);
          candidates.push(occurrence);
        }
      }
      // An unsupported rule is a documented degradation, not a failure: the
      // base event still shows, and it is NOT logged here. This function runs
      // on every poll over the cached round, and a personal calendar's few
      // thousand YEARLY birthdays once produced one warn line each per poll —
      // thousands of lines an hour, drowning the supervisor lane the operator
      // diagnoses everything else from (ro-l2ji). The round that fetched the
      // bytes logs one aggregate line per feed instead (see feedRound).
    }

    const replaced = overridden.get(`${event.calendar}\0${event.uid}`);
    for (const occurrence of candidates) {
      if (event.excluded.has(occurrence.key)) continue;
      // An override replaces its instance, so the SERIES must not also draw it.
      // The override's own VEVENT is exempt: an instance that was retitled but
      // not moved still starts where the instance it replaces started, and would
      // otherwise erase itself.
      if (event.overrides === null && replaced?.has(occurrence.key)) continue;
      if (!inWindow(occurrence, nowMs, windowEndMs)) continue;
      meetings.push({
        calendar: event.calendar,
        title: event.title,
        startsAt: new Date(occurrence.startMs).toISOString(),
        endsAt: new Date(occurrence.endMs).toISOString(),
        allDay: event.allDay,
        location: event.location,
      });
    }
  }

  return meetings
    .sort(
      (left, right) =>
        compare(left.startsAt, right.startsAt) ||
        compare(left.title, right.title) ||
        // Two calendars can hold the same meeting at the same minute; a third
        // key keeps the order the same on every poll.
        compare(left.calendar, right.calendar),
    )
    // Field-for-field twins collapse to one. Google's auto-generated events
    // (flight check-ins from two booking emails, say) can land in one calendar
    // twice under different UIDs, and a panel showing "Check in" twice tells
    // the operator less than showing it once (observed live 2026-08-11: twin
    // WN 1533 check-ins, ro-l2ji). The sort above makes twins adjacent, so
    // this is a neighbour test. Anything that differs in ANY field — even
    // location — is two facts and both survive.
    .filter(
      (meeting, index, sorted) =>
        index === 0 || !sameMeeting(meeting, sorted[index - 1]!),
    )
    .slice(0, MEETING_LIMIT);
}

function sameMeeting(a: UpcomingMeeting, b: UpcomingMeeting): boolean {
  return (
    a.calendar === b.calendar &&
    a.title === b.title &&
    a.startsAt === b.startsAt &&
    a.endsAt === b.endsAt &&
    a.allDay === b.allDay &&
    a.location === b.location
  );
}

/** Starting inside the window, or already running: a meeting the operator is in
 * right now is the one they are most likely to be looking for. */
function inWindow(
  occurrence: Occurrence,
  nowMs: number,
  windowEndMs: number,
): boolean {
  if (occurrence.startMs >= nowMs) return occurrence.startMs <= windowEndMs;
  return occurrence.endMs > nowMs;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
