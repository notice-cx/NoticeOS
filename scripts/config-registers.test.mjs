import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ASSET_PARAM,
  ASSET_ROSTER_REGISTER,
  CONFIG_REGISTERS,
  CONFIG_KNOBS,
  LANE_FALLBACK_LABEL,
  LANE_MAPPED_LABEL,
  LANE_MAPPING,
  LANE_MAPPING_TIMING_LABEL,
  laneMappingTiming,
  SETTABLE_FILES,
  assetIdFields,
  assetRosterFile,
  candidateRefusal,
  clusterSpellingRefusal,
  containerRegExp,
  duplicateKey,
  fieldOf,
  fieldRefusal,
  holderOf,
  laneStatuses,
  liveSearchLaneRefusal,
  matchRegister,
  fixedFieldLabel,
  readOnlyFieldRefusal,
  readOnlyRowRefusal,
  registerEntries,
  registerFiles,
  resolveContainer,
  rosterAssetIds,
  duplicateIssue,
  rowIssue,
  rowRefusal,
  rowValue,
  SITE_ROW_FIELDS,
} from './config-registers.mjs';
import { documentRefusal } from './config-documents.mjs';
import { installationPath } from './installation.mjs';

// The declaration is only true if it describes the files.
//
// `config-registers.mjs` is read by two things that cannot check each other: the
// changeset pipeline, which refuses a row the declaration does not allow, and
// the Tower, which builds a table out of the same fields. Neither notices when a
// register drifts from the file it claims to describe (a renamed key, a
// container pointer that resolves nowhere, an enum missing a value the file
// already holds). This is what notices.
//
// It reads the REAL config files, deliberately. A fixture would pass forever:
// the product's defaults in config/, and this installation's own copies when
// the checkout carries them.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readConfig(rel) {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
}

/** The product default and, when there is one, this installation's copy of a
 * document, each labelled with where it was read. */
function copiesOf(rel) {
  const copies = [{ where: rel, doc: readConfig(rel) }];
  const own = installationPath(rel, { root: REPO_ROOT });
  if (existsSync(own)) copies.push({ where: path.relative(REPO_ROOT, own), doc: JSON.parse(readFileSync(own, 'utf8')) });
  return copies;
}

/** Walk a pointer, `{asset}` standing for "any one key here". Returns every
 * container the register resolves to in the real file. */
function containersIn(doc, container) {
  const tokens = container === '' ? [] : container.slice(1).split('/');
  let found = [{ at: doc, params: {} }];
  for (const token of tokens) {
    const next = [];
    for (const { at, params } of found) {
      if (at === null || typeof at !== 'object') continue;
      if (token === ASSET_PARAM) {
        for (const [key, value] of Object.entries(at)) next.push({ at: value, params: { asset: key } });
      } else if (Object.prototype.hasOwnProperty.call(at, token)) {
        next.push({ at: at[token], params });
      }
    }
    found = next;
  }
  return found;
}

test('every register is well formed', () => {
  for (const [key, register] of registerEntries()) {
    assert.ok(typeof register.file === 'string' && register.file.startsWith('config/'), `${key}: file`);
    assert.ok(register.container === '' || register.container.startsWith('/'), `${key}: container`);
    assert.ok(['array', 'object'].includes(register.shape), `${key}: shape`);
    assert.ok(register.label && register.describe && register.owner && register.surface, `${key}: prose`);

    if (register.shape === 'object') {
      assert.equal(register.keyField, null, `${key}: an object register is keyed by its keys`);
      assert.ok(['asset-id', 'lane-id'].includes(register.keyRule), `${key}: keyRule`);
    } else {
      assert.ok(typeof register.keyField === 'string', `${key}: an array register names its key field`);
    }

    if (register.fields === null) continue;
    assert.ok(register.fields.length > 0, `${key}: a declared register has fields`);
    for (const field of register.fields) {
      assert.ok(field.name && field.label && field.describe, `${key}.${field.name}: prose`);
      assert.equal(typeof field.required, 'boolean', `${key}.${field.name}: required`);
      if (field.type === 'enum') {
        assert.ok(Array.isArray(field.values) && field.values.length > 0, `${key}.${field.name}: values`);
      }
      if (field.pattern !== undefined) new RegExp(field.pattern);
      if (field.defaultFrom !== undefined) {
        assert.ok(
          fieldOf(register, field.defaultFrom) !== null,
          `${key}.${field.name}: defaultFrom names a declared field`,
        );
        assert.notEqual(field.defaultFrom, field.name, `${key}.${field.name}: defaultFrom is another field`);
      }
      // A read-only field with no stated state is a control that vanished and
      // never said why. It states one ("Fixed once added", or its own
      // label-length state) and never a paragraph: the lock is the explanation,
      // and why a key is fixed is the declaration's comment.
      if (field.readOnly === true) {
        const state = fixedFieldLabel(field);
        assert.ok(typeof state === 'string' && state.length > 0, `${key}.${field.name}: readOnly states its state`);
        assert.ok(state.split(/\s+/).length <= 12, `${key}.${field.name}: the state is a label, not a rationale`);
        // Existing task documents retain repo metadata for guarded Undo, but
        // new logical rows do not require or execute it. Other immutable
        // fields remain required at creation.
        if (key === 'task-hub-spokes' && field.name === 'repo') {
          assert.equal(field.required, false);
        } else {
          assert.ok(field.required, `${key}.${field.name}: a field only settable at create is required`);
        }
      }
      if (field.readOnlyReason !== undefined) {
        assert.equal(field.readOnly, true, `${key}.${field.name}: a reason without the rule`);
      }
    }
    if (register.shape === 'array') {
      assert.ok(fieldOf(register, register.keyField) !== null, `${key}: keyField is a declared field`);
    }
    for (const name of register.unique ?? []) {
      assert.ok(fieldOf(register, name) !== null, `${key}: unique names the declared field ${name}`);
      assert.notEqual(name, register.keyField, `${key}: the keyField is unique already`);
    }
    if (register.scalarField !== undefined) {
      assert.ok(fieldOf(register, register.scalarField) !== null, `${key}: scalarField is a declared field`);
    }
  }
});

