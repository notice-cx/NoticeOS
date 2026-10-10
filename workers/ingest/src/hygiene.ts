// Nightly tech/GEO hygiene guards (docs/08 §S5) — the served layer, checked by
// actually fetching it.
//
// Three regressions in this family are invisible to every other lane the OS
// runs, because none of them change a metric until long after they happen:
//
//   1. STATIC DEPTH. AI crawlers do not render JavaScript. One asset's home
//      page served 88 words of static HTML for months while GA4, GSC, and the
//      nightly pulse all stayed green — the page was fine for humans and empty
//      for crawlers, and nothing in the store could have said so.
//   2. AI-CRAWLER ACCESS. Whether OAI-SearchBot, ClaudeBot, or PerplexityBot may
//      read a property is a business input, and it is one robots.txt line away
//      from being revoked by a framework default, a CDN toggle, or a copy-paste.
//   3. SITEMAP. A sitemap that 404s or collapses to a handful of URLs surfaces
//      weeks later as a Search Console notification, i.e. after the damage.
//
// All of them are plain HTTPS GETs against the property's OWN domain: zero API
// quota, zero provider, no credential. The cost of running them nightly is six
// requests per property — three site-level, three sampled real pages — which is
// why they run nightly.
//
// OURS, NOT THEIRS. Every check here accuses a property, so each one first has
// to be sure the failure is the property's. That is why a 200 past the byte
// ceiling records `unsupported` and files nothing, and — since 2026-08-08, when
// this sweep flagged six properties while the house internet was out — why a
// fetch that came back with NO status at all asks src/egress.ts whether the OS
// could reach the network before concluding anything. A real HTTP status never
// asks: it is proof the request got there and back.
//
// WHAT THIS MODULE IS NOT: it is not a crawler and it does not pretend to be
// one. Requests go out under this OS's own honest User-Agent
// (HYGIENE_USER_AGENT). Fetching a property's robots.txt to see whether GPTBot
// is allowed is a different act from fetching a page AS GPTBot, and only the
// first one is something we are entitled to do. A property that serves
// different HTML to crawlers than to us is therefore outside what the
// html-depth check can see — see the limits table in
// workers/ingest/README §"Hygiene guards".

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
 * Reachability of the home page, deliberately a SECOND rule on the same
 * `html-depth` reading rather than a second trigger inside the depth rule.
 *
 * The depth rule's only sanctioned trigger is a median collapse, and an
 * unreachable page is not a zero-word page — so it stores `value_num = NULL` and
 * files nothing. That reasoning is right and it left the loudest failure of all
 * (a 500, a 404, a timeout on a property's front door) reaching the operator
 * only sideways, through the sitemap guard or ingest freshness. Two rule ids
 * cannot double-report the same night because they trigger on disjoint
 * outcomes: depth needs a body it counted, this one needs the absence of one.
 *
 * IT IS ALSO THE SITE'S UPTIME (bead `ro-ujb9.165`). The same check runs every
 * hour ({@link runUptimeChecks}), so a site that stops answering is an `error`
 * alert within the hour rather than the next night, and a site's Data sources
 * reads Up or Down from the reading it stores. One GET, one reading, one rule:
 * no second monitor that could disagree with this one. It files only on a
 * failure the retry confirms (bead `ro-ujb9.180`, {@link HOME_CONFIRM_WAIT_MS}).
 */
export const HOME_UNREACHABLE_RULE_ID = 'hygiene-home-unreachable';
/**
 * Crawler directives found on REAL PAGES rather than in the site-level file:
 * `<meta name="robots">` and `X-Robots-Tag`. A second rule on the
 * `robots-ai-access` check for the same reason the depth check has two: one
 * fetch, two questions. Site-level and page-level blocks are different facts
 * with different fixes — one is a robots.txt line, the other is a template — so
 * an operator should never have to read the message to learn which they have.
 */
export const PAGE_DIRECTIVES_RULE_ID = 'hygiene-page-directives';
/**
 * Structural faults on the sampled pages: a missing `<title>`, a missing meta
 * description, a missing or duplicated `<h1>`, and a canonical that points
 * somewhere else (ro-cda6.5).
 *
 * A FOURTH question on bytes we already have. The page sample is fetched once
 * for {@link PAGE_DIRECTIVES_RULE_ID} and read twice — a served page is one
 * document, and re-fetching it to ask a second question would double the
 * property's nightly request count to learn nothing new.
 *
 * WHY THESE FOUR AND NOT THE TWENTY-FIVE a site-audit tool ships. Each of the
 * three founding S5 checks was born from a real "nobody noticed for months"
 * incident, and that is the bar. These four are the ones with a decision
 * attached and no room to be wrong:
 *
 *   - **no title / no meta description** — the snippet is the click, and
 *     a title and description written against the live result page are the
 *     fix. A page with
 *     impressions and no title is losing the click it already earned.
 *   - **no h1 / several h1** — the page states no subject, or several.
 *   - **canonical elsewhere** — a page canonicalized to another URL cannot
 *     rank, however good it is. The loudest of the four, and the one most often
 *     shipped by accident: a template, a CMS default, a copied `<head>`.
 *
 * DELIBERATELY NOT CHECKED: title and description LENGTH. Google truncates by
 * pixel width, not characters, and rewrites titles at will; "your title is 61
 * characters" is taste with no decision behind it, and a check that fires on
 * taste is a check the operator learns to ignore. Also not checked: image alt
 * text, heading-level skips, and thin content on inner pages — real, but none of
 * them has hurt this portfolio yet, and the register of checks should record
 * incidents rather than a competitor's feature list.
 */
export const PAGE_STRUCTURE_RULE_ID = 'hygiene-page-structure';

/**
 * The bots whose access is a business input for this portfolio: the three AI
 * search crawlers docs/08 names, their sibling training/user agents, Google's
 * AI-training opt-out token, and Bing (whose index feeds ChatGPT search). A bot
 * absent from this list is simply not watched — the check reports on exactly
 * these names and claims nothing about the rest of the file.
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
 * Who we say we are. Honest identification, with a contact URL, exactly as we
 * would want a third party fetching our properties to identify itself. It is
 * deliberately NOT any crawler's token: impersonating GPTBot to see what GPTBot
 * receives would be lying to the origin about who is asking.
 */
export const HYGIENE_USER_AGENT =
  'NoticeOS-Hygiene/1.0 (+https://www.notice.cx; portfolio self-check)';

/** Per-request ceiling. Three requests per property, so a slow origin costs a
 * bounded amount of the nightly slot rather than the whole sweep. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Response byte ceiling — a home page or sitemap far past this is not a
 * document we should be word-counting inside a Worker's memory. */
const RESPONSE_BYTE_LIMIT = 8 * 1024 * 1024;

/** How many prior READINGS feed the html-depth median (see `depthBaseline`). */
const DEPTH_BASELINE_WINDOW = 14;
/** Below this many prior readings the depth rule stays unarmed — never flag on
 * sparse history (docs/14-design.md § Operator flows: rules arm after baselining, not before). */
const DEPTH_MIN_READINGS = 7;
/** Today must be at or under this share of the baseline median to flag. */
const DEPTH_COLLAPSE_RATIO = 0.5;

/** Same shape for sitemaps: today at or under half of the previous count … */
const SITEMAP_COLLAPSE_RATIO = 0.5;
/** … but only when the previous count was big enough for -50% to mean anything.
 * A property going 6 → 3 URLs is noise; 4,000 → 40 is an outage. */
const SITEMAP_MIN_PREV_URLS = 50;
/**
 * A <sitemapindex> is followed ONE level deep and at most this many children.
 * Large properties shard into hundreds of child sitemaps and fetching all of
 * them would turn a three-request check into a crawl of our own origin. Past
 * the cap the stored count is an explicit floor (`children_capped: true`), and
 * because the cap is constant the collapse comparison is still floor-to-floor.
 */
const SITEMAP_INDEX_CHILD_CAP = 10;

/**
 * How many REAL pages the directive check samples per property per night, on top
 * of the three site-level requests. The roster is the sitemap the sweep already
 * fetched — no new config, no new list to keep true — and the sample is stable
 * (see {@link stableSample}) so the same pages come back night after night.
 *
 * Three is the budget, not a coverage claim: this check says "these pages are
 * clean", never "the property is clean". The cost of getting that wrong is a
 * property's whole nightly slot spent crawling our own origin.
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
  /**
   * `X-Robots-Tag`, verbatim. The one response header this lane reads: it is a
   * crawler directive that lives nowhere in the body, so a page can be
   * `noindex` with markup that looks perfectly ordinary.
   */
  xRobotsTag: string | null;
  /** The origin answered with bytes we will not decode as text (gzip, binary). */
  binary?: boolean;
  error?: string;
}

