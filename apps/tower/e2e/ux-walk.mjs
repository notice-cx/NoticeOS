// The flow recorder the flow walker drives with.
//
// Grown from a UX audit's walker so the walker measures a flow exactly the
// way the audit did: by clicking the controls the product offers, never by
// typing a URL the product did not link to, and COUNTING what each flow
// costs. The step scripts live in `ux-flows.mjs`; the runner and the report
// are `flow-gate.mjs`.
//
// This module holds no Playwright import: the runner owns the browser, and the
// root script tests can load the flow registry without one.
//
// COUNTING RULES (the audit's, unchanged unless noted):
//   click    a press on a control: button, link, tile, tab, disclosure, choice
//   field    an input the person fills (typed or pasted)
//   select   one native <select> choice
//   confirm  an "are you sure" gate (typed confirmation, second button, reason)
//   screen   a distinct place to orient on: a URL (path + query + hash) or a
//            guided-setup step that replaces the content. A panel or dialog
//            opened over the page is NOT a screen of its own (the audit's rule:
//            the connect panel is a control on the current step); every press
//            inside it still counts as an action. The guided step is detected
//            from the page, not declared by the script (new in the gate): the
//            current step of a step navigation (`aria-current="step"`, or the
//            pressed button of a nav labelled as setup/steps), in the open
//            dialog if there is one, else in <main>.
//   hop      moving between product areas (Home, Integrations, an asset page,
//            Assets, Tasks, Settings, Health, the Wall editor)
//   words    explanatory text on screen: visible sentences of six or more
//            words that are not a control, heading, label, value or code; per
//            flow, the UNIQUE text met along the way
//   empty    an EMPTY STEP: a screen left on which the person entered or
//            decided nothing (no choose, commit, verify, field or select). The
//            flow's starting screen is exempt.
//   dup check  the same verification or confirmation twice in one flow: a
//            repeated verify or confirm step, a repeated check request
//            (…/test, …/sites, google/properties), the same browser dialog
//            twice, or one observed and named with its code evidence.
//   dup status the same status for the same subject shown more than once on
//            one screen (doc 14's one representation per fact)
//   ungrouped a list whose items repeat one subject (timelines and logs, whose
//            order is the meaning, are exempt)
//
// SUBJECTS ARE READ FROM THE MARKUP, NEVER GUESSED (bead ro-ujb9.96.10). A
// status names what it is about in `data-status-for` (every status component
// draws it: `StateChip`, `IntegrationStateChip`, `StatusBanner`,
// `InlineSaveState`; `scripts/status-subject.test.mjs` fails a call site
// without one), and a row in a list of subjects carries `data-subject`. A
// status that declares nothing is the SCREEN's (`page:<path>`), and a row that
// declares nothing is read by the line it leads with, so an undeclared repeat
// fails the gate rather than passing as two subjects.

import { installGoogleConsent } from "./google-consent.mjs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

// Synthetic, public values: the same ones apps/tower/e2e/fixtures.ts exports
// (JOURNEY_KEY, JOURNEY_ASSET, JOURNEY_SITE, JOURNEY_NOW). Never a real key.
export const KEY = "journey-only-not-a-real-key";
export const ASSET = "journey.example";
export const SITE = "https://journey.example/";
export const NOW = "2026-09-06T12:00:00.000Z";

export const VIEWPORTS = Object.freeze({
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 },
});

export function areaOf(url) {
  const { pathname } = new URL(url);
  if (pathname === "/") return "Home";
  if (pathname === "/assets/new") return "New asset";
  if (/^\/assets\/[^/]+/.test(pathname)) return "Asset page";
  const first = pathname.split("/")[1];
  return { assets: "Assets", integrations: "Integrations", tasks: "Tasks", settings: "Settings", health: "Health",
    wall: pathname.startsWith("/wall/edit") ? "Wall editor" : "Wall", alerts: "Alerts", financials: "Money" }[first] ?? first;
}

// ── in-page probes (each runs in the browser; no closures) ────────────────────

/** The guided step on screen, or null: runs in the page. A step navigation
 * inside an open dialog counts (a wizard in a panel is still a wizard); the
 * dialog itself does not. */
export function viewInPage() {
  const modal = [...document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="alertdialog"]')].find((el) => {
    if (el.getAttribute("aria-label") === "Navigation" || el.querySelector("[cmdk-root]")) return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  });
  const root = modal ?? document.querySelector("main") ?? document.body;
  let current = root.querySelector('[aria-current="step"]');
  if (!current) {
    for (const nav of root.querySelectorAll("nav[aria-label]")) {
      if (!/setup|step|wizard/i.test(nav.getAttribute("aria-label") ?? "")) continue;
      current = nav.querySelector('button[aria-pressed="true"]');
      if (current) break;
    }
  }
  if (!current) return null;
  return (current.textContent ?? "").replace(/\s+/g, " ").trim().replace(/^\d+\s*/, "").slice(0, 60) || null;
}

