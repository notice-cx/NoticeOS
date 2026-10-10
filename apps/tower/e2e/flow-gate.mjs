#!/usr/bin/env node
// THE FLOW WALKER: walk every declared operator flow in a real browser and
// report what each one costs — actions, screens, page changes, explanatory
// words, empty steps, repeated checks, duplicate statuses, ungrouped lists.
//
// The text report (scripts/ux-gate.mjs) sees words in source files; it cannot
// see a flow that takes nine clicks across two pages. This walks the flows and
// prints the measurements for design review. It fails only when a flow cannot
// be walked to its end, when a page escapes the isolated fixture, or when the
// probes themselves stop seeing what they are built to see; a count is never
// a failure. Whether a step earns its place is the builder's call.
//
//   node apps/tower/e2e/flow-gate.mjs                    every flow, both viewports (pnpm test:journeys runs this)
//   node apps/tower/e2e/flow-gate.mjs --flows a,b        just these flows
//   node apps/tower/e2e/flow-gate.mjs --viewports phone  just this viewport
//   --port <n>      pin the first lane's port (default: free ports, journey-port.mjs)
//   --parallel <n>  lanes walked at once, each with its own fixture (default: as many
//                   as the journeys' workers, JOURNEY_WORKERS or half the cores, 1 to 4)
//   --json          machine-readable result on stdout
//
// ISOLATION is the journey suite's own (apps/tower/e2e/README.md): one
// fixture server per lane, started once per run (server.mjs, in-memory store,
// synthetic config, the isolation guard armed before Vite loads), loopback
// only, every browser request to another origin aborted, each flow started
// from POST /__journey/reset, and any JOURNEY_ISOLATION_VIOLATION a server
// prints fails the run. Before any flow, the probes are checked against a page
// holding one of each violation (`probeSelfTest`).
//
// OUTPUT: apps/tower/e2e/ux-flows-results/results.json (schema ux-walk/1, the
// audit's shape) and shots/<flow>/<viewport>/*.jpg, the screenshot every
// failure names. Both are generated and ignored by git.

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FLOWS } from "./ux-flows.mjs";
import { VIEWPORTS, Walk, installSyntheticProviders, settle, trackRequests } from "./ux-walk.mjs";
import { parallelServers, startFixtureServer } from "./fixture-server.mjs";
import { JOURNEY_BROWSERS } from "./journey-browsers.mjs";
import { checkedPort } from "./journey-port.mjs";
import { installOfflineGuard, startOfflineProxy } from "./offline-guard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
export const RESULTS_DIR = path.join(HERE, "ux-flows-results");

// The same Chromium the journeys use, wherever the gate is started from.
process.env.PLAYWRIGHT_BROWSERS_PATH = JOURNEY_BROWSERS;

function parseArgs(argv) {
  const args = { flows: null, viewports: Object.keys(VIEWPORTS), json: false, port: null, parallel: Math.min(4, parallelServers()), help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--flows") args.flows = argv[++index].split(",").filter(Boolean);
    else if (arg === "--viewports") args.viewports = argv[++index].split(",").filter(Boolean);
    else if (arg === "--json") args.json = true;
    else if (arg === "--port") args.port = Number(argv[++index]);
    else if (arg === "--parallel") args.parallel = Number(argv[++index]);
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`flow-gate: unknown argument ${arg}`);
  }
  if (args.port !== null) checkedPort(args.port);
  if (!Number.isInteger(args.parallel) || args.parallel < 1 || args.parallel > 4) throw new Error("flow-gate: --parallel takes 1 to 4 lanes");
  for (const viewport of args.viewports) if (!VIEWPORTS[viewport]) throw new Error(`flow-gate: unknown viewport ${viewport}`);
  for (const flow of args.flows ?? []) if (!FLOWS[flow]) throw new Error(`flow-gate: no flow "${flow}" in apps/tower/e2e/ux-flows.mjs`);
  return args;
}