// A register naming a container that is not there is a UI that renders an empty
// table forever and a lane that refuses every write with a pointer error; and
// the declaration has to accept what is already committed, because a rule
// stricter than the file refuses the operator's own data back at them the first
// time they edit a row. Both are the whole-document check the Tower's build
// runs on the defaults it compiles in (`documentRefusal`).
test('every document a register names passes the whole-document check, shipped and saved', () => {
  const offenders = [];
  for (const file of registerFiles()) {
    for (const { where, doc } of copiesOf(file)) {
      const refusal = documentRefusal(file, doc);
      if (refusal !== null) offenders.push(`${where}: ${refusal}`);
    }
  }
  assert.deepEqual(offenders, [], `documents the declaration would refuse:\n  ${offenders.join('\n  ')}`);
});

// A `unique` column the committed file already repeats is a rule the Add form
// would enforce against the operator while the file itself breaks it: the
// worst of both, and the reason this reads the real files too.
test('no committed row repeats a value its register declares unique', () => {
  const offenders = [];
  for (const [key, register] of registerEntries()) {
    const names = [...new Set([register.keyField, ...(register.unique ?? [])])].filter(
      (name) => typeof name === 'string',
    );
    if (register.shape !== 'array' || names.length === 0) continue;
    for (const { at, params } of copiesOf(register.file).flatMap(({ doc }) => containersIn(doc, register.container))) {
      const seen = [];
      for (const row of at ?? []) {
        const clash = duplicateKey(register, seen, row);
        if (clash !== null) offenders.push(`${key}${params.asset ? ` (${params.asset})` : ''}: ${clash}`);
        seen.push(row);
      }
    }
  }
  assert.deepEqual(offenders, [], `committed rows that repeat a unique value:\n  ${offenders.join('\n  ')}`);
});

test('a pointer resolves to the register that owns it, and to its row and field', () => {
  const m = matchRegister('config/domain-costs.json', '/domains/3/paidUsd');
  assert.equal(m.key, 'domain-costs');
  assert.deepEqual(m.rest, ['3', 'paidUsd']);

  // A per-asset container hands back the asset it matched.
  const per = matchRegister('config/value-events.json', '/assets/meals.example/valueEvents/2');
  assert.equal(per.key, 'value-events');
  assert.deepEqual(per.params, { asset: 'meals.example' });
  assert.deepEqual(per.rest, ['2']);

  // The longer container wins where both could match — a pointer inside an
  // asset's LIST is the list's, never the holder's.
  assert.equal(
    matchRegister('config/value-events.json', '/assets/meals.example/valueEvents').key,
    'value-events',
  );
  // And the asset's own entry — which is what a first declaration has to create
  // before there is a list at all — is the holder's.
  const holder = matchRegister('config/value-events.json', '/assets/nosh.example');
  assert.equal(holder.key, 'value-events-assets');
  assert.deepEqual(holder.rest, ['nosh.example']);

  // One file, two containers.
  // `config/integrations.json` holds three registers, and the longest container
  // wins at every depth: the whole asset entry belongs to the holder, one lane
  // inside it to `asset-lane`, and the catalog to its own.
  assert.equal(matchRegister('config/integrations.json', '/assets/meals.example').key, 'asset-lane');
  const laneField = matchRegister('config/integrations.json', '/assets/meals.example/ga4/propertyId');
  assert.equal(laneField.key, 'asset-lane');
  assert.deepEqual(laneField.params, { asset: 'meals.example' });
  assert.deepEqual(laneField.rest, ['ga4', 'propertyId']);
  assert.equal(matchRegister('config/integrations.json', '/assets').key, 'asset-integrations');
  assert.equal(matchRegister('config/integrations.json', '/catalog/0/label').key, 'data-source-catalog');
  assert.equal(matchRegister('config/constants.json', '/flag_defaults/alpha'), null);
});

