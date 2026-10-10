import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// A site is never a *property*, and one word means one thing. The word a
// person reads is *site*; *property* collides with the GA4/Search Console
// **property** object the Sources tab has to name.
//
// A copy sweep is only true on the day it runs. The old word survives in every
// commit message, in the docs' history, and in working vocabulary, so it comes
// back one string at a time unless something fails. This is that something.
//
// WHAT IT READS: shipped text only, string and template literals and JSX text
// nodes. Not comments, not identifiers, not object keys. `PropertyFavicon`,
// `perProperty` and a local `properties` array are code nobody but us reads;
// a LABEL is what this guard is about.
//
// It reads TWO corpora, because the operator's sentences come from two places:
// the Tower's own source (below), and the config files the Tower renders
// verbatim (at the bottom of this file).
//
// The exemptions are exact phrases rather than a pattern, so widening the guard
// is a decision somebody makes on purpose.

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');

/**
 * `shared/` and `worker/` are scanned alongside `src/` because the payload
 * builders WRITE the sentences the UI renders — the alert headlines, the
 * integration lane copy, the financials titles. A guard that read only `src/`
 * would be blind to half the strings the operator actually sees.
 */
const SCAN_DIRS = ['apps/tower/src', 'apps/tower/shared', 'apps/tower/worker'];

/**
 * `worker/mcp-route.ts` speaks to AGENTS, not to the operator: its tool names
 * (`list_properties`, `property_report`) are a published MCP interface, and
 * renaming them would break every caller for a word no person reads. It is the
 * one file whose vocabulary this rule deliberately does not govern.
 */
const NOT_OPERATOR_FACING = new Set(['apps/tower/worker/mcp-route.ts']);

/**
 * Exact strings that may contain `propert` and are NOT the portfolio noun.
 * Three kinds, and nothing else belongs here:
 *
 *  1. THE PROVIDER'S OWN OBJECT. A site's GA4 property is a real thing with
 *     that real name; calling it an asset would be wrong rather than
 *     consistent.
 *  2. STORED OR WIRE VALUES — config file values, DOM hooks, storage keys, and
 *     the alias URL. Renaming one of these is a data migration, not a copy
 *     change, and `/properties` must keep resolving forever.
 *  3. A QUOTE OF SOMETHING THAT REALLY SAID IT. Rewriting a quotation makes the
 *     history wrong.
 */
const ALLOWED_PHRASES = [
  // 1. the provider's own object: Google's word stays where Google's object is
  //    what is being named. The plurals earn their place on the Integrations
  //    page, where a sign-in lists everything one account can see.
  'GA4 property',
  'GA4 properties',
  'Analytics properties',
  // 2. stored values, DOM hooks, storage keys, the alias URL
  '"property"',
  '"per-property"',
  // The response decoder reads the same stored enum values with single quotes.
  "'property'",
  "'per-property'",
  '"property-setup"',
  '"property-card"',
  'data-property-favicon',
  '`property-findings:',
  '/properties',
  // The react-query key for the connected Google account's own property list.
  // It names the provider's object and never reaches a person: it is a cache
  // key, and the two cards that share it share it BY this string.
  '"google-properties"',
  // 3. a quotation of a label that no longer exists
  '← All properties',
];

/** Comments are not labels. Block comments (JSX `{/* … *\/}` included) go
 * whole; line comments only when the `//` opens the line, so a `https://…`
 * inside a string survives. Replaced by spaces so every offset still points at
 * the same character it did in the file. */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/^[ \t]*\/\/.*$/gm, (m) => ' '.repeat(m.length))
    // A `${…}` inside a template literal is an EXPRESSION, not copy: blanked
    // so `${property.asset}` reads as the identifier it is.
    .replace(/\$\{[^{}]*\}/g, (m) => ' '.repeat(m.length));
}

/** The spans of a file that end up in front of a person: string and template
 * literals, plus JSX text nodes. Offsets are into the original file. */
function shippedSpans(text) {
  const spans = [];
  const patterns = [
    /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, // literals
    // JSX text nodes. The lookbehind keeps `=>` and `->` out, and the
    // lookahead requires a real tag after the text, so an arrow function in
    // code is never mistaken for a label.
    /(?<![=\-!<>])>([^<>{}]*)<(?=[/A-Za-z])/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      spans.push([match.index, match.index + match[0].length]);
    }
  }
  return spans;
}

