// The proof that every test file starts clean in a reused process (the reset
// is test/clean-start.ts).
//
// isolation-probe-a.test.ts and isolation-probe-b.test.ts are this one file
// under two names, each with its own `vi.mock` stand-in for
// isolation-probe-mocked.ts. Each first checks that it starts clean: module
// state evaluated anew and seeing its own stand-in, a real clock, the
// starting globals and environment, and jsdom's empty storage, starting
// address and empty document. Then it leaves all of those dirty behind it,
// with a fake clock still installed and a dead fake clock's setTimeout on the
// global. Whichever of the two runs second in a process checks what the first
// left, so either order proves it. In the full suite they share a process
// only by chance; `vitest run test/isolation-probe --maxWorkers=1` always
// puts them in one.
import { expect, it, vi } from "vitest";
import { marks, stoodIn } from "./isolation-probe-reader";

type Probe = "a" | "b";

const JSDOM_START = "http://localhost:3000/";
const JSDOM_WIDTH = 1024;

export function isolationProbe(probe: Probe): void {
  it("starts with nothing the file before it left", async () => {
    expect(marks).toEqual([]);
    expect(stoodIn()).toBe(`probe ${probe}'s stand-in`);

    expect(vi.isFakeTimers()).toBe(false);
    expect(Date.now()).toBeGreaterThan(Date.UTC(2020, 0, 1));
    await new Promise((resolve) => setTimeout(resolve, 1));

    expect(window.innerWidth).toBe(JSDOM_WIDTH);
    expect("isolationProbe" in fetch).toBe(false);
    expect("IsolationProbeStub" in globalThis).toBe(false);
    expect(process.env.ISOLATION_PROBE).toBeUndefined();
    expect(process.env.ISOLATION_PROBE_STUB).toBeUndefined();

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
    expect(location.href).toBe(JSDOM_START);
    expect(document.title).toBe("");
    expect(document.documentElement.getAttributeNames()).toEqual([]);
    expect(document.head.querySelectorAll(":not(style)")).toHaveLength(0);
    expect(document.body.getAttributeNames()).toEqual([]);
    expect(document.body.childNodes).toHaveLength(0);
  });

  it("leaves module state, globals, the clock and the document dirty", () => {
    marks.push(probe);

    globalThis.fetch = Object.assign(() => Promise.reject(new Error("left by the isolation probe")), { isolationProbe: probe }) as unknown as typeof fetch;
    Object.defineProperty(window, "innerWidth", { value: 1, configurable: true });
    vi.stubGlobal("IsolationProbeStub", probe);
    process.env.ISOLATION_PROBE = probe;
    vi.stubEnv("ISOLATION_PROBE_STUB", probe);

    localStorage.setItem("isolation-probe", probe);
    sessionStorage.setItem("isolation-probe", probe);
    document.cookie = `isolation-probe=${probe}`;
    history.pushState(null, "", `/isolation-probe-${probe}`);
    document.title = `isolation probe ${probe}`;
    document.documentElement.classList.add("dark");
    document.body.setAttribute("data-probe", probe);
    document.body.append(document.createElement("dialog"));
    document.head.append(document.createElement("meta"));

    // A spy on a faked setTimeout, restored after the clock is gone, leaves
    // that dead clock's setTimeout on the global; then a live fake clock.
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, "setTimeout");
    vi.useRealTimers();
    spy.mockRestore();
    vi.useFakeTimers({ now: 0, toFake: ["Date"] });

    expect(localStorage.getItem("isolation-probe")).toBe(probe);
    expect(location.pathname).toBe(`/isolation-probe-${probe}`);
    expect(Date.now()).toBe(0);
  });
}
