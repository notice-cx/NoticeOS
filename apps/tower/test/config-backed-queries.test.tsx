import { QueryClient, QueryClientProvider, QueryObserver, type QueryFunctionContext } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "./render";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  affectedConfigBackedQueries,
  refreshConfigBackedQueries,
} from "@/hooks/config-backed-queries";
import type { ConfigWritability } from "@/lib/api";
import { useCollectionSave, useFieldCollectionSave } from "@/hooks/useCollectionSave";
import { useConfigSave, useFieldConfigSave, useInlineConfigSave, useStructuralSave, useLandmarkSave } from "@/hooks/useConfigSave";
import { typeScriptSources, withoutComments } from "./source-files";

import { TOWER_CONFIG_FILES } from "@noticeos/contract/configuration";
import type { ChangesetOp, FileOp } from "@shared/changeset";
import { patchAssetColumn, saveConfig } from "@/lib/api";
import { toast } from "sonner";

let client: QueryClient;

/** What this deployment's `GET /api/config` says. The store answer is the one
 * the wait has to disappear on; `FILE_BACKED` is a local dev server with no
 * store, which really does restart. */
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
  client.clear();
  vi.useRealTimers();
  vi.clearAllMocks();
});

/** The first segment of every key the hook invalidated, once it has. */
async function invalidatedKeys(calls: unknown[][]): Promise<string[]> {
  await waitFor(() => expect(calls.length).toBeGreaterThan(0));
  return calls.map((call) => String((call[0] as { queryKey?: unknown[] }).queryKey?.[0]));
}

describe("a config save refreshes only the changed document’s consumers", () => {
  it.each(["retired", "live"] as const)("refreshes archived work, history and activity immediately on status %s", async status => {
    const invalidated = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useConfigSave(), { wrapper });
    await result.current({ label: "Lifecycle stage", ops: [{ kind: "store-asset-set", asset: "example.com", column: "status", expect: status === "retired" ? "live" : "retired", value: status }] });
    const keys = await invalidatedKeys(invalidated.mock.calls);
    expect(keys).toEqual(expect.arrayContaining(["work", "alert-history", "wall-feed"]));
  });

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
      new Set(["financials"]),
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
      new Set(["financials"]),
    );
  });
});

describe("a save waits only for a restart that is actually going to happen", () => {
  it("is decided by where the config came from, not by the deployment", () => {
    // Unknown waits: a deployment that does not say may still be reading the
    // compiled copy, which changes only after a restart.
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
      new Set(["financials"]),
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
      new Set(["financials"]),
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
      new Set(["financials"]),
    );
  });
});

const costOp = {
  kind: "file-json-set", file: "config/recurring-costs.json",
  pointer: "/costs/0/amountUsdPerMonth", expect: 200, value: 250,
} satisfies FileOp;
const costChange = {
  kind: "add" as const,
  row: { id: "subscription", label: "Subscription", asset: "root-os", family: "inference", amountUsdPerMonth: 200, from: "2026-09" },
  count: 0,
};

const consumers = {
  "config/constants.json": ["wall", "asset-detail", "settings", "workflows", "financials", "integrations", "integration-providers", "work", "wall-feed"],
  "config/pull.json": ["wall", "asset-detail", "settings", "integrations"],
  "config/integrations.json": ["wall", "asset-detail", "settings", "integrations", "integration-providers"],
  "config/counters.json": ["wall", "asset-detail"],
  "config/tower.json": ["wall", "settings", "asset-detail"],
  "config/serp-panel.json": ["wall", "asset-detail", "integrations"],
  "config/signal-panels.json": ["asset-detail", "settings"],
  "config/value-events.json": ["asset-detail"],
  "config/ga4-custom-dimensions.json": ["asset-detail"],
  "config/domain-costs.json": ["financials"],
  "config/recurring-costs.json": ["financials"],
  "config/entities.json": ["settings"],
  "config/beads.json": ["settings", "task-source", "work"],
} satisfies Record<(typeof TOWER_CONFIG_FILES)[keyof typeof TOWER_CONFIG_FILES], string[]>;

