import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONFIG_PATH_RE,
  DEFAULT_ROUTES,
  DEFAULT_URL,
  SUBTITLE_MAX_CHARS,
  TOUCH_FLOOR,
  collectSurface,
  describe,
  heroVerdict,
  isConfigSurfaceRoute,
  isInsideAbout,
  isInsideClosedDisclosure,
  kpiOffenders,
  measureExpression,
  ownerChipOffenders,
  pendingSeries,
  paragraphOffenders,
  parseArgs,
  SITE_TOKEN,
  firstListedSite,
  siteRoutes,
  readEmpty,
  readSkeletal,
  routeVerdict,
  sentenceCount,
  summarize,
  touchTargetOffenders,
} from './surface-audit.mjs';

// THE FIXTURES ARE A DOM, not hand-written descriptors.
//
// `collectSurface` runs in Chrome and returns flat descriptor lists — tag,
// attributes, ancestry, text, box — and every rule in `surface-audit.mjs` is a
// pure function over those. So a test that hand-wrote descriptors would be
// testing a shape nobody produces. `dom()` takes the nested tree a fixture page
// actually has and flattens it exactly the way the page does, which means the
// ancestry the About rule and the owner-chip rule walk is the ancestry a real
// DOM would have handed them.

/** Flattens a nested fixture into the descriptor list the page returns. */
function dom(spec, ancestors = []) {
  const node = {
    tag: spec.tag,
    attrs: spec.attrs ?? {},
    text: spec.text ?? '',
    rect: spec.rect ?? { width: 200, height: 20 },
    display: spec.display ?? 'block',
    visible: spec.visible !== false,
    ancestors,
  };
  if (spec.hitRect) node.hitRect = spec.hitRect;
  if (spec.sparks) node.sparks = spec.sparks;
  if (spec.relatedSeries) node.relatedSeries = spec.relatedSeries;
  const flat = [node];
  const inner = [{ tag: node.tag, attrs: node.attrs, rect: node.rect }, ...ancestors];
  for (const child of spec.children ?? []) flat.push(...dom(child, inner));
  return flat;
}

/** Every node in the fixture whose tag is one of these — the page's own
 * per-kind selectors, applied to the fixture. */
const pick = (nodes, ...tags) => nodes.filter((node) => tags.includes(node.tag));
const withAttribute = (nodes, name) =>
  nodes.filter((node) => Object.hasOwn(node.attrs, name));

// ---------------------------------------------------------------------------
// sentenceCount — the one primitive the paragraph rule stands on
// ---------------------------------------------------------------------------

test('sentenceCount: a run with no terminator is one sentence, which is what a subtitle is', () => {
  assert.equal(sentenceCount('Reported 14h ago'), 1);
  assert.equal(sentenceCount('Net revenue by month'), 1);
  assert.equal(sentenceCount(''), 0);
});

test('sentenceCount: a full stop between two sentences counts, mid-token punctuation does not', () => {
  assert.equal(sentenceCount('One sentence.'), 1);
  assert.equal(sentenceCount('First sentence. Second one.'), 2);
  assert.equal(sentenceCount('Three. Of. Them.'), 3);
  assert.equal(sentenceCount('Does it? It does.'), 2);
});

test('sentenceCount: decimals and abbreviations are not sentence breaks', () => {
  assert.equal(sentenceCount('Averaging 1.5 days per import.'), 1);
  assert.equal(sentenceCount('Spend was $12.40 across 3.2k sessions'), 1);
  assert.equal(sentenceCount('Provisional days, e.g. today, are hollow.'), 1);
  assert.equal(sentenceCount('The 28d avg. is bold.'), 1);
});

test('sentenceCount: a stop followed by lowercase is punctuation inside one line', () => {
  // "…the store.d1 table" style copy: a period that does not start a sentence.
  assert.equal(sentenceCount('Read from config.local overrides'), 1);
});

// ---------------------------------------------------------------------------
// The paragraph rule — doc 21: no paragraph past one sentence outside About
// ---------------------------------------------------------------------------

