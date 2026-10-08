import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkoutRelative, installationDir } from './installation.mjs';

// THE PRODUCT IS CALLED NOTICEOS (decision D26, beads ro-ujb9.77.1, ro-ujb9.77.4).
//
// Notice is the company and NoticeOS its first product, as www.notice.cx sells
// it. Before the rename the product's old name stood on 516 lines of the Tower
// alone and in every package name, one label, title or import at a time, so
// this is the stop for the next one. Two rules:
//
// 1. WHAT A PERSON READS (ro-ujb9.77.1). The old name may not come back into the
//    Tower's screens and pages (`apps/tower/src`, `apps/tower/shared`,
//    `apps/tower/public` and the HTML pages beside them) or any tracked
//    Markdown document, bar the historical records below.
//
// 2. WHAT A CONTRIBUTOR READS (ro-ujb9.77.4). No file imports or names the old
//    package scope `@reindex-os/`, and product code (the Tower, the ingest,
//    the packages and the scripts, not their tests) carries no `Reindex…`
//    identifier and no `x-reindex-` wire name. The names a running
//    installation or an old bead still carries — the REINDEX_* environment
//    variables, the `reindex-os:` browser keys, the `reindex_*` task metadata
//    and the `reindex-handoff` label — are read for compatibility, and each is
//    spelled as a literal in exactly one registry module, so nothing else can
//    start writing them again. The list of names a working installation keeps
//    is docs/06-operations.md § Legacy names.
//
// WHAT MAY KEEP THE OLD NAME. Dated records keep the wording they were written
// under, and one installation's own documents are its owner's, not the
// product's. Each entry is a path prefix with its reason; an entry that stops
// matching a tracked file fails the suite, so the list only shrinks.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The old product name as a person reads it: `ReindexOS`, `Reindex OS`, the
 * lowercase `reindexos`, and the lockup's `Reindex<span …>OS</span>`. */
export const OLD_PRODUCT_NAME = /reindex(?:\s|<[^>]*>)*os\b/i;

/** The short form a sentence used for the product ("Reindex owns the
 * credential store"): the capitalised word standing alone. Not a code name
 * (rule 2 has those) and not the owner's company, Reindex Ventures, whose name
 * is the owner's data. */
export const OLD_SHORT_NAME = /(?<![-\w])Reindex(?![-\w])(?!\s+Ventures)/;

/** Names a running installation keeps on purpose (docs/06-operations.md
 * § Legacy names): removed from the text before rule 1 reads it. */
export const LEGACY_NAMES = Object.freeze(['com.reindexos.local']);

/** Historical records, each with why it keeps its original wording. */
export const HISTORICAL_PATHS = Object.freeze({
  'docs/reports/': 'Dated reports: a record of what was found under the name of the day.',
  'docs/artifacts/': 'Dated evidence: captures, measurements and the scripts that took them.',
  'docs/briefs/': 'Dated briefs handed to agents, kept as written.',
  'docs/19-architecture-implementation-ux-audit.md': 'A dated audit of the repository as it stood on its review date.',
  'config/decisions.md': "The decision register's rows are dated decisions; what a past decision said is not rewritten.",
});

/** Blocks that name the old product on purpose: the one list of legacy names,
 * and blocks another repository owns a byte-identical copy of, changed only
 * together with every copy by the bead named. */
export const SHARED_BLOCKS = Object.freeze([
  Object.freeze({
    file: 'docs/06-operations.md',
    begin: '<!-- legacy-names:begin -->',
    end: '<!-- legacy-names:end -->',
    bead: null,
    why: 'The list of legacy names says what the product was called, once, so a contributor can recognize every old name still in use.',
  }),
]);

/** This installation's own folder, repo-relative with a trailing slash, or
 * null when it sits outside the checkout. Its documents are the owner's. */
const INSTALLATION_PREFIX = (() => {
  const relative = checkoutRelative(installationDir({ root: REPO_ROOT }), { root: REPO_ROOT });
  return path.isAbsolute(relative) ? null : `${relative}/`;
})();

const USER_VISIBLE_ROOTS = ['apps/tower/src/', 'apps/tower/shared/', 'apps/tower/public/'];
const USER_VISIBLE_FILES = ['apps/tower/index.html', 'apps/tower/viewport-audit.html'];
const TEXT = /\.(?:tsx?|mts|mjs|js|css|html|md|json|svg|txt)$/;

function tracked() {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(listed.status, 0, `git ls-files failed: ${listed.stderr}`);
  return listed.stdout.split('\0').filter((name) => name !== '');
}