test('pattern refusals give a readable correction instead of regular-expression syntax', () => {
  const fields = [
    ...Object.values(CONFIG_REGISTERS).flatMap(register => register.fields ?? []),
    ...Object.values(CONFIG_KNOBS).map(knob => knob.field),
  ].filter(field => field.pattern !== undefined);
  assert.ok(fields.length > 0);
  for (const field of fields) {
    assert.equal(new RegExp(field.pattern).test('!'), false, field.label);
    const message = fieldRefusal(field, '!');
    assert.equal(typeof message, 'string', field.label);
    assert.ok(message.startsWith(field.label), message);
    assert.doesNotMatch(message, /[\^$\[\\]/, field.label);
    assert.ok(!message.includes(field.pattern), field.label);
  }
  assert.equal(
    fieldRefusal(fieldOf(CONFIG_REGISTERS['asset-lane'], 'propertyId'), 'G-123'),
    'GA4 property id: digits only, e.g. 313598867',
  );
});

test('resolveContainer fills the asset in, and refuses to guess one', () => {
  const register = CONFIG_REGISTERS['serp-panel-queries'];
  assert.equal(resolveContainer(register, { asset: 'nosh.example' }), '/assets/nosh.example/queries');
  assert.throws(() => resolveContainer(register, {}), /needs a site id/);
  assert.equal(resolveContainer(CONFIG_REGISTERS['domain-costs'], {}), '/domains');
  assert.ok(containerRegExp(register).test('/assets/nosh.example/queries/4'));
  assert.ok(!containerRegExp(register).test('/assets/nosh.example/other'));
});

test('a field refusal names the field by its label and the rule it broke', () => {
  const domain = CONFIG_REGISTERS['domain-costs'];
  assert.equal(fieldRefusal(fieldOf(domain, 'paidUsd'), 12.5), null);
  assert.match(fieldRefusal(fieldOf(domain, 'paidUsd'), 'twelve'), /^Paid \(USD\) must be a number$/);
  assert.match(fieldRefusal(fieldOf(domain, 'paidUsd'), -1), /^Paid \(USD\) must be at least 0$/);
  assert.match(fieldRefusal(fieldOf(domain, 'kind'), 'gift'), /^Order must be one of registration \| renewal \| transfer$/);
  assert.match(fieldRefusal(fieldOf(domain, 'paidOn'), '2026-02-30'), /^Paid on must be a date/);
  assert.match(fieldRefusal(fieldOf(domain, 'asset'), 'Not An Asset'), /^Site must be a site id$/);
  assert.equal(fieldRefusal(fieldOf(domain, 'domain'), 'https://x.test'), 'Domain: lowercase, a name not a URL: example.com');

  const costs = CONFIG_REGISTERS['recurring-costs'];
  assert.match(fieldRefusal(fieldOf(costs, 'from'), '2026-13'), /^From must be a month/);
  // An OPTIONAL field may be absent; that is what "the subscription is live" is.
  assert.equal(fieldRefusal(fieldOf(costs, 'to'), null), null);
  assert.match(fieldRefusal(fieldOf(costs, 'label'), ''), /^Label is required$/);

  const panels = CONFIG_REGISTERS['signal-panels'];
  assert.match(fieldRefusal(fieldOf(panels, 'enabled'), 'yes'), /^Daily refresh must be true or false$/);

  // Every declared field carries a label, so no refusal names a code key; a
  // declaration without one falls back to its key rather than to nothing.
  for (const register of Object.values(CONFIG_REGISTERS)) {
    for (const field of register.fields ?? []) assert.ok(field.label.trim(), `${register.key}.${field.name} has a label`);
  }
  assert.equal(fieldRefusal({ name: 'retries', label: '', type: 'integer', required: true }, 'x'), 'retries must be a number');
});

// A refusal knows its field: the Add form outlines the one input a refusal is
// about, so the row and duplicate checks say which field it is, or none when
// the refusal is the row's as a whole. The lane and the CLI read the same
// sentence through `rowRefusal` and `duplicateKey`.
test('a row refusal names the field it is about, or none for the whole row', () => {
  const costs = CONFIG_REGISTERS['recurring-costs'];
  const row = { id: 'chatgpt', label: 'ChatGPT Team', asset: 'plate.example', family: 'inference', amountUsdPerMonth: -5, from: '2026-09' };
  assert.deepEqual(rowIssue(costs, row), { field: 'amountUsdPerMonth', message: 'USD / month must be at least 0' });
  assert.equal(rowRefusal(costs, row), 'USD / month must be at least 0');
  assert.equal(rowIssue(costs, { ...row, amountUsdPerMonth: 20 }), null);
  assert.equal(rowIssue(costs, { ...row, typo: 1 }).field, null);
  assert.deepEqual(rowIssue(costs, 'not a row'), { field: null, message: 'value must be a JSON object (one row)' });

  const stored = [{ ...row, amountUsdPerMonth: 20 }];
  assert.deepEqual(duplicateIssue(costs, stored, { ...row, amountUsdPerMonth: 30 }), {
    field: 'id',
    message: 'Id "chatgpt" is already in this list',
  });
  assert.equal(duplicateKey(costs, stored, { ...row, amountUsdPerMonth: 30 }), 'Id "chatgpt" is already in this list');
  assert.equal(duplicateIssue(costs, stored, { ...row, id: 'claude' }), null);
});

// A site's row is refused in the same words: the ingest's site lanes word every
// refusal through `fieldRefusal` over `SITE_ROW_FIELDS`, so Add a site reads
// "Domain must be a hostname such as example.com" beside its Domain input,
// never a request key ("domain must …") and never "… a property id".
test('a site row refusal names the field by its label and says site', () => {
  const { id, displayName, domain, status, senseOnly } = SITE_ROW_FIELDS;
  assert.equal(fieldRefusal(domain, 'shop.example.com'), null);
  assert.equal(fieldRefusal(domain, undefined), null, 'a site with no domain is a service');
  assert.equal(fieldRefusal(domain, 'https://shop.example.com/x'), 'Domain must be a hostname such as example.com');
  assert.equal(fieldRefusal(domain, 'Shop.Example.com'), 'Domain must be a hostname such as example.com');
  assert.equal(fieldRefusal(id, 'shop.example.com'), null);
  assert.equal(fieldRefusal(id, 'home-os'), null, 'a short slug is a site id');
  assert.equal(fieldRefusal(id, 'NOT VALID'), 'Site must be a site id');
  // The store's spelling, not a configuration key's: an underscore is refused
  // here and accepted there, as each rule always did.
  assert.equal(fieldRefusal(id, 'shop_example'), 'Site must be a site id');
  assert.equal(fieldRefusal({ ...id, type: 'asset-id' }, 'shop_example'), null);
  assert.equal(fieldRefusal(id, 'x'.repeat(129)), 'Site must be 128 characters or fewer');
  assert.equal(fieldRefusal(id, undefined), 'Site is required');
  assert.equal(fieldRefusal(displayName, ''), 'Display name is required');
  assert.equal(fieldRefusal(displayName, 'x'.repeat(81)), 'Display name must be 80 characters or fewer');
  assert.match(fieldRefusal(status, 'shipping'), /^Lifecycle stage must be one of pre-launch \| onboarding/);
  assert.equal(fieldRefusal(senseOnly, 2), 'Automation must be at most 1');

  for (const [key, field] of Object.entries(SITE_ROW_FIELDS)) {
    assert.equal(field.name, key, `${key}: the key is the request body's`);
    assert.ok(field.label.trim() && field.describe.trim(), `${key}: prose`);
    for (const value of ['NOT VALID', '', -1, 'x'.repeat(300), { not: 'a value' }]) {
      const refusal = fieldRefusal(field, value);
      if (refusal === null) continue;
      assert.ok(refusal.startsWith(`${field.label} `), `${key}: ${refusal}`);
      assert.doesNotMatch(refusal, /\bproperty\b|\basset\b/i, `${key}: ${refusal}`);
    }
  }
});

// The three join keys. Each is set when its row is created and never after,
// because a rename here breaks something in a file this pipeline does not edit:
// the catalog id every asset entry and collector names, the recurring-cost id
// the ledger's idempotency key is built from, and the domain a registrar's
// export is reconciled against.
//
// A recurring cost's monthly AMOUNT is a join key too: every month already
// booked was booked at it and cost-import refuses a replay whose amount moved,
// so a price change is the row's To plus a new row, Stripe's rule for a price's
// amount.
test('a join key may be set when the row is created and not renamed afterwards', () => {
  const fixed = [
    ['data-source-catalog', 'id'],
    ['recurring-costs', 'id'],
    ['recurring-costs', 'amountUsdPerMonth'],
    ['domain-costs', 'domain'],
    ['entities', 'slug'],
  ];
  for (const [key, name] of fixed) {
    const field = fieldOf(CONFIG_REGISTERS[key], name);
    assert.equal(field.readOnly, true, `${key}.${name} is read-only`);
    assert.match(readOnlyFieldRefusal(field), /set when a row is created/);
    assert.equal(fixedFieldLabel(field), 'Fixed once added', `${key}.${name} states its lock`);
  }
  // Every other field is silent about it, so the flag stays a decision.
  assert.equal(readOnlyFieldRefusal(fieldOf(CONFIG_REGISTERS['domain-costs'], 'paidUsd')), null);

  // A whole ROW is set for two honest reasons (a scalar row, a cleared optional
  // field), and neither moves a read-only value. One that DOES is the rename by
  // another pointer.
  const costs = CONFIG_REGISTERS['recurring-costs'];
  const row = { id: 'claude-max', label: 'Claude Max', asset: 'root-os', family: 'inference', amountUsdPerMonth: 100, from: '2026-06' };
  assert.equal(readOnlyRowRefusal(costs, row, { ...row, label: 'Claude' }), null);
  assert.match(readOnlyRowRefusal(costs, row, { ...row, id: 'claude-max-2' }), /^id is set when a row is created/);
});

test('a scalar register takes the bare value as well as its one-field object', () => {
  const events = CONFIG_REGISTERS['value-events'];
  assert.equal(rowRefusal(events, 'calculation_complete'), null);
  assert.equal(rowRefusal(events, { event: 'sign_up' }), null);
  assert.match(rowRefusal(events, 'Calculation Complete'), /^GA4 event: verbatim as the site emits it/);
  assert.deepEqual(rowValue(events, 'sign_up'), { event: 'sign_up' });

  // A tracked query is a string OR an object carrying its cluster, in any mix.
  const queries = CONFIG_REGISTERS['serp-panel-queries'];
  assert.equal(rowRefusal(queries, 'big mac calories'), null);
  assert.equal(rowRefusal(queries, { query: 'big mac calories', label: 'Item head' }), null);
  assert.match(rowRefusal(queries, { query: 'x', cluster: 'y' }), /cluster is not a field here/);
});

// A per-asset list cannot be appended to until its asset has an entry, and in
// every one of these files most assets have none. The holder is what a surface
// files first — DERIVED from the pair of containers, so nothing has to be kept
// in step by hand.
test('a per-asset list finds the register that holds its asset entry', () => {
  for (const [listKey, holderKey, field] of [
    ['value-events', 'value-events-assets', 'valueEvents'],
    ['ga4-event-params', 'ga4-event-params-assets', 'eventParams'],
    ['serp-panel-queries', 'serp-panel-assets', 'queries'],
  ]) {
    const holder = holderOf(CONFIG_REGISTERS[listKey]);
    assert.equal(holder?.key, holderKey, `${listKey}: holder`);
    assert.equal(holder?.field, field, `${listKey}: field`);
    assert.equal(holder?.register.shape, 'object');
    // The holder is OPAQUE: an entry may be filed and removed whole, and the
    // list register alone decides what may be set inside it.
    assert.equal(holder?.register.fields, null);
    // What the surface files: the whole entry, wrapping one row.
    assert.equal(rowRefusal(holder.register, { [field]: ['x'] }), null);
    assert.match(rowRefusal(holder.register, 'x'), /must be a JSON object/);
  }

  // Registers that are not a per-asset list have nothing to file first.
  assert.equal(holderOf(CONFIG_REGISTERS['domain-costs']), null);
  assert.equal(holderOf(CONFIG_REGISTERS['value-events-assets']), null);
  assert.equal(holderOf(CONFIG_REGISTERS['asset-pull']), null);
});

// The Tower's `RegisterFile` union is the same list spelled for TypeScript. It
// cannot import this module's data, so this is what keeps the two in step.
test('every register file is in the Tower\'s RegisterFile union', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'apps/tower/shared/changeset.ts'), 'utf8');
  const union = source.slice(source.indexOf('export type RegisterFile'));
  const declared = union.slice(0, union.indexOf(';'));
  for (const file of registerFiles()) {
    assert.ok(
      declared.includes(`"${file}"`) || declared.includes('AssetRegisterFile'),
      `${file} is a register file but is not in RegisterFile`,
    );
  }
  for (const file of ['config/domain-costs.json', 'config/recurring-costs.json', 'config/beads.json']) {
    assert.ok(declared.includes(`"${file}"`), `${file} missing from RegisterFile`);
  }
});

