#!/usr/bin/env node
// A SCREEN THAT NEEDS A PARAGRAPH TO BE USED IS A SCREEN TO REDESIGN
// (operator, 2026-09-23; bead `ro-ujb9.94`).
//
// "If interactions need footnotes or a 'paragraph' of explanation, that's a
// huge UX red flag. We should minimize instances of this by rethinking a
// simple, intuitive flow, instead of piling on instructions, descriptions,
// directions." Doc 21 already said prose belongs behind one `About`; the desk
// kept growing it anyway, one honest sentence at a time, because a rule an
// agent has to go and read is a rule most agents never meet. The operator's
// second instruction was the fix: "codify/gatify this so any agent who does
// work on UX in the future encounters a hard stop".
//
// This is that stop. It is the sister of `scripts/ui-lexicon.test.mjs` (which
// bans words) and it reads that corpus — `apps/tower/{src,shared,worker}` minus
// the same few files that are not desk copy — plus every module and config
// document the Tower imports from outside it (bead `ro-ujb9.96.6.13`: the
// config registers, the contract catalog, `config/*.json`, the job
// descriptions), and the ingest Worker the Tower calls through its service
// binding (bead `ro-ujb9.96.6.24`). It judges LENGTH: every single visible
// string is measured in words, and one over its budget is explanatory prose.
//
// The budgets (labels 12, failures 18, accessible names 24), the directories
// read and the files skipped live in `scripts/ux-gate.settings.json`, a file
// agents cannot loosen (bead `ro-ujb9.96.3`, see "The gate's own rules").
//
// WHAT COUNTS AS VISIBLE. Everything that can reach a person is PRESUMED
// visible, and only positions that provably cannot are excluded. The Tower
// invents a new prop for its explanations every few weeks — `hint`, `help`,
// `explain`, `explanation`, `emptyHint`, `footnote`, `seriesUnavailable`,
// `describe`, `rationale`, `nextStep`, `quotaReality`, `degradation` all
// carried paragraphs on 2026-09-23 — so an allow-list of prop names would be
// the gate agents walk around. The exclusions (className and class-building
// calls, data-*/id/key/href-style attributes, import specifiers, type
// positions, property names, comparisons, console and other terminal output,
// SQL, SVG geometry) are listed below, each for its reason.
//
// A JSX paragraph is one string: `<p>Text <strong>bold</strong> more</p>` is
// measured whole, because that is what the reader reads. So is a sentence
// joined with `+` (bead `ro-ujb9.96.11`): `'Twelve words… ' + 'twelve more'`
// is one 24-word string, never two short ones. `About` and
// `InfoTooltip` content is measured like any other: hiding a paragraph behind
// a disclosure is still shipping a paragraph.
//
// THE RATCHET. `apps/tower/ux-budget.json` records today's offenders per file
// (count and words). A file may not gain either. `pnpm ux:baseline` lowers the
// record when text is removed and can never raise it; a raise is the
// operator's hand edit and must carry a `"kind"` from a closed set
// (trust-safety, legal, destructive-confirmation — everything else is
// redesigned), `"approvedBy": "<bead id>"`, a `"reason"`, and
// `"priorArt": "docs/briefs/<flow>.md#<section>"` — a section citing at least
// three researched comparable products, because the operator's order for a
// stopped agent is to research the best modern comparable first.
// The git history of the file is audited so a raise cannot slip in unapproved.
//
// EVERY FAILURE names the violation first and ends with the same fixed
// instructions (`NEXT_STEPS`): the failure is the one text a stopped agent is
// guaranteed to read.
//
// Usage:
//   node scripts/ux-gate.mjs                    everything the Tower renders vs the baseline
//   node scripts/ux-gate.mjs --files a.tsx ...  just these files (edit time)
//   node scripts/ux-gate.mjs --staged           staged files the Tower renders (pre-commit)
//   node scripts/ux-gate.mjs --list             every offender, worst first
//   node scripts/ux-gate.mjs --write-baseline   lower the baseline (never raises)
//   node scripts/ux-gate.mjs --widen <bead> --reason "…"
//                                               record once what a widened gate newly reads
//   add --json for machine-readable output, --root <dir> for another checkout

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readablePath } from './installation.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Is the module at `url` the script node was asked to run? Compared by real
 * path: the pre-commit hook and a symlinked temp dir (macOS /var → /private/var)
 * name the same file two ways. */
export function invokedDirectly(url) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

export const GATE_BEAD = 'ro-ujb9.94';
export const BASELINE_FILE = 'apps/tower/ux-budget.json';

// ---------------------------------------------------------------------------
// The gate's own rules live in a data file the agents cannot loosen
// ---------------------------------------------------------------------------
//
// Bead `ro-ujb9.96.3`. The budgets, the directories always read, the files
// imports are followed from and the files never read used to be constants
// in this script: one commit could add a Tower file to the skip list, put a
// paragraph in it, and pass CI, the commit hook and the edit hook. They now
// live in `SETTINGS_FILE`, which the edit hook protects like the baseline and
// whose every change is judged like a baseline raise: TIGHTENING is free; a
// raised budget or a new skipped file carries the same four-key approval; a
// scan directory or trace root leaves only when it no longer exists; and the
// git history of the file is audited, from the commit that introduced it
// (judged against `LEGACY_SETTINGS`, the constants it replaced).
//
//   budgets.label       12  a heading, button, caption or state line
//   budgets.failure     18  a failure must say what happened AND what to do,
//                           so it gets one clause more
//   budgets.accessible  24  aria-label / alt / sr-only text: a screen reader
//                           names a whole chart or control in one breath
//   scanDirs                every file under these is read (`shared/` and
//                           `worker/` build the sentences the desk renders)
//   traceRoots              read for their imports only: the Vite config
//                           compiles every config document into the bundle
//   notDeskCopy             files never read, each with its reason

export const SETTINGS_FILE = 'scripts/ux-gate.settings.json';
export const BUDGET_KINDS = Object.freeze(['label', 'failure', 'accessible']);
export const SETTINGS_KEYS = Object.freeze(['about', 'budgets', 'scanDirs', 'traceRoots', 'notDeskCopy']);

/** The constants the settings file replaced: the tightest rules history
 * knows, and what the file's first commit is judged against. */
export const LEGACY_SETTINGS = Object.freeze({
  budgets: { label: { words: 12 }, failure: { words: 18 }, accessible: { words: 24 } },
  scanDirs: ['apps/tower/src', 'apps/tower/shared', 'apps/tower/worker'],
  traceRoots: ['apps/tower/vite.config.ts'],
  notDeskCopy: {
    'apps/tower/worker/mcp-route.ts': { reason: 'speaks to agents: its tool descriptions are a published interface' },
    'apps/tower/src/components/registry.ts': { reason: 'the machine-readable component index (doc 14), documentation for agents' },
    'apps/tower/src/routes/KitchenSinkRoute.tsx': { reason: 'the /dev gallery, rendered only under import.meta.env.DEV' },
    'apps/tower/src/routes/AssetStateGalleryRoute.tsx': { reason: 'the /dev asset-state gallery, rendered only under import.meta.env.DEV' },
    'apps/tower/shared/materiality.ts': { reason: 'the material-state contract: a record read by a test, rendered nowhere' },
    'apps/tower/src/lib/task-handoff.ts': { reason: 'writes the task command an agent runs; the command is the payload' },
    'apps/tower/src/lib/page-decision-markdown.ts': { reason: 'writes the Markdown brief "Copy Markdown" hands to an agent; a document, not a screen' },
    'apps/tower/src/lib/query-decision-markdown.ts': { reason: 'writes the Markdown brief "Copy Markdown" hands to an agent; a document, not a screen' },
  },
});

/** The rules as the gate uses them. A malformed or missing file falls back
 * to `LEGACY_SETTINGS` here (so the gate can still run and say so); the
 * whole-Tower check reports the file itself as a failure. */
export function normalizeSettings(json) {
  const source = json && typeof json === 'object' ? json : LEGACY_SETTINGS;
  const budgets = {};
  for (const kind of BUDGET_KINDS) {
    const words = source.budgets?.[kind]?.words;
    budgets[kind] = Number.isInteger(words) && words > 0 ? words : LEGACY_SETTINGS.budgets[kind].words;
  }
  const paths = (value, fallback) => (Array.isArray(value) && value.every((item) => typeof item === 'string') ? [...value] : [...fallback]);
  const notDeskCopy = new Map();
  const skipped = source.notDeskCopy && typeof source.notDeskCopy === 'object' ? source.notDeskCopy : LEGACY_SETTINGS.notDeskCopy;
  for (const [file, entry] of Object.entries(skipped)) notDeskCopy.set(file, String(entry?.reason ?? ''));
  return Object.freeze({
    budgets: Object.freeze(budgets),
    scanDirs: Object.freeze(paths(source.scanDirs, LEGACY_SETTINGS.scanDirs)),
    traceRoots: Object.freeze(paths(source.traceRoots, LEGACY_SETTINGS.traceRoots)),
    notDeskCopy,
  });
}

/** The settings file's JSON in `root`, or null when it is absent. */
export function readSettingsJson(root = REPO_ROOT) {
  const file = path.join(root, SETTINGS_FILE);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** The rules for the checkout at `root` (its own settings file). */
export function readSettings(root = REPO_ROOT) {
  try {
    return normalizeSettings(readSettingsJson(root));
  } catch {
    return normalizeSettings(null);
  }
}

/** This checkout's rules: what every function uses unless handed another
 * checkout's (the edit hook judges a worktree by the worktree's own file). */
export const SETTINGS = readSettings(REPO_ROOT);

export const LABEL_WORD_BUDGET = SETTINGS.budgets.label;
export const FAILURE_WORD_BUDGET = SETTINGS.budgets.failure;
export const ACCESSIBLE_NAME_WORD_BUDGET = SETTINGS.budgets.accessible;
export const BUDGETS = SETTINGS.budgets;
export const SCAN_DIRS = SETTINGS.scanDirs;
export const TRACE_ROOTS = SETTINGS.traceRoots;
export const NOT_DESK_COPY = SETTINGS.notDeskCopy;

const PLACEHOLDER = '${…}';

// ---------------------------------------------------------------------------
// Loading TypeScript
// ---------------------------------------------------------------------------

let typescript = null;

/** The compiler is a Tower devDependency, not a root one (pnpm does not hoist
 * it), so it is resolved from the workspace that owns it. `roots` lets a hook
 * running from one checkout measure a file in another (a worktree without its
 * own `node_modules`). */
export function loadTypeScript(roots = [REPO_ROOT]) {
  if (typescript) return typescript;
  const tried = [];
  for (const root of [...roots, REPO_ROOT]) {
    for (const owner of ['apps/tower', 'packages/contract']) {
      const manifest = path.join(root, owner, 'package.json');
      tried.push(manifest);
      try {
        typescript = createRequire(manifest)('typescript');
        return typescript;
      } catch {
        // try the next owner
      }
    }
  }
  throw new Error(`ux-gate: cannot load the typescript package (run pnpm install). Tried:\n  ${tried.join('\n  ')}`);
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** A word is a whitespace-separated token carrying a letter or a digit, or a
 * `${…}` interpolation (which renders as at least one word). Separators such
 * as `·` and `—` are not words. */
export function countWords(text) {
  let words = 0;
  for (const token of String(text).split(/\s+/)) {
    if (!token) continue;
    if (/[\p{L}\p{N}]/u.test(token) || token.includes(PLACEHOLDER)) words++;
  }
  return words;
}

const collapse = (text) => String(text).replace(/\s+/g, ' ').trim();
const hasLetters = (text) => /\p{L}/u.test(String(text).replaceAll(PLACEHOLDER, ''));

// ---------------------------------------------------------------------------
// What is not visible
// ---------------------------------------------------------------------------

/** Attribute, prop, key and variable names whose values never reach a reader
 * as text: styling, identity, routing, wiring, SVG geometry, and the
 * id-reference aria attributes. */
const NON_VISIBLE_NAMES = new Set([
  'className', 'class', 'style', 'key', 'id', 'htmlFor', 'role', 'type', 'href', 'src', 'srcSet',
  'to', 'rel', 'target', 'method', 'accept', 'autoComplete', 'inputMode', 'pattern', 'lang', 'dir',
  'd', 'points', 'viewBox', 'transform', 'fill', 'stroke', 'strokeDasharray', 'clipPath', 'mask',
  'xmlns', 'ref', 'form', 'sql', 'testId',
  'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant',
  'aria-errormessage', 'aria-details', 'aria-flowto',
]);

/** A value that is a class list: `pillControlClass`, `rowClassName`, `classes`. */
const CLASS_NAME_RE = /(?:^class(?:es)?$|Class(?:Name|Names|es)?$|^classNames?$)/;

/** Accessibility-only text, which gets `ACCESSIBLE_NAME_WORD_BUDGET`. */
const ACCESSIBLE_NAME_RE =
  /^(?:aria-(?:label|description|roledescription|valuetext|placeholder|braillelabel)|alt|aria(?:Label|Description)|[A-Za-z]+Aria(?:Label|Description)|srLabel|screenReader[A-Za-z]*)$/;

/** A component prop that renders ONLY as an accessible name. `InfoTooltip`'s
 * `label` becomes the trigger's and the panel's aria-label, and nothing else. */
const ACCESSIBLE_ONLY_PROPS = new Map([['InfoTooltip', new Set(['label'])]]);

/** Names that say the text is a failure or refusal, which gets
 * `FAILURE_WORD_BUDGET`. Matched on attribute, key, variable and function
 * names, and on the condition that guards a JSX branch (`error ? … : …`). */
const FAILURE_NAME_RE = /(?:error|fail|refus|reject|invalid|problem|denied|forbidden|blocked)/i;

/** Calls whose string arguments are class lists, log lines, module specifiers,
 * SQL, selectors or storage keys — never rendered text. Matched against the
 * callee's last name segment. */
const NON_VISIBLE_CALLS = new Set([
  'cn', 'clsx', 'cva', 'cx', 'twMerge', 'classNames',
  'require', 'prepare', 'exec', 'querySelector', 'querySelectorAll', 'getElementById', 'matchMedia',
  'RegExp', 'URL', 'fetch', 'addEventListener', 'removeEventListener', 'setAttribute',
  'getAttribute', 'getItem', 'setItem', 'removeItem',
]);

/** Output to a terminal, never the Tower, like `console.*`: a CLI's
 * `process.stdout/stderr.write` and a dev server's `logger.*` (the Vite
 * plugins and `scripts/` modules the Tower imports print through these).
 * Matched against the callee's full name. */
const TERMINAL_CALL_RE = /^(?:process\.(?:stdout|stderr)\.write|(?:[\w$]+\.)*logger\.(?:error|warn|warnOnce|info|debug|log))$/;

const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'kbd', 'mark', 'q',
  's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'Link', 'NavLink',
]);
const BREAK_TAGS = new Set(['br', 'wbr']);
const DISCLOSURE_TAGS = new Set(['About', 'InfoTooltip', 'details', 'EvidencePopover']);

