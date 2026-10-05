import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "./render";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// WHICH READS A CONFIG SAVE INVALIDATES, asserted once for both write paths
// (bead `ro-ina0`).
//
// `useConfigSave` writes a SETTING and `useCollectionSave` writes a ROW, onto
// the same files, so they refresh the same pages. They kept two copies of the
// list and the copies drifted — the setting path's was short by `financials`,
// so saving a cost left the ledger page showing the figure it had just been
// told to change, and nobody was looking at the page that went stale.
//
// Two guards, and they are not the same guard. The first is BEHAVIOUR: each
// hook actually invalidates every key in the declaration. The second is
// STRUCTURE: neither hook may grow a list of its own again, which is the
// failure mode that produced this bead and which a behaviour test alone cannot
// see — a second copy that happens to agree today passes every assertion.

// AND HOW LONG IT WAITS FIRST (bead `ro-ssgu`). Both paths used to wait out a
// Vite restart unconditionally, because before D22 every save rewrote a file
// and every rewrite restarted the local Worker. A store-backed save changes no
// file and restarts nothing, so the wait was a second and a half of stale
// figures on screen for nothing. `GET /api/config` already says which happened,
// per file, and the two cases are asserted below.

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  saveConfig: vi.fn(async () => {}),
  patchAssetColumn: vi.fn(async () => {}),
  fetchConfigWritable: vi.fn(async () => configAnswer),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import { configRegister } from "@shared/config-registers";
import {
  CONFIG_BACKED_QUERIES,
  WORKER_RESTART_MS,
  configSaveDelayMs,
} from "@/hooks/config-backed-queries";
import type { ConfigWritability } from "@/lib/api";
import { useCollectionSave } from "@/hooks/useCollectionSave";
import { useConfigSave } from "@/hooks/useConfigSave";

let client: QueryClient;

/** What this deployment's `GET /api/config` says. The store answer is the one
 * the wait has to disappear on; `FILE_BACKED` is the local dev server, which
 * really does restart. */
let configAnswer: ConfigWritability;

const FILE_BACKED: ConfigWritability = {
  writable: true,
  reason: null,
  sources: { "config/constants.json": "file", "config/recurring-costs.json": "file" },
};

const STORE_BACKED: ConfigWritability = {
  writable: true,
  reason: null,
  sources: { "config/constants.json": "store", "config/recurring-costs.json": "store" },
};

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = new QueryClient();
  configAnswer = FILE_BACKED;
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

/** The first segment of every key the hook invalidated, once it has. */
async function invalidatedKeys(calls: unknown[][]): Promise<string[]> {
  await waitFor(() => expect(calls.length).toBeGreaterThan(0));
  return calls.map((call) => String((call[0] as { queryKey?: unknown[] }).queryKey?.[0]));
}

describe("a config save refreshes every page built from a config file", () => {
  it("from the SETTING path", async () => {
    const invalidated = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useConfigSave(), { wrapper });

    await result.current({
      ops: [
        {
          kind: "file-json-set",
          file: "config/recurring-costs.json",
          pointer: "/costs/0/usdPerMonth",
          value: 250,
          expect: 200,
        },
      ],
      label: "Claude Code",
    });
    vi.advanceTimersByTime(WORKER_RESTART_MS);

    expect(new Set(await invalidatedKeys(invalidated.mock.calls))).toEqual(
      new Set(CONFIG_BACKED_QUERIES),
    );
  });

  it("from the ROW path", async () => {
    const invalidated = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useCollectionSave(), { wrapper });

    await result.current({
      register: configRegister("recurring-costs"),
      change: {
        kind: "add",
        row: {
          id: "claude-code",
          label: "Claude Code",
          asset: "root-os",
          family: "inference",
          amountUsdPerMonth: 200,
          from: "2026-09",
        },
        count: 0,
      },
      label: "Claude Code",
    });
    vi.advanceTimersByTime(WORKER_RESTART_MS);

    expect(new Set(await invalidatedKeys(invalidated.mock.calls))).toEqual(
      new Set(CONFIG_BACKED_QUERIES),
    );
  });
});

