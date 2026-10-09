import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// THE COMPONENT REGISTRY IS ONLY AN INDEX IF SOMETHING READS IT
// (doc 14 anti-duplication mechanic #1).
//
// `apps/tower/src/components/registry.ts` is the Tower's component index, and
// the `/dev/kitchen-sink` route renders it. Nothing else describes the
// component set: there is no prose mirror to keep in step.
//
// Three things could drift silently, and this is what fails on each:
//   1. a component in `components/` with no registry entry — the near-duplicate
//      the registry exists to prevent gets built because nobody saw the row;
//   2. an entry naming a file or an export that is gone — the index points at
//      something that no longer answers;
//   3. an entry with no demo on the kitchen-sink page — the one place a person
//      looks falls behind the data.
//
// It is the sister of `ui-noun.test.mjs` and `ui-lexicon.test.mjs`: the same
// shape, the same exact-match exemptions with a reason each, and the same rule
// that an exemption which stops matching is deleted rather than kept.
//
// WHAT IT READS: source text, never a module. These are `.tsx` files with JSX
// and path aliases that only Vite resolves, so the check is textual by
// necessity — which also keeps it honest about what a reader would find.

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');

const COMPONENTS_DIR = 'apps/tower/src/components';
const REGISTRY_TS = `${COMPONENTS_DIR}/registry.ts`;
const KITCHEN_SINK = 'apps/tower/src/routes/KitchenSinkRoute.tsx';

/**
 * `.tsx` files under `components/` that deliberately hold NO registry entry.
 * Each needs a reason, and the pruning test below deletes an entry that has
 * stopped being true — an allowlist nobody prunes is a habit, not a decision.
 *
 * The bar for landing here is high: `components/ui/` is NOT exempt. Those
 * primitives are vendored rather than written, but doc 14's stack table names
 * them and a second copy of one is as much a duplicate as any other.
 */
const NOT_A_REGISTRY_COMPONENT = {
  // (empty — every component file currently carries an entry)
};

/**
 * Registry entries the kitchen sink does not render UNDER THEIR OWN NAME, each
 * with its reason. A demo that would be a second copy of an existing one is
 * worse than an exception stated out loud. (An entry that renders but cannot
 * stage every variant says so in its own `demo` field in registry.ts.)
 */
const NO_STANDALONE_DEMO = {
  Command:
    'the cmdk parts have no face of their own — the gallery renders them through ' +
    "`CommandPalette inline`, which exists for exactly that, and a raw second menu " +
    'beside it would demo the same markup twice.',
  'DecisionLaneSummary / MobileCellLabel / EvidenceLine':
    'the shared decision-lane vocabulary is drawn INSIDE the two decision tables the ' +
    'gallery already renders (`QueryVisibilityRankings` and `PageDecisions`); shown ' +
    'alone it would be four words and a colour with no rows under them.',
};

/** Every `.tsx` under `components/`, repo-relative. `.ts` files are not
 * components — `nav-items.ts` is data and `registry.ts` is this index. */
function componentFiles(dir) {
  const found = [];
  for (const entry of readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...componentFiles(rel));
    else if (entry.name.endsWith('.tsx')) found.push(rel);
  }
  return found;
}

const read = (name) => readFileSync(path.join(REPO_ROOT, name), 'utf8');

/**
 * The registry's entries, parsed out of the source. Reading the text rather
 * than importing the module keeps this test free of a TypeScript loader, and
 * the shape it matches is the one every entry is written in.
 */
function registryEntries(source) {
  return [...source.matchAll(/^ {4}name: "([^"]+)",\n {4}file: "([^"]+)",/gm)].map((m) => ({
    name: m[1],
    file: m[2],
    /** `Tabs / TabPanel` is one file exporting two components; each part is a
     * name that has to resolve on its own. */
    parts: m[1].split(' / '),
  }));
}

/** An entry's `file` is written relative to `src/`, which is how a reader
 * following it from `components/` would type it. */
const repoPath = (file) => `apps/tower/src/${file}`;

/** A whole-word match, so `Command` does not resolve on `CommandPalette` and
 * `Card` does not resolve on `AssetCard`. */
function mentionsWord(haystack, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`).test(haystack);
}

const COMPONENT_FILES = componentFiles(COMPONENTS_DIR);
const ENTRIES = registryEntries(read(REGISTRY_TS));

// A guard that scans nothing passes forever.
test('the registry check has a registry to check', () => {
  assert.ok(
    COMPONENT_FILES.length > 50,
    `only ${COMPONENT_FILES.length} component file(s) found — the directory walk did not resolve`,
  );
  assert.ok(
    ENTRIES.length > 50,
    `only ${ENTRIES.length} registry entr(ies) parsed — the entry shape in registry.ts changed, ` +
      'and a parser that reads nothing passes forever',
  );
  assert.ok(
    ENTRIES.some((entry) => entry.file === 'components/BrandLockup.tsx'),
    'the parse must find BrandLockup, an entry every Tower draws',
  );
});

test('every component file has a registry entry (doc 14 mechanic #1)', () => {
  const registered = new Set(ENTRIES.map((entry) => repoPath(entry.file)));
  const missing = COMPONENT_FILES.filter(
    (file) => !registered.has(file) && !Object.hasOwn(NOT_A_REGISTRY_COMPONENT, path.basename(file)),
  );

  assert.deepEqual(
    missing,
    [],
    `these components exist but the registry does not know them:\n  ${missing.join('\n  ')}\n` +
      'The registry is what stops the Tower growing four button styles, and it only works if ' +
      'every component is in it. Add an entry to apps/tower/src/components/registry.ts — ' +
      'or extend the entry it duplicates. A file that genuinely is not a component belongs in ' +
      'NOT_A_REGISTRY_COMPONENT in this file, with its reason.',
  );
});

test('every registry entry names a component that exists', () => {
  const offenders = [];

  for (const entry of ENTRIES) {
    const file = repoPath(entry.file);
    if (!COMPONENT_FILES.includes(file)) {
      offenders.push(`${entry.name}  →  ${entry.file} does not exist`);
      continue;
    }
    const source = read(file);
    for (const part of entry.parts) {
      const declared = new RegExp(
        `export\\s+(?:default\\s+)?(?:async\\s+)?(?:function|const|class|let|var)\\s+` +
          `${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_$])`,
      );
      if (!declared.test(source)) {
        offenders.push(`${entry.name}  →  ${entry.file} exports no ${part}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `the registry points at components that are not there:\n  ${offenders.join('\n  ')}\n` +
      'An entry names the EXPORT a caller imports — several exports from one file are joined ' +
      'with " / " and each has to resolve. A renamed or deleted component means the entry ' +
      'changes with it; an index pointing at nothing is worse than no index.',
  );
});