/** Tailwind utilities that carry no hyphen, so a class list can be recognised
 * by shape where it travels through a variable the name rules cannot see. */
const UTILITY_WORDS = new Set([
  'flex', 'grid', 'block', 'inline', 'hidden', 'contents', 'table', 'relative', 'absolute', 'fixed',
  'sticky', 'static', 'border', 'rounded', 'truncate', 'underline', 'italic', 'uppercase',
  'lowercase', 'capitalize', 'shrink', 'grow', 'group', 'peer', 'container', 'invisible', 'visible',
  'transform', 'transition', 'shadow', 'outline', 'ring', 'antialiased', 'isolate', 'grayscale',
  'blur', 'filter', 'resize', 'collapse', 'ordinal', 'prose', 'sr-only',
]);

/** Is this a class list (every token a utility, most of them hyphenated)? */
export function looksLikeClassList(text) {
  const tokens = collapse(text).replaceAll(PLACEHOLDER, '').split(' ').filter(Boolean);
  if (tokens.length < 3) return false;
  if (!tokens.every((token) => /^[!a-z0-9:[\]/.%#()&>*=,@~+_'"-]+$/.test(token))) return false;
  if (tokens.some((token) => /[.,]$/.test(token) && !token.includes('['))) return false;
  const utility = tokens.filter((token) => /[-:[/]/.test(token) || UTILITY_WORDS.has(token)).length;
  return utility / tokens.length >= 0.6;
}

const SQL_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT', 'INNER', 'GROUP', 'ORDER', 'BY', 'LIMIT', 'VALUES',
  'COALESCE', 'INSERT', 'UPDATE', 'DELETE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'UNION', 'HAVING',
  'DISTINCT', 'IS', 'NULL', 'AND', 'OR', 'AS', 'IN', 'INTO', 'SET', 'ON', 'CONFLICT', 'EXISTS', 'ASC',
  'DESC',
]);

/** Is this SQL? A statement, a fragment with three or more upper-case
 * keywords (`… IS NOT NULL AND …`), or a column list (`id, pulse_id AS
 * pulseId, …`: a keyword beside snake_case identifiers). Prose in this repo
 * shouts the odd word ("PAUSED, not failed"), never three SQL keywords. */
export function looksLikeSql(text) {
  const clean = collapse(text);
  if (/^(?:SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|DROP|PRAGMA|REPLACE)\b/.test(clean)) return true;
  // One line of a column list: an expression named with `AS snake_case,`.
  if (/\(.*\) AS [a-z][a-z0-9]*_[a-z0-9_]*,?$/.test(clean)) return true;
  const tokens = clean.split(' ').map((token) => token.replace(/^[('"]+|[),;'"]+$/g, ''));
  const keywords = tokens.filter((token) => SQL_KEYWORDS.has(token)).length;
  const snake = tokens.filter((token) => /^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(token)).length;
  return keywords >= 3 || (keywords >= 1 && snake >= 2);
}

/** Is this a GraphQL document (`query Name($id: ID!) { … }`)? A client the
 * ingest calls through (packages/mediavine) sends its queries as strings. */
export function looksLikeGraphql(text) {
  return /^(?:query|mutation|subscription|fragment)\b[^{}]*\{[\s\S]*\}$/.test(collapse(text));
}

const ENTITIES = {
  amp: '&', apos: "'", quot: '"', lt: '<', gt: '>', nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”',
  ldquo: '“', mdash: '—', ndash: '–', hellip: '…', middot: '·', times: '×', rarr: '→', larr: '←',
};

/** JSX text carries HTML entities verbatim; the reader sees the character. */
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Every visible string in one source file, with its kind and word count.
 *
 * `renderErrorsShown` says whether the Tower has an error boundary that
 * renders a caught error's message (`errorBoundaryShowsMessages`). Without
 * one, a message thrown while a component or hook renders reaches only the
 * console, so it is developer text and not counted (bead `ro-ujb9.96.4`).
 * Unknown means shown: the default never under-counts.
 *
 * @returns {{ line: number, start: number, end: number, text: string,
 *   words: number, kind: 'label'|'failure'|'accessible', context: string }[]}
 */
export function extractVisibleStrings(source, fileName, ts = loadTypeScript(), { renderErrorsShown = true } = {}) {
  // A config document is read with the same rules: a string value is judged
  // by its key (`note`, `label`, `error`…), and a key itself is code.
  const scriptKind = fileName.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : fileName.endsWith('.json')
      ? ts.ScriptKind.JSON
      : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
  const consumed = new Set();
  const found = [];

  const lineOf = (node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const tagName = (element) => {
    const opening = ts.isJsxElement(element) ? element.openingElement : element;
    return opening.tagName.getText(file);
  };
  const attributesOf = (element) => {
    const opening = ts.isJsxElement(element) ? element.openingElement : element;
    return opening.attributes.properties;
  };
  const attribute = (element, name) => {
    for (const property of attributesOf(element)) {
      if (ts.isJsxAttribute(property) && property.name.getText(file) === name) return property;
    }
    return null;
  };
  const attributeText = (element, name) => {
    const found = attribute(element, name);
    if (!found?.initializer) return null;
    if (ts.isStringLiteral(found.initializer)) return found.initializer.text;
    return found.initializer.getText(file);
  };

  const isPlus = (node) => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;

  /** The operands of a `+` chain, left to right and through parentheses:
   * `a + (b + c)` is `[a, b, c]`. */
  const plusOperands = (node) => {
    if (isPlus(node)) return [...plusOperands(node.left), ...plusOperands(node.right)];
    if (ts.isParenthesizedExpression(node) && isPlus(node.expression)) return plusOperands(node.expression);
    return [node];
  };

  const longestLeaf = (leaves) => leaves.reduce((a, b) => (countWords(b.text) > countWords(a.text) ? b : a));

  /** The text a string expression renders, or null when it is not a string.
   * Conditionals and `??`/`||` yield every branch; `&&` yields its right side.
   * A `+` chain holding a string is ONE string (bead `ro-ujb9.96.11`): a
   * sentence cut into short pieces is read whole, each operand's longest
   * branch in place and anything else as `${…}`. */
  const stringLeaves = (node) => {
    if (!node) return null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return [{ node, text: node.text }];
    }
    if (ts.isTemplateExpression(node)) {
      const text = node.head.text + node.templateSpans.map((span) => PLACEHOLDER + span.literal.text).join('');
      return [{ node, text }];
    }
    if (ts.isParenthesizedExpression(node)) return stringLeaves(node.expression);
    if (ts.isConditionalExpression(node)) {
      const a = stringLeaves(node.whenTrue);
      const b = stringLeaves(node.whenFalse);
      return a && b ? [...a, ...b] : null;
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return stringLeaves(node.right);
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        const a = stringLeaves(node.left);
        const b = stringLeaves(node.right);
        return a && b ? [...a, ...b] : null;
      }
      if (op === ts.SyntaxKind.PlusToken) {
        const parts = plusOperands(node).map((operand) => stringLeaves(operand));
        if (!parts.some(Boolean)) return null; // arithmetic
        const chosen = parts.filter(Boolean).map(longestLeaf);
        const text = parts.map((leaves) => (leaves ? longestLeaf(leaves).text : PLACEHOLDER)).join('');
        return [{ node, text, chosen: chosen.flatMap((leaf) => leaf.chosen ?? [leaf.node]) }];
      }
    }
    return null;
  };

  /** Mark what `stringLeaves` read of an expression — its literals and the
   * `+` joining them — as measured, so the second pass does not measure a
   * piece again. */
  const consumeString = (node) => {
    if (!node || !stringLeaves(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      consumed.add(node);
    } else if (ts.isParenthesizedExpression(node)) {
      consumeString(node.expression);
    } else if (ts.isConditionalExpression(node)) {
      consumeString(node.whenTrue);
      consumeString(node.whenFalse);
    } else if (isPlus(node)) {
      const markChain = (part) => {
        if (ts.isParenthesizedExpression(part) && isPlus(part.expression)) markChain(part.expression);
        else if (isPlus(part)) {
          consumed.add(part);
          markChain(part.left);
          markChain(part.right);
        }
      };
      markChain(node);
      for (const operand of plusOperands(node)) consumeString(operand);
    } else if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) consumeString(node.left);
      consumeString(node.right);
    }
  };

  const containsJsx = (node) => {
    let hit = false;
    const visit = (child) => {
      if (hit) return;
      if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) {
        hit = true;
        return;
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return hit;
  };

  const isSrOnly = (element) => /\bsr-only\b/.test(attributeText(element, 'className') ?? '');

  /** Does a JSX element mark its content as a failure? */
  const elementSaysFailure = (element) => {
    if (attributeText(element, 'role') === 'alert') return true;
    if (/(?:Error|Failure|Refus)/.test(tagName(element))) return true;
    for (const name of ['tone', 'severity', 'variant', 'state']) {
      const value = attributeText(element, name);
      if (value && /^["'`]?(?:error|destructive|failed|failure)["'`]?$/.test(value)) return true;
    }
    return false;
  };

  /** Name of a property, attribute, variable, parameter or function node. */
  const nameOf = (node) => {
    const name = node.name;
    if (!name) return null;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
    if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
    if (ts.isJsxNamespacedName?.(name)) return name.getText(file);
    return name.getText(file);
  };

  const calleeName = (call) => {
    let callee = call.expression;
    while (ts.isParenthesizedExpression(callee) || ts.isNonNullExpression(callee)) callee = callee.expression;
    if (ts.isIdentifier(callee)) return { last: callee.text, full: callee.text };
    if (ts.isPropertyAccessExpression(callee)) {
      return { last: callee.name.text, full: callee.getText(file) };
    }
    if (callee.kind === ts.SyntaxKind.ImportKeyword) return { last: 'import', full: 'import' };
    return { last: '', full: callee.getText(file) };
  };

  const isFunctionLike = (node) =>
    ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node);

  /** The name a function is known by: its own, or the `const` it is
   * assigned to (through `memo(…)` / `forwardRef(…)`). */
  const functionName = (fn) => {
    if (fn.name && !ts.isArrowFunction(fn)) return fn.name.getText(file);
    let parent = fn.parent;
    while (
      parent &&
      (ts.isParenthesizedExpression(parent) ||
        (ts.isCallExpression(parent) && /^(?:React\.)?(?:memo|forwardRef)$/.test(parent.expression.getText(file))))
    ) {
      parent = parent.parent;
    }
    return parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : null;
  };

  /** Does this function's own body run while React renders: a component
   * (PascalCase, returns JSX), a hook (`useX`), or a class `render`? A nested
   * callback — an event handler, an effect, a query function — does not: its
   * throw may be caught and shown, so it keeps counting. */
  const runsDuringRender = (fn) => {
    if (ts.isMethodDeclaration(fn)) return fn.name.getText(file) === 'render';
    const name = functionName(fn);
    if (!name) return false;
    if (/^use[A-Z0-9]/.test(name)) return true;
    return /^[A-Z]/.test(name) && containsJsx(fn);
  };

  /**
   * Walk from `node` to the file root and decide what the text is: `null`
   * (not visible), or `{ kind, context }`. The NEAREST naming anchor (an
   * attribute, key, variable or parameter) decides class lists and accessible
   * names; ANY enclosing failure marker upgrades a label to a failure.
   */
  const judge = (node, initialContext) => {
    let kind = 'label';
    let context = initialContext ?? null;
    let anchored = false;
    let disclosure = null;
    const nameVerdict = (name, tag) => {
      if (!name) return null;
      if (NON_VISIBLE_NAMES.has(name) || name.startsWith('data-') || CLASS_NAME_RE.test(name)) return 'skip';
      if (ACCESSIBLE_NAME_RE.test(name)) return 'accessible';
      if (tag && ACCESSIBLE_ONLY_PROPS.get(tag)?.has(name)) return 'accessible';
      if (FAILURE_NAME_RE.test(name)) return 'failure';
      return 'label';
    };
    const anchor = (name, tag, describe) => {
      const verdict = nameVerdict(name, tag);
      if (!anchored) {
        anchored = true;
        context ??= describe;
        if (verdict === 'skip') return false;
        if (verdict === 'accessible') kind = 'accessible';
      }
      if (verdict === 'failure' && kind === 'label') kind = 'failure';
      return true;
    };
    const failure = () => {
      if (kind === 'label') kind = 'failure';
    };
    let thrown = false;
    let throwSiteChecked = false;

    let child = node;
    for (let current = node.parent; current && !ts.isSourceFile(current); child = current, current = current.parent) {
      // A message thrown while a component or hook renders, where no error
      // boundary shows caught messages, reaches only the console.
      if (thrown && !throwSiteChecked && isFunctionLike(current)) {
        throwSiteChecked = true;
        if (!renderErrorsShown && runsDuringRender(current)) return null;
      }
      if (ts.isTypeNode(current)) return null;
      if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current) || ts.isExternalModuleReference(current)) {
        return null;
      }
      if (ts.isTemplateSpan(current)) return null; // counted as `${…}` in its template
      if (ts.isComputedPropertyName(current)) return null;
      if (ts.isElementAccessExpression(current) && child === current.argumentExpression) return null;
      if (ts.isCaseClause(current) && child === current.expression) return null;
      if (ts.isExpressionStatement(current) && child === current.expression && ts.isStringLiteral(child)) {
        return null; // a directive
      }
      if (ts.isJsxAttribute(current)) {
        const element = current.parent.parent;
        const tag = element ? tagName(element) : undefined;
        if (!anchor(current.name.getText(file), tag, `${current.name.getText(file)}=`)) return null;
        continue;
      }
      if (
        (ts.isPropertyAssignment(current) || ts.isPropertyDeclaration(current) || ts.isVariableDeclaration(current) ||
          ts.isParameter(current) || ts.isBindingElement(current)) &&
        child === current.initializer
      ) {
        const name = ts.isBindingElement(current) && current.propertyName
          ? current.propertyName.getText(file)
          : nameOf(current);
        const describe = ts.isVariableDeclaration(current) ? `const ${name}` : `${name}:`;
        if (!anchor(name, undefined, describe)) return null;
        continue;
      }
      if ((ts.isPropertyAssignment(current) || ts.isPropertyDeclaration(current) || ts.isEnumMember(current) ||
        ts.isPropertySignature(current) || ts.isMethodDeclaration(current)) && child === current.name) {
        return null; // a property NAME is code
      }
      if (ts.isCallExpression(current) || ts.isNewExpression(current)) {
        if (child === current.expression) continue;
        const { last, full } = calleeName(current);
        if (NON_VISIBLE_CALLS.has(last) || full.startsWith('console.') || TERMINAL_CALL_RE.test(full) || last === 'import') return null;
        if (/^(?:[A-Z][A-Za-z]*)?Error$/.test(last) || full === 'Promise.reject') {
          failure();
          context ??= `${full}()`;
        } else if (full === 'toast.error') {
          failure();
          context ??= 'toast.error()';
        } else if (full === 'toast' || full.startsWith('toast.')) {
          context ??= `${full}()`;
        } else {
          context ??= `${last || 'call'}() argument`;
        }
        continue;
      }
      if (ts.isThrowStatement(current)) {
        failure();
        context ??= 'throw';
        thrown = true;
        continue;
      }
      if (ts.isReturnStatement(current)) {
        context ??= 'return';
        continue;
      }
      if (ts.isConditionalExpression(current)) {
        if (child === current.condition) return null;
        if (child === current.whenTrue && FAILURE_NAME_RE.test(current.condition.getText(file))) failure();
        continue;
      }
      if (ts.isBinaryExpression(current)) {
        const op = current.operatorToken.kind;
        if (
          op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
          op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken ||
          op === ts.SyntaxKind.InKeyword || op === ts.SyntaxKind.InstanceOfKeyword
        ) {
          return null;
        }
        if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
          if (child === current.left) return null;
          if (FAILURE_NAME_RE.test(current.left.getText(file))) failure();
        }
        continue;
      }
      if (ts.isIfStatement(current)) {
        if (child === current.expression) return null;
        if (child === current.thenStatement && FAILURE_NAME_RE.test(current.expression.getText(file))) failure();
        continue;
      }
      if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) {
        const tag = tagName(current);
        if (DISCLOSURE_TAGS.has(tag)) disclosure ??= tag;
        if (isSrOnly(current) && !anchored) {
          anchored = true;
          kind = 'accessible';
          context ??= 'sr-only text';
        }
        if (elementSaysFailure(current)) failure();
        continue;
      }
      if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current) || ts.isFunctionExpression(current)) {
        const name = nameOf(current);
        if (name && CLASS_NAME_RE.test(name) && !anchored) return null;
        if (name && FAILURE_NAME_RE.test(name)) failure();
        continue;
      }
    }
    return { kind, context: context ?? 'string', disclosure };
  };

  const record = (node, rawText, verdict, startNode = node, endNode = node) => {
    const text = collapse(rawText);
    if (!hasLetters(text)) return;
    if (looksLikeClassList(text) || looksLikeSql(text) || looksLikeGraphql(text)) return;
    const where = verdict.disclosure && !verdict.context.startsWith(`<${verdict.disclosure}>`)
      ? `${verdict.context} inside <${verdict.disclosure}>`
      : verdict.context;
    found.push({
      line: lineOf(startNode),
      start: startNode.getStart(file),
      end: endNode.getEnd(),
      text,
      words: countWords(text),
      kind: verdict.kind,
      context: where,
    });
  };

  // --- Pass 1: JSX paragraphs --------------------------------------------
  //
  // A parent with its own text (a JsxText, or a string child expression) is a
  // paragraph: its inline children (`<strong>`, `<code>`, `<a>`, `<Link>`…)
  // are part of the sentence, a self-closing child is one word (`<AgeBadge/>`
  // reads as "3h"), and a block child ends the run. A parent with no text of
  // its own is layout, and each child is judged on its own.

  const hasOwnText = (children) =>
    children.some((child) => {
      if (ts.isJsxText(child)) return hasLetters(child.text);
      if (ts.isJsxExpression(child) && child.expression) {
        return (stringLeaves(child.expression) ?? []).some((leaf) => hasLetters(leaf.text));
      }
      return false;
    });

  const paragraphs = (label, children) => {
    let parts = [];
    let first = null;
    let last = null;
    const flush = () => {
      if (parts.length && first) {
        const verdict = judge(first, label);
        if (verdict) record(first, parts.join(''), verdict, first, last);
      }
      parts = [];
      first = null;
      last = null;
    };
    const push = (node, text) => {
      parts.push(text);
      first ??= node;
      last = node;
    };
    const walk = (list) => {
      for (const child of list) {
        if (ts.isJsxText(child)) {
          if (child.containsOnlyTriviaWhiteSpaces) continue;
          push(child, decodeEntities(child.text));
          continue;
        }
        if (ts.isJsxExpression(child)) {
          if (!child.expression) continue;
          const leaves = stringLeaves(child.expression);
          if (leaves) {
            consumeString(child.expression);
            push(child, longestLeaf(leaves).text);
          } else if (containsJsx(child.expression)) {
            flush();
          } else {
            push(child, ` ${PLACEHOLDER} `);
          }
          continue;
        }
        if (ts.isJsxSelfClosingElement(child)) {
          push(child, BREAK_TAGS.has(tagName(child)) ? ' ' : ` ${PLACEHOLDER} `);
          continue;
        }
        if (ts.isJsxFragment(child)) {
          consumed.add(child);
          walk(child.children);
          continue;
        }
        if (ts.isJsxElement(child)) {
          const tag = tagName(child);
          if (isSrOnly(child)) continue; // judged on its own, as accessible text
          if (INLINE_TAGS.has(tag)) {
            consumed.add(child);
            push(child, ' ');
            walk(child.children);
            push(child, ' ');
            continue;
          }
          flush();
        }
      }
    };
    walk(children);
    flush();
  };

  const visitJsx = (node) => {
    if ((ts.isJsxElement(node) || ts.isJsxFragment(node)) && !consumed.has(node) && hasOwnText(node.children)) {
      paragraphs(ts.isJsxFragment(node) ? '<> text' : `<${tagName(node)}> text`, node.children);
    }
    ts.forEachChild(node, visitJsx);
  };
  visitJsx(file);

  // --- Pass 2: every other string and template literal -------------------

  const visitLiterals = (node) => {
    if (isPlus(node) && !consumed.has(node)) {
      // The top of a `+` chain: the whole sentence, judged where it lands.
      // A piece inside a failure branch (`error ? '…' : '…'`) keeps the
      // failure budget, as it would measured alone.
      const [chain] = stringLeaves(node) ?? [];
      if (chain) {
        consumeString(node);
        if (countWords(chain.text) > 0) {
          const verdict = judge(node);
          if (verdict?.kind === 'label' && chain.chosen.some((piece) => judge(piece)?.kind === 'failure')) verdict.kind = 'failure';
          if (verdict) record(node, chain.text, verdict);
        }
      }
    }
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) &&
      !consumed.has(node)
    ) {
      const text = ts.isTemplateExpression(node)
        ? node.head.text + node.templateSpans.map((span) => PLACEHOLDER + span.literal.text).join('')
        : node.text;
      if (countWords(text) > 0) {
        const verdict = judge(node);
        if (verdict) record(node, text, verdict);
      }
    }
    if (ts.isTaggedTemplateExpression(node)) return; // css`…`, sql`…` — not copy
    ts.forEachChild(node, visitLiterals);
  };
  visitLiterals(file);

  return found.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// Retired on-screen terms (bead ro-ujb9.135)