/** Content types we refuse to run through `.text()` — decoding them would produce
 * mojibake and a runtime warning, and every one of them is a document this lane
 * cannot read anyway. */
const BINARY_CONTENT_TYPE = /gzip|zip|octet-stream/i;

/**
 * One hygiene GET. Never throws: every failure mode becomes an outcome, because
 * "the origin refused" and "we could not reach the origin" are both readings
 * this lane wants to store, not exceptions that would abort a property's sweep.
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
    // An unrecognized named entity is almost always a single glyph inside or
    // between words; dropping it cannot invent a word, whereas substituting a
    // space could split one in two.
    return NAMED_ENTITIES[ref.toLowerCase()] ?? '';
  });
}

/**
 * Words of visible text in served HTML — the number that was 88 on one asset's home page.
 *
 * Deliberately a string transform, not a parser: this must run in a Worker with
 * no dependencies, and the question it answers ("is there prose here at all?")
 * is coarse by nature. It strips comments and never-visible elements, drops the
 * remaining tags, decodes the entities that matter, and counts whitespace-
 * separated tokens containing at least one letter or digit — so `|`, `—`, and
 * `&middot;` separators do not inflate the count.
 *
 * What it does NOT do: execute JavaScript (that is the point — neither do AI
 * crawlers), resolve `<iframe>`/shadow DOM content, or distinguish nav
 * boilerplate from article body. A page whose only words are its own menu will
 * read as having those words; the check catches collapse, not quality.
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
 * One `User-agent:` group, reduced to the only question this check asks: is the
 * whole site closed to the agents in this group?
 *
 * `disallow_all` is `Disallow: /` exactly. `allow_root` is `Allow: /` exactly,
 * tracked because a group carrying both is the documented tie-break case (equal
 * path length resolves to allow), which is how several CMS defaults express
 * "blocked from nothing".
 */