test('paragraphOffenders: a two-sentence paragraph on the page is an offender, with its first 60 characters', () => {
  const nodes = dom({
    tag: 'section',
    children: [
      {
        tag: 'p',
        text: 'Impressions come from Search Console. They lag by two days and are never backfilled.',
      },
      { tag: 'p', text: 'Net revenue by month' },
    ],
  });
  const offenders = paragraphOffenders(pick(nodes, 'p'));
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].rule, 'prose');
  assert.equal(offenders[0].sentences, 2);
  assert.equal(offenders[0].text.length, 60);
  assert.equal(
    offenders[0].text,
    'Impressions come from Search Console. They lag by two days a',
  );
});

test('paragraphOffenders: the same prose inside [data-about] is where doc 21 puts it', () => {
  const nodes = dom({
    tag: 'div',
    attrs: { 'data-about': '' },
    children: [
      {
        tag: 'p',
        text: 'Impressions come from Search Console. They lag by two days.',
      },
    ],
  });
  assert.equal(isInsideAbout(pick(nodes, 'p')[0]), true);
  assert.deepEqual(paragraphOffenders(pick(nodes, 'p')), []);
});

test('paragraphOffenders: clipped screen-reader text is excluded, including its descendants', () => {
  const text = 'Line: trailing seven-day average. Values end on September 6.';
  const nodes = dom({
    tag: 'span',
    attrs: { class: 'sr-only' },
    rect: { width: 1, height: 1 },
    text,
    children: [{ tag: 'span', text }],
  });
  assert.deepEqual(paragraphOffenders(nodes), []);
  const restored = dom({ tag: 'span', attrs: { class: 'sr-only md:not-sr-only' }, text });
  assert.equal(paragraphOffenders(restored).length, 1, 'visibly restored text remains accountable');
  const visible = dom({ tag: 'span', rect: { width: 1, height: 1 }, text });
  assert.equal(paragraphOffenders(visible).length, 1, 'small text alone is not an exemption');
});

test('paragraphOffenders: details.about is accepted too, so a surface built before the attribute still measures', () => {
  const nodes = dom({
    tag: 'details',
    attrs: { class: 'about card' },
    children: [
      { tag: 'p', text: 'What these numbers are. Where they come from.' },
    ],
  });
  assert.deepEqual(paragraphOffenders(pick(nodes, 'p')), []);
});

test('paragraphOffenders: prose that is not visible by default is not on the page', () => {
  const nodes = dom({
    tag: 'section',
    children: [
      {
        tag: 'p',
        visible: false,
        text: 'A closed disclosure. Two sentences inside it.',
      },
    ],
  });
  assert.deepEqual(paragraphOffenders(pick(nodes, 'p')), []);
});

// ---------------------------------------------------------------------------
// isInsideClosedDisclosure — doc 21's disclosure principle, measured (ro-78qo.20)
//
// The descriptor says `visible: true` for all of these on purpose: that is what
// Chrome reports for a closed `<details>` now, which is the bug. The rule reads
// the ancestry instead.
// ---------------------------------------------------------------------------

test('isInsideClosedDisclosure: content inside a closed details is folded away, its summary is not', () => {
  const nodes = dom({
    tag: 'details',
    children: [
      { tag: 'summary', text: 'All findings · 8' },
      { tag: 'div', children: [{ tag: 'p', text: 'One. And two.' }] },
    ],
  });
  assert.equal(isInsideClosedDisclosure(pick(nodes, 'summary')[0]), false);
  assert.equal(isInsideClosedDisclosure(pick(nodes, 'p')[0]), true);
  assert.equal(isInsideClosedDisclosure(pick(nodes, 'details')[0]), false);
});

test('isInsideClosedDisclosure: an OPEN details is on the page, summary and content alike', () => {
  const nodes = dom({
    tag: 'details',
    attrs: { open: '' },
    children: [
      { tag: 'summary', text: 'About these numbers' },
      { tag: 'p', text: 'One. And two.' },
    ],
  });
  assert.equal(isInsideClosedDisclosure(pick(nodes, 'p')[0]), false);
});

test('isInsideClosedDisclosure: a summary is exempt only for ITS OWN details', () => {
  // An open disclosure inside a closed one — the shape a finding row makes
  // inside "All findings". Nothing in there is on the page, its summary least
  // of all, because the thing that would reveal it is shut.
  const nodes = dom({
    tag: 'details',
    children: [
      { tag: 'summary', text: 'All findings · 8' },
      {
        tag: 'details',
        attrs: { open: '' },
        children: [{ tag: 'summary', text: 'Evidence & limits' }],
      },
    ],
  });
  const summaries = pick(nodes, 'summary');
  assert.equal(isInsideClosedDisclosure(summaries[0]), false);
  assert.equal(isInsideClosedDisclosure(summaries[1]), true);
});

