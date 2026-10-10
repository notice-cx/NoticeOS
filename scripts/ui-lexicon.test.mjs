import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commentsBlanked, coveredByPhrase, sourceFiles, stringValues, withoutComments } from './test/shipped-copy.mjs';
import { extractVisibleStrings, loadTypeScript } from './ux-gate.mjs';

// The desk speaks plain English, and a sweep is only true on the day it runs.
//
// `docs/14-design.md` maps every internal coinage to the word the UI renders:
// read a screen aloud to somebody who has never seen this repo, and any term
// you would have to stop and define fails review. Every one of these words
// survives in the schema, the docs, the CLI and working vocabulary, so they
// come back one string at a time; this is what fails when one does. It is the
// sister of `ui-noun.test.mjs` and reads the same corpus the same way.
//
// WHAT IT READS: shipped text only, string and template literals and JSX text
// nodes. Not comments, not identifiers, not module paths: a LABEL is what this
// guard is about.
//
// The exemptions are exact phrases rather than patterns, so widening the guard
// is a decision somebody makes on purpose.

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');

/** `shared/` and `worker/` are scanned with `src/` because the payload builders
 * WRITE the sentences the desk renders — the alert headlines, the data-source
 * copy, the refusal messages. A guard that read only `src/` would be blind to
 * half of what the operator sees. */
const SCAN_DIRS = ['apps/tower/src', 'apps/tower/shared', 'apps/tower/worker'];

/**
 * Files whose strings are not desk copy. Each is here for its own reason, and
 * the list is deliberately short: an exclusion is a page this guard stops
 * watching.
 *
 *  - `worker/mcp-route.ts` speaks to AGENTS: its tool descriptions are a
 *    published interface, exactly as `ui-noun.test.mjs` records.
 *  - `components/registry.ts` is the machine-readable component index,
 *    documentation for the next agent. Its one importer is `KitchenSinkRoute`,
 *    which renders the entry names as the gallery's contents, and that route
 *    is excluded here for its own reason, so nothing in this file reaches the
 *    desk.
 *  - The `/dev/*` gallery renders only under `import.meta.env.DEV` and is the
 *    agent's visual reference, not a desk route.
 *  - `shared/materiality.ts` is the material-state contract, a record read by
 *    `test/materiality.test.tsx` and rendered nowhere.
 *  - `lib/task-handoff.ts` writes the `bd create` command an agent runs, and
 *    that command IS its payload (the same reason owner chips keep their file
 *    paths). The other two Markdown builders build the evidence brief around
 *    the section and emit no command of their own, so they are swept like any
 *    other document the operator reads.
 */
const NOT_DESK_COPY = new Set([
  'apps/tower/worker/mcp-route.ts',
  'apps/tower/src/components/registry.ts',
  'apps/tower/src/routes/KitchenSinkRoute.tsx',
  'apps/tower/shared/materiality.ts',
  'apps/tower/src/lib/task-handoff.ts',
]);

/**
 * The banned coinages, each with the word doc 14 renders instead. The `word`
 * is quoted back in the failure so a reader never has to open the doc to know
 * what to write.
 *
 * `changeset` is deliberately ABSENT: doc 14 keeps it as a justified exception
 * (git's own vocabulary for a preview-then-apply document), and it renders
 * only beside `pnpm config:apply --stdin`, the command that consumes it.
 * `sense_only` is absent for the same kind of reason: doc 14 sanctions it as
 * the jargon suffix on "Automation", and it has no prose use to guard.
 */
