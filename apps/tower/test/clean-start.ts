// Before every test file, in the process that runs it.
//
// A worker runs file after file in one process (vitest.config.ts, `isolate:
// false`): a new process, jsdom and setup for every file cost more than most
// files' tests. This is what still gives each file the start a process of its
// own gives it:
//  - every module is evaluated again, so no module state and no `vi.mock`
//    stand-in carries over: the module reset Vitest itself makes before an
//    isolated file. Packages under node_modules load once per process.
//  - the clock is real, and every global and environment variable the process
//    started with is back to its starting value, however the last file changed
//    it. A global added since stays: packages that load once add theirs
//    (React's act flag, zod's registry), and `vi.stubGlobal` takes back the
//    ones a test adds through it.
//  - under jsdom: empty storage, no cookies, the starting address, no selection
//    and the starting document. Only the <style> elements packages add to
//    <head> as they load stay.
// test/isolation-probe.ts proves it.
import { vi } from "vitest";

interface ModuleNode {
  promise?: unknown;
  exports?: unknown;
  evaluated: boolean;
  importers: Set<string>;
}

interface StartState {
  globals: Map<string, { descriptor: PropertyDescriptor; value: unknown }>;
  env: Record<string, string | undefined>;
  url: string | null;
  rootAttributes: [string, string][];
}

/** The parts of jsdom's JSDOM, which Vitest's jsdom environment puts on the global. */
interface Jsdom {
  reconfigure(settings: { url: string }): void;
  cookieJar: { removeAllCookiesSync(): void };
}

const runtime = globalThis as typeof globalThis & {
  __vitest_worker__?: { evaluatedModules?: { idToModuleMap?: Map<string, ModuleNode> } };
  __vitest_mocker__?: { reset?(): void };
  jsdom?: Jsdom;
};

// Vitest's own modules, which its reset leaves alone too.
const VITEST_MODULES = [/\/vitest\/dist\//, /vitest-virtual-\w+\/dist/, /@vitest\/dist/];
// Vitest's own globals and variables, which it sets for each file (VITEST_WORKER_ID).
const VITEST_GLOBAL = /^__vitest/;
const VITEST_ENV = /^VITEST/;

const modules = runtime.__vitest_worker__?.evaluatedModules?.idToModuleMap;
if (!modules) throw new Error("test/clean-start.ts cannot find Vitest's module map, so files would share module state; update it for this Vitest version");
for (const [id, node] of modules) {
  if (VITEST_MODULES.some((pattern) => pattern.test(id))) continue;
  node.promise = undefined;
  node.exports = undefined;
  node.evaluated = false;
  node.importers.clear();
}
runtime.__vitest_mocker__?.reset?.();

vi.useRealTimers();
vi.unstubAllGlobals();
vi.unstubAllEnvs();

// Held on the global: this module is evaluated again for every file.
const START = Symbol.for("noticeos.tower.test-start-state");
const held = runtime as typeof runtime & { [START]?: StartState };
const start = held[START];
if (start === undefined) held[START] = recordStart();
else restoreStart(start);

function recordStart(): StartState {
  const globals: StartState["globals"] = new Map();
  for (const key of Object.getOwnPropertyNames(globalThis)) {
    if (VITEST_GLOBAL.test(key)) continue;
    // Read first: Node defines some globals lazily on first read.
    const value: unknown = Reflect.get(globalThis, key);
    globals.set(key, { descriptor: Object.getOwnPropertyDescriptor(globalThis, key)!, value });
  }
  return {
    globals,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !VITEST_ENV.test(key))),
    url: typeof document === "undefined" ? null : location.href,
    rootAttributes: typeof document === "undefined" ? [] : document.documentElement.getAttributeNames().map((name) => [name, document.documentElement.getAttribute(name)!]),
  };
}

function restoreStart(state: StartState): void {
  for (const [key, { descriptor, value }] of state.globals) {
    const now = Object.getOwnPropertyDescriptor(globalThis, key);
    if (now !== undefined && now.get === descriptor.get && now.set === descriptor.set && Object.is(now.value, descriptor.value)) {
      // jsdom's globals are accessors whose setter keeps what was assigned.
      if (descriptor.set && !Object.is(Reflect.get(globalThis, key), value)) Reflect.set(globalThis, key, value);
      continue;
    }
    if (now === undefined || now.configurable) Object.defineProperty(globalThis, key, descriptor);
    else if (now.writable) Reflect.set(globalThis, key, descriptor.value);
  }

  for (const key of Object.keys(process.env)) if (!VITEST_ENV.test(key) && !(key in state.env)) delete process.env[key];
  for (const [key, value] of Object.entries(state.env)) if (process.env[key] !== value) process.env[key] = value;

  if (typeof document === "undefined" || state.url === null) return;
  localStorage.clear();
  sessionStorage.clear();
  runtime.jsdom?.cookieJar.removeAllCookiesSync();
  runtime.jsdom?.reconfigure({ url: state.url });
  getSelection()?.removeAllRanges();
  const root = document.documentElement;
  for (const name of root.getAttributeNames()) root.removeAttribute(name);
  for (const [name, value] of state.rootAttributes) root.setAttribute(name, value);
  for (const child of [...document.head.children]) if (child.localName !== "style") child.remove();
  for (const name of document.body.getAttributeNames()) document.body.removeAttribute(name);
  document.body.replaceChildren();
  root.replaceChildren(document.head, document.body);
}
