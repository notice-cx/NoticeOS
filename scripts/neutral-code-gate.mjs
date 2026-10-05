#!/usr/bin/env node
// PRODUCT CODE NAMES NO INSTALLATION'S OWN SITES OR CLOCK
// (operator, 2026-09-23; decision D30; bead `ro-ujb9.118`).
//
// A stranger's installation must not carry somebody else's sites, or behave
// differently because of them. On 2026-09-23 the operator's own domains stood
// in 216 lines of product source and his time zone in 15, one honest comment
// or demo row at a time, because nothing stopped the next one. This is that
// stop — the sister of the UX gate (`scripts/ux-gate.mjs`) and wired the same
// way: `pnpm neutral:gate`, the pre-commit hook and `pnpm test:scripts` in CI.
//
// WHAT IT FORBIDS, AND WHERE THE LIST COMES FROM. Nothing here names a site.
// The forbidden names are read from THIS installation's own asset list, so the
// gate protects whoever runs it:
//   - every asset id and domain its config documents key rows by — the
//     registers in `scripts/config-registers.mjs` whose rows are keyed by an
//     asset id or a domain (`integrations.json` /assets, `beads.json`
//     /spokes, `domain-costs.json` /domains, ...), read from the installation
//     folder `pnpm config:export` writes the store back into
//     (`installation/`, scripts/installation.mts, bead ro-ujb9.125);
//   - the tracked `neutral-names.json` inventory in the installation folder:
//     the OS's own asset id, each historical site's domain and display name;
//     retired names stay protected after their runtime rows change;
//   - every Google account the installation's sources are routed through: the
//     alias each `integrations.json` row's `ref` names after
//     `GOOGLE_SIGNAL_ACCOUNTS`, and the `GOOGLE_SERVICE_ACCOUNT_<ALIAS>` secret
//     name derived from it (bead ro-ujb9.157).
// Plus one rule that needs no list: a literal IANA time zone. The installation's
// clock is a saved setting (`os_time_zone`, UTC in `config/constants.json`);
// UTC is the one neutral fallback product code may name.
//
// WHAT IT READS. Product source: `apps/tower/{src,shared,worker,vite}`,
// `workers/ingest/src`, `packages/contract/src`, `apps/tower/vite.config.ts`
// and `apps/tower/index.html` — code, comments, styles, JSON and the component
// registry alike, because a comment naming a site is how the next copy of it
// starts. And `scripts/`: the local runner and the host and CLI scripts ship
// with the product too, so a stranger's runner must not file against, back up
// to or describe somebody else's sites (bead ro-ujb9.120; a generated `.mjs`
// is judged as its authored `.mts`, and the folder's README is prose). And the product DEFAULTS, `config/*.json` and `config/*.yaml`: a
// fresh clone seeds those, so a site or zone there is a site or zone in every
// stranger's installation (bead ro-ujb9.125). And the prose that ships beside
// them — `config/*.md` (each register's README and the decision log) and
// `config/changesets/README.md` — which teaches a stranger the product with
// example names; one installation's own history and decisions live in its
// installation folder (bead ro-ujb9.149). And the TEST CODE (bead
// ro-ujb9.151): the Tower, ingest, contract and script suites, the e2e walks,
// their frozen config fixtures and the dev seed ship in the public repository
// too, and a test that passes on somebody's own sites can hide an assumption
// about them. They name invented `.example` sites; a store a suite migrates
// renames the historical seed's rows to them (`db/fixtures/invented-sites.json`).
// The zone rule does not apply there: a time-zone test's data is a zone. The
// one test that must spell the product's old slug — which the historical seed
// also gives the OS asset — is the old-name rule's own (`OLD_NAME_TEST`).
// And the two pages a stranger reads first, `README.md` and `docs/README.md`
// (bead ro-ujb9.139): the repository's first screen names no installation.
// And every operator document that ships with the product (bead ro-ujb9.157):
// `docs/**/*.md`, the scripts' and the Workers' READMEs, the glossary and the
// example secrets files. They explain the product with example names; this
// installation's own history and evidence moved to its installation folder's
// `notes.md`, word for word. Dated records — `docs/reports/`, `docs/briefs/`
// and the capture notes in `docs/artifacts/` — keep the words they were
// written in and are not read.
//
// HOW A NAME MATCHES. Case-insensitively, as a whole name:
//   - a domain anywhere, including inside a URL, a subdomain or a file name
//     (`https://shop.example/x`, `api.shop.example`, `shop.example.svg`);
//   - a dot-less id (the OS asset's, typically the product's own slug) only
//     where it stands alone — `'home-os'`, `home-os's page` — and never as a
//     namespace or a path segment of the PRODUCT's own name: a package scope
//     (`@home-os/contract`), a storage key (`home-os:theme`), a repository path
//     (`github.com/home-os/home-os`) or a longer name (`home-os-central`).
//
// THE ONE PLACE A ZONE MAY BE NAMED is a provider's documented reporting zone
// in the provider catalog (`reportingTimeZones` in
// `packages/contract/src/integrations.ts`): Search Console fixes every
// property's day to Pacific time for every installation, which makes it a fact
// about Google rather than about anybody's clock. Everything else is zero.
//
// There is no baseline and no allowance file (operator rule: no grandfathering).
// A name that must appear is read from the store with a generic default.
//
//   pnpm neutral:gate                       every product and test file (what CI runs)
//   pnpm neutral:gate -- --files <paths>    just these files
//   pnpm neutral:gate -- --names            the names this installation owns
//   node scripts/neutral-code-gate.mjs --staged     staged product and test files (pre-commit)
//   flags: --root <dir>  --json

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_REGISTERS } from './config-registers.mjs';
import { checkoutRelative, installationDir, installationPath, readablePath } from './installation.mjs';

