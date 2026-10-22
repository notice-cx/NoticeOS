// The icons each site's home page declares, read once a day. A browser cannot
// read another site's HTML, so the Tower knows a site's dark-scheme icon only
// when this lane reads the page's <link> tags and stores what it found
// (noticeos.asset_icons, one row per read).
//
// One GET of the home page per site, under this OS's own User-Agent: redirects
// followed by hand, at most five; no cookie sent; ten seconds for the whole
// read; only the first 256 KB, and only up to the end of the head. A read that
// got no HTTP status at all asks the egress gate (src/egress.ts) first: when
// the OS itself is offline nothing is stored and the site's last read stands.

import type { SiteIconOutcome } from '@noticeos/contract';
import { EGRESS_NOT_ASKED, EgressGate, type EgressRunOutcome } from './egress.js';
import { askHome, eligibleAssets, type HygieneAsset } from './hygiene.js';

/** Honest identification, with a product token of its own. */
export const SITE_ICONS_USER_AGENT =
  'NoticeOS-Icons/1.0 (+https://www.notice.cx; asset icon read)';

/** The whole read of one address, redirects and body included. */
const READ_TIMEOUT_MS = 10_000;
/** The head is at the top of the page; nothing past this is read. */
const READ_BYTE_LIMIT = 256 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** The store's own ceiling on an icon address (migration 0017). */
const MAX_ICON_URL_LENGTH = 2048;
/** The smallest raster preferred over an apple-touch-icon. */
const PREFERRED_RASTER_PX = 32;

// --- the parser ---------------------------------------------------------------

/** `icon` covers `rel="icon"` and `rel="shortcut icon"`. */
export type IconKind = 'icon' | 'apple-touch-icon';
export type IconScheme = 'light' | 'dark';

/** One `<link>` in the head that declares an icon, attributes as written. */
export interface DeclaredIcon {
  kind: IconKind;
  href: string;
  media: string | null;
  sizes: string | null;
  type: string | null;
}

export interface DeclaredHead {
  /** The first `<base href>`, as written; null when the head has none. */
  base: string | null;
  icons: DeclaredIcon[];
}

/** The best icon for each scheme, as an absolute address. */
export interface ChosenIcons {
  light: string | null;
  dark: string | null;
}

const COMMENT = /<!--[\s\S]*?-->/g;
/** Elements whose text is never markup: a `<link>` inside one is a string. */
const RAW_TEXT = /<(script|style|template|textarea|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
/** Where the head ends, or an element a truncated read left open. */
const HEAD_END = /<\/head\s*>|<body[\s>]|<script\b/i;
/** A `<link>` or `<base>` tag; a quoted value may hold a `>`. */
const TAG = /<(link|base)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const DARK_SCHEME = /prefers-color-scheme\s*:\s*dark/i;

const NAMED_REFERENCES: Readonly<Record<string, string>> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };

/** The few character references an address or a media query carries. */
function decodeAttribute(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (match, ref: string) => {
    const lower = ref.toLowerCase();
    if (lower.startsWith('#x')) return codePoint(Number.parseInt(lower.slice(2), 16)) ?? match;
    if (lower.startsWith('#')) return codePoint(Number.parseInt(lower.slice(1), 10)) ?? match;
    return NAMED_REFERENCES[lower] ?? match;
  });
}

