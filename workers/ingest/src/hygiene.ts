// Nightly hygiene guards on the served layer: static HTML depth, AI-crawler
// access, sitemap health and page structure, checked by fetching each
// property's own domain under this OS's honest User-Agent. Every check accuses
// a property, so each first makes sure the failure is the property's: a 200
// past the byte ceiling records `unsupported`, and a fetch with no status asks
// src/egress.ts whether the OS could reach the network at all.

import { javascriptInstant } from '@noticeos/postgres';
import { appendReadingToOpen, holdCondition, raiseAlertUnlessOpen, readOpenAlert, resolveOpen } from './alert-store.js';
import { EgressGate, type EgressRunOutcome } from './egress.js';

// --- vocabulary -------------------------------------------------------------

export const HYGIENE_CHECKS = [
  'html-depth',
  'robots-ai-access',
  'sitemap',
  'page-structure',
] as const;
export type HygieneCheckId = (typeof HYGIENE_CHECKS)[number];

/** The four states a reading can record; see the migration for the semantics. */
export type HygieneStatus = 'ok' | 'warn' | 'error' | 'unreachable';

export const HTML_DEPTH_RULE_ID = 'hygiene-html-depth';
export const ROBOTS_AI_RULE_ID = 'hygiene-robots-ai';
export const SITEMAP_RULE_ID = 'hygiene-sitemap';
/**
 * Reachability of the home page: a second rule on the `html-depth` reading,
 * because an unreachable page is not a zero-word page. The two cannot
 * double-report: depth needs a body it counted, this needs the absence of one.
 * Also the site's uptime ({@link runUptimeChecks}); it files only on a failure
 * the retry confirms ({@link HOME_CONFIRM_WAIT_MS}).
 */
export const HOME_UNREACHABLE_RULE_ID = 'hygiene-home-unreachable';
/**
 * Crawler directives found on real pages (`<meta name="robots">`,
 * `X-Robots-Tag`). A site-level block is a robots.txt line and a page-level one
 * is a template, so they carry separate rule ids.
 */
export const PAGE_DIRECTIVES_RULE_ID = 'hygiene-page-directives';
/**
 * Structural faults on the sampled pages: missing `<title>`, missing meta
 * description, missing or duplicated `<h1>`, canonical pointing elsewhere.
 * Read from the bytes the directive check already fetched. Title and
 * description length are deliberately not checked: Google truncates by pixel
 * width and rewrites titles, so a length check fires on taste.
 */
export const PAGE_STRUCTURE_RULE_ID = 'hygiene-page-structure';

/**
 * The bots whose access is a business input. A bot absent from this list is
 * not watched: the check claims nothing about the rest of the file.
 */
export const WATCHED_BOTS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'anthropic-ai',
  'PerplexityBot',
  'Google-Extended',
  'Bingbot',
] as const;
export type WatchedBot = (typeof WATCHED_BOTS)[number];

/**
 * Honest identification. Never a crawler's token: impersonating GPTBot to see
 * what GPTBot receives would be lying to the origin about who is asking.
 */
export const HYGIENE_USER_AGENT =
  'NoticeOS-Hygiene/1.0 (+https://www.notice.cx; portfolio self-check)';

/** Per request, so a slow origin costs a bounded slice of the nightly slot. */
const REQUEST_TIMEOUT_MS = 15_000;

/** A document past this is not one to word-count inside a Worker's memory. */
const RESPONSE_BYTE_LIMIT = 8 * 1024 * 1024;

/** How many prior READINGS feed the html-depth median (see `depthBaseline`). */
const DEPTH_BASELINE_WINDOW = 14;
/** Below this many prior readings the depth rule stays unarmed: never flag on
 * sparse history. */
const DEPTH_MIN_READINGS = 7;
/** Today must be at or under this share of the baseline median to flag. */
const DEPTH_COLLAPSE_RATIO = 0.5;

/** Same shape for sitemaps: today at or under half of the previous count … */
const SITEMAP_COLLAPSE_RATIO = 0.5;
/** … but only when the previous count was big enough for -50% to mean anything:
 * 6 → 3 URLs is noise; 4,000 → 40 is an outage. */
const SITEMAP_MIN_PREV_URLS = 50;
/**
 * A <sitemapindex> is followed one level deep and at most this many children,
 * so a sharded property does not turn a three-request check into a crawl. Past
 * the cap the stored count is an explicit floor (`children_capped: true`), and a
 * constant cap keeps the collapse comparison floor-to-floor.
 */
const SITEMAP_INDEX_CHILD_CAP = 10;

/**
 * Real pages sampled per property per night, from the sitemap the sweep already
 * fetched, stably ({@link stableSample}). A budget, not a coverage claim: the
 * check says "these pages are clean", never "the property is clean".
 */
const PAGE_SAMPLE_SIZE = 3;

// --- HTTP -------------------------------------------------------------------

interface FetchOutcome {
  url: string;
  /** HTTP status, or null when the request never completed at all. */
  status: number | null;
  /** True only for a 200 whose body we actually read. */
  ok: boolean;
  body: string;
  bytes: number;
  contentType: string | null;
  /** `X-Robots-Tag`, verbatim: a crawler directive that lives nowhere in the body. */
  xRobotsTag: string | null;
  /** The origin answered with bytes we will not decode as text (gzip, binary). */
  binary?: boolean;
  error?: string;
}

/** Content types never run through `.text()`: none is a document this lane can read. */
const BINARY_CONTENT_TYPE = /gzip|zip|octet-stream/i;

/**
 * One hygiene GET. Never throws: "the origin refused" and "we could not reach
 * the origin" are both readings this lane stores.
 */
async function fetchDoc(fetchImpl: typeof fetch, url: string, accept: string): Promise<FetchOutcome> {
  const base: FetchOutcome = {
    url,
    status: null,
    ok: false,
    body: '',
    bytes: 0,
    contentType: null,
    xRobotsTag: null,
  };
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept, 'user-agent': HYGIENE_USER_AGENT },
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const contentType = response.headers.get('content-type');
    const xRobotsTag = response.headers.get('x-robots-tag');
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > RESPONSE_BYTE_LIMIT) {
      await response.body?.cancel();
      return {
        ...base,
        status: response.status,
        contentType,
        xRobotsTag,
        error: `response exceeds ${RESPONSE_BYTE_LIMIT} bytes`,
      };
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      return {
        ...base,
        status: response.status,
        contentType,
        xRobotsTag,
        error: `non-200 response (${response.status})`,
      };
    }
    if (BINARY_CONTENT_TYPE.test(contentType ?? '')) {
      await response.body?.cancel();
      return {
        ...base,
        status: 200,
        contentType,
        xRobotsTag,
        binary: true,
        error: `unreadable content type (${contentType})`,
      };
    }
    const body = await response.text();
    const bytes = new TextEncoder().encode(body).length;
    if (bytes > RESPONSE_BYTE_LIMIT) {
      return {
        ...base,
        status: 200,
        contentType,
        xRobotsTag,
        bytes,
        error: `response exceeds ${RESPONSE_BYTE_LIMIT} bytes`,
      };
    }
    return { url, status: 200, ok: true, body, bytes, contentType, xRobotsTag };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}

// --- check a: html-depth ----------------------------------------------------

/** Elements whose contents are never visible text a crawler would read. */
const INVISIBLE_ELEMENTS = /<(script|style|noscript|svg|template|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const ANY_TAG = /<[^>]*>/g;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

/** The handful of entities that actually affect a word count. */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (_match, ref: string) => {
    if (ref.startsWith('#x') || ref.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(ref.slice(2), 16) || 32);
    }
    if (ref.startsWith('#')) return String.fromCodePoint(Number.parseInt(ref.slice(1), 10) || 32);
    // Dropping an unknown entity cannot invent a word; a space could split one in two.
    return NAMED_ENTITIES[ref.toLowerCase()] ?? '';
  });
}

/**
 * Words of visible text in served HTML. A string transform, not a parser: it
 * strips comments and never-visible elements, drops tags, decodes the entities
 * that matter, and counts tokens with at least one letter or digit. It does not
 * execute JavaScript (neither do AI crawlers) or distinguish nav from body: the
 * check catches collapse, not quality.
 */