/** Visible explanatory sentences where the person is reading: runs in the page. */
export function proseInPage() {
  // Where the person is reading: an open modal dialog (not the phone's
  // navigation drawer or the command palette), else <main>.
  const modal = [...document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="alertdialog"]')]
    .find((el) => el.getAttribute("aria-label") !== "Navigation" && !el.querySelector("[cmdk-root]") && el.getBoundingClientRect().width > 0);
  const root = modal ?? document.querySelector("main") ?? document.body;
  const EXCLUDE = 'button,a,label,h1,h2,h3,h4,h5,h6,summary,nav,th,td,dt,dd,option,select,input,textarea,code,pre,svg,[role="tab"],[role="tooltip"],[data-sonner-toaster],[data-owner-chip],.sr-only,[data-walk-overlay]';
  const shown = (el) => {
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
    const closed = el.closest("details:not([open])");
    if (closed && !el.closest("summary")) return false;
    return true;
  };
  // A text run belongs to its nearest block box, so an inline label and the
  // sentence beside it are one reading unit but two separate rows are two.
  const blockOf = (el) => {
    let at = el;
    while (at && at !== root && getComputedStyle(at).display.startsWith("inline")) at = at.parentElement;
    return at ?? el;
  };
  const words = (text) => text.split(" ").filter((word) => /[A-Za-z0-9]/.test(word)).length;
  const blocks = new Map();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.nodeValue ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const el = node.parentElement;
    if (!el || el.closest(EXCLUDE) || el.closest("span.rounded-full.whitespace-nowrap") || !shown(el)) continue;
    const block = blockOf(el);
    blocks.set(block, `${blocks.get(block) ?? ""} ${text}`);
  }
  return [...blocks.values()]
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter((text) => words(text) >= 6)
    // A data line ("Portfolio · 1 asset · updated 2m ago") is a row of values
    // separated by middots, not an explanation.
    .filter((text) => {
      const parts = text.split(/\s·\s/);
      return !(parts.length >= 2 && parts.every((part) => words(part) <= 5));
    });
}
export const wordCount = (text) => text.split(" ").filter((word) => /[A-Za-z0-9]/.test(word)).length;

/** Every visible status on the screen, with the subject it describes: runs in
 * the page. A status is a state chip, a banner, a setup-step state, or a leaf
 * element whose whole text is one of the product's status words. Its subject
 * is the nearest `data-status-for` the markup declares; one that declares none
 * belongs to the screen (`page:<path>`), so two undeclared copies of one
 * status on a screen are a duplicate, never two subjects. */
export function statusesInPage() {
  const modal = [...document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="alertdialog"]')]
    .find((el) => el.getAttribute("aria-label") !== "Navigation" && !el.querySelector("[cmdk-root]") && el.getBoundingClientRect().width > 0);
  const root = modal ?? document.querySelector("main") ?? document.body;
  const url = new URL(location.href);
  const WORDS = new Set(["not connected", "connected", "awaiting first result", "working", "failing", "overdue", "idle", "paused",
    "not monitored", "unknown", "not recorded", "ready to connect", "connection saved", "no recorded use", "no assets assigned",
    "configured · not verified", "not set up", "needs setup", "awaiting first sync", "syncing daily", "never", "no data connected",
    "not connected · open to set up", "legacy env", "not verified", "verified", "receiving data", "onboarding",
    "key accepted", "signed in", "url accepted", "checking"]);
  const shown = (el) => {
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
    const closed = el.closest("details:not([open])");
    return !(closed && !el.closest("summary"));
  };
  const found = [];
  const seen = new Set();
  const add = (el, label, kind) => {
    if (seen.has(el)) return;
    seen.add(el);
    const box = el.getBoundingClientRect();
    const declared = el.closest("[data-status-for]")?.getAttribute("data-status-for") ?? null;
    found.push({ label: label.replace(/\s+/g, " ").trim(), kind, subject: declared ?? `page:${url.pathname}${url.search}`,
      declared: declared !== null,
      box: { x: Math.round(box.left + scrollX), y: Math.round(box.top + scrollY), w: Math.round(box.width), h: Math.round(box.height) } });
  };
  const text = (el) => el.textContent.replace(/\s+/g, " ").trim();
  const chips = [...root.querySelectorAll("span.rounded-full.whitespace-nowrap")].filter((el) => shown(el) && text(el));
  for (const el of chips) add(el, el.textContent, "chip");
  for (const el of root.querySelectorAll('[role="status"]')) {
    if (!shown(el) || !text(el)) continue;
    // A live region around one chip (so a screen reader hears it) is that
    // chip's status, not a second one.
    if (chips.some((chip) => el.contains(chip) && text(chip) === text(el))) continue;
    add(el, el.textContent.slice(0, 90), "banner");
  }
  for (const el of root.querySelectorAll("[data-lane-step]")) {
    if (shown(el)) add(el, `${el.querySelector("span")?.firstChild?.textContent ?? "step"}: ${el.getAttribute("data-lane-step-state")}`, "setup-step");
  }
  for (const el of root.querySelectorAll("span, p, div, time")) {
    if (el.children.length > 0 || !shown(el)) continue;
    if (el.closest("span.rounded-full.whitespace-nowrap, [role=\"status\"], button, a, option, select, label")) continue;
    const text = el.textContent.replace(/\s+/g, " ").trim().toLowerCase();
    if (WORDS.has(text)) add(el, text, "status-text");
  }
  return found;
}

/** Every list on the screen and the SUBJECT each item is about: runs in the
 * page. A list is a <ul>/<ol>/<tbody>/role=list, or an element holding two or
 * more <details> rows. An item's subject is the `data-subject` it declares (on
 * the row or inside it); an item that declares none is read by the line it
 * leads with, status words skipped. One subject heading two or more items is
 * an UNGROUPED REPEAT, unless the list is a timeline or a log
 * (`data-order="chronological"`, or a timeline/history/changes/log region),
 * whose order is the meaning. */