// ---------------------------------------------------------------------------

/**
 * SHORT LABELS CAN STILL NAME AN INTERNAL. The word budget stops a paragraph;
 * it cannot stop "no ledger rows for Sep yet" or "On the roster", which are
 * short and still say the system's own nouns to a stranger. Each term here was
 * replaced on screen by a row in `docs/17-ui-lexicon.md` (§ Retired on-screen
 * terms), and `say` is that row's word, quoted back in the failure so nobody
 * has to open the doc to know what to write.
 *
 * Matched against every string the gate already reads as visible — the same
 * corpus the budgets judge, so a code token, a comment or an id is never a
 * hit. There is no baseline: a retired term enters with zero offenders and
 * stays at zero. Adding a term is a tightening; removing one means its doc 17
 * row was amended first.
 */
export const RETIRED_TERMS = Object.freeze([
  { term: 'ledger rows', pattern: /\bledger rows?\b/i, say: 'revenue or costs ("no revenue or costs for Sep yet")' },
  { term: 'onboarded', pattern: /\bonboarded\b/i, say: '"No sites yet", or the site\'s stage' },
  { term: 'manual stages', pattern: /\bmanual stages?\b/i, say: '"All stages"' },
  { term: 'report coverage', pattern: /\breport coverage\b/i, say: '"28 days of reports", or the report days themselves' },
  { term: 'named separately', pattern: /\bnamed separately\b/i, say: 'nothing: name the estimate on its own line' },
  { term: 'what the panel buys', pattern: /\bwhat the panel buys\b/i, say: '"Tracked search terms"' },
  { term: 'on the roster', pattern: /\bon the roster\b/i, say: '"Daily refresh"' },
  { term: 'task status unavailable', pattern: /\btask status unavailable\b/i, say: '"Tasks not read yet"' },
  // A site's Data sources tab (bead ro-ujb9.164).
  { term: 'additional connections', pattern: /\badditional connections?\b/i, say: '"More sources"' },
  { term: 'checks complete', pattern: /\bchecks? complete\b/i, say: '"1 of 2 done"' },
  { term: 'daily report status', pattern: /\bdaily report status\b/i, say: '"Nightly report"' },
]);

/** The visible strings that say a retired term, one entry per term hit. */
export function retiredTermHits(strings, file) {
  return strings.flatMap((entry) =>
    RETIRED_TERMS.filter(({ pattern }) => pattern.test(entry.text)).map(({ term, say }) => ({
      file, line: entry.line, text: entry.text, context: entry.context, term, say,
    })));
}

/** Every retired-term hit in a measurement, file order. */
export function retiredIn(measured) {
  return Object.values(measured).flatMap((entry) => entry.retired ?? []);
}

export function formatRetired(hits) {
  return [
    `UX gate: a retired internal term is on screen (bead ${RETIRED_TERMS_BEAD}; docs/17-ui-lexicon.md, Retired on-screen terms).`,
    ...hits.map((hit) => `  ${hit.file}:${hit.line}  "${hit.term}" · ${hit.context}\n      "${truncate(hit.text)}"\n      say instead: ${hit.say}`),
  ].join('\n');
}

export const RETIRED_TERMS_BEAD = 'ro-ujb9.135';

/** The strings in `extractVisibleStrings` output that exceed their budget. */
export function overBudget(strings, settings = SETTINGS) {
  const budgets = settings.budgets;
  return strings
    .filter((entry) => entry.words > budgets[entry.kind])
    .map((entry) => ({ ...entry, budget: budgets[entry.kind] }));
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const toPosix = (value) => value.split(path.sep).join('/');

/** Is `rel` under one of the directories the gate always reads? */
export const underScanDirs = (rel, settings = SETTINGS) => settings.scanDirs.some((dir) => toPosix(rel).startsWith(`${dir}/`));

/** Is `rel` (repo-relative, posix) a Tower file this gate always reads? */
export function isTowerUiFile(rel, settings = SETTINGS) {
  const file = toPosix(rel);
  if (!/\.tsx?$/.test(file) || /\.d\.ts$/.test(file) || /\.(?:test|spec)\.tsx?$/.test(file)) return false;
  if (settings.notDeskCopy.has(file)) return false;
  return underScanDirs(file, settings);
}

/** Every Tower file the gate always reads in `root`, repo-relative and sorted. */
export function towerFiles(root = REPO_ROOT, settings = SETTINGS) {
  const found = [];
  const walk = (dir) => {
    const absolute = path.join(root, dir);
    if (!existsSync(absolute)) return;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (isTowerUiFile(rel, settings)) found.push(rel);
    }
  };
  for (const dir of settings.scanDirs) walk(dir);
  return found.sort();
}

// ---------------------------------------------------------------------------
// Trees: the working tree, the index, a commit
// ---------------------------------------------------------------------------
//
// The gate asks three questions of a checkout — which files exist, what they
// say, which directories hold packages — and asks them of the working tree
// (CI, edit time), of the index (the pre-commit hook) and of a past commit
// (the history audit). One small interface answers all three.

const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', '.wrangler', '.local', 'coverage']);