export interface RobotsGroup {
  /** Lower-cased agent tokens this group applies to. */
  agents: string[];
  disallow_all: boolean;
  allow_root: boolean;
}

/**
 * Hand-rolled robots.txt group parser (no dependencies, per the milestone
 * constraint). It is deliberately a SITE-LEVEL detector, and its limits are as
 * load-bearing as its behavior:
 *
 * CATCHES — the regression this check exists for: a named bot (or `*`) acquiring
 * a blanket `Disallow: /`, a bot's group disappearing so it falls back to a
 * blocking `*` group, and robots.txt itself vanishing.
 *
 * DOES NOT CATCH — path-level rules (`Disallow: /recipes/` reads as allowed,
 * because the bot IS still allowed the rest of the site), wildcard/`$` patterns,
 * longest-match precedence between competing rules inside a group, and
 * `crawl-delay` throttling. Adding real longest-match evaluation is only worth it
 * once a property actually ships path-scoped AI rules. `<meta name="robots">`,
 * `X-Robots-Tag`, and per-page `nosnippet`/`noai` are not this parser's job at
 * all — they are per-URL facts, read from sampled pages by
 * {@link parsePageDirectives}.
 *
 * Agent matching is exact (case-insensitive) on the token, not the substring
 * prefix real crawlers use: a group for `Googlebot` does not resolve
 * `Google-Extended`, which is the conservative direction — it can miss a block,
 * never invent one.
 */
