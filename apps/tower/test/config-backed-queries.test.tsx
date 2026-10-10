import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "./render";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Which reads a config save invalidates, asserted once for both write paths:
// `useConfigSave` writes a setting and `useCollectionSave` writes a row, onto
// the same files, so they refresh the same pages. Two guards: behaviour (each
// hook invalidates every key in the declaration) and structure (neither hook
// may grow a list of its own, which a behaviour test alone cannot see).

// And how long it waits first. A store-backed save changes no file and
// restarts nothing, so there is no Vite restart to wait out; `GET /api/config`
// says which happened, per file.

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
import { typeScriptSources, withoutComments } from "./source-files";

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
    // Unknown waits: the local dev lane answers this route itself and reports
    // no sources at all, and it is the one deployment that really restarts.
    expect(configSaveDelayMs(STORE_BACKED.sources)).toBe(0);
    expect(configSaveDelayMs(FILE_BACKED.sources)).toBe(WORKER_RESTART_MS);
    expect(configSaveDelayMs({})).toBe(WORKER_RESTART_MS);
    expect(configSaveDelayMs(undefined)).toBe(WORKER_RESTART_MS);
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

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const HOOKS = path.join(SRC, "hooks");

describe("neither write path may keep a list of its own", () => {
  for (const hook of ["useConfigSave.ts", "useCollectionSave.ts"]) {
    it(`${hook} reads the shared declaration`, () => {
      const source = withoutComments(
        readFileSync(path.join(HOOKS, hook), "utf8"),
      );

      expect(source).toMatch(
        /import\s*\{[^}]*\}\s*from\s*"@\/hooks\/config-backed-queries"/,
      );
      // Neither the list nor the restart wait is declared locally: a local
      // `const` here is exactly how two lists come to exist.
      expect(source).not.toMatch(/const\s+CONFIG_BACKED_QUERIES/);
      expect(source).not.toMatch(/const\s+WORKER_RESTART_MS/);
      // No hand-rolled walk of query keys either: the invalidation has one
      // implementation, so a hook cannot quietly skip a key it imported.
      expect(source).not.toMatch(/invalidateQueries\(\{\s*queryKey:\s*\[\s*key/);
    });
  }

  it("holds the list nowhere else in src/", () => {
    // A third copy under another file name is the same bug, so the guard is
    // on the shape (an array literal naming two or more of these keys).
    const offenders = typeScriptSources(SRC).filter((file) => {
      if (file.endsWith(`hooks${path.sep}config-backed-queries.ts`)) return false;
      let source = withoutComments(readFileSync(file, "utf8"));
      if (file.endsWith(`asset-detail${path.sep}AssetTabs.tsx`)) {
        // This one declaration is route navigation, not cache invalidation.
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
    // A key nothing reads hides the one that is missing. Matched against the
    // hooks' own sources rather than the key expression, because one of them
    // (`INTEGRATION_PROVIDERS_KEY`) is a named constant its writers share.
    const reads = typeScriptSources(HOOKS)
      .filter((file) => !file.endsWith("config-backed-queries.ts"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");

    for (const key of CONFIG_BACKED_QUERIES) {
      expect(reads, `no hook reads a "${key}" query`).toContain(`"${key}"`);
    }
    expect(new Set(CONFIG_BACKED_QUERIES).size).toBe(CONFIG_BACKED_QUERIES.length);
  });
});