describe("document consumers", () => {
  it.each(Object.entries(consumers))("%s refreshes its payload consumers for every file operation", (file, expected) => {
    for (const kind of ["file-json-set", "file-json-insert", "file-json-delete"] as const) {
      const ops = [{ kind, file, pointer: "/new-field", expect: 1, value: 2 }] as FileOp[];
      expect(new Set(affectedConfigBackedQueries(ops))).toEqual(new Set(expected));
    }
  });

  it("unions multi-document changes without duplicate reads", () => {
    expect(new Set(affectedConfigBackedQueries([
      costOp, { ...costOp, file: "config/domain-costs.json" },
      { ...costOp, file: "config/tower.json" },
    ]))).toEqual(new Set(["financials", "wall", "settings", "asset-detail"]));
  });

  it.each([
    undefined, [],
    [{ ...costOp, file: "config/future.json" }],
    [{ ...costOp, file: "toString" }],
    [{ ...costOp, kind: "future-write" }],
    [{ kind: "store-asset-set", asset: "example.test", column: "display_name", expect: "Before", value: "After" }],
    [costOp, { ...costOp, file: "config/future.json" }],
  ])("keeps broad invalidation for an unclassified write (%j)", (ops) => {
    expect(affectedConfigBackedQueries(ops as ChangesetOp[] | undefined)).toEqual(CONFIG_BACKED_QUERIES);
    const invalidated = vi.spyOn(client, "invalidateQueries");
    refreshConfigBackedQueries(client, 0, ops as ChangesetOp[] | undefined);
    expect(invalidated.mock.calls.map(([filter]) => filter?.queryKey?.[0])).toEqual(CONFIG_BACKED_QUERIES);
  });
});

function useSavePaths() {
  return {
    setting: useConfigSave(), field: useFieldConfigSave(), inline: useInlineConfigSave(),
    row: useCollectionSave(), rowField: useFieldCollectionSave(),
    structural: useStructuralSave(), landmark: useLandmarkSave(),
  };
}

function toastUndo(): () => Promise<void> {
  const calls = vi.mocked(toast.success).mock.calls;
  const action = calls[calls.length - 1]?.[1]?.action;
  if (!action || typeof action !== "object" || !("onClick" in action)) throw new Error("missing Undo");
  return async () => {
    action.onClick({} as React.MouseEvent<HTMLButtonElement>);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/^Reverted/)));
  };
}

async function savePath(paths: ReturnType<typeof useSavePaths>, path: keyof typeof paths) {
  const request = { ops: [costOp], label: "Subscription", slug: "subscription" };
  if (path === "field" || path === "rowField") {
    const saved = path === "field" ? await paths.field(request) : await paths.rowField({ register: configRegister("recurring-costs"), change: costChange, label: "Subscription" });
    if (!saved.saved) throw new Error(saved.refusal);
    return async () => { expect(await saved.undo()).toEqual({ undone: true }); };
  }
  if (path === "inline") {
    const saved = await paths.inline(request);
    if (!saved) throw new Error("save refused");
    return async () => { expect(await saved.undo()).toBe(true); };
  }
  if (path === "row") {
    expect(await paths.row({ register: configRegister("recurring-costs"), change: costChange, label: "Subscription" })).toBe(true);
  } else if (path === "structural") {
    expect(await paths.structural({ ...request, undo: [{ ...costOp, expect: 250, value: 200 }] })).toBe(true);
  } else if (path === "landmark") {
    expect(await paths.landmark({ op: { kind: "file-json-insert", file: "config/tower.json", pointer: "/countdown", value: { label: "Launch" } }, label: "Countdown", slug: "countdown" })).toBe(true);
  } else {
    expect(await paths.setting(request)).toBe(true);
  }
  return toastUndo();
}

const paths: (keyof ReturnType<typeof useSavePaths>)[] = ["setting", "field", "inline", "row", "rowField", "structural", "landmark"];
for (const source of ["store", "file"] as const) {
  describe(`${source}-backed saves and Undo`, () => {
    it.each(paths)("%s refreshes only its consumers at the required time", async (path) => {
      configAnswer = source === "store" ? STORE_BACKED : FILE_BACKED;
      const invalidated = vi.spyOn(client, "invalidateQueries");
      const { result } = renderHook(useSavePaths, { wrapper });
      await waitFor(() => expect(client.getQueryData(["config-writable"])).toBeDefined());
      let undo!: () => Promise<void>;
      await act(async () => { undo = await savePath(result.current, path); });
      const expected = path === "landmark" ? ["wall", "settings", "asset-detail"] : ["financials"];
      if (source === "file") {
        expect(invalidated).not.toHaveBeenCalled();
        act(() => vi.advanceTimersByTime(WORKER_RESTART_MS - 1));
        expect(invalidated).not.toHaveBeenCalled();
        act(() => vi.advanceTimersByTime(1));
      }
      expect(await invalidatedKeys(invalidated.mock.calls)).toEqual(expected);
      invalidated.mockClear();
      await act(async () => { await undo(); });
      if (source === "file") {
        expect(invalidated).not.toHaveBeenCalled();
        act(() => vi.advanceTimersByTime(WORKER_RESTART_MS));
      }
      expect(await invalidatedKeys(invalidated.mock.calls)).toEqual(expected);
      expect(saveConfig).toHaveBeenCalledTimes(2);
    });
  });
}