test('the kitchen sink renders every registry entry', () => {
  const sink = read(KITCHEN_SINK);
  const missing = ENTRIES.filter(
    (entry) =>
      !Object.hasOwn(NO_STANDALONE_DEMO, entry.name) &&
      !entry.parts.some((part) => mentionsWord(sink, part)),
  ).map((entry) => `${entry.name}  (${entry.file})`);

  assert.deepEqual(
    missing,
    [],
    `these registry entries have no demo on /dev/kitchen-sink:\n  ${missing.join('\n  ')}\n` +
      'registry.ts\'s own header says every entry must render there — it is the visual ' +
      'reference a reviewer opens and the only place a component can be compared with its ' +
      'neighbours before a fifth one is written. Add a Section to ' +
      `${KITCHEN_SINK}. A component with no face of its own is an exception: record it in ` +
      'NO_STANDALONE_DEMO in this file with its reason.',
  );
});

// The registry stopped being documentation the moment something imported it,
// and that importer is the thing keeping this whole check honest: without it,
// a registry entry could be right about a component nobody ever renders.
test('the kitchen sink actually imports the registry', () => {
  const sink = read(KITCHEN_SINK);
  assert.match(
    sink,
    /import \{ COMPONENT_REGISTRY \} from "@\/components\/registry";/,
    `${KITCHEN_SINK} must import COMPONENT_REGISTRY — the gallery's contents are the registry's ` +
      'own inventory, so an entry added to registry.ts appears there without anyone editing the ' +
      'route. A registry with no importer is a file, not a mechanism.',
  );
  assert.match(
    sink,
    /COMPONENT_REGISTRY\.length/,
    'the gallery must render the registry rather than merely import it',
  );
});

// An allowlist nobody prunes stops being a decision and becomes a habit.
test('every registry exemption still applies', () => {
  const stale = [];

  for (const [basename, reason] of Object.entries(NOT_A_REGISTRY_COMPONENT)) {
    const file = COMPONENT_FILES.find((name) => path.basename(name) === basename);
    if (!file) stale.push(`${basename} no longer exists (${reason})`);
    else if (ENTRIES.some((entry) => repoPath(entry.file) === file)) {
      stale.push(`${basename} now HAS a registry entry — drop it from NOT_A_REGISTRY_COMPONENT`);
    }
  }

  const names = new Set(ENTRIES.map((entry) => entry.name));
  const sink = read(KITCHEN_SINK);
  for (const name of Object.keys(NO_STANDALONE_DEMO)) {
    if (!names.has(name)) stale.push(`"${name}" is no longer a registry entry`);
    else if (ENTRIES.find((entry) => entry.name === name).parts.some((p) => mentionsWord(sink, p))) {
      stale.push(`"${name}" now renders in the kitchen sink — drop it from NO_STANDALONE_DEMO`);
    }
  }

  assert.deepEqual(
    stale,
    [],
    `these exemptions no longer describe anything — delete them:\n  ${stale.join('\n  ')}`,
  );
});

// The guard has to be able to FAIL, or a broken parser would read as a clean
// registry. These are the two shapes it is actually about.
test('the guard sees a missing entry and a name that no longer resolves', () => {
  const entries = registryEntries(
    [
      'export const COMPONENT_REGISTRY: RegistryEntry[] = [',
      '  {',
      '    name: "Ghost / GhostRow",',
      '    file: "components/Ghost.tsx",',
      '    purpose: "nothing",',
      '    variants: [],',
      '  },',
      '];',
    ].join('\n'),
  );
  assert.deepEqual(
    entries,
    [{ name: 'Ghost / GhostRow', file: 'components/Ghost.tsx', parts: ['Ghost', 'GhostRow'] }],
    'the parser must read an entry and split a two-component name',
  );
  assert.equal(
    COMPONENT_FILES.includes(repoPath(entries[0].file)),
    false,
    'an entry naming a file that does not exist must be seen as missing',
  );
  assert.ok(mentionsWord('<CommandPalette />', 'CommandPalette'), 'a whole word must match');
  assert.equal(
    mentionsWord('<CommandPalette />', 'Command'),
    false,
    'a prefix of a longer identifier is not a demo of the shorter one',
  );
});
