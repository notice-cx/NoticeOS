import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Registry paths and exports must resolve so the component index remains usable.

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');

const COMPONENTS_DIR = 'apps/tower/src/components';
const REGISTRY_TS = `${COMPONENTS_DIR}/registry.ts`;
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
    (file) => !registered.has(file),
  );

  assert.deepEqual(
    missing,
    [],
    `these components exist but the registry does not know them:\n  ${missing.join('\n  ')}\n` +
      'The registry is what stops the Tower growing four button styles, and it only works if ' +
      'every component is in it. Add an entry to apps/tower/src/components/registry.ts — ' +
      'or extend the entry it duplicates.',
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

// A parser that reads no entries would let a broken index pass.
test('the registry parser preserves multi-export names and paths', () => {
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
});