export function countVisibleWords(html: string): number {
  const text = decodeEntities(
    html.replace(HTML_COMMENT, ' ').replace(INVISIBLE_ELEMENTS, ' ').replace(ANY_TAG, ' '),
  );
  let words = 0;
  for (const token of text.split(/\s+/)) {
    if (token !== '' && WORD_CHARACTER.test(token)) words += 1;
  }
  return words;
}

/** Median of a non-empty list; the mean of the two middle values when even. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// --- check b: robots-ai-access ----------------------------------------------

/**
 * One `User-agent:` group, reduced to: is the whole site closed to its agents?
 * `allow_root` is tracked because a group carrying both `Disallow: /` and
 * `Allow: /` resolves to allow (equal path length), which is how several CMS
 * defaults express "blocked from nothing".
 */
export interface RobotsGroup {
  /** Lower-cased agent tokens this group applies to. */
  agents: string[];
  disallow_all: boolean;
  allow_root: boolean;
}

/**
 * Site-level robots.txt group parser. Catches a named bot (or `*`) acquiring a
 * blanket `Disallow: /`, a bot's group disappearing into a blocking `*` group,
 * and robots.txt vanishing. Does not evaluate path-level rules, wildcards, `$`
 * patterns, longest-match precedence or `crawl-delay`; per-page directives are
 * {@link parsePageDirectives}'s job. Agent matching is exact (case-insensitive),
 * not the prefix match real crawlers use: it can miss a block, never invent one.
 */
export function parseRobotsGroups(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  // Consecutive `User-agent:` lines address one group; the first rule line ends
  // the header.
  let inHeader = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = (rawLine.split('#')[0] ?? '').trim();
    if (line === '') continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (current === null || !inHeader) {
        current = { agents: [], disallow_all: false, allow_root: false };
        groups.push(current);
        inHeader = true;
      }
      if (value !== '') current.agents.push(value.toLowerCase());
      continue;
    }
    if (current === null) continue; // a rule before any group belongs to nobody
    inHeader = false;
    if (field === 'disallow' && value === '/') current.disallow_all = true;
    if (field === 'allow' && value === '/') current.allow_root = true;
  }
  return groups;
}

export interface BotAccess {
  allowed: boolean;
  /** Which group decided it: the bot's own name, '*', or null (no group at all). */
  via: string | null;
}

/** Resolve one watched bot against the parsed groups: own group, else `*`, else allowed. */
export function resolveBotAccess(groups: RobotsGroup[], bot: string): BotAccess {
  const token = bot.toLowerCase();
  const named = groups.find((group) => group.agents.includes(token));
  const wildcard = groups.find((group) => group.agents.includes('*'));
  const group = named ?? wildcard;
  if (!group) return { allowed: true, via: null };
  return { allowed: !(group.disallow_all && !group.allow_root), via: named ? bot : '*' };
}

/** The resolved allow map for every watched bot — the thing the next night diffs. */
export function resolveWatchedBots(groups: RobotsGroup[]): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const bot of WATCHED_BOTS) map[bot] = resolveBotAccess(groups, bot).allowed;
  return map;
}

/** `Sitemap:` declarations, absolute http(s) URLs only, in file order. */
export function sitemapUrlsFromRobots(text: string): string[] {
  const urls: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = (rawLine.split('#')[0] ?? '').trim();
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    if (line.slice(0, separator).trim().toLowerCase() !== 'sitemap') continue;
    const value = line.slice(separator + 1).trim();
    if (/^https?:\/\//i.test(value) && !urls.includes(value)) urls.push(value);
  }
  return urls;
}

// --- check b, page level: meta-robots and X-Robots-Tag ----------------------

/**
 * Directives that take a value rather than naming a user agent; without this
 * set `unavailable_after: <date>` would parse as a user-agent scope.
 */
const VALUED_DIRECTIVES = new Set([
  'unavailable_after',
  'max-snippet',
  'max-image-preview',
  'max-video-preview',
]);

/**
 * The directives that take a page out of the surfaces this portfolio is graded
 * on; `nofollow`, `noarchive` and `max-image-preview` change treatment without
 * removing the page. `max-snippet:0` is `nosnippet` written as a number.
 */
const BLOCKING_DIRECTIVES = new Set([
  'noindex',
  'none',
  'nosnippet',
  'noai',
  'noimageai',
  'max-snippet:0',
]);

/** One page's crawler directives, resolved from its markup and its headers. */
export interface PageDirectives {
  /** Directives addressed to every agent (`<meta name="robots">`, a bare `X-Robots-Tag`). */
  all: string[];
  /** Directives scoped to one agent token, lower-cased (`googlebot: noindex`). */
  byAgent: Record<string, string[]>;
  /** Where each directive came from, so a reading can say `meta-robots` vs `x-robots-tag`. */
  sources: string[];
}

function normalizeDirectives(value: string): string[] {
  const out: string[] = [];
  for (const raw of value.split(',')) {
    const token = raw.trim().toLowerCase().replace(/\s*:\s*/, ':');
    if (token !== '') out.push(token);
  }
  return out;
}

const META_TAG = /<meta\b[^>]*>/gi;
const META_ATTR = /(\w[\w:-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function metaAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  META_ATTR.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = META_ATTR.exec(tag)) !== null) {
    attrs[match[1]!.toLowerCase()] = decodeEntities(match[3] ?? match[4] ?? match[5] ?? '');
  }
  return attrs;
}

/**
 * Crawler directives for one page: `<meta name="robots">`, per-agent meta, and
 * the `X-Robots-Tag` header. In the header an `agent:` part opens a scope that
 * runs until the next one; several headers arrive joined into one string, so a
 * bare directive after an agent-scoped one is read as that agent's. It can
 * attribute a block too narrowly, never invent one.
 */
export function parsePageDirectives(html: string, xRobotsTag: string | null): PageDirectives {
  const all: string[] = [];
  const byAgent: Record<string, string[]> = {};
  const sources = new Set<string>();

  const add = (agent: string | null, directives: string[], source: string): void => {
    if (directives.length === 0) return;
    sources.add(source);
    if (agent === null) {
      for (const directive of directives) if (!all.includes(directive)) all.push(directive);
      return;
    }
    const bucket = (byAgent[agent] ??= []);
    for (const directive of directives) if (!bucket.includes(directive)) bucket.push(directive);
  };

  META_TAG.lastIndex = 0;
  let tag: RegExpExecArray | null;
  while ((tag = META_TAG.exec(html)) !== null) {
    const attrs = metaAttributes(tag[0]);
    const name = attrs.name?.trim().toLowerCase();
    if (name === undefined || attrs.content === undefined) continue;
    if (name === 'robots') add(null, normalizeDirectives(attrs.content), 'meta-robots');
    else if (name.endsWith('bot') || name === 'anthropic-ai' || name === 'google-extended') {
      add(name, normalizeDirectives(attrs.content), 'meta-robots');
    }
  }

  if (xRobotsTag !== null && xRobotsTag.trim() !== '') {
    let scope: string | null = null;
    for (const part of xRobotsTag.split(',')) {
      const token = part.trim();
      if (token === '') continue;
      const colon = token.indexOf(':');
      const head = colon < 0 ? '' : token.slice(0, colon).trim().toLowerCase();
      if (colon > 0 && !VALUED_DIRECTIVES.has(head) && !/\s/.test(head)) {
        scope = head;
        add(scope, normalizeDirectives(token.slice(colon + 1)), 'x-robots-tag');
        continue;
      }
      add(scope, normalizeDirectives(token), 'x-robots-tag');
    }
  }

  return { all, byAgent, sources: [...sources].sort() };
}

/**
 * The blocking directives on a page, each qualified by the agent it addresses,
 * so a reading names what an operator would have to go and delete.
 */
export function blockingDirectives(parsed: PageDirectives): string[] {
  const found = parsed.all.filter((directive) => BLOCKING_DIRECTIVES.has(directive));
  for (const [agent, directives] of Object.entries(parsed.byAgent)) {
    for (const directive of directives) {
      if (BLOCKING_DIRECTIVES.has(directive)) found.push(`${agent}:${directive}`);
    }
  }
  return [...new Set(found)].sort();
}