/** An interrupted run never leaves a fixture server behind. */
const servers = new Set();
let interruptible = false;
function stopServersOnInterrupt() {
  if (interruptible) return;
  interruptible = true;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      for (const fixture of servers) fixture.child.kill("SIGTERM");
      process.exit(130);
    });
  }
}

/** Start one lane's isolated fixture server (fixture-server.mjs, the one way
 * every runner starts it) on `port`, or on a free port when null. */
async function startFixture(port) {
  stopServersOnInterrupt();
  const fixture = await startFixtureServer({ port });
  servers.add(fixture);
  fixture.child.once("exit", () => servers.delete(fixture));
  return fixture;
}

// ── the probes' own check ─────────────────────────────────────────────────────
//
// A probe that stopped seeing something would read as the Tower getting
// better. So before any flow is walked, the probes must find each kind of
// finding on a page built to hold exactly one of each, the way the Tower
// draws them.

const PROBE_PAGE = `<!doctype html><html><body><main>
  <nav aria-label="Integration setup"><button aria-pressed="false">1 Connect</button><button aria-pressed="true">2 Choose assets</button></nav>
  <section aria-label="Health">
    <span class="rounded-full whitespace-nowrap" data-status-for="integration:acme">Connected</span>
    <p>Acme <span class="rounded-full whitespace-nowrap" data-status-for="integration:acme">Connected</span></p>
    <span class="rounded-full whitespace-nowrap" data-status-for="integration:other">Connected</span>
    <span role="status" data-status-for="integration:other"><span class="rounded-full whitespace-nowrap" data-status-for="integration:other">Paused</span></span>
    <span class="rounded-full whitespace-nowrap">Failing</span>
  </section>
  <ul aria-label="Signals"><li data-subject="asset:journey.example">Journey Example – Error count</li><li data-subject="asset:journey.example">Journey Example – Replay sessions</li><li data-subject="asset:second.example">Second Example – Backlinks</li></ul>
  <ul aria-label="Undeclared"><li>Row one</li><li>Row one</li><li>Row two</li></ul>
  <ol data-order="chronological" aria-label="Recent"><li data-subject="asset:journey.example">Journey Example – saved</li><li data-subject="asset:journey.example">Journey Example – tested</li></ol>
  <p>This sentence is long enough to count as explanation on the screen.</p>
</main><section aria-label="Notifications"><ol data-sonner-toaster>
  <li data-sonner-toast data-type="error">Changed elsewhere — reload to see the current value</li>
  <li data-sonner-toast data-type="success">Saved — TV layout</li>
</ol></section></body></html>`;