// An `asset-id` field is a shape plus a candidate set.
//
// `fieldRefusal` can only judge the shape, because this module has no store and
// no filesystem, so a typo would book a recurring cost against an asset that
// does not exist. The candidates come from whoever knows: the browser passes
// the integration matrix's asset list, the apply pipeline passes the roster
// below. One function, one sentence, both ends.
test('a candidate set refuses an id nobody has, and an empty one refuses nothing', () => {
  const field = fieldOf(CONFIG_REGISTERS['recurring-costs'], 'asset');
  const known = ['root-os', 'meals.example', 'nosh.example'];

  assert.equal(candidateRefusal(field, known, 'nosh.example'), null);
  assert.equal(
    candidateRefusal(field, known, 'meals.fod'),
    'asset "meals.fod" is not one of root-os, meals.example, nosh.example',
  );

  // "Nobody answered" is not "nothing is allowed": a page whose source has not
  // loaded and a repo with no roster file both refuse nothing.
  assert.equal(candidateRefusal(field, [], 'meals.fod'), null);
  assert.equal(candidateRefusal(field, undefined, 'meals.fod'), null);
  // A blank field is `fieldRefusal`'s business, not this one's.
  assert.equal(candidateRefusal(field, known, ''), null);
  assert.equal(candidateRefusal(field, known, null), null);

  // Past five, the sentence names five and says there are more — a refusal an
  // operator reads, not a dump of the portfolio.
  const many = ['a', 'b', 'c', 'd', 'e', 'f'];
  assert.equal(candidateRefusal(field, many, 'g'), 'asset "g" is not one of a, b, c, d, e, …');
});