/** The working tree under `root`. */
export function workingTree(root = REPO_ROOT) {
  const cache = new Map();
  const tree = {
    root,
    rev: null,
    exists: (rel) => {
      try {
        return statSync(path.join(root, rel)).isFile();
      } catch {
        return false;
      }
    },
    read(rel) {
      if (!cache.has(rel)) {
        let text = null;
        try {
          text = readFileSync(path.join(root, rel), 'utf8');
        } catch (error) {
          // Absent is null; any other refusal is loud, never a silent zero.
          if (error?.code !== 'ENOENT' && error?.code !== 'EISDIR') throw error;
        }
        cache.set(rel, text);
      }
      return cache.get(rel);
    },
    readMany(rels) {
      for (const rel of rels) tree.read(rel);
    },
    files(dir) {
      const found = [];
      const walk = (sub) => {
        let entries;
        try {
          entries = readdirSync(path.join(root, sub), { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const rel = `${sub}/${entry.name}`;
          if (entry.isDirectory()) {
            if (!SKIPPED_DIRS.has(entry.name)) walk(rel);
          } else found.push(rel);
        }
      };
      walk(dir);
      return found.sort();
    },
    dirs(dir) {
      try {
        return readdirSync(path.join(root, dir), { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !SKIPPED_DIRS.has(entry.name))
          .map((entry) => `${dir}/${entry.name}`)
          .sort();
      } catch {
        return [];
      }
    },
  };
  return tree;
}

/** The tree git holds at `rev`: `':'` is the index, anything else a commit.
 * Contents are read in one `git cat-file --batch` per call to `readMany`. */
export function gitTree(root, rev) {
  const listing = rev === ':'
    ? git(root, ['ls-files', '-z'])
    : git(root, ['ls-tree', '-r', '-z', '--name-only', rev]);
  if (listing.status !== 0) throw new Error(`ux-gate: cannot list ${rev === ':' ? 'the index' : rev}: ${listing.stderr.trim()}`);
  const all = listing.stdout.split('\0').filter(Boolean);
  const present = new Set(all);
  const cache = new Map();
  const spec = (rel) => (rev === ':' ? `:${rel}` : `${rev}:${rel}`);
  const tree = {
    root,
    rev,
    exists: (rel) => present.has(rel),
    readMany(rels) {
      const wanted = [...new Set(rels)].filter((rel) => !cache.has(rel));
      for (const rel of wanted) if (!present.has(rel)) cache.set(rel, null);
      const batch = wanted.filter((rel) => present.has(rel));
      if (!batch.length) return;
      const result = spawnSync('git', ['cat-file', '--batch'], {
        cwd: root,
        input: `${batch.map(spec).join('\n')}\n`,
        maxBuffer: 256 * 1024 * 1024,
      });
      if (result.error) throw result.error;
      const out = result.stdout;
      let at = 0;
      for (const rel of batch) {
        const newline = out.indexOf(10, at);
        const header = out.subarray(at, newline).toString('utf8');
        at = newline + 1;
        const size = /^[0-9a-f]+ blob (\d+)$/.exec(header);
        if (!size) {
          cache.set(rel, null); // "missing", or not a blob
          continue;
        }
        const length = Number(size[1]);
        cache.set(rel, out.subarray(at, at + length).toString('utf8'));
        at += length + 1;
      }
    },
    read(rel) {
      if (!cache.has(rel)) tree.readMany([rel]);
      return cache.get(rel);
    },
    files: (dir) => all.filter((rel) => rel.startsWith(`${dir}/`)).sort(),
    dirs(dir) {
      const found = new Set();
      for (const rel of all) {
        if (!rel.startsWith(`${dir}/`)) continue;
        const [child, ...rest] = rel.slice(dir.length + 1).split('/');
        if (rest.length) found.add(`${dir}/${child}`);
      }
      return [...found].sort();
    },
  };
  return tree;
}

// ---------------------------------------------------------------------------
// What the Tower renders: its own directories, plus everything they import
// ---------------------------------------------------------------------------
//
// Bead `ro-ujb9.96.6.13`. The desk renders text written outside
// `apps/tower`: the config registers' field labels and hints
// (`scripts/config-registers.mts`), the provider catalog and health copy in
// `packages/contract`, every config document compiled into the bundle
// (`config/integrations.json` notes and setup steps), the workflow and job
// descriptions (`scripts/scheduled-jobs.mts`). A gate that reads only
// `apps/tower` lets a paragraph move one import away and pass. So the gate
// follows the Tower's imports — relative ones and `@noticeos/*` workspace
// packages, through every module they reach — and measures each file it
// lands on the same way. Type-only imports carry no text and are not
// followed; a `.mjs` generated from a sibling `.mts` is measured as its
// authored `.mts`. Nothing is listed by hand, so a new module the desk
// imports is measured the day it is imported.

const SOURCE_RE = /\.(?:tsx?|mts|mjs|js|json)$/;

/** Is `rel` a source whose strings could reach the desk (not a test, not a
 * declaration file, not an excluded file)? */
export function isGateSource(rel, settings = SETTINGS) {
  const file = toPosix(rel);
  if (!SOURCE_RE.test(file)) return false;
  if (/\.d\.m?ts$/.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) return false;
  if (file.split('/').includes('node_modules')) return false;
  return !settings.notDeskCopy.has(file);
}

const IMPORT_RE =
  /^[ \t]*(?:import|export)\b(?![ \t]+type\b)[^'"`;]*?\bfrom[ \t]*['"]([^'"\n]+)['"]|^[ \t]*import[ \t]*['"]([^'"\n]+)['"]|\bimport[ \t]*\([ \t]*['"]([^'"\n]+)['"][ \t]*\)/gm;

/** The module specifiers a source imports for their values (static, re-export,
 * side-effect and dynamic imports; `import type` / `export type` skipped). */
export function importSpecifiers(source) {
  const found = [];
  for (const match of String(source).matchAll(IMPORT_RE)) found.push(match[1] ?? match[2] ?? match[3]);
  return found;
}

/** Candidate files for an import target, the authored source first. */
function sourceCandidates(base) {
  const ext = path.posix.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  switch (ext) {
    case '.js':
      return [`${stem}.ts`, `${stem}.tsx`, base];
    case '.jsx':
      return [`${stem}.tsx`, base];
    case '.mjs':
      return [`${stem}.mts`, base];
    case '.ts':
    case '.tsx':
    case '.mts':
    case '.json':
      return [base];
    default:
      return [base, ...['.ts', '.tsx', '.mts', '.js', '.mjs', '.json', '/index.ts', '/index.tsx', '/index.js'].map((tail) => base + tail)];
  }
}

/** The workspace packages (`apps/*`, `packages/*`, `workers/*`) by name. */
function workspacePackages(tree) {
  const packages = new Map();
  const manifests = ['apps', 'packages', 'workers'].flatMap((dir) => tree.dirs(dir)).map((dir) => `${dir}/package.json`);
  tree.readMany(manifests);
  for (const manifest of manifests) {
    const text = tree.read(manifest);
    if (text == null) continue;
    try {
      const json = JSON.parse(text);
      if (json.name) packages.set(json.name, { dir: path.posix.dirname(manifest), json });
    } catch {
      // not a package
    }
  }
  return packages;
}

/** A package subpath through its `exports` map (`"./*"` patterns included). */
function packageTarget(json, subpath) {
  const pick = (value) => (typeof value === 'string' ? value : value && (value.default ?? value.import ?? value.types));
  const exportsMap = json.exports;
  if (typeof exportsMap === 'string') return subpath === '.' ? exportsMap : null;
  if (exportsMap && typeof exportsMap === 'object') {
    if (subpath in exportsMap) return pick(exportsMap[subpath]);
    for (const [pattern, value] of Object.entries(exportsMap)) {
      const star = pattern.indexOf('*');
      if (star === -1) continue;
      const head = pattern.slice(0, star);
      const tail = pattern.slice(star + 1);
      if (subpath.startsWith(head) && subpath.endsWith(tail) && subpath.length >= head.length + tail.length) {
        const target = pick(value);
        return target ? target.replace('*', subpath.slice(head.length, subpath.length - tail.length)) : null;
      }
    }
    return null;
  }
  return subpath === '.' ? (json.main ?? 'index.ts') : subpath;
}

/** The repo file an import resolves to, or null (a dependency, a missing
 * file, a non-source asset). */
export function resolveImport(tree, from, specifier, packages = workspacePackages(tree)) {
  let base = null;
  if (specifier.startsWith('.')) {
    base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  } else {
    for (const [name, { dir, json }] of packages) {
      if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
      const target = packageTarget(json, `.${specifier.slice(name.length)}`);
      if (target) base = path.posix.normalize(path.posix.join(dir, target));
      break;
    }
  }
  if (!base || base.startsWith('..')) return null;
  const hit = sourceCandidates(base.split('?')[0]).find((candidate) => tree.exists(candidate));
  return hit && SOURCE_RE.test(hit) ? hit : null;
}

// ---------------------------------------------------------------------------
// What the Tower reaches through a service binding (bead ro-ujb9.96.6.24)
// ---------------------------------------------------------------------------
//
// The Tower does not import the ingest Worker: it calls it. `env.INGEST` is a
// service binding declared in the Tower's wrangler config, and every method on
// the bound Worker's entrypoint class is a call the Tower (or the runner that
// fills the store the Tower reads) can make. A probe verdict, a connect
// refusal, a stored `last_error`, a flag's message: all of it is written in
// workers/ingest and drawn by the Tower word for word, and none of it is an
// import. So the gate follows the binding the way it follows an import: from
// the Tower's wrangler config to the bound Worker's `main`, which is measured,
// and from each method of its default-export class (the Workers handlers
// `fetch`, `scheduled`… excluded: they answer other clients) into the modules
// that method calls, which are measured and followed like any import. Nothing
// is listed by hand, so a new RPC is read the day it is written.

/** The Workers runtime handlers: their callers are sites, crons and queues,
 * not the Tower. */
const WORKER_HANDLERS = new Set(['fetch', 'scheduled', 'queue', 'tail', 'email', 'trace', 'test', 'alarm', 'constructor']);

const WRANGLER_CONFIGS = ['wrangler.jsonc', 'wrangler.json'];

/** A wrangler config's JSON (comments allowed), or null. The compiler that
 * parses it is loaded only when a config exists: a checkout with no Worker
 * (a scratch repo, a fresh clone before install) never needs it. */
function readWrangler(tree, dir) {
  for (const name of WRANGLER_CONFIGS) {
    const rel = `${dir}/${name}`;
    const text = tree.read(rel);
    if (text == null) continue;
    const { config } = loadTypeScript([tree.root ?? REPO_ROOT]).parseConfigFileTextToJson(rel, text);
    return config && typeof config === 'object' ? { rel, config } : null;
  }
  return null;
}

/** Does this tree's own gate follow service bindings? A widening is judged by
 * what the gate AT THAT COMMIT read, so the feature is read off the tree's
 * gate source rather than assumed. */
export function followsServiceBindings(tree) {
  return (tree.read('scripts/ux-gate.mjs') ?? '').includes('function serviceBindingScope(');
}

/**
 * The bound Workers the Tower calls: each one's entry (`main`), measured
 * whole, and the modules its entrypoint's methods call into, followed.
 *
 * @returns {{ entries: string[], roots: string[] }}
 */
export function serviceBindingScope(tree, settings = SETTINGS, packages = workspacePackages(tree)) {
  const towerDirs = [...new Set(settings.scanDirs.map((dir) => path.posix.dirname(dir)))];
  const services = new Set();
  for (const dir of towerDirs) {
    const found = readWrangler(tree, dir);
    for (const binding of Array.isArray(found?.config.services) ? found.config.services : []) {
      if (typeof binding?.service === 'string') services.add(binding.service);
    }
  }
  const entries = new Set();
  const roots = new Set();
  if (!services.size) return { entries: [], roots: [] };
  for (const dir of ['apps', 'workers', 'packages'].flatMap((parent) => tree.dirs(parent))) {
    const found = readWrangler(tree, dir);
    if (!found || !services.has(found.config.name) || typeof found.config.main !== 'string') continue;
    const entry = path.posix.normalize(path.posix.join(dir, found.config.main));
    const source = tree.read(entry);
    if (source == null) continue;
    entries.add(entry);
    for (const target of entrypointImports(source, entry, loadTypeScript([tree.root ?? REPO_ROOT]))) {
      const resolved = resolveImport(tree, entry, target, packages);
      if (resolved) roots.add(resolved);
    }
  }
  return { entries: [...entries].sort(), roots: [...roots].sort() };
}

/** The value-import specifiers the default-export class's non-handler
 * members use. */
function entrypointImports(source, fileName, ts) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imported = new Map();
  let exported = null;
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause && !statement.importClause.isTypeOnly) {
      const specifier = statement.moduleSpecifier.text;
      const { name, namedBindings } = statement.importClause;
      if (name) imported.set(name.text, specifier);
      if (namedBindings && ts.isNamespaceImport(namedBindings)) imported.set(namedBindings.name.text, specifier);
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) if (!element.isTypeOnly) imported.set(element.name.text, specifier);
      }
    }
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) exported = statement.expression.text;
  }
  const isDefault = (statement) =>
    ts.isClassDeclaration(statement) &&
    (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) || statement.name?.text === exported);
  const used = new Set();
  for (const statement of file.statements.filter(isDefault)) {
    for (const member of statement.members) {
      if (WORKER_HANDLERS.has(member.name?.getText(file) ?? '')) continue;
      const visit = (node) => {
        if (ts.isIdentifier(node) && imported.has(node.text)) used.add(imported.get(node.text));
        ts.forEachChild(node, visit);
      };
      visit(member);
    }
  }
  return [...used];
}

/**
 * Everything the gate measures in `tree`: the Tower directories' own files,
 * plus every repo module and config document reachable from them (and from
 * `TRACE_ROOTS`) by value imports, plus what the Tower calls through a
 * service binding (`serviceBindingScope`). An excluded file (`NOT_DESK_COPY`)
 * is not measured and not followed. `bindings` says whether to follow service
 * bindings; by default, whether the tree's own gate does.
 *
 * @returns {{ tower: string[], traced: string[], files: string[] }}
 */
export function traceScope(tree = workingTree(), settings = SETTINGS, { bindings = followsServiceBindings(tree) } = {}) {
  const tower = settings.scanDirs.flatMap((dir) => tree.files(dir)).filter((rel) => isTowerUiFile(rel, settings)).sort();
  const packages = workspacePackages(tree);
  const bound = bindings ? serviceBindingScope(tree, settings, packages) : { entries: [], roots: [] };
  const roots = [...tower, ...settings.traceRoots.filter((rel) => tree.exists(rel))];
  const seen = new Set([...roots, ...bound.entries]);
  const traced = new Set();
  for (const entry of bound.entries) if (isGateSource(entry, settings) && !underScanDirs(entry, settings)) traced.add(entry);
  for (const root of bound.roots) {
    if (seen.has(root) || !isGateSource(root, settings)) continue;
    seen.add(root);
    if (underScanDirs(root, settings)) continue;
    traced.add(root);
    roots.push(root);
  }
  let frontier = roots;
  while (frontier.length) {
    tree.readMany(frontier.filter((rel) => !rel.endsWith('.json')));
    const next = [];
    for (const from of frontier) {
      if (from.endsWith('.json')) continue;
      const source = tree.read(from);
      if (source == null) continue;
      for (const specifier of importSpecifiers(source)) {
        const target = resolveImport(tree, from, specifier, packages);
        if (!target || seen.has(target)) continue;
        seen.add(target);
        if (!isGateSource(target, settings)) continue;
        if (underScanDirs(target, settings)) {
          if (!isTowerUiFile(target, settings)) continue;
        } else {
          traced.add(target);
        }
        next.push(target);
      }
    }
    frontier = next;
  }
  const tracedFiles = [...traced].sort();
  return { tower, traced: tracedFiles, files: [...new Set([...tower, ...tracedFiles])].sort() };
}