const historical = (file) => Object.keys(HISTORICAL_PATHS).some((prefix) => file.startsWith(prefix));
const ownersOwn = (file) => INSTALLATION_PREFIX !== null && file.startsWith(INSTALLATION_PREFIX);

export function inScope(file) {
  if (historical(file) || ownersOwn(file)) return false;
  if (USER_VISIBLE_FILES.includes(file)) return true;
  if (USER_VISIBLE_ROOTS.some((root) => file.startsWith(root))) return TEXT.test(file);
  return file.endsWith('.md');
}

/** `text` with every shared block of `file` blanked, line count kept. */
function withoutSharedBlocks(file, text) {
  let out = text;
  for (const block of SHARED_BLOCKS.filter((entry) => entry.file === file)) {
    const start = out.indexOf(block.begin);
    const end = out.indexOf(block.end, start);
    if (start === -1 || end === -1) continue;
    out = out.slice(0, start) + out.slice(start, end).replace(/[^\n]/g, ' ') + out.slice(end);
  }
  return out;
}

/** Each line of `text` that still names the product by its old name. */
export function oldNameLines(text) {
  const found = [];
  text.split('\n').forEach((line, index) => {
    let scrubbed = line;
    for (const legacy of LEGACY_NAMES) scrubbed = scrubbed.split(legacy).join('');
    if (OLD_PRODUCT_NAME.test(scrubbed) || OLD_SHORT_NAME.test(scrubbed)) {
      found.push({ line: index + 1, text: line.trim().slice(0, 160) });
    }
  });
  return found;
}

// ── rule 2: code, package and wire names ────────────────────────────────────

/** Product code: what ships, not what tests it. */
const PRODUCT_CODE_ROOTS = ['apps/tower/src/', 'apps/tower/shared/', 'apps/tower/worker/', 'apps/tower/vite/', 'apps/tower/e2e/',
  'workers/ingest/src/', 'packages/contract/src/', 'packages/mediavine/src/', 'scripts/'];
const PRODUCT_CODE_FILES = ['apps/tower/vite.config.ts', 'apps/tower/index.html', 'workers/ingest/wrangler.jsonc', 'apps/tower/wrangler.jsonc'];
const CODE = /\.(?:tsx?|mts|mjs|js|jsonc?|html|css|plist)$/;
const TEST_FILE = /(?:\.test\.|\/test\/|-test\.|\.spec\.)/;

export function isProductCode(file) {
  if (historical(file) || ownersOwn(file) || TEST_FILE.test(file)) return false;
  if (PRODUCT_CODE_FILES.includes(file)) return true;
  return PRODUCT_CODE_ROOTS.some((root) => file.startsWith(root)) && CODE.test(file);
}