export function listsInPage({ statusWords }) {
  const modal = [...document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="alertdialog"]')]
    .find((el) => el.getAttribute("aria-label") !== "Navigation" && !el.querySelector("[cmdk-root]") && el.getBoundingClientRect().width > 0);
  const root = modal ?? document.querySelector("main") ?? document.body;
  const words = new Set(statusWords);
  const shown = (el) => {
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    const closed = el.closest("details:not([open])");
    return !(closed && closed !== el && !el.closest("summary"));
  };
  const containers = new Set(root.querySelectorAll('ul, ol, tbody, [role="list"]'));
  for (const el of root.querySelectorAll("*")) {
    if ([...el.children].filter((child) => child.tagName === "DETAILS").length >= 2) containers.add(el);
  }
  const lists = [];
  for (const list of containers) {
    if (!shown(list) || list.closest('nav, [role="tablist"], select, [data-sonner-toaster]')) continue;
    const items = [...list.children].filter((child) => ["LI", "TR", "DETAILS"].includes(child.tagName) || child.getAttribute("role") === "listitem").filter(shown);
    if (items.length < 2) continue;
    const exempt = Boolean(list.closest('[data-order="chronological"], #timeline, [data-timeline], [aria-label*="changes" i], [aria-label*="history" i], [aria-label*="timeline" i], [aria-label*="log" i]'));
    const region = list.closest("section, [role=region], details, [data-list-panel]");
    const name = list.getAttribute("aria-label") ?? region?.getAttribute("aria-label")
      ?? region?.querySelector("h2, h3, summary")?.textContent?.trim().slice(0, 60) ?? list.tagName.toLowerCase();
    const rows = items.map((item) => {
      const box = item.getBoundingClientRect();
      const at = { x: Math.round(box.left + scrollX), y: Math.round(box.top + scrollY), w: Math.round(box.width), h: Math.round(box.height) };
      const lines = (item.innerText ?? "").split("\n").map((line) => line.trim()).filter((line) => line.length > 1 && !words.has(line.toLowerCase()));
      const declared = item.getAttribute("data-subject") ?? item.querySelector("[data-subject]")?.getAttribute("data-subject");
      if (declared) return { subject: declared, declared: true, property: (lines[0] ?? "").slice(0, 80), box: at };
      const lead = lines[0] ?? "";
      return { subject: lead ? `~${lead.slice(0, 80)}` : null, declared: false, property: (lines[1] ?? "").slice(0, 80), box: at };
    });
    const groups = new Map();
    for (const row of rows) if (row.subject) groups.set(row.subject, [...(groups.get(row.subject) ?? []), row]);
    const repeats = [...groups.entries()].filter(([, group]) => group.length >= 2)
      .map(([subject, group]) => ({ subject, declared: group[0].declared, properties: group.map((row) => row.property), boxes: group.map((row) => row.box) }));
    lists.push({ name, items: items.length, exempt, subjects: rows.map((row) => row.subject ?? "~"), repeats });
  }
  return lists;
}

export const STATUS_WORDS = ["not connected", "connected", "awaiting first result", "working", "failing", "overdue", "idle", "paused",
  "not monitored", "unknown", "not recorded", "ready to connect", "connection saved", "legacy env", "set up", "manage", "needs setup", "not set up",
  "key accepted", "signed in", "url accepted", "connect", "reconnect"];

// ── settling ──────────────────────────────────────────────────────────────────

// A measurement is only as good as the moment it is taken: text that renders
// after a slow answer must be on screen before the gate reads it, on a loaded
// laptop as on CI. So a settle waits for the network AND the DOM to go quiet,
// never for a fixed pause.
const QUIET_MS = 150;
const DOM_QUIET_MS = 150;
const SETTLE_CAP_MS = 10_000;
/** A request still open after this long is not one the screen waits on to
 * draw; its path is not waited on again for the rest of the run. */
const HUNG_MS = 4_000;
const NEVER_ANSWERED = new Set();

const pathOf = (request) => {
  try { return new URL(request.url()).pathname; } catch { return ""; }
};

/** Track the page's same-origin requests in flight, so a settle can wait for
 * quiet instead of a fixed pause (the desk polls, so never `networkidle`). */
export function trackRequests(page, base) {
  const state = { pending: new Map(), last: Date.now() };
  const mine = (request) => {
    try { return new URL(request.url()).origin === base; } catch { return false; }
  };
  page.on("request", (request) => {
    if (!mine(request) || NEVER_ANSWERED.has(pathOf(request))) return;
    state.pending.set(request, Date.now());
    state.last = Date.now();
  });
  const done = (request) => { if (state.pending.delete(request)) state.last = Date.now(); };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  page.__uxRequests = state;
  return state;
}

/** Resolves once the document has gone `quiet` ms without a mutation (capped). */
function domQuiet({ quiet, cap }) {
  return new Promise((resolve) => {
    let timer = null;
    const done = () => { observer.disconnect(); clearTimeout(timer); clearTimeout(limit); resolve(); };
    const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, quiet); });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    timer = setTimeout(done, quiet);
    const limit = setTimeout(done, cap);
  });
}

async function networkQuiet(page, state, deadline) {
  for (;;) {
    const now = Date.now();
    for (const [request, since] of state.pending) {
      if (now - since >= HUNG_MS) {
        NEVER_ANSWERED.add(pathOf(request));
        state.pending.delete(request);
      }
    }
    if (!state.pending.size && now - state.last >= QUIET_MS) return true;
    if (now >= deadline) return false;
    await page.waitForTimeout(30);
  }
}

/** The page has drawn: loaded, no route or tab still fetching its code, no
 * request in flight and no DOM change for a beat. */
export async function settle(page) {
  await page.waitForLoadState("load").catch(() => {});
  await page.locator("[data-route-loading]").first().waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
  const state = page.__uxRequests;
  if (!state) {
    await page.waitForTimeout(350);
    return;
  }
  const started = Date.now();
  const deadline = started + SETTLE_CAP_MS;
  // A render can start a request (a lazy tab, a dependent query), so repeat
  // until one pass finds both quiet.
  for (let pass = 0; pass < 5 && Date.now() < deadline; pass += 1) {
    await networkQuiet(page, state, deadline);
    const before = state.last;
    await page.evaluate(domQuiet, { quiet: DOM_QUIET_MS, cap: Math.max(0, deadline - Date.now()) }).catch(() => {});
    if (state.last === before && !state.pending.size) break;
  }
  if (process.env.UX_FLOWS_DEBUG) {
    process.stderr.write(`    settle ${Date.now() - started}ms pending=${[...state.pending.keys()].map(pathOf).join(",")}\n`);
  }
}

// ── the recorder ──────────────────────────────────────────────────────────────

const slugOf = (text, max) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max);