/** Every file the gate measures in `root`'s working tree, sorted. */
export function gateFiles(root = REPO_ROOT, tree = workingTree(root), settings = SETTINGS) {
  return traceScope(tree, settings).files;
}

/** Is `rel` a file the gate measures? The Tower directories answer without a
 * trace; any other source is measured when the Tower reaches it. */
export function isGateFile(rel, tree, settings = SETTINGS) {
  const file = toPosix(rel);
  if (isTowerUiFile(file, settings)) return true;
  if (!isGateSource(file, settings) || underScanDirs(file, settings)) return false;
  return traceScope(tree, settings).traced.includes(file);
}

// ---------------------------------------------------------------------------
// Developer-only messages (bead ro-ujb9.96.4)
// ---------------------------------------------------------------------------
//
// A message thrown while React renders a component or hook goes to the
// nearest error boundary. When no boundary in the Tower shows a caught
// error's message, the operator sees a blank panel and the text reaches only
// the console: developer text, like `console.*`, and not counted. The moment
// a boundary that renders `error.message` (or a react-error-boundary
// fallback) exists, every such message is desk text again. Throws anywhere
// else keep counting: a query or mutation function's error is shown by the
// screen that catches it.

const ERROR_BOUNDARY_RE = /\b(?:getDerivedStateFromError|componentDidCatch|errorElement|errorComponent|useRouteError|ErrorBoundary|FallbackComponent|fallbackRender)\b/;

/** Does any Tower file hold an error boundary that shows the caught
 * message? Unknown counts as yes. */
export function errorBoundaryShowsMessages(tree = workingTree(), settings = SETTINGS) {
  const files = settings.scanDirs.flatMap((dir) => tree.files(dir)).filter((rel) => isTowerUiFile(rel, settings));
  tree.readMany(files);
  return files.some((rel) => {
    const text = tree.read(rel) ?? '';
    return ERROR_BOUNDARY_RE.test(text) && (/\.message\b/.test(text) || text.includes('react-error-boundary'));
  });
}

/**
 * Measure files. `read(rel)` (or `tree`) supplies the content (the working
 * tree by default; the pre-commit hook passes the index).
 *
 * @returns {Record<string, { count: number, words: number, offenders: object[] }>}
 */