/** Names retired everywhere in product code, comments included. */
export const RETIRED_CODE_NAMES = Object.freeze([
  Object.freeze({ pattern: /@reindex-os\//, what: 'the old package scope (now @noticeos/)' }),
  Object.freeze({ pattern: /(?<![A-Za-z])[Rr]eindex[A-Z][A-Za-z]*/, what: 'a Reindex… identifier' }),
  Object.freeze({ pattern: /x-reindex-/i, what: 'an x-reindex- header or media type' }),
  Object.freeze({ pattern: /reindexos-/, what: 'a reindexos- name' }),
  Object.freeze({ pattern: /reindex-os-(?:tower|ingest)\b/, what: 'an old Worker name (now noticeos-tower / noticeos-ingest)' }),
  Object.freeze({ pattern: /(?:process\.)?env\.REINDEX_|<key>REINDEX_/, what: 'a direct read or write of a REINDEX_* variable (scripts/product-env.mts reads both names)' }),
]);

/** Legacy names written as LITERALS, each allowed only in the one module that
 * reads it for compatibility. A mention in a comment (in backticks) is prose. */
export const LEGACY_LITERALS = Object.freeze([
  Object.freeze({
    pattern: /["']REINDEX_[A-Z_]+["']/,
    registry: ['scripts/product-env.mts', 'scripts/product-env.mjs', 'scripts/product-env.d.mts'],
    what: 'a pre-rename environment variable',
  }),
  Object.freeze({
    pattern: /["']reindex-os:/,
    registry: ['apps/tower/src/lib/browser-storage.ts'],
    what: 'a pre-rename browser storage key',
  }),
  Object.freeze({
    pattern: /["'](?:reindex_(?:source|asset|kind|rule|key|panel_asset|panel_date|push_asset|task_map_asset)|reindex-handoff)["']/,
    registry: ['packages/contract/src/task-metadata.mts', 'packages/contract/src/task-metadata.mjs', 'packages/contract/src/task-metadata.d.mts'],
    what: 'a pre-rename task metadata key or handoff label',
  }),
  Object.freeze({
    pattern: /["']com\.reindexos\.local["']/,
    registry: ['scripts/resource-names.mts', 'scripts/resource-names.mjs', 'scripts/resource-names.d.mts'],
    what: 'the launchd label a service installed before the rename keeps',
  }),
  // An older store's database and bucket names live in that installation's
  // own folder (resource-names.json, bead ro-ujb9.77.8), never in product code
  // or the Worker configs a stranger deploys.
  Object.freeze({
    pattern: /["']reindex-os-(?:central|raw-signals)["']/,
    registry: [],
    what: "a resource name only the owner's installation folder may keep",
  }),
]);

/** Each problem rule 2 finds in one file's text. */
export function codeNameProblems(file, text) {
  const found = [];
  text.split('\n').forEach((line, index) => {
    for (const { pattern, what } of RETIRED_CODE_NAMES) {
      if (pattern.test(line)) found.push(`${file}:${index + 1}  ${what}: ${line.trim().slice(0, 140)}`);
    }
    for (const { pattern, registry, what } of LEGACY_LITERALS) {
      if (!registry.includes(file) && pattern.test(line)) found.push(`${file}:${index + 1}  ${what} outside ${registry[0] ?? 'the installation folder'}: ${line.trim().slice(0, 140)}`);
    }
  });
  return found;
}

const FILES = tracked();
const SCANNED = FILES.filter(inScope);
const CODE_FILES = FILES.filter(isProductCode);

test('the product-name rule has the Tower and the living documents to read', () => {
  assert.ok(SCANNED.length > 300, `only ${SCANNED.length} files in scope — the listing did not resolve`);
  for (const file of ['apps/tower/index.html', 'apps/tower/src/components/BrandLockup.tsx', 'README.md', 'AGENTS.md', 'CONTEXT.md', 'docs/14-ui-standards.md']) {
    assert.ok(SCANNED.includes(file), `${file} must be read by the rule`);
  }
  for (const file of ['config/decisions.md']) {
    assert.ok(!SCANNED.includes(file), `${file} is a historical record the rule leaves alone`);
  }
});

test('the rule sees every way the old name was written', () => {
  for (const sample of ['ReindexOS', 'the Reindex OS', 'reindexos-tokens.json', 'Reindex<span className="brand-os">OS</span>', "ReindexOS's own",
    'Reindex owns the credential store', "Check Reindex’s database"]) {
    assert.equal(oldNameLines(sample).length, 1, sample);
  }
  for (const sample of ['NoticeOS', 'reindex-os', 'reindex_key', 'reindex-os-central', 'launchctl print gui/501/com.reindexos.local', 'Reindex Ventures',
    'X-Reindex-Runner-Door', 'ReindexSignIn']) {
    assert.deepEqual(oldNameLines(sample), [], sample);
  }
});

test('nothing a person reads calls the product by its old name', () => {
  const offenders = [];
  for (const file of SCANNED) {
    const text = withoutSharedBlocks(file, readFileSync(path.join(REPO_ROOT, file), 'utf8'));
    for (const hit of oldNameLines(text)) offenders.push(`${file}:${hit.line}  ${hit.text}`);
  }
  assert.deepEqual(offenders, [], `the product is NoticeOS (D26); rename these, or record a dated file in HISTORICAL_PATHS with its reason:\n${offenders.join('\n')}`);
});

test('every historical entry still names a tracked record', () => {
  const publicManifest = path.join(REPO_ROOT, 'public-source.json');
  const exported = existsSync(publicManifest) ? JSON.parse(readFileSync(publicManifest, 'utf8')) : null;
  if (exported) {
    assert.equal(exported.schema, 'noticeos-public-source/1');
    assert.match(exported.commit, /^[a-f0-9]{40}$/);
    assert.ok(Array.isArray(exported.files) && exported.files.length > 100);
  }
  for (const prefix of Object.keys(HISTORICAL_PATHS)) {
    // The history-free export deliberately omits private reports and evidence.
    // A published historical path must still exist; private checkouts keep the
    // original stale-exemption check for their complete tracked inventory.
    if (exported && /^docs\/(?:reports|artifacts|briefs)\/$/u.test(prefix)
      && !exported.files.some(({ file }) => file.startsWith(prefix))) continue;
    assert.ok(FILES.some((file) => file.startsWith(prefix)), `${prefix} matches no tracked file; remove it from HISTORICAL_PATHS`);
  }
});

test('every shared block still needs its exception, and names the bead that removes it', () => {
  for (const block of SHARED_BLOCKS) {
    const text = readFileSync(path.join(REPO_ROOT, block.file), 'utf8');
    const start = text.indexOf(block.begin);
    const end = text.indexOf(block.end, start);
    assert.ok(start !== -1 && end !== -1, `${block.file} no longer carries ${block.begin}…${block.end}`);
    if (block.bead === null) continue; // a permanent block
    assert.ok(oldNameLines(text.slice(start, end)).length > 0, `${block.file}'s shared block no longer names the old product; remove its entry (bead ${block.bead})`);
    assert.match(block.bead, /^ro-[a-z0-9.]+$/);
  }
});

test('the browser tab and the lockup say NoticeOS', () => {
  const html = readFileSync(path.join(REPO_ROOT, 'apps/tower/index.html'), 'utf8');
  assert.match(html, /<title>NoticeOS · [^<]+<\/title>/);
  const lockup = readFileSync(path.join(REPO_ROOT, 'apps/tower/src/components/BrandLockup.tsx'), 'utf8');
  assert.match(lockup, /Notice<span className="brand-os">OS<\/span>/);
});

test('the code-name rule reads the product code and leaves tests alone', () => {
  assert.ok(CODE_FILES.length > 300, `only ${CODE_FILES.length} code files in scope — the listing did not resolve`);
  for (const file of ['scripts/os-up.mjs', 'apps/tower/vite/runner-door.ts', 'workers/ingest/src/posthog-dumps.ts', 'packages/mediavine/src/index.ts',
    'apps/tower/src/lib/task-handoff.ts', 'scripts/launchd/local-service.plist']) {
    assert.ok(CODE_FILES.includes(file), `${file} must be read by the code-name rule`);
  }
  for (const file of ['scripts/os-up.test.mjs', 'apps/tower/test/browser-storage.test.tsx', 'apps/tower/e2e/journeys.spec.ts']) {
    assert.ok(!CODE_FILES.includes(file), `${file} is a test; it may build a pre-rename shape on purpose`);
  }
});

test('the code-name rule sees every retired name, and lets the registries and the prose keep theirs', () => {
  for (const line of ['import { x } from "@reindex-os/contract";', 'function reindexLane() {}', 'mutation ReindexSignIn(', '"x-reindex-runner-door"',
    'https://reindexos-cache.internal/', 'process.env.REINDEX_OS_MANAGED', '<key>REINDEX_OS_HOME</key>', '"service": "reindex-os-ingest"']) {
    assert.equal(codeNameProblems('scripts/example.mjs', line).length, 1, line);
  }
  for (const line of ["const home = 'REINDEX_OS_HOME';", 'const key = "reindex-os:theme";', "metadata['reindex_key']", "label: 'reindex-handoff'",
    "const LABEL = 'com.reindexos.local';", "const DB_NAME = 'reindex-os-central';"]) {
    assert.equal(codeNameProblems('scripts/example.mjs', line).length, 1, line);
  }
  assert.deepEqual(codeNameProblems('scripts/product-env.mts', 'home: { name: "NOTICEOS_HOME", legacy: "REINDEX_OS_HOME" },'), []);
  assert.deepEqual(codeNameProblems('apps/tower/src/lib/browser-storage.ts', 'export const LEGACY_STORAGE_PREFIX = "reindex-os:";'), []);
  // Prose about the legacy names, and ids that stay ids, pass.
  for (const line of ['// a bead filed before the rename carries `reindex_*` and `reindex-handoff`', "asset: 'reindex-os'", 'reindex-os-central',
    '<string>com.reindexos.local</string>', 'Reindex Ventures LLC']) {
    assert.deepEqual(codeNameProblems('scripts/example.mjs', line), [], line);
  }
});

test('no product code uses a retired code, package or wire name', () => {
  const problems = CODE_FILES.flatMap((file) => codeNameProblems(file, readFileSync(path.join(REPO_ROOT, file), 'utf8')));
  assert.deepEqual(problems, [], `rename these (ro-ujb9.77.4), or read the legacy name through its registry module:\n${problems.join('\n')}`);
});

test('no tracked file imports or names the old package scope', () => {
  const offenders = FILES.filter((file) => !historical(file) && !ownersOwn(file) && /\.(?:tsx?|mts|mjs|js|json|jsonc|ya?ml|md)$/.test(file))
    .filter((file) => file !== 'scripts/product-name.test.mjs')
    // The product's config documents are settings, read only by seed-validation
    // tests (scripts/test-config-isolation.mts); their prose is `config/**/*.md`.
    .filter((file) => !file.startsWith('config/') || file.endsWith('.md'))
    .filter((file) => /@reindex-os\//.test(readFileSync(path.join(REPO_ROOT, file), 'utf8')));
  assert.deepEqual(offenders, [], 'the workspace scope is @noticeos/ (ro-ujb9.77.4)');
});