test('paragraphOffenders: prose inside a closed disclosure is not on the page, whatever its box says', () => {
  const nodes = dom({
    tag: 'details',
    children: [
      { tag: 'summary', text: 'All findings · 8' },
      { tag: 'p', text: 'One. And two.' },
    ],
  });
  assert.deepEqual(paragraphOffenders(pick(nodes, 'p')), []);
});

test('touchTargetOffenders: a closed disclosure hides its controls but not its own summary', () => {
  const small = { width: 20, height: 20 };
  const nodes = dom({
    tag: 'details',
    children: [
      { tag: 'summary', text: 'All findings', rect: small },
      { tag: 'button', text: 'Dismiss', rect: small },
    ],
  });
  const offenders = touchTargetOffenders(pick(nodes, 'summary', 'button'));
  assert.equal(offenders.length, 1);
  assert.match(offenders[0].text, /All findings/);
});

test('paragraphOffenders: [data-audit-ignore] opts a subtree out, ancestors included', () => {
  const nodes = dom({
    tag: 'div',
    attrs: { 'data-audit-ignore': '' },
    children: [
      { tag: 'div', children: [{ tag: 'p', text: 'One. And two.' }] },
    ],
  });
  assert.deepEqual(paragraphOffenders(pick(nodes, 'p')), []);
});

test('paragraphOffenders: --strict also flags a one-sentence subtitle that is really a paragraph', () => {
  const long = `A single sentence that keeps going well past the point at which it is still a subtitle and has become explanatory prose with a full stop on the end of it.`;
  assert.equal(sentenceCount(long), 1);
  assert.ok(long.length > SUBTITLE_MAX_CHARS);
  const nodes = dom({ tag: 'p', text: long });
  assert.deepEqual(paragraphOffenders(nodes), []);
  const strict = paragraphOffenders(nodes, { strict: true });
  assert.equal(strict.length, 1);
  assert.equal(strict[0].rule, 'long-subtitle');
  assert.equal(strict[0].chars, long.length);
});

// ---------------------------------------------------------------------------
// The owner-chip rule — doc 21: never on a view surface
// ---------------------------------------------------------------------------

test('ownerChipOffenders: the declared chip, today s OwnerChip title, and a bare config path all count', () => {
  const nodes = dom({
    tag: 'section',
    children: [
      { tag: 'span', attrs: { 'data-owner-chip': 'config/tower.json' }, text: 'config/tower.json' },
      {
        tag: 'button',
        attrs: {
          title: 'Owned by config/counters.json — click to copy. The Tower points here; it never edits it.',
        },
        text: 'config/counters.json',
      },
      { tag: 'span', text: 'Thresholds live in config/constants.json' },
      { tag: 'span', text: 'Active users' },
    ],
  });
  const offenders = ownerChipOffenders(
    nodes.filter((node) => node.tag !== 'section'),
    { route: '/assets/meals.example' },
  );
  assert.equal(offenders.length, 3);
  assert.deepEqual(
    offenders.map((offender) => offender.rule),
    ['owner-chip', 'owner-chip', 'config-path'],
  );
});

test('ownerChipOffenders: a chip and the path it draws inside itself are one offence', () => {
  // `OwnerChip` is a button whose title says "Owned by …" wrapping a span that
  // draws the path. Both signatures match; the operator has one chip to remove.
  const nodes = dom({
    tag: 'button',
    attrs: { title: 'Owned by config/serp-panel.json — click to copy.' },
    children: [{ tag: 'span', attrs: { class: 'truncate' }, text: 'config/serp-panel.json' }],
  });
  const offenders = ownerChipOffenders(nodes, { route: '/assets/meals.example/growth' });
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].rule, 'owner-chip');
});

