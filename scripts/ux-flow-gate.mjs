#!/usr/bin/env node
// A FLOW THAT GROWS A STEP IS A FLOW TO REDESIGN (operator, 2026-09-23; bead
// `ro-ujb9.95`).
//
// "I've seen instances of way too many steps where it's more natural just to
// add one more button or component to the current step than blowing the
// entire flow up with extra steps, duplicated checks, etc."; "No duplicate
// statuses on the same screen"; a list that repeats one subject with a
// different property per row is grouped under that subject; and "codify/gatify
// this so any agent who does work on UX in the future encounters a hard stop …
// instead of counting on agents to read docs".
//
// The text gate (`scripts/ux-gate.mjs`, bead ro-ujb9.94) reads source files and
// cannot see a flow. This is the flow gate's judge: the browser half
// (`apps/tower/e2e/flow-gate.mjs`) walks every flow declared in
// `apps/tower/e2e/ux-flows.mjs` at desktop and phone and hands its ux-walk/1
// results here. It holds each flow, per viewport, to `apps/tower/ux-flows.json`:
//
//   steps only go down   actions, screens, page changes and words on screen
//   no empty step        a screen left having entered or decided nothing
//   check once           the same verification or confirmation twice in a flow
//   one status           the same status for the same subject twice on a screen
//   group by subject     a list whose items repeat one subject
//
// The four rule counts recorded when the gate landed are LEGACY DEBT, removed
// to zero by epic ro-ujb9.96.7 — never an allowance. A NEW flow enters with
// none, and must cite researched prior art.
//
// THE RATCHET is the text gate's, reused: `pnpm ux:flows:baseline` lowers the
// record and never raises it; a raise is the operator's hand edit carrying
// "kind" (trust-safety, legal, destructive-confirmation), "approvedBy" (a bead
// id), "reason" and "priorArt" (a docs/briefs section citing at least three
// comparable products); the record's git history is audited so a raise cannot
// slip in unapproved; a budgeted flow is never dropped without a "retired"
// record. EVERY design failure ends with the same fixed instructions as the
// text gate's (`FLOW_NEXT_STEPS`).
//
// Usage (no browser — the static half; the walk is apps/tower/e2e/flow-gate.mjs):
//   node scripts/ux-flow-gate.mjs            the record's schema and history, the
//                                            registry against it, every prior-art citation
//   node scripts/ux-flow-gate.mjs --staged   the staged record (the pre-commit hook)
//   add --json for machine-readable output, --root <dir> for another checkout

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  EXCEPTION_KINDS,
  EXCEPTION_KIND_RULE,
  beadPrefixes,
  countWords,
  gitShow,
  invokedDirectly,
  isBeadId,
  priorArtProblems,
  researchAndExceptionSteps,
} from './ux-gate.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const FLOW_GATE_BEAD = 'ro-ujb9.95';
/** The epic whose beads remove the legacy rule counts to zero. */
export const LEGACY_DEBT_EPIC = 'ro-ujb9.96.7';

/**
 * The legacy-debt clause of a passing summary: the counts while any is left,
 * and that none is once they are all zero (bead ro-ujb9.96.7.28 removed the
 * last two empty steps) — a line of zeros "still held" reads as debt that is
 * not there.
 */
export function legacyDebtLine(legacy, held = 'held') {
  if (Object.values(legacy).every((value) => value === 0)) return `No legacy debt left for epic ${LEGACY_DEBT_EPIC}.`;
  return `Legacy debt ${held} for epic ${LEGACY_DEBT_EPIC}: ${Object.entries(legacy).map(([metric, value]) => `${metric} ${value}`).join(', ')}.`;
}
export const FLOW_BUDGET_FILE = 'apps/tower/ux-flows.json';
export const REGISTRY_FILE = 'apps/tower/e2e/ux-flows.mjs';
export const RUNNER_FILE = 'apps/tower/e2e/flow-gate.mjs';
export const VIEWPORT_NAMES = Object.freeze(['desktop', 'phone']);

/**
 * What the gate counts, per flow per viewport. `rule` is the operator's rule
 * the count enforces (docs/21 principle 3b); `zeroForNew` rules carry no
 * legacy allowance for a flow added after the gate landed.
 */
export const METRICS = Object.freeze({
  actions: { rule: 'steps only go down', what: 'actions (clicks, fields, selects)', zeroForNew: false },
  screens: { rule: 'steps only go down', what: 'screens', zeroForNew: false },
  pageChanges: { rule: 'steps only go down', what: 'page changes', zeroForNew: false },
  words: { rule: 'zero words needed to act', what: 'words of explanation on screen', zeroForNew: false },
  emptySteps: { rule: 'no empty step', what: 'empty steps', zeroForNew: true },
  duplicatedChecks: { rule: 'check once', what: 'duplicated checks', zeroForNew: true },
  duplicateStatuses: { rule: 'one status per subject per screen', what: 'duplicate statuses', zeroForNew: true },
  ungroupedRepeats: { rule: 'group lists by subject', what: 'ungrouped repeated subjects', zeroForNew: true },
});
export const FLOW_METRICS = Object.freeze(Object.keys(METRICS));
/** The survey opens every main screen by URL: only the per-screen rules apply. */
export const SURVEY_METRICS = Object.freeze(['duplicateStatuses', 'ungroupedRepeats']);
export const RULE_METRICS = Object.freeze(FLOW_METRICS.filter((metric) => METRICS[metric].zeroForNew));