// A picker is not an allowlist.
//
// The same list means two different things depending on the field: an asset id
// the OS does not have is a typo, and a cluster label the panel does not use yet
// is a new bet. A picker that refused every new cluster would make the operator
// retype a label by eye, which is exactly what `clusterSpellingRefusal` exists
// to catch. The FIELD says which kind it is, once.
test('an open-domain field offers its list as a picker and refuses nothing', () => {
  const label = fieldOf(CONFIG_REGISTERS['serp-panel-queries'], 'label');
  const inUse = ['Item head', 'Chain calories'];
  assert.equal(label.candidates, 'suggest');
  assert.equal(candidateRefusal(label, inUse, 'Item head'), null);
  assert.equal(candidateRefusal(label, inUse, 'Breakfast head'), null, 'a new bet is a legitimate edit');

  // The closed domain beside it is unchanged: an asset either exists or is a typo.
  const asset = fieldOf(CONFIG_REGISTERS['recurring-costs'], 'asset');
  assert.equal(asset.candidates, undefined, 'closed is the default, and stays unstated');
  assert.match(candidateRefusal(asset, ['nosh.example'], 'nom.nwo'), /is not one of nosh\.example/);

  // Every declared field says one of the two things, or nothing at all.
  for (const [key, register] of registerEntries()) {
    for (const field of register.fields ?? []) {
      assert.ok(
        field.candidates === undefined || ['closed', 'suggest'].includes(field.candidates),
        `${key}.${field.name}: candidates`,
      );
    }
  }
});