test('ownerChipOffenders: Settings and an asset Sources tab are the two surfaces doc 21 exempts', () => {
  assert.equal(isConfigSurfaceRoute('/settings'), true);
  assert.equal(isConfigSurfaceRoute('/assets/meals.example/sources'), true);
  assert.equal(isConfigSurfaceRoute('/assets/meals.example/settings'), true);
  assert.equal(isConfigSurfaceRoute('/assets/meals.example/growth'), false);
  assert.equal(isConfigSurfaceRoute('/'), false);

  const nodes = dom({
    tag: 'span',
    attrs: { 'data-owner-chip': 'config/tower.json' },
    text: 'config/tower.json',
  });
  assert.deepEqual(ownerChipOffenders(nodes, { route: '/settings' }), []);
  assert.equal(ownerChipOffenders(nodes, { route: '/health' }).length, 1);
});

test('ownerChipOffenders: [data-config-surface] exempts a register embedded in a view route', () => {
  const nodes = dom({
    tag: 'section',
    attrs: { 'data-config-surface': '' },
    children: [
      { tag: 'span', attrs: { 'data-owner-chip': 'config/pull.json' }, text: 'config/pull.json' },
    ],
  });
  assert.deepEqual(
    ownerChipOffenders(withAttribute(nodes, 'data-owner-chip'), {
      route: '/integrations',
    }),
    [],
  );
});

test('CONFIG_PATH_RE: a config file in copy, not every slash and dot', () => {
  assert.ok(CONFIG_PATH_RE.test('config/tower.json'));
  assert.ok(CONFIG_PATH_RE.test('Edit config/serp-panel.json to change this'));
  assert.ok(CONFIG_PATH_RE.test('config/changesets/2026-09-05.json'));
  assert.equal(CONFIG_PATH_RE.test('meals.example/recipes'), false);
  assert.equal(CONFIG_PATH_RE.test('reconfigure/tower.json'), false);
});

// ---------------------------------------------------------------------------
// The KPI rule — doc 21: every number that can have a series shows one
// ---------------------------------------------------------------------------

test('kpiOffenders: a KPI with no series inside it is the offender', () => {
  const nodes = dom({
    tag: 'div',
    attrs: { 'data-kpi-strip': '' },
    children: [
      {
        tag: 'div',
        attrs: { 'data-kpi': 'active-users' },
        text: '2,652',
        sparks: [{ tag: 'svg', attrs: { 'data-spark': 'users' } }],
      },
      { tag: 'div', attrs: { 'data-kpi': 'open-alerts' }, text: '4', sparks: [] },
    ],
  });
  const offenders = kpiOffenders(withAttribute(nodes, 'data-kpi'));
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].rule, 'kpi-without-spark');
  assert.equal(offenders[0].text, 'open-alerts');
});

test('kpiOffenders: a bare svg or canvas inside the KPI counts as its series', () => {
  const withSvg = dom({
    tag: 'div',
    attrs: { 'data-kpi': 'sessions' },
    text: '3,468',
    sparks: [{ tag: 'svg', attrs: {} }],
  });
  const withDecoration = dom({
    tag: 'div',
    attrs: { 'data-kpi': 'sessions' },
    text: '3,468',
    sparks: [{ tag: 'div', attrs: { class: 'chevron' } }],
  });
  assert.deepEqual(kpiOffenders(withSvg), []);
  assert.equal(kpiOffenders(withDecoration).length, 1);
});

test('kpiOffenders: an explicitly related visible chart supports its summary figures', () => {
  const chart = dom({ tag: 'section', attrs: { 'data-hero-chart': '' } })[0];
  const summary = relatedSeries => dom({ tag: 'div', attrs: { 'data-kpi': 'Reported earnings' }, text: '$42', relatedSeries });
  assert.deepEqual(kpiOffenders(summary([chart])), []);
  assert.equal(kpiOffenders(summary([])).length, 1, 'a missing target never supplies a series');
  assert.equal(kpiOffenders(summary([{ ...chart, visible: false }])).length, 1);
  assert.equal(kpiOffenders(summary([{ ...chart, attrs: {} }])).length, 1, 'ordinary related text is not a chart');
  assert.equal(kpiOffenders(summary([{ ...chart, ancestors: [{ tag: 'details', attrs: {} }] }])).length, 1);
});