const BANNED = [
  { pattern: /\bbeads?\b/gi, word: 'task' },
  { pattern: /\bbd\b/g, word: 'a labelled command — `bd` inside <code> or backticks' },
  { pattern: /\bspokes?\b/gi, word: 'project' },
  // NOT a bare `hub`: `config/serp-panel.json` tracks queries in clusters the
  // operator names ("Recipe hub"), which are content taxonomy and have nothing
  // to do with `bd`'s server. The coinage is the COMPOUND, so the compound is
  // what is banned.
  { pattern: /\btask[- ]hubs?\b|\bthe hubs?\b/gi, word: 'the task database (or just Tasks)' },
  { pattern: /\blanes?\b/gi, word: 'data source, scheduled job, or write path — say which' },
  { pattern: /\bpulses?\b/gi, word: 'nightly report' },
  { pattern: /\basset #0\b/gi, word: 'the System' },
  { pattern: /\bpollers?\b/gi, word: 'the OS' },
  { pattern: /\bknobs?\b/gi, word: 'setting' },
  { pattern: /\b(?:the|a|this) registers?\b/gi, word: 'the catalog' },
  // `tile` names a shape rather than a thing and appears nowhere else in the
  // product; every dashboard the operator has ever used calls that box a
  // WIDGET.
  { pattern: /\btiles?\b/gi, word: 'widget' },
  // The other half of rule 1: a SYNONYM for a word doc 14 has already mapped is
  // the same failure as a coinage. `sense_only` renders as exactly one pair,
  // "Monitor only" and "Automation enabled".
  { pattern: /\bObserve only\b/gi, word: 'Monitor only' },
  { pattern: /\bAutomation on\b/gi, word: 'Automation enabled' },
];

/**
 * Exact strings that may contain a banned word and are NOT desk copy. Five
 * kinds, and nothing else belongs here; the television says Tasks like every
 * other surface, so *bead* fails everywhere.
 */
const ALLOWED_PHRASES = [
  // 1. FILE PATHS THE OPERATOR EXECUTES AGAINST: owner chips and command
  //    labels, kept verbatim by doc 14's owner-chip row.
  'config/beads.json',
  'config/beads.README.md',
  '/.beads/config.yaml',
  'config/changesets',
  // 2. STORED, WIRE AND DOM VALUES. Renaming one is a data migration or a
  //    broken link, not a copy change.
  'scheduled-lane-health',
  'lane-', // the wizard's per-source field ids, and `reason: "no-lane-yet"`
  '"task-hub"', // the Settings section id — `/settings#task-hub` must keep resolving
  '"task-hub-spokes"', // the register id declared in scripts/config-registers.mjs
  '"asset-lane"', // ditto — the per-asset data-source register the write lane validates against
  'POST /api/pulse', // the endpoint an asset posts its nightly report to
  'dataforseo_incomplete', // a collector error code, shown as the code it is
  // 3. SQL. A `lanes(…)` CTE is the store's own name.
  'lanes(integration)',
  'lanes.integration',
  'JOIN lanes',
  // Hosted job SQL keeps its stored lane column (doc 14); no UI label does.
  'a.lane',
  'j.lane',
  'PARTITION BY lane ORDER BY',
  'lane=ANY($2::text[])',
  'AND lane=$2 AND occurrence=$3',
  'USING(workspace_id,lane,occurrence)',
  'USING(workspace_id,lane,occurrence,attempt)',
  // 4. SEARCH ALIASES in the command palette's `keywords`, which are matched
  //    against and never rendered: an operator who knows the old word should
  //    still find the page.
  '"beads", "todo"',
  // The task source's id, declared once (apps/tower/shared/task-source.ts):
  // a key and a wire value, never a label.
  'BEADS = "beads"',
  // …and its NAME on the Integrations row: the product a stranger installs,
  // as a provider row names Bing (doc 14, "Beads (a task source)").
  'name: "Beads"',
  '"knobs", "preferences"',
  // 5. A COMMAND PASSED TO A LABELLED BLOCK rather than written inline. The
  //    Settings checklist renders it under "Terminal · run in <repo>" with a
  //    Copy button, which is the labelling doc 14 asks for; it is not inline
  //    prose, so the inline-markup rule below cannot see it.
  'bd init --server',
];

/**
 * The altitude rule (doc 14 § Altitude). "4 / 6 fresh · 12 jobs" on the first
 * screen is the OS talking about itself, so every word has an altitude
 * (business, operational, technical) and a surface shows its own altitude or
 * lower, never higher. These are the BUSINESS surfaces, and the lower
 * altitudes' words that may not reach them.
 *
 * A provider's name may appear on a business surface only as a chart key
 * beside its own line (Bing's blue is always beside the word "Bing"), which
 * the exact phrases below cover; never as a label, an eyebrow or a caption.
 * Widening this list is a doc 14 row, never a quick fix.
 */
const BUSINESS_SURFACES = [
  'apps/tower/src/routes/HomeRoute.tsx',
  'apps/tower/src/routes/home/ClockProposal.tsx',
  'apps/tower/src/routes/asset-detail/OverviewTab.tsx',
  'apps/tower/src/routes/asset-detail/SiteLead.tsx',
  'apps/tower/src/routes/asset-detail/AssetHeader.tsx',
  'apps/tower/src/lib/home-brief.ts',
  'apps/tower/src/lib/site-health.ts',
  'apps/tower/src/components/HighlightCard.tsx',
  // The Sites list is the portfolio's business index.
  'apps/tower/src/routes/AssetsRoute.tsx',
  'apps/tower/src/routes/assets/AssetsTable.tsx',
  'apps/tower/src/hooks/useSiteIssues.ts',
  'apps/tower/src/components/surface/PageAnswer.tsx',
  'apps/tower/src/components/surface/FinishLine.tsx',
  // Money (the portfolio page and its daily revenue panel, which is also a
  // revenue-only site's Overview lead) is a business surface.
  'apps/tower/src/routes/FinancialsRoute.tsx',
  'apps/tower/src/components/DailyRevenuePanel.tsx',
];

const BANNED_ON_BUSINESS = [
  { pattern: /\bprovisional\b/gi, word: 'still counting' },
  { pattern: /\bsnapshots?\b/gi, word: 'the reading, or nothing at all' },
  { pattern: /\bfreshness\b/gi, word: 'data as of …' },
  { pattern: /\bstale\b/gi, word: 'outdated' },
  { pattern: /\bjobs?\b/gi, word: 'nothing — jobs belong to Workflows and System health' },
  { pattern: /\bwatch windows?\b/gi, word: 'being watched · verdict in N days' },
  { pattern: /\bcaptured\b/gi, word: 'nothing — the read\'s mechanics are not the fact' },
  { pattern: /\bGA4\b/g, word: 'people (GA4 only as a chart key)' },
  { pattern: /\bSearch Console\b/g, word: 'search (Search Console only as a chart key)' },
  { pattern: /\bWebmaster\b/g, word: 'search (Bing only as a chart key)' },
  { pattern: /\bMediavine\b/g, word: 'ad revenue' },
  { pattern: /\bPostHog\b/g, word: 'product (PostHog only as a chart key)' },
  { pattern: /\bDataForSEO\b/g, word: 'search position' },
  { pattern: /\bClarity\b/g, word: 'session report' },
];

/** Chart keys and wire values: a provider's name beside its own line, or a
 * `data-*` value the audit reads. Exact phrases, each one a key. */
const ALLOWED_ON_BUSINESS = [
  'name: "GA4"',
  'name: "Google"',
  'name: "Bing"',
  'name: "PostHog"',
  'data-site-lead="posthog"',
  'data-site-lead="clarity"',
  'data-site-lead="rankings"',
  '"posthog"',
  '"clarity"',
  '"rankings"',
  // Material-condition wire values the materiality suite reads (shared/materiality.ts).
  '"signal-freshness"',
];

/** The spans of a file that end up in front of a person: string and template
 * literals, plus JSX text nodes. Offsets are into the original file.
 *
 * A JSX text node may not contain `=`: `</div> ) : spokes.length === 0 ? (`
 * sits between a `>` and a `<` and is code, and prose almost never carries a
 * bare equals sign. Without that the guard reads expressions as labels. */
function shippedSpans(text) {
  const spans = [];
  for (const m of text.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)) {
    spans.push([m.index, m.index + m[0].length]);
  }
  for (const m of text.matchAll(/(?<![=\-!<>])>([^<>{}=]*)<(?=[/A-Za-z])/g)) {
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

/**
 * Is the hit at `at` inside a LABELLED COMMAND — the one context doc 14 keeps
 * `bd` for? Two markings, and only two, because a command an operator pastes
 * has to be exact and has to be visibly a command:
 *
 *   - a `<code className="font-mono">` element, the desk's inline code, or
 *   - an inline backtick pair inside a sentence ("this runtime has no `bd`").
 *
 * The backtick must not be a TEMPLATE LITERAL'S OWN delimiter, which is why the
 * character leading into it is checked: `` : `bd init … ` `` is a command
 * passed to a prop, not inline markup, and it earns an allowlist row above
 * instead of slipping through on punctuation.
 */
function insideLabelledCommand(text, at) {
  const before = text.slice(Math.max(0, at - 160), at);
  if (/<code\b[^<>]*>\s*$/.test(before)) return true;
  const tick = /^([\s\S]*)`[^`\n]*$/.exec(before);
  if (!tick) return false;
  // A backtick that OPENS a template literal follows JS syntax; one that opens
  // inline code follows a word. The last non-space character says which.
  const lead = tick[1].replace(/\s+$/, '').slice(-1);
  return lead !== '' && !/[=(:,+[{;]/.test(lead);
}

const FILES = SCAN_DIRS.flatMap((dir) => sourceFiles(REPO_ROOT, dir, NOT_DESK_COPY));

// A guard that scans nothing passes forever.
test('the lexicon sweep has files to sweep', () => {
  assert.ok(
    FILES.length > 50,
    `only ${FILES.length} Tower source file(s) found — the directory walk did not resolve`,
  );
  for (const name of [
    'apps/tower/src/components/AppShell.tsx',
    'apps/tower/src/routes/tasks/TasksBoard.tsx',
    'apps/tower/src/routes/SettingsRoute.tsx',
  ]) {
    assert.ok(FILES.includes(name), `${name} must be in the scan`);
  }
});

// Every exclusion is a page this guard stops watching, so each one has to still
// be a file — a stale entry silently widens the blind spot.
test('every excluded file still exists', () => {
  for (const name of NOT_DESK_COPY) {
    assert.doesNotThrow(
      () => readFileSync(path.join(REPO_ROOT, name), 'utf8'),
      `${name} is excluded from the lexicon sweep but no longer exists — prune NOT_DESK_COPY`,
    );
  }
});

test('every business surface is in the scan, and exists', () => {
  for (const name of BUSINESS_SURFACES) {
    assert.ok(FILES.includes(name), `${name} is a business surface but not in the lexicon scan`);
  }
});

test('no business surface says a lower altitude\'s word', () => {
  const offenders = [];
  for (const name of BUSINESS_SURFACES) {
    const text = withoutComments(readFileSync(path.join(REPO_ROOT, name), 'utf8'));
    const spans = shippedSpans(text);
    for (const { pattern, word } of BANNED_ON_BUSINESS) {
      for (const hit of text.matchAll(pattern)) {
        const at = hit.index;
        if (!spans.some(([start, end]) => at >= start && at < end)) continue;
        const before = at > 0 ? text[at - 1] : '';
        const after = text[at + hit[0].length] ?? '';
        if (/[A-Za-z0-9_$]/.test(before) || /[A-Za-z0-9_$]/.test(after)) continue;
        const from = Math.max(0, at - 70);
        const window = text.slice(from, at + 70);
        if (coveredByPhrase(window, from, at, ALLOWED_ON_BUSINESS)) continue;
        const line = text.slice(0, at).split('\n').length;
        offenders.push(`${name}:${line}  "${hit[0]}" → ${word}\n      …${window.replace(/\s+/g, ' ').trim()}…`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these business surfaces say a word from a lower altitude (doc 14 § Altitude):\n  ' +
      `${offenders.join('\n  ')}\n` +
      'Say it in business words, move the fact to the surface that owns it, or ' +
      'record the exception as a doc 14 row and an exact phrase in ALLOWED_ON_BUSINESS.',
  );
});

test('no shipped desk string uses an internal coinage (doc 14)', () => {
  const offenders = [];

  for (const name of FILES) {
    const text = withoutComments(readFileSync(path.join(REPO_ROOT, name), 'utf8'));
    const spans = shippedSpans(text);

    for (const { pattern, word } of BANNED) {
      for (const hit of text.matchAll(pattern)) {
        const at = hit.index;
        if (!spans.some(([start, end]) => at >= start && at < end)) continue;

        // Part of a longer identifier (`beadId`, `laneLabel`, `hubHost`) even
        // inside a template literal — still code.
        const before = at > 0 ? text[at - 1] : '';
        const after = text[at + hit[0].length] ?? '';
        if (/[A-Za-z0-9_$]/.test(before) || /[A-Za-z0-9_$]/.test(after)) continue;

        // `bd` is the CLI's own name and stays wherever the string is visibly a
        // command an operator can copy. Nothing else earns that.
        if (word.startsWith('a labelled command') && insideLabelledCommand(text, at)) continue;

        const from = Math.max(0, at - 70);
        const window = text.slice(from, at + 70);
        if (coveredByPhrase(window, from, at, ALLOWED_PHRASES)) continue;

        const line = text.slice(0, at).split('\n').length;
        offenders.push(
          `${name}:${line}  "${hit[0]}" → ${word}\n      …${window.replace(/\s+/g, ' ').trim()}…`,
        );
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'these shipped desk strings still use internal vocabulary ' +
      `(doc 14):\n  ${offenders.join('\n  ')}\n` +
      'Every one of these words is precise for the operator and private for the ' +
      'stranger doc 14 rule 8 asks you to read the screen to. Replace it with the ' +
      'mapped word, or add the row to docs/14-design.md and the exact phrase to ' +
      'ALLOWED_PHRASES in this file with its reason — never widen a pattern. A `bd` ' +
      'command stays verbatim when it is visibly a command: inside a ' +
      '<code className="font-mono"> element, or in backticks inside a sentence.',
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

// The guard has to be able to FAIL, or a broken span reader would read as a
// clean desk. These are the two shapes the sweep is actually about.
test('the guard catches a coinage and spares a labelled command', () => {
  const leak = 'const a = <p>Filed as bead in the project its prefix names.</p>;';
  const text = withoutComments(leak);
  const spans = shippedSpans(text);
  const hits = [...text.matchAll(/\bbeads?\b/gi)].filter(({ index }) =>
    spans.some(([start, end]) => index >= start && index < end),
  );
  assert.equal(hits.length, 1, 'a bead in a JSX text node must be seen');

  const labelled = 'const a = <code className="font-mono">bd ready</code>;';
  const at = labelled.indexOf('bd ready');
  assert.ok(insideLabelledCommand(labelled, at), 'a <code> command must be spared');
  const inline = 'const a = "this runtime has no `bd` command to talk to it";';
  assert.ok(
    insideLabelledCommand(inline, inline.indexOf('bd`')),
    'a backticked command inside a sentence must be spared',
  );
  const propArg = 'const init = hub === null ? null : `bd init --server`;';
  assert.equal(
    insideLabelledCommand(propArg, propArg.indexOf('bd init')),
    false,
    "a template literal's own delimiter is not inline markup",
  );
});

test('SQL table-name exemptions do not exempt nearby user-facing vocabulary', () => {
  const sql = 'SELECT l.integration FROM assets a JOIN lanes l ON l.asset = a.id';
  assert.equal(coveredByPhrase(sql, 0, sql.indexOf('lanes'), ALLOWED_PHRASES), true);
  const prose = 'JOIN lanes is stored SQL. These lanes are shown on the desk.';
  assert.equal(coveredByPhrase(prose, 0, prose.lastIndexOf('lanes'), ALLOWED_PHRASES), false);
});

// ---------------------------------------------------------------------------
// The word a person reads for a site
// ---------------------------------------------------------------------------
// Everything a person reads says *site*: the navigation, the index page,
// headings, columns, counts, empty states, the palette, hover and
// screen-reader text. Code keeps *asset*: `/assets` and `/assets/:id`, the
// `assets` table and its `asset` columns, `/api/assets`, asset ids, `asset:`
// task labels, query keys and DOM ids. So *asset* cannot simply join BANNED
// (it is the most common identifier in the Tower), and an exact-phrase
// allowlist would be a list of every query key in the product.
//
// WHAT IT READS is the UX gate's own answer to "what does a person read"
// (`extractVisibleStrings` in `scripts/ux-gate.mjs`, one derivation): JSX
// paragraphs and every string that can reach the screen or a screen reader,
// with class lists, ids, `data-*`, `to`/`href`, types, property names,
// comparisons, imports and SQL already set aside. Inside what is left, three
// shapes are still code, and nothing else is:
//
//   - a path, the word right after a `/` (a route, an API URL, a JSON
//     pointer), or a qualified name right after a `.` (`f.asset`), or a bound
//     SQL column too short for the gate's SQL test (`asset = ?`);
//   - a string that is ONE lowercase token (`"asset"`, `"asset-detail"`,
//     `"per-asset"`, `asset:${id}`): a URL parameter, a query key, a step id
//     or a task label, unless it is handed to a prop a person reads (`label`,
//     `title`, `placeholder`, an accessible name);
//   - an identifier inside a longer string, named in SITE_NOUN_IDENTIFIERS.
//
// And one shape is copy wherever it sits: singular and plural side by side in
// a conditional (`n === 1 ? "asset" : "assets"`), which is how "1 assets" is
// born. A count of sites is written by `siteCount()` / `siteNoun()` in
// `apps/tower/shared/site-noun.ts`, so a hand-rolled `? "site" : "sites"`
// fails too, anywhere but in that helper.
//
// It reads the Tower's source, `scripts/config-registers.mjs` (the labels,
// `surface` lines and refusals `/settings` renders verbatim),
// `scripts/scheduled-jobs.mjs` (the job names and categories Settings → Data
// collection and Workflows render) and `config/integrations.json` (the
// data-source catalog the Integrations page and a site's Sources tab render).
// The UX gate still reads every config document.

const SITE_NOUN = /\bassets?\b/gi;

/** A prop whose value a person reads or hears — even one lowercase word. */
const PROSE_CONTEXT =
  /^(?:label|title|aria-label|ariaLabel|placeholder|hint|caption|heading|description|detail|empty|emptyHint|message|headline|note|explanation|seriesUnavailable)[=:]$/;

/** Singular and plural side by side in a conditional: a count noun. */
const COUNT_NOUN = /\?\s*(["'`])(?:asset|site)s?\1\s*:\s*(["'`])(?:asset|site)s?\2/gi;

/** The one place a count of sites may choose its own noun. */
const SITE_COUNT_HELPER = 'apps/tower/shared/site-noun.ts';

/** The site-noun rule's corpus: the Tower, the Settings declarations, the
 * scheduled jobs' names and the product's config documents that carry prose. */
const SITE_NOUN_FILES = [
  ...FILES,
  'scripts/config-registers.mjs',
  'scripts/scheduled-jobs.mjs',
  'config/integrations.json',
];

/**
 * Identifiers that sit INSIDE a multi-word visible string, where no shape rule
 * can see them. Exact phrases; each is code a person does not read as the noun.
 */
const SITE_NOUN_IDENTIFIERS = [
  'db · assets row', // an owner chip naming the `assets` table it writes (doc 14 owner-chip row)
];

let ts;
const typescript = () => (ts ??= loadTypeScript([REPO_ROOT]));

/** Is this `asset` hit, at `at` in one visible string, code? */
function siteNounIsCode(entry, at, word) {
  const { text } = entry;
  const before = at > 0 ? text[at - 1] : '';
  const after = text[at + word.length] ?? '';
  // Part of a longer identifier (`assetId`, `ASSET_TOKENS`, `asset_id`).
  if (/[A-Za-z0-9_$]/.test(before) || /[A-Za-z0-9_$]/.test(after)) return true;
  // A path or a qualified name.
  if (before === '/' || before === '.') return true;
  if (after === '.' && /[A-Za-z_]/.test(text[at + word.length + 1] ?? '')) return true;
  // A SQL fragment too short for the gate's SQL test: a bound `asset = ?`.
  if (/^\s*=\s*\?/.test(text.slice(at + word.length))) return true;
  // One lowercase token: an identifier, unless a prose prop receives it.
  const oneToken = !/\s/.test(text.trim());
  if (oneToken && word[0] === word[0].toLowerCase()) {
    return !(entry.kind === 'accessible' || PROSE_CONTEXT.test(entry.context));
  }
  const from = Math.max(0, at - 70);
  return coveredByPhrase(text.slice(from, at + 70), from, at, SITE_NOUN_IDENTIFIERS);
}

/** Every place one Tower source file says asset to a person. */
function siteNounOffenders(name, source) {
  const found = [];
  const lineAt = (at) => source.slice(0, at).split('\n').length;

  // A count noun is copy even where the literal scan would call each half one
  // lowercase token, so it is read off the source with comments removed.
  if (name !== SITE_COUNT_HELPER) {
    for (const m of commentsBlanked(source).matchAll(COUNT_NOUN)) {
      found.push(`${name}:${lineAt(m.index)}  "${m[0]}"  (a count: siteCount() or siteNoun() from @shared/site-noun)`);
    }
  }

  for (const entry of extractVisibleStrings(source, name, typescript())) {
    for (const hit of entry.text.matchAll(SITE_NOUN)) {
      if (siteNounIsCode(entry, hit.index, hit[0])) continue;
      found.push(`${name}:${entry.line}  "${hit[0]}"  (${entry.context})\n      …${entry.text.slice(0, 140)}…`);
    }
  }
  return found;
}

test('no shipped desk string calls a site an asset, and every site count uses the helper', () => {
  assert.ok(SITE_NOUN_FILES.includes(SITE_COUNT_HELPER), `${SITE_COUNT_HELPER} must be in the scan`);
  const offenders = SITE_NOUN_FILES.flatMap((name) =>
    siteNounOffenders(name, readFileSync(path.join(REPO_ROOT, name), 'utf8')),
  );
  assert.deepEqual(
    offenders,
    [],
    `these shipped desk strings still say asset where a person reads it:\n  ${offenders.join('\n  ')}\n` +
      'A person reads *site*: "Sites", "1 site", "this site", "Every site". Code keeps asset — ' +
      'a route or API path, SQL, a query key, a DOM id or a task label passes on its own shape. ' +
      'An identifier inside a multi-word string goes in SITE_NOUN_IDENTIFIERS with its reason; ' +
      'never widen a rule to let copy through.',
  );
});

test('every site-noun identifier phrase still matches something', () => {
  const corpus = SITE_NOUN_FILES.map((name) => readFileSync(path.join(REPO_ROOT, name), 'utf8')).join('\n');
  const unused = SITE_NOUN_IDENTIFIERS.filter((phrase) => !corpus.includes(phrase));
  assert.deepEqual(
    unused,
    [],
    `these site-noun exemptions no longer match anything in the Tower — delete them:\n  ${unused.join('\n  ')}`,
  );
});

// The guard has to be able to FAIL, and to pass code, or a broken reader would
// read as a clean desk. One line per shape the rule decides on.
test('the site-noun guard tells copy from code', () => {
  const copy = [
    'const a = () => <PageHeader title="Assets" />;',
    'const a = () => <p>No asset matches.</p>;',
    'const a = () => <select aria-label="asset" />;',
    'const a = (n: number) => `${n} ${n === 1 ? "asset" : "assets"}`;',
    'const a = { label: "All assets" };',
    'const a = (n: number) => `${n} ${n === 1 ? "site" : "sites"}`;',
    'const a = () => <option value="all">Every asset</option>;',
  ];
  const code = [
    'const a = () => <Link to="/assets" />;',
    'const a = (id: string) => fetch(`/api/assets/${id}`);',
    'const a = (id: string) => navigate(`/assets/${id}/sources`);',
    'const a = (db: Db) => db.prepare(`SELECT id FROM assets WHERE asset = ?`);',
    'const a = (params: URLSearchParams) => params.get("asset");',
    'const a = (id: string) => ["asset-detail", id];',
    'const a = (id: string) => `asset:${id}`;',
    'const a = (id: string) => <div data-status-for={`asset-setup:${id}`} />;',
    'const a = () => <select id="alerts-asset" />;',
  ];
  const offendersIn = (line) => siteNounOffenders('probe.tsx', line).length;
  for (const line of copy) assert.ok(offendersIn(line) > 0, `copy must fail: ${line}`);
  for (const line of code) assert.equal(offendersIn(line), 0, `code must pass: ${line}`);
});

// ---------------------------------------------------------------------------
// The second corpus: the sentences the Tower does not write
// ---------------------------------------------------------------------------
// Half the prose on the Data-sources surfaces is not in `apps/tower/` at all.
// The Sources tab and `/health` render `config/integrations.json` verbatim
// (each lane's label), and `/settings` renders the field labels and `describe`
// lines out of `scripts/config-registers.mjs`, where the write lane's
// declarations live. A guard that reads only the app would let the vocabulary
// back in through a file nobody thinks of as copy.
const CONFIG_SOURCES = ['scripts/config-registers.mjs'];
// The product defaults that carry prose. Per-asset notes and tracked queries
// are one installation's own words, kept in its installation folder, not
// product copy.
const CONFIG_JSON = [
  'config/integrations.json',
];

/**
 * Exact strings in the config corpus that are NOT copy. Two kinds:
 * STORED VALUES the register declarations and the files both match on (renaming
 * one is a data migration), and the register/key ids the write lane validates
 * against.
 */
const CONFIG_ALLOWED_PHRASES = [
  // The `reason` enum, in the declaration AND in the rows already written with
  // it. Bare, because the JSON walker yields a VALUE and the declaration a
  // quoted literal, and one exemption should cover the same stored word twice.
  'live-lanes',
  'no-lane-yet',
  "'/spokes'", // the JSON pointer into config/beads.json the projects register writes
  "'asset-lane'", // the per-asset data-source register's id
  "'lane-id'", // its key rule, resolved by KEY_RULE_SOURCE
  "'task-hub-spokes'", // the Settings projects register's id
  'config/beads.json', // the file that register writes — an owner path
  'config/beads.README.md',
];

// A guard that scans nothing passes forever.
test('the config corpus has prose to scan', () => {
  for (const name of CONFIG_SOURCES) {
    const text = readFileSync(path.join(REPO_ROOT, name), 'utf8');
    assert.ok(text.length > 1000, `${name} did not resolve`);
  }
  for (const name of CONFIG_JSON) {
    const values = [...stringValues(JSON.parse(readFileSync(path.join(REPO_ROOT, name), 'utf8')))];
    assert.ok(values.length > 5, `${name} yielded only ${values.length} string value(s)`);
  }
});

test('no operator-visible config string uses an internal coinage (doc 14)', () => {
  const offenders = [];
  const phrases = [...ALLOWED_PHRASES, ...CONFIG_ALLOWED_PHRASES];

  /** One hit, judged the same way the Tower scan judges one. */
  const check = (label, haystack, at, matched, word) => {
    const before = at > 0 ? haystack[at - 1] : '';
    const after = haystack[at + matched.length] ?? '';
    if (/[A-Za-z0-9_$]/.test(before) || /[A-Za-z0-9_$]/.test(after)) return;
    if (word.startsWith('a labelled command') && insideLabelledCommand(haystack, at)) return;
    const from = Math.max(0, at - 70);
    const window = haystack.slice(from, at + 70);
    if (coveredByPhrase(window, from, at, phrases)) return;
    offenders.push(`${label}  "${matched}" → ${word}\n      …${window.replace(/\s+/g, ' ').trim()}…`);
  };

  // The declarations: shipped literals only, exactly as in the Tower.
  for (const name of CONFIG_SOURCES) {
    const text = withoutComments(readFileSync(path.join(REPO_ROOT, name), 'utf8'));
    const spans = shippedSpans(text);
    for (const { pattern, word } of BANNED) {
      for (const hit of text.matchAll(pattern)) {
        if (!spans.some(([start, end]) => hit.index >= start && hit.index < end)) continue;
        const line = text.slice(0, hit.index).split('\n').length;
        check(`${name}:${line}`, text, hit.index, hit[0], word);
      }
    }
  }

  // The files: every string VALUE, whatever key holds it.
  for (const name of CONFIG_JSON) {
    const parsed = JSON.parse(readFileSync(path.join(REPO_ROOT, name), 'utf8'));
    for (const [at, value] of stringValues(parsed)) {
      for (const { pattern, word } of BANNED) {
        for (const hit of value.matchAll(pattern)) {
          check(`${name} ${at}`, value, hit.index, hit[0], word);
        }
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'these config strings reach the operator and still use internal vocabulary ' +
      `(doc 14):\n  ${offenders.join('\n  ')}\n` +
      'The Tower renders these verbatim — the register labels and describe lines on ' +
      '/settings, the lane labels and per-site notes on a Sources tab ' +
      'and /health. A stored value or a register id belongs in CONFIG_ALLOWED_PHRASES ' +
      'with its reason; never widen a pattern.',
  );
});

// The same pruning discipline, over the corpus this list actually guards.
test('every config exemption still matches something', () => {
  const corpus = [
    ...CONFIG_SOURCES.map((name) => readFileSync(path.join(REPO_ROOT, name), 'utf8')),
    ...CONFIG_JSON.map((name) => readFileSync(path.join(REPO_ROOT, name), 'utf8')),
  ].join('\n');
  const unused = CONFIG_ALLOWED_PHRASES.filter((phrase) => !corpus.includes(phrase));
  assert.deepEqual(
    unused,
    [],
    `these config exemptions no longer match anything — delete them:\n  ${unused.join('\n  ')}`,
  );
});