// One cluster, one spelling.
//
// Grouping is an exact string match on the stored label, so "Item head" and
// "Item Head" are two bets in the readout and one in the operator's head, and
// the collector (`trackedLabel` in workers/ingest/src/dataforseo-dumps.ts)
// refuses the asset's whole panel for that run.
test('a cluster label that only differs in case or spacing is refused', () => {
  const queries = CONFIG_REGISTERS['serp-panel-queries'];
  assert.equal(queries.clusterField, 'label', 'the cluster key is declared');
  const label = fieldOf(queries, 'label');
  const rows = [
    'big mac calories',
    { query: 'whopper calories', label: 'Item head' },
    { query: 'mcchicken calories', label: 'Item head' },
  ];

  // Row 2 relabelled into a spelling variant.
  const refusal = clusterSpellingRefusal(queries, rows, '2', label, 'Item Head');
  assert.match(refusal, /spells one cluster two ways/);
  assert.match(refusal, /"Item head" and "Item Head"/);
  assert.match(refusal, /pick one, or the collector refuses the panel/);
  // Surrounding space is not a second spelling on either side: this rule trims
  // exactly as the collector does, so " Item head " simply IS "Item head" and
  // joins the cluster rather than being refused for a difference nobody stores.
  assert.equal(clusterSpellingRefusal(queries, rows, '2', label, ' Item head '), null);

  // Joining the cluster with its EXACT spelling is the point of the field.
  assert.equal(clusterSpellingRefusal(queries, rows, '0', label, 'Item head'), null);
  // A genuinely new cluster is a legitimate edit the collector has no opinion on.
  assert.equal(clusterSpellingRefusal(queries, rows, '2', label, 'Chain compare'), null);
  // A row's own spelling never clashes with itself, so recasing a cluster only
  // one row uses is allowed — the collector refuses two spellings COEXISTING.
  const alone = [{ query: 'whopper calories', label: 'Item head' }];
  assert.equal(clusterSpellingRefusal(queries, alone, '0', label, 'Item Head'), null);
  // …and the Add form, where every row belongs to somebody else, still clashes.
  assert.notEqual(clusterSpellingRefusal(queries, alone, null, label, 'Item Head'), null);

  // No other field, and no register without a declared cluster key, is judged.
  assert.equal(clusterSpellingRefusal(queries, rows, '2', fieldOf(queries, 'query'), 'Item Head'), null);
  assert.equal(
    clusterSpellingRefusal(CONFIG_REGISTERS['recurring-costs'], [], null, fieldOf(CONFIG_REGISTERS['recurring-costs'], 'label'), 'x'),
    null,
  );
  // A blank label is `fieldRefusal`'s business (the field is optional; omitting
  // it is how "no cluster" is said), not this rule's.
  assert.equal(clusterSpellingRefusal(queries, rows, null, label, '  '), null);
});