export function measure(files, { root = REPO_ROOT, read, ts, settings = SETTINGS, tree, renderErrorsShown } = {}) {
  if (!files.length) return {};
  const compiler = ts ?? loadTypeScript([root]);
  const reader = read ?? tree?.read ?? ((rel) => readFileSync(path.join(root, rel), 'utf8'));
  const shown = renderErrorsShown ?? errorBoundaryShowsMessages(tree ?? workingTree(root), settings);
  const result = {};
  for (const rel of files) {
    let source;
    try {
      source = reader(rel);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (source == null) continue;
    const strings = extractVisibleStrings(source, rel, compiler, { renderErrorsShown: shown });
    const offenders = overBudget(strings, settings).map((entry) => ({ file: rel, ...entry }));
    result[rel] = {
      count: offenders.length,
      words: offenders.reduce((sum, entry) => sum + entry.words, 0),
      offenders,
      // Outside the ratchet's count: a retired term is never legacy debt.
      retired: retiredTermHits(strings, rel),
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// The baseline and its ratchet
// ---------------------------------------------------------------------------

const EMPTY = Object.freeze({ count: 0, words: 0 });

export function emptyBaseline() {
  return { files: {} };
}

export function readBaseline(root = REPO_ROOT) {
  const file = path.join(root, BASELINE_FILE);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** The record's own header: what it is and who may change it. */
export const BASELINE_ABOUT =
  'One-way ratchet for scripts/ux-gate.mjs (bead ro-ujb9.94): the explanatory-prose offenders each file the Tower ' +
  'renders held when the gate first read it. A file may not gain offenders or words. pnpm ux:baseline lowers entries ' +
  'when text is removed and never raises them. Files the gate started reading later (text the Tower renders from ' +
  'outside apps/tower/{src,shared,worker}) entered once, through the widening record naming the bead that widened ' +
  'the gate. A raise is an operator-only exception for a trust-safety, legal or destructive-confirmation fact: the ' +
  'operator adds kind, approvedBy (a bead id), reason and priorArt (a docs/briefs section citing three researched ' +
  'comparables) to that entry. Agents never edit this file; see scripts/README.md, UX gate.';

/** The JSON the baseline file holds, keys sorted so a diff shows only change. */
export function serializeBaseline(baseline) {
  const files = {};
  for (const name of Object.keys(baseline.files ?? {}).sort()) {
    const entry = baseline.files[name];
    files[name] = { count: entry.count, words: entry.words };
    for (const key of APPROVAL_KEYS) if (entry[key] !== undefined) files[name][key] = entry[key];
  }
  const { about: _about, widenings: records, files: _files, ...rest } = baseline;
  const out = { about: BASELINE_ABOUT, ...(records?.length ? { widenings: records } : {}), ...rest, files };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** Bead-id prefixes the task hub knows (this installation's `beads.json`,
 * else the product default's none). */
export function beadPrefixes(root = REPO_ROOT) {
  try {
    const config = JSON.parse(readFileSync(readablePath('config/beads.json', { root }), 'utf8'));
    const prefixes = (config.spokes ?? []).map((spoke) => spoke.prefix).filter(Boolean);
    return prefixes.length ? prefixes : null;
  } catch {
    return null;
  }
}

/** A bead id: `<prefix>-<id>` with optional `.n` children, e.g. `ro-ujb9.94`. */
export function isBeadId(value, prefixes = null) {
  const match = /^([a-z]+)-[a-z0-9]{2,}(?:\.\d+)*$/.exec(String(value ?? ''));
  if (!match) return false;
  return prefixes ? prefixes.includes(match[1]) : true;
}

// ---------------------------------------------------------------------------
// Prior art: the research an exception must cite
// ---------------------------------------------------------------------------
//
// Operator, 2026-09-23: "If you get hard stopped at a gate which requires
// redesign but you're not sure what's wrong or how to redesign it you should
// research it until you find the best modern comp for what you're looking
// for." So an exception is only possible AFTER that research, and it points at
// it: `priorArt` names a section of a brief under docs/briefs/ that cites at
// least three comparable products by URL. A raise with no research behind it
// has nowhere to point.

export const APPROVAL_KEYS = ['approvedBy', 'kind', 'reason', 'priorArt'];

/**
 * The only facts an exception may keep on screen as text (operator,
 * 2026-09-23: "we cannot afford cheap workarounds/exceptions if we can
 * actually improve/streamline/simplify the flows"). A closed set: anything
 * else is a flow to redesign.
 *   trust-safety              a secret is shown once and never again
 *   legal                     a disclosure the law requires in words
 *   destructive-confirmation  what an irreversible action will destroy
 */
export const EXCEPTION_KINDS = Object.freeze(['trust-safety', 'legal', 'destructive-confirmation']);

export const EXCEPTION_KIND_RULE =
  `kind must be one of ${EXCEPTION_KINDS.join(', ')}: exceptions exist only for trust, safety, legal or ` +
  'destructive-confirmation facts, and everything else must be redesigned';
export const PRIOR_ART_RE = /^docs\/briefs\/[A-Za-z0-9._-]+\.md#[A-Za-z0-9_-]+$/;
export const PRIOR_ART_MIN_LINKS = 3;

/** GitHub's heading anchor: lower-case, punctuation dropped, spaces to `-`. */
export function headingSlug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** The lines of the section `#anchor` names in a Markdown document: the
 * heading whose slug matches (or an explicit `<a id>` / `{#anchor}`), up to the
 * next heading of the same or a higher level. Fenced code is not headings. */
export function markdownSection(markdown, anchor) {
  const lines = String(markdown).split('\n');
  let fenced = false;
  let start = -1;
  let level = 7;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (start === -1) {
      const explicit = line.includes(`id="${anchor}"`) || line.includes(`name="${anchor}"`) || line.includes(`{#${anchor}}`);
      if ((heading && headingSlug(heading[2].replace(/\{#[^}]*\}/, '')) === anchor) || explicit) {
        start = index + 1;
        level = heading ? heading[1].length : 7;
      }
    } else if (heading && heading[1].length <= level) {
      return lines.slice(start, index);
    }
  }
  return start === -1 ? null : lines.slice(start);
}

/**
 * Problems with a `priorArt` citation (none when it resolves). `readFile(rel)`
 * returns a repo file's text or null — the working tree, the index or a
 * commit, whichever the caller is judging.
 */
export function priorArtProblems(citation, readFile) {
  if (typeof citation !== 'string' || !PRIOR_ART_RE.test(citation)) {
    return [`priorArt must cite the research as "docs/briefs/<flow>.md#<section>" (got ${JSON.stringify(citation)})`];
  }
  const [file, anchor] = citation.split('#');
  const text = readFile(file);
  if (text == null) return [`priorArt ${citation}: ${file} does not exist`];
  const section = markdownSection(text, anchor);
  if (!section) return [`priorArt ${citation}: ${file} has no "#${anchor}" section`];
  const links = new Set(section.join('\n').match(/https?:\/\/[^\s)>\]"'`]+/g) ?? []);
  if (links.size < PRIOR_ART_MIN_LINKS) {
    return [
      `priorArt ${citation} cites ${links.size} source link(s); an exception needs at least ${PRIOR_ART_MIN_LINKS} ` +
        'comparable products researched (product, source URL, adopted pattern)',
    ];
  }
  return [];
}

const workingTreeReader = (root) => (rel) => {
  try {
    return readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return null;
  }
};

/** Problems with one entry's exception: all four keys, each valid. */
function approvalProblems(entry, { prefixes, readFile }) {
  const problems = [];
  if (!EXCEPTION_KINDS.includes(entry.kind)) {
    problems.push(`${EXCEPTION_KIND_RULE} (got ${JSON.stringify(entry.kind)})`);
  }
  if (!isBeadId(entry.approvedBy, prefixes)) {
    problems.push(`approvedBy must be the operator-approved bead id, e.g. "ro-abcd.1" (got ${JSON.stringify(entry.approvedBy)})`);
  }
  if (typeof entry.reason !== 'string' || countWords(entry.reason) < 3) {
    problems.push('reason must say, in at least three words, why no redesign removes the text');
  }
  problems.push(...priorArtProblems(entry.priorArt, readFile));
  return problems;
}

/** Schema errors in a baseline (an empty list when it is well-formed). */
export function validateBaseline(baseline, { prefixes = null, root = REPO_ROOT, readFile = workingTreeReader(root) } = {}) {
  const errors = [];
  if (!baseline || typeof baseline !== 'object' || !baseline.files || typeof baseline.files !== 'object') {
    return [`${BASELINE_FILE} must be an object with a "files" map`];
  }
  errors.push(...wideningSchemaProblems(baseline, prefixes));
  const minWords = LABEL_WORD_BUDGET + 1;
  for (const [file, entry] of Object.entries(baseline.files)) {
    const where = `${BASELINE_FILE} → ${file}`;
    if (!entry || typeof entry !== 'object') {
      errors.push(`${where}: must be an object`);
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!['count', 'words', ...APPROVAL_KEYS].includes(key)) errors.push(`${where}: unknown key "${key}"`);
    }
    if (!Number.isInteger(entry.count) || entry.count < 1) errors.push(`${where}: count must be a positive integer`);
    if (!Number.isInteger(entry.words) || entry.words < 1) errors.push(`${where}: words must be a positive integer`);
    else if (Number.isInteger(entry.count) && entry.words < entry.count * minWords) {
      errors.push(`${where}: ${entry.count} offender(s) cannot total ${entry.words} words (each is over ${LABEL_WORD_BUDGET})`);
    }
    if (APPROVAL_KEYS.some((key) => entry[key] !== undefined)) {
      for (const problem of approvalProblems(entry, { prefixes, readFile })) errors.push(`${where}: ${problem}`);
    }
  }
  return errors;
}

/**
 * Entries in `next` that are higher than in `previous` without a FRESH, valid
 * exception: an `approvedBy` bead id, a `reason`, and a `priorArt` citation
 * that resolves to researched comparables — and an approval different from the
 * one the previous version carried (one approval never covers two raises).
 */
export function baselineRaises(
  previous,
  next,
  { prefixes = null, root = REPO_ROOT, readFile = workingTreeReader(root), admitted = new Set() } = {},
) {
  const violations = [];
  for (const [file, entry] of Object.entries(next?.files ?? {})) {
    const before = previous?.files?.[file] ?? EMPTY;
    if (!(entry.count > before.count || entry.words > before.words)) continue;
    // A widening's first measurement of a file (judged by `judgeWidenings`).
    if (admitted.has(file) && !previous?.files?.[file]) continue;
    const change = `${file}: count ${before.count} → ${entry.count}, words ${before.words} → ${entry.words}`;
    const problems = approvalProblems(entry, { prefixes, readFile });
    if (problems.length) {
      violations.push(`${change} is a raise without a valid exception: ${problems.join('; ')}`);
    } else if (entry.approvedBy === before.approvedBy && entry.reason === before.reason) {
      violations.push(`${change} reuses the approval of an earlier raise (${entry.approvedBy}); each raise needs its own`);
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Widenings: the gate starts reading a source it never read
// ---------------------------------------------------------------------------
//
// Bead `ro-ujb9.96.6.13`. When the gate learns to read text the desk was
// ALREADY rendering from outside `apps/tower/{src,shared,worker}`, that text
// is legacy debt like the rest, not a new paragraph. It enters the record
// once, under a widening record in the file's header that names the bead that
// widened the gate — never as per-file exceptions, and never for text written
// in the same change. `pnpm ux:gate -- --widen <bead> --reason "<why>"` writes
// it; `judgeWidenings` decides whether it is honest, at commit time and for
// every commit in history.

/** The gate's own scope: a widening must change one of these. */
export const GATE_SCOPE_FILES = ['scripts/ux-gate.mjs', SETTINGS_FILE];

export const WIDENING_KEYS = ['bead', 'reason', 'files'];

export const widenings = (baseline) => (Array.isArray(baseline?.widenings) ? baseline.widenings : []);

/** The rules a tree carries: its settings file, or null before the file
 * existed (the legacy constants, and no import tracing, applied then). */
function settingsOfTree(tree) {
  const text = tree.read(SETTINGS_FILE);
  if (text == null) return null;
  try {
    return normalizeSettings(JSON.parse(text));
  } catch {
    return normalizeSettings(null);
  }
}

/** Shape problems with the widening records (none when well-formed). */
function wideningSchemaProblems(baseline, prefixes) {
  if (baseline.widenings === undefined) return [];
  const where = `${BASELINE_FILE} → widenings`;
  if (!Array.isArray(baseline.widenings)) return [`${where} must be a list`];
  const problems = [];
  const beads = new Set();
  const files = new Set();
  baseline.widenings.forEach((record, index) => {
    const at = `${where}[${index}]`;
    if (!record || typeof record !== 'object') {
      problems.push(`${at} must be an object`);
      return;
    }
    for (const key of Object.keys(record)) if (!WIDENING_KEYS.includes(key)) problems.push(`${at}: unknown key "${key}"`);
    if (!isBeadId(record.bead, prefixes)) problems.push(`${at}: bead must be the bead that widened the gate (got ${JSON.stringify(record.bead)})`);
    else if (beads.has(record.bead)) problems.push(`${at}: bead ${record.bead} already widened the gate once`);
    beads.add(record.bead);
    if (typeof record.reason !== 'string' || countWords(record.reason) < 3) problems.push(`${at}: reason must say what the gate started reading`);
    if (!Array.isArray(record.files) || !record.files.length || !record.files.every((file) => typeof file === 'string')) {
      problems.push(`${at}: files must list the files the gate started reading`);
      return;
    }
    for (const file of record.files) {
      if (files.has(file)) problems.push(`${at}: ${file} was already widened`);
      files.add(file);
    }
  });
  return problems;
}

/**
 * Judge the widening records `next` adds to `previous`. `before`/`after` are
 * the trees on either side of the change (`gitTree`/`workingTree`). Valid
 * only when the records are append-only; each new record names a fresh bead
 * and a reason; the same change edits the gate's scope (`GATE_SCOPE_FILES`);
 * and every file it lists is new to the record, was NOT read by the gate
 * before the change, is byte-identical before and after it, and is one the
 * new rules would have read in the old tree — a widening measures text the
 * desk was already rendering, and never admits new text.
 *
 * @returns {{ problems: string[], admitted: Set<string> }}
 */
export function judgeWidenings(previous, next, { before, after, prefixes = null } = {}) {
  const earlier = widenings(previous);
  const now = widenings(next);
  const problems = [];
  const admitted = new Set();
  earlier.forEach((record, index) => {
    if (JSON.stringify(now[index]) !== JSON.stringify(record)) {
      problems.push(`the widening record for ${record?.bead} was changed or removed; widening records are append-only`);
    }
  });
  const added = now.slice(earlier.length);
  if (!added.length) return { problems, admitted };
  // One batch per side for every file this judgement reads.
  const listed = added.flatMap((record) => (Array.isArray(record?.files) ? record.files : []));
  before.readMany([...GATE_SCOPE_FILES, ...listed]);
  after.readMany([...GATE_SCOPE_FILES, ...listed]);
  const gateChanged = GATE_SCOPE_FILES.some((file) => before.read(file) !== after.read(file));
  const earlierBeads = new Set(earlier.map((record) => record?.bead));
  const earlierFiles = new Set(earlier.flatMap((record) => (Array.isArray(record?.files) ? record.files : [])));
  const afterSettings = settingsOfTree(after) ?? normalizeSettings(null);
  const beforeSettings = settingsOfTree(before);
  let readBefore = null;
  let renderedBefore = null;
  // What the OLD gate read: before the settings file existed, the Tower
  // directories only (the gate did not follow imports yet); and service
  // bindings only once the old tree's own gate followed them.
  const wasRead = (file) => {
    readBefore ??= beforeSettings
      ? new Set(traceScope(before, beforeSettings, { bindings: followsServiceBindings(before) }).files)
      : { has: (rel) => isTowerUiFile(rel, normalizeSettings(null)) };
    return readBefore.has(file);
  };
  // What the NEW rules would have read in the old tree.
  const wouldRead = (file) => {
    renderedBefore ??= new Set(traceScope(before, afterSettings, { bindings: followsServiceBindings(after) }).files);
    return renderedBefore.has(file);
  };
  for (const record of added) {
    const name = `widening ${record?.bead}`;
    if (!isBeadId(record?.bead, prefixes)) {
      problems.push(`${name}: bead must be the bead that widened the gate`);
      continue;
    }
    if (earlierBeads.has(record.bead)) problems.push(`${name}: that bead already widened the gate once`);
    if (!gateChanged) {
      problems.push(`${name}: a widening must come with the change that widens the gate (${GATE_SCOPE_FILES.join(', ')})`);
    }
    for (const file of Array.isArray(record.files) ? record.files : []) {
      const refuse = (why) => problems.push(`${name}: ${file} ${why}`);
      if (earlierFiles.has(file) || admitted.has(file)) refuse('was already widened');
      else if (previous?.files?.[file]) refuse('is already in the record');
      else if (before.read(file) == null || before.read(file) !== after.read(file)) {
        refuse('is new or changed in the same change; a widening only records text that already existed');
      } else if (wasRead(file)) refuse('was already read by the gate; its prose needs a redesign, not a widening');
      else if (!wouldRead(file)) refuse('was not imported by the Tower before this change');
      else admitted.add(file);
    }
  }
  return { problems, admitted };
}

// ---------------------------------------------------------------------------
// The settings: tightening is free, loosening is the operator's exception
// ---------------------------------------------------------------------------

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Schema problems in the settings document (none when well-formed).
 * `exists(rel)` answers whether a path is in the tree judged. */
export function validateSettings(json, { prefixes = null, readFile = workingTreeReader(REPO_ROOT), exists = null } = {}) {
  if (!isPlainObject(json)) return [`${SETTINGS_FILE} must be an object`];
  const errors = [];
  const where = (key) => `${SETTINGS_FILE} → ${key}`;
  for (const key of Object.keys(json)) if (!SETTINGS_KEYS.includes(key)) errors.push(`${where(key)}: unknown key`);
  if (!isPlainObject(json.budgets)) errors.push(`${where('budgets')} must name ${BUDGET_KINDS.join(', ')}`);
  else {
    for (const key of Object.keys(json.budgets)) if (!BUDGET_KINDS.includes(key)) errors.push(`${where(`budgets.${key}`)}: unknown budget`);
    for (const kind of BUDGET_KINDS) {
      const entry = json.budgets[kind];
      const at = where(`budgets.${kind}`);
      if (!isPlainObject(entry) || !Number.isInteger(entry.words) || entry.words < 1) {
        errors.push(`${at} must be { "words": <positive integer> }`);
        continue;
      }
      for (const key of Object.keys(entry)) if (!['words', ...APPROVAL_KEYS].includes(key)) errors.push(`${at}: unknown key "${key}"`);
      if (APPROVAL_KEYS.some((key) => entry[key] !== undefined)) {
        for (const problem of approvalProblems(entry, { prefixes, readFile })) errors.push(`${at}: ${problem}`);
      }
    }
  }
  for (const key of ['scanDirs', 'traceRoots']) {
    const list = json[key];
    if (!Array.isArray(list) || !list.every((item) => typeof item === 'string' && item && !item.endsWith('/'))) {
      errors.push(`${where(key)} must be a list of repo-relative paths`);
    } else if (new Set(list).size !== list.length) errors.push(`${where(key)} lists a path twice`);
  }
  if (Array.isArray(json.scanDirs) && !json.scanDirs.length) errors.push(`${where('scanDirs')} must name at least one directory`);
  if (!isPlainObject(json.notDeskCopy)) errors.push(`${where('notDeskCopy')} must map a file to its reason`);
  else {
    for (const [file, entry] of Object.entries(json.notDeskCopy)) {
      const at = where(`notDeskCopy.${file}`);
      if (!isPlainObject(entry) || typeof entry.reason !== 'string' || countWords(entry.reason) < 3) {
        errors.push(`${at} must say, in at least three words, why the desk never shows this file`);
        continue;
      }
      for (const key of Object.keys(entry)) if (!APPROVAL_KEYS.includes(key)) errors.push(`${at}: unknown key "${key}"`);
      if (APPROVAL_KEYS.some((key) => key !== 'reason' && entry[key] !== undefined)) {
        for (const problem of approvalProblems(entry, { prefixes, readFile })) errors.push(`${at}: ${problem}`);
      }
      if (exists && !exists(file)) errors.push(`${at}: the file no longer exists; remove the entry`);
    }
  }
  return errors;
}

/**
 * Loosenings in `next` against `previous` (the legacy constants when the file
 * is new) that lack a FRESH, valid four-key approval: a raised budget, a new
 * skipped file. A scan directory or trace root may only leave when it no
 * longer exists (`pathExists`): stopping to read a file that still renders is
 * an approved `notDeskCopy` entry, never a shorter list.
 */
export function settingsLoosenings(previous, next, { prefixes = null, readFile = workingTreeReader(REPO_ROOT), pathExists = () => true } = {}) {
  const before = isPlainObject(previous) ? previous : LEGACY_SETTINGS;
  if (!isPlainObject(next)) return [];
  const violations = [];
  for (const kind of BUDGET_KINDS) {
    const was = before.budgets?.[kind]?.words ?? LEGACY_SETTINGS.budgets[kind].words;
    const entry = next.budgets?.[kind];
    const now = entry?.words;
    if (!Number.isInteger(now) || now <= was) continue;
    const change = `budgets.${kind}: ${was} → ${now} words`;
    const problems = approvalProblems(entry, { prefixes, readFile });
    if (problems.length) violations.push(`${change} loosens the gate without a valid exception: ${problems.join('; ')}`);
    else if (entry.approvedBy === before.budgets?.[kind]?.approvedBy && entry.reason === before.budgets?.[kind]?.reason) {
      violations.push(`${change} reuses the approval of an earlier raise (${entry.approvedBy}); each raise needs its own`);
    }
  }
  const skippedBefore = isPlainObject(before.notDeskCopy) ? before.notDeskCopy : {};
  for (const [file, entry] of Object.entries(isPlainObject(next.notDeskCopy) ? next.notDeskCopy : {})) {
    if (Object.hasOwn(skippedBefore, file)) continue;
    const problems = approvalProblems(isPlainObject(entry) ? entry : {}, { prefixes, readFile });
    if (problems.length) {
      violations.push(`notDeskCopy + ${file}: skipping a file loosens the gate and needs a valid exception: ${problems.join('; ')}`);
    }
  }
  for (const key of ['scanDirs', 'traceRoots']) {
    const kept = new Set(Array.isArray(next[key]) ? next[key] : []);
    for (const dir of Array.isArray(before[key]) ? before[key] : []) {
      if (!kept.has(dir) && pathExists(dir)) {
        violations.push(`${key} − ${dir}: the gate stops reading a path that still exists; skip a file only through an approved notDeskCopy entry`);
      }
    }
  }
  return violations;
}

const parseJson = (text) => {
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // malformed: reported by the schema check
  }
};

/**
 * Audit every commit that changed the settings: each loosening must carry a
 * fresh, valid exception, resolved IN THAT COMMIT'S TREE. The first version
 * is judged against `LEGACY_SETTINGS`; deleting the file, or re-creating it
 * after a deletion, is a violation.
 */
export function auditSettingsHistory(root = REPO_ROOT, { prefixes = beadPrefixes(root) } = {}) {
  const { commits, parents, shallow, text } = fileHistory(root, SETTINGS_FILE);
  if (!commits) return { skipped: text, violations: [] };
  const violations = [];
  commits.forEach((commit, index) => {
    const short = commit.slice(0, 8);
    const next = parseJson(text(commit));
    if (next === null) {
      violations.push(`${short} deletes ${SETTINGS_FILE}; the gate's rules are never deleted`);
      return;
    }
    const hasParent = Boolean(parents.get(commit));
    if (!hasParent && shallow) return; // history beyond a shallow clone's edge
    const previous = hasParent ? parseJson(text(parents.get(commit))) : null;
    if (previous === null && index !== commits.length - 1) {
      violations.push(`${short} re-creates ${SETTINGS_FILE} after it was deleted`);
      return;
    }
    const readFile = (rel) => gitShow(root, `${commit}:${rel}`);
    const pathExists = (rel) => git(root, ['cat-file', '-e', `${commit}:${rel}`]).status === 0;
    for (const violation of settingsLoosenings(previous ?? LEGACY_SETTINGS, next, { prefixes, readFile, pathExists })) {
      violations.push(`${short} ${violation}`);
    }
  });
  return { violations, commits: commits.length, shallow };
}

/** `judgeWidenings` for one change, building the two trees only when the
 * change touches the widening records at all (`before`/`after` are thunks). */
function judgeChange(previous, next, { prefixes, before, after }) {
  if (JSON.stringify(widenings(previous)) === JSON.stringify(widenings(next))) return { problems: [], admitted: new Set() };
  return judgeWidenings(previous, next, { prefixes, before: before(), after: after() });
}

/**
 * Compare a measurement with the baseline. `scope` limits the files judged
 * (null = every measured file and every baseline entry).
 */
export function compareToBaseline(measured, baseline, { scope = null } = {}) {
  const files = scope ?? [...new Set([...Object.keys(measured), ...Object.keys(baseline?.files ?? {})])].sort();
  const increases = [];
  const decreases = [];
  for (const file of files) {
    const now = measured[file] ?? { ...EMPTY, offenders: [] };
    const allowed = baseline?.files?.[file] ?? EMPTY;
    if (now.count > allowed.count || now.words > allowed.words) increases.push({ file, now, allowed });
    else if (now.count < allowed.count || now.words < allowed.words) decreases.push({ file, now, allowed });
  }
  return { increases, decreases };
}

/** The baseline with every entry lowered to the measurement where it is
 * lower. Never adds a file, never raises a number; drops entries that reach
 * zero. */
export function lowerBaseline(baseline, measured) {
  const next = { ...baseline, files: {} };
  const changes = [];
  for (const [file, entry] of Object.entries(baseline.files ?? {})) {
    const now = measured[file] ?? EMPTY;
    const count = Math.min(entry.count, now.count);
    const words = Math.min(entry.words, now.words);
    if (count !== entry.count || words !== entry.words) {
      changes.push(`${file}: count ${entry.count} → ${count}, words ${entry.words} → ${words}`);
    }
    if (count === 0 || words === 0) continue;
    next.files[file] = { ...entry, count, words };
  }
  return { next, changes };
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

function git(root, args, options = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  return result;
}

/** A file's content at a git revision (`HEAD:path`, `:path` for the index),
 * or null when it does not exist there. */
export function gitShow(root, spec) {
  const result = git(root, ['show', spec]);
  return result.status === 0 ? result.stdout : null;
}

const parseBaseline = (text) => (text == null ? null : JSON.parse(text));

/**
 * Audit every commit that changed the baseline: each raise must carry a fresh,
 * valid exception, its `priorArt` resolved IN THAT COMMIT'S TREE. The commit
 * that introduced the file is exempt; a later commit that re-creates it after
 * a deletion is not. Returns `{ violations, commits, shallow }` (`skipped`
 * when this is not a git work tree).
 */
/** Blobs by `rev:path` spec, in one `git cat-file --batch` (null: absent). */
export function catFiles(root, specs) {
  const found = new Map();
  const wanted = [...new Set(specs)];
  if (!wanted.length) return found;
  const result = spawnSync('git', ['cat-file', '--batch'], { cwd: root, input: `${wanted.join('\n')}\n`, maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  const out = result.stdout;
  let at = 0;
  for (const spec of wanted) {
    const newline = out.indexOf(10, at);
    if (newline === -1) break;
    const header = out.subarray(at, newline).toString('utf8');
    at = newline + 1;
    const size = /^[0-9a-f]+ blob (\d+)$/.exec(header);
    if (!size) {
      found.set(spec, null);
      continue;
    }
    const length = Number(size[1]);
    found.set(spec, out.subarray(at, at + length).toString('utf8'));
    at += length + 1;
  }
  return found;
}

/**
 * Every commit that changed `file` (newest first), each one's first parent,
 * and the file's text at any of them — read in one batch, because the audit
 * runs in every CI pass and a spawn per commit grows with the history.
 * `commits` is null (and `text` the reason) outside a git work tree.
 */
function fileHistory(root, file) {
  const inside = git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return { commits: null, text: 'not a git work tree' };
  const log = git(root, ['log', '--format=%H %P', '--', file]);
  if (log.status !== 0) return { commits: null, text: log.stderr.trim() };
  const commits = [];
  const parents = new Map();
  for (const line of log.stdout.split('\n').filter(Boolean)) {
    const [commit, parent = ''] = line.split(' ');
    commits.push(commit);
    parents.set(commit, parent);
  }
  const shallow = git(root, ['rev-parse', '--is-shallow-repository']).stdout.trim() === 'true';
  const revs = [...new Set([...commits, ...parents.values()].filter(Boolean))];
  const blobs = catFiles(root, revs.map((rev) => `${rev}:${file}`));
  return { commits, parents, shallow, text: (rev) => blobs.get(`${rev}:${file}`) ?? null };
}

export function auditBaselineHistory(root = REPO_ROOT, { prefixes = beadPrefixes(root) } = {}) {
  const { commits, parents, shallow, text } = fileHistory(root, BASELINE_FILE);
  if (!commits) return { skipped: text, violations: [] };
  const violations = [];
  commits.forEach((commit, index) => {
    const next = parseBaseline(text(commit));
    if (!next) return; // a deletion: the gate then fails closed on every file
    const hasParent = Boolean(parents.get(commit));
    if (!hasParent && shallow) return; // history beyond a shallow clone's edge
    const previous = hasParent ? parseBaseline(text(parents.get(commit))) : null;
    const introduction = index === commits.length - 1;
    if (!previous && !introduction) {
      violations.push(`${commit.slice(0, 8)} re-creates ${BASELINE_FILE} after it was deleted`);
      return;
    }
    if (!previous) return;
    const readFile = (rel) => gitShow(root, `${commit}:${rel}`);
    const { problems, admitted } = judgeChange(previous, next, {
      prefixes,
      before: () => gitTree(root, `${commit}^`),
      after: () => gitTree(root, commit),
    });
    for (const violation of [...problems, ...baselineRaises(previous, next, { prefixes, readFile, admitted })]) {
      violations.push(`${commit.slice(0, 8)} ${violation}`);
    }
  });
  return { violations, commits: commits.length, shallow };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
//
// A stopped agent is guaranteed to read exactly one thing: the failure. So
// every failure names the specific violation first, then the rule, then the
// same fixed instructions (`NEXT_STEPS`) — including the operator's standing
// order to research the best modern comparable before asking for anything.

const truncate = (text, max = 110) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function formatOffender(entry, marker = '') {
  return `${entry.file}:${entry.line}  ${entry.words} words (${entry.kind} budget ${entry.budget}) · ${entry.context}${marker}\n      "${truncate(entry.text)}"`;
}

export const RULE_TEXT =
  `Rule (bead ${GATE_BEAD}; docs/21 principle 3; operator, 2026-09-23): an interaction that needs a paragraph of\n` +
  `explanation is a flow to redesign. Budgets: labels ≤ ${LABEL_WORD_BUDGET} words, failure messages ≤ ${FAILURE_WORD_BUDGET}, ` +
  `accessible names ≤ ${ACCESSIBLE_NAME_WORD_BUDGET};\nAbout and InfoTooltip content counts.`;

/**
 * Steps 3 and 4 of the fixed instructions: research the best modern
 * comparable, and the only exception there is. Shared word for word with the
 * flow gate (`scripts/ux-flow-gate.mjs`, bead ro-ujb9.95), so a stopped agent
 * reads the same order from either stop. `subject` is what a redesign removes
 * (`text` here, `step` there); `file` is that gate's ratchet.
 */
export function researchAndExceptionSteps({ subject = 'text', file = BASELINE_FILE } = {}) {
  return [
    '  3. Not sure how? Research how best-in-class modern products handle this same interaction (their docs,',
    '     changelogs, screenshots) until you find the best current comparable. Record product, source URL and the',
    '     adopted pattern in docs/briefs/<flow>.md#prior-art, then build that pattern.',
    `  4. Only if that research finds no pattern that removes the ${subject}, and the ${subject} is a trust-safety, legal or`,
    '     destructive-confirmation fact, can the operator approve an exception: a raise in',
    `     ${file} with "kind", "approvedBy" (bead id), "reason" and "priorArt"`,
    `     ("docs/briefs/<flow>.md#prior-art", at least ${PRIOR_ART_MIN_LINKS} source links). Agents never edit that file.`,
  ];
}

/** The fixed block every design failure ends with. */
export const NEXT_STEPS = [
  'What to do next:',
  '  1. Do not shorten the text, move it behind a tooltip or About, or add an exception.',
  '  2. Redesign the interaction so it needs no explanation: show the state visually, or remove the step that needs it.',
  ...researchAndExceptionSteps(),
].join('\n');

export const LOWER_TEXT =
  `Lock the improvement in: pnpm ux:baseline (it only ever lowers), then commit ${BASELINE_FILE}.`;

/** Violations first, the fixed instructions last. */
export function composeFailure(sections) {
  return [...sections.filter(Boolean), NEXT_STEPS].join('\n\n');
}

export const THIS_CHANGE = '  ← this change';

/**
 * The increases, file by file. `introduced(file, offenders)` returns the
 * offenders the change added (bead `ro-ujb9.96.5`): they are listed FIRST and
 * marked `← this change`, so nobody redesigns legacy text instead of the new
 * sentence; the file's older offenders follow under their own line.
 */
export function formatIncreases(increases, { introduced = null } = {}) {
  const lines = [`UX gate: explanatory prose added to the Tower (bead ${GATE_BEAD}).`];
  for (const { file, now, allowed } of increases) {
    lines.push(`  ${file}  offenders ${allowed.count} → ${now.count}, words ${allowed.words} → ${now.words}`);
    const fresh = introduced?.(file, now.offenders) ?? [];
    const added = new Set(fresh);
    const older = now.offenders.filter((entry) => !added.has(entry));
    for (const entry of fresh) lines.push(`    ${formatOffender(entry, THIS_CHANGE)}`);
    if (fresh.length && older.length) lines.push(`    already in ${file} before this change:`);
    for (const entry of older) lines.push(`    ${formatOffender(entry)}`);
  }
  lines.push(RULE_TEXT);
  return lines.join('\n');
}

/**
 * `introduced` for `formatIncreases`: the offenders whose text the file's
 * base version (`readBase(file)`: HEAD for a commit, the branch point in CI)
 * does not hold. Counted as a multiset, so a second copy of a legacy sentence
 * is new. A file the base does not have is new throughout.
 */
export function introducedSince(readBase, { ts, renderErrorsShown = true } = {}) {
  return (file, offenders) => {
    let base;
    try {
      base = readBase(file);
    } catch {
      return [];
    }
    if (base == null) return offenders;
    const remaining = new Map();
    for (const entry of extractVisibleStrings(base, file, ts ?? loadTypeScript(), { renderErrorsShown })) {
      remaining.set(entry.text, (remaining.get(entry.text) ?? 0) + 1);
    }
    return offenders.filter((entry) => {
      const left = remaining.get(entry.text) ?? 0;
      if (!left) return true;
      remaining.set(entry.text, left - 1);
      return false;
    });
  };
}

/**
 * The version of each file a whole-checkout run (CI, `pnpm ux:gate`) judges
 * "this change" against: HEAD for a file with uncommitted edits; otherwise
 * the point the branch left `main` (or `origin/main`), or the parent commit
 * on `main` itself and in a CI merge checkout. Null outside git.
 */
export function changeBaseReader(root, tree = workingTree(root)) {
  let head;
  try {
    head = gitTree(root, 'HEAD');
  } catch {
    return null;
  }
  let base;
  const baseTree = () => {
    if (base !== undefined) return base;
    const headSha = git(root, ['rev-parse', 'HEAD']).stdout.trim();
    let rev = null;
    for (const branch of ['main', 'origin/main']) {
      const point = git(root, ['merge-base', 'HEAD', branch]);
      const sha = point.status === 0 ? point.stdout.trim() : '';
      if (sha && sha !== headSha) {
        rev = sha;
        break;
      }
    }
    if (!rev && git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^']).status === 0) rev = 'HEAD^';
    base = rev ? gitTree(root, rev) : null;
    return base;
  };
  return (rel) => {
    const atHead = head.read(rel);
    if (tree.read(rel) !== atHead) return atHead;
    const older = baseTree();
    return older ? older.read(rel) : atHead;
  };
}

/** The committed HEAD version of each file (the pre-commit hook's base):
 * null for every file before the first commit, and no reader at all outside
 * a git work tree. */
export function headReader(root) {
  const inside = git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return null;
  if (git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).status !== 0) return () => null;
  let head;
  return (rel) => {
    head ??= gitTree(root, 'HEAD');
    return head.read(rel);
  };
}

/** `introducedSince` over a base reader, or null when there is no base (not
 * a git checkout): the list is then printed unmarked. */
function markChange(readBase, renderErrorsShown = true) {
  return readBase ? introducedSince(readBase, { renderErrorsShown }) : null;
}

export function formatRaises(raises, heading = `UX gate: ${BASELINE_FILE} was raised without a valid exception:`) {
  return [heading, ...raises].join('\n  ');
}

export function formatDecreases(decreases) {
  const lines = ['UX gate: the Tower has less explanatory prose than its baseline records.'];
  for (const { file, now, allowed } of decreases) {
    lines.push(`  ${file}  offenders ${allowed.count} → ${now.count}, words ${allowed.words} → ${now.words}`);
  }
  lines.push(LOWER_TEXT);
  return lines.join('\n');
}

/**
 * The message for one gate run. Design failures (prose added, an exception
 * without its research, a malformed record) end with `NEXT_STEPS`. A stale
 * baseline alone — the Tower got BETTER and the record has not caught up — is
 * bookkeeping, and ends with the one command that fixes it instead.
 */
export function gateMessage({
  increases = [], decreases = [], raises = [], schema = [], loosened = [], introduced = null, stageHint = false, retired = [],
}) {
  const design = [
    schema.length ? formatRaises(schema, 'UX gate: the gate\'s records are malformed:') : '',
    loosened.length ? formatRaises(loosened, `UX gate: ${SETTINGS_FILE} was loosened without a valid exception:`) : '',
    raises.length ? formatRaises(raises) : '',
    retired.length ? formatRetired(retired) : '',
    increases.length ? formatIncreases(increases, { introduced }) : '',
  ].filter(Boolean);
  const stale = decreases.length ? formatDecreases(decreases) + (stageHint ? `\nThen stage it: git add ${BASELINE_FILE}` : '') : '';
  if (!design.length) return stale;
  return composeFailure([...design, stale]);
}

// ---------------------------------------------------------------------------
// Whole-Tower check (the CI gate)
// ---------------------------------------------------------------------------

/** Everything the CI test asserts, in one call. */
export function checkTower(root = REPO_ROOT) {
  const tree = workingTree(root);
  const prefixes = beadPrefixes(root);
  const settingsJson = parseJson(tree.read(SETTINGS_FILE));
  const settings = normalizeSettings(settingsJson ?? null);
  const files = gateFiles(root, tree, settings);
  const renderErrorsShown = errorBoundaryShowsMessages(tree, settings);
  const measured = measure(files, { root, tree, settings, renderErrorsShown });
  const baseline = readBaseline(root);
  const schema = baseline ? validateBaseline(baseline, { prefixes, root }) : [`${BASELINE_FILE} is missing`];
  if (settingsJson === null) schema.push(`${SETTINGS_FILE} is missing; restore it from git (git checkout -- ${SETTINGS_FILE})`);
  else if (settingsJson === undefined) schema.push(`${SETTINGS_FILE} is not valid JSON`);
  else schema.push(...validateSettings(settingsJson, { prefixes, readFile: tree.read, exists: tree.exists }));
  const { increases, decreases } = compareToBaseline(measured, baseline ?? emptyBaseline());
  const headSettings = parseJson(gitShow(root, `HEAD:${SETTINGS_FILE}`));
  const loosenings = settingsJson
    ? settingsLoosenings(headSettings ?? LEGACY_SETTINGS, settingsJson, {
      prefixes,
      readFile: tree.read,
      pathExists: (rel) => existsSync(path.join(root, rel)),
    })
    : [];
  const settingsHistory = auditSettingsHistory(root, { prefixes });
  const head = parseBaseline(gitShow(root, `HEAD:${BASELINE_FILE}`));
  let uncommittedRaises = [];
  if (head && baseline) {
    const { problems, admitted } = judgeChange(head, baseline, {
      prefixes,
      before: () => gitTree(root, 'HEAD'),
      after: () => tree,
    });
    uncommittedRaises = [...problems, ...baselineRaises(head, baseline, { prefixes, root, admitted })];
  }
  const history = auditBaselineHistory(root, { prefixes });
  const raises = [...uncommittedRaises, ...history.violations];
  const loosened = [...loosenings, ...settingsHistory.violations];
  const introduced = increases.length ? markChange(changeBaseReader(root, tree), renderErrorsShown) : null;
  const retired = retiredIn(measured);
  const message = gateMessage({ increases, decreases, raises, schema, loosened, introduced, retired });
  return {
    files, measured, baseline, settings, schema, increases, decreases, uncommittedRaises, history, settingsHistory, raises, loosened, retired, message,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    files: null, json: false, staged: false, list: false, write: false, widen: null, reason: null, root: REPO_ROOT, help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') continue; // `pnpm ux:gate -- --list` may forward the separator
    if (arg === '--json') args.json = true;
    else if (arg === '--staged') args.staged = true;
    else if (arg === '--list') args.list = true;
    else if (arg === '--write-baseline') args.write = true;
    else if (arg === '--widen') args.widen = argv[++index] ?? '';
    else if (arg === '--reason') args.reason = argv[++index] ?? '';
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--root') args.root = path.resolve(argv[++index]);
    else if (arg === '--files') {
      args.files = [];
      while (index + 1 < argv.length && !argv[index + 1].startsWith('--')) args.files.push(argv[++index]);
    } else throw new Error(`ux-gate: unknown argument ${arg}`);
  }
  return args;
}

function toRelative(root, file) {
  const real = (value) => {
    try {
      return realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  return toPosix(path.relative(real(root), real(path.resolve(file))));
}

function stagedFiles(root, filter = 'ACMR') {
  const result = git(root, ['diff', '--cached', '--name-only', `--diff-filter=${filter}`, '-z']);
  if (result.status !== 0) throw new Error(`ux-gate: git diff --cached failed: ${result.stderr}`);
  return result.stdout.split('\0').filter(Boolean);
}

function emit(args, payload, text, code) {
  if (args.json) process.stdout.write(`${JSON.stringify({ ...payload, message: text, exitCode: code }, null, 2)}\n`);
  else if (text) (code === 0 ? process.stdout : process.stderr).write(`${text}\n`);
  return code;
}

function strip(measured) {
  return Object.fromEntries(Object.entries(measured).map(([file, { count, words }]) => [file, { count, words }]));
}

const USAGE = `ux-gate — block explanatory prose in the Tower (bead ${GATE_BEAD})

  node scripts/ux-gate.mjs                    everything the Tower renders vs ${BASELINE_FILE} (CI)
  node scripts/ux-gate.mjs --files a.tsx ...  just these files (edit time)
  node scripts/ux-gate.mjs --staged           staged files the Tower renders (the pre-commit hook)
  node scripts/ux-gate.mjs --list             every offender, longest first
  node scripts/ux-gate.mjs --write-baseline   pnpm ux:baseline: lower the record, never raise it
  node scripts/ux-gate.mjs --widen <bead> --reason "<what the gate now reads>"
                                              record, once, the text the Tower already rendered
                                              from files a widened gate reads for the first time
  --json                                      machine-readable output
  --root <dir>                                judge another checkout

Exit 0 clean, 1 violations, 2 could not run.`;

/** `--widen`: after the gate learns to read files it never read, record the
 * offenders they ALREADY held, once, under the bead that widened it. Refuses
 * text that is new or changed since HEAD, and files the Tower did not import
 * at HEAD: those are redesigned, never recorded. */
function widen(args, prefixes) {
  const { root } = args;
  const bead = args.widen;
  const baseline = readBaseline(root);
  if (!baseline) return emit(args, {}, `ux-gate: ${BASELINE_FILE} is missing. Restore it from git first.`, 1);
  const refusals = [];
  if (!isBeadId(bead, prefixes)) refusals.push(`--widen needs the bead that widened the gate (got ${JSON.stringify(bead)})`);
  else if (widenings(baseline).some((record) => record?.bead === bead)) refusals.push(`${bead} already widened the gate once`);
  if (typeof args.reason !== 'string' || countWords(args.reason) < 3) refusals.push('--reason must say what the gate started reading');
  if (refusals.length) return emit(args, { refusals }, `ux-gate: ${refusals.join('; ')}`, 1);

  const tree = workingTree(root);
  const head = gitTree(root, 'HEAD');
  const settings = readSettings(root);
  const measured = measure(gateFiles(root, tree, settings), { root, tree, settings });
  const earlier = new Set(widenings(baseline).flatMap((record) => record?.files ?? []));
  const candidates = Object.keys(measured)
    .filter((file) => measured[file].count && !baseline.files?.[file] && !earlier.has(file))
    .sort();
  if (!candidates.length) return emit(args, { files: [] }, `ux-gate: nothing to widen — every file the Tower renders is already in ${BASELINE_FILE}.`, 0);
  const files = { ...baseline.files };
  for (const file of candidates) files[file] = { count: measured[file].count, words: measured[file].words };
  const record = { bead, reason: args.reason, files: candidates };
  const next = { ...baseline, widenings: [...widenings(baseline), record], files };
  // The same judgement the commit hook and CI will make, before anything is
  // written: new, changed or already-read text is refused whole.
  const { problems } = judgeWidenings(baseline, next, { before: head, after: tree, prefixes });
  if (problems.length) {
    const offenders = candidates.flatMap((file) => measured[file].offenders);
    const text = composeFailure([
      [
        'UX gate: --widen records only text the Tower already rendered at HEAD, from files a widened gate reads for the',
        'first time. Nothing was recorded:',
        ...problems.map((problem) => `  ${problem}`),
        ...offenders.map((entry) => `    ${formatOffender(entry)}`),
      ].join('\n'),
    ]);
    return emit(args, { refused: problems }, text, 1);
  }
  writeFileSync(path.join(root, BASELINE_FILE), serializeBaseline(next));
  const count = candidates.reduce((sum, file) => sum + measured[file].count, 0);
  const words = candidates.reduce((sum, file) => sum + measured[file].words, 0);
  const text = [
    `Widened ${BASELINE_FILE} under ${bead}: ${candidates.length} files, ${count} offenders, ${words} words.`,
    ...candidates.map((file) => `  ${String(measured[file].count).padStart(3)}  ${String(measured[file].words).padStart(5)}  ${file}`),
    `Commit it together with the change to ${GATE_SCOPE_FILES.join(' / ')} that widened the gate.`,
  ].join('\n');
  return emit(args, { bead, files: candidates, count, words }, text, 0);
}

/** The pre-commit check: judge the INDEX, not the working tree, and pay one
 * `git diff` when nothing staged could carry desk text. */
function checkStaged(args, prefixes) {
  const { root } = args;
  const staged = stagedFiles(root);
  const deleted = stagedFiles(root, 'D');
  const baselineStaged = staged.includes(BASELINE_FILE);
  const baselineDeleted = deleted.includes(BASELINE_FILE);
  const settingsStaged = staged.includes(SETTINGS_FILE);
  const settingsDeleted = deleted.includes(SETTINGS_FILE);
  const candidates = staged.filter((file) => isTowerUiFile(file) || isGateSource(file));
  if (!candidates.length && !baselineStaged && !baselineDeleted && !settingsDeleted) return emit(args, { checked: [] }, '', 0);
  const index = gitTree(root, ':');
  // The rules being committed are the rules the commit is measured by; a
  // loosening among them is refused below.
  const settingsJson = parseJson(index.read(SETTINGS_FILE));
  const settings = normalizeSettings(settingsJson ?? null);
  const scope = traceScope(index, settings);
  const scanned = new Set(scope.files);
  // Every file the Tower reaches outside its own directories is measured on
  // every such commit: a staged import can bring an unchanged file into view.
  const stagedRead = staged.filter((file) => scanned.has(file));
  if (!stagedRead.length && !baselineStaged && !baselineDeleted && !settingsStaged && !settingsDeleted) {
    return emit(args, { checked: [] }, '', 0); // nothing the Tower renders is in this commit
  }
  const checked = [...new Set([...stagedRead, ...scope.traced])].sort();
  const baseline = parseBaseline(index.read(BASELINE_FILE)) ?? emptyBaseline();
  let schema = [];
  let raises = [];
  let loosened = [];
  if (baselineDeleted) raises = [`${BASELINE_FILE} is staged for deletion; the record of legacy prose is never deleted`];
  if (settingsDeleted) loosened = [`${SETTINGS_FILE} is staged for deletion; the gate's rules are never deleted`];
  if (settingsStaged) {
    if (settingsJson === undefined) schema.push(`${SETTINGS_FILE} is not valid JSON`);
    else schema.push(...validateSettings(settingsJson, { prefixes, readFile: index.read, exists: index.exists }));
    const headSettings = parseJson(gitShow(root, `HEAD:${SETTINGS_FILE}`));
    loosened = settingsLoosenings(headSettings ?? LEGACY_SETTINGS, settingsJson, {
      prefixes,
      readFile: index.read,
      pathExists: (rel) => index.exists(rel) || index.files(rel).length > 0,
    });
  }
  if (baselineStaged) {
    schema.push(...validateBaseline(baseline, { prefixes, readFile: index.read }));
    const head = parseBaseline(gitShow(root, `HEAD:${BASELINE_FILE}`));
    if (head) {
      const { problems, admitted } = judgeChange(head, baseline, { prefixes, before: () => gitTree(root, 'HEAD'), after: () => index });
      raises = [...problems, ...baselineRaises(head, baseline, { prefixes, readFile: index.read, admitted })];
    } else if (git(root, ['log', '-1', '--format=%H', '--', BASELINE_FILE]).stdout.trim()) {
      raises = [`${BASELINE_FILE} is being re-created after it was deleted; restore it from history instead`];
    }
    // Otherwise this commit introduces the gate: its first record is the
    // measurement, and every later commit is judged against it.
  }
  index.readMany(checked);
  const renderErrorsShown = errorBoundaryShowsMessages(index, settings);
  const measured = measure(checked, { root, tree: index, settings, renderErrorsShown });
  const { increases, decreases } = compareToBaseline(measured, baseline, { scope: checked });
  // What this commit added: text the committed HEAD version does not hold.
  const introduced = increases.length ? markChange(headReader(root), renderErrorsShown) : null;
  const retired = retiredIn(measured);
  const text = gateMessage({ increases, decreases, raises, schema, loosened, introduced, retired, stageHint: true });
  const code = text ? 1 : 0;
  return emit(args, { checked, measured: strip(measured), increases, decreases, raises, loosened, schema, retired }, text, code);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { root } = args;
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const prefixes = beadPrefixes(root);

  if (args.staged) return checkStaged(args, prefixes);
  if (args.widen !== null) return widen(args, prefixes);
  const settings = readSettings(root);

  if (args.write) {
    const baseline = readBaseline(root);
    if (!baseline) {
      return emit(args, {}, `ux-gate: ${BASELINE_FILE} is missing. Restore it from git (git checkout -- ${BASELINE_FILE}); ux:baseline never creates or raises it.`, 1);
    }
    const measured = measure(gateFiles(root, workingTree(root), settings), { root, settings });
    const { next, changes } = lowerBaseline(baseline, measured);
    if (changes.length) writeFileSync(path.join(root, BASELINE_FILE), serializeBaseline(next));
    const { increases } = compareToBaseline(measured, next);
    const lowered = changes.length
      ? `Lowered ${BASELINE_FILE}:\n  ${changes.join('\n  ')}`
      : `${BASELINE_FILE} is already as low as the Tower measures.`;
    const introduced = increases.length ? markChange(changeBaseReader(root)) : null;
    const text = increases.length
      ? composeFailure([lowered, `Still over the baseline — ux:baseline never raises:\n${formatIncreases(increases, { introduced })}`])
      : lowered;
    return emit(args, { changes, increases }, text, increases.length ? 1 : 0);
  }

  if (args.list) {
    const measured = measure(gateFiles(root, workingTree(root), settings), { root, settings });
    const all = Object.values(measured).flatMap((entry) => entry.offenders).sort((a, b) => b.words - a.words);
    const files = Object.entries(strip(measured)).filter(([, entry]) => entry.count).sort((a, b) => b[1].words - a[1].words);
    const text = [
      `${all.length} offenders in ${files.length} files, ${all.reduce((sum, entry) => sum + entry.words, 0)} words.`,
      '',
      'By file (offenders, words):',
      ...files.map(([file, entry]) => `  ${String(entry.count).padStart(3)}  ${String(entry.words).padStart(5)}  ${file}`),
      '',
      'Every offender, longest first:',
      ...all.map((entry) => `  ${formatOffender(entry)}`),
    ].join('\n');
    return emit(args, { files: Object.fromEntries(files), offenders: all }, text, 0);
  }

  if (args.files) {
    // Edit time: the named files only. A decrease is news, not a failure.
    const tree = workingTree(root);
    const scope = args.files.map((file) => toRelative(root, file)).filter((file) => isGateFile(file, tree, settings));
    const baseline = readBaseline(root) ?? emptyBaseline();
    const measured = measure(scope, { root, settings, tree });
    const { increases, decreases } = compareToBaseline(measured, baseline, { scope });
    const introduced = increases.length ? markChange(changeBaseReader(root, tree)) : null;
    const retired = retiredIn(measured);
    const text = gateMessage({ increases, decreases, introduced, retired });
    return emit(args, { checked: scope, measured: strip(measured), increases, decreases, retired }, text, increases.length || retired.length ? 1 : 0);
  }

  // The whole Tower.
  const started = Date.now();
  const result = checkTower(root);
  const totals = Object.values(result.measured).reduce(
    (sum, entry) => ({ count: sum.count + entry.count, words: sum.words + entry.words }),
    { count: 0, words: 0 },
  );
  const summary = `UX gate: ${result.files.length} files the Tower renders, ${totals.count} legacy offenders (${totals.words} words) held by ${BASELINE_FILE}, ${Date.now() - started}ms.`;
  const code = result.message ? 1 : 0;
  return emit(
    args,
    {
      files: result.files.length,
      totals,
      measured: strip(result.measured),
      increases: result.increases,
      decreases: result.decreases,
      schema: result.schema,
      raises: result.raises,
      loosened: result.loosened,
      retired: result.retired,
    },
    code ? result.message : summary,
    code,
  );
}

if (invokedDirectly(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 2;
  }
}