export const GATE_BEAD = 'ro-ujb9.118';
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Directories whose every file is product source. `scripts/` is the local
 * runner and the host and CLI scripts that ship with the product (bead
 * ro-ujb9.120); its tests, its frozen fixture config and its Markdown are not. */
export const PRODUCT_DIRS = Object.freeze([
  'apps/tower/src',
  'apps/tower/shared',
  'apps/tower/worker',
  'apps/tower/vite',
  'workers/ingest/src',
  'packages/contract/src',
  'scripts',
]);
/** The runner and host scripts' own documentation, judged with the rest of the
 * repository's prose rather than as source. */
const SCRIPTS_PROSE = /^scripts\/.*\.md$/;
/** Single product files outside those directories. */
export const PRODUCT_FILES = Object.freeze(['apps/tower/vite.config.ts', 'apps/tower/index.html', 'README.md', 'docs/README.md']);
/** The operator documents that ship beside the product outside docs/ (bead
 * ro-ujb9.157): read as prose, whatever their extension. */
export const PRODUCT_DOCS = Object.freeze([
  'CONTEXT.md',
  'apps/tower/README.md',
  'apps/tower/public/integrations/README.md',
  'db/README.md',
  'packages/mediavine/README.md',
  'scripts/README.md',
  'workers/ingest/README.md',
  'workers/ingest/.dev.vars.example',
  'workers/ingest/.dev.secrets.example.json',
]);
/** The operator documentation directory; every Markdown file in it is product
 * prose except the dated records below. */
export const DOCS_DIR = 'docs';
/** Dated records: they keep the words they were written in. */
export const DATED_DOCS = Object.freeze(['docs/reports/', 'docs/briefs/', 'docs/artifacts/']);
const DOCS_PROSE = /^docs\/.+\.md$/;
/** The product's defaults: every config document and host file a fresh clone
 * ships, directly in this directory (bead ro-ujb9.125). */
export const PRODUCT_DEFAULTS_DIR = 'config';
const PRODUCT_DEFAULT = /^config\/[^/]+\.(?:json|ya?ml)$/;
/** The prose that ships beside those defaults — each register's README, the
 * decision log and the changeset format — which teaches a stranger the product
 * and so names nobody's sites either (bead ro-ujb9.149). */