// Turning a roster row on is a claim about another file.
//
// config/signal-panels.README.md states it and its own validation snippet
// enforces it: an asset is enabled when at least one of its gsc / ga4 /
// bing-webmaster lanes is live in config/integrations.json. A click needs the
// rule itself, not a person reading the README beside the file.
test('a roster row may only be turned ON when a search lane is live', () => {
  const roster = CONFIG_REGISTERS['signal-panels'];
  assert.equal(roster.requiresLiveSearchLane, true, 'the rule is declared on the register');
  const enabled = fieldOf(roster, 'enabled');

  assert.equal(liveSearchLaneRefusal(enabled, { gsc: 'live' }, true), null);
  assert.equal(liveSearchLaneRefusal(enabled, { ga4: 'live', gsc: 'needs-setup' }, true), null);
  assert.equal(liveSearchLaneRefusal(enabled, { 'bing-webmaster': 'live' }, true), null);

  const refusal = liveSearchLaneRefusal(enabled, { gsc: 'needs-setup', ga4: 'skipped' }, true);
  assert.match(refusal, /enabled but no live search source in integrations\.json/);
  assert.match(refusal, /gsc, ga4, bing-webmaster/);

  // A lane that is live but is NOT a search lane proves nothing about a panel.
  assert.match(
    liveSearchLaneRefusal(enabled, { 'affiliate-amazon': 'live' }, true),
    /no live search source/,
  );

  // Turning a row OFF is always allowed — a decision the file is FOR.
  assert.equal(liveSearchLaneRefusal(enabled, { gsc: 'needs-setup' }, false), null);
  // And no other field is this rule's business.
  assert.equal(liveSearchLaneRefusal(fieldOf(roster, 'task'), {}, 'anything'), null);

  // "Nobody answered" refuses nothing, exactly as an empty candidate set does.
  assert.equal(liveSearchLaneRefusal(enabled, null, true), null);
  assert.equal(liveSearchLaneRefusal(enabled, undefined, true), null);
  assert.equal(liveSearchLaneRefusal(enabled, {}, true), null);
});

// The rule reads `status` — the value the FILE holds — so the shape it judges is
// derived from an integrations entry rather than restated anywhere.
test('an integrations entry flattens to the lane statuses the rule reads', () => {
  assert.deepEqual(
    laneStatuses({ gsc: { status: 'live', note: '' }, ga4: { status: 'needs-setup' } }),
    { gsc: 'live', ga4: 'needs-setup' },
  );
  // A lane with no status says nothing rather than reading as absent-and-fine.
  assert.deepEqual(laneStatuses({ gsc: { note: 'x' } }), {});
  assert.equal(laneStatuses(undefined), null);
  assert.equal(laneStatuses('live'), null);

  // Every roster row the installation turned ON satisfies the rule it is
  // enabled under — the README's validation snippet, run here on each copy.
  const enabled = fieldOf(CONFIG_REGISTERS['signal-panels'], 'enabled');
  const lanes = copiesOf('config/integrations.json');
  copiesOf('config/signal-panels.json').forEach(({ where, doc }, index) => {
    for (const [asset, row] of Object.entries(doc.assets ?? {})) {
      if (row.enabled !== true) continue;
      const entry = laneStatuses(lanes[Math.min(index, lanes.length - 1)].doc.assets?.[asset]);
      assert.equal(liveSearchLaneRefusal(enabled, entry, row.enabled), null, `${where}: ${asset}`);
    }
  });
});

// WHICH FILE ANSWERS "does this asset exist" is declared rather than written
// down in the pipeline: `config/integrations.json` `/assets` carries one entry
// per asset, and config/signal-panels.README.md makes that an invariant.
test('the asset roster is a declared register, and the real file fills it', () => {
  const roster = CONFIG_REGISTERS[ASSET_ROSTER_REGISTER];
  assert.equal(roster.shape, 'object');
  assert.equal(roster.keyRule, 'asset-id');
  assert.equal(assetRosterFile(), roster.file);

  // The product default names nobody; an installation's roster names its own
  // assets, and every id in it still satisfies the shape rule beside it.
  const [product, ...own] = copiesOf(assetRosterFile());
  assert.deepEqual(rosterAssetIds(product.doc), [], 'the product default names no asset');
  const shape = { name: 'asset', label: 'Asset', type: 'asset-id', required: true, describe: '' };
  for (const { doc } of own) {
    for (const id of rosterAssetIds(doc)) assert.equal(fieldRefusal(shape, id), null, id);
  }

  // A file that said nothing refuses nothing, rather than refusing everything.
  assert.deepEqual(rosterAssetIds({}), []);
  assert.deepEqual(rosterAssetIds({ assets: [] }), []);
  assert.deepEqual(rosterAssetIds(null), []);
});