export const APPROVAL_KEYS = Object.freeze(['approvedBy', 'kind', 'reason', 'priorArt']);

export const metricsFor = (kind) => (kind === 'survey' ? SURVEY_METRICS : FLOW_METRICS);

/** A ux-walk/1 run's counts, as the gate names them. */
export function measureRun(run, kind = 'flow') {
  const all = {
    actions: run.actions ?? 0,
    screens: run.screens ?? 0,
    pageChanges: run.hops ?? 0,
    words: run.proseWords ?? 0,
    emptySteps: run.emptySteps ?? 0,
    duplicatedChecks: run.duplicatedChecks ?? 0,
    duplicateStatuses: run.duplicateStatuses ?? 0,
    ungroupedRepeats: run.ungroupedRepeats ?? 0,
  };
  return Object.fromEntries(metricsFor(kind).map((metric) => [metric, all[metric]]));
}

const kindOf = (registry, flow) => registry?.[flow]?.kind ?? 'flow';

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

export const BUDGET_ABOUT =
  `One-way ratchet for the flow gate (${RUNNER_FILE}, bead ${FLOW_GATE_BEAD}): what each operator flow in ` +
  `${REGISTRY_FILE} cost at desktop and phone. Actions, screens, page changes and words only go down. The empty ` +
  'steps, duplicated checks, duplicate statuses and ungrouped repeats recorded here are LEGACY DEBT, not an ' +
  `allowance: epic ${LEGACY_DEBT_EPIC} removes each to zero, and a new flow enters with none. pnpm ` +
  'ux:flows:baseline lowers entries when a flow gets cheaper and never raises them. A raise is an operator-only ' +
  'exception for a trust-safety, legal or destructive-confirmation step: the operator adds kind, approvedBy (a ' +
  'bead id), reason and priorArt (a docs/briefs section citing three researched comparables) to that viewport\'s ' +
  'entry. A flow is retired only by the operator, under "retired" with approvedBy and reason. Agents never edit ' +
  'this file; see scripts/README.md, UX flow gate.';