const PRODUCT_PROSE = /^config\/(?:[^/]+\.md|changesets\/README\.md)$/;
/** The one product prose file below the defaults' own directory. */
export const CHANGESETS_README = 'config/changesets/README.md';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.css', '.html', '.json', '.md']);
const NEUTRAL_NAMES_FILE = 'neutral-names.json';

/** Test code (bead ro-ujb9.151): every file below these directories, every
 * root script test and each suite's own config. */
export const TEST_DIRS = Object.freeze([
  'apps/tower/test',
  'apps/tower/e2e',
  'workers/ingest/test',
  'packages/contract/test',
  'packages/mediavine/test',
  'scripts/fixture-config',
  'db/fixtures',
]);
export const TEST_FILES = Object.freeze([
  'apps/tower/vitest.config.ts',
  'workers/ingest/vitest.config.ts',
  'packages/contract/vitest.config.ts',
]);
const SCRIPT_TEST = /^scripts\/[^/]+\.test\.mjs$/;
/** What a walk writes, never source: the flow gate's results. */
const TEST_OUTPUT = /^apps\/tower\/e2e\/ux-flows-results\//;
const TEST_EXTENSIONS = new Set([...SOURCE_EXTENSIONS, '.sql', '.snap', '.yaml', '.yml']);
/** The old-name rule's own test spells the product's old slug, which the
 * historical seed also gives the OS asset; that one name is its to spell. */
export const OLD_NAME_TEST = 'scripts/product-name.test.mjs';

/** The provider catalog, and the one key under which a zone may be named. */
export const PROVIDER_ZONE_FILE = 'packages/contract/src/integrations.ts';
const PROVIDER_ZONE_KEY = /\breportingTimeZones\s*:/;

/** Is the module at `url` the script node was asked to run? */
export function invokedDirectly(url) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

const toPosix = (file) => file.split(path.sep).join('/');

// ---------------------------------------------------------------------------
// The installation's own names
// ---------------------------------------------------------------------------

function readJson(full) {
  if (!existsSync(full)) return null;
  try {
    return JSON.parse(readFileSync(full, 'utf8'));
  } catch {
    return null;
  }
}

/** RFC 6901, read only. `''` is the whole document. */
function atPointer(doc, pointer) {
  if (pointer === '') return doc;
  let node = doc;
  for (const raw of pointer.split('/').slice(1)) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object') return undefined;
    node = node[token];
  }
  return node;
}

/** How a register's rows are keyed, when they are keyed by something this
 * installation owns: an asset id or a domain. */
function ownedKey(register) {
  if (register.container.includes('{')) return null;
  if (register.shape === 'object') return register.keyRule === 'asset-id' ? 'asset' : null;
  if (register.keyField === 'asset') return 'asset';
  if (register.keyField === 'domain') return 'domain';
  return null;
}

/** A Google account alias, as a source's `ref` names it
 * (`GOOGLE_SIGNAL_ACCOUNTS <alias> -> …`, config/integrations.README.md). */
const GOOGLE_ACCOUNT_REF = /\bGOOGLE_SIGNAL_ACCOUNTS\s+([A-Za-z0-9][A-Za-z0-9_-]*)/g;

/** Every `ref` string under a node, however deep. */
function refsUnder(node, out = []) {
  if (Array.isArray(node)) for (const item of node) refsUnder(item, out);
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'ref' && typeof value === 'string') out.push(value);
      else refsUnder(value, out);
    }
  }
  return out;
}

/**
 * THE NAMES THIS INSTALLATION OWNS, derived — never listed here. Each carries
 * its `kind` (`os-asset`, `asset`, `domain`, `display-name`, `account`) and
 * where it was read. A display name is a proper noun and is matched as
 * written; every other name is matched in any case.
 * @returns {Map<string, { name: string, kind: 'os-asset' | 'asset' | 'domain' | 'display-name' | 'account', source: string }>}
 */