describe("a save waits only for a restart that is actually going to happen", () => {
  it("is decided by where the config came from, not by the deployment", () => {
    // The pure rule, stated where both hooks read it. Unknown waits: the local
    // dev lane answers this route itself and reports no sources at all, and it
    // is the one deployment that really restarts.
    expect(configSaveDelayMs(STORE_BACKED.sources)).toBe(0);
    expect(configSaveDelayMs(FILE_BACKED.sources)).toBe(WORKER_RESTART_MS);
    expect(configSaveDelayMs({})).toBe(WORKER_RESTART_MS);
    expect(configSaveDelayMs(undefined)).toBe(WORKER_RESTART_MS);
    // One file still compiled in is one file whose rewrite restarts Vite.
    expect(
      configSaveDelayMs({ "config/counters.json": "store", "config/tower.json": "file" }),
    ).toBe(WORKER_RESTART_MS);
  });

  it("refreshes immediately when the write went to the store", async () => {
    configAnswer = STORE_BACKED;
    const invalidated = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(
      () => ({ save: useConfigSave(), row: useCollectionSave() }),
      { wrapper },
    );
    // The deployment's answer has to have arrived before a save can key on it.
    await waitFor(() => expect(client.getQueryData(["config-writable"])).toBeDefined());

    await result.current.save({
      ops: [
        {
          kind: "file-json-set",
          file: "config/recurring-costs.json",
          pointer: "/costs/0/usdPerMonth",
          value: 250,
          expect: 200,
        },
      ],
      label: "Claude Code",
    });

    // No timer advanced, and the pages have already been told to refetch.
    expect(new Set(await invalidatedKeys(invalidated.mock.calls))).toEqual(
      new Set(CONFIG_BACKED_QUERIES),
    );
  });

  it("still waits the restart out when a file was rewritten", async () => {
    const invalidated = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useConfigSave(), { wrapper });
    await waitFor(() => expect(client.getQueryData(["config-writable"])).toBeDefined());

    await result.current({
      ops: [
        {
          kind: "file-json-set",
          file: "config/recurring-costs.json",
          pointer: "/costs/0/usdPerMonth",
          value: 250,
          expect: 200,
        },
      ],
      label: "Claude Code",
    });

    expect(invalidated.mock.calls).toEqual([]);
    vi.advanceTimersByTime(WORKER_RESTART_MS);
    expect(new Set(await invalidatedKeys(invalidated.mock.calls))).toEqual(
      new Set(CONFIG_BACKED_QUERIES),
    );
  });

  it("refreshes the ROW path immediately too", async () => {
    configAnswer = STORE_BACKED;
    const invalidated = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useCollectionSave(), { wrapper });
    await waitFor(() => expect(client.getQueryData(["config-writable"])).toBeDefined());

    await result.current({
      register: configRegister("recurring-costs"),
      change: {
        kind: "add",
        row: {
          id: "claude-code",
          label: "Claude Code",
          asset: "root-os",
          family: "inference",
          amountUsdPerMonth: 200,
          from: "2026-09",
        },
        count: 0,
      },
      label: "Claude Code",
    });

    expect(new Set(await invalidatedKeys(invalidated.mock.calls))).toEqual(
      new Set(CONFIG_BACKED_QUERIES),
    );
  });
});

// --- the structural half ----------------------------------------------------

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const HOOKS = path.join(SRC, "hooks");

/** Comments say the same words as code and are not the thing under guard. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Every `.ts`/`.tsx` under a directory, absolute. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe("neither write path may keep a list of its own", () => {
  for (const hook of ["useConfigSave.ts", "useCollectionSave.ts"]) {
    it(`${hook} reads the shared declaration`, () => {
      const source = withoutComments(
        readFileSync(path.join(HOOKS, hook), "utf8"),
      );

      // It imports the declaration…
      expect(source).toMatch(
        /import\s*\{[^}]*\}\s*from\s*"@\/hooks\/config-backed-queries"/,
      );
      // …and declares neither the list nor the restart wait itself. A local
      // `const` here is exactly how the two lists came to exist.
      expect(source).not.toMatch(/const\s+CONFIG_BACKED_QUERIES/);
      expect(source).not.toMatch(/const\s+WORKER_RESTART_MS/);
      // No hand-rolled walk of query keys either: the invalidation itself has
      // one implementation, so a hook cannot quietly skip a key it imported.
      expect(source).not.toMatch(/invalidateQueries\(\{\s*queryKey:\s*\[\s*key/);
    });
  }

  it("holds the list nowhere else in src/", () => {
    // A THIRD copy under another file name is the same bug wearing a disguise,
    // so the guard is on the SHAPE — an array literal naming two or more of
    // these keys — rather than on the two hooks by name.
    const offenders = sourceFiles(SRC).filter((file) => {
      if (file.endsWith(`hooks${path.sep}config-backed-queries.ts`)) return false;
      let source = withoutComments(readFileSync(file, "utf8"));
      if (file.endsWith(`asset-detail${path.sep}AssetTabs.tsx`)) {
        // This one declaration is route navigation, not cache invalidation.
        // Keep scanning the rest of the file for duplicate query inventories.
        source = source.replace(/export const ASSET_TABS = \[[\s\S]*?\] as const;/, "");
      }
      return [...source.matchAll(/\[[^[\]]*\]/g)].some(
        (literal) =>
          CONFIG_BACKED_QUERIES.filter((key) => literal[0].includes(`"${key}"`))
            .length > 1,
      );
    });

    expect(offenders.map((file) => path.relative(SRC, file))).toEqual([]);
  });

  it("names only keys a read actually uses", () => {
    // A key nothing reads is documentation of a route that no longer exists,
    // and it hides the one that IS missing. Matched against the hooks' own
    // sources rather than against the key expression, because one of them
    // (`INTEGRATION_PROVIDERS_KEY`) is a named constant its writers share.
    const reads = sourceFiles(HOOKS)
      .filter((file) => !file.endsWith("config-backed-queries.ts"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");

    for (const key of CONFIG_BACKED_QUERIES) {
      expect(reads, `no hook reads a "${key}" query`).toContain(`"${key}"`);
    }
    expect(new Set(CONFIG_BACKED_QUERIES).size).toBe(CONFIG_BACKED_QUERIES.length);
  });
});