export async function probeSelfTest(browser) {
  const { SAVED, STATUS_WORDS, listsInPage, proseInPage, refusalOnScreen, statusesInPage, viewInPage } = await import("./ux-walk.mjs");
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.setContent(PROBE_PAGE);
    const problems = [];
    const view = await page.evaluate(viewInPage);
    if (view !== "Choose assets") problems.push(`the guided-step probe read ${JSON.stringify(view)}, not "Choose assets"`);
    const statuses = await page.evaluate(statusesInPage);
    const acme = statuses.filter((status) => status.subject === "integration:acme" && status.label === "Connected").length;
    if (acme !== 2) problems.push(`the status probe found "Connected" for integration:acme ${acme} time(s), not 2`);
    const paused = statuses.filter((status) => status.label === "Paused").length;
    if (paused !== 1) problems.push(`the status probe counted a live region around one chip as ${paused} statuses, not 1`);
    const undeclared = statuses.find((status) => status.label === "Failing");
    if (undeclared?.declared !== false || !undeclared.subject.startsWith("page:")) {
      problems.push(`the status probe did not read a chip with no data-status-for as the screen's (${JSON.stringify(undeclared ?? null)})`);
    }
    const lists = await page.evaluate(listsInPage, { statusWords: STATUS_WORDS });
    const signals = lists.find((list) => list.name === "Signals");
    if (signals?.repeats?.[0]?.subject !== "asset:journey.example" || signals.repeats[0].properties.length !== 2) {
      problems.push(`the list probe did not see asset:journey.example repeated in the Signals list (${JSON.stringify(signals?.repeats ?? null)})`);
    }
    const lead = lists.find((list) => list.name === "Undeclared");
    if (lead?.repeats?.[0]?.subject !== "~Row one" || lead.repeats[0].declared !== false) {
      problems.push(`the list probe did not read undeclared rows by the line they lead with (${JSON.stringify(lead?.repeats ?? null)})`);
    }
    if (!lists.find((list) => list.name === "Recent")?.exempt) problems.push("the list probe did not exempt a chronological list");
    // A refusal is a refusal and never a confirmation (bead ro-nuz9): the
    // error toast is read as one, and only the success toast counts as saved.
    const refusal = await refusalOnScreen(page);
    if (refusal !== "Changed elsewhere — reload to see the current value") problems.push(`the refusal probe read ${JSON.stringify(refusal)}, not the error toast`);
    const confirmations = await page.locator(SAVED).allInnerTexts();
    if (confirmations.join("|") !== "Saved — TV layout") problems.push(`the save probe counted ${JSON.stringify(confirmations)} as saved, not only the success toast`);
    const prose = await page.evaluate(proseInPage);
    if (prose.length !== 1) problems.push(`the prose probe found ${prose.length} explanatory sentence(s), not 1`);
    return problems;
  } finally {
    await context.close();
  }
}

/** One flow at one viewport, from a reset fixture; returns its ux-walk/1 run. */
async function walkOne({ browser, base, id, viewport }) {
  const flow = FLOWS[id];
  const started = Date.now();
  const dir = path.join(RESULTS_DIR, "shots", id, viewport);
  await mkdir(dir, { recursive: true });
  const transport = await startOfflineProxy(base);
  let context, guard;
  try {
    context = await browser.newContext({ ...VIEWPORTS[viewport], baseURL: base, colorScheme: "dark", locale: "en-US",
      timezoneId: "UTC", reducedMotion: "reduce", serviceWorkers: "block", proxy: transport.proxy });
    context.setDefaultTimeout(15_000);
    // No page leaves the fixture, not even by a redirect (bead ro-o3hv).
    guard = await installOfflineGuard(context, base, { transport });
    await installSyntheticProviders(context, base);
    const page = await context.newPage();
    trackRequests(page, base);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const fixture = async (control) => {
      const response = await page.request.post(`${base}${control}`);
      if (!response.ok()) throw new Error(`${control} → ${response.status()} ${await response.text()}`);
      return response.json();
    };
    await fixture("/__journey/reset");
    try {
      await flow.setup(page, fixture);
      await settle(page);
    } catch (error) {
      return { ok: false, error: `setup: ${String(error?.message ?? error).split("\n")[0]}`, ms: Date.now() - started };
    }
    // The recorder starts listening after the setup, which is not counted.
    const w = new Walk({ page, flow: id, viewport, base, dir, repoRoot: REPO_ROOT, countStart: flow.countStart === true });
    w.fixture = fixture;
    try {
      await flow.run(w);
      const escaped = guard.check();
      if (escaped) return { ok: false, error: escaped, ...w.result(), pageErrors: errors, ms: Date.now() - started };
      return { ok: true, ...w.result(), pageErrors: errors, ms: Date.now() - started };
    } catch (error) {
      const failureShot = await w.shot("failed", "failure", null).catch(() => null);
      const last = w.steps.filter((step) => step.kind !== "wait").at(-1) ?? null;
      return { ok: false, error: String(error?.message ?? error).split("\n").slice(0, 4).join("\n"),
        failedAfter: last ? { n: last.n, label: last.label, screen: last.screen } : null, failureShot,
        ...w.result(), pageErrors: errors, ms: Date.now() - started };
    }
  } finally {
    try {
      if (guard) {
        await guard.close();
        const escaped = guard.check();
        if (escaped) throw new Error(escaped);
      } else await context?.close();
    } finally { await transport.close(); }
  }
}