/**
 * A stable K-of-N sample: the URLs whose FNV-1a hash sorts first. Sitemaps are
 * commonly ordered by `lastmod` descending, so "the first three" would be three
 * different URLs every night and a first reading never flags.
 */
export function stableSample(urls: string[], size: number): string[] {
  const unique = [...new Set(urls)];
  const hashed = unique.map((url) => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < url.length; i += 1) {
      hash ^= url.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return { url, hash };
  });
  hashed.sort((a, b) => (a.hash === b.hash ? (a.url < b.url ? -1 : 1) : a.hash - b.hash));
  return hashed.slice(0, size).map((entry) => entry.url);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}


// --- check d: page structure ------------------------------------------------

const TITLE_TAG = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i;
const H1_TAG = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/gi;
const LINK_TAG = /<link\b[^>]*>/gi;

/** What one page says about itself, structurally. */
export interface PageStructure {
  /** The trimmed `<title>` text, or null when the tag is absent or empty. */
  title: string | null;
  /** The trimmed `<meta name="description">`, or null. */
  description: string | null;
  /** How many `<h1>` elements the document carries. */
  h1Count: number;
  /** `<link rel="canonical">`, resolved against the page URL, or null. */
  canonical: string | null;
  /** True when the canonical names a DIFFERENT page — this one is disclaimed. */
  canonicalElsewhere: boolean;
}

/**
 * Compare two URLs the way a search engine's canonical check does: scheme and
 * host case-insensitively, path exactly except a trailing slash, query
 * order-insensitively, fragment dropped. Stricter would fire on almost every
 * page on the internet.
 */
export function sameCanonicalTarget(pageUrl: string, canonical: string): boolean {
  let left: URL;
  let right: URL;
  try {
    left = new URL(pageUrl);
    right = new URL(canonical, pageUrl);
  } catch {
    // Unparseable means "could not tell", not "disclaimed": treated as
    // self-referential so the rule stays silent.
    return true;
  }
  if (left.protocol !== right.protocol) return false;
  if (left.hostname.toLowerCase() !== right.hostname.toLowerCase()) return false;
  if (left.port !== right.port) return false;
  const path = (url: URL): string =>
    url.pathname.length > 1 && url.pathname.endsWith('/')
      ? url.pathname.slice(0, -1)
      : url.pathname;
  if (path(left) !== path(right)) return false;
  const params = (url: URL): string =>
    [...url.searchParams.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
  return params(left) === params(right);
}

/**
 * Regex rather than a DOM: this runs on up to `RESPONSE_BYTE_LIMIT` of HTML and
 * the questions are shallow. Where a regex cannot be sure it returns null,
 * which reads as "not measured", never as "absent".
 */
export function parsePageStructure(html: string, pageUrl: string): PageStructure {
  const titleMatch = TITLE_TAG.exec(html);
  const rawTitle = titleMatch ? decodeEntities(titleMatch[1] ?? '').trim() : '';
  // An empty <title></title> is the same fact as no title: the SERP has nothing
  // to print either way.
  const title = rawTitle.length > 0 ? rawTitle : null;

  let description: string | null = null;
  META_TAG.lastIndex = 0;
  let tag: RegExpExecArray | null;
  while ((tag = META_TAG.exec(html)) !== null) {
    const attrs = metaAttributes(tag[0]);
    if (attrs.name?.trim().toLowerCase() === 'description') {
      const value = (attrs.content ?? '').trim();
      description = value.length > 0 ? value : null;
      break;
    }
  }

  H1_TAG.lastIndex = 0;
  let h1Count = 0;
  while (H1_TAG.exec(html) !== null) h1Count += 1;

  let canonical: string | null = null;
  LINK_TAG.lastIndex = 0;
  let link: RegExpExecArray | null;
  while ((link = LINK_TAG.exec(html)) !== null) {
    const attrs = metaAttributes(link[0]);
    if (attrs.rel?.trim().toLowerCase() !== 'canonical') continue;
    const href = (attrs.href ?? '').trim();
    if (href.length === 0) continue;
    canonical = href;
    break;
  }

  return {
    title,
    description,
    h1Count,
    canonical,
    canonicalElsewhere:
      canonical !== null && !sameCanonicalTarget(pageUrl, canonical),
  };
}

/** The structural faults on one page. Empty is the only thing that means clean. */
export function structureFaults(structure: PageStructure): string[] {
  const faults: string[] = [];
  if (structure.title === null) faults.push('no-title');
  if (structure.description === null) faults.push('no-meta-description');
  if (structure.h1Count === 0) faults.push('no-h1');
  if (structure.h1Count > 1) faults.push('multiple-h1');
  if (structure.canonicalElsewhere) faults.push('canonical-elsewhere');
  return faults;
}

// --- check c: sitemap -------------------------------------------------------

const SITEMAP_ROOT = /<\s*(urlset|sitemapindex)\b/i;
const LOC_ENTRY = /<loc\b[^>]*>([\s\S]*?)<\/loc\s*>/gi;

/**
 * The root element, or null when this is not a sitemap (commonly an origin
 * answering /sitemap.xml with its 200 HTML error page). Requires the closing
 * tag, so a truncated response is unparseable rather than silently short.
 */
export function sitemapRoot(xml: string): 'urlset' | 'sitemapindex' | null {
  const opened = SITEMAP_ROOT.exec(xml.replace(HTML_COMMENT, ' '));
  if (!opened) return null;
  const root = opened[1]!.toLowerCase() as 'urlset' | 'sitemapindex';
  return new RegExp(`</\\s*${root}\\s*>`, 'i').test(xml) ? root : null;
}

/** `<loc>` values in document order — page URLs in a urlset, child sitemaps in an index. */
export function locValues(xml: string): string[] {
  const values: string[] = [];
  LOC_ENTRY.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LOC_ENTRY.exec(xml)) !== null) {
    const value = decodeEntities(match[1]!.trim());
    if (value !== '') values.push(value);
  }
  return values;
}

/**
 * Gzipped sitemaps are legal and unreadable here: either the content type said
 * so, or a `.gz` URL came back 200. A non-200 on a `.gz` URL is an ordinary
 * outage and is flagged as one.
 */
function isUnreadableSitemap(outcome: FetchOutcome): boolean {
  return outcome.binary === true || (outcome.ok && /\.gz(\?|$)/i.test(outcome.url));
}

// --- stored history ---------------------------------------------------------

type HygieneReading = {
  observed_on: string;
  observed_at: string;
  status: HygieneStatus;
  value_num: number | null;
  detail_json: string;
};

/**
 * Prior readings for one check, newest first, strictly before today. The window
 * is the last N readings, not N days: a night the cron did not run should make
 * the baseline older, not thinner. `healthyOnly` is load-bearing for the count
 * rules: a regression that persists must not become its own baseline and
 * resolve the flag describing it.
 */
async function priorReadings(
  env: IngestEnv,
  asset: string,
  check: HygieneCheckId,
  today: string,
  limit: number,
  healthyOnly = false,
): Promise<HygieneReading[]> {
  const rows = await env.STORE.read((tx) =>
    tx.query<HygieneReading>(
      `SELECT observed_on, observed_at, status, value_num, detail::text AS detail_json
         FROM noticeos.hygiene_checks
        WHERE asset_id = $1 AND check_id = $2 AND observed_on < $3::date
          AND (NOT $5::boolean OR (status = 'ok' AND value_num IS NOT NULL))
        ORDER BY observed_on DESC
        LIMIT $4`,
      [asset, check, today, limit, healthyOnly],
    ),
  );
  return rows.map((row) => ({ ...row, observed_at: javascriptInstant(row.observed_at) }));
}

/** The open flag's stored inputs for one guard, so an ongoing condition can be
 * told apart from a fresh one. */