export class Walk {
  /**
   * @param {object} options
   * @param {import("@playwright/test").Page} options.page
   * @param {string} options.flow      registry id
   * @param {string} options.viewport  desktop | phone
   * @param {string} options.base      the fixture's origin
   * @param {string} options.dir       absolute directory for this run's screenshots
   * @param {string} options.repoRoot  screenshot paths are reported relative to it
   * @param {boolean} [options.countStart]  the starting screen is part of the flow
   */
  constructor({ page, flow, viewport, base, dir, repoRoot, countStart = false }) {
    Object.assign(this, { page, flow, viewport, base, dir, repoRoot, countStart });
    this.n = 0;
    this.steps = [];
    this.m = { clicks: 0, fields: 0, keys: 0, pastes: 0, selects: 0, confirms: 0, waits: 0, waitMs: 0, scrollPx: 0 };
    this.screens = new Set();
    this.areas = [];
    this.prose = new Map(); // text -> words
    this.proseAt = new Map(); // text -> the screen it was first read on
    this.proseByScreen = new Map(); // screen key -> words
    this.statusByScreen = new Map(); // screen key -> statuses at their most
    this.duplicateStatuses = new Map(); // `${screen}|${subject}|${label}` -> record
    this.listsByScreen = new Map(); // screen key -> lists with item subjects
    this.ungrouped = new Map(); // `${screen}|${list}|${subject}` -> record
    this.markShots = new Map();
    this.marks = 0;
    this.external = [];
    this.mustKnow = [];
    this.system = [];
    this.notes = [];
    this.manualDuplicates = [];
    this.requests = [];
    this.dialogs = [];
    this.transitions = [];
    this.current = null; // { key, inputs, start }
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.origin !== base || !url.pathname.startsWith("/api/")) return;
      this.requests.push({ step: this.n, method: request.method(), path: `${url.pathname}${url.search}` });
    });
    page.on("dialog", (dialog) => {
      this.dialogs.push({ step: this.n, type: dialog.type(), message: dialog.message() });
      void dialog.accept();
    });
  }
  get mobile() { return this.viewport === "phone"; }
  rel(file) { return path.relative(this.repoRoot, file).split(path.sep).join("/"); }
  async screenKey() {
    const url = new URL(this.page.url());
    const view = await this.page.evaluate(viewInPage).catch(() => null);
    return `${url.pathname}${url.search}${url.hash}${view ? ` [${view}]` : ""}`;
  }
  /** Where the person is now, what they read there, which statuses it shows —
   * and whether they just left a screen on which they did nothing. */
  async observe() {
    await settle(this.page);
    const key = await this.screenKey();
    const area = areaOf(this.page.url());
    if (this.current === null) this.current = { key, area, inputs: 0, start: true };
    else if (this.current.key !== key) {
      const last = this.steps.filter((step) => step.kind !== "wait").at(-1);
      this.transitions.push({
        from: this.current.key, to: key, fromArea: this.current.area, toArea: area,
        by: last?.label ?? null, role: last?.role ?? null, atStep: last?.n ?? null,
        inputsOnFrom: this.current.inputs, start: this.current.start,
        empty: this.current.inputs === 0 && !this.current.start,
      });
      this.current = { key, area, inputs: 0, start: false };
    }
    this.screens.add(key);
    if (this.areas.at(-1) !== area) this.areas.push(area);
    const prose = await this.page.evaluate(proseInPage);
    let words = 0;
    // The screen a flow STARTS on (usually Home) is where the person already
    // was; its text is not part of the flow unless the flow acts on it.
    const counted = !this.current.start || this.countStart;
    for (const text of prose) {
      const count = wordCount(text);
      words += count;
      if (counted && !this.prose.has(text)) {
        this.prose.set(text, count);
        this.proseAt.set(text, key);
      }
    }
    if (counted) this.proseByScreen.set(key, Math.max(words, this.proseByScreen.get(key) ?? 0));
    if (counted) await this.scan(key);
    return { key, words };
  }
  /** Statuses and lists on this screen: duplicates and ungrouped repeats. */
  async scan(key) {
    const statuses = await this.page.evaluate(statusesInPage);
    if ((this.statusByScreen.get(key)?.length ?? -1) < statuses.length) this.statusByScreen.set(key, statuses);
    const groups = new Map();
    for (const status of statuses) {
      const group = `${status.subject}|${status.label.toLowerCase()}`;
      groups.set(group, [...(groups.get(group) ?? []), status]);
    }
    // A status that names no subject could be about anything on its screen, so
    // it is the same fact as every status there with its words (fail closed:
    // the fix is a `data-status-for`, never a pass).
    for (const [group, list] of groups) {
      if (list.every((status) => status.declared !== false)) continue;
      const label = list[0].label.toLowerCase();
      list.push(...statuses.filter((status) => status.declared !== false && status.label.toLowerCase() === label));
      groups.set(group, list);
    }
    for (const [group, list] of groups) {
      if (list.length < 2) continue;
      const id = `${key}|${group}`;
      if ((this.duplicateStatuses.get(id)?.count ?? 0) >= list.length) continue;
      // One ringed capture per duplicate per flow; later screens cite it.
      const shot = this.markShots.get(`status|${group}`) ?? await this.markDuplicates(list.map((s) => s.box), `dup-${list[0].label}`);
      this.markShots.set(`status|${group}`, shot);
      this.duplicateStatuses.set(id, { screen: key, subject: list[0].subject, label: list[0].label, count: list.length, kinds: list.map((s) => s.kind),
        undeclared: list.filter((s) => s.declared === false).length, shot });
    }
    const lists = await this.page.evaluate(listsInPage, { statusWords: STATUS_WORDS });
    this.listsByScreen.set(key, lists.map(({ name, items, exempt, subjects, repeats }) => ({ name, items, exempt, subjects, repeats: repeats.map(({ subject, properties, declared }) => ({ subject, properties, declared })) })));
    for (const list of lists) {
      if (list.exempt) continue;
      for (const repeat of list.repeats) {
        const id = `${key}|${list.name}|${repeat.subject}`;
        if ((this.ungrouped.get(id)?.count ?? 0) >= repeat.properties.length) continue;
        const where = new URL(this.page.url());
        const mark = `list|${where.pathname}${where.search}|${list.name}|${repeat.subject}`;
        const shot = this.markShots.get(mark) ?? await this.markDuplicates(repeat.boxes, `ungrouped-${repeat.subject}`);
        this.markShots.set(mark, shot);
        this.ungrouped.set(id, { screen: key, list: list.name, subject: repeat.subject, count: repeat.properties.length, properties: repeat.properties,
          declared: repeat.declared, shot });
      }
    }
  }
  /** A full-page picture with every instance of one repeated thing ringed. */
  async markDuplicates(boxList, label) {
    await this.page.evaluate((boxes) => {
      for (const box of boxes) {
        const ring = document.createElement("div");
        ring.setAttribute("data-walk-overlay", "");
        Object.assign(ring.style, { position: "absolute", left: `${box.x - 5}px`, top: `${box.y - 5}px`, width: `${box.w + 10}px`, height: `${box.h + 10}px`, border: "3px solid #ffb000", borderRadius: "10px", zIndex: 2147483647, pointerEvents: "none" });
        document.body.appendChild(ring);
      }
    }, boxList);
    this.marks += 1;
    const file = path.join(this.dir, `${String(this.n).padStart(2, "0")}-m${this.marks}-${slugOf(label, 48)}.jpg`);
    await this.page.screenshot({ path: file, type: "jpeg", quality: 42, fullPage: true });
    await this.page.evaluate(() => document.querySelectorAll("[data-walk-overlay]").forEach((el) => el.remove()));
    return this.rel(file);
  }
  /** The viewport before an action, the target ringed. */
  async shot(verb, label, target) {
    this.n += 1;
    const file = path.join(this.dir, `${String(this.n).padStart(2, "0")}-${slugOf(`${verb}-${label}`, 64)}.jpg`);
    if (target) {
      await target.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const ring = document.createElement("div");
        ring.setAttribute("data-walk-overlay", "");
        Object.assign(ring.style, { position: "fixed", left: `${box.left - 4}px`, top: `${box.top - 4}px`, width: `${box.width + 8}px`, height: `${box.height + 8}px`, border: "3px solid #ff3da8", borderRadius: "8px", boxShadow: "0 0 0 4px rgba(255,61,168,.25)", zIndex: 2147483647, pointerEvents: "none" });
        document.body.appendChild(ring);
      }).catch(() => {});
    }
    await this.page.screenshot({ path: file, type: "jpeg", quality: 40 });
    await this.page.evaluate(() => document.querySelectorAll("[data-walk-overlay]").forEach((el) => el.remove())).catch(() => {});
    return this.rel(file);
  }
  /** How far the page has to move to bring this control fully into view. */
  async reach(target) {
    await target.waitFor({ state: "visible", timeout: 15_000 });
    const { top, bottom, vh } = await target.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, vh: window.innerHeight };
    });
    let scroll = 0;
    if (bottom > vh) scroll = Math.round(bottom - vh + 24);
    else if (top < 0) scroll = Math.round(-top + 24);
    if (scroll > 0) {
      await target.scrollIntoViewIfNeeded();
      this.m.scrollPx += scroll;
    }
    return scroll;
  }
  /**
   * One action. `role` says what the action IS, which is what the empty-step
   * rule reads: `nav` (go somewhere), `advance` (Next / Continue / a setup
   * step), `reveal` (open a form, row, disclosure or menu in place), `choose`
   * (pick an item or an action), `commit` (Save, Create, Send, Enable),
   * `verify` (a connection test or discovery the person asks for), and `field`
   * / `select` for inputs. A screen left having had no choose, commit, verify,
   * field or select on it is an EMPTY step.
   */
  async step(kind, role, label, target, act, extra = {}) {
    const { key, words } = await this.observe();
    const scroll = target ? await this.reach(target) : 0;
    const shot = await this.shot(kind, label, target);
    const at = new URL(this.page.url());
    const before = this.requests.length;
    const record = { n: this.n, kind, role, label, screen: key, at: `${at.pathname}${at.search}${at.hash}`, scroll, proseWords: words, shot, ...extra };
    this.steps.push(record);
    await act();
    if (["choose", "commit", "verify", "field", "select"].includes(role)) this.current.inputs += 1;
    // Requests the action itself started (read back once the next one begins).
    record.requestsFrom = before;
  }
  async click(target, label, { role = "commit", confirm = false } = {}) {
    this.m.clicks += 1;
    if (confirm) this.m.confirms += 1;
    await this.step(confirm ? "confirm" : "click", role, label, target, () => target.click());
  }
  async fill(target, value, label, { paste = false, confirm = false } = {}) {
    this.m.fields += 1;
    if (paste) this.m.pastes += 1; else this.m.keys += value.length;
    if (confirm) this.m.confirms += 1;
    await this.step("field", "field", label, target, () => target.fill(value), { value: paste ? "(pasted)" : value });
  }
  async select(target, value, label) {
    this.m.selects += 1;
    await this.step("select", "select", label, target, () => target.selectOption(value));
  }
  /** A file dropped or chosen (Google's client_secret.json, bead
   * ro-ujb9.96.7.7): one field, like a paste. */
  async upload(target, file, label) {
    this.m.fields += 1;
    this.m.pastes += 1;
    await this.step("field", "field", label, target, () => target.setInputFiles(file), { value: "(file)" });
  }
  /** An operation the person waits on before going on (a Save, a Test). */
  async waitFor(label, condition) {
    const started = Date.now();
    await condition();
    const ms = Date.now() - started;
    this.m.waits += 1;
    this.m.waitMs += ms;
    this.steps.push({ n: this.n, kind: "wait", role: "wait", label, ms });
  }
  /** Something done in another product's UI, which the flow depends on. */
  outside(label, { clicks = 0, fields = 0, estimate = true, source }) {
    this.external.push({ label, clicks, fields, estimate, source });
  }
  know(label) { this.mustKnow.push(label); }
  /** A step the system performs on its own schedule (the person waits). */
  systemStep(label, delay) { this.system.push({ label, delay }); }
  note(text) { this.notes.push(text); }
  /** A verification or confirmation that repeats one already made in this
   * flow, which no request or step label reveals on its own. Removed only by
   * the redesign that removes the second check. */
  duplicate(label, evidence) { this.manualDuplicates.push({ label, evidence, step: this.n }); }
  async end(label = "done") {
    const { key } = await this.observe();
    const shot = await this.shot("end", label, null);
    this.steps.push({ n: this.n, kind: "end", role: "end", label, screen: key, shot });
    // A flow never finishes on a refusal (bead ro-nuz9): whatever it waited
    // for, an error toast or a "Not saved" still on screen means the product
    // said no, and the walk is a failure however many steps it took.
    const refusal = await refusalOnScreen(this.page);
    if (refusal !== null) throw new Error(`the walk ended on a refusal: ${refusal}`);
  }
  result() {
    const hops = Math.max(0, this.areas.length - 1);
    const proseWords = [...this.prose.values()].reduce((a, b) => a + b, 0);
    const worst = [...this.proseByScreen.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
    // Requests per action: everything fired between one action and the next.
    const actions = this.steps.filter((step) => step.requestsFrom !== undefined);
    actions.forEach((step, index) => {
      const until = actions[index + 1]?.requestsFrom ?? this.requests.length;
      step.requests = this.requests.slice(step.requestsFrom, until).map((r) => `${r.method} ${r.path}`);
      delete step.requestsFrom;
    });
    const shotOf = (n) => this.steps.find((step) => step.n === n && step.shot)?.shot ?? null;
    // A check is a verification the person asks for, or a request that proves
    // something to them; the same one twice in one flow is a duplicated check.
    const checks = new Map();
    for (const step of this.steps) {
      if (step.role === "verify" || step.kind === "confirm") {
        const id = `${step.role}:${step.label}`;
        checks.set(id, [...(checks.get(id) ?? []), step.n]);
      }
    }
    const repeatedRequests = new Map();
    for (const request of this.requests) {
      if (!/\/test$|\/sites$|\/google\/properties$/.test(request.path) || request.method === "OPTIONS") continue;
      const id = `${request.method} ${request.path}`;
      repeatedRequests.set(id, [...(repeatedRequests.get(id) ?? []), request.step]);
    }
    const repeatedDialogs = new Map();
    for (const dialog of this.dialogs) {
      const id = `${dialog.type}: ${dialog.message}`;
      repeatedDialogs.set(id, [...(repeatedDialogs.get(id) ?? []), dialog.step]);
    }
    const duplicatedChecks = [
      ...[...checks.entries()].filter(([, at]) => at.length > 1).map(([label, at]) => ({ kind: "repeated step", label, steps: at, shot: shotOf(at.at(-1)) })),
      ...[...repeatedRequests.entries()].filter(([, at]) => at.length > 1).map(([label, at]) => ({ kind: "repeated request", label, steps: at, shot: shotOf(at.at(-1)) })),
      ...[...repeatedDialogs.entries()].filter(([, at]) => at.length > 1).map(([label, at]) => ({ kind: "repeated dialog", label, steps: at, shot: shotOf(at.at(-1)) })),
      ...this.manualDuplicates.map((d) => ({ kind: "observed", ...d, steps: [d.step], shot: shotOf(d.step) })),
    ];
    const emptySteps = this.transitions.filter((t) => t.empty);
    return {
      flow: this.flow, viewport: this.viewport,
      ...this.m,
      actions: this.m.clicks + this.m.fields + this.m.selects,
      screens: this.screens.size, hops, areas: this.areas,
      emptySteps: emptySteps.length,
      duplicatedChecks: duplicatedChecks.length,
      duplicateStatuses: this.duplicateStatuses.size,
      ungroupedRepeats: this.ungrouped.size,
      proseWords, proseBlocks: this.prose.size,
      worstScreen: worst ? { screen: worst[0], words: worst[1] } : null,
      external: this.external, mustKnow: this.mustKnow, system: this.system, notes: this.notes,
      transitions: this.transitions.map((t) => ({ ...t, shot: shotOf(t.atStep) })),
      emptyStepList: emptySteps.map((t) => ({ left: t.from, to: t.to, by: t.by, atStep: t.atStep, shot: shotOf(t.atStep) })),
      duplicatedCheckList: duplicatedChecks,
      duplicateStatusList: [...this.duplicateStatuses.values()],
      ungroupedRepeatList: [...this.ungrouped.values()],
      heights: this.heights ?? null,
      listsByScreen: Object.fromEntries(this.listsByScreen),
      statusesByScreen: Object.fromEntries([...this.statusByScreen.entries()].map(([key, list]) => [key, list.map(({ label, kind, subject }) => ({ label, kind, subject }))])),
      proseByScreen: Object.fromEntries(this.proseByScreen),
      prose: [...this.prose.entries()].map(([text, words]) => ({ words, text, screen: this.proseAt.get(text) })),
      requests: this.requests,
      dialogs: this.dialogs,
      steps: this.steps,
    };
  }
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

// ── navigation the product offers ─────────────────────────────────────────────

/** A sidebar destination: one click on a desk, the menu then the link on a phone. */
export async function nav(w, name) {
  if (w.mobile) {
    await w.click(w.page.getByRole("button", { name: "Open navigation" }), "open menu", { role: "reveal" });
    const drawer = w.page.locator('[aria-label="Navigation"]');
    await w.click(drawer.getByRole("link", { name, exact: true }).first(), `menu ${name}`, { role: "nav" });
  } else {
    await w.click(w.page.locator("[data-app-sidebar]").getByRole("link", { name, exact: true }).first(), `sidebar ${name}`, { role: "nav" });
  }
  await settle(w.page);
}

/** The asset's own page from wherever the person is: the sidebar lists assets. */
export async function openAsset(w) {
  if (w.mobile) {
    await w.click(w.page.getByRole("button", { name: "Open navigation" }), "open menu", { role: "reveal" });
    const drawer = w.page.locator('[aria-label="Navigation"]');
    const expand = drawer.getByRole("button", { name: "Expand the site list" });
    if (await expand.isVisible().catch(() => false)) await w.click(expand, "expand site list", { role: "reveal" });
    await w.click(drawer.getByRole("link", { name: /Journey Example|journey\.example/ }).first(), "menu asset", { role: "nav" });
  } else {
    await w.click(w.page.locator("[data-app-sidebar]").getByRole("link", { name: /Journey Example|journey\.example/ }).first(), "sidebar asset", { role: "nav" });
  }
  await settle(w.page);
}

export async function assetTab(w, name) {
  const tab = w.page.getByRole("tab", { name: new RegExp(`^${name}`) }).first();
  await w.click(tab, `tab ${name}`, { role: "nav" });
  await settle(w.page);
}

/** A provider's own page, through its catalog row's one action (Connect or
 * Manage). The row itself is not a link since bead ro-ujb9.96.7.1. */
export async function openIntegration(w, label) {
  await nav(w, "Integrations");
  const row = w.page.locator("[data-integration-tile]").filter({ hasText: label }).first();
  await w.click(row.getByRole("link"), `row ${label}`, { role: "choose" });
}

/** The connect panel (beads ro-ujb9.96.7.1, ro-ujb9.96.7.2): the row's
 * Connect opens it over the list — the same screen — and one Connect press
 * saves and tests the key. The account's sites then appear in the same panel,
 * matched to assets by domain and ticked; one Start press saves those matches
 * (the Data sources tab's own write) and runs the first collection through the
 * scheduled job's step. The flow ends when a collected site reads Working —
 * first data inside the flow, with no visit to Data sources. */
export async function connectInPanel(w, id, fields) {
  await nav(w, "Integrations");
  const row = w.page.locator(`[data-integration-tile="${id}"]`);
  await w.click(row.getByRole("button", { name: /^Connect / }), "row Connect", { role: "reveal" });
  const panel = w.page.locator(`[data-connect-panel="${id}"]`);
  for (const [label, value] of fields) await w.fill(panel.getByLabel(label, { exact: true }), value, label, { paste: true });
  await w.click(panel.getByRole("button", { name: "Connect", exact: true }), "Connect", { role: "commit" });
  await w.waitFor("Connect → Key accepted", () => panel.locator('[data-connect-state="accepted"]').waitFor({ timeout: 15_000 }));
  const start = panel.locator("[data-sites-start]");
  await w.waitFor("Key accepted → sites matched", () => start.waitFor({ timeout: 15_000 }));
  await w.click(start, "Start collecting", { role: "commit" });
  await w.waitFor("Start → Working", () => panel.locator('[data-site-row] [data-connection="working"]').first().waitFor({ timeout: 60_000 }));
}

/** The same panel reached from where a new site lands (bead ro-ujb9.96.7.5):
 * the asset's Data sources row's one Connect — picking which source to connect
 * — opens the panel for this asset on Integrations; the key, the match and
 * Start are the panel's own, as above. */
export async function connectFromSource(w, id, fields) {
  const connect = w.page.locator(`#integrations [data-source-connect="${id}"]`);
  await w.click(connect, "source Connect", { role: "choose" });
  await w.waitFor("Connect → panel", () => w.page.locator(`[data-connect-panel="${id}"]`).waitFor({ timeout: 15_000 }));
  const panel = w.page.locator(`[data-connect-panel="${id}"]`);
  for (const [label, value] of fields) await w.fill(panel.getByLabel(label, { exact: true }), value, label, { paste: true });
  await w.click(panel.getByRole("button", { name: "Connect", exact: true }), "Connect", { role: "commit" });
  await w.waitFor("Connect → Key accepted", () => panel.locator('[data-connect-state="accepted"]').waitFor({ timeout: 15_000 }));
  const start = panel.locator("[data-sites-start]");
  await w.waitFor("Key accepted → sites matched", () => start.waitFor({ timeout: 15_000 }));
  await w.click(start, "Start collecting", { role: "commit" });
  await w.waitFor("Start → Working", () => panel.locator('[data-site-row] [data-connection="working"]').first().waitFor({ timeout: 60_000 }));
}

export async function guidedStep(w, name) {
  const card = w.page.locator("[data-provider-card]");
  await w.click(card.getByRole("navigation", { name: "Integration setup" }).getByRole("button", { name: new RegExp(`${name}$`) }), `step ${name}`, { role: "advance" });
}

export async function saveCredential(w, label = "Save credential") {
  const card = w.page.locator("[data-provider-card]");
  const button = card.getByRole("button", { name: label, exact: true });
  await w.click(button, label, { role: "commit" });
  await w.waitFor(`${label} → saved`, () => card.locator("form[data-connect-form]").first().waitFor({ state: "detached", timeout: 15_000 }).catch(() => {}));
}

/** The card's Test button, named for what the press does (bead
 * ro-ujb9.96.6.1): "Test connection" for a free read, "Check keys" where the
 * provider offers no free call (Clarity). */
export async function testConnection(w, label = "Test connection") {
  const card = w.page.locator("[data-provider-card]");
  await w.click(card.getByRole("button", { name: label, exact: true }), label, { role: "verify" });
  await w.waitFor(`${label} → verdict`, () => card.getByRole("button", { name: label, exact: true }).waitFor({ state: "visible", timeout: 15_000 }));
}

export async function continueTo(w, label) {
  const card = w.page.locator("[data-provider-card]");
  await w.click(card.getByRole("button", { name: label, exact: true }), label, { role: "advance" });
}

/** A row on the asset's Sources tab, opened. */
export async function openSourceRow(w, name) {
  const sources = w.page.locator("#integrations");
  const row = sources.getByRole("button", { name: new RegExp(`^${name}`) }).first();
  // Data sources and More sources each keep their rows past three behind their
  // own "Show N more" (bead ro-ujb9.164: More sources is no longer a closed box).
  for (const panel of ["Data sources", "More sources"]) {
    if (await row.isVisible().catch(() => false)) break;
    const more = sources.getByRole("region", { name: panel, exact: true }).getByRole("button", { name: /^Show \d+ more$/ });
    if (await more.isVisible().catch(() => false)) await w.click(more, "Show more sources", { role: "reveal" });
  }
  if ((await row.getAttribute("aria-expanded")) !== "true") await w.click(row, `row ${name}`, { role: "reveal" });
}

/** A save the product confirmed: its success toast, or "Saved" beside the
 * field. Never any toast: an error toast is the refusal (bead ro-nuz9). */
export const SAVED = '[data-sonner-toast][data-type="success"], [data-save-state="saved"]';

/** A save the product refused: its error toast, or "Not saved" beside the
 * field (InlineSaveState). */
export const REFUSED = '[data-sonner-toast][data-type="error"], [data-save-state="refused"]';

/** The words of the refusal on screen, or null when there is none. */
export async function refusalOnScreen(page) {
  const refused = page.locator(REFUSED).first();
  if (!(await refused.isVisible().catch(() => false))) return null;
  return (await refused.innerText().catch(() => "")).replace(/\s+/g, " ").trim() || "refused";
}

/**
 * Wait for the product's answer to a commit and accept only a confirmation
 * (bead ro-nuz9): `confirmation` — by default any SAVED — passes; a refusal
 * appearing first fails the walk in the refusal's own words, and so does no
 * answer at all. The arrange-wall walk used to wait for ANY toast, so the
 * "Changed elsewhere" refusal of a first Save counted as saved.
 */
export async function awaitSaved(w, label, confirmation = w.page.locator(SAVED).first()) {
  await w.waitFor(label, async () => {
    const refused = w.page.locator(REFUSED).first();
    const outcome = await Promise.race([
      confirmation.waitFor({ state: "visible", timeout: 15_000 }).then(() => "saved", () => null),
      refused.waitFor({ state: "visible", timeout: 15_000 }).then(() => "refused", () => null),
    ]);
    if (outcome === "saved") return;
    const words = await refusalOnScreen(w.page);
    throw new Error(words ? `${label}: refused — ${words}` : `${label}: no confirmation in 15 s`);
  });
}

/** One KnobEditor field: pick/type, then its own Save — the first Save after
 * the control in document order, which is the one beside it. */
export async function knobSave(w, control, label) {
  const save = control.locator('xpath=following::button[normalize-space(.)="Save"][1]');
  await w.click(save, `Save ${label}`, { role: "commit" });
  await awaitSaved(w, `Save ${label} → saved`);
}

// ── the synthetic provider layer (the browser boundary) ───────────────────────
//
// The connect panels (Bing, DataForSEO, PostHog, Clarity, Mediavine, Google)
// run the production ingest over the fixture, with only each provider's
// network answered by harness.ts. What is still answered here: the older
// credential writes and connection tests of the providers on their own pages
// (Discord, calendars), and Google's consent screen — a full-page trip to
// accounts.google.com that is not walked: it answers with the redirect Google
// sends back after a person consents, carrying the fixture's synthetic code
// (bead ro-ujb9.96.7.7), so the callback, the token exchange and the account's
// lists are the product's own.

const REQUIRED = {
  dataforseo: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"],
  posthog: ["POSTHOG_API_KEY"], clarity: ["CLARITY_TOKENS"],
  discord: ["DISCORD_WEBHOOK_URL"], calendar: ["CALENDAR_FEEDS"],
};
export async function installSyntheticProviders(context, base) {
  const held = new Map(); // provider -> { assets: string[], tested: boolean }
  await context.route(`${base}/api/integrations/providers`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const status of body.providers) {
      const id = status.provider.id;
      const entry = held.get(id);
      if (!entry) continue;
      status.credential = {
        ...status.credential, source: "store", fields: REQUIRED[id], missingFields: [], assetsHeld: entry.assets,
        auth: null,
        metadata: null,
        keyVersion: 1, createdAt: NOW, updatedAt: NOW,
        lastUsedAt: entry.tested ? NOW : null, lastOkAt: entry.tested ? NOW : null, lastError: null,
      };
    }
    await route.fulfill({ response, json: body });
  });
  await context.route(new RegExp(`^${base}/api/integrations/([a-z-]+)/(credential|test)$`), async (route) => {
    const [, id, what] = route.request().url().match(/integrations\/([a-z-]+)\/(credential|test)$/);
    if (!(id in REQUIRED)) return route.continue();
    const method = route.request().method();
    if (what === "credential" && method === "PUT") {
      const fields = route.request().postDataJSON()?.fields ?? {};
      const map = fields.POSTHOG_KEYS ?? fields.CLARITY_TOKENS;
      held.set(id, { assets: map ? Object.keys(JSON.parse(map)) : [], tested: false });
      return route.fulfill({ status: 200, json: { ok: true } });
    }
    if (what === "credential" && method === "DELETE") { held.delete(id); return route.fulfill({ status: 204, body: "" }); }
    if (what === "test") {
      const entry = held.get(id);
      if (entry) entry.tested = true;
      // A result, never a sentence (bead ro-ujb9.96.6.19).
      const result = entry ? { outcome: "answered" } : { outcome: "not-connected", fix: { kind: "connect" } };
      return route.fulfill({ json: { ok: Boolean(entry), message: entry ? "Answered" : "Not connected", result, checkedAt: NOW } });
    }
    return route.continue();
  });
  await installGoogleConsent(context, base);
  // Task writes (answer, dismiss, approve, file) go through the real task lane
  // to the fixture's `bd` (bead ro-ujb9.96.7.11); nothing is answered here.
  return held;
}
