#!/usr/bin/env node
// The UX text report: how much reading each Tower screen asks for.
//
// It extracts every string the Tower can show a person — from
// `apps/tower/{src,shared,worker}` and every module or config document those
// import (the config registers, the contract catalog, `config/*.json`, the job
// descriptions, the ingest Worker behind the service binding) — counts the
// words in each, and lists the long ones, longest first. The thresholds in
// `scripts/ux-gate.settings.json` (labels 12 words, failures 18, accessible
// names 24) only decide what the report calls long; they are a reading aid
// for design review, not a rule. The report never fails a commit or a build:
// whether a sentence on a screen is the right design is a judgement the
// person building the screen makes, with this list in hand.
//
// It is the sister of `scripts/ui-lexicon.test.mjs`, which reads the same
// corpus through `extractVisibleStrings` and does fail on system jargon.
//
// What counts as visible. Everything that can reach a person is presumed
// visible, and only positions that provably cannot are excluded: className
// and class-building calls, data-*/id/key/href-style attributes, import
// specifiers, type positions, property names, comparisons, console and other
// terminal output, SQL, SVG geometry. A JSX paragraph is one string
// (`<p>Text <strong>bold</strong> more</p>` is measured whole, because that is
// what the reader reads), and so is a sentence joined with `+`. `About` and
// `InfoTooltip` content is measured like any other text.
//
// Usage:
//   node scripts/ux-gate.mjs                    every long string the Tower renders
//   node scripts/ux-gate.mjs --files a.tsx ...  just these files
//   node scripts/ux-gate.mjs --summary          per-file counts only
//   node scripts/ux-gate.mjs --json             machine-readable output
//   node scripts/ux-gate.mjs --root <dir>       another checkout

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** True when this module is the script Node was started with. */
export function invokedDirectly(url) {
  try {
    return realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Settings: the thresholds, the directories read, the files skipped
// ---------------------------------------------------------------------------
//
//   budgets.label       12  a heading, button, caption or state line
//   budgets.failure     18  a failure says what happened and what to do
//   budgets.accessible  24  aria-label / alt / sr-only text names a whole
//                           chart or control in one breath
//   scanDirs                every file under these is read
//   traceRoots              read for their imports only: the Vite config
//                           compiles every config document into the bundle
//   notDeskCopy             files never read, each with its reason

export const SETTINGS_FILE = 'scripts/ux-gate.settings.json';
export const BUDGET_KINDS = Object.freeze(['label', 'failure', 'accessible']);
export const SETTINGS_KEYS = Object.freeze(['about', 'budgets', 'scanDirs', 'traceRoots', 'notDeskCopy']);

/** What the report uses when the settings file is missing or malformed. */
export const DEFAULT_SETTINGS = Object.freeze({
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


/** The settings as the report uses them; a malformed or missing file falls
 * back to `DEFAULT_SETTINGS`. */
export function normalizeSettings(json) {
  const source = json && typeof json === 'object' ? json : DEFAULT_SETTINGS;
  const budgets = {};
  for (const kind of BUDGET_KINDS) {
    const words = source.budgets?.[kind]?.words;
    budgets[kind] = Number.isInteger(words) && words > 0 ? words : DEFAULT_SETTINGS.budgets[kind].words;
  }
  const paths = (value, fallback) => (Array.isArray(value) && value.every((item) => typeof item === 'string') ? [...value] : [...fallback]);
  const notDeskCopy = new Map();
  const skipped = source.notDeskCopy && typeof source.notDeskCopy === 'object' ? source.notDeskCopy : DEFAULT_SETTINGS.notDeskCopy;
  for (const [file, entry] of Object.entries(skipped)) notDeskCopy.set(file, String(entry?.reason ?? ''));
  return Object.freeze({
    budgets: Object.freeze(budgets),
    scanDirs: Object.freeze(paths(source.scanDirs, DEFAULT_SETTINGS.scanDirs)),
    traceRoots: Object.freeze(paths(source.traceRoots, DEFAULT_SETTINGS.traceRoots)),
    notDeskCopy,
  });
}

/** The settings file's JSON in `root`, or null when it is absent. */
export function readSettingsJson(root = REPO_ROOT) {
  const file = path.join(root, SETTINGS_FILE);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** The settings for the checkout at `root`. */
export function readSettings(root = REPO_ROOT) {
  try {
    return normalizeSettings(readSettingsJson(root));
  } catch {
    return normalizeSettings(null);
  }
}

/** This checkout's settings: what every function uses unless handed another checkout's. */
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
 * console, so it is developer text and not counted.
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
   * A `+` chain holding a string is ONE string: a
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
// What the Tower reaches through a service binding
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
// Developer-only messages
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
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** Every long string in a measurement, longest first. */
export function longStrings(measured) {
  return Object.values(measured)
    .flatMap((entry) => entry.offenders)
    .sort((a, b) => b.words - a.words || a.file.localeCompare(b.file) || a.line - b.line);
}

const truncate = (text, max = 110) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function formatLongString(entry) {
  return `  ${entry.file}:${entry.line}  ${entry.words} words (${entry.kind}, over ${entry.budget}) · ${entry.context}\n      "${truncate(entry.text)}"`;
}

/** The report as text: a summary line, then each long string (unless
 * `summary` asks for the per-file counts only). */
export function formatReport(measured, { summary = false } = {}) {
  const entries = longStrings(measured);
  const files = Object.entries(measured).filter(([, entry]) => entry.count > 0).sort(([a], [b]) => a.localeCompare(b));
  const measuredFiles = Object.keys(measured).length;
  const lines = [
    `UX text report: ${entries.length} long string(s) in ${files.length} of ${measuredFiles} file(s) the Tower renders ` +
      `(long = over ${BUDGETS.label}/${BUDGETS.failure}/${BUDGETS.accessible} words for labels/failures/accessible names).`,
  ];
  if (!entries.length) return lines.join('\n');
  if (summary) {
    for (const [file, entry] of files) lines.push(`  ${file}  ${entry.count} string(s), ${entry.words} words`);
  } else {
    lines.push(...entries.map(formatLongString));
  }
  lines.push('A long string is something to look at in design review: show the state instead where that reads better, keep the sentence where it earns its place.');
  return lines.join('\n');
}

/** Normalise a path argument to a repo-relative posix path. */
export function relativeToRoot(root, file) {
  const real = (value) => {
    try {
      return realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  return toPosix(path.relative(real(root), real(path.resolve(file))));
}

/** Measure the whole Tower (or just `files`) in the checkout at `root`. */
export function report({ root = REPO_ROOT, files = null } = {}) {
  const tree = workingTree(root);
  const settings = readSettings(root);
  const wanted = files
    ? files.map((file) => relativeToRoot(root, file)).filter((rel) => isGateFile(rel, tree, settings))
    : gateFiles(root, tree, settings);
  return measure(wanted, { root, tree, settings });
}

export function main(argv = process.argv.slice(2)) {
  let root = REPO_ROOT;
  let json = false;
  let summary = false;
  let files = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--json') json = true;
    else if (arg === '--summary') summary = true;
    else if (arg === '--root') root = path.resolve(argv[++i] ?? '.');
    else if (arg === '--files') {
      files = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) files.push(argv[++i]);
    } else {
      process.stderr.write(`ux-gate: unknown option ${arg}\n`);
      return 2;
    }
  }
  const measured = report({ root, files });
  process.stdout.write(json ? `${JSON.stringify({ files: measured, long: longStrings(measured) }, null, 2)}\n` : `${formatReport(measured, { summary })}\n`);
  return 0;
}

if (invokedDirectly(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`ux-gate: ${error?.stack ?? error}\n`);
    process.exitCode = 2;
  }
}