export function installationNames(root = REPO_ROOT) {
  /** @type {Map<string, { name: string, kind: 'os-asset' | 'asset' | 'domain' | 'display-name' | 'account', source: string }>} */
  const names = new Map();
  const rank = { 'os-asset': 5, asset: 4, domain: 3, account: 2, 'display-name': 1 };
  const add = (raw, kind, source) => {
    if (typeof raw !== 'string') return;
    const trimmed = raw.trim();
    const name = kind === 'display-name' ? trimmed : trimmed.toLowerCase();
    // A shorter name would match ordinary words; a display name is matched in
    // its own capitals, so three letters are enough.
    if (name.length < (kind === 'display-name' ? 3 : 4)) return;
    if (kind !== 'display-name' && /\s/.test(name)) return;
    const key = name.toLowerCase();
    const held = names.get(key);
    if (!held || rank[kind] > rank[held.kind]) names.set(key, { name, kind, source });
  };

  for (const register of Object.values(CONFIG_REGISTERS)) {
    const keyed = ownedKey(register);
    if (keyed === null) continue;
    // This installation's own copy (scripts/installation.mts, bead
    // ro-ujb9.125); a clone with none reads the defaults, which name nobody.
    const file = readablePath(register.file, { root });
    const doc = readJson(file);
    if (doc === null) continue;
    const container = atPointer(doc, register.container);
    const kind = keyed === 'domain' ? 'domain' : 'asset';
    const source = `${checkoutRelative(file, { root })}${register.container}`;
    if (register.shape === 'object') {
      if (container && typeof container === 'object' && !Array.isArray(container)) {
        for (const key of Object.keys(container)) add(key, kind, source);
      }
    } else if (Array.isArray(container)) {
      for (const row of container) {
        add(row && typeof row === 'object' ? row[register.keyField] : row, kind, source);
      }
    }
  }

  // The Google accounts its sources are routed through, and the secret name
  // each one's key is kept under.
  const integrationsFile = readablePath('config/integrations.json', { root });
  const integrations = readJson(integrationsFile);
  if (integrations !== null) {
    const source = `${checkoutRelative(integrationsFile, { root })} ref`;
    for (const ref of refsUnder(integrations)) {
      for (const match of ref.matchAll(GOOGLE_ACCOUNT_REF)) {
        add(match[1], 'account', source);
        add(`GOOGLE_SERVICE_ACCOUNT_${match[1].toUpperCase().replace(/-/g, '_')}`, 'account', source);
      }
    }
  }

  const inventory = installationPath(NEUTRAL_NAMES_FILE, { root });
  if (existsSync(inventory)) {
    const source = `${checkoutRelative(inventory, { root })} /assets`;
    let document;
    try { document = JSON.parse(readFileSync(inventory, 'utf8')); }
    catch { throw new Error(`neutral-code gate: cannot read ${checkoutRelative(inventory, { root })}`); }
    if (!document || !Array.isArray(document.assets)) throw new Error(`neutral-code gate: invalid ${checkoutRelative(inventory, { root })}`);
    for (const row of document.assets) {
      if (!row || typeof row.id !== 'string' || !row.id.trim() || typeof row.isOs !== 'boolean'
        || !(row.domain === null || typeof row.domain === 'string')
        || !(row.displayName === null || typeof row.displayName === 'string')) {
        throw new Error(`neutral-code gate: invalid ${checkoutRelative(inventory, { root })}`);
      }
      add(row.id, row.isOs ? 'os-asset' : 'asset', source);
      if (row.domain) add(row.domain, 'domain', source);
      // The OS display name is the product's old name, governed by the old-name rule.
      if (row.displayName && !row.isOs) add(row.displayName, 'display-name', source);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One regex per name. A display name: a whole word in its own capitals. The
 * OS asset's dot-less id: only where it is not the product's namespace (see
 * the header). Every other name — a domain, an asset id, an account — wherever
 * it is not part of a longer word, so a file name or a path segment built on it
 * (`<name>-open.json`, `<name>_x`, `<name>/panel`) is caught too. */
export function nameMatcher(name, kind = null) {
  const body = escapeRegExp(name);
  if (kind === 'display-name') {
    return new RegExp(`(?<![A-Za-z0-9_])${body.replace(/ /g, '\\s+')}(?![A-Za-z0-9_])`, 'g');
  }
  if (kind === 'os-asset' && !name.includes('.')) {
    return new RegExp(`(?<![A-Za-z0-9_@/.:#$-])${body}(?![A-Za-z0-9_/:-])(?!\\.[A-Za-z0-9_])`, 'gi');
  }
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'gi');
}

const ZONE_SHAPES = [
  /(?<![A-Za-z0-9_/-])[A-Z][A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+/g, // Area/Location[/Sub]
  /(?<![A-Za-z0-9_])[A-Z]{3}\d{1,2}[A-Z]{3}(?![A-Za-z0-9_])/g, // the POSIX-style US zones: letters, offset, letters
];
const NEUTRAL_ZONE = /^(?:Etc\/)?(?:UTC|UCT|GMT|Universal|Zulu|Greenwich)(?:[+-]?0)?$/;
const zoneCache = new Map();

/** Does the runtime's own tz database know this name? (The only authority
 * worth asking; `packages/contract/src/time-zone-setting.ts` asks the same.) */
export function isTimeZoneName(candidate) {
  if (zoneCache.has(candidate)) return zoneCache.get(candidate);
  let known = false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    known = true;
  } catch {
    known = false;
  }
  zoneCache.set(candidate, known);
  return known;
}

/**
 * Every offender in one file's text. A test file (`isTestFile`) is judged for
 * names only: its zones are test data.
 * @param {string} text
 * @param {string} file repo-relative, posix
 * @param {Map<string, { name: string, kind: string }>} names
 */
export function findOffenders(text, file, names) {
  const testFile = isTestFile(file);
  const matchers = [...names.values()]
    .filter((entry) => !(file === OLD_NAME_TEST && entry.kind === 'os-asset'))
    .map((entry) => ({ entry, regex: nameMatcher(entry.name, entry.kind) }));
  const offenders = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    for (const { entry, regex } of matchers) {
      regex.lastIndex = 0;
      for (const match of line.matchAll(regex)) {
        offenders.push({ file, line: index + 1, column: match.index + 1, kind: entry.kind, name: match[0], text: line.trim() });
      }
    }
    if (testFile) return;
    for (const shape of ZONE_SHAPES) {
      for (const match of line.matchAll(shape)) {
        const zone = match[0];
        if (NEUTRAL_ZONE.test(zone) || !isTimeZoneName(zone)) continue;
        if (file === PROVIDER_ZONE_FILE && PROVIDER_ZONE_KEY.test(line)) continue;
        offenders.push({ file, line: index + 1, column: match.index + 1, kind: 'zone', name: zone, text: line.trim() });
      }
    }
  });
  return offenders.sort((a, b) => a.line - b.line || a.column - b.column);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** Tests, e2e walks and fixtures are not product source (they are test code,
 * `isTestFile`); the product defaults in config/ are. */
export function isProductFile(file) {
  const posix = toPosix(file);
  if (PRODUCT_DEFAULT.test(posix) || PRODUCT_PROSE.test(posix)) return true;
  if (PRODUCT_DOCS.includes(posix)) return true;
  if (DOCS_PROSE.test(posix)) return !DATED_DOCS.some((dated) => posix.startsWith(dated));
  if (!SOURCE_EXTENSIONS.has(path.extname(posix))) return false;
  if (/(^|\/)(test|tests|__tests__|e2e)\//.test(posix)) return false;
  if (/\.(test|spec)\.[a-z]+$/.test(posix) || /fixture/i.test(posix)) return false;
  // A generated `.mjs`/`.d.mts` is judged as its authored `.mts`.
  if (/\.d\.mts$/.test(posix)) return false;
  if (SCRIPTS_PROSE.test(posix)) return false;
  return PRODUCT_FILES.includes(posix) || PRODUCT_DIRS.some((dir) => posix.startsWith(`${dir}/`));
}

/** The suites, the e2e walks and their fixtures (bead ro-ujb9.151). */
export function isTestFile(file) {
  const posix = toPosix(file);
  if (TEST_OUTPUT.test(posix)) return false;
  if (TEST_FILES.includes(posix) || SCRIPT_TEST.test(posix)) return true;
  if (!TEST_EXTENSIONS.has(path.extname(posix))) return false;
  return TEST_DIRS.some((dir) => posix.startsWith(`${dir}/`));
}

/** Every file the gate judges: product source and prose, and test code. */
export function isGatedFile(file) {
  return isProductFile(file) || isTestFile(file);
}

function walk(root, dir, out) {
  const full = path.join(root, dir);
  if (!existsSync(full)) return;
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(root, rel, out);
    else if (entry.isFile()) out.push(rel);
  }
}

/** Every product file in the checkout, repo-relative. */
export function productFiles(root = REPO_ROOT) {
  const out = [];
  for (const dir of PRODUCT_DIRS) walk(root, dir, out);
  for (const file of [...PRODUCT_FILES, ...PRODUCT_DOCS]) if (existsSync(path.join(root, file))) out.push(file);
  walk(root, DOCS_DIR, out);
  const defaults = path.join(root, PRODUCT_DEFAULTS_DIR);
  if (existsSync(defaults)) {
    for (const entry of readdirSync(defaults, { withFileTypes: true })) {
      if (entry.isFile()) out.push(`${PRODUCT_DEFAULTS_DIR}/${entry.name}`);
    }
  }
  if (existsSync(path.join(root, CHANGESETS_README))) out.push(CHANGESETS_README);
  return [...new Set(out)]
    .filter(isProductFile)
    .filter((file) => !(file.endsWith('.mjs') && existsSync(path.join(root, file.replace(/\.mjs$/, '.mts')))))
    .sort();
}

/** Every test file in the checkout, repo-relative (bead ro-ujb9.151). */
export function testFiles(root = REPO_ROOT) {
  const out = [];
  for (const dir of TEST_DIRS) walk(root, dir, out);
  for (const file of TEST_FILES) if (existsSync(path.join(root, file))) out.push(file);
  const scripts = path.join(root, 'scripts');
  if (existsSync(scripts)) {
    for (const entry of readdirSync(scripts, { withFileTypes: true })) {
      if (entry.isFile()) out.push(`scripts/${entry.name}`);
    }
  }
  return [...new Set(out)].filter(isTestFile).sort();
}

/** Every file the gate judges. */
export function gatedFiles(root = REPO_ROOT) {
  return [...new Set([...productFiles(root), ...testFiles(root)])].sort();
}

/** A file whose change can change the names this installation owns. */
function isNamesSource(file, root) {
  const installed = checkoutRelative(installationDir({ root }), { root });
  return (/^config\/[^/]+\.json$/.test(file)) || file.startsWith(`${installed}/`);
}

function git(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function stagedFiles(root) {
  const result = git(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']);
  if (result.status !== 0) throw new Error(`neutral-code-gate: git diff --cached failed: ${result.stderr}`);
  return result.stdout.split('\0').filter(Boolean);
}

function stagedText(root, file) {
  const result = git(root, ['show', `:${file}`]);
  return result.status === 0 ? result.stdout : null;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

const KIND_LABEL = {
  'os-asset': "the OS asset's id",
  asset: 'an asset id',
  domain: 'a domain',
  'display-name': "a site's display name",
  account: 'a Google account of this installation',
  zone: 'a time zone',
};

export const FIXED_INSTRUCTIONS = [
  "Product code names no installation's own sites, accounts or time zone (D30, AGENTS.md).",
  '  - Behaviour keyed on a site: make it a property of the asset read from the store, with a generic default.',
  "  - The OS's own asset: find it by assets.is_os, never by its id.",
  '  - A Google account: an example alias such as example-signals.',
  '  - A time zone: the saved os_time_zone, or UTC.',
  '  - Demo, gallery and example data: example.com-style names.',
  "  - A product default in config/: generic (no rows, UTC); this installation's own rows live in its installation folder.",
  '  - Comments: name the concept, not the site.',
  "There is no baseline and no allowance: the names come from this installation's own asset list.",
].join('\n');

/**
 * Judge the given files. `read(file)` returns a file's text or null.
 * @returns {{ names: number, files: number, offenders: ReturnType<typeof findOffenders> }}
 */
export function check({ root = REPO_ROOT, files = gatedFiles(root), read, names = installationNames(root) } = {}) {
  const reader = read ?? ((file) => {
    const full = path.join(root, file);
    return existsSync(full) && statSync(full).isFile() ? readFileSync(full, 'utf8') : null;
  });
  const offenders = [];
  let judged = 0;
  for (const file of files) {
    const text = reader(file);
    if (text === null) continue;
    judged += 1;
    offenders.push(...findOffenders(text, file, names));
  }
  return { names: names.size, files: judged, offenders };
}

export function formatReport(result) {
  if (result.offenders.length === 0) {
    return `neutral-code gate: ${result.files} product and test files name none of this installation's ${result.names} sites, ids or domains, and product code no time zone.`;
  }
  const lines = [
    `neutral-code gate: ${result.offenders.length} place(s) in product or test code name this installation's own sites or clock (bead ${GATE_BEAD})`,
    '',
  ];
  for (const offender of result.offenders) {
    const shown = offender.text.length > 160 ? `${offender.text.slice(0, 157)}...` : offender.text;
    lines.push(`  ${offender.file}:${offender.line}  ${KIND_LABEL[offender.kind]} "${offender.name}"`);
    lines.push(`      ${shown}`);
  }
  lines.push('', FIXED_INSTRUCTIONS);
  return lines.join('\n');
}

const USAGE = `neutral-code-gate — product code names no installation's own sites or clock (bead ${GATE_BEAD})

  pnpm neutral:gate                          every product and test file (what CI runs)
  pnpm neutral:gate -- --files <paths...>    just these files
  pnpm neutral:gate -- --names               the names this installation owns, and where each was read
  node scripts/neutral-code-gate.mjs --staged       staged product and test files (the pre-commit hook)
  flags: --root <dir>  --json`;

export function parseArgs(argv) {
  const args = { root: REPO_ROOT, files: null, staged: false, names: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--root') args.root = path.resolve(argv[++i]);
    else if (arg === '--files') {
      args.files = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args.files.push(argv[++i]);
    } else if (arg === '--staged') args.staged = true;
    else if (arg === '--names') args.names = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`neutral-code-gate: unknown argument ${JSON.stringify(arg)}\n\n${USAGE}`);
  }
  return args;
}

export function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  const root = args.root;
  const names = installationNames(root);
  if (args.names) {
    const rows = [...names.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    if (args.json) stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    else for (const row of rows) stdout.write(`${row.kind.padEnd(8)} ${row.name.padEnd(32)} ${row.source}\n`);
    return 0;
  }

  let result;
  if (args.staged) {
    const staged = stagedFiles(root);
    // A staged config document or installation inventory can add a name the product
    // already holds, so it rechecks every product and test file.
    const files = staged.some((file) => isNamesSource(file, root)) ? gatedFiles(root) : staged.filter(isGatedFile);
    const stagedSet = new Set(staged);
    result = check({
      root,
      names,
      files,
      read: (file) => (stagedSet.has(file) ? stagedText(root, file) : readFileSync(path.join(root, file), 'utf8')),
    });
  } else if (args.files) {
    // The same files CI judges, out of those named: product source and prose,
    // and test code by its own rule (names, not zones).
    const files = args.files
      .map((file) => toPosix(path.relative(root, path.resolve(root, file))))
      .filter(isGatedFile);
    result = check({ root, names, files });
  } else {
    result = check({ root, names });
  }

  const code = result.offenders.length === 0 ? 0 : 1;
  if (args.json) stdout.write(`${JSON.stringify({ ...result, exitCode: code }, null, 2)}\n`);
  else (code === 0 ? stdout : stderr).write(`${formatReport(result)}\n`);
  return code;
}

if (invokedDirectly(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 2;
  }
}