async function openFlagInputs(
  env: IngestEnv,
  asset: string,
  ruleId: string,
): Promise<Record<string, unknown> | null> {
  const open = await env.STORE.read((tx) => readOpenAlert(tx, asset, ruleId));
  if (!open?.ruleInputs) return null;
  try {
    const parsed = JSON.parse(open.ruleInputs) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Upsert today's reading; a same-day re-run replaces it. */
async function writeReading(
  env: IngestEnv,
  asset: string,
  check: HygieneCheckId,
  observedAt: string,
  status: HygieneStatus,
  valueNum: number | null,
  detail: unknown,
): Promise<void> {
  await env.STORE.write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.hygiene_checks
         (workspace_id, asset_id, check_id, observed_at, observed_on, status, value_num, detail)
       VALUES ($1, $2, $3, $4::timestamptz, $5::date, $6, $7, $8::json)
       ON CONFLICT (workspace_id, asset_id, check_id, observed_on) DO UPDATE SET
         observed_at = excluded.observed_at,
         status      = excluded.status,
         value_num   = excluded.value_num,
         detail      = excluded.detail`,
      [tx.workspaceId, asset, check, observedAt, observedAt.slice(0, 10), status, valueNum, JSON.stringify(detail ?? {})],
    ),
  );
}

// --- flags ------------------------------------------------------------------

/** The bookkeeping every hygiene flag carries on top of its check-specific inputs. */
interface HygieneFlagBookkeeping {
  rule: string;
  check: HygieneCheckId;
  /** Nights this condition has been observed since the flag opened — 1 on the first. */
  occurrences: number;
  /** Most recent observation; the row's `fired_at` stays the FIRST one. */
  lastObservedAt: string;
  evaluatedAt: string;
}

function priorOccurrences(ruleInputs: string | null | undefined): number {
  if (!ruleInputs) return 0;
  try {
    const previous = JSON.parse(ruleInputs) as Partial<HygieneFlagBookkeeping>;
    return typeof previous.occurrences === 'number' && Number.isFinite(previous.occurrences)
      ? previous.occurrences
      : 0;
  } catch {
    return 0;
  }
}

export interface HygieneFlagWrite {
  /** 1 when a new flag row was inserted. */
  fired: number;
  /** 1 when an already-open flag was rewritten with tonight's observation. */
  refreshed: number;
}

/**
 * File a hygiene flag as an ongoing condition observed once a night: the first
 * night inserts, every night after becomes the open alert's newest reading
 * (message, inputs and severity), because the cause can change between nights.
 * `fired_at` still dates the onset; `occurrences`/`lastObservedAt` carry how
 * long it has run. Served-layer guards file at `warn`; a home page that does not
 * answer files at `error`, and an open flag takes the severity of the check
 * that refreshes it.
 */
async function fireHygieneFlag(
  env: IngestEnv,
  asset: string,
  ruleId: string,
  check: HygieneCheckId,
  message: string,
  inputs: Record<string, unknown>,
  at: string,
  severity: 'warn' | 'error' = 'warn',
): Promise<HygieneFlagWrite> {
  // One transaction holds the condition: read the open alert as its newest
  // reading states it, then raise one or append tonight's reading.
  return env.STORE.write(async (tx) => {
    await holdCondition(tx, asset, ruleId);
    const open = await readOpenAlert(tx, asset, ruleId);

    const bookkeeping: HygieneFlagBookkeeping = {
      rule: ruleId,
      check,
      occurrences: priorOccurrences(open?.ruleInputs) + 1,
      lastObservedAt: at,
      evaluatedAt: at,
    };
    const serialized = JSON.stringify({ ...bookkeeping, ...inputs });

    if (open) {
      const refreshed = await appendReadingToOpen(tx, asset, ruleId, {
        observedAt: null,
        severity,
        message,
        ruleInputs: serialized,
      });
      return { fired: 0, refreshed };
    }

    const flagId = await raiseAlertUnlessOpen(tx, {
      asset,
      firedAt: at,
      severity,
      kind: 'anomaly',
      metric: check,
      message,
      ruleId,
      ruleInputs: serialized,
    });
    return { fired: flagId === null ? 0 : 1, refreshed: 0 };
  });
}

/**
 * A clean reading closes the open flag: the condition is a live property of the
 * served bytes, so once they are healthy the alert has no subject.
 */
async function resolveHygieneFlag(
  env: IngestEnv,
  asset: string,
  ruleId: string,
  at: string,
): Promise<number> {
  return env.STORE.write((tx) => resolveOpen(tx, asset, ruleId, at));
}

// --- the sweep --------------------------------------------------------------

export interface HygieneAsset {
  asset: string;
  domain: string;
}

export interface HygieneCheckOutcome {
  asset: string;
  check: HygieneCheckId;
  status: HygieneStatus;
  /** The stored `value_num` — word count, URL count, pages read, or null. */
  value: number | null;
  fired: number;
  refreshed: number;
  resolved: number;
  /** Set when the check itself threw; the reading is then not stored. */
  error?: string;
}

export interface HygieneRunResult {
  assets: number;
  checks: number;
  fired: number;
  refreshed: number;
  resolved: number;
  outcomes: HygieneCheckOutcome[];
  failed: { asset: string; check: HygieneCheckId; error: string }[];
  /** What the run's egress gate concluded, outside the `fired`/`resolved`
   * totals: those count alerts about properties, this one is about the OS. */
  egress: EgressRunOutcome;
}

export interface HygieneOptions {
  /** Override the eligible-asset query (tests inject their own properties). */
  assets?: HygieneAsset[];
  /** Override the outbound fetcher (tests stub the origin's responses). */
  fetchImpl?: typeof fetch;
  nowMs?: number;
  /** Override the run's egress gate (tests control the verdict TTL). */
  egress?: EgressGate;
  /** How long a failed home page waits for its confirming retry; default
   * {@link HOME_CONFIRM_WAIT_MS}. */
  confirmWaitMs?: number;
}

/**
 * How long a home page whose GET failed waits before the one retry that
 * confirms it: a transient 5xx or a deploy is over within it, a site that is
 * really down still is. The run waits once, for every such site, after every
 * other site is read.
 */
export const HOME_CONFIRM_WAIT_MS = 45_000;

/** A home page whose first GET this run failed, owed its confirming retry. */
interface UnconfirmedHome {
  entry: HygieneAsset;
  firstTry: FetchOutcome;
}

/** Which GET of a home page this is: the run's first, whose failure is held
 * for the retry, or the retry itself, whose failure is the site's. */
type HomeAttempt = { retryOwed: UnconfirmedHome[] } | { firstTry: FetchOutcome };

/** A timer, so the tests drive it with fake timers. */
function waitMs(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * After one wait, ask each home page whose first GET failed once more. Its
 * answer is the reading; a retry with no answer asks the egress gate as the
 * first GET would have.
 */
async function confirmHomeFailures(
  env: IngestEnv,
  unconfirmed: UnconfirmedHome[],
  fetchImpl: typeof fetch,
  gate: EgressGate,
  at: string,
  today: string,
  waitForMs: number,
): Promise<{ outcomes: HygieneCheckOutcome[]; failed: { asset: string; error: string }[] }> {
  const outcomes: HygieneCheckOutcome[] = [];
  const failed: { asset: string; error: string }[] = [];
  if (unconfirmed.length === 0) return { outcomes, failed };
  await waitMs(waitForMs);
  for (const { entry, firstTry } of unconfirmed) {
    try {
      const outcome = await checkHtmlDepth(env, entry, fetchImpl, gate, at, today, { firstTry });
      if (outcome) outcomes.push(outcome);
    } catch (error) {
      failed.push({ asset: entry.asset, error: error instanceof Error ? error.message.slice(0, 500) : String(error) });
    }
  }
  return { outcomes, failed };
}

/**
 * Every property whose served layer this OS can check: it has a domain, it is
 * not retired, and it is not asset #0 (the cockpit has no crawl surface, and
 * including it would mean a permanent "no sitemap" warn). Pre-launch
 * properties are included: that is where a robots block sits unnoticed.
 */
async function eligibleAssets(env: IngestEnv): Promise<HygieneAsset[]> {
  // The assets table's CHECK already refuses an empty domain.
  return env.STORE.read((tx) =>
    tx.query<{ asset: string; domain: string }>(
      `SELECT asset_id AS asset, domain
         FROM noticeos.assets
        WHERE domain IS NOT NULL
          AND status <> 'retired'
          AND NOT is_os
        ORDER BY asset_id COLLATE "C"`,
    ),
  );
}

/**
 * html-depth: fetch the home page, count words of visible text, and flag when
 * today's count has collapsed against the property's own trailing median. The
 * rule stays unarmed below {@link DEPTH_MIN_READINGS} prior readings.
 *
 * A home page that fails to load records a NULL count and no depth flag; it is
 * instead the trigger for {@link HOME_UNREACHABLE_RULE_ID}, fired here because
 * this check already fetches the page. On the run's first GET such a failure is
 * only held (`attempt.retryOwed`, returns null); only the confirming retry
 * ({@link confirmHomeFailures}) writes the failing reading and files the alert.
 */
async function checkHtmlDepth(
  env: IngestEnv,
  entry: HygieneAsset,
  fetchImpl: typeof fetch,
  gate: EgressGate,
  at: string,
  today: string,
  attempt: HomeAttempt,
): Promise<HygieneCheckOutcome | null> {
  const url = `https://${entry.domain}/`;
  const response = await fetchDoc(fetchImpl, url, 'text/html');
  const firstTry = 'firstTry' in attempt ? attempt.firstTry : null;

  if (!response.ok) {
    const status: HygieneStatus = response.status === null ? 'unreachable' : 'error';
    // A 200 we declined to read (byte ceiling, undecodable content type) is
    // our limit, not the property's failure: record the reading, accuse nobody.
    const oursNotTheirs = response.status === 200;
    // A fetch with no status at all might be the OS's own uplink. Any status
    // skips the question: it proves the request got out.
    const egressDown = response.status === null && (await gate.isDown());
    if (!oursNotTheirs && !egressDown && 'retryOwed' in attempt) {
      attempt.retryOwed.push({ entry, firstTry: response });
      return null;
    }
    const detail = {
      url,
      http_status: response.status,
      error: response.error,
      ...(oursNotTheirs ? { unsupported: true } : {}),
      ...(egressDown ? { egress_down: true } : {}),
      // Two GETs, the confirmed failure's pair.
      ...(oursNotTheirs || egressDown ? {} : { failed_tries: 2 }),
    };
    await writeReading(env, entry.asset, 'html-depth', at, status, null, detail);
    if (oursNotTheirs || egressDown) {
      // No flag, and no retraction either: "we did not measure it" is never
      // grounds for withdrawing an alert we already made.
      if (egressDown) gate.recordUnmeasured(entry.asset);
      return { asset: entry.asset, check: 'html-depth', status, value: null, fired: 0, refreshed: 0, resolved: 0 };
    }

    const { fired, refreshed } = await fireHygieneFlag(
      env,
      entry.asset,
      HOME_UNREACHABLE_RULE_ID,
      'html-depth',
      status === 'unreachable'
        ? `home page unreachable at ${url} (${response.error ?? 'no response'})`
        : `home page did not serve: ${url} answered HTTP ${response.status}`,
      { ...detail, reading_status: status },
      at,
      'error',
    );
    return { asset: entry.asset, check: 'html-depth', status, value: null, fired, refreshed, resolved: 0 };
  }

  const words = countVisibleWords(response.body);
  const history = await priorReadings(env, entry.asset, 'html-depth', today, DEPTH_BASELINE_WINDOW, true);
  const baselineValues = history
    .map((reading) => reading.value_num)
    .filter((value): value is number => typeof value === 'number');

  const armed = baselineValues.length >= DEPTH_MIN_READINGS;
  const baseline = armed ? median(baselineValues) : null;
  const collapsed = baseline !== null && baseline > 0 && words <= baseline * DEPTH_COLLAPSE_RATIO;

  const detail = {
    url,
    http_status: response.status,
    bytes: response.bytes,
    words,
    baseline_median: baseline,
    baseline_readings: baselineValues.length,
    baseline_min_readings: DEPTH_MIN_READINGS,
    armed,
    // It answered the retry: up, with the one failed try on the record.
    ...(firstTry ? { failed_tries: 1, first_try_http_status: firstTry.status } : {}),
  };
  await writeReading(env, entry.asset, 'html-depth', at, collapsed ? 'warn' : 'ok', words, detail);

  // A body we counted proves reachability whatever the depth rule concludes and
  // whether or not it is armed, so this retraction is unconditional.
  const reachable = await resolveHygieneFlag(env, entry.asset, HOME_UNREACHABLE_RULE_ID, at);

  if (!collapsed) {
    // Only an armed, healthy reading retracts an open flag: while unarmed we
    // have not judged the page.
    const resolved = armed ? await resolveHygieneFlag(env, entry.asset, HTML_DEPTH_RULE_ID, at) : 0;
    return {
      asset: entry.asset,
      check: 'html-depth',
      status: 'ok',
      value: words,
      fired: 0,
      refreshed: 0,
      resolved: resolved + reachable,
    };
  }

  const { fired, refreshed } = await fireHygieneFlag(
    env,
    entry.asset,
    HTML_DEPTH_RULE_ID,
    'html-depth',
    // Values only: the Tower draws the headline and evidence rows from the inputs.
    `home page HTML fell to ${words} words (median ${baseline!})`,
    { ...detail, threshold_ratio: DEPTH_COLLAPSE_RATIO },
    at,
  );
  return {
    asset: entry.asset,
    check: 'html-depth',
    status: 'warn',
    value: words,
    fired,
    refreshed,
    resolved: reachable,
  };
}

/** One sampled page's directive reading, as the check stores and re-reads it. */
interface PageReading {
  url: string;
  http_status: number | null;
  /** Every directive found, agent-qualified — the evidence, not just the verdict. */
  directives: string[];
  /** The subset that closes the page. Empty is the only thing that means "clean". */
  blocking: string[];
  /** `meta-robots`, `x-robots-tag`, or both. */
  sources: string[];
  /** False when there was nothing to read: UNKNOWN, which is never clean. */
  read: boolean;
  error?: string;
  /** The structural facts from the same bytes. Present only when the page was
   * read: a page we could not fetch has no structure, as opposed to none. */
  structure?: PageStructure;
  /** The structural faults, if any. Empty means clean; absent means unread. */
  faults?: string[];
}

/** Fetch each sampled page and resolve its directives. Never throws. */
async function samplePageDirectives(fetchImpl: typeof fetch, urls: string[]): Promise<PageReading[]> {
  const readings: PageReading[] = [];
  for (const url of urls) {
    const response = await fetchDoc(fetchImpl, url, 'text/html');
    if (!response.ok) {
      readings.push({
        url,
        http_status: response.status,
        directives: [],
        blocking: [],
        sources: [],
        read: false,
        ...(response.error !== undefined ? { error: response.error } : {}),
      });
      continue;
    }
    const parsed = parsePageDirectives(response.body, response.xRobotsTag);
    const agentScoped = Object.entries(parsed.byAgent).flatMap(([agent, directives]) =>
      directives.map((directive) => `${agent}:${directive}`),
    );
    // The structural parse rides the fetch the directive check already paid for.
    const structure = parsePageStructure(response.body, url);
    readings.push({
      url,
      http_status: response.status,
      directives: [...parsed.all, ...agentScoped].sort(),
      blocking: blockingDirectives(parsed),
      sources: parsed.sources,
      read: true,
      structure,
      faults: structureFaults(structure),
    });
  }
  return readings;
}

/**
 * robots-ai-access: the site-level `robots.txt`, and `<meta name="robots">` /
 * `X-Robots-Tag` on a stable sample of real pages. Two rule ids, one reading.
 *
 * Only transitions flag, and only in the bad direction: the first reading of a
 * URL or a robots.txt establishes the map and can never fire. The transition is
 * measured against last night's reading while continuation is measured against
 * the open flag, or night three of a block would look like night one of health
 * and the guard would resolve its own alert. The page half is a sample and says
 * so: it never claims the property is clean.
 */
async function checkRobotsAiAccess(
  env: IngestEnv,
  entry: HygieneAsset,
  robots: FetchOutcome,
  roster: PageRoster,
  sample: PageSample,
  fetchImpl: typeof fetch,
  gate: EgressGate,
  at: string,
  today: string,
): Promise<HygieneCheckOutcome> {
  const [previous] = await priorReadings(env, entry.asset, 'robots-ai-access', today, 1);
  let previousDetail: {
    present?: boolean;
    bots?: Record<string, boolean>;
    hash?: string;
    pages?: PageReading[];
  } = {};
  if (previous) {
    try {
      previousDetail = JSON.parse(previous.detail_json) as typeof previousDetail;
    } catch {
      previousDetail = {};
    }
  }

  const present = robots.ok;
  // "robots.txt is no longer served" is this lane's loudest claim: an absence
  // proves nothing when the request never left the house.
  const egressDown = !present && robots.status === null && (await gate.isDown());
  const bots = present ? resolveWatchedBots(parseRobotsGroups(robots.body)) : {};
  const hash = present ? await sha256Hex(robots.body) : null;

  const sampled = stableSample(roster.urls, PAGE_SAMPLE_SIZE);
  const pages = await samplePageDirectives(fetchImpl, sampled);
  // Hand the fetched documents on: `page-structure` asks a second question of
  // these exact bytes.
  sample.pages = pages;
  sample.source = roster.source;
  sample.egressDown = egressDown;
  const detail = {
    url: robots.url,
    http_status: robots.status,
    present,
    hash,
    bots,
    pages,
    pages_sampled: pages.length,
    pages_available: roster.urls.length,
    pages_source: roster.source,
    ...(robots.error !== undefined ? { error: robots.error } : {}),
    ...(egressDown ? { egress_down: true } : {}),
  };

  // --- site level ---
  const openInputs = await openFlagInputs(env, entry.asset, ROBOTS_AI_RULE_ID);
  const alreadyFlaggedLost = Array.isArray(openInputs?.lost_bots)
    ? (openInputs.lost_bots as unknown[]).filter((bot): bot is string => typeof bot === 'string')
    : [];

  // Newly lost tonight …
  const newlyLost = present
    ? WATCHED_BOTS.filter((bot) => previousDetail.bots?.[bot] === true && bots[bot] === false)
    : [];
  // … plus anything the open flag already named that is STILL blocked.
  const stillLost = present ? alreadyFlaggedLost.filter((bot) => bots[bot] === false) : [];
  const lost = [...new Set([...newlyLost, ...stillLost])];
  const vanished = !present && (previousDetail.present === true || openInputs?.robots_vanished === true);
  // Under an OS egress outage neither half measured anything: no regression may
  // be declared, and none withdrawn. Forcing both verdicts false is enough, since
  // the retract branches need a served file or a page we read.
  const regression = !egressDown && (vanished || lost.length > 0);

  // --- page level ---
  const previousPages = new Map((previousDetail.pages ?? []).map((page) => [page.url, page]));
  const tonightPages = new Map(pages.map((page) => [page.url, page]));
  const openPageInputs = await openFlagInputs(env, entry.asset, PAGE_DIRECTIVES_RULE_ID);
  const alreadyBlocked = Array.isArray(openPageInputs?.blocked_urls)
    ? (openPageInputs.blocked_urls as unknown[]).filter((url): url is string => typeof url === 'string')
    : [];

  const newlyBlocked = pages
    .filter((page) => {
      if (!page.read || page.blocking.length === 0) return false;
      const before = previousPages.get(page.url);
      return before?.read === true && before.blocking.length === 0;
    })
    .map((page) => page.url);
  // A URL the open flag named is retracted only by proof that it is clean now;
  // not re-reading it is "we did not measure it".
  const unretracted = alreadyBlocked.filter((url) => {
    const tonight = tonightPages.get(url);
    return !(tonight?.read === true && tonight.blocking.length === 0);
  });
  const blockedUrls = [...new Set([...newlyBlocked, ...unretracted])];
  const pageRegression = !egressDown && blockedUrls.length > 0;

  if (egressDown) gate.recordUnmeasured(entry.asset);

  const status: HygieneStatus =
    regression || pageRegression
      ? 'warn'
      : present
        ? 'ok'
        : robots.status === null
          ? 'unreachable'
          : 'error';
  await writeReading(env, entry.asset, 'robots-ai-access', at, status, null, {
    ...detail,
    ...(regression ? { lost_bots: lost, robots_vanished: vanished } : {}),
    ...(pageRegression ? { blocked_urls: blockedUrls } : {}),
  });

  let fired = 0;
  let refreshed = 0;
  let resolved = 0;

  if (regression) {
    // A headline with its values; the bots and the previous file's date ride in
    // the inputs.
    const message = vanished
      ? `robots.txt no longer served (${robots.error ?? `HTTP ${robots.status}`}) · allowed ` +
        `${Object.values(previousDetail.bots ?? {}).filter(Boolean).length} of ${WATCHED_BOTS.length} AI crawlers`
      : `AI crawler access lost: ${lost.join(', ')} newly disallowed by robots.txt`;

    const write = await fireHygieneFlag(
      env,
      entry.asset,
      ROBOTS_AI_RULE_ID,
      'robots-ai-access',
      message,
      {
        ...detail,
        lost_bots: lost,
        robots_vanished: vanished,
        previous_bots: previousDetail.bots ?? null,
        previous_hash: previousDetail.hash ?? null,
        previous_observed_on: previous?.observed_on ?? null,
      },
      at,
    );
    fired += write.fired;
    refreshed += write.refreshed;
  } else if (present) {
    // A first-ever reading of an already-blocking robots.txt fires nothing and
    // resolves nothing; an absent robots.txt never retracts anything.
    resolved += await resolveHygieneFlag(env, entry.asset, ROBOTS_AI_RULE_ID, at);
  }

  if (pageRegression) {
    // The count as the headline; each URL and its directives are in the inputs.
    const write = await fireHygieneFlag(
      env,
      entry.asset,
      PAGE_DIRECTIVES_RULE_ID,
      'robots-ai-access',
      `crawler directives closed ${blockedUrls.length} of ${pages.length} sampled pages`,
      { ...detail, blocked_urls: blockedUrls, previous_observed_on: previous?.observed_on ?? null },
      at,
    );
    fired += write.fired;
    refreshed += write.refreshed;
  } else if (pages.some((page) => page.read)) {
    resolved += await resolveHygieneFlag(env, entry.asset, PAGE_DIRECTIVES_RULE_ID, at);
  }

  return { asset: entry.asset, check: 'robots-ai-access', status, value: null, fired, refreshed, resolved };
}

interface SitemapCount {
  /** URLs counted, or null when the count would be an undercount of unknown size. */
  urls: number | null;
  root: 'urlset' | 'sitemapindex';
  children_found: number;
  children_fetched: number;
  children_capped: boolean;
  children_failed: string[];
  /** Every page URL this traversal saw — the roster the directive check samples. */
  pageUrls: string[];
}

/** Count a fetched sitemap, following one level of <sitemapindex> under the cap. */
async function countSitemapUrls(
  fetchImpl: typeof fetch,
  body: string,
  root: 'urlset' | 'sitemapindex',
): Promise<SitemapCount> {
  const entries = locValues(body);
  if (root === 'urlset') {
    return {
      urls: entries.length,
      root,
      children_found: 0,
      children_fetched: 0,
      children_capped: false,
      children_failed: [],
      pageUrls: entries,
    };
  }

  const children = entries.slice(0, SITEMAP_INDEX_CHILD_CAP);
  const failed: string[] = [];
  const pageUrls: string[] = [];
  let total = 0;
  for (const child of children) {
    const response = await fetchDoc(fetchImpl, child, 'application/xml');
    if (!response.ok || sitemapRoot(response.body) === null) {
      failed.push(child);
      continue;
    }
    const locs = locValues(response.body);
    total += locs.length;
    pageUrls.push(...locs);
  }
  return {
    pageUrls,
    // A child we could not read makes the total an undercount, which is exactly
    // the shape of a collapse: report no number rather than accuse the property.
    urls: failed.length > 0 ? null : total,
    root,
    children_found: entries.length,
    children_fetched: children.length - failed.length,
    children_capped: entries.length > SITEMAP_INDEX_CHILD_CAP,
    children_failed: failed,
  };
}

/**
 * sitemap: resolve it (robots.txt `Sitemap:` lines first, else /sitemap.xml),
 * fetch it, prove it parses, count its URLs, and flag an outage, an unparseable
 * body, or a count at or under half the previous healthy reading when that
 * reading held at least {@link SITEMAP_MIN_PREV_URLS} URLs.
 *
 * Also the roster supplier: it fills `roster` on its way past and runs first for
 * that reason. A failed sitemap leaves the roster empty, which the directive
 * check records as "sampled nothing", never "nothing is wrong".
 */
async function checkSitemap(
  env: IngestEnv,
  entry: HygieneAsset,
  robots: FetchOutcome,
  roster: PageRoster,
  fetchImpl: typeof fetch,
  gate: EgressGate,
  at: string,
  today: string,
): Promise<HygieneCheckOutcome> {
  const declared = robots.ok ? sitemapUrlsFromRobots(robots.body) : [];
  const url = declared[0] ?? `https://${entry.domain}/sitemap.xml`;
  const source = declared.length > 0 ? 'robots.txt' : 'convention';
  const response = await fetchDoc(fetchImpl, url, 'application/xml');

  const base = {
    url,
    source,
    declared_in_robots: declared,
    http_status: response.status,
  };

  const fail = async (
    status: HygieneStatus,
    reason: string,
    message: string,
    detail: Record<string, unknown>,
  ): Promise<HygieneCheckOutcome> => {
    await writeReading(env, entry.asset, 'sitemap', at, status, null, { ...base, ...detail, reason });
    const { fired, refreshed } = await fireHygieneFlag(
      env,
      entry.asset,
      SITEMAP_RULE_ID,
      'sitemap',
      message,
      { ...base, ...detail, reason },
      at,
    );
    return { asset: entry.asset, check: 'sitemap', status, value: null, fired, refreshed, resolved: 0 };
  };

  // A gzipped sitemap is legal and unreadable here: record the gap, do not
  // flag. Checked before the transport failure below because it is ours.
  if (isUnreadableSitemap(response)) {
    await writeReading(env, entry.asset, 'sitemap', at, 'error', null, {
      ...base,
      reason: 'unsupported-encoding',
      unsupported: true,
      content_type: response.contentType,
    });
    return { asset: entry.asset, check: 'sitemap', status: 'error', value: null, fired: 0, refreshed: 0, resolved: 0 };
  }

  if (!response.ok) {
    const status: HygieneStatus = response.status === null ? 'unreachable' : 'error';
    // Only a statusless fetch is ambiguous: a 404 sitemap is still a 404 sitemap.
    if (response.status === null && (await gate.isDown())) {
      await writeReading(env, entry.asset, 'sitemap', at, status, null, {
        ...base,
        reason: 'unreachable',
        error: response.error ?? null,
        egress_down: true,
      });
      gate.recordUnmeasured(entry.asset);
      return { asset: entry.asset, check: 'sitemap', status, value: null, fired: 0, refreshed: 0, resolved: 0 };
    }
    return fail(
      status,
      'unreachable',
      `sitemap unreachable at ${url} (${response.error ?? `HTTP ${response.status}`})`,
      { error: response.error ?? null },
    );
  }

  const root = sitemapRoot(response.body);
  if (root === null) {
    return fail('error', 'unparseable', `sitemap at ${url} is not parseable XML (no <urlset>/<sitemapindex> root)`, {
      bytes: response.bytes,
      content_type: response.contentType,
    });
  }

  // `pageUrls` is the roster and never the reading: detail_json must not carry a
  // copy of a 4,000-page sitemap.
  const { pageUrls, ...counted } = await countSitemapUrls(fetchImpl, response.body, root);
  roster.urls = pageUrls;
  roster.source = 'sitemap';

  if (counted.urls === null) {
    // Not egress-gated: the parent fetch succeeded moments ago, which is proof
    // the OS could reach this origin.
    return fail(
      'error',
      'child-unreachable',
      `${counted.children_failed.length} child sitemaps unreadable (first: ${counted.children_failed[0]})`,
      { ...counted },
    );
  }

  // The comparator is the last healthy count, not yesterday's row: a sitemap
  // that stayed collapsed would otherwise match itself and resolve the flag.
  const [previous] = await priorReadings(env, entry.asset, 'sitemap', today, 1, true);
  const previousCount = typeof previous?.value_num === 'number' ? previous.value_num : null;
  const comparable = previousCount !== null && previousCount >= SITEMAP_MIN_PREV_URLS;
  const collapsed = comparable && counted.urls <= previousCount * SITEMAP_COLLAPSE_RATIO;

  const detail = {
    ...base,
    ...counted,
    previous_urls: previousCount,
    previous_observed_on: previous?.observed_on ?? null,
    min_previous_urls: SITEMAP_MIN_PREV_URLS,
  };
  await writeReading(env, entry.asset, 'sitemap', at, collapsed ? 'warn' : 'ok', counted.urls, detail);

  if (!collapsed) {
    const resolved = await resolveHygieneFlag(env, entry.asset, SITEMAP_RULE_ID, at);
    return { asset: entry.asset, check: 'sitemap', status: 'ok', value: counted.urls, fired: 0, refreshed: 0, resolved };
  }

  const { fired, refreshed } = await fireHygieneFlag(
    env,
    entry.asset,
    SITEMAP_RULE_ID,
    'sitemap',
    `sitemap URL count collapsed: ${counted.urls} URLs vs ${previousCount} on ${previous?.observed_on}`,
    { ...detail, threshold_ratio: SITEMAP_COLLAPSE_RATIO, reason: 'count-collapse' },
    at,
  );
  return { asset: entry.asset, check: 'sitemap', status: 'warn', value: counted.urls, fired, refreshed, resolved: 0 };
}

/**
 * The property's real pages, as one check hands them to another: `checkSitemap`
 * fills it, `checkRobotsAiAccess` samples from it. `source` is `'none'` when the
 * sitemap never produced one, which differs from an empty property.
 */
interface PageRoster {
  urls: string[];
  source: 'sitemap' | 'none';
}

/**
 * The page sample, handed from the check that fetched it to the check that asks
 * a second question of it, so a served page is fetched once per night and two
 * answers cannot disagree about a page that changed between them.
 */
interface PageSample {
  pages: PageReading[];
  /** Carried so the second check can say "sampled nothing because the sitemap
   * failed" rather than "nothing wrong". */
  source: PageRoster['source'];
  /** The OS itself could not get out: nothing may be declared or withdrawn. */
  egressDown: boolean;
}

/**
 * page-structure: the four structural facts on the sampled pages. Fetches
 * nothing: it asks a second question of the bytes {@link checkRobotsAiAccess}
 * read, so it runs last. Only transitions fire: the first reading of a URL
 * establishes the baseline and can never flag. It reports the fault and stops
 * short of ranking it; that triage needs traffic evidence this lane lacks.
 */
async function checkPageStructure(
  env: IngestEnv,
  entry: HygieneAsset,
  sample: PageSample,
  gate: EgressGate,
  at: string,
  today: string,
): Promise<HygieneCheckOutcome> {
  const [previous] = await priorReadings(env, entry.asset, 'page-structure', today, 1);
  let previousPagesList: PageReading[] = [];
  if (previous) {
    try {
      previousPagesList =
        (JSON.parse(previous.detail_json) as { pages?: PageReading[] }).pages ?? [];
    } catch {
      previousPagesList = [];
    }
  }

  const pages = sample.pages;
  const readable = pages.filter((page) => page.read);
  const detail = {
    pages,
    pages_sampled: pages.length,
    pages_read: readable.length,
    pages_source: sample.source,
    ...(sample.egressDown ? { egress_down: true } : {}),
  };

  const previousPages = new Map(previousPagesList.map((page) => [page.url, page]));
  const tonightPages = new Map(pages.map((page) => [page.url, page]));
  const openInputs = await openFlagInputs(env, entry.asset, PAGE_STRUCTURE_RULE_ID);
  const alreadyFaulty = Array.isArray(openInputs?.faulty_urls)
    ? (openInputs.faulty_urls as unknown[]).filter((url): url is string => typeof url === 'string')
    : [];

  // A fault is new only when the same URL read clean last night; no prior
  // reading means no transition.
  const newlyFaulty = pages
    .filter((page) => {
      if (!page.read || (page.faults ?? []).length === 0) return false;
      const before = previousPages.get(page.url);
      return before?.read === true && (before.faults ?? []).length === 0;
    })
    .map((page) => page.url);
  // A URL the open flag named is retracted only by proof that it is clean now.
  const unretracted = alreadyFaulty.filter((url) => {
    const tonight = tonightPages.get(url);
    return !(tonight?.read === true && (tonight.faults ?? []).length === 0);
  });
  const faultyUrls = [...new Set([...newlyFaulty, ...unretracted])];
  // Under an OS egress outage nothing was measured: no regression may be
  // declared, and none may be withdrawn.
  const regression = !sample.egressDown && faultyUrls.length > 0;

  const status: HygieneStatus = regression
    ? 'warn'
    : readable.length > 0
      ? 'ok'
      : // Nothing to read is unknown, not clean.
        'unreachable';

  await writeReading(env, entry.asset, 'page-structure', at, status, readable.length, {
    ...detail,
    ...(regression ? { faulty_urls: faultyUrls } : {}),
  });

  let fired = 0;
  let refreshed = 0;
  let resolved = 0;

  if (regression) {
    // The count as the headline; each URL and its faults are in the inputs.
    const write = await fireHygieneFlag(
      env,
      entry.asset,
      PAGE_STRUCTURE_RULE_ID,
      'page-structure',
      `page structure regressed on ${faultyUrls.length} of ${pages.length} sampled pages`,
      { ...detail, faulty_urls: faultyUrls, previous_observed_on: previous?.observed_on ?? null },
      at,
    );
    fired += write.fired;
    refreshed += write.refreshed;
  } else if (readable.length > 0) {
    resolved += await resolveHygieneFlag(env, entry.asset, PAGE_STRUCTURE_RULE_ID, at);
  }

  return {
    asset: entry.asset,
    check: 'page-structure',
    status,
    // How many pages were read: the denominator behind every claim. Zero is a
    // real reading, which is why the status beside it is 'unreachable'.
    value: readable.length,
    fired,
    refreshed,
    resolved,
  };
}

export async function runHygieneChecks(
  env: IngestEnv,
  opts: HygieneOptions = {},
): Promise<HygieneRunResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const nowMs = opts.nowMs ?? Date.now();
  const at = new Date(nowMs).toISOString();
  const today = at.slice(0, 10);
  const entries = opts.assets ?? (await eligibleAssets(env));
  // One gate for the whole sweep: six dead properties are one outage, and the
  // set of properties it cost is what the flag at the end counts.
  const gate = opts.egress ?? new EgressGate(env, { lane: 'hygiene', fetchImpl, at });

  const result: HygieneRunResult = {
    assets: entries.length,
    checks: 0,
    fired: 0,
    refreshed: 0,
    resolved: 0,
    outcomes: [],
    failed: [],
    egress: { checked: false, up: null, probes: 0, fired: 0, refreshed: 0, resolved: 0, unmeasuredAssets: [] },
  };
  const count = (outcome: HygieneCheckOutcome) => {
    result.outcomes.push(outcome);
    result.checks += 1;
    result.fired += outcome.fired;
    result.refreshed += outcome.refreshed;
    result.resolved += outcome.resolved;
  };
  // Home pages whose first GET failed are asked again once, after every site.
  const retryOwed: UnconfirmedHome[] = [];

  for (const entry of entries) {
    const robots = await fetchDoc(fetchImpl, `https://${entry.domain}/robots.txt`, 'text/plain');

    const roster: PageRoster = { urls: [], source: 'none' };
    // Filled by the directive check and read by the structure check, so the
    // order below is load-bearing.
    const sample: PageSample = { pages: [], source: 'none', egressDown: false };

    const checks: [HygieneCheckId, () => Promise<HygieneCheckOutcome | null>][] = [
      ['sitemap', () => checkSitemap(env, entry, robots, roster, fetchImpl, gate, at, today)],
      ['html-depth', () => checkHtmlDepth(env, entry, fetchImpl, gate, at, today, { retryOwed })],
      ['robots-ai-access', () => checkRobotsAiAccess(env, entry, robots, roster, sample, fetchImpl, gate, at, today)],
      ['page-structure', () => checkPageStructure(env, entry, sample, gate, at, today)],
    ];

    for (const [check, run] of checks) {
      try {
        const outcome = await run();
        if (outcome) count(outcome);
      } catch (error) {
        result.failed.push({
          asset: entry.asset,
          check,
          error: error instanceof Error ? error.message.slice(0, 500) : String(error),
        });
      }
    }
  }

  const confirmed = await confirmHomeFailures(
    env, retryOwed, fetchImpl, gate, at, today, opts.confirmWaitMs ?? HOME_CONFIRM_WAIT_MS,
  );
  for (const outcome of confirmed.outcomes) count(outcome);
  for (const failure of confirmed.failed) result.failed.push({ ...failure, check: 'html-depth' });

  result.egress = await gate.finalize();
  return result;
}

// --- uptime: the home-page check, hourly ------------------------------------

/**
 * A home-page reading younger than this is the check this hour would make, so
 * the nightly sweep and the hourly tick firing together ask the site once.
 */
export const UPTIME_FRESH_MS = 30 * 60_000;

export interface UptimeRunResult {
  assets: number;
  /** Sites whose home page this run fetched. */
  checked: number;
  /** Sites skipped because a reading younger than {@link UPTIME_FRESH_MS} stands. */
  skipped: number;
  /** Sites whose first GET failed and were asked once more. */
  retried: number;
  fired: number;
  refreshed: number;
  resolved: number;
  failed: { asset: string; error: string }[];
  egress: EgressRunOutcome;
}

/** The newest home-page reading's instant for one site, or null. */
async function latestHomeReadingAt(env: IngestEnv, asset: string): Promise<string | null> {
  const [row] = await env.STORE.read((tx) =>
    tx.query<{ observedAt: string }>(
      `SELECT observed_at AS "observedAt" FROM noticeos.hygiene_checks
        WHERE asset_id = $1 AND check_id = 'html-depth'
        ORDER BY observed_on DESC LIMIT 1`,
      [asset],
    ),
  );
  return row ? javascriptInstant(row.observedAt) : null;
}

/**
 * Is each site up: the nightly sweep's own home-page check
 * ({@link checkHtmlDepth}) run on the hourly tick, with the same reading (the
 * hour's check replaces the day's row), the same {@link HOME_UNREACHABLE_RULE_ID}
 * flag and the same egress gate, so there is no second monitor to disagree with
 * it. The other checks stay nightly: they guard slow declines and cost several
 * requests a site.
 */
export async function runUptimeChecks(
  env: IngestEnv,
  opts: HygieneOptions = {},
): Promise<UptimeRunResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const nowMs = opts.nowMs ?? Date.now();
  const at = new Date(nowMs).toISOString();
  const today = at.slice(0, 10);
  const entries = opts.assets ?? (await eligibleAssets(env));
  const gate = opts.egress ?? new EgressGate(env, { lane: 'uptime', fetchImpl, at });
  const result: UptimeRunResult = {
    assets: entries.length,
    checked: 0,
    skipped: 0,
    retried: 0,
    fired: 0,
    refreshed: 0,
    resolved: 0,
    failed: [],
    egress: { checked: false, up: null, probes: 0, fired: 0, refreshed: 0, resolved: 0, unmeasuredAssets: [] },
  };
  const count = (outcome: HygieneCheckOutcome) => {
    result.fired += outcome.fired;
    result.refreshed += outcome.refreshed;
    result.resolved += outcome.resolved;
  };
  const retryOwed: UnconfirmedHome[] = [];
  for (const entry of entries) {
    try {
      const last = await latestHomeReadingAt(env, entry.asset);
      if (last !== null && nowMs - Date.parse(last) < UPTIME_FRESH_MS) {
        result.skipped += 1;
        continue;
      }
      const outcome = await checkHtmlDepth(env, entry, fetchImpl, gate, at, today, { retryOwed });
      result.checked += 1;
      if (outcome) count(outcome);
    } catch (error) {
      result.failed.push({
        asset: entry.asset,
        error: error instanceof Error ? error.message.slice(0, 500) : String(error),
      });
    }
  }
  result.retried = retryOwed.length;
  const confirmed = await confirmHomeFailures(
    env, retryOwed, fetchImpl, gate, at, today, opts.confirmWaitMs ?? HOME_CONFIRM_WAIT_MS,
  );
  for (const outcome of confirmed.outcomes) count(outcome);
  result.failed.push(...confirmed.failed);
  result.egress = await gate.finalize();
  return result;
}