/**
 * Walk the flows across `lanes.length` fixture servers (each started once and
 * reset before every flow, so no two flows ever share a store); returns the
 * ux-walk/1 results object, flows in registry order.
 */
async function walkFlows({ ids, viewports, lanes, log }) {
  const { chromium } = await import("@playwright/test");
  for (const base of lanes) {
    const status = await (await fetch(`${base}/__journey/status`)).json();
    if (status.isolated !== true) throw new Error(`${base} did not identify as the isolated journey fixture`);
  }
  const status = await (await fetch(`${lanes[0]}/__journey/status`)).json();
  const results = { schema: "ux-walk/1", measuredAt: new Date().toISOString(), servers: lanes, fixtureNow: status.now, flows: {} };
  for (const id of ids) results.flows[id] = { title: FLOWS[id].title, kind: FLOWS[id].kind ?? "flow", runs: {} };
  // The survey is the longest walk: start it first so the lanes finish together.
  const ordered = [...ids].sort((a, b) => Number(FLOWS[b].kind === "survey") - Number(FLOWS[a].kind === "survey"));
  const jobs = ordered.flatMap((id) => viewports.map((viewport) => ({ id, viewport })));
  const browser = await chromium.launch({ headless: true });
  try {
    results.probeProblems = await probeSelfTest(browser);
    if (results.probeProblems.length) return results;
    await Promise.all(lanes.map(async (base) => {
      for (let job = jobs.shift(); job; job = jobs.shift()) {
        const run = await walkOne({ browser, base, ...job });
        results.flows[job.id].runs[job.viewport] = run;
        log(`  ${run.ok ? "✓" : "✗"} ${job.id.padEnd(20)} ${job.viewport.padEnd(7)} ${String(run.ms).padStart(6)}ms  ` + (run.ok
          ? `actions ${run.actions} · screens ${run.screens} · pages ${run.hops} · words ${run.proseWords} · empty ${run.emptySteps} · checks ${run.duplicatedChecks} · statuses ${run.duplicateStatuses} · ungrouped ${run.ungroupedRepeats}`
          : `could not finish: ${String(run.error).split("\n")[0]}`));
      }
    }));
  } finally {
    await browser.close();
  }
  for (const id of ids) {
    results.flows[id].runs = Object.fromEntries(viewports.map((viewport) => [viewport, results.flows[id].runs[viewport]]));
  }
  return results;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const out = args.json ? () => {} : (line) => process.stderr.write(`${line}\n`);
  if (args.help) {
    process.stdout.write(`${readUsage()}\n`);
    return 0;
  }
  const started = Date.now();
  const ids = args.flows ?? Object.keys(FLOWS);
  const full = !args.flows && args.viewports.length === Object.keys(VIEWPORTS).length;

  if (full) await rm(RESULTS_DIR, { recursive: true, force: true });
  await mkdir(RESULTS_DIR, { recursive: true });
  const jobs = ids.length * args.viewports.length;
  // Each lane's server takes a free loopback port (fixture-server.mjs, beads
  // ro-ujb9.107 and ro-ujb9.167), so two runs on one machine never collide;
  // --port pins them.
  const laneCount = Math.max(1, Math.min(args.parallel, jobs));
  const fixtures = [];
  let results;
  let stopFailure;
  try {
    for (let lane = 0; lane < laneCount; lane += 1) fixtures.push(await startFixture(args.port === null ? null : args.port + lane));
    const lanes = fixtures.map((fixture) => fixture.origin);
    out(`UX flow walker: walking ${ids.length} flow(s) × ${args.viewports.join(", ")} on ${lanes.length} isolated fixture(s) ${lanes.join(", ")}`);
    results = await walkFlows({ ids, viewports: args.viewports, lanes, log: out });
  } finally {
    // Every fixture is stopped; one that did not exit cleanly fails the run.
    const stops = await Promise.allSettled(fixtures.map((fixture) => fixture.stop()));
    stopFailure = stops.find((stop) => stop.status === "rejected")?.reason;
  }
  if (stopFailure) throw stopFailure;
  const isolation = fixtures.flatMap((fixture) => fixture.violations());
  await writeFile(path.join(RESULTS_DIR, "results.json"), `${JSON.stringify(results, null, 2)}\n`);

  const probes = results.probeProblems ?? [];
  const unfinished = [];
  for (const id of ids) {
    for (const [viewport, run] of Object.entries(results.flows[id]?.runs ?? {})) {
      if (!run?.ok) unfinished.push(`${id} (${viewport}): ${String(run?.error ?? "no run").split("\n")[0]}${run?.failureShot ? `\n      ${run.failureShot}` : ""}`);
    }
  }
  const problems = [
    probes.length ? `The probes no longer see what they are built to see (apps/tower/e2e/ux-walk.mjs):\n  ${probes.join("\n  ")}` : "",
    isolation.length ? `A page left the isolated fixture:\n  ${isolation.join("\n  ")}` : "",
    unfinished.length ? `These flows could not be walked to the end (apps/tower/e2e/ux-flows.mjs):\n  ${unfinished.join("\n  ")}` : "",
  ].filter(Boolean).join("\n\n");
  const totals = summarize(results, ids, args.viewports);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (args.json) process.stdout.write(`${JSON.stringify({ results, totals, isolation, probes, problems, seconds }, null, 2)}\n`);
  if (problems) {
    process.stderr.write(`\n${problems}\n`);
    return 1;
  }
  out(`UX flow walker: ${ids.length} flow(s) × ${args.viewports.length} viewport(s) walked in ${seconds}s; ` +
    `the measurements are in ${path.relative(REPO_ROOT, RESULTS_DIR)}/results.json. ` + totalsLine(totals));
  return 0;
}