export function parseRobotsGroups(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  // Consecutive `User-agent:` lines address ONE group; the first rule line ends
  // the header, so the next `User-agent:` after it starts a new group.
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
 * Directives that take a value rather than naming a user agent. Without this
 * set, `unavailable_after: 2026-01-01T…` in an `X-Robots-Tag` would parse as a
 * user-agent scope called `unavailable_after`.
 */
const VALUED_DIRECTIVES = new Set([
  'unavailable_after',
  'max-snippet',
  'max-image-preview',
  'max-video-preview',
]);

/**
 * The directives that take a page OUT of the surfaces this portfolio is graded
 * on. Deliberately narrower than "every robots directive": `nofollow` and
 * `noarchive` change how a page is treated, `max-image-preview:none` costs a
 * thumbnail — none of them remove the page. These do.
 *
 * `max-snippet:0` is here because it IS `nosnippet` written as a number, and a
 * zero-length snippet is the whole game for an AI answer that quotes you.
 * `noai`/`noimageai` are the emerging opt-out pair; nothing obliges a crawler to
 * honor them, which is exactly why an accidental one must be visible.
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
 * Crawler directives for ONE page: `<meta name="robots">` and any per-agent meta
 * (`<meta name="googlebot">`), plus the `X-Robots-Tag` response header.
 *
 * The header parser scopes by agent the way the header is actually written:
 * `googlebot: noindex, nosnippet` applies BOTH directives to googlebot, so an
 * `agent:` part opens a scope that runs until the next one. That is also its
 * limit — several `X-Robots-Tag` headers arrive here already joined into one
 * comma-separated string, so a bare directive after an agent-scoped header is
 * read as belonging to that agent. Conservative in the direction that matters:
 * it can attribute a block too narrowly, never invent one.
 *
 * Unlike robots.txt this is per-URL by construction, which is the whole point —
 * a `noindex` on one template is invisible to a site-level file.
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
 * The blocking directives on a page, each qualified by the agent it addresses
 * (`noindex`, `googlebot:nosnippet`) so a reading names what an operator would
 * have to go and delete.
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
 * A stable K-of-N sample: the URLs whose FNV-1a hash sorts first.
 *
 * Order-independent and stable under additions, which is what makes the
 * page-directive rule able to accumulate a comparison at all. "The first three
 * `<loc>` entries" would look simpler and be useless: sitemaps are commonly
 * ordered by `lastmod` descending, so the sample would be three different URLs
 * every night, every reading would be a first reading, and a first reading never
 * flags. Hashing means tonight's sample differs from last night's only where the
 * property actually changed.
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


// --- check d: page structure (ro-cda6.5) ------------------------------------

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
 * host case-insensitively, path exactly except for a trailing slash, and query
 * order-insensitively. A canonical that differs only in those respects is
 * self-referential, and calling it "elsewhere" would fire on almost every page
 * on the internet.
 *
 * The fragment is dropped: it never reaches the server and cannot distinguish
 * two documents.
 */
export function sameCanonicalTarget(pageUrl: string, canonical: string): boolean {
  let left: URL;
  let right: URL;
  try {
    left = new URL(pageUrl);
    right = new URL(canonical, pageUrl);
  } catch {
    // An unparseable canonical is not evidence that the page is disclaimed; it
    // is evidence that we could not tell. Treated as self-referential, so the
    // rule stays silent rather than accusing on a string it did not understand.
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
 * Parse the four structural facts out of a served page.
 *
 * Regex rather than a DOM: this runs inside a Worker on up to
 * `RESPONSE_BYTE_LIMIT` of HTML, and the questions are shallow enough that a
 * parser would be weight without accuracy. Where a regex genuinely cannot be
 * sure it returns null, which reads as "not measured" and never as "absent".
 */
export function parsePageStructure(html: string, pageUrl: string): PageStructure {
  const titleMatch = TITLE_TAG.exec(html);
  const rawTitle = titleMatch ? decodeEntities(titleMatch[1] ?? '').trim() : '';
  // An empty <title></title> is the same fact as no title at all — the SERP has
  // nothing to print either way — so both resolve to null rather than to ''.
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

/**
 * The structural faults on one page, as an operator would name them. Empty is
 * the only thing that means clean.
 */
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
 * The document's root element, or null when this is not a sitemap at all — the
 * common failure being an origin that answers /sitemap.xml with its 200 HTML
 * error page. Requires the closing tag too, so a truncated response is
 * unparseable rather than silently short.
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
 * Gzipped sitemaps are legal and common, and we cannot read one — either the
 * origin told us so in the content type (`binary`), or it served a `.gz` URL
 * with a 200 and some content type we would have mis-parsed. A NON-200 on a
 * `.gz` URL is not this case: that is an ordinary outage and is flagged as one.
 */
function isUnreadableSitemap(outcome: FetchOutcome): boolean {
  return outcome.binary === true || (outcome.ok && /\.gz(\?|$)/i.test(outcome.url));
}

// --- stored history ---------------------------------------------------------
//
// On Postgres, `noticeos.hygiene_checks`, through the call's store (bead
// ro-ujb9.76.5.8). The flags these checks file are other statements.

type HygieneReading = {
  observed_on: string;
  observed_at: string;
  status: HygieneStatus;
  value_num: number | null;
  detail_json: string;
};

/**
 * Prior readings for one check, newest first, strictly before today.
 *
 * The window is the last N READINGS rather than the last N calendar days: a
 * night the cron did not run should make the baseline older, not smaller.
 * Shrinking it would be the wrong direction — a thinner baseline is exactly
 * when a median is easiest to trip.
 *
 * `healthyOnly` is the comparison baseline the two count rules use, and it is
 * load-bearing. A regression that persists must not become its own baseline: a
 * fortnight of 88-word home pages would otherwise drag the median down to 88,
 * stop matching the collapse test, and RESOLVE the very flag describing it —
 * the store would quietly redefine normal as broken. Comparing only against
 * readings the check considered healthy means a standing regression keeps
 * alerting until the bytes recover or an operator dispositions the flag (which
 * is what disposition is for, docs/14-design.md § Operator flows).
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

/** The open flag's stored inputs for one guard, so an ONGOING condition can be
 * told apart from a fresh one (see `checkRobotsAiAccess`). */
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

/** Upsert today's reading (see the migration's grain note on same-day re-runs). */
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
 * File a hygiene flag, mirroring `asset-pull-failed` (src/pull.ts) exactly —
 * because it is the same shape of fact: an ONGOING condition observed once a
 * night. A hygiene regression that lasts a fortnight is one problem, not
 * fourteen, so the first night INSERTs (guarded by NOT EXISTS against an open
 * flag with the same rule) and every night after becomes that open alert's
 * newest reading (message, inputs and severity; `noticeos.flag_evidence`).
 * Recording rather than dropping matters: the cause can
 * change between nights (a sitemap that 404s on Monday and returns nine URLs on
 * Tuesday), and an operator reading a flag frozen at Monday's cause is chasing
 * the wrong thing. `fired_at` is left alone so the row still dates the onset,
 * and `occurrences`/`lastObservedAt` carry how long it has run.
 *
 * Severity is `warn` on the served-layer guards. docs/08's alert-rules line
 * asks for `error` on static-depth; landing at `warn` is a deliberate first-run
 * posture (see the dated delta in docs/08 §S5) — `error` is the
 * revenue-off-switch band, and a hand-rolled word count that has never fired in
 * production has not earned it yet. A home page that does not answer HAS: the
 * site is down, which is exactly that band, so {@link HOME_UNREACHABLE_RULE_ID}
 * files at `error` (bead `ro-ujb9.165`). An open flag takes the severity of the
 * check that refreshes it, so one filed at `warn` before that is raised by the
 * next check that still finds the site down.
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
  // One transaction that holds the condition: read the open alert as its
  // newest reading states it, then raise one or append tonight's reading
  // (bead ro-ujb9.76.5.2; D1 rewrote the open row, severity included).
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
 * A clean reading closes the open flag for that guard. The condition these rules
 * describe is a live property of the served bytes, so once the bytes are healthy
 * again the alert has no subject — same contract as `asset-pull-failed`
 * resolving on the next good pull.
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
  /**
   * What the run's egress gate concluded, deliberately OUTSIDE the `fired` /
   * `resolved` totals: those count alerts about properties, and the one alert
   * this can write is about the OS. Mixing them would put a flag that says
   * "ignore tonight's silence" into the count of things tonight found.
   */
  egress: EgressRunOutcome;
}

export interface HygieneOptions {
  /** Override the eligible-asset query (tests inject their own properties). */
  assets?: HygieneAsset[];
  /** Override the outbound fetcher (tests stub the origin's responses). */
  fetchImpl?: typeof fetch;
  nowMs?: number;
  /** Override the run's egress gate — one per run, so its verdict and its
   * unmeasured-property set describe this sweep. Tests inject one to control the
   * verdict TTL; every other caller gets a real one over the same fetcher. */
  egress?: EgressGate;
  /** How long a failed home page waits for its confirming retry; default
   * {@link HOME_CONFIRM_WAIT_MS}. The journey fixture passes 0. */
  confirmWaitMs?: number;
}

/**
 * How long a home page whose GET failed waits before the one retry that
 * confirms it (bead `ro-ujb9.180`). A transient 5xx, a deploy in progress or a
 * CDN hiccup is over within it; a site that is really down still is. Uptime
 * products confirm the same way before alerting — UptimeRobot re-checks up to
 * three times 10–20 seconds apart, Pingdom needs a second failed test
 * (bead ro-ujb9.180).
 *
 * The run waits ONCE, for every site whose first GET failed, after every other
 * site is read: never a wait per site. A timer costs no CPU, and a scheduled
 * Worker has 15 minutes of wall clock; the hourly tick's freshness step runs
 * beside this one, so the wait holds up nothing else.
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
 * THE SECOND LOOK (bead `ro-ujb9.180`). After one wait, ask each home page
 * whose first GET failed once more. Its answer is the reading: up (with the
 * failed try recorded) or, failing again, the failing reading and the
 * {@link HOME_UNREACHABLE_RULE_ID} alert. A retry with no answer asks the egress
 * gate as the first GET would have: an OS that cannot reach the network
 * accuses no site.
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
 * not retired, and it is not asset #0.
 *
 * Asset #0 is excluded because S5 guards what a CRAWLER receives, and the OS's
 * own cockpit has no crawl surface to guard — including it would mean a
 * permanent "no sitemap" warn on the OS row, which is precisely the standing
 * noise the flags lane exists to avoid. Pre-launch properties ARE included:
 * observing them is Sense, and a pre-launch property is exactly where a robots
 * block or an empty home page is most likely to be sitting unnoticed.
 */
async function eligibleAssets(env: IngestEnv): Promise<HygieneAsset[]> {
  // The site list on Postgres (bead ro-ujb9.76.4.2); its CHECK already
  // refuses an empty domain. Ids in byte order, as D1 ordered them.
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
 * today's count has collapsed against the property's own trailing median.
 *
 * The rule stays UNARMED below {@link DEPTH_MIN_READINGS} prior readings. A
 * property whose second night looks different from its first has told us
 * nothing, and a guard that cries on day two is a guard that gets muted before
 * the day it matters.
 *
 * A home page that fails to load records `error`/`unreachable` with a NULL count
 * and files NO depth flag: an unreachable page is not a zero-word page, and this
 * rule's only sanctioned trigger is the median collapse. It is instead the
 * trigger for {@link HOME_UNREACHABLE_RULE_ID}, which is fired here because this
 * is the check that already fetches the page — one request, two rules, disjoint
 * conditions.
 *
 * ONE FAILED GET IS NOT DOWN (bead `ro-ujb9.180`). On the run's first GET a
 * failure the site may own is only held: the page joins `attempt.retryOwed`,
 * nothing is written, and this returns null. The run asks once more after
 * {@link HOME_CONFIRM_WAIT_MS} ({@link confirmHomeFailures}); only that second
 * failure writes the failing reading and files the alert, and a retry that
 * answers is an ordinary reading that carries the failed try.
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
    // A 200 we declined to read (past the byte ceiling, or a content type we
    // will not decode) is OUR limit, not the property's failure — same posture
    // the sitemap guard takes on a gzipped file. Record the reading so the gap
    // is visible; accuse nobody.
    const oursNotTheirs = response.status === 200;
    // A fetch with no status at all is the other failure that might be ours: on
    // 2026-08-08 this branch called six live home pages unreachable while the
    // OS's own uplink was down. Any status skips the question — it already
    // proves the request got out.
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
      // Two GETs, the confirmed failure's pair (bead `ro-ujb9.180`).
      ...(oursNotTheirs || egressDown ? {} : { failed_tries: 2 }),
    };
    await writeReading(env, entry.asset, 'html-depth', at, status, null, detail);
    if (oursNotTheirs || egressDown) {
      // No flag, and no retraction either: the reading stands as the record that
      // we looked, and "we did not measure it" is never grounds for withdrawing
      // an alert we already made.
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
    // It answered the retry: up, with the one failed try on the record, so the
    // row can say so without anything filed (bead `ro-ujb9.180`).
    ...(firstTry ? { failed_tries: 1, first_try_http_status: firstTry.status } : {}),
  };
  await writeReading(env, entry.asset, 'html-depth', at, collapsed ? 'warn' : 'ok', words, detail);

  // The page answered with a body we counted, so it is reachable — whatever the
  // depth rule goes on to conclude, and whether or not that rule is armed.
  // Reachability needs no baseline, so unlike the depth flag this retraction is
  // unconditional.
  const reachable = await resolveHygieneFlag(env, entry.asset, HOME_UNREACHABLE_RULE_ID, at);

  if (!collapsed) {
    // Only an ARMED, healthy reading retracts an open flag. While the rule is
    // unarmed we have not judged the page, and "we did not measure it" is never
    // grounds for withdrawing an alert we already made.
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
    // Values only (bead `ro-ujb9.96.6.26`): the Tower's headline and its
    // evidence rows are drawn from the inputs; why the depth matters (AI
    // crawlers read the served HTML, not the rendered page) is this file's.
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
  /**
   * The structural facts from the SAME bytes (ro-cda6.5). Present only when the
   * page was read; a page we could not fetch has no structure, as opposed to a
   * page with none.
   */
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
    // Two questions, one document. The structural parse rides the fetch the
    // directive check already paid for — re-fetching to ask it separately would
    // double the property's nightly requests to learn nothing new.
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
 * robots-ai-access: what the property's crawler directives say tonight, at BOTH
 * levels — the site-level `robots.txt`, and `<meta name="robots">` /
 * `X-Robots-Tag` on a stable sample of real pages.
 *
 * Two levels because they are two different regressions with two different
 * fixes. A blanket `Disallow: /` is a robots.txt line; a `noindex` shipped by a
 * template is a page, invisible to any site-level file, and it is the one a CMS
 * or a staging flag actually produces. They therefore carry two rule ids
 * ({@link ROBOTS_AI_RULE_ID}, {@link PAGE_DIRECTIVES_RULE_ID}) and one reading.
 *
 * Both halves share the family's discipline. Only transitions flag, and only in
 * the bad direction: the first reading of a URL (or of a robots.txt) establishes
 * the map and can never fire — a page that has always been `noindex` is a
 * standing configuration to argue about, not tonight's incident. And the
 * transition is measured against last night's reading while CONTINUATION is
 * measured against the open flag, because otherwise night three of a block looks
 * identical to night one of health and the guard would resolve its own alert.
 *
 * The page half is a SAMPLE and says so: `pages_sampled` of `pages_available`.
 * It can prove the pages it read are clean; it never claims the property is.
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
  // "robots.txt is no longer served" is this lane's loudest claim and its easiest
  // one to get wrong: an absence proves nothing when the request never left the
  // house. That is the flag 2026-08-08 fired on six properties at once, so a
  // statusless robots fetch asks the gate before the word `vanished` is used.
  const egressDown = !present && robots.status === null && (await gate.isDown());
  const bots = present ? resolveWatchedBots(parseRobotsGroups(robots.body)) : {};
  const hash = present ? await sha256Hex(robots.body) : null;

  const sampled = stableSample(roster.urls, PAGE_SAMPLE_SIZE);
  const pages = await samplePageDirectives(fetchImpl, sampled);
  // Hand the fetched documents on: `page-structure` asks a second question of
  // these exact bytes rather than fetching them again (ro-cda6.5).
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
  // Under an OS egress outage NEITHER half of this check measured anything: the
  // file did not answer and neither did the pages, so no regression may be
  // declared — and none may be withdrawn either. Forcing both verdicts false is
  // enough to reach that: the fire branches need a regression and the retract
  // branches need a served file or a page we read, and an outage has none of them.
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
  // A URL the open flag named is retracted only by PROOF that it is clean now.
  // Not re-reading it tonight (it left the sample, it 500s) is "we did not
  // measure it", which is never grounds for withdrawing an alert we made — the
  // flag stands until the page reads clean or an operator dispositions it.
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
    // A headline with its values (bead `ro-ujb9.96.6.26`); the bots and the
    // previous file's date ride in the inputs, which the Tower draws as rows.
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
    // resolves nothing; only a served file with the previously-lost bots back
    // in it retracts the flag. An absent robots.txt never retracts anything.
    resolved += await resolveHygieneFlag(env, entry.asset, ROBOTS_AI_RULE_ID, at);
  }

  if (pageRegression) {
    // The count as the headline (bead `ro-ujb9.96.6.26`); each URL and the
    // directives it carries are in the inputs (`blocked_urls`, `pages`), which
    // the Tower draws as one row per page. A page-level directive is the one
    // closure robots.txt cannot show, which is why this check exists.
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
    // A child we could not read makes the total an undercount, and an undercount
    // is exactly the shape of the collapse this check flags on. Report no number
    // rather than a number that would accuse the property of our own failure.
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
 * fetch it, prove it parses, count its URLs, and flag an outage or a collapse.
 *
 * Three flagging conditions: unreachable, unparseable, or a URL count at or
 * under half the previous reading when that reading held at least
 * {@link SITEMAP_MIN_PREV_URLS} URLs. The floor keeps small properties out of
 * the rule entirely — 6 → 3 URLs is a content edit, 4,000 → 40 is an outage.
 *
 * It is ALSO the roster supplier: the URLs it walks to produce a count are the
 * only list of the property's real pages this lane has in hand, and re-fetching
 * the sitemap for the directive check would double the most expensive request of
 * the night. So it fills `roster` on its way past, and runs first for that
 * reason. A sitemap that fails leaves the roster empty, which the directive
 * check records as "sampled nothing" rather than as "nothing is wrong".
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

  // A gzipped sitemap is legal and we cannot read one. Record the reading as an
  // error so the gap is visible, but do NOT flag: we cannot tell a real outage
  // from our own missing capability, and accusing the property of the second
  // would be the more expensive mistake. Checked before the transport failure
  // below because it is the one failure that is OURS.
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
    // The same question the depth check asks, checked before the same mistake:
    // the sitemaps that "vanished" on 2026-08-08 had not moved an inch. Only a
    // statusless fetch is ambiguous — a 404 sitemap is still a 404 sitemap.
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

  // `pageUrls` is the roster and never the reading: a detail_json carrying every
  // URL of a 4,000-page sitemap would be a copy of the sitemap in the store.
  const { pageUrls, ...counted } = await countSitemapUrls(fetchImpl, response.body, root);
  roster.urls = pageUrls;
  roster.source = 'sitemap';

  if (counted.urls === null) {
    // NOT egress-gated in v1, on purpose. A child sitemap's fetch failure only
    // ever reaches a reading through this collapsed count, and to get here the
    // PARENT fetch has to have succeeded — which is itself proof the OS could
    // reach this origin moments ago. The gate on the parent covers the outage
    // shape that actually happened; a mid-traversal outage would file one
    // `child-unreachable` on one property, not a portfolio's worth of alarms.
    return fail(
      'error',
      'child-unreachable',
      `${counted.children_failed.length} child sitemaps unreadable (first: ${counted.children_failed[0]})`,
      { ...counted },
    );
  }

  // The comparator is the last HEALTHY count, not simply yesterday's row: a
  // sitemap that stayed collapsed would otherwise match itself on night two and
  // resolve the flag describing it.
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
 * The property's real pages, as one check hands them to another. Mutable on
 * purpose: `checkSitemap` fills it while walking the sitemap it had to fetch
 * anyway, and `checkRobotsAiAccess` samples from it. `source` is `'none'` when
 * the sitemap never produced one, which is a different reading from an empty
 * property.
 */
interface PageRoster {
  urls: string[];
  source: 'sitemap' | 'none';
}

/**
 * Nightly hygiene sweep (04:00 UTC, after the watch-window read-out).
 *
 * robots.txt is fetched ONCE per property and shared by the robots check and the
 * sitemap check's URL resolution, and the sitemap's URL list is handed on to the
 * page-directive sample rather than re-fetched. Six requests per property on a
 * healthy night — three site-level, three sampled pages — and no check can
 * disagree with another about what the property served.
 *
 * ORDER IS LOAD-BEARING: `sitemap` runs first because it is the roster supplier.
 * Its failure is not the directive check's failure, though — an empty roster
 * means "sampled nothing", never "nothing is wrong".
 *
 * Isolation is per CHECK, not just per property: a home page that times out must
 * not cost that property its robots reading, and one property's origin being
 * down must not end the sweep. A check that throws outright is recorded in
 * `failed` with no reading stored — an exception is not an observation.
 *
 * The sweep also carries ONE {@link EgressGate}. Its verdict decides whether a
 * statusless fetch is the property's failure or the OS's own, and the set of
 * properties it caused to be skipped becomes the single `os-egress-down` flag
 * filed at the end of the run. It costs nothing on a night when every property
 * answers: nothing is probed until something has already come back empty.
 */

/**
 * The page sample, handed from the check that fetched it to the check that asks
 * a second question of it — the same device `PageRoster` is for the sitemap.
 *
 * `checkRobotsAiAccess` fills it on its way past, and `checkPageStructure` runs
 * after and reads it. A served page is ONE document: fetching it twice to ask
 * two questions would double every property's nightly request count to learn
 * nothing new, and the two answers could then disagree about a page that
 * changed between them.
 */
interface PageSample {
  pages: PageReading[];
  /** Where the roster came from, carried through so the second check can say
   * "sampled nothing because the sitemap failed" rather than "nothing wrong". */
  source: PageRoster['source'];
  /** True when the OS itself could not get out — nothing was measured, so
   * nothing may be declared AND nothing may be withdrawn. */
  egressDown: boolean;
}

/**
 * page-structure: the four structural facts on the sampled pages — a missing
 * `<title>`, a missing meta description, a missing or duplicated `<h1>`, and a
 * canonical pointing somewhere else (ro-cda6.5).
 *
 * IT FETCHES NOTHING. The pages were read once by
 * {@link checkRobotsAiAccess}; this asks a second question of the same bytes.
 * Hence the `sample` hand-off, the same device `roster` uses between the sitemap
 * and directive checks, and hence this check runs last.
 *
 * ONLY TRANSITIONS FIRE, the same discipline the directive half is held to. A
 * page that has always shipped without a meta description is a standing
 * editorial decision to argue about at leisure; a page that HAD one last night
 * and does not tonight is a regression somebody shipped today. The first reading
 * of a URL establishes the baseline and can never flag — which is also what
 * keeps this check from opening a flag on every page of every property the night
 * it lands.
 *
 * WHAT IT DOES NOT CLAIM. A structural fault is not automatically an *act*: a
 * missing title on a page with impressions is worth a morning, and the same
 * fault on a page nobody reaches is worth nothing. That triage needs traffic
 * evidence, which lives in the Tower's page decisions and not in this lane —
 * so this check reports the fault and stops short of ranking it.
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

  // A fault is NEW only when the same URL read clean last night. No prior
  // reading means no transition, which is the rule that stops this check from
  // flagging the whole portfolio on the night it ships.
  const newlyFaulty = pages
    .filter((page) => {
      if (!page.read || (page.faults ?? []).length === 0) return false;
      const before = previousPages.get(page.url);
      return before?.read === true && (before.faults ?? []).length === 0;
    })
    .map((page) => page.url);
  // A URL the open flag named is retracted only by PROOF that it is clean now.
  // Not re-reading it tonight is "we did not measure it", never grounds for
  // withdrawing an alert we made.
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
      : // Nothing to read is UNKNOWN, not clean. A property whose sitemap failed
        // has no roster, so this check measured nothing and must not report 'ok'.
        'unreachable';

  await writeReading(env, entry.asset, 'page-structure', at, status, readable.length, {
    ...detail,
    ...(regression ? { faulty_urls: faultyUrls } : {}),
  });

  let fired = 0;
  let refreshed = 0;
  let resolved = 0;

  if (regression) {
    // The count as the headline (bead `ro-ujb9.96.6.26`); each URL and its
    // faults are in the inputs (`faulty_urls`, `pages`), which the Tower draws
    // as one row per page.
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
    // The headline number is HOW MANY PAGES WERE READ — the denominator behind
    // every claim this check makes. Zero is a real reading ("the roster was
    // empty"), which is why the status beside it is 'unreachable' and not 'ok'.
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
  // ONE gate for the whole sweep: the verdict is shared (six dead properties are
  // one outage, asked about once) and so is the set of properties it cost, which
  // is what the flag at the end counts.
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
  // Home pages whose first GET failed: asked again once, after every site
  // (bead ro-ujb9.180).
  const retryOwed: UnconfirmedHome[] = [];

  for (const entry of entries) {
    const robots = await fetchDoc(fetchImpl, `https://${entry.domain}/robots.txt`, 'text/plain');

    const roster: PageRoster = { urls: [], source: 'none' };
    // Filled by the directive check and read by the structure check; see
    // PageSample. The ORDER of the two below is therefore load-bearing.
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

// --- uptime: the home-page check, hourly (bead ro-ujb9.165) -----------------

/**
 * A home-page reading younger than this is the check this hour would make. The
 * 04:00 nightly sweep and the 04:00 hourly tick fire together, and whichever
 * runs second finds the other's reading and asks the site nothing more.
 */
export const UPTIME_FRESH_MS = 30 * 60_000;

export interface UptimeRunResult {
  assets: number;
  /** Sites whose home page this run fetched. */
  checked: number;
  /** Sites skipped because a reading younger than {@link UPTIME_FRESH_MS} stands. */
  skipped: number;
  /** Sites whose first GET failed and were asked once more (bead `ro-ujb9.180`). */
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
 * IS EACH SITE UP — the OS asks itself, every hour, with no account and no
 * setup (bead `ro-ujb9.165`).
 *
 * It is not a second monitor. It is the nightly sweep's own home-page check
 * ({@link checkHtmlDepth}) run on the hourly tick: the same plain HTTPS GET of
 * `https://<domain>/` under the OS's honest User-Agent and the 15-second
 * ceiling, the same `hygiene_checks` reading (one row per site per day; the
 * hour's check replaces the day's reading, which the migration's grain allows),
 * and the same {@link HOME_UNREACHABLE_RULE_ID} flag, filed at `error` when the
 * page does not answer twice in a row, 45 seconds apart (bead `ro-ujb9.180`,
 * {@link HOME_CONFIRM_WAIT_MS}), and retracted by the first check it answers.
 * The same egress gate means an OS that cannot reach the network accuses no
 * site: the reading says so and the site is not checked, never Down.
 *
 * The robots, sitemap and page-sample checks stay nightly — they guard slow
 * declines and cost several requests a site; being up is one request.
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