// THE "CAN" IN "every number that CAN have a series" (bead `ro-78qo.6`).
// Home's strip carries two numbers the store keeps no history of — the
// operator's inbox posture and tonight's open-alert count — and doc 21's own
// Home template draws each of them as a bar: how the total DIVIDES, since there
// is no way it moved. `[data-composition]` is that declaration, and `SegmentBar`
// (and `PriorityBar` through it) is what carries the mark.
test('kpiOffenders: a declared composition answers for a number with no history', () => {
  const nodes = dom({
    tag: 'div',
    attrs: { 'data-kpi-strip': '' },
    children: [
      {
        tag: 'div',
        attrs: { 'data-kpi': 'Open alerts' },
        text: '5',
        sparks: [{ tag: 'div', attrs: { 'data-composition': '', 'data-segment-bar': '' } }],
      },
      // The neighbour proves the mark is a declaration and not a blanket
      // amnesty: this one shows neither a series nor a composition.
      { tag: 'div', attrs: { 'data-kpi': 'Needs you' }, text: '25', sparks: [] },
    ],
  });
  const offenders = kpiOffenders(withAttribute(nodes, 'data-kpi'));
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].text, 'Needs you');
});

// THE THIRD ANSWER: "not yet". A payload with no history has no series to draw
// and no composition either — the Tasks board's six counts — and six identical
// grey placards say nothing. Such a KPI draws nothing and DECLARES the gap; the
// audit lists it rather than failing the route, so it stays visible until the
// payload grows one.
test('kpiOffenders: a declared "not yet" is not an offender, and is listed instead', () => {
  const nodes = withAttribute(
    dom({
      tag: 'div',
      attrs: { 'data-kpi-strip': '' },
      children: [
        {
          tag: 'div',
          attrs: {
            'data-kpi': 'Ready',
            'data-series': 'unavailable',
            'data-series-reason': 'the queue keeps 7 days of snapshots',
          },
          text: '18',
          sparks: [],
        },
        { tag: 'div', attrs: { 'data-kpi': 'Blocked' }, text: '4', sparks: [] },
      ],
    }),
    'data-kpi',
  );

  const offenders = kpiOffenders(nodes);
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].text, 'Blocked');

  const pending = pendingSeries(nodes);
  assert.deepEqual(pending, [
    { label: 'Ready', reason: 'the queue keeps 7 days of snapshots' },
  ]);
});

