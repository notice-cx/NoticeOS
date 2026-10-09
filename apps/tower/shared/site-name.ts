// A site's own name, read from its home page (bead `ro-ujb9.96.7.5`).
//
// The add screen asks for a domain and nothing else, so the name the asset is
// saved under has to come from somewhere the operator did not type. The domain
// gives a starting name at once (`siteNameFromDomain`), and the site itself
// gives a better one when it answers: Ahrefs fills a new project's name from
// the page's title the same way.
//
// PURE, so the rules are pinned without a network: the Worker route
// (`worker/site-name-route.ts`) fetches the page and hands the HTML here.

import { DISPLAY_NAME_MAX } from "@noticeos/contract/configuration";

/** The route the add screen asks. */
export const SITE_NAME_PATH = "/api/site-name";

/** What the route answers: the site's own name, or null when the site did not
 * answer with one — the add screen then keeps the domain's name. */
export interface SiteNameAnswer {
  name: string | null;
}

/**
 * May the Worker fetch this host to read a name? A public-looking DNS name
 * only: at least two labels, an alphabetic top level, and none of the names
 * that resolve inside a network. An IP literal, `localhost` or `*.internal` is
 * refused before any request, so the route cannot be pointed at the machine it
 * runs on.
 */
export function isLookupHost(host: string): boolean {
  const value = host.toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value)) return false;
  const labels = value.split(".");
  const top = labels.at(-1)!;
  if (!/^[a-z]{2,63}$/.test(top)) return false;
  if (["localhost", "local", "internal", "intranet", "lan", "home", "corp", "test", "invalid", "example"].includes(top)) {
    return false;
  }
  return !labels.includes("localhost");
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", middot: "·", raquo: "»", laquo: "«",
};

/** The few HTML entities a title carries, decoded; anything else is left as
 * written rather than guessed. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return ENTITIES[lower] ?? whole;
  });
}

function clean(text: string | undefined | null): string | null {
  if (!text) return null;
  const value = decodeEntities(text).replace(/\s+/g, " ").trim();
  return value.length === 0 ? null : value;
}

/** The value of a `<meta>` whose `property` or `name` is one of `keys`. */
function metaContent(html: string, keys: readonly string[]): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    if (!key || !keys.includes(key)) continue;
    const content = clean(/\bcontent\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? /\bcontent\s*=\s*'([^']*)'/i.exec(tag)?.[1]);
    if (content) return content;
  }
  return null;
}

/** Letters and digits only, lower case: "Field-Notes" and "fieldnotes" compare equal. */
function compact(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * The site's own name out of its home page, or null.
 *
 * In order: the name the site declares for itself (`og:site_name`,
 * `application-name`), then the part of its `<title>` that is the brand — the
 * segment between separators ("Acme — tools for makers" → "Acme") that
 * matches the domain's first label, or the whole title when it is short enough
 * to be a name. A long title that matches nothing is a sentence, not a name,
 * and answers null.
 */
export function siteNameFromHtml(html: string, domain: string): string | null {
  const head = html.slice(0, 64 * 1024);
  const declared = metaContent(head, ["og:site_name", "application-name", "apple-mobile-web-app-title"]);
  const title = clean(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1]);
  const label = compact(domain.split(".")[0] ?? "");
  const pick = (): string | null => {
    if (declared) return declared;
    if (!title) return null;
    const segments = title
      .split(/\s+[|·•»–—-]\s+|\s*[|·•»]\s*|:\s+/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    // The segment that IS the domain's name beats one that merely contains it:
    // "Recipe search · RecipeBox" is RecipeBox. Among containers, the
    // shortest carries the least that is not the name.
    const flat = segments.map((part) => ({ part, flat: compact(part) })).filter((entry) => entry.flat.length > 0);
    const brand = label.length === 0
      ? undefined
      : flat.find((entry) => entry.flat === label)
        ?? flat.filter((entry) => label.includes(entry.flat) || entry.flat.includes(label))
          .sort((a, b) => a.flat.length - b.flat.length)[0];
    if (brand) return brand.part;
    return title.split(" ").length <= 4 ? title : null;
  };
  const name = pick();
  if (name === null) return null;
  return name.slice(0, DISPLAY_NAME_MAX).trim() || null;
}