// Which fields the check applies to is the declaration's answer too — the two
// money registers and the task-hub map name an asset; a tracked query does not.
test('the asset-id fields are exactly the ones declaring that type', () => {
  assert.deepEqual(assetIdFields(CONFIG_REGISTERS['recurring-costs']).map((f) => f.name), ['asset']);
  assert.deepEqual(assetIdFields(CONFIG_REGISTERS['domain-costs']).map((f) => f.name), ['asset']);
  assert.deepEqual(assetIdFields(CONFIG_REGISTERS['task-hub-spokes']).map((f) => f.name), ['asset']);
  assert.deepEqual(assetIdFields(CONFIG_REGISTERS['serp-panel-queries']), []);
  // An OPAQUE register has no fields at all, so it has none of these either.
  assert.deepEqual(assetIdFields(CONFIG_REGISTERS[ASSET_ROSTER_REGISTER]), []);
});

test('the settable four are still exactly four, and still exist', () => {
  assert.deepEqual([...SETTABLE_FILES].sort(), [
    'config/constants.json',
    'config/integrations.json',
    'config/pull.json',
    'config/tower.json',
  ]);
  for (const file of [...SETTABLE_FILES, ...registerFiles()]) readConfig(file);
});

/**
 * The two sentences a lane card can print.
 *
 * The collectors read the register where an asset states a value and their old
 * source where it does not, so every mapped lane owes BOTH lines — `reads` for
 * the first case, `fallback` for the second — over fields the `asset-lane`
 * declaration actually has. A lane missing one would leave the card silent about
 * a real consequence, which is the failure the sentences exist to prevent.
 */
test('every mapped lane states what reads it, and what reads it when nothing is mapped', () => {
  const lane = CONFIG_REGISTERS['asset-lane'];
  const declared = new Set(lane.fields.map((field) => field.name));
  const entries = Object.entries(LANE_MAPPING);
  assert.ok(entries.length > 0);
  for (const [id, spec] of entries) {
    assert.ok(spec.fields.length > 0, `${id} maps no field`);
    for (const field of spec.fields) {
      assert.ok(declared.has(field), `${id} maps ${field}, which asset-lane does not declare`);
    }
    // A state, not a sentence: the fallback is a code the card draws as a
    // chip, and every code has its chip.
    assert.ok(Object.hasOwn(LANE_FALLBACK_LABEL, spec.fallback), `${id} names no known fallback`);
    assert.equal('reads' in spec, false, `${id} still carries a sentence`);
  }
  for (const label of [...Object.values(LANE_FALLBACK_LABEL), ...Object.values(LANE_MAPPING_TIMING_LABEL), LANE_MAPPED_LABEL]) {
    assert.ok(label.split(/\s+/).length <= 6, `"${label}" is a chip, not a sentence`);
  }
  assert.equal(laneMappingTiming('store'), 'next-run');
  assert.equal(laneMappingTiming('file'), 'after-restart');
  assert.equal(laneMappingTiming(undefined), 'after-restart');
});

/**
 * PostHog's per-asset settings. Region and project are two
 * plain mapping fields; funnels are one structured list judged whole by the
 * portable contract's rule, so the store save, the Tower editor and the
 * collector refuse exactly the same values.
 */
test('PostHog maps a region and project, and judges a funnels list whole', () => {
  const lane = CONFIG_REGISTERS['asset-lane'];
  assert.deepEqual(LANE_MAPPING.posthog.fields, ['host', 'projectId']);
  assert.deepEqual(LANE_MAPPING.posthog.lists, ['funnels']);
  for (const name of LANE_MAPPING.posthog.lists) {
    assert.ok(fieldOf(lane, name), `${name} is a declared asset-lane field`);
  }
  const host = fieldOf(lane, 'host');
  const projectId = fieldOf(lane, 'projectId');
  const funnels = fieldOf(lane, 'funnels');
  assert.equal(fieldRefusal(host, 'us'), null);
  assert.match(fieldRefusal(host, 'apac'), /must be one of us \| eu/);
  assert.equal(fieldRefusal(projectId, '596607'), null);
  assert.match(fieldRefusal(projectId, 'p596607'), /digits only/);
  assert.equal(fieldRefusal(funnels, undefined), null);
  const calculator = {
    id: 'calculator',
    name: 'Calculator',
    steps: [{ event: '$pageview', path: '/calculator' }, { event: 'form_start' }, { event: 'calculation_complete' }],
  };
  assert.equal(fieldRefusal(funnels, [calculator]), null);
  assert.match(fieldRefusal(funnels, [{ ...calculator, steps: [{ event: 'form_start' }] }]), /needs 2 to 10 steps/);
  assert.match(fieldRefusal(funnels, 'calculator'), /must be a list of funnels/);
  // The row as a whole: an asset's PostHog cell with every field it may hold.
  assert.equal(
    rowRefusal(lane, { status: 'needs-setup', note: 'x', since: '2026-09-22', host: 'us', projectId: '596607', funnels: [calculator] }),
    null,
  );
});