test('routeVerdict: a route full of declared gaps still meets doc 21', () => {
  const kpis = withAttribute(
    dom({
      tag: 'div',
      attrs: { 'data-surface-hero': '', 'data-kpi-strip': '' },
      children: [
        {
          tag: 'div',
          attrs: { 'data-kpi': 'Ready', 'data-series': 'unavailable' },
          sparks: [],
        },
      ],
    }),
    'data-kpi',
  );
  const verdict = routeVerdict({
    route: '/tasks',
    desk: {
      pageHeight: 1200,
      hero: { found: true, source: '[data-surface-hero]', bottom: 300 },
      kpis,
      paragraphs: [],
      owners: [],
    },
    phone: { pageHeight: 2400, controls: [] },
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.counts.kpis, 0);
  assert.equal(verdict.counts.pending, 1);
  // Informational, and never inside the offender list a failing route prints.
  assert.equal(verdict.offenders.length, 0);
});

test('kpiOffenders: a KPI that is not visible by default is not on the first screen', () => {
  const nodes = dom({
    tag: 'div',
    attrs: { 'data-kpi': 'net' },
    visible: false,
    sparks: [],
  });
  assert.deepEqual(kpiOffenders(nodes), []);
});

// ---------------------------------------------------------------------------
// The 44px rule — ro-md80's floor at 390
// ---------------------------------------------------------------------------

test('touchTargetOffenders: a control under the floor on either axis is named with its size', () => {
  const nodes = dom({
    tag: 'div',
    children: [
      { tag: 'button', text: 'Resolve', rect: { width: 88, height: 28 }, display: 'inline-flex' },
      { tag: 'button', text: 'Mark read', rect: { width: 96, height: 44 }, display: 'inline-flex' },
      { tag: 'button', text: 'Snooze', rect: { width: 32, height: 48 }, display: 'inline-flex' },
    ],
  });
  const offenders = touchTargetOffenders(pick(nodes, 'button'));
  assert.equal(offenders.length, 2);
  assert.deepEqual(
    offenders.map((offender) => offender.text),
    ['Resolve', 'Snooze'],
  );
  assert.equal(offenders[0].height, 28);
  assert.equal(offenders[1].width, 32);
});

test('touchTargetOffenders: 43.99px is 44px — sub-pixel layout is not a broken floor', () => {
  const nodes = dom({
    tag: 'button',
    text: 'Approve',
    rect: { width: 60, height: 43.99 },
    display: 'inline-flex',
  });
  assert.deepEqual(touchTargetOffenders(nodes), []);
  assert.equal(TOUCH_FLOOR, 44);
});

test('touchTargetOffenders: a link laid out inline is a word in a sentence, not a control', () => {
  const nodes = dom({
    tag: 'a',
    text: 'Sources',
    rect: { width: 46, height: 16 },
    display: 'inline',
  });
  assert.deepEqual(touchTargetOffenders(nodes), []);
});

test('touchTargetOffenders: a checkbox is measured through the label a thumb actually hits', () => {
  const nodes = dom({
    tag: 'input',
    attrs: { type: 'checkbox' },
    rect: { width: 16, height: 16 },
    hitRect: { width: 220, height: 48 },
    display: 'inline-block',
  });
  assert.deepEqual(touchTargetOffenders(nodes), []);
});

test('touchTargetOffenders: an invisible or zero-size control is not a target', () => {
  const hidden = dom({
    tag: 'button',
    text: 'Menu',
    visible: false,
    rect: { width: 24, height: 24 },
  });
  const collapsed = dom({
    tag: 'button',
    text: 'Menu',
    rect: { width: 0, height: 0 },
  });
  assert.deepEqual(touchTargetOffenders(hidden), []);
  assert.deepEqual(touchTargetOffenders(collapsed), []);
});

// ---------------------------------------------------------------------------
// The hero rule
// ---------------------------------------------------------------------------

test('heroVerdict: a declared hero that ends inside the first screen passes', () => {
  const verdict = heroVerdict(
    { found: true, source: '[data-surface-hero]', top: 120, bottom: 812 },
    { height: 900 },
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.bottom, 812);
});

test('heroVerdict: a hero past the fold names how far past', () => {
  const verdict = heroVerdict(
    { found: true, source: '[data-kpi-strip] + [data-hero-chart]', bottom: 1240 },
    { height: 900 },
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'hero-below-fold');
  assert.equal(verdict.over, 340);
});

test('heroVerdict: a surface that declares no hero cannot certify a first screen', () => {
  const verdict = heroVerdict({ found: false, source: 'none' }, { height: 900 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'no-hero');
});

// ---------------------------------------------------------------------------
// One route, and the run
// ---------------------------------------------------------------------------

test('routeVerdict: each rule reads the viewport it is written against', () => {
  const deskProse = dom({ tag: 'p', text: 'One thing. And another thing.' });
  const kpi = dom({ tag: 'div', attrs: { 'data-kpi': 'net' }, text: '$436', sparks: [] });
  const phoneButton = dom({
    tag: 'button',
    text: 'Resolve',
    rect: { width: 80, height: 30 },
    display: 'inline-flex',
  });
  const verdict = routeVerdict(
    {
      route: '/assets/meals.example/growth',
      desk: {
        pageHeight: 10139,
        hero: { found: true, source: '[data-surface-hero]', bottom: 820 },
        paragraphs: deskProse,
        owners: [],
        kpis: kpi,
        controls: [],
      },
      phone: {
        pageHeight: 21044,
        hero: { found: false },
        paragraphs: [],
        owners: [],
        kpis: [],
        controls: phoneButton,
      },
    },
    { strict: false },
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.heights.desk, 10139);
  assert.equal(verdict.heights.phone, 21044);
  assert.equal(verdict.counts.prose, 1);
  assert.equal(verdict.counts.kpis, 1);
  assert.equal(verdict.counts.touch, 1);
  // The hero fits at 900 and is only judged on the desk read, so a phone with no
  // hero attribute does not fail the route.
  assert.equal(verdict.hero.ok, true);
  assert.equal(verdict.counts.total, 3);
});

test('routeVerdict: a surface that meets doc 21 has no offenders at all', () => {
  const verdict = routeVerdict({
    route: '/',
    desk: {
      pageHeight: 1480,
      hero: { found: true, source: '[data-surface-hero]', bottom: 700 },
      paragraphs: dom({ tag: 'p', text: 'What needs you today' }),
      owners: [],
      kpis: dom({
        tag: 'div',
        attrs: { 'data-kpi': 'net' },
        sparks: [{ tag: 'svg', attrs: { 'data-spark': 'net' } }],
      }),
      controls: [],
    },
    phone: {
      pageHeight: 2600,
      hero: { found: true, source: '[data-surface-hero]', bottom: 700 },
      paragraphs: [],
      owners: [],
      kpis: [],
      controls: dom({
        tag: 'button',
        text: 'Approve',
        rect: { width: 120, height: 44 },
        display: 'inline-flex',
      }),
    },
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.counts.total, 0);
});

test('summarize: the run is green only when every route is', () => {
  const green = summarize([
    { ok: true, hero: { ok: true }, counts: { prose: 0, owners: 0, kpis: 0, touch: 0, total: 0 } },
  ]);
  assert.equal(green.ok, true);
  assert.equal(green.failing, 0);

  const red = summarize([
    { ok: true, hero: { ok: true }, counts: { prose: 0, owners: 0, kpis: 0, touch: 0, total: 0 } },
    {
      ok: false,
      hero: { ok: false },
      // `pending` rides along and is summed like the rest — but it is never a
      // reason a run is red, which is the assertion under it.
      counts: { prose: 2, owners: 1, kpis: 3, touch: 4, pending: 5, total: 11 },
    },
  ]);
  assert.equal(red.ok, false);
  assert.equal(red.routes, 2);
  assert.equal(red.failing, 1);
  assert.deepEqual(red.totals, {
    prose: 2,
    owners: 1,
    kpis: 3,
    touch: 4,
    hero: 1,
    pending: 5,
    total: 11,
  });
});

test('readEmpty: a reading with no controls and no text is a skeleton, not a surface', () => {
  // The live failure this exists for: /assets/meals.example measured 844px with
  // zero controls at 390 on one run while the identical route measured 6,417px
  // with eighteen. Recording that would have made the baseline a lie.
  assert.equal(readEmpty({ counts: { controls: 0, paragraphs: 0 } }), true);
  assert.equal(readEmpty({ counts: { controls: 13, paragraphs: 0 } }), false);
  assert.equal(readEmpty({ counts: { controls: 0, paragraphs: 6 } }), false);
  assert.equal(readEmpty(null), true);
});

test('readSkeletal: a page that has painted nothing past the fold is the shell, not the surface', () => {
  // The live failure this exists for (bead `ro-78qo.44`): /assets came back
  // 844px at 390×844 with `no-hero` and thirteen controls under the floor,
  // while the same Tower measured the same route at 2,588px with none. The
  // thirteen was the shell's own nav, and it matched this route's PRE-REBUILD
  // baseline exactly — which is how convincing a skeleton reading looks.
  const shell = {
    counts: { controls: 13, paragraphs: 2 },
    viewport: { width: 390, height: 844 },
    pageHeight: 844,
  };
  assert.equal(readSkeletal(shell), true);

  // A real surface: the same shell plus its own content, which is any page at
  // all past the fold.
  assert.equal(
    readSkeletal({ ...shell, pageHeight: 2588 }),
    false,
    'a page taller than the viewport is a surface',
  );

  // EXACT, not a threshold. A surface that genuinely ends a pixel short of the
  // fold is a surface, and discarding it would trade a false failure for a
  // hang — the audit would retake it forever and report it unmeasurable.
  assert.equal(readSkeletal({ ...shell, pageHeight: 843 }), false);
  assert.equal(readSkeletal({ ...shell, pageHeight: 845 }), false);

  // It still catches everything `readEmpty` did.
  assert.equal(readSkeletal({ counts: { controls: 0, paragraphs: 0 } }), true);
  assert.equal(readSkeletal(null), true);

  // A reading with no viewport to compare against is not condemned on a guess.
  assert.equal(
    readSkeletal({ counts: { controls: 13, paragraphs: 2 }, pageHeight: 844 }),
    false,
  );
});

test('describe: an offender is named by what a reader can find it with', () => {
  assert.equal(describe({ tag: 'p', attrs: { id: 'intro' } }), 'p#intro');
  assert.equal(
    describe({ tag: 'div', attrs: { class: 'card muted extra' } }),
    'div.card.muted',
  );
  assert.equal(
    describe({ tag: 'div', attrs: { 'data-kpi': 'net' } }),
    'div[data-kpi=net]',
  );
  assert.equal(describe(null), '—');
});

// ---------------------------------------------------------------------------
// Arguments and the injected page function
// ---------------------------------------------------------------------------

test('parseArgs: the eleven desk routes at the local Tower by default', () => {
  const options = parseArgs([]);
  assert.equal(options.url, DEFAULT_URL);
  assert.deepEqual(options.routes, DEFAULT_ROUTES);
  assert.equal(options.strict, false);
  assert.equal(options.json, false);
  assert.equal(options.asset, null);
  assert.equal(options.chrome, null);
  assert.equal(parseArgs(['--chrome', '/explicit/testing-browser']).chrome, '/explicit/testing-browser');
  assert.ok(DEFAULT_ROUTES.includes(`/assets/${SITE_TOKEN}/growth`));
});

// Bead ro-ujb9.120: the site pages are measured on a site this Tower lists, or
// the one `--asset` names — never a site written into the script.
test('the site pages are filled with --asset, or with the first site the Sites page lists', () => {
  assert.equal(parseArgs(['--asset', 'shop.example']).asset, 'shop.example');
  assert.deepEqual(siteRoutes(DEFAULT_ROUTES, 'shop.example').slice(0, 5), [
    '/',
    '/assets',
    '/assets/shop.example',
    '/assets/shop.example/growth',
    '/assets/shop.example/search',
  ]);
  assert.ok(siteRoutes(DEFAULT_ROUTES, 'shop.example').every((route) => !route.includes(SITE_TOKEN)));
  // An installation with no site yet: the site pages are left out, the rest kept.
  const bare = siteRoutes(DEFAULT_ROUTES, null);
  assert.equal(bare.length, DEFAULT_ROUTES.length - 3);
  assert.ok(bare.includes('/settings'));
  assert.ok(bare.every((route) => !route.includes(SITE_TOKEN)));
  // The first link that IS a site page: never the index, a tab or another page.
  assert.equal(
    firstListedSite(['/assets', '/alerts', '/assets/shop.example/growth', '/assets/shop.example', '/assets/b.example']),
    'shop.example',
  );
  assert.equal(firstListedSite(['/assets', '/settings']), null);
  assert.equal(firstListedSite(undefined), null);
});

test('parseArgs: --routes is comma-separated and repeatable, and a bare name gets its slash', () => {
  assert.deepEqual(parseArgs(['--routes', '/health,/tasks']).routes, [
    '/health',
    '/tasks',
  ]);
  assert.deepEqual(
    parseArgs(['--routes', '/health', '--routes', 'financials']).routes,
    ['/health', '/financials'],
  );
});

test('parseArgs: a trailing slash on the origin never doubles up in a route url', () => {
  assert.equal(parseArgs(['--url', 'http://127.0.0.1:5173/']).url, 'http://127.0.0.1:5173');
});

test('parseArgs: a flag that needs a value says so rather than reading the next flag', () => {
  assert.throws(() => parseArgs(['--url', '--json']), /--url requires a value/);
  assert.throws(() => parseArgs(['--routes']), /--routes requires a value/);
  assert.throws(() => parseArgs(['--ready-ms', '0']), /--ready-ms must be a positive number/);
});

test('measureExpression: the injected function is self-contained', () => {
  // It reaches Chrome through Function.prototype.toString, so a reference to
  // anything at module scope would be a ReferenceError in the page and the
  // audit would exit 2 with a stack instead of a table. Nothing in this repo
  // typechecks that; this does.
  const source = collectSurface.toString();
  for (const name of [
    'SKIP_PROSE_TAGS',
    'TOLERANCE',
    'DESK_VIEWPORT',
    'PHONE_VIEWPORT',
    'CONFIG_PATH_RE',
    'collapse(',
    'describe(',
    'require(',
  ]) {
    assert.equal(
      source.includes(name),
      false,
      `collectSurface must not reference ${name} — it runs in the page, not in node`,
    );
  }
  const expression = measureExpression({ skipProseTags: ['script'] });
  assert.ok(expression.startsWith('(function'));
  assert.ok(expression.includes('{"skipProseTags":["script"]}'));
});
