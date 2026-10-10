import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateSchemaAndSafety } from './config-apply-core.mjs';
import { installationPath } from './installation.mjs';
import {
  CONFIG_KNOBS,
  SETTABLE_FILES,
  fieldRefusal,
  knobEntries,
  knobsForFile,
  matchKnob,
} from './config-registers.mjs';

// The scalar knobs are only declared if the pipeline actually licenses them.
//
// A knob is a claim in two directions at once: this exact pointer may be
// written, and nothing around it may be. Neither half is visible from the
// declaration alone — the first is decided in `validateSetTarget`, the second is
// decided by everything that file does NOT say. So every knob is driven through
// the real pipeline three times: accepted with a value its rule allows, refused
// with one it does not, and refused one level up.
//
// It reads the REAL config files for the value each pointer holds today. A
// declaration whose rule refuses the committed value is a rule that would refuse
// the operator's own data back at them the first time they open the field.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readConfig(rel) {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
}

/** Resolve a pointer in a parsed document; `undefined` when anything is absent. */
function pointerValue(doc, pointer) {
  let at = doc;
  for (const token of pointer.slice(1).split('/')) {
    if (at === null || typeof at !== 'object' || !Object.prototype.hasOwnProperty.call(at, token)) {
      return undefined;
    }
    at = at[token];
  }
  return at;
}

/** One `file-json-set` changeset, as either entry point would receive it. */
function setChangeset(file, pointer, expect, value) {
  return {
    version: 1,
    slug: 'knob-test',
    createdAt: '2026-09-05T00:00:00.000Z',
    ops: [{ kind: 'file-json-set', file, pointer, expect, value }],
  };
}

/** The pointer one reference token above this one — `''` at the document root,
 * which the pipeline refuses on its own separate ground. */
function parentPointer(pointer) {
  return pointer.slice(0, pointer.lastIndexOf('/'));
}

test('every knob is well formed, and its file is a file the ops may name', () => {
  for (const [key, knob] of knobEntries()) {
    assert.ok(typeof knob.file === 'string' && knob.file.startsWith('config/'), `${key}: file`);
    assert.ok(knob.pointer.startsWith('/'), `${key}: pointer must be an RFC-6901 pointer`);
    assert.ok(knob.label && knob.owner && knob.surface, `${key}: prose`);
    // What changing it costs is drawn beside the field on /settings, never a
    // paragraph the declaration carries.
    assert.equal('consequence' in knob, false, `${key}: no consequence paragraph`);
    // The last reference token IS the field's name, so a refusal names the key
    // an operator would find in the file rather than a label only we use.
    assert.equal(
      knob.field.name,
      knob.pointer.slice(knob.pointer.lastIndexOf('/') + 1),
      `${key}: the field name must be the pointer's last token`,
    );
    assert.ok(knob.field.label && knob.field.describe, `${key}: field prose`);
    assert.equal(typeof knob.field.required, 'boolean', `${key}: field.required`);
  }
});

// A knob in one of the four wholesale-editable files would license nothing that
// was not already licensed, and would read as a rule where there is none.
test('no knob sits in a file that is already settable at any pointer', () => {
  for (const [key, knob] of knobEntries()) {
    assert.ok(
      !SETTABLE_FILES.includes(knob.file),
      `${key}: ${knob.file} is wholesale-editable, so declaring a knob in it decides nothing`,
    );
  }
});

// The `file` a knob names has to be spellable by an op. `RegisterFile` is that
// set written for TypeScript and cannot import this module's data.
test("every knob's file is in the Tower's RegisterFile union", () => {
  const source = readFileSync(path.join(REPO_ROOT, 'apps/tower/shared/changeset.ts'), 'utf8');
  const registerUnion = source.slice(source.indexOf('export type RegisterFile'));
  const assetUnion = source.slice(source.indexOf('export type AssetRegisterFile'));
  const declared =
    registerUnion.slice(0, registerUnion.indexOf(';')) +
    assetUnion.slice(0, assetUnion.indexOf(';'));
  for (const [key, knob] of knobEntries()) {
    assert.ok(declared.includes(`"${knob.file}"`), `${key}: ${knob.file} is not in RegisterFile`);
  }
});

test('every knob resolves in its own file, and the committed value satisfies its rule', () => {
  for (const [key, knob] of knobEntries()) {
    // The product default, and this installation's saved copy when the
    // checkout carries one.
    const own = installationPath(knob.file, { root: REPO_ROOT });
    const copies = [[knob.file, readConfig(knob.file)]];
    if (existsSync(own)) copies.push([path.relative(REPO_ROOT, own), JSON.parse(readFileSync(own, 'utf8'))]);
    for (const [where, doc] of copies) {
      const current = pointerValue(doc, knob.pointer);
      assert.notEqual(current, undefined, `${key}: ${knob.pointer} resolves nowhere in ${where}`);
      assert.equal(
        fieldRefusal(knob.field, current),
        null,
        `${key}: the value ${where} holds today is one this knob would refuse`,
      );
    }
  }
});