export function readBudget(root = REPO_ROOT) {
  const file = path.join(root, FLOW_BUDGET_FILE);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

const parseBudget = (text) => (text == null ? null : JSON.parse(text));

/** The JSON the record holds: flows sorted, viewports and metrics in their
 * fixed order, so a diff shows only change. */
export function serializeBudget(budget) {
  const flows = {};
  for (const flow of Object.keys(budget.flows ?? {}).sort()) {
    flows[flow] = {};
    for (const viewport of VIEWPORT_NAMES) {
      const entry = budget.flows[flow]?.[viewport];
      if (!entry) continue;
      const out = {};
      for (const metric of FLOW_METRICS) if (entry[metric] !== undefined) out[metric] = entry[metric];
      for (const key of APPROVAL_KEYS) if (entry[key] !== undefined) out[key] = entry[key];
      flows[flow][viewport] = out;
    }
  }
  const retired = {};
  for (const flow of Object.keys(budget.retired ?? {}).sort()) retired[flow] = budget.retired[flow];
  const out = { about: budget.about ?? BUDGET_ABOUT, legacyDebtEpic: budget.legacyDebtEpic ?? LEGACY_DEBT_EPIC, flows };
  if (Object.keys(retired).length) out.retired = retired;
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** The record the gate lands with: every flow as measured, legacy counts included. */
export function initialBudget(results, registry) {
  const flows = {};
  for (const [flow, entry] of Object.entries(results.flows ?? {})) {
    for (const [viewport, run] of Object.entries(entry.runs ?? {})) {
      if (!run.ok) throw new Error(`${flow} · ${viewport} did not finish its walk; the record starts from complete walks only`);
      flows[flow] ??= {};
      flows[flow][viewport] = measureRun(run, kindOf(registry, flow));
    }
  }
  return { about: BUDGET_ABOUT, legacyDebtEpic: LEGACY_DEBT_EPIC, flows };
}

const workingTreeReader = (root) => (rel) => {
  try {
    return readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return null;
  }
};

/** Problems with one entry's exception: all four keys, each valid. */
export function approvalProblems(entry, { prefixes = null, readFile }) {
  const problems = [];
  if (!EXCEPTION_KINDS.includes(entry.kind)) problems.push(`${EXCEPTION_KIND_RULE} (got ${JSON.stringify(entry.kind)})`);
  if (!isBeadId(entry.approvedBy, prefixes)) {
    problems.push(`approvedBy must be the operator-approved bead id, e.g. "ro-abcd.1" (got ${JSON.stringify(entry.approvedBy)})`);
  }
  if (typeof entry.reason !== 'string' || countWords(entry.reason) < 3) {
    problems.push('reason must say, in at least three words, why no redesign removes the step');
  }
  problems.push(...priorArtProblems(entry.priorArt, readFile));
  return problems;
}

/** Schema errors in the record (an empty list when it is well-formed). */
export function validateBudget(budget, { prefixes = null, root = REPO_ROOT, readFile = workingTreeReader(root) } = {}) {
  const errors = [];
  if (!budget || typeof budget !== 'object' || !budget.flows || typeof budget.flows !== 'object') {
    return [`${FLOW_BUDGET_FILE} must be an object with a "flows" map`];
  }
  for (const key of Object.keys(budget)) {
    if (!['about', 'legacyDebtEpic', 'flows', 'retired'].includes(key)) errors.push(`${FLOW_BUDGET_FILE}: unknown key "${key}"`);
  }
  if (!isBeadId(budget.legacyDebtEpic)) {
    errors.push(`${FLOW_BUDGET_FILE}: legacyDebtEpic must name the epic that removes the legacy counts (${LEGACY_DEBT_EPIC})`);
  }
  for (const [flow, viewports] of Object.entries(budget.flows)) {
    const where = `${FLOW_BUDGET_FILE} → ${flow}`;
    if (!viewports || typeof viewports !== 'object' || !Object.keys(viewports).length) {
      errors.push(`${where}: must hold at least one of ${VIEWPORT_NAMES.join(', ')}`);
      continue;
    }
    for (const [viewport, entry] of Object.entries(viewports)) {
      const at = `${where} · ${viewport}`;
      if (!VIEWPORT_NAMES.includes(viewport)) {
        errors.push(`${where}: unknown viewport "${viewport}" (expected ${VIEWPORT_NAMES.join(' or ')})`);
        continue;
      }
      if (!entry || typeof entry !== 'object') {
        errors.push(`${at}: must be an object`);
        continue;
      }
      for (const key of Object.keys(entry)) {
        if (!FLOW_METRICS.includes(key) && !APPROVAL_KEYS.includes(key)) errors.push(`${at}: unknown key "${key}"`);
      }
      const present = FLOW_METRICS.filter((metric) => entry[metric] !== undefined);
      const shape = [FLOW_METRICS, SURVEY_METRICS].find((set) => set.length === present.length && set.every((metric) => present.includes(metric)));
      if (!shape) {
        errors.push(`${at}: must record every one of ${FLOW_METRICS.join(', ')} (a flow) or of ${SURVEY_METRICS.join(', ')} (the survey)`);
      }
      for (const metric of present) {
        if (!Number.isInteger(entry[metric]) || entry[metric] < 0) errors.push(`${at}: ${metric} must be a whole number ≥ 0`);
      }
      if (APPROVAL_KEYS.some((key) => entry[key] !== undefined)) {
        for (const problem of approvalProblems(entry, { prefixes, readFile })) errors.push(`${at}: ${problem}`);
      }
    }
  }
  for (const [flow, record] of Object.entries(budget.retired ?? {})) {
    const where = `${FLOW_BUDGET_FILE} → retired → ${flow}`;
    if (budget.flows[flow]) errors.push(`${where}: a retired flow cannot also hold a budget`);
    errors.push(...retiredProblems(record, prefixes).map((problem) => `${where}: ${problem}`));
  }
  return errors;
}

function retiredProblems(record, prefixes) {
  const problems = [];
  if (!record || typeof record !== 'object') return ['must be an object with approvedBy and reason'];
  for (const key of Object.keys(record)) if (!['approvedBy', 'reason'].includes(key)) problems.push(`unknown key "${key}"`);
  if (!isBeadId(record.approvedBy, prefixes)) problems.push(`approvedBy must be the operator-approved bead id (got ${JSON.stringify(record.approvedBy)})`);
  if (typeof record.reason !== 'string' || countWords(record.reason) < 3) problems.push('reason must say, in at least three words, why the product no longer has this flow');
  return problems;
}

/**
 * What changed in `next` that the ratchet refuses: a raised count without a
 * FRESH, valid exception; a flow or viewport added carrying a legacy rule
 * count; a budgeted flow dropped without a "retired" record.
 */
export function budgetRaises(previous, next, { prefixes = null, root = REPO_ROOT, readFile = workingTreeReader(root) } = {}) {
  const violations = [];
  for (const [flow, viewports] of Object.entries(next?.flows ?? {})) {
    for (const [viewport, entry] of Object.entries(viewports ?? {})) {
      const before = previous?.flows?.[flow]?.[viewport];
      if (!before) {
        const legacy = RULE_METRICS.filter((metric) => (entry?.[metric] ?? 0) > 0);
        if (legacy.length) {
          violations.push(
            `${flow} · ${viewport} enters the record with legacy allowance (${legacy.map((metric) => `${metric} ${entry[metric]}`).join(', ')}); ` +
              'a new flow meets every rule at zero',
          );
        }
        continue;
      }
      const raised = FLOW_METRICS.filter((metric) => entry?.[metric] !== undefined && entry[metric] > (before[metric] ?? 0));
      if (!raised.length) continue;
      const change = `${flow} · ${viewport}: ${raised.map((metric) => `${metric} ${before[metric] ?? 0} → ${entry[metric]}`).join(', ')}`;
      const problems = approvalProblems(entry, { prefixes, readFile });
      if (problems.length) violations.push(`${change} is a raise without a valid exception: ${problems.join('; ')}`);
      else if (entry.approvedBy === before.approvedBy && entry.reason === before.reason) {
        violations.push(`${change} reuses the approval of an earlier raise (${entry.approvedBy}); each raise needs its own`);
      }
    }
  }
  for (const flow of Object.keys(previous?.flows ?? {})) {
    if (next?.flows?.[flow]) continue;
    const retired = next?.retired?.[flow];
    const problems = retired ? retiredProblems(retired, prefixes) : ['no "retired" record'];
    if (problems.length) {
      violations.push(
        `${flow} was dropped from the record (${problems.join('; ')}); a budgeted flow is never dropped to get past the gate — ` +
          'only the operator retires one, under "retired" with "approvedBy" and "reason"',
      );
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}

/**
 * Audit every commit that changed the record, the way the text gate audits
 * its own: each change is judged by `budgetRaises` with prior art resolved IN
 * THAT COMMIT'S TREE. The commit that introduced the record is exempt; a later
 * one that re-creates it after a deletion is not.
 */
export function auditBudgetHistory(root = REPO_ROOT, { prefixes = beadPrefixes(root) } = {}) {
  const inside = git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return { skipped: 'not a git work tree', violations: [] };
  const log = git(root, ['log', '--format=%H', '--', FLOW_BUDGET_FILE]);
  if (log.status !== 0) return { skipped: log.stderr.trim(), violations: [] };
  const commits = log.stdout.split('\n').filter(Boolean);
  const shallow = git(root, ['rev-parse', '--is-shallow-repository']).stdout.trim() === 'true';
  const violations = [];
  commits.forEach((commit, index) => {
    const next = parseBudget(gitShow(root, `${commit}:${FLOW_BUDGET_FILE}`));
    if (!next) return; // a deletion: the gate then fails closed on the missing record
    const hasParent = git(root, ['rev-parse', '--verify', '--quiet', `${commit}^`]).status === 0;
    if (!hasParent && shallow) return;
    const previous = hasParent ? parseBudget(gitShow(root, `${commit}^:${FLOW_BUDGET_FILE}`)) : null;
    const introduction = index === commits.length - 1;
    if (!previous && !introduction) {
      violations.push(`${commit.slice(0, 8)} re-creates ${FLOW_BUDGET_FILE} after it was deleted`);
      return;
    }
    if (!previous) return;
    const readFile = (rel) => gitShow(root, `${commit}:${rel}`);
    for (const violation of budgetRaises(previous, next, { prefixes, readFile })) violations.push(`${commit.slice(0, 8)} ${violation}`);
  });
  return { violations, commits: commits.length, shallow };
}

// ---------------------------------------------------------------------------
// Judging a walk
// ---------------------------------------------------------------------------

const truncate = (text, max = 110) => (String(text).length > max ? `${String(text).slice(0, max - 1)}…` : String(text));

/** Where the steps went: each screen in order with the actions taken on it. */
function stepsByScreen(run) {
  const lines = [];
  let screen = null;
  let line = null;
  for (const step of run.steps ?? []) {
    if (step.kind === 'wait' || step.kind === 'end' || !step.screen) continue;
    if (step.screen !== screen) {
      if (line) lines.push(line);
      screen = step.screen;
      line = `on ${screen}: `;
    } else line += ', ';
    line += `${step.n} "${step.label}" (${step.role})`;
  }
  if (line) lines.push(line);
  const last = [...(run.steps ?? [])].reverse().find((step) => step.shot);
  if (last) lines.push(`last screenshot: ${last.shot}`);
  return lines;
}

/** The evidence behind one count: step, screen and screenshot for each instance. */
export function detailsFor(metric, run) {
  switch (metric) {
    case 'emptySteps':
      return (run.emptyStepList ?? []).flatMap((entry) => [
        `step ${entry.atStep} "${entry.by}" left ${entry.left} (for ${entry.to}) with nothing entered or decided on it`,
        `  screenshot: ${entry.shot}`,
      ]);
    case 'duplicatedChecks':
      return (run.duplicatedCheckList ?? []).flatMap((entry) => [
        `${entry.kind}: ${entry.label}${entry.steps?.length ? ` (step ${entry.steps.join(', ')})` : ''}`,
        ...(entry.evidence ? [`  evidence: ${entry.evidence}`] : []),
        ...(entry.shot ? [`  screenshot: ${entry.shot}`] : []),
      ]);
    case 'duplicateStatuses':
      return (run.duplicateStatusList ?? []).flatMap((entry) => [
        `"${entry.label}" shown ${entry.count}× for ${entry.subject} on ${entry.screen} (${(entry.kinds ?? []).join(', ')})`,
        ...(entry.undeclared ? [`  ${entry.undeclared} of them name no subject: give each its data-status-for (a StatusSubject, bead ro-ujb9.96.10)`] : []),
        `  screenshot (each copy ringed): ${entry.shot}`,
      ]);
    case 'ungroupedRepeats':
      return (run.ungroupedRepeatList ?? []).flatMap((entry) => [
        `list "${entry.list}" on ${entry.screen} repeats "${entry.subject}" on ${entry.count} items: ${entry.properties.map((p) => truncate(p, 40)).join(' / ')}`,
        ...(entry.declared === false ? ['  its rows declare no data-subject, so each is read by the line it leads with: declare what each row is about'] : []),
        `  screenshot (each item ringed): ${entry.shot}`,
      ]);
    case 'screens': {
      // Each screen once, in the order it was first reached, with the step
      // that opened it.
      const start = run.transitions?.[0]?.from ?? run.steps?.find((step) => step.screen)?.screen;
      const lines = start ? [`1. ${start} (where the flow starts)`] : [];
      const seen = new Set(start ? [start] : []);
      for (const t of run.transitions ?? []) {
        if (seen.has(t.to)) continue;
        seen.add(t.to);
        lines.push(`${seen.size}. ${t.to} — opened by step ${t.atStep} "${t.by}"`);
      }
      return lines;
    }
    case 'pageChanges':
      return [
        `areas: ${(run.areas ?? []).join(' → ')}`,
        ...(run.transitions ?? []).filter((t) => t.fromArea && t.fromArea !== t.toArea).flatMap((t) => [
          `step ${t.atStep} "${t.by}" moved from ${t.fromArea} (${t.from}) to ${t.toArea} (${t.to})`,
          ...(t.shot ? [`  screenshot: ${t.shot}`] : []),
        ]),
      ];
    case 'words':
      return [...(run.prose ?? [])]
        .sort((a, b) => b.words - a.words)
        .slice(0, 8)
        .map((entry) => `${entry.words} words on ${entry.screen ?? '?'}: "${truncate(entry.text, 90)}"`);
    default:
      return stepsByScreen(run);
  }
}

/**
 * Judge a walk against the record. `scope` limits the flows judged (the ones
 * the walk ran). Returns design failures (`increases`, `walkFailures`) and
 * bookkeeping (`decreases`: the record is looser than the flows; `unrecorded`:
 * a new flow that meets every rule but has no record yet).
 */
export function judgeResults(results, budget, registry, { scope = null } = {}) {
  const increases = [];
  const decreases = [];
  const walkFailures = [];
  const unrecorded = [];
  for (const [flow, entry] of Object.entries(results?.flows ?? {})) {
    if (scope && !scope.includes(flow)) continue;
    const kind = kindOf(registry, flow);
    for (const [viewport, run] of Object.entries(entry.runs ?? {})) {
      if (!run.ok) {
        walkFailures.push({
          flow, viewport, error: run.error, failedAfter: run.failedAfter ?? null, shot: run.failureShot ?? null,
        });
        continue;
      }
      const measured = measureRun(run, kind);
      const allowed = budget?.flows?.[flow]?.[viewport];
      if (!allowed) {
        const broken = RULE_METRICS.filter((metric) => metric in measured && measured[metric] > 0);
        for (const metric of broken) {
          increases.push({ flow, viewport, metric, measured: measured[metric], allowed: 0, isNew: true, details: detailsFor(metric, run) });
        }
        if (!broken.length) unrecorded.push({ flow, viewport, measured });
        continue;
      }
      for (const metric of metricsFor(kind)) {
        const limit = allowed[metric] ?? 0;
        if (measured[metric] > limit) {
          increases.push({ flow, viewport, metric, measured: measured[metric], allowed: limit, isNew: false, details: detailsFor(metric, run) });
        } else if (measured[metric] < limit) {
          decreases.push({ flow, viewport, metric, measured: measured[metric], allowed: limit });
        }
      }
    }
  }
  return { increases, decreases, walkFailures, unrecorded };
}

/**
 * The record lowered to what the walk measured wherever that is lower, plus a
 * first record for each NEW flow that meets every rule and cites valid prior
 * art. Never raises a number; never records a flow with a legacy rule count or
 * an unfinished walk.
 */
export function lowerBudget(budget, results, registry, { root = REPO_ROOT, readFile = workingTreeReader(root) } = {}) {
  const next = structuredClone(budget);
  next.flows ??= {};
  const changes = [];
  const added = [];
  for (const [flow, entry] of Object.entries(results?.flows ?? {})) {
    const kind = kindOf(registry, flow);
    for (const [viewport, run] of Object.entries(entry.runs ?? {})) {
      if (!run.ok) continue;
      const measured = measureRun(run, kind);
      const current = next.flows[flow]?.[viewport];
      if (current) {
        const lowered = metricsFor(kind).filter((metric) => measured[metric] < (current[metric] ?? 0));
        for (const metric of lowered) {
          changes.push(`${flow} · ${viewport}: ${metric} ${current[metric]} → ${measured[metric]}`);
          current[metric] = measured[metric];
        }
        continue;
      }
      if (!registry?.[flow]) continue;
      if (RULE_METRICS.some((metric) => (measured[metric] ?? 0) > 0)) continue;
      if (priorArtProblems(registry[flow].priorArt, readFile).length) continue;
      next.flows[flow] ??= {};
      next.flows[flow][viewport] = measured;
      added.push(`${flow} · ${viewport}: ${Object.entries(measured).map(([metric, value]) => `${metric} ${value}`).join(', ')}`);
    }
  }
  return { next, changes, added };
}

// ---------------------------------------------------------------------------
// The static half: record, history, registry, prior art
// ---------------------------------------------------------------------------

/** Load the flow registry a checkout declares (metadata only is read). */
export async function loadRegistry(root = REPO_ROOT) {
  const file = path.join(root, REGISTRY_FILE);
  if (!existsSync(file)) return null;
  return (await import(pathToFileURL(file).href)).FLOWS;
}

/**
 * Everything that can be judged without a browser. `registry` is the FLOWS
 * map (loaded from the checkout when omitted).
 */
export async function checkStatic({ root = REPO_ROOT, registry = null, prefixes = beadPrefixes(root) } = {}) {
  const flows = registry ?? (await loadRegistry(root)) ?? {};
  const budget = readBudget(root);
  const readFile = workingTreeReader(root);
  const schema = budget ? validateBudget(budget, { prefixes, readFile }) : [`${FLOW_BUDGET_FILE} is missing`];
  const head = parseBudget(gitShow(root, `HEAD:${FLOW_BUDGET_FILE}`));
  const uncommitted = head && budget ? budgetRaises(head, budget, { prefixes, readFile }) : [];
  const history = auditBudgetHistory(root, { prefixes });
  const raises = [...uncommitted, ...history.violations];
  const priorArt = [];
  for (const [flow, entry] of Object.entries(flows)) {
    const problems = priorArtProblems(entry.priorArt, readFile);
    if (problems.length) priorArt.push({ flow, problems });
  }
  const orphaned = Object.keys(budget?.flows ?? {}).filter((flow) => !flows[flow]);
  const shape = [];
  for (const [flow, viewports] of Object.entries(budget?.flows ?? {})) {
    if (!flows[flow]) continue;
    const expected = metricsFor(kindOf(flows, flow));
    for (const [viewport, entry] of Object.entries(viewports ?? {})) {
      const present = FLOW_METRICS.filter((metric) => entry?.[metric] !== undefined);
      if (present.length !== expected.length || !expected.every((metric) => present.includes(metric))) {
        shape.push(`${FLOW_BUDGET_FILE} → ${flow} · ${viewport}: a ${kindOf(flows, flow)} records ${expected.join(', ')}`);
      }
    }
  }
  return { schema: [...schema, ...shape], raises, priorArt, orphaned, history, flows: Object.keys(flows).length };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
//
// A stopped agent is guaranteed to read exactly one thing: the failure. So it
// names the flow, viewport, rule, step, screen, measured vs budget and the
// screenshot first, and ends with the same fixed instructions as the text
// gate's (steps 3 and 4 are shared word for word).

export const FLOW_RULE_TEXT =
  `Rules (bead ${FLOW_GATE_BEAD}; docs/21 principle 3b; operator, 2026-09-23): every screen change carries an input or\n` +
  'a decision; a check or confirmation happens once per flow; one status per subject per screen, where the operator\n' +
  'acts on it; a list that repeats one subject is grouped under it; a flow\'s actions, screens, page changes and words\n' +
  `only go down. The legacy counts in ${FLOW_BUDGET_FILE} are debt epic ${LEGACY_DEBT_EPIC} removes, not an allowance.`;

/** The fixed block every flow-gate design failure ends with. */
export const FLOW_NEXT_STEPS = [
  'What to do next:',
  '  1. Do not add a step, screen, check or status to get past this, do not change a flow\'s walk to avoid the',
  '     screen, and do not add an exception.',
  '  2. Redesign the flow: add the control to the current step instead of a new step or screen; check once; show one',
  '     status per subject, where the operator acts on it; group a list\'s repeated subject under one heading.',
  ...researchAndExceptionSteps({ subject: 'step', file: FLOW_BUDGET_FILE }),
].join('\n');

export const FLOW_LOWER_TEXT =
  `Lock the improvement in: pnpm ux:flows:baseline (it only ever lowers), then commit ${FLOW_BUDGET_FILE}.`;

function formatIncreases(increases) {
  const blocks = [];
  const groups = new Map();
  for (const increase of increases) {
    const key = `${increase.flow} · ${increase.viewport}`;
    groups.set(key, [...(groups.get(key) ?? []), increase]);
  }
  for (const [key, list] of groups) {
    const isNew = list.some((entry) => entry.isNew);
    const lines = [
      `UX flow gate: ${key} breaks ${list.length === 1 ? 'a rule' : `${list.length} rules`}${isNew ? ' — a new flow carries no legacy allowance' : ''} (bead ${FLOW_GATE_BEAD}).`,
    ];
    for (const entry of list) {
      lines.push(`  ✗ ${METRICS[entry.metric].rule} — ${METRICS[entry.metric].what}: ${entry.measured} measured, budget ${entry.allowed}`);
      for (const detail of entry.details) lines.push(`      ${detail}`);
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

function formatWalkFailures(failures) {
  return failures
    .map(({ flow, viewport, error, failedAfter, shot }) => [
      `UX flow gate: the walk of ${flow} · ${viewport} could not finish (bead ${FLOW_GATE_BEAD}).`,
      `  ${failedAfter ? `after step ${failedAfter.n} "${failedAfter.label}" on ${failedAfter.screen}` : 'before its first step'}: ${truncate(String(error).split('\n')[0], 200)}`,
      ...(shot ? [`  screenshot: ${shot}`] : []),
      `  A flow's walk in ${REGISTRY_FILE} drives the flow the product offers. If you changed this flow, change its walk`,
      '  in the same commit (clicking only controls the product shows); the gate then holds the new flow to its budget.',
      '  A flow is never deleted to get past the gate.',
    ].join('\n'))
    .join('\n\n');
}

function formatPriorArt(priorArt) {
  return [
    `UX flow gate: every flow in ${REGISTRY_FILE} must cite its research (bead ${FLOW_GATE_BEAD}):`,
    ...priorArt.map(({ flow, problems }) => `  ${flow}: ${problems.join('; ')}`),
  ].join('\n');
}

function formatOrphaned(orphaned) {
  return [
    `UX flow gate: ${FLOW_BUDGET_FILE} holds budgets for flows ${REGISTRY_FILE} no longer walks:`,
    ...orphaned.map((flow) => `  ${flow}`),
    '  Restore each walk. A flow the product no longer has is retired only by the operator: its entry moves under',
    '  "retired" with "approvedBy" (bead id) and "reason".',
  ].join('\n');
}

function formatDecreases(decreases, unrecorded, stageHint) {
  const lines = [];
  if (decreases.length) {
    lines.push(`UX flow gate: flows cost less than ${FLOW_BUDGET_FILE} records.`);
    for (const { flow, viewport, metric, measured, allowed } of decreases) lines.push(`  ${flow} · ${viewport}  ${metric} ${allowed} → ${measured}`);
  }
  if (unrecorded.length) {
    lines.push(`UX flow gate: new flows meet every rule but have no record yet (their first measurement becomes their budget):`);
    for (const { flow, viewport } of unrecorded) lines.push(`  ${flow} · ${viewport}`);
  }
  if (!lines.length) return '';
  lines.push(FLOW_LOWER_TEXT);
  if (stageHint) lines.push(`Then stage it: git add ${FLOW_BUDGET_FILE}`);
  return lines.join('\n');
}

/**
 * The message for one gate run ('' when it passes). Design failures end with
 * FLOW_NEXT_STEPS; a stale record alone (the flows got CHEAPER and the record
 * has not caught up) is bookkeeping, and ends with the one command that fixes
 * it; a broken isolation boundary is reported on its own.
 */
export function flowGateMessage({
  increases = [], decreases = [], walkFailures = [], unrecorded = [], statics = {}, isolation = [], probes = [], stageHint = false,
}) {
  const { schema = [], raises = [], priorArt = [], orphaned = [] } = statics;
  if (probes.length) {
    // Nothing was measured: a blind probe would read as the Tower improving.
    return [
      `UX flow gate: the gate's own probes no longer see what they measure, so no flow was walked (bead ${FLOW_GATE_BEAD}):`,
      ...probes.map((problem) => `  ${problem}`),
      '  Fix the probe in apps/tower/e2e/ux-walk.mjs so it finds each violation on the check page in',
      `  ${RUNNER_FILE} again. Never lower ${FLOW_BUDGET_FILE} from a walk with a blind probe.`,
    ].join('\n');
  }
  const design = [
    schema.length ? [`UX flow gate: ${FLOW_BUDGET_FILE} is malformed:`, ...schema].join('\n  ') : '',
    raises.length ? [`UX flow gate: ${FLOW_BUDGET_FILE} was raised without a valid exception:`, ...raises].join('\n  ') : '',
    priorArt.length ? formatPriorArt(priorArt) : '',
    orphaned.length ? formatOrphaned(orphaned) : '',
    walkFailures.length ? formatWalkFailures(walkFailures) : '',
    increases.length ? `${formatIncreases(increases)}\n\n${FLOW_RULE_TEXT}` : '',
  ].filter(Boolean);
  const boundary = isolation.length
    ? [`UX flow gate: the isolated fixture reported ${isolation.length} isolation violation(s); the walk is void:`, ...isolation.map((line) => `  ${line}`)].join('\n')
    : '';
  const stale = formatDecreases(decreases, unrecorded, stageHint);
  if (!design.length) return [boundary, stale].filter(Boolean).join('\n\n');
  return [boundary, ...design, stale, FLOW_NEXT_STEPS].filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function stagedFiles(root, filter = 'ACMR') {
  const result = git(root, ['diff', '--cached', '--name-only', `--diff-filter=${filter}`, '-z']);
  if (result.status !== 0) throw new Error(`ux-flow-gate: git diff --cached failed: ${result.stderr}`);
  return result.stdout.split('\0').filter(Boolean);
}

function parseArgs(argv) {
  const args = { staged: false, json: false, root: REPO_ROOT, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--staged') args.staged = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--root') args.root = path.resolve(argv[++index]);
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`ux-flow-gate: unknown argument ${arg}`);
  }
  return args;
}

const USAGE = `ux-flow-gate — the flow gate's static half (bead ${FLOW_GATE_BEAD})

  node scripts/ux-flow-gate.mjs            ${FLOW_BUDGET_FILE}'s schema and history, the registry
                                           against it, and every flow's prior-art citation
  node scripts/ux-flow-gate.mjs --staged   the staged record (the pre-commit hook)
  --json, --root <dir>

The walk itself: node ${RUNNER_FILE} (pnpm test:journeys runs it; pnpm ux:flows:baseline lowers the record).
Exit 0 clean, 1 violations, 2 could not run.`;

function emit(args, payload, text, code) {
  if (args.json) process.stdout.write(`${JSON.stringify({ ...payload, message: text, exitCode: code }, null, 2)}\n`);
  else if (text) (code === 0 ? process.stdout : process.stderr).write(`${text}\n`);
  return code;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { root } = args;
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const prefixes = beadPrefixes(root);

  if (args.staged) {
    // Pre-commit: judge the record being committed (the INDEX), and pay one
    // `git diff` when it is not staged.
    const staged = stagedFiles(root).includes(FLOW_BUDGET_FILE);
    const deleted = stagedFiles(root, 'D').includes(FLOW_BUDGET_FILE);
    if (!staged && !deleted) return emit(args, { checked: false }, '', 0);
    const readIndex = (rel) => gitShow(root, `:${rel}`);
    let schema = [];
    let raises = [];
    if (deleted) raises = [`${FLOW_BUDGET_FILE} is staged for deletion; the record of what flows cost is never deleted`];
    else {
      const index = parseBudget(gitShow(root, `:${FLOW_BUDGET_FILE}`));
      schema = validateBudget(index, { prefixes, readFile: readIndex });
      const head = parseBudget(gitShow(root, `HEAD:${FLOW_BUDGET_FILE}`));
      if (head) raises = budgetRaises(head, index, { prefixes, readFile: readIndex });
      else if (git(root, ['log', '-1', '--format=%H', '--', FLOW_BUDGET_FILE]).stdout.trim()) {
        raises = [`${FLOW_BUDGET_FILE} is being re-created after it was deleted; restore it from history instead`];
      }
      // Otherwise this commit introduces the gate: its first record is the
      // measurement, and every later commit is judged against it.
    }
    const text = flowGateMessage({ statics: { schema, raises } });
    return emit(args, { checked: true, schema, raises }, text, text ? 1 : 0);
  }

  const statics = await checkStatic({ root, prefixes });
  const text = flowGateMessage({ statics });
  const budget = readBudget(root);
  const legacy = Object.fromEntries(RULE_METRICS.map((metric) => [metric, 0]));
  for (const viewports of Object.values(budget?.flows ?? {})) {
    for (const entry of Object.values(viewports)) for (const metric of RULE_METRICS) legacy[metric] += entry[metric] ?? 0;
  }
  const summary =
    `UX flow gate (static): ${statics.flows} flows declared, ${FLOW_BUDGET_FILE} well-formed, history clean. ` +
    legacyDebtLine(legacy);
  return emit(args, { ...statics, legacy }, text || summary, text ? 1 : 0);
}

if (invokedDirectly(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  }, (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 2;
  });
}
