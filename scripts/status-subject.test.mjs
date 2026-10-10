import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadTypeScript } from './ux-gate.mjs';

// Every status names what it is about.
//
// The UX flow gate holds one status per subject per screen and lists grouped
// by subject (docs/21 principle 3b; apps/tower/e2e/ux-walk.mjs). Guessing a
// status's subject from the markup around it would let a redesign that drops
// a marker make two copies of one status read as two subjects, a silent pass.
// So the product declares it: every status renderer takes a `subject` (a
// `StatusSubject`, `kind:id`) and draws it as `data-status-for`, and the
// walker reads only that. This file is the static half of the
// contract, so a call site that names no subject fails `pnpm test:scripts`
// before a walk ever has to find it.
//
//   - a status renderer (below) used without a `subject` fails, and so does a
//     literal subject that is not `kind:id`;
//   - a hand-drawn live region (`role="status"`) without `data-status-for`
//     fails: it is a status too, and the walker reads it as one.
//
// It reads SOURCE TEXT through the TypeScript parser, like ui-lexicon.test.mjs:
// the `.tsx` files use path aliases only Vite resolves.

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');
const SRC = 'apps/tower/src';

/** The components that draw a status, each from its `subject` prop. */
const STATUS_RENDERERS = {
  StateChip: 'components/StateChip.tsx',
  IntegrationStateChip: 'components/IntegrationStateChip.tsx',
  ConnectionFacts: 'components/IntegrationStateChip.tsx',
  StatusBanner: 'components/surface/StatusBanner.tsx',
  InlineSaveState: 'components/InlineSaveState.tsx',
};

/** `kind:id` — the shape `StatusSubject` types. */
const SUBJECT_SHAPE = /^[a-z][a-z0-9-]*:\S/;

let ts;
const typescript = () => (ts ??= loadTypeScript([REPO_ROOT]));

function sourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...sourceFiles(rel));
    else if (entry.name.endsWith('.tsx')) found.push(rel);
  }
  return found;
}

/** The literal text of an attribute's value, or null when it is computed. */
function literalValue(attribute) {
  const ts_ = typescript();
  const init = attribute.initializer;
  if (!init) return null;
  if (ts_.isStringLiteral(init)) return init.text;
  if (ts_.isJsxExpression(init) && init.expression) {
    if (ts_.isStringLiteral(init.expression) || ts_.isNoSubstitutionTemplateLiteral(init.expression)) return init.expression.text;
  }
  return null;
}

/** Every status in `source` that names no subject, as `line: problem`. */
function statusSubjectProblems(source, name = 'source.tsx') {
  const ts_ = typescript();
  const file = ts_.createSourceFile(name, source, ts_.ScriptTarget.Latest, true, ts_.ScriptKind.TSX);
  const problems = [];
  const lineOf = (node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const visit = (node) => {
    if (ts_.isJsxSelfClosingElement(node) || ts_.isJsxOpeningElement(node)) {
      const tag = node.tagName.getText(file);
      const attributes = new Map();
      for (const property of node.attributes.properties) {
        if (ts_.isJsxAttribute(property)) attributes.set(property.name.getText(file), property);
      }
      if (Object.hasOwn(STATUS_RENDERERS, tag)) {
        const subject = attributes.get('subject');
        const value = subject ? literalValue(subject) : null;
        const expression = subject?.initializer && ts_.isJsxExpression(subject.initializer) ? subject.initializer.expression : null;
        if (!subject || !subject.initializer || (expression && expression.getText(file) === 'undefined')) {
          problems.push(`${lineOf(node)}: <${tag}> names no subject`);
        } else if (value !== null && !SUBJECT_SHAPE.test(value)) {
          problems.push(`${lineOf(node)}: <${tag}> subject "${value}" is not kind:id`);
        }
      }
      const role = attributes.get('role');
      if (/^[a-z]/.test(tag) && role && literalValue(role) === 'status' && !attributes.has('data-status-for')) {
        problems.push(`${lineOf(node)}: <${tag} role="status"> names no subject (data-status-for)`);
      }
    }
    ts_.forEachChild(node, visit);
  };
  visit(file);
  return problems;
}

test('every status renderer draws its subject as data-status-for', () => {
  for (const [component, file] of Object.entries(STATUS_RENDERERS)) {
    const source = readFileSync(path.join(REPO_ROOT, SRC, file), 'utf8');
    assert.match(source, new RegExp(`export function ${component}\\b`), `${component} is not in ${file}`);
    assert.match(source, /data-status-for=\{subject\}/, `${file} does not draw its subject as data-status-for`);
  }
});

test('a status chip, banner or live region that names no subject fails', () => {
  const failing = [
    '<StateChip tone="na" label="Not verified" />',
    '<IntegrationStateChip state="working" />',
    '<ConnectionFacts status={status} subject={undefined} />',
    '<StatusBanner lead="Saves paused" severity="warn">x</StatusBanner>',
    '<InlineSaveState save={save} />',
    '<StateChip tone="na" label="Stale" subject="stale" />',
    '<div role="status">Loading…</div>',
  ];
  for (const snippet of failing) {
    const source = `export const View = () => <>${snippet}</>;`;
    assert.equal(statusSubjectProblems(source).length, 1, `not caught: ${snippet}`);
  }
  const passing = [
    '<StateChip tone="na" label="Not verified" subject={`site:${provider}:${asset}`} />',
    '<IntegrationStateChip state="working" subject="integration:bing-webmaster" />',
    '<StatusBanner lead="Saves paused" subject="config:saves" severity="warn">x</StatusBanner>',
    '<div role="status" data-status-for="route:desk">Loading…</div>',
    '<Chip role="status" />',
  ];
  for (const snippet of passing) {
    const source = `export const View = () => <>${snippet}</>;`;
    assert.deepEqual(statusSubjectProblems(source), [], `refused: ${snippet}`);
  }
});

test('every status the Tower draws names its subject', () => {
  const problems = sourceFiles(SRC).flatMap((file) =>
    statusSubjectProblems(readFileSync(path.join(REPO_ROOT, file), 'utf8'), file).map((problem) => `${file}:${problem}`),
  );
  assert.deepEqual(problems, [], `give each its subject (a StatusSubject, kind:id):\n  ${problems.join('\n  ')}`);
});