test('matchKnob is an exact pointer match — never a parent, never a child', () => {
  assert.equal(
    matchKnob('config/signal-panels.json', '/refresh/windowDays').key,
    'panel-refresh-window',
  );
  assert.equal(matchKnob('config/signal-panels.json', '/refresh/windowDays/0'), null);
  assert.equal(matchKnob('config/signal-panels.json', ''), null);
  assert.equal(matchKnob('config/signal-panels.json', '/refresh'), null);
  // The counters interval is not a knob: the counters job's schedule is the
  // one place that cadence is written.
  assert.equal(matchKnob('config/counters.json', '/intervalMinutes'), null);
  // A file with no knobs answers nothing, and a knob is scoped to its own file.
  assert.equal(matchKnob('config/constants.json', '/intervalMinutes'), null);
  assert.equal(knobsForFile('config/signal-panels.json').length, 2);
  assert.equal(knobsForFile('config/beads.json').length, 0);
});

// `config/beads.json` `/hub` stays undeclared ON PURPOSE: host/port/dataDir is
// how `bd` reaches the Dolt server on this machine, not a portfolio setting,
// and nothing a browser should be able to move. If it is ever declared, that
// is a decision somebody makes here first.
test('the task hub connection is not a knob', () => {
  assert.equal(matchKnob('config/beads.json', '/hub/port'), null);
  assert.throws(
    () => validateSchemaAndSafety(setChangeset('config/beads.json', '/hub/port', 3307, 3308)),
    /not a row of config\/beads\.json|is not editable/,
  );
});

// ---------------------------------------------------------------------------
// The three checks, per knob, through the real pipeline.
// ---------------------------------------------------------------------------

/** A value this knob's rule accepts, and one it refuses, derived from the rule
 * itself rather than hand-picked per knob — so a knob added later is covered by
 * the same three assertions without anybody remembering to write them. */
function probeValues(field) {
  if (field.type === 'integer' || field.type === 'number') {
    const min = field.min ?? 0;
    const max = field.max ?? min + 10;
    return { good: Math.min(min + 1, max), bad: min - 1, badRule: /must be at least/ };
  }
  if (field.type === 'boolean') return { good: true, bad: 'yes', badRule: /must be true or false/ };
  return { good: 'x', bad: 42, badRule: /must be a string/ };
}

for (const [key, knob] of knobEntries()) {
  const { good, bad, badRule } = probeValues(knob.field);
  const current = pointerValue(readConfig(knob.file), knob.pointer);

  test(`${key}: a valid value is accepted at ${knob.file} ${knob.pointer}`, () => {
    assert.doesNotThrow(() =>
      validateSchemaAndSafety(setChangeset(knob.file, knob.pointer, current, good)),
    );
  });

  test(`${key}: an invalid value is refused, naming the field and the rule`, () => {
    assert.throws(
      () => validateSchemaAndSafety(setChangeset(knob.file, knob.pointer, current, bad)),
      (err) => {
        assert.match(err.message, new RegExp(knob.field.name));
        assert.match(err.message, badRule);
        return true;
      },
    );
  });

  test(`${key}: the pointer one level up is refused`, () => {
    const parent = parentPointer(knob.pointer);
    assert.throws(
      () => validateSchemaAndSafety(setChangeset(knob.file, parent, null, good)),
      // At the document root the refusal is the older, blunter one — a set may
      // never replace a whole file — and that is the same answer for the same
      // reason: the knob licenses its own pointer and nothing containing it.
      parent === '' ? /refusing to replace an entire file/ : /is not a settable knob/,
    );
  });

  test(`${key}: the pointer one level down is refused`, () => {
    assert.throws(
      () => validateSchemaAndSafety(setChangeset(knob.file, `${knob.pointer}/0`, null, good)),
      /is not a settable knob|is not a declared field/,
    );
  });
}

// The two `/refresh` numbers are settable; the block holding them is not, and
// neither is anything else in that file. This is the case the declaration exists
// to make possible without widening `SETTABLE_FILES` to the whole file.
test('a knob does not open the rest of its file', () => {
  assert.throws(
    () =>
      validateSchemaAndSafety(
        setChangeset('config/signal-panels.json', '/refresh/providerCallsPerPass', 0, 5),
      ),
    /is not a settable knob/,
  );
  assert.throws(
    () => validateSchemaAndSafety(setChangeset('config/signal-panels.json', '/updated', 'a', 'b')),
    /is not a settable knob/,
  );
  // A counter CARD is still unreachable: `config/counters.json` has an opaque
  // whole-asset register and no knob, and neither licenses a card.
  assert.throws(
    () =>
      validateSchemaAndSafety(
        setChangeset('config/counters.json', '/assets/meals.example/heading', 'a', 'b'),
      ),
    /is not editable/,
  );
  // And the roster row's own declared field still is reachable — a knob added
  // beside a register must not have taken anything away from it.
  assert.doesNotThrow(() =>
    validateSchemaAndSafety(
      setChangeset('config/signal-panels.json', '/assets/meals.example/enabled', true, false),
    ),
  );
});

test('the declared knobs are the two panel-refresh numbers', () => {
  // The counters interval is not one: the counters job's schedule already says
  // it.
  assert.deepEqual(Object.keys(CONFIG_KNOBS), [
    'panel-refresh-window',
    'panel-freshness-bar',
  ]);
});

test('a retired counters interval may leave a stored document, and never come back', () => {
  assert.doesNotThrow(() =>
    validateSchemaAndSafety({
      version: 1,
      slug: 'retire-counters-interval',
      createdAt: '2026-09-24T00:00:00.000Z',
      ops: [{ kind: 'file-json-delete', file: 'config/counters.json', pointer: '/intervalMinutes', expect: 15 }],
    }),
  );
  assert.throws(
    () => validateSchemaAndSafety(setChangeset('config/counters.json', '/intervalMinutes', 15, 20)),
    /is not editable/,
  );
});