function codePoint(value: number): string | null {
  return Number.isInteger(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : null;
}

/** A tag's attributes by lower-case name; the first of a repeated name counts, as in a browser. */
function attributesOf(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match[1]!.toLowerCase();
    if (attributes.has(name)) continue;
    attributes.set(name, decodeAttribute(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return attributes;
}

/** The head of a page: comments and raw-text elements removed, cut where the head ends. */
function headOf(html: string): string {
  const text = html.replace(COMMENT, '').replace(RAW_TEXT, '');
  const end = text.search(HEAD_END);
  return end === -1 ? text : text.slice(0, end);
}

function iconKind(rel: string): IconKind | null {
  const tokens = rel.toLowerCase().split(/\s+/);
  if (tokens.includes('icon')) return 'icon';
  if (tokens.includes('apple-touch-icon') || tokens.includes('apple-touch-icon-precomposed')) return 'apple-touch-icon';
  return null;
}

/** Every icon a page's head declares and its `<base href>`, in document order. */
export function parseDeclaredIcons(html: string): DeclaredHead {
  const head: DeclaredHead = { base: null, icons: [] };
  for (const match of headOf(html).matchAll(TAG)) {
    const attributes = attributesOf(match[2] ?? '');
    const href = attributes.get('href');
    if (match[1]!.toLowerCase() === 'base') {
      if (head.base === null && href !== undefined) head.base = href;
      continue;
    }
    const kind = iconKind(attributes.get('rel') ?? '');
    if (kind === null || href === undefined || href.trim() === '') continue;
    head.icons.push({
      kind,
      href,
      media: attributes.get('media') ?? null,
      sizes: attributes.get('sizes') ?? null,
      type: attributes.get('type') ?? null,
    });
  }
  return head;
}

/** Dark when the media query asks for prefers-color-scheme: dark; light otherwise, no query included. */
export function iconScheme(media: string | null): IconScheme {
  return media !== null && DARK_SCHEME.test(media) && !/\bnot\b/i.test(media) ? 'dark' : 'light';
}

/** The largest edge a `sizes` attribute declares, in pixels; null for none or `any`. */
export function largestSize(sizes: string | null): number | null {
  let largest: number | null = null;
  for (const token of (sizes ?? '').split(/\s+/)) {
    const match = /^(\d+)[xX](\d+)$/.exec(token);
    if (!match) continue;
    const edge = Math.max(Number(match[1]), Number(match[2]));
    if (largest === null || edge > largest) largest = edge;
  }
  return largest;
}

function isSvg(icon: DeclaredIcon): boolean {
  return /svg/i.test(icon.type ?? '') || /\.svg(?:[?#]|$)/i.test(icon.href.trim());
}

/**
 * Lower is better. SVG first; then a raster icon of 32 px or more, largest
 * first; then a raster icon with no declared size (usually a multi-size
 * `.ico`); then an apple-touch-icon, largest first; then a raster icon under
 * 32 px. Document order breaks a tie.
 */
function iconRank(icon: DeclaredIcon, index: number): [number, number, number] {
  const size = largestSize(icon.sizes);
  const tier = isSvg(icon)
    ? 0
    : icon.kind === 'apple-touch-icon'
      ? 3
      : size === null
        ? 2
        : size >= PREFERRED_RASTER_PX
          ? 1
          : 4;
  return [tier, -(size ?? 0), index];
}

function better(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

/** An http(s) address, resolved against `base`; null for anything else. */
function webAddress(href: string, base: string | URL): string | null {
  let url: URL;
  try {
    url = new URL(href.trim(), base);
  } catch {
    return null;
  }
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
}

/**
 * The best light icon and the best dark icon `html` declares, each resolved
 * against its `<base href>` or else `pageUrl`, the address the page was read
 * from after redirects.
 */
export function chooseSiteIcons(html: string, pageUrl: string): ChosenIcons {
  const head = parseDeclaredIcons(html);
  const base = (head.base === null ? null : webAddress(head.base, pageUrl)) ?? pageUrl;
  const best: Record<IconScheme, { url: string; rank: [number, number, number] } | null> = { light: null, dark: null };
  head.icons.forEach((icon, index) => {
    const url = webAddress(icon.href, base);
    if (url === null || url.length > MAX_ICON_URL_LENGTH) return;
    const scheme = iconScheme(icon.media);
    const rank = iconRank(icon, index);
    const held = best[scheme];
    if (held === null || better(rank, held.rank)) best[scheme] = { url, rank };
  });
  return { light: best.light?.url ?? null, dark: best.dark?.url ?? null };
}

// --- the read -----------------------------------------------------------------

interface PageRead {
  /** The last address asked: the page itself once redirects are followed. */
  url: string;
  /** The last HTTP status, or null when nothing came back at all. */
  status: number | null;
  /** The start of a 2xx body, up to the end of its head; null otherwise. */
  html: string | null;
  error?: string;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/** The body up to the end of its head, at most {@link READ_BYTE_LIMIT} bytes.
 * A failure part-way keeps what had arrived: the head comes first. */
async function readHead(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (bytes < READ_BYTE_LIMIT) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      const chunk = value.byteLength > READ_BYTE_LIMIT - bytes ? value.subarray(0, READ_BYTE_LIMIT - bytes) : value;
      bytes += chunk.byteLength;
      // A tag split across two chunks is found from a few characters back.
      const from = Math.max(0, text.length - 16);
      text += decoder.decode(chunk, { stream: true });
      if (/<\/head\s*>|<body[\s>]/i.test(text.slice(from))) break;
    }
  } catch {
    return text;
  }
  await reader.cancel().catch(() => undefined);
  return text;
}

/** One address, redirects followed by hand. Never throws. */
async function readPage(fetchImpl: typeof fetch, startUrl: string): Promise<PageRead> {
  const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
  let url = startUrl;
  try {
    for (let redirects = 0; ; redirects += 1) {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': SITE_ICONS_USER_AGENT },
        redirect: 'manual',
        signal,
      });
      const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get('location') : null;
      if (location !== null) {
        await response.body?.cancel();
        const next = webAddress(location, url);
        if (redirects === MAX_REDIRECTS || next === null) {
          const error = next === null ? 'redirect to an address that is not a web page' : `more than ${MAX_REDIRECTS} redirects`;
          return { url, status: response.status, html: null, error };
        }
        url = next;
        continue;
      }
      if (response.status < 200 || response.status > 299) {
        await response.body?.cancel();
        return { url, status: response.status, html: null };
      }
      return { url, status: response.status, html: await readHead(response) };
    }
  } catch (error) {
    return { url, status: null, html: null, error: errorText(error) };
  }
}

// --- the lane -----------------------------------------------------------------

/** A site and the domain its home page is read from. */
export type SiteIconTarget = HygieneAsset;

export interface SiteIconRead {
  asset: string;
  /** `unmeasured` when the OS itself could not reach the network: nothing was stored. */
  outcome: SiteIconOutcome | 'unmeasured';
  light: string | null;
  dark: string | null;
}

export interface SiteIconsRunResult {
  /** `not-migrated` when the store has no asset_icons table yet: no site was asked. */
  skipped: 'not-migrated' | null;
  assets: number;
  reads: SiteIconRead[];
  /** Sites whose read or write threw; the run went on to the next site. */
  failed: { asset: string; error: string }[];
  egress: EgressRunOutcome;
}

export interface SiteIconsOptions {
  fetchImpl?: typeof fetch;
  nowMs?: number;
  /** Read only these sites. Default: the sites the hygiene checks read
   * (`eligibleAssets`), every one with a domain that is not retired and is
   * not the OS's own row. */
  assets?: readonly SiteIconTarget[];
  egress?: EgressGate;
}

/** Whether migration 0017 has been applied to this store. */
async function iconTableExists(env: IngestEnv): Promise<boolean> {
  const [row] = await env.STORE.read((tx) =>
    tx.query<{ present: boolean }>(`SELECT to_regclass('noticeos.asset_icons') IS NOT NULL AS present`),
  );
  return row?.present === true;
}

async function storeRead(
  env: IngestEnv,
  asset: string,
  at: string,
  outcome: SiteIconOutcome,
  icons: ChosenIcons,
  page: PageRead,
): Promise<void> {
  const detail = { pageUrl: page.url, status: page.status, ...(page.error ? { error: page.error } : {}) };
  await env.STORE.write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.asset_icons (workspace_id, asset_id, read_at, outcome, light_url, dark_url, detail)
       VALUES ($1::uuid, $2, $3::timestamptz, $4, $5, $6, $7::json)`,
      [tx.workspaceId, asset, at, outcome, icons.light, icons.dark, JSON.stringify(detail)],
    ),
  );
}

/**
 * Read every site's declared icons and store one row per site. One site's
 * failure is recorded in `failed` and never stops the run.
 */
export async function runSiteIcons(env: IngestEnv, opts: SiteIconsOptions = {}): Promise<SiteIconsRunResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const at = new Date(opts.nowMs ?? Date.now()).toISOString();
  const result: SiteIconsRunResult = { skipped: null, assets: 0, reads: [], failed: [], egress: EGRESS_NOT_ASKED };
  if (!(await iconTableExists(env))) return { ...result, skipped: 'not-migrated' };

  // One row per site per read: the store keys a read by its site and instant.
  const targets = [...new Map((opts.assets ?? (await eligibleAssets(env))).map((target) => [target.asset, target])).values()];
  result.assets = targets.length;
  const gate = opts.egress ?? new EgressGate(env, { lane: 'icons', fetchImpl, at });

  for (const target of targets) {
    try {
      const page = (await askHome(target.domain, (host) => readPage(fetchImpl, `https://${host}/`))).response;
      if (page.status === null && (await gate.isDown())) {
        gate.recordUnmeasured(target.asset);
        result.reads.push({ asset: target.asset, outcome: 'unmeasured', light: null, dark: null });
        continue;
      }
      const icons = page.html === null ? { light: null, dark: null } : chooseSiteIcons(page.html, page.url);
      const outcome: SiteIconOutcome =
        page.html === null ? 'unreachable' : icons.light !== null || icons.dark !== null ? 'read' : 'no-icon';
      await storeRead(env, target.asset, at, outcome, icons, page);
      result.reads.push({ asset: target.asset, outcome, ...icons });
    } catch (error) {
      result.failed.push({ asset: target.asset, error: errorText(error) });
    }
  }

  result.egress = await gate.finalize();
  return result;
}