const METRICS = ["actions", "screens", "hops", "proseWords", "emptySteps", "duplicatedChecks", "duplicateStatuses", "ungroupedRepeats"];

/** The sums over every walked run, for the one-line summary. */
export function summarize(results, ids, viewports) {
  const totals = Object.fromEntries(METRICS.map((metric) => [metric, 0]));
  for (const id of ids) {
    for (const viewport of viewports) {
      const run = results.flows[id]?.runs?.[viewport];
      if (!run?.ok) continue;
      for (const metric of METRICS) totals[metric] += run[metric] ?? 0;
    }
  }
  return totals;
}

export function totalsLine(totals) {
  return `Across them: ${totals.actions} actions, ${totals.screens} screens, ${totals.hops} page changes, ${totals.proseWords} explanatory words, ` +
    `${totals.emptySteps} empty steps, ${totals.duplicatedChecks} repeated checks, ${totals.duplicateStatuses} duplicate statuses, ${totals.ungroupedRepeats} ungrouped lists.`;
}

function readUsage() {
  return [
    "flow-gate — walk every declared Tower flow in a browser and report what each costs",
    "",
    "  node apps/tower/e2e/flow-gate.mjs                    every flow, desktop and phone",
    "  node apps/tower/e2e/flow-gate.mjs --flows a,b        just these flows",
    "  node apps/tower/e2e/flow-gate.mjs --viewports phone  just this viewport",
    "  --port <n>      pin the first lane's port; the others take the next ones (default: free ports)",
    "  --parallel <n>  fixture lanes walked at once, 1-4 (default JOURNEY_WORKERS, or half the cores up to 4)",
    "  --json          machine-readable output",
    "",
    "Exit 0 when every flow walked to its end, 1 when one could not, 2 could not run.",
  ].join("\n");
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`flow-gate could not run: ${error?.stack ?? error}\n`);
    process.exitCode = 2;
  });
}