/** Is the `propert…` at `at` inside one of `phrases` — the exact-phrase kind of
 * exemption, checked against THIS hit rather than "the line mentions GA4
 * somewhere". `window` is `text.slice(from, …)`, so `from` maps back to file
 * offsets. Shared by the Tower scan and the config scan below. */
function coveredByPhrase(window, from, at, phrases) {
  return phrases.some((phrase) => {
    for (let found = window.indexOf(phrase); found >= 0; found = window.indexOf(phrase, found + 1)) {
      const start = from + found;
      if (start <= at && at < start + phrase.length) return true;
    }
    return false;
  });
}

function sourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...sourceFiles(rel));
    else if (/\.tsx?$/.test(entry.name) && !NOT_OPERATOR_FACING.has(rel)) found.push(rel);
  }
  return found;
}

const FILES = SCAN_DIRS.flatMap(sourceFiles);

// A guard that scans nothing passes forever.
test('the UI-noun sweep has files to sweep', () => {
  assert.ok(
    FILES.length > 50,
    `only ${FILES.length} Tower source file(s) found — the directory walk did not resolve`,
  );
  assert.ok(
    FILES.includes('apps/tower/src/components/AppShell.tsx'),
    'the file holding the nav labels must be in the scan',
  );
});

test('no shipped Tower string calls an asset a property', () => {
  const offenders = [];

  for (const name of FILES) {
    const text = withoutComments(readFileSync(path.join(REPO_ROOT, name), 'utf8'));
    const spans = shippedSpans(text);

    for (const hit of text.matchAll(/propert(y|ies)/gi)) {
      const at = hit.index;
      if (!spans.some(([start, end]) => at >= start && at < end)) continue;

      // Part of a longer identifier (`PropertyFavicon`, `perProperty`,
      // `property_ref`) even inside a template literal — still code.
      const before = at > 0 ? text[at - 1] : '';
      const after = text[at + hit[0].length] ?? '';
      if (/[A-Za-z0-9_$]/.test(before) || /[A-Za-z0-9_$]/.test(after)) continue;

      // Exempt only when an allowlisted phrase actually covers THIS hit.
      const from = Math.max(0, at - 60);
      const window = text.slice(from, at + 60);
      if (coveredByPhrase(window, from, at, ALLOWED_PHRASES)) continue;

      const line = text.slice(0, at).split('\n').length;
      offenders.push(`${name}:${line}  …${window.replace(/\s+/g, ' ').trim()}…`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these shipped strings still call an asset a property:\n  ${offenders.join('\n  ')}\n` +
      'The UI noun is Site — nav labels, headings, copy, hover text, and the sentences the ' +
      'payload builders write. If a string genuinely names the GA4/Search Console property ' +
      'object, a stored config value, a DOM hook, or the /properties alias URL, add that exact ' +
      'phrase to ALLOWED_PHRASES in this file with its reason — never widen the pattern.',
  );
});

// An allowlist nobody prunes stops being a decision and becomes a habit.
test('every allowed phrase still matches something', () => {
  const corpus = FILES.map((name) => readFileSync(path.join(REPO_ROOT, name), 'utf8')).join('\n');
  const unused = ALLOWED_PHRASES.filter((phrase) => !corpus.includes(phrase));
  assert.deepEqual(
    unused,
    [],
    `these exemptions no longer match anything in the Tower — delete them:\n  ${unused.join('\n  ')}`,
  );
});

// ---------------------------------------------------------------------------
// The config side
// ---------------------------------------------------------------------------
// Half the sentences on the Data-sources surfaces are not written in the Tower
// at all: the Tower reads them VERBATIM out of config/*.json (the integration
// matrix hovers, the lane copy on an asset page, the setup steps on /health, a
// recurring cost's note as it rides onto a ledger row). A guard that reads only
// source would let the old word back in through a file nobody thinks of as
// copy.
// The product defaults that carry prose. Per-asset notes and a cost's note are
// one installation's own words, kept in its installation folder, not product
// copy.
const CONFIG_FILES = [
  'config/integrations.json',
];

/**
 * Exact string VALUES that are SCHEMA rather than copy. `scope`, `layer` and
 * `credential` are typed on these literals in `apps/tower/shared/integrations.ts`
 * (`LaneScope`, `IntegrationLayer`, `CredentialScope`), the payload defaults to
 * them, and the register's own validation matches on them — renaming one is a
 * data migration and a type change, not a copy fix.
 *
 * Only whole values are exempt, never a prose sentence that happens to contain
 * one: an exact-match set cannot be widened by accident.
 *
 * The `perProperty` FIELD NAME needs no entry: the walk below reads values and
 * never keys, because a key is code and code identifiers are left alone.
 */
const SCHEMA_VALUES = new Set(['property', 'per-property']);

/**
 * Phrases inside config prose that name a PROVIDER's object rather than ours.
 * Same rule as ALLOWED_PHRASES above and kept separate from it so each list is
 * pruned against the corpus it actually guards.
 */
// Empty while the generic config/integrations.json carries no catalog prose; a
// provider's object named in config prose again earns its place here with its
// reason.
const CONFIG_ALLOWED_PHRASES = [];

/** Every string VALUE in a parsed config, with a JSON-path label for the error
 * message. Keys are deliberately not yielded. */
function* stringValues(node, at = '$') {
  if (typeof node === 'string') yield [at, node];
  else if (Array.isArray(node)) {
    for (const [i, child] of node.entries()) yield* stringValues(child, `${at}[${i}]`);
  } else if (node && typeof node === 'object') {
    for (const [key, child] of Object.entries(node)) yield* stringValues(child, `${at}.${key}`);
  }
}

const CONFIG_VALUES = CONFIG_FILES.map((name) => ({
  name,
  values: [...stringValues(JSON.parse(readFileSync(path.join(REPO_ROOT, name), 'utf8')))],
}));

// A guard that scans nothing passes forever.
test('the config scan has prose to scan', () => {
  for (const { name, values } of CONFIG_VALUES) {
    assert.ok(values.length > 5, `${name} yielded only ${values.length} string value(s)`);
  }
});

test('no operator-visible config string calls an asset a property', () => {
  const offenders = [];

  for (const { name, values } of CONFIG_VALUES) {
    for (const [at, value] of values) {
      if (SCHEMA_VALUES.has(value)) continue;

      for (const hit of value.matchAll(/propert(y|ies)/gi)) {
        const index = hit.index;

        // Part of a longer identifier (`ga4_property_id`, `property_ref`) —
        // still a wire name, even inside a sentence.
        const before = index > 0 ? value[index - 1] : '';
        const after = value[index + hit[0].length] ?? '';
        if (/[A-Za-z0-9_$]/.test(before) || /[A-Za-z0-9_$]/.test(after)) continue;

        const from = Math.max(0, index - 60);
        const window = value.slice(from, index + 60);
        if (coveredByPhrase(window, from, index, CONFIG_ALLOWED_PHRASES)) continue;

        offenders.push(`${name} ${at}  …${window.replace(/\s+/g, ' ').trim()}…`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these config strings reach the operator and still call an asset a property:\n  ${offenders.join('\n  ')}\n` +
      'The Tower renders these verbatim — lane labels, ' +
      'cell notes, ledger-row notes. A schema literal belongs in SCHEMA_VALUES (whole value ' +
      "only); a provider's own object belongs in CONFIG_ALLOWED_PHRASES with its reason. " +
      'Never widen the pattern.',
  );
});

// The same pruning discipline, over the corpus these two lists actually guard.
test('every config exemption still matches something', () => {
  const corpus = CONFIG_VALUES.flatMap(({ values }) => values.map(([, value]) => value));
  const unusedPhrases = CONFIG_ALLOWED_PHRASES.filter(
    (phrase) => !corpus.some((value) => value.includes(phrase)),
  );
  const unusedValues = [...SCHEMA_VALUES].filter((literal) => !corpus.includes(literal));
  assert.deepEqual(
    [...unusedPhrases, ...unusedValues],
    [],
    'these config exemptions no longer match anything — delete them:\n  ' +
      [...unusedPhrases, ...unusedValues].join('\n  '),
  );
});
