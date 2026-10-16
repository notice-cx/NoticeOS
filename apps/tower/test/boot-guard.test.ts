import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// index.html's own guard: a page whose app drew nothing reloads by itself,
// less often each time; a page that drew is never reloaded. Run with its
// globals handed in, so each reload and wait can be seen.

const indexHtml = readFileSync(path.join(import.meta.dirname, "..", "index.html"), "utf8");
const script = new DOMParser().parseFromString(indexHtml, "text/html").querySelector("script[data-boot-guard]")!.textContent!;
const KEY = "noticeos:boot-reloads";
const MINUTE = 60_000;

function memoryStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

const refusedStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
  getItem: () => {
    throw new DOMException("denied", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("denied", "SecurityError");
  },
  removeItem: () => {
    throw new DOMException("denied", "SecurityError");
  },
};

/** Loads the page once: returns how long the guard waits, and runs its check
 * with the app having drawn or not. */
function load({ storage, now, drawn }: { storage: Pick<Storage, "getItem" | "setItem" | "removeItem">; now: number; drawn: boolean }) {
  let check: (() => void) | undefined;
  let wait: number | undefined;
  let reloads = 0;
  const page = { getElementById: (id: string) => (id === "root" ? { firstElementChild: drawn ? {} : null } : null) };
  const timer = (callback: () => void, ms: number) => {
    check = callback;
    wait = ms;
  };
  new Function("document", "sessionStorage", "location", "setTimeout", "Date", script)(
    page,
    storage,
    { reload: () => void (reloads += 1) },
    timer,
    { now: () => now + (wait ?? 0) },
  );
  check!();
  return { wait: wait!, reloaded: reloads === 1 };
}

describe("the boot guard index.html runs", () => {
  it("reloads a page whose app drew nothing 30 s after it loaded", () => {
    const storage = memoryStorage();
    expect(load({ storage, now: 0, drawn: false })).toEqual({ wait: 30_000, reloaded: true });
    expect(JSON.parse(storage.getItem(KEY)!)).toEqual({ at: 30_000, run: 1 });
  });

  it("waits 1, 2, 4 and 8 minutes for reloads in a row, then 10 at most", () => {
    const storage = memoryStorage();
    let now = 0;
    const waits: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const { wait } = load({ storage, now, drawn: false });
      waits.push(wait);
      now += wait + 5_000;
    }
    expect(waits).toEqual([30_000, MINUTE, 2 * MINUTE, 4 * MINUTE, 8 * MINUTE, 10 * MINUTE, 10 * MINUTE]);
  });

  it("starts the count over once 20 minutes have passed since the last reload", () => {
    const storage = memoryStorage();
    storage.setItem(KEY, JSON.stringify({ at: 0, run: 3 }));
    expect(load({ storage, now: 19 * MINUTE, drawn: false }).wait).toBe(4 * MINUTE);
    storage.setItem(KEY, JSON.stringify({ at: 0, run: 3 }));
    expect(load({ storage, now: 20 * MINUTE, drawn: false }).wait).toBe(30_000);
  });

  it("never reloads a page that drew, and clears the count", () => {
    const storage = memoryStorage();
    storage.setItem(KEY, JSON.stringify({ at: 0, run: 2 }));
    expect(load({ storage, now: 1_000, drawn: true })).toEqual({ wait: 2 * MINUTE, reloaded: false });
    expect(storage.getItem(KEY)).toBeNull();
  });

  it("waits the longest when the tab cannot store its count", () => {
    expect(load({ storage: refusedStorage, now: 0, drawn: false })).toEqual({ wait: 10 * MINUTE, reloaded: true });
  });
});