it("refreshes the union for structural saves and derives Undo from its own operations", async () => {
  configAnswer = STORE_BACKED;
  const invalidated = vi.spyOn(client, "invalidateQueries");
  const { result } = renderHook(() => useStructuralSave(), { wrapper });
  await waitFor(() => expect(client.getQueryData(["config-writable"])).toBeDefined());
  await result.current({ ops: [costOp, { ...costOp, file: "config/tower.json" }], undo: [{ ...costOp, file: "config/entities.json" }], label: "Change", slug: "change" });
  expect(new Set(await invalidatedKeys(invalidated.mock.calls))).toEqual(new Set(["financials", "wall", "settings", "asset-detail"]));
  invalidated.mockClear();
  await toastUndo()();
  expect(await invalidatedKeys(invalidated.mock.calls)).toEqual(["settings"]);
});

it.each(["setting", "row", "structural"] as const)("a refused %s save does not refresh", async (path) => {
  vi.mocked(saveConfig).mockRejectedValueOnce(new Error("Refused"));
  const invalidated = vi.spyOn(client, "invalidateQueries");
  const { result } = renderHook(useSavePaths, { wrapper });
  const request = { ops: [costOp], label: "Subscription", slug: "subscription" };
  const saved = path === "setting" ? await result.current.setting(request)
    : path === "row" ? await result.current.row({ register: configRegister("recurring-costs"), change: costChange, label: "Subscription" })
    : await result.current.structural({ ...request, undo: [costOp] });
  expect(saved).toBe(false);
  vi.advanceTimersByTime(WORKER_RESTART_MS);
  expect(invalidated).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalled();
});

it("keeps store columns immediate and lifecycle lists refreshed on save and Undo", async () => {
  const invalidated = vi.spyOn(client, "invalidateQueries");
  const { result } = renderHook(() => useConfigSave(), { wrapper });
  await result.current({ ops: [{ kind: "store-asset-set", asset: "example.test", column: "status", expect: "live", value: "retired" }], label: "Archive" });
  const expected = [...CONFIG_BACKED_QUERIES, "work", "alert-history", "wall-feed"];
  expect(new Set(await invalidatedKeys(invalidated.mock.calls))).toEqual(new Set(expected));
  invalidated.mockClear();
  await toastUndo()();
  expect(new Set(await invalidatedKeys(invalidated.mock.calls))).toEqual(new Set(expected));
  expect(patchAssetColumn).toHaveBeenCalledTimes(2);
});

it("reduces nine active refetches to two across both cached Financials periods", async () => {
  configAnswer = STORE_BACKED;
  const reads = vi.fn(async (_context: QueryFunctionContext) => ({}));
  // Two cached periods must both refresh, with seven unrelated active
  // families untouched.
  const keys = CONFIG_BACKED_QUERIES.slice(0, 8).map(key => [key, "2026-08"]);
  keys.push(["financials", "2026-09"]);
  const observers = keys.map(queryKey => new QueryObserver(client, { queryKey, queryFn: reads, initialData: {}, staleTime: Infinity }));
  const unsubscribe = observers.map(observer => observer.subscribe(() => {}));
  try {
    // Measure broad and scoped refreshes against the same active cache.
    for (const key of CONFIG_BACKED_QUERIES.slice(0, 8)) {
      await client.invalidateQueries({ queryKey: [key] });
    }
    expect(reads).toHaveBeenCalledTimes(9);
    reads.mockClear();
    const { result } = renderHook(() => useConfigSave(), { wrapper });
    await waitFor(() => expect(client.getQueryData(["config-writable"])).toBeDefined());
    await result.current({ ops: [costOp], label: "Subscription" });
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(2));
    expect(reads.mock.calls.map(([context]) => context.queryKey)).toEqual([["financials", "2026-08"], ["financials", "2026-09"]]);
    await toastUndo()();
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(4));
  } finally {
    unsubscribe.forEach(stop => stop());
  }
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
