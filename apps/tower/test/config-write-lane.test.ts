// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_REPO_ROOT,
  crossOrigin,
  handleConfigRequest,
} from "../vite/config-write-lane";
import { laneRepoRoot } from "../vite/lane";
import { parseDashboardConfig } from "../shared/dashboard";
import { DEFAULT_WALL_LAYOUT } from "../shared/wall-layout";

// The Tower's ONE direct write to the repo (D18, bead ro-pbzu.5). It runs in the
// dev server's Node process, it edits files an operator committed, and it makes
// commits — so what is asserted here is every way it can refuse, and the exact
// state of a temp repo after it accepts.
//
// The last case is the one that matters most: it runs BOTH entry points — this
// lane and `pnpm config:apply` — over identical throwaway repos and compares
// what each left behind. They share scripts/config-apply-core.mjs, and this is
// what keeps that true rather than merely intended.

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const CLI = path.join(REPO_ROOT, "scripts/config-apply.mjs");
/** The ceiling for a test that runs both entry points: two throwaway checkouts
 * and a cold Node start of the CLI, about twenty child processes. That is 0.3 s
 * on an idle Mac and went past Vitest's 5 s default on a loaded one (bead
 * ro-ujb9.234), so the ceiling is sized to the work, not to the default. */
const CLI_COMPARISON_MS = 60_000;
/** Where a document's file lives in a checkout: this installation's own
 * folder, never the product default in config/ (bead ro-ujb9.125). */
const installed = (rel: string) => rel.replace(/^config\//, "installation/");

// `inference_usd` is deliberately still here though the real file dropped it
// (D6, bead `ro-uj7x`): a store or checkout seeded before 2026-09-05 carries the
// retired key, and the lane must edit such a document without tripping over it.
const CONSTANTS = {
  monthly_caps: { data_usd: 25, inference_usd: 10 },
  flag_defaults: { alpha: 0.01, min_baseline_per_day: 3 },
};

const created: string[] = [];

afterAll(async () => {
  await Promise.all(created.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

/** A throwaway checkout with one editable config file, already committed —
 * the shape of the repo this lane actually edits. */
async function tempRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "config-lane-"));
  created.push(root);
  await fs.mkdir(path.join(root, "installation"), { recursive: true });
  await fs.writeFile(
    path.join(root, installed("config/constants.json")),
    JSON.stringify(CONSTANTS, null, 2) + "\n",
    "utf8",
  );
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "lane@test.local");
  git(root, "config", "user.name", "Lane Test");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "seed");
  return root;
}

/** The three per-asset registers, in the shapes the real files have. */
const REGISTERS = {
  integrations: {
    version: 1,
    catalog: [{ id: "gsc", label: "Google Search Console" }],
    assets: { "meals.example": { gsc: { status: "live" } } },
  },
  counters: { assets: { "meals.example": { cards: [] } } },
  pull: [
    { asset: "meals.example", url: "https://meals.example/m", enabled: true },
    { asset: "nosh.example", url: "https://nosh.example/o", enabled: true },
  ],
  // The two panel registers (bead ro-sk7q). Both carry file-level metadata
  // beside their `/assets` map — the roster's `refresh` block is what a pass
  // costs — which is what the one-container rule keeps an asset write away from.
  signalPanels: {
    version: 1,
    refresh: { windowDays: 35, freshnessMaxAgeDays: 7, providerCostUsdPerPass: 0 },
    assets: {
      "meals.example": {
        enabled: true,
        reason: "live-lanes",
        note: "GSC + GA4 live.",
        since: "2026-08-03",
      },
    },
  },
  serpPanel: { assets: { "meals.example": { queries: ["meals", "meals calculator"] } } },
  // The portfolio's legal entities (bead ro-aodz). An asset's membership is a
  // STRING ON ANOTHER ROW, so a delete reaches it with a guarded set rather than
  // by removing anything — the entity outlives the assets it owns (ro-xzxg).
  entities: {
    version: 1,
    entities: [
      { slug: "first-co", name: "First Co" },
      {
        slug: "reindex-ventures",
        name: "Reindex Ventures LLC",
        assets: ["meals.example", "fees.example"],
      },
    ],
  },
} as const;

/** A throwaway checkout carrying the registers an asset is added to. */
async function tempRepoWithRegisters(): Promise<string> {
  const root = await tempRepo();
  for (const [rel, doc] of [
    ["config/integrations.json", REGISTERS.integrations],
    ["config/counters.json", REGISTERS.counters],
    ["config/pull.json", REGISTERS.pull],
    ["config/signal-panels.json", REGISTERS.signalPanels],
    ["config/serp-panel.json", REGISTERS.serpPanel],
    ["config/entities.json", REGISTERS.entities],
  ] as const) {
    await fs.writeFile(
      path.join(root, installed(rel)),
      JSON.stringify(doc, null, 2) + "\n",
      "utf8",
    );
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "registers");
  return root;
}

const SAME_ORIGIN = {
  host: "office-mac.local:5173",
  origin: "http://office-mac.local:5173",
  "content-type": "application/json",
  "sec-fetch-site": "same-origin",
};

function put(body: unknown, headers: Record<string, string> = SAME_ORIGIN) {
  return { method: "PUT", headers, body: JSON.stringify(body) };
}

const alphaOp = (expect_: unknown, value: unknown) => ({
  kind: "file-json-set",
  file: "config/constants.json",
  pointer: "/flag_defaults/alpha",
  expect: expect_,
  value,
});

async function readJson(root: string, rel: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(path.join(root, installed(rel)), "utf8"));
}

describe("the config write lane", () => {
  // Vite bundles the config file and everything it imports before executing it,
  // so where this module thinks it lives is the bundler's business. A root off
  // by one directory would mean a Save writing into `apps/`, or writing nothing
  // — so the default is walked to the workspace manifest, and pinned here.
  it("edits the checkout it is serving, not wherever the bundler put it", () => {
    expect(DEFAULT_REPO_ROOT).toBe(REPO_ROOT);
  });

  // The managed service runs this dev server from a runtime copy of the code
  // (bead ro-ujb9.113) and names the operator's checkout in NOTICEOS_HOME (a
  // plist installed before the rename says REINDEX_OS_HOME, still read). A
  // Save must still commit THERE — a commit inside the runtime copy would never
  // reach main, and would dirty the copy the next deploy has to move.
  it("commits in the home checkout the runner names, not in the runtime copy", () => {
    const runtimeCopy = path.join(REPO_ROOT, ".local", "runtime", "runtime-a", "apps", "tower", "vite");
    expect(laneRepoRoot({ NOTICEOS_HOME: "/Users/operator/reindex-os" }, runtimeCopy)).toBe(
      "/Users/operator/reindex-os",
    );
    // The installed plist's legacy name, and the new name winning over it.
    expect(laneRepoRoot({ REINDEX_OS_HOME: "/Users/operator/reindex-os" }, runtimeCopy)).toBe(
      "/Users/operator/reindex-os",
    );
    expect(laneRepoRoot({ NOTICEOS_HOME: "/srv/notice", REINDEX_OS_HOME: "/Users/operator/reindex-os" }, runtimeCopy)).toBe(
      "/srv/notice",
    );
    expect(laneRepoRoot({ REINDEX_OS_HOME: "  " }, path.join(REPO_ROOT, "apps", "tower", "vite"))).toBe(REPO_ROOT);
    expect(laneRepoRoot({}, path.join(REPO_ROOT, "apps", "tower", "vite"))).toBe(REPO_ROOT);
  });

  it("answers that this deployment can write", async () => {
    const reply = await handleConfigRequest({ method: "GET", headers: {}, body: "" });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ writable: true });
  });

  // There is no authentication on the Tower and there must not be (docs/10), so
  // same-origin IS the boundary: what it stops is a page on another site
  // steering the operator's own browser into a config write.
  it("refuses a write whose origin is not this server", async () => {
    const root = await tempRepo();
    const reply = await handleConfigRequest(
      put({ ops: [alphaOp(0.01, 0.05)] }, { ...SAME_ORIGIN, origin: "https://evil.test" }),
      { repoRoot: root },
    );
    expect(reply.status).toBe(403);
    expect(reply.body).toEqual({ error: "forbidden" });
    expect(await readJson(root, "config/constants.json")).toEqual(CONSTANTS);
  });

  it("reads an absent Origin as a same-origin call, and an unparseable one as foreign", () => {
    expect(crossOrigin({ host: "office-mac.local:5173" })).toBe(false);
    expect(crossOrigin({ host: "office-mac.local:5173", origin: "http://office-mac.local:5173" })).toBe(false);
    expect(crossOrigin({ host: "office-mac.local:5173", referer: "http://office-mac.local:5173/settings" })).toBe(false);
    expect(crossOrigin({ host: "office-mac.local:5173", origin: "not a url" })).toBe(true);
    expect(crossOrigin({ host: "office-mac.local:5173", "sec-fetch-site": "cross-site" })).toBe(true);
  });

  it("takes JSON and PUT, and nothing else", async () => {
    const form = await handleConfigRequest(
      put({ ops: [] }, { ...SAME_ORIGIN, "content-type": "application/x-www-form-urlencoded" }),
    );
    expect(form.status).toBe(415);
    const deleted = await handleConfigRequest({ method: "DELETE", headers: SAME_ORIGIN, body: "" });
    expect(deleted.status).toBe(405);
    const garbage = await handleConfigRequest({ method: "PUT", headers: SAME_ORIGIN, body: "{" });
    expect(garbage.status).toBe(400);
  });

  // The allowlist is the reason a same-origin write is safe to accept at all:
  // four named files, named pointers, and nothing else is reachable.
  it("refuses a file outside the allowlist, and writes nothing", async () => {
    const root = await tempRepo();
    const reply = await handleConfigRequest(
      put({
        ops: [
          {
            kind: "file-json-set",
            file: "config/domain-costs.json",
            pointer: "/version",
            expect: 1,
            value: 2,
          },
        ],
      }),
      { repoRoot: root },
    );
    expect(reply.status).toBe(422);
    expect(reply.body.error).toBe("invalid_changeset");
    expect(String(reply.body.detail)).toContain("not editable");
    expect(git(root, "log", "--oneline").split("\n")).toHaveLength(1);
  });

  // A DECLARED KNOB is the narrowest permission the lane has (bead
  // `ro-x5gu.8`): one exact scalar pointer in a file that is otherwise
  // unreachable. The pair below is the whole rule — the pointer writes and
  // commits like any other setting; the block above it and the cards beside it
  // are refused, naming the pointers that would have worked.
  it("writes a declared knob, and refuses everything else in the same file", async () => {
    const root = await tempRepoWithRegisters();

    const saved = await handleConfigRequest(
      put({
        ops: [
          {
            kind: "file-json-set",
            file: "config/signal-panels.json",
            pointer: "/refresh/windowDays",
            expect: 35,
            value: 30,
          },
        ],
      }),
      { repoRoot: root },
    );
    expect(saved.status).toBe(200);
    expect(await readJson(root, "config/signal-panels.json")).toEqual({
      ...REGISTERS.signalPanels,
      refresh: { ...REGISTERS.signalPanels.refresh, windowDays: 30 },
    });

    // One level up, and an undeclared number beside it: both refused, and the
    // refusal names the knobs rather than the wholesale allowlist the writer
    // never wanted.
    for (const pointer of ["/refresh", "/refresh/providerCostUsdPerPass"]) {
      const refused = await handleConfigRequest(
        put({
          ops: [
            { kind: "file-json-set", file: "config/signal-panels.json", pointer, expect: null, value: 1 },
          ],
        }),
        { repoRoot: root },
      );
      expect(refused.status, pointer).toBe(422);
      expect(String(refused.body.detail)).toContain("/refresh/windowDays");
    }

    // A value the knob's own rule refuses never reaches the file either.
    const tooSmall = await handleConfigRequest(
      put({
        ops: [
          {
            kind: "file-json-set",
            file: "config/signal-panels.json",
            pointer: "/refresh/windowDays",
            expect: 30,
            value: 0,
          },
        ],
      }),
      { repoRoot: root },
    );
    expect(tooSmall.status).toBe(422);
    expect(String(tooSmall.body.detail)).toContain("/refresh/windowDays — Panel history window must be at least 1");
  });

  it("sends a store column to the route that owns it, rather than half-applying a mixed set", async () => {
    const root = await tempRepo();
    const reply = await handleConfigRequest(
      put({
        ops: [
          alphaOp(0.01, 0.05),
          { kind: "store-asset-set", asset: "nosh.example", column: "status", expect: "live", value: "retired" },
        ],
      }),
      { repoRoot: root },
    );
    expect(reply.status).toBe(422);
    expect(reply.body.error).toBe("store_op_not_accepted");
    expect(String(reply.body.detail)).toContain("PATCH /api/assets/:id");
    expect(await readJson(root, "config/constants.json")).toEqual(CONSTANTS);
  });

  // One stale op refuses the whole set. A settings page left open while the file
  // moved must not win, and it must not half-win either.
  it("refuses the whole changeset on a stale expect, and leaves the file untouched", async () => {
    const root = await tempRepo();
    const reply = await handleConfigRequest(
      put({ ops: [alphaOp(0.01, 0.05), alphaOp(999, 1)] }),
      { repoRoot: root },
    );
    expect(reply.status).toBe(409);
    expect(reply.body.error).toBe("expect_mismatch");
    expect(reply.body.mismatches).toEqual([
      {
        file: "config/constants.json",
        pointer: "/flag_defaults/alpha",
        expect: 999,
        current: 0.01,
        absent: false,
      },
    ]);
    expect(await readJson(root, "config/constants.json")).toEqual(CONSTANTS);
    await expect(fs.readdir(path.join(root, "installation/changesets"))).rejects.toThrow();
    expect(git(root, "log", "--oneline").split("\n")).toHaveLength(1);
  });

  it("says an absent pointer is absent rather than reporting it as null", async () => {
    const root = await tempRepo();
    const reply = await handleConfigRequest(
      put({
        ops: [
          {
            kind: "file-json-set",
            file: "config/constants.json",
            pointer: "/flag_defaults/nope",
            expect: 1,
            value: 2,
          },
        ],
      }),
      { repoRoot: root },
    );
    expect(reply.status).toBe(409);
    expect(reply.body.mismatches).toEqual([
      {
        file: "config/constants.json",
        pointer: "/flag_defaults/nope",
        expect: 1,
        current: null,
        absent: true,
      },
    ]);
  });

  it("applies, archives and commits — the three things the terminal step used to do", async () => {
    const root = await tempRepo();
    const logged: string[] = [];
    const reply = await handleConfigRequest(put({ ops: [alphaOp(0.01, 0.05)], slug: "anomaly-sensitivity" }), {
      repoRoot: root,
      log: (line) => logged.push(line),
      now: () => new Date("2026-09-04T12:00:00.000Z"),
    });

    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      applied: 1,
      archive: "installation/changesets/0001_anomaly-sensitivity.json",
    });
    expect(typeof reply.body.commit).toBe("string");

    // the file
    expect(await readJson(root, "config/constants.json")).toEqual({
      ...CONSTANTS,
      flag_defaults: { ...CONSTANTS.flag_defaults, alpha: 0.05 },
    });
    // the archive — the audit artifact, byte-shaped like the CLI's
    expect(await readJson(root, "installation/changesets/0001_anomaly-sensitivity.json")).toEqual({
      version: 1,
      createdAt: "2026-09-04T12:00:00.000Z",
      slug: "anomaly-sensitivity",
      ops: [alphaOp(0.01, 0.05)],
    });
    // the commit, carrying both, and NOTHING else
    expect(git(root, "log", "--oneline").split("\n")).toHaveLength(2);
    expect(git(root, "log", "-1", "--pretty=%s")).toBe("config: anomaly-sensitivity via Tower");
    expect(git(root, "show", "--name-only", "--pretty=", "HEAD").split("\n").sort()).toEqual([
      "installation/changesets/0001_anomaly-sensitivity.json",
      "installation/constants.json",
    ]);
    expect(git(root, "status", "--porcelain")).toBe("");
    expect(logged).toHaveLength(1);
  });

  // An operator's checkout usually has other work in it. A settings Save must
  // commit its own two files and leave that work exactly where it was.
  it("commits only its own files, even with unrelated work staged beside them", async () => {
    const root = await tempRepo();
    await fs.writeFile(path.join(root, "notes.md"), "half-written\n", "utf8");
    git(root, "add", "notes.md");

    await handleConfigRequest(put({ ops: [alphaOp(0.01, 0.07)], slug: "sensitivity" }), {
      repoRoot: root,
    });

    expect(git(root, "show", "--name-only", "--pretty=", "HEAD")).not.toContain("notes.md");
    expect(git(root, "status", "--porcelain")).toContain("notes.md");
  });

  it("never pushes", async () => {
    const root = await tempRepo();
    const commands: string[][] = [];
    await handleConfigRequest(put({ ops: [alphaOp(0.01, 0.09)], slug: "sensitivity" }), {
      repoRoot: root,
      run: (command, args) => {
        commands.push([command, ...args]);
        return { ok: true, output: "" };
      },
    });
    expect(commands.every(([command]) => command === "git")).toBe(true);
    expect(commands.some((argv) => argv.includes("push"))).toBe(false);
  });

  // Both entry points, the same edit, two identical repos. If the extraction ever
  // drifts — a different archive shape, a different number, a re-serialized file
  // — this is where it is caught.
  it("leaves exactly what `pnpm config:apply --yes` leaves", async () => {
    const viaLane = await tempRepo();
    const viaCli = await tempRepo();
    const createdAt = "2026-09-04T12:00:00.000Z";
    const changeset = {
      version: 1,
      createdAt,
      slug: "equivalence",
      ops: [alphaOp(0.01, 0.04)],
    };

    const reply = await handleConfigRequest(put({ ops: changeset.ops, slug: changeset.slug }), {
      repoRoot: viaLane,
      now: () => new Date(createdAt),
    });
    expect(reply.status).toBe(200);

    const cli = spawnSync("node", [CLI, "--stdin", "--yes", "--seed-files"], {
      cwd: viaCli,
      input: JSON.stringify(changeset),
      encoding: "utf8",
      env: { ...process.env, CONFIG_APPLY_REPO_ROOT: viaCli },
    });
    expect(cli.status).toBe(0);

    for (const rel of ["config/constants.json", "installation/changesets/0001_equivalence.json"]) {
      expect(await fs.readFile(path.join(viaLane, installed(rel)), "utf8")).toBe(
        await fs.readFile(path.join(viaCli, installed(rel)), "utf8"),
      );
    }
    // The one difference is deliberate: the lane commits for the operator, and
    // the CLI prints the command for them to run.
    expect(git(viaLane, "log", "--oneline").split("\n")).toHaveLength(2);
    expect(git(viaCli, "log", "--oneline").split("\n")).toHaveLength(1);
    expect(cli.stdout).toContain("archived installation/changesets/0001_equivalence.json");
  }, CLI_COMPARISON_MS);
});

// The file half of "an asset was created" (bead ro-z349.1). `file-json-set` was
// the lane's only op because a changeset never created structure; adding an
// asset needs exactly that, so these two kinds have their own tighter allowlist
// in the shared core — one container per file, addressed by asset id.
describe("adding and removing an asset's config entries", () => {
  it("appends to pull.json, adds the two register keys, archives and commits", async () => {
    const root = await tempRepoWithRegisters();

    const reply = await handleConfigRequest(
      put({
        ops: [
          {
            kind: "file-json-insert",
            file: "config/integrations.json",
            pointer: "/assets/brandnew.test",
            value: { uptime: { status: "needs-setup" } },
          },
          {
            kind: "file-json-insert",
            file: "config/counters.json",
            pointer: "/assets/brandnew.test",
            value: { cards: [] },
          },
          {
            kind: "file-json-insert",
            file: "config/pull.json",
            pointer: "/-",
            value: { asset: "brandnew.test", url: "https://brandnew.test/m", enabled: true },
          },
        ],
        slug: "add-brandnew",
      }),
      { repoRoot: root, now: () => new Date("2026-09-04T12:00:00.000Z") },
    );

    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      applied: 3,
      archive: "installation/changesets/0001_add-brandnew.json",
    });
    expect(await readJson(root, "config/integrations.json")).toEqual({
      ...REGISTERS.integrations,
      assets: {
        ...REGISTERS.integrations.assets,
        "brandnew.test": { uptime: { status: "needs-setup" } },
      },
    });
    expect(await readJson(root, "config/pull.json")).toEqual([
      ...REGISTERS.pull,
      { asset: "brandnew.test", url: "https://brandnew.test/m", enabled: true },
    ]);
    // Every touched file plus the archive, in one commit, and nothing else.
    expect(git(root, "show", "--name-only", "--pretty=", "HEAD").split("\n").sort()).toEqual([
      "installation/changesets/0001_add-brandnew.json",
      "installation/counters.json",
      "installation/integrations.json",
      "installation/pull.json",
    ]);
  });

  it("removes an asset again, splicing the pull entry rather than holing it", async () => {
    const root = await tempRepoWithRegisters();

    const reply = await handleConfigRequest(
      put({
        ops: [
          {
            kind: "file-json-delete",
            file: "config/integrations.json",
            pointer: "/assets/meals.example",
            expect: REGISTERS.integrations.assets["meals.example"],
          },
          {
            kind: "file-json-delete",
            file: "config/pull.json",
            pointer: "/0",
            expect: REGISTERS.pull[0],
          },
        ],
        slug: "remove-meals",
      }),
      { repoRoot: root },
    );

    expect(reply.status).toBe(200);
    expect(await readJson(root, "config/integrations.json")).toEqual({
      ...REGISTERS.integrations,
      assets: {},
    });
    expect(await readJson(root, "config/pull.json")).toEqual([REGISTERS.pull[1]]);
  });

  // Bead ro-sk7q. Until this, a delete could not reach either panel register:
  // the asset left the store and the file that decides what the weekly collector
  // buys went on naming it, silently, since the confirmation never said so.
  it("removes the asset from both panel registers as well, in the same changeset", async () => {
    const root = await tempRepoWithRegisters();

    const reply = await handleConfigRequest(
      put({
        ops: [
          {
            kind: "file-json-delete",
            file: "config/signal-panels.json",
            pointer: "/assets/meals.example",
            expect: REGISTERS.signalPanels.assets["meals.example"],
          },
          {
            kind: "file-json-delete",
            file: "config/serp-panel.json",
            pointer: "/assets/meals.example",
            expect: REGISTERS.serpPanel.assets["meals.example"],
          },
        ],
        slug: "remove-meals-panels",
      }),
      { repoRoot: root, now: () => new Date("2026-09-04T12:00:00.000Z") },
    );

    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      applied: 2,
      archive: "installation/changesets/0001_remove-meals-panels.json",
    });
    // The `/assets` key goes; everything the file says about itself stays.
    expect(await readJson(root, "config/signal-panels.json")).toEqual({
      ...REGISTERS.signalPanels,
      assets: {},
    });
    expect(await readJson(root, "config/serp-panel.json")).toEqual({ assets: {} });
    expect(git(root, "show", "--name-only", "--pretty=", "HEAD").split("\n").sort()).toEqual([
      "installation/changesets/0001_remove-meals-panels.json",
      "installation/serp-panel.json",
      "installation/signal-panels.json",
    ]);
  });

  // Bead ro-xzxg. The store row went and the id stayed on the entity that owned
  // it — a ghost visible on /settings under Entities and nowhere else, because
  // an asset's membership is a string in another row rather than an entry of its
  // own, and no `file-json-delete` can address it.
  it("takes the asset off its entity's list, in the same changeset as its entries", async () => {
    const root = await tempRepoWithRegisters();

    const reply = await handleConfigRequest(
      put({
        ops: [
          {
            kind: "file-json-delete",
            file: "config/integrations.json",
            pointer: "/assets/meals.example",
            expect: REGISTERS.integrations.assets["meals.example"],
          },
          {
            kind: "file-json-set",
            file: "config/entities.json",
            pointer: "/entities/1/assets",
            expect: ["meals.example", "fees.example"],
            value: ["fees.example"],
          },
        ],
        slug: "delete-asset-meals-example",
      }),
      { repoRoot: root },
    );

    expect(reply.status).toBe(200);
    // The row is untouched but for the id: the entity is a legal person and
    // outlives every asset it owns, and the assets it still owns stay owned.
    expect(await readJson(root, "config/entities.json")).toEqual({
      version: 1,
      entities: [
        { slug: "first-co", name: "First Co" },
        {
          slug: "reindex-ventures",
          name: "Reindex Ventures LLC",
          assets: ["fees.example"],
        },
      ],
    });
  });

  it("refuses a list that has moved since the delete was offered, and writes nothing", async () => {
    const root = await tempRepoWithRegisters();

    const refused = await handleConfigRequest(
      put({
        ops: [
          {
            kind: "file-json-set",
            file: "config/entities.json",
            pointer: "/entities/1/assets",
            // What the page rendered before somebody else added an asset.
            expect: ["meals.example"],
            value: [],
          },
        ],
        slug: "delete-asset-meals-example",
      }),
      { repoRoot: root },
    );

    expect(refused.status).toBe(409);
    expect(await readJson(root, "config/entities.json")).toEqual(REGISTERS.entities);
  });

  it("refuses a panel delete whose entry has moved, and writes nothing", async () => {
    const root = await tempRepoWithRegisters();

    const reply = await handleConfigRequest(
      put({
        ops: [
          {
            kind: "file-json-delete",
            file: "config/serp-panel.json",
            pointer: "/assets/meals.example",
            // A panel somebody grew since the page read it.
            expect: { queries: ["meals"] },
          },
        ],
      }),
      { repoRoot: root },
    );

    expect(reply.status).toBe(409);
    expect(reply.body.mismatches).toMatchObject([
      {
        file: "config/serp-panel.json",
        pointer: "/assets/meals.example",
        current: REGISTERS.serpPanel.assets["meals.example"],
      },
    ]);
    expect(await readJson(root, "config/serp-panel.json")).toEqual(REGISTERS.serpPanel);
  });

  it("refuses to reach past the panel registers' declared containers", async () => {
    const root = await tempRepoWithRegisters();

    for (const [file, pointer] of [
      // What a refresh pass costs and how far back it reads is not an asset,
      // and no register names it — it is reachable from nowhere at all.
      ["config/signal-panels.json", "/refresh"],
      // The container is not one of its own rows.
      ["config/serp-panel.json", "/assets/meals.example/queries"],
    ] as const) {
      const reply = await handleConfigRequest(
        put({ ops: [{ kind: "file-json-delete", file, pointer, expect: null }] }),
        { repoRoot: root },
      );
      expect(reply.status).toBe(422);
      expect(reply.body.error).toBe("invalid_changeset");
      expect(String(reply.body.detail)).toContain("/assets/<asset-id>");
    }

    // ONE QUERY, on the other hand, IS a row now (bead ro-x5gu.1): the asset's
    // Growth tab removes a tracked term, so `serp-panel-queries` declares that
    // container and the pointer is legal. It still refuses here — on the
    // `expect` guard, which is a different refusal saying a different thing:
    // the file is what it always was, and the caller named the wrong value.
    const oneQuery = await handleConfigRequest(
      put({
        ops: [
          {
            kind: "file-json-delete",
            file: "config/serp-panel.json",
            pointer: "/assets/meals.example/queries/0",
            expect: null,
          },
        ],
      }),
      { repoRoot: root },
    );
    expect(oneQuery.status).toBe(409);

    expect(await readJson(root, "config/signal-panels.json")).toEqual(REGISTERS.signalPanels);
    expect(await readJson(root, "config/serp-panel.json")).toEqual(REGISTERS.serpPanel);
  });

  // An insert's guard is fixed at absence. A wizard re-submitted, or an id typed
  // twice, must never silently replace whatever was configured under that key.
  it("refuses to overwrite an asset that is already configured, and says it expected nothing", async () => {
    const root = await tempRepoWithRegisters();

    const reply = await handleConfigRequest(
      put({
        ops: [
          {
            kind: "file-json-insert",
            file: "config/integrations.json",
            pointer: "/assets/meals.example",
            value: { uptime: { status: "needs-setup" } },
          },
        ],
      }),
      { repoRoot: root },
    );

    expect(reply.status).toBe(409);
    expect(reply.body.mismatches).toEqual([
      {
        file: "config/integrations.json",
        pointer: "/assets/meals.example",
        expect: null,
        expectAbsent: true,
        current: REGISTERS.integrations.assets["meals.example"],
        absent: false,
      },
    ]);
    expect(await readJson(root, "config/integrations.json")).toEqual(REGISTERS.integrations);
    // A refused changeset commits nothing: the two here are the fixture's own.
    expect(git(root, "log", "--oneline").split("\n")).toHaveLength(2);
  });

  // The allowlist for these kinds is its own, and narrower: only the per-asset
  // register, only one token past it, and only in the three register files.
  it("refuses a pointer outside the per-asset register, and a file that is not one", async () => {
    const root = await tempRepoWithRegisters();
    const refuse = async (op: Record<string, unknown>) =>
      handleConfigRequest(put({ ops: [op] }), { repoRoot: root });

    // One lane inside an asset's entry became a declared row when `asset-lane`
    // landed (bead `ro-vu8d.4`), so the pointer is legal and the VALUE decides:
    // a cell missing the date every cell carries is refused by name. (A note
    // is optional since bead ro-ujb9.96.7.22 — absent until there is
    // something to say — but a blank one is still refused.)
    const insideAnEntry = await refuse({
      kind: "file-json-insert",
      file: "config/integrations.json",
      pointer: "/assets/meals.example/gsc",
      value: { status: "live" },
    });
    expect(insideAnEntry.status).toBe(422);
    expect(String(insideAnEntry.body.detail)).toContain("Since is required");
    const blankNote = await refuse({
      kind: "file-json-insert",
      file: "config/integrations.json",
      pointer: "/assets/meals.example/gsc",
      value: { status: "live", note: "", since: "2026-09-24" },
    });
    expect(blankNote.status).toBe(422);
    expect(String(blankNote.body.detail)).toContain("Reason must not be blank");

    const aboveAnEntry = await refuse({
      kind: "file-json-insert",
      file: "config/integrations.json",
      pointer: "/assets",
      value: {},
    });
    expect(aboveAnEntry.status).toBe(422);
    expect(String(aboveAnEntry.body.detail)).toContain("/assets/<asset-id>");

    const wrongFile = await refuse({
      kind: "file-json-insert",
      file: "config/constants.json",
      pointer: "/assets/brandnew.test",
      value: {},
    });
    expect(wrongFile.status).toBe(422);
    expect(String(wrongFile.body.detail)).toContain("may not touch");

    expect(git(root, "log", "--oneline").split("\n")).toHaveLength(2);
  });

  // The equivalence test above covers `file-json-set`; these kinds get their own
  // run because the CLI has a second surface for them — the printed diff, which
  // has one side rather than two ("+ add" / "- remove" instead of a `→`).
  it("leaves exactly what `pnpm config:apply --yes` leaves, for an add and a removal", async () => {
    const viaLane = await tempRepoWithRegisters();
    const viaCli = await tempRepoWithRegisters();
    const createdAt = "2026-09-04T12:00:00.000Z";
    const changeset = {
      version: 1,
      createdAt,
      slug: "swap-an-asset",
      ops: [
        {
          kind: "file-json-insert",
          file: "config/pull.json",
          pointer: "/-",
          value: { asset: "brandnew.test", url: "https://brandnew.test/m", enabled: true },
        },
        {
          kind: "file-json-delete",
          file: "config/integrations.json",
          pointer: "/assets/meals.example",
          expect: REGISTERS.integrations.assets["meals.example"],
        },
      ],
    };

    const reply = await handleConfigRequest(
      put({ ops: changeset.ops, slug: changeset.slug }),
      { repoRoot: viaLane, now: () => new Date(createdAt) },
    );
    expect(reply.status).toBe(200);

    const cli = spawnSync("node", [CLI, "--stdin", "--yes", "--seed-files"], {
      cwd: viaCli,
      input: JSON.stringify(changeset),
      encoding: "utf8",
      env: { ...process.env, CONFIG_APPLY_REPO_ROOT: viaCli },
    });
    expect(cli.status).toBe(0);
    // The diff reads as an addition and a removal, not as a value moving.
    expect(cli.stdout).toContain("+ add");
    expect(cli.stdout).toContain("- remove");

    for (const rel of [
      "config/pull.json",
      "config/integrations.json",
      "installation/changesets/0001_swap-an-asset.json",
    ]) {
      expect(await fs.readFile(path.join(viaLane, installed(rel)), "utf8")).toBe(
        await fs.readFile(path.join(viaCli, installed(rel)), "utf8"),
      );
    }
  }, CLI_COMPARISON_MS);
});

// A FIRST WRITE INTO A FIELD NOTHING HAS WRITTEN YET (bead `ro-j71v`).
//
// Every mapping field in `config/integrations.json` is sparse — the key is
// absent until an operator maps the asset — so a guard that can only name a
// JSON value has nothing honest to say about one. `expectAbsent: true` is that
// word, and these are the four things it has to be true of: the write lands, the
// guard still refuses a field somebody else already filled in, it cannot be used
// to invent anything but that one declared optional key, and both entry points
// leave the same bytes behind.
describe("a first write into a declared optional field", () => {
  const siteOp = (guard: Record<string, unknown>) => ({
    kind: "file-json-set",
    file: "config/integrations.json",
    pointer: "/assets/meals.example/gsc/siteUrl",
    ...guard,
    value: "sc-domain:meals.example",
  });

  it("writes the key the row did not have, and leaves the rest of the row alone", async () => {
    const root = await tempRepoWithRegisters();
    const reply = await handleConfigRequest(
      put({ ops: [siteOp({ expectAbsent: true })], slug: "map-the-site" }),
      { repoRoot: root },
    );
    expect(reply.status).toBe(200);
    expect(await readJson(root, "config/integrations.json")).toMatchObject({
      assets: {
        "meals.example": { gsc: { status: "live", siteUrl: "sc-domain:meals.example" } },
      },
    });
  });

  // The bug itself: an empty string is a value somebody wrote down, and the file
  // holds no such value — so it stays a mismatch, and the field that means "no
  // value here" is the one that works.
  it("still refuses an empty string as the guard for an absent key", async () => {
    const root = await tempRepoWithRegisters();
    const reply = await handleConfigRequest(put({ ops: [siteOp({ expect: "" })] }), {
      repoRoot: root,
    });
    expect(reply.status).toBe(409);
    expect(reply.body.mismatches).toEqual([
      {
        file: "config/integrations.json",
        pointer: "/assets/meals.example/gsc/siteUrl",
        expect: "",
        current: null,
        absent: true,
      },
    ]);
  });

  it("refuses a first write onto a field somebody else already filled in", async () => {
    const root = await tempRepoWithRegisters();
    expect(
      (await handleConfigRequest(put({ ops: [siteOp({ expectAbsent: true })] }), { repoRoot: root }))
        .status,
    ).toBe(200);

    const second = await handleConfigRequest(
      put({ ops: [siteOp({ expectAbsent: true })] }),
      { repoRoot: root },
    );
    expect(second.status).toBe(409);
    expect(second.body.mismatches).toEqual([
      {
        file: "config/integrations.json",
        pointer: "/assets/meals.example/gsc/siteUrl",
        expect: null,
        expectAbsent: true,
        current: "sc-domain:meals.example",
        absent: false,
      },
    ]);
  });

  it("creates that one declared optional key and nothing else", async () => {
    const root = await tempRepoWithRegisters();
    const before = await readJson(root, "config/integrations.json");
    for (const pointer of [
      // A lane that is not in the file: the ROW is `file-json-insert`'s job.
      "/assets/meals.example/clarity",
      // A required field — a row missing one is broken, not new.
      "/assets/meals.example/gsc/status",
      // Two levels down, inside a key that is not there either.
      "/assets/meals.example/gsc/nested/siteUrl",
    ]) {
      const reply = await handleConfigRequest(
        put({
          ops: [
            {
              kind: "file-json-set",
              file: "config/integrations.json",
              pointer,
              expectAbsent: true,
              value: "live",
            },
          ],
        }),
        { repoRoot: root },
      );
      expect(reply.status).toBe(422);
      expect(String((reply.body as { detail: string }).detail)).toContain("declared OPTIONAL field");
    }
    expect(await readJson(root, "config/integrations.json")).toEqual(before);
  });

  it("leaves exactly what `pnpm config:apply --yes` leaves", async () => {
    const viaLane = await tempRepoWithRegisters();
    const viaCli = await tempRepoWithRegisters();
    const createdAt = "2026-09-05T12:00:00.000Z";
    const changeset = {
      version: 1,
      createdAt,
      slug: "map-the-site",
      ops: [siteOp({ expectAbsent: true })],
    };

    const reply = await handleConfigRequest(
      put({ ops: changeset.ops, slug: changeset.slug }),
      { repoRoot: viaLane, now: () => new Date(createdAt) },
    );
    expect(reply.status).toBe(200);

    const cli = spawnSync("node", [CLI, "--stdin", "--yes", "--seed-files"], {
      cwd: viaCli,
      input: JSON.stringify(changeset),
      encoding: "utf8",
      env: { ...process.env, CONFIG_APPLY_REPO_ROOT: viaCli },
    });
    expect(cli.status).toBe(0);

    for (const rel of ["config/integrations.json", "installation/changesets/0001_map-the-site.json"]) {
      expect(await fs.readFile(path.join(viaLane, installed(rel)), "utf8")).toBe(
        await fs.readFile(path.join(viaCli, installed(rel)), "utf8"),
      );
    }
  }, CLI_COMPARISON_MS);
});

// TAKING THAT FIELD BACK OFF (bead `ro-pkpz`).
//
// The mirror of the block above, and the reason it had to exist: emptying the
// box is refused — a field rule reads `""` as a blank string rather than as
// "take this away" — so a mapping written once could be replaced and never
// removed, and an asset that should go back to its fallback source could not be
// put back there from the Tower. It is also what makes the FIRST save undoable:
// the way back from writing a key is taking the key away.
describe("taking a declared optional field back off", () => {
  const siteUrl = "sc-domain:meals.example";
  const write = {
    kind: "file-json-set",
    file: "config/integrations.json",
    pointer: "/assets/meals.example/gsc/siteUrl",
    expectAbsent: true,
    value: siteUrl,
  };
  const unset = (expect_: unknown) => ({
    kind: "file-json-delete",
    file: "config/integrations.json",
    pointer: "/assets/meals.example/gsc/siteUrl",
    expect: expect_,
  });

  it("removes the key the first write added, and leaves the row otherwise as it was", async () => {
    const root = await tempRepoWithRegisters();
    expect(
      (await handleConfigRequest(put({ ops: [write] }), { repoRoot: root })).status,
    ).toBe(200);

    const reply = await handleConfigRequest(
      put({ ops: [unset(siteUrl)], slug: "unmap-the-site" }),
      { repoRoot: root },
    );
    expect(reply.status).toBe(200);
    // The key is GONE, not blank — absent is what the collector reads as "fall
    // back", and a blank string would be a value nobody meant to write.
    expect(await readJson(root, "config/integrations.json")).toEqual(REGISTERS.integrations);
  });

  it("refuses a removal whose value somebody else has already moved", async () => {
    const root = await tempRepoWithRegisters();
    await handleConfigRequest(put({ ops: [write] }), { repoRoot: root });

    const reply = await handleConfigRequest(put({ ops: [unset("https://elsewhere.test/")] }), {
      repoRoot: root,
    });
    expect(reply.status).toBe(409);
    expect(reply.body.mismatches).toEqual([
      {
        file: "config/integrations.json",
        pointer: "/assets/meals.example/gsc/siteUrl",
        expect: "https://elsewhere.test/",
        current: siteUrl,
        absent: false,
      },
    ]);
  });

  it("removes only what a first write may create", async () => {
    const root = await tempRepoWithRegisters();
    const before = await readJson(root, "config/integrations.json");
    for (const pointer of [
      // A required field — a row missing one is broken, not unmapped.
      "/assets/meals.example/gsc/status",
      // Two levels down, inside a key that is not there at all.
      "/assets/meals.example/gsc/nested/siteUrl",
    ]) {
      const reply = await handleConfigRequest(
        put({
          ops: [
            { kind: "file-json-delete", file: "config/integrations.json", pointer, expect: "live" },
          ],
        }),
        { repoRoot: root },
      );
      expect(reply.status).toBe(422);
    }
    expect(await readJson(root, "config/integrations.json")).toEqual(before);
  });

  it("leaves exactly what `pnpm config:apply --yes` leaves", async () => {
    const viaLane = await tempRepoWithRegisters();
    const viaCli = await tempRepoWithRegisters();
    const createdAt = "2026-09-05T12:00:00.000Z";
    for (const root of [viaLane, viaCli]) {
      await handleConfigRequest(put({ ops: [write], slug: "map-the-site" }), {
        repoRoot: root,
        now: () => new Date(createdAt),
      });
    }
    const changeset = {
      version: 1,
      createdAt,
      slug: "unmap-the-site",
      ops: [unset(siteUrl)],
    };

    expect(
      (
        await handleConfigRequest(put({ ops: changeset.ops, slug: changeset.slug }), {
          repoRoot: viaLane,
          now: () => new Date(createdAt),
        })
      ).status,
    ).toBe(200);

    const cli = spawnSync("node", [CLI, "--stdin", "--yes", "--seed-files"], {
      cwd: viaCli,
      input: JSON.stringify(changeset),
      encoding: "utf8",
      env: { ...process.env, CONFIG_APPLY_REPO_ROOT: viaCli },
    });
    expect(cli.status).toBe(0);
    // The diff reads as a removal, which is what it is.
    expect(cli.stdout).toContain("- remove");

    for (const rel of ["config/integrations.json", "installation/changesets/0002_unmap-the-site.json"]) {
      expect(await fs.readFile(path.join(viaLane, installed(rel)), "utf8")).toBe(
        await fs.readFile(path.join(viaCli, installed(rel)), "utf8"),
      );
    }
  }, CLI_COMPARISON_MS);
});

// The list-shaped registers (bead ro-x5gu.1). What the lane may do to them is
// declared in scripts/config-registers.mjs, and the point of these cases is that
// the DECLARATION is what decides — the lane holds no list of its own, so a
// register gains a surface without this file changing.
const DOMAIN_COSTS = {
  domains: [
    { domain: "fees.example", asset: "fees.example", kind: "registration", paidUsd: 36.32, paidOn: "2026-06-28" },
    { domain: "nosh.example", asset: "nosh.example", kind: "registration", paidUsd: 109.69, paidOn: "2026-06-19" },
  ],
};
const VALUE_EVENTS = { assets: { "meals.example": { valueEvents: ["sign_up"] } } };

async function tempRepoWithCollections(): Promise<string> {
  const root = await tempRepo();
  for (const [name, doc] of [
    ["domain-costs", DOMAIN_COSTS],
    ["value-events", VALUE_EVENTS],
  ] as const) {
    await fs.writeFile(
      path.join(root, installed(`config/${name}.json`)),
      JSON.stringify(doc, null, 2) + "\n",
      "utf8",
    );
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "collections");
  return root;
}

describe("a declared collection register", () => {
  it("adds a row, edits one field of another, and removes a third", async () => {
    const root = await tempRepoWithCollections();
    const added = {
      domain: "teller.example",
      asset: "fees.example",
      kind: "registration",
      paidUsd: 6.69,
      paidOn: "2026-06-28",
    };

    // Each action is its OWN changeset — one op, one archive, one commit —
    // because that is what makes each one separately undoable.
    const add = await handleConfigRequest(
      put({
        ops: [{ kind: "file-json-insert", file: "config/domain-costs.json", pointer: "/domains/-", value: added }],
        slug: "add-a-domain",
      }),
      { repoRoot: root },
    );
    expect(add.status).toBe(200);

    const edit = await handleConfigRequest(
      put({
        ops: [
          {
            kind: "file-json-set",
            file: "config/domain-costs.json",
            pointer: "/domains/0/paidUsd",
            expect: 36.32,
            value: 40,
          },
        ],
        slug: "correct-a-price",
      }),
      { repoRoot: root },
    );
    expect(edit.status).toBe(200);

    const remove = await handleConfigRequest(
      put({
        ops: [
          {
            kind: "file-json-delete",
            file: "config/domain-costs.json",
            pointer: "/domains/1",
            expect: DOMAIN_COSTS.domains[1],
          },
        ],
        slug: "drop-a-domain",
      }),
      { repoRoot: root },
    );
    expect(remove.status).toBe(200);

    expect(await readJson(root, "config/domain-costs.json")).toEqual({
      domains: [{ ...DOMAIN_COSTS.domains[0], paidUsd: 40 }, added],
    });
  });

  it("refuses a value the field's own rule rejects, naming the field", async () => {
    const root = await tempRepoWithCollections();
    const before = await readJson(root, "config/domain-costs.json");

    const wrongType = await handleConfigRequest(
      put({
        ops: [
          {
            kind: "file-json-set",
            file: "config/domain-costs.json",
            pointer: "/domains/0/paidUsd",
            expect: 36.32,
            value: "thirty six",
          },
        ],
      }),
      { repoRoot: root },
    );
    expect(wrongType.status).toBe(422);
    expect(String((wrongType.body as { detail: string }).detail)).toContain("Paid (USD) must be a number");

    const undeclared = await handleConfigRequest(
      put({
        ops: [
          {
            kind: "file-json-set",
            file: "config/domain-costs.json",
            pointer: "/domains/0/currency",
            expect: null,
            value: "USD",
          },
        ],
      }),
      { repoRoot: root },
    );
    expect(undeclared.status).toBe(422);
    expect(String((undeclared.body as { detail: string }).detail)).toContain("not a declared field");

    // Nothing was written by either refusal.
    expect(await readJson(root, "config/domain-costs.json")).toEqual(before);
  });

  it("scopes a per-asset register to the asset in its pointer", async () => {
    const root = await tempRepoWithCollections();
    const ok = await handleConfigRequest(
      put({
        ops: [
          {
            kind: "file-json-insert",
            file: "config/value-events.json",
            pointer: "/assets/meals.example/valueEvents/-",
            value: "plan_save_click",
          },
        ],
        slug: "declare-a-value-event",
      }),
      { repoRoot: root },
    );
    expect(ok.status).toBe(200);
    expect(await readJson(root, "config/value-events.json")).toEqual({
      assets: { "meals.example": { valueEvents: ["sign_up", "plan_save_click"] } },
    });

    // An asset with no entry has no list to append to, and a pointer never
    // creates structure — so the refusal is about the pointer, not the value.
    const missing = await handleConfigRequest(
      put({
        ops: [
          {
            kind: "file-json-insert",
            file: "config/value-events.json",
            pointer: "/assets/nosh.example/valueEvents/-",
            value: "sign_up",
          },
        ],
      }),
      { repoRoot: root },
    );
    expect(missing.status).toBe(500);
    expect(String((missing.body as { detail: string }).detail)).toContain("missing key");
  });

  it("leaves exactly what `pnpm config:apply --yes` leaves, for a register row", async () => {
    const viaLane = await tempRepoWithCollections();
    const viaCli = await tempRepoWithCollections();
    const createdAt = "2026-09-05T12:00:00.000Z";
    const changeset = {
      version: 1,
      createdAt,
      slug: "book-a-domain",
      ops: [
        {
          kind: "file-json-insert",
          file: "config/domain-costs.json",
          pointer: "/domains/-",
          value: {
            domain: "bankcodes.example",
            asset: "fees.example",
            kind: "renewal",
            paidUsd: 11.11,
            paidOn: "2026-09-01",
          },
        },
        {
          kind: "file-json-set",
          file: "config/value-events.json",
          pointer: "/assets/meals.example/valueEvents/0",
          expect: "sign_up",
          value: "auth_complete",
        },
      ],
    };

    const reply = await handleConfigRequest(put({ ops: changeset.ops, slug: changeset.slug }), {
      repoRoot: viaLane,
      now: () => new Date(createdAt),
    });
    expect(reply.status).toBe(200);

    const cli = spawnSync("node", [CLI, "--stdin", "--yes", "--seed-files"], {
      cwd: viaCli,
      input: JSON.stringify(changeset),
      encoding: "utf8",
      env: { ...process.env, CONFIG_APPLY_REPO_ROOT: viaCli },
    });
    expect(cli.status).toBe(0);

    for (const rel of [
      "config/domain-costs.json",
      "config/value-events.json",
      "installation/changesets/0001_book-a-domain.json",
    ]) {
      expect(await fs.readFile(path.join(viaLane, installed(rel)), "utf8")).toBe(
        await fs.readFile(path.join(viaCli, installed(rel)), "utf8"),
      );
    }
  }, CLI_COMPARISON_MS);
});

/** A throwaway checkout holding `config/tower.json` as a fresh install has it:
 * a countdown and no `/wall` at all, because the default layout lives in the
 * code and a file that restated it would be a second copy of the same Wall. */
async function tempRepoWithTower(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "config-lane-wall-"));
  created.push(root);
  await fs.mkdir(path.join(root, "installation"), { recursive: true });
  await fs.writeFile(
    path.join(root, installed("config/tower.json")),
    JSON.stringify(
      {
        readme: "config/tower.README.md",
        countdown: {
          emoji: "\u{1F301}",
          label: "SF MOVE 2026",
          targetAt: "2026-11-16T08:00:00.000Z",
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "lane@test.local");
  git(root, "config", "user.name", "Lane Test");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "seed");
  return root;
}

// `config/tower.json` may be SET at any pointer — every value in it is a setting
// the Tower renders — so nothing in the safety allowlist has an opinion about
// `/wall`. The Wall's OWN validator supplies one, and refuses in the validator's
// own words, because the alternative is committing a layout whose first reader
// is the television (epic `ro-lzmq`).
//
// THE RULE IS NO LONGER THIS LANE'S (bead `ro-lzmq.3`). It lives in
// `scripts/wall-layout.mjs`, which `validateSchemaAndSafety` runs — so
// `pnpm config:apply`, the Worker's `PUT /api/config` and the ingest's
// `applyConfigOps` refuse the identical layout in the identical sentence, and
// these cases assert this door's share of one answer rather than its own.
describe("a layout the Wall could not draw", () => {
  const savesWall = (value: unknown) => ({
    kind: "file-json-insert",
    file: "config/tower.json",
    pointer: "/wall",
    value,
  });
  const detail = (body: unknown) => String((body as { detail?: unknown }).detail ?? "");

  it("refuses one, with the sentence the editor shows under Save", async () => {
    const root = await tempRepoWithTower();
    const reply = await handleConfigRequest(
      put({
        slug: "wall-layout",
        ops: [savesWall({ layout: { version: 1, rows: [] }, history: [] })],
      }),
      { repoRoot: root },
    );
    expect(reply.status).toBe(422);
    expect(reply.body).toMatchObject({ error: "invalid_changeset" });
    expect(detail(reply.body)).toContain("A layout needs at least one row.");
    // Nothing written, nothing committed.
    expect(await readJson(root, "config/tower.json")).not.toHaveProperty("wall");
    expect(git(root,"rev-list", "--count", "HEAD")).toBe("1");
  });

  it("refuses a saved VERSION it could not draw either", async () => {
    const root = await tempRepoWithTower();
    const reply = await handleConfigRequest(
      put({
        slug: "wall-layout",
        ops: [
          savesWall({
            layout: DEFAULT_WALL_LAYOUT,
            history: [
              {
                savedAt: "2026-09-05T10:00:00.000Z",
                reason: "before",
                layout: { version: 1, rows: [] },
              },
            ],
          }),
        ],
      }),
      { repoRoot: root },
    );
    expect(reply.status).toBe(422);
    expect(detail(reply.body)).toContain("at least one row");
  });

  // Bead ro-trai.2: the column slot is part of the one rule this lane runs.
  it("refuses a column inside a column, in the validator's words", async () => {
    const root = await tempRepoWithTower();
    const inner = { id: "deeper", type: "column", width: 1, rows: [{ id: "x", height: "auto", widgets: [{ id: "strip", type: "strip", width: 1 }] }] };
    const reply = await handleConfigRequest(
      put({
        slug: "wall-layout",
        ops: [
          savesWall({
            layout: {
              version: 1,
              rows: [
                {
                  id: "body",
                  height: "fill",
                  widgets: [{ id: "column", type: "column", width: 1, rows: [{ id: "inner", height: "auto", widgets: [inner] }] }],
                },
              ],
            },
            history: [],
          }),
        ],
      }),
      { repoRoot: root },
    );
    expect(reply.status).toBe(422);
    expect(detail(reply.body)).toContain("A column cannot hold another column.");
    expect(await readJson(root, "config/tower.json")).not.toHaveProperty("wall");
  });

  // Bead ro-trai.11: a layout saved before D28 names retired widgets. It still
  // reads (as the default), so an Undo that puts one back is not refused — but
  // a fresh `/wall/layout` naming one is, and the read-side `retired` marker is
  // never written into the store.
  it("takes back a pre-D28 layout whole, refuses one piece of it, and never stores the retired marker", async () => {
    const old = { version: 1, rows: [{ id: "assets", height: "fill", widgets: [{ id: "assets", type: "assets", width: 1 }] }] };
    const root = await tempRepoWithTower();
    const whole = await handleConfigRequest(
      put({ slug: "wall-layout", ops: [savesWall({ layout: old, history: [] })] }),
      { repoRoot: root },
    );
    expect(whole.status).toBe(200);
    expect(parseDashboardConfig(await readJson(root, "config/tower.json")).wall?.layout).toEqual(DEFAULT_WALL_LAYOUT);

    const marked = await handleConfigRequest(
      put({
        slug: "wall-layout",
        ops: [{
          kind: "file-json-set",
          file: "config/tower.json",
          pointer: "/wall",
          expect: { layout: old, history: [] },
          value: { layout: DEFAULT_WALL_LAYOUT, history: [], retired: { saved: null, replaced: true } },
        }],
      }),
      { repoRoot: root },
    );
    expect(marked.status).toBe(422);
    expect(detail(marked.body)).toContain("never saved");

    const piece = await handleConfigRequest(
      put({
        slug: "wall-layout",
        ops: [{ kind: "file-json-set", file: "config/tower.json", pointer: "/wall/layout", expect: old, value: old }],
      }),
      { repoRoot: root },
    );
    expect(piece.status).toBe(422);
    expect(detail(piece.body)).toContain('a widget the Wall no longer draws: "assets"');
  });

  it("refuses a pointer INSIDE a layout, because a width alone cannot be judged", async () => {
    const root = await tempRepoWithTower();
    const reply = await handleConfigRequest(
      put({
        slug: "wall-layout",
        ops: [
          {
            kind: "file-json-set",
            file: "config/tower.json",
            pointer: "/wall/layout/rows/0/widgets/0/width",
            expect: 1.7,
            value: 99,
          },
        ],
      }),
      { repoRoot: root },
    );
    expect(reply.status).toBe(422);
    expect(detail(reply.body)).toContain("saved whole");
  });

  it("accepts one it can draw, and commits it like any other setting", async () => {
    const root = await tempRepoWithTower();
    const reply = await handleConfigRequest(
      put({
        slug: "wall-layout",
        ops: [savesWall({ layout: DEFAULT_WALL_LAYOUT, history: [] })],
      }),
      { repoRoot: root },
    );
    expect(reply.status).toBe(200);
    const saved = await readJson(root, "config/tower.json");
    expect(saved).toMatchObject({ wall: { layout: DEFAULT_WALL_LAYOUT, history: [] } });
    expect(git(root,"log", "-1", "--format=%s")).toBe("config: wall-layout via Tower");
    // And the file still parses as the display config the Worker is built from.
    expect(parseDashboardConfig(saved).wall?.layout).toEqual(DEFAULT_WALL_LAYOUT);
  });

  it("lets the layout go again — the Wall falls back to the one it can always draw", async () => {
    const root = await tempRepoWithTower();
    await handleConfigRequest(
      put({
        slug: "wall-layout",
        ops: [savesWall({ layout: DEFAULT_WALL_LAYOUT, history: [] })],
      }),
      { repoRoot: root },
    );
    const reply = await handleConfigRequest(
      put({
        slug: "wall-reset",
        ops: [
          {
            kind: "file-json-delete",
            file: "config/tower.json",
            pointer: "/wall",
            expect: { layout: DEFAULT_WALL_LAYOUT, history: [] },
          },
        ],
      }),
      { repoRoot: root },
    );
    expect(reply.status).toBe(200);
    expect(await readJson(root, "config/tower.json")).not.toHaveProperty("wall");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Since 2026-09-05 the lane is a THIN CLIENT of the store (epic `ro-syok`).
//
// db/0029 holds a document per config file, so a Save goes there first and this
// process's remaining job is the CHECKOUT: write what the store wrote, archive
// the changeset, commit. Three properties hold that up, and each has a case:
// the store's refusals are passed through rather than second-guessed, a store
// that cannot take the write never falls back to files, and a checkout
// that could not be updated never reports the Save as failed.
//
// Every case injects its store. There is deliberately NO default door — a test
// run in any checkout must not be able to write to whatever OS is listening on
// the machine running it.
// ─────────────────────────────────────────────────────────────────────────────

/** A store that answers what the case wants and records what it was sent. */
function fakeStore(reply: { status: number; body: Record<string, unknown> }) {
  const applied: unknown[] = [];
  return {
    applied,
    lane: {
      state: async () => ({ ready: true, reason: null, unseeded: [] }),
      apply: async (input: unknown) => {
        applied.push(input);
        return reply;
      },
    },
  };
}

describe("the lane with a config store behind it", () => {
  it("sends the Save to the store, then exports and commits what came back", async () => {
    const root = await tempRepo();
    const store = fakeStore({
      status: 200,
      body: {
        ok: true,
        applied: 1,
        documents: [
          {
            file: "config/constants.json",
            version: 2,
            body: { ...CONSTANTS, flag_defaults: { ...CONSTANTS.flag_defaults, alpha: 0.05 } },
          },
        ],
      },
    });

    const reply = await handleConfigRequest(put({ ops: [alphaOp(0.01, 0.05)], slug: "sensitivity" }), {
      repoRoot: root,
      store: store.lane,
    });

    expect(reply.status).toBe(200);
    expect(store.applied).toEqual([
      { ops: [alphaOp(0.01, 0.05)], slug: "sensitivity", actor: "operator" },
    ]);
    // The file is the export: the checkout holds what the store holds, and the
    // archive plus the commit are the audit trail the repo has always carried.
    expect(await readJson(root, "config/constants.json")).toMatchObject({
      flag_defaults: { alpha: 0.05 },
    });
    expect((reply.body as { archive: string }).archive).toBe(
      "installation/changesets/0001_sensitivity.json",
    );
    expect(git(root, "log", "--oneline", "-1")).toContain("config: sensitivity via Tower");
  });

  // `pnpm start` (bead ro-ujb9.126) runs an installation out of a plain folder,
  // usually one inside somebody's checkout: git run there would find THAT
  // repository. The Save still lands in the store and in the folder's exports.
  it("runs no git at all when its home is a plain folder rather than a checkout", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "config-lane-folder-"));
    created.push(home);
    await fs.mkdir(path.join(home, "installation"), { recursive: true });
    const commands: string[][] = [];
    const store = fakeStore({
      status: 200,
      body: {
        ok: true,
        applied: 1,
        documents: [{ file: "config/constants.json", version: 2, body: { ...CONSTANTS, flag_defaults: { alpha: 0.05 } } }],
      },
    });

    const reply = await handleConfigRequest(put({ ops: [alphaOp(0.01, 0.05)], slug: "sensitivity" }), {
      repoRoot: home,
      store: store.lane,
      run: (command, args) => {
        commands.push([command, ...args]);
        return { ok: true, output: "" };
      },
    });

    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ commit: null, exported: true, archive: "installation/changesets/0001_sensitivity.json" });
    expect(await readJson(home, "config/constants.json")).toMatchObject({ flag_defaults: { alpha: 0.05 } });
    expect(commands).toEqual([]);
  });

  it("passes a stale-value refusal straight through, and writes no file", async () => {
    const root = await tempRepo();
    const store = fakeStore({
      status: 409,
      body: {
        ok: false,
        error: "expect_mismatch",
        mismatches: [{ file: "config/constants.json", pointer: "/flag_defaults/alpha", current: 0.02 }],
      },
    });

    const reply = await handleConfigRequest(put({ ops: [alphaOp(0.01, 0.05)] }), {
      repoRoot: root,
      store: store.lane,
    });

    expect(reply.status).toBe(409);
    expect(reply.body).toMatchObject({ error: "expect_mismatch" });
    // The store is the source of truth once seeded; the lane must not re-run
    // the same ops against the file and reach a different answer.
    expect(await readJson(root, "config/constants.json")).toEqual(CONSTANTS);
  });

  it("refuses a missing store rather than silently changing the fallback file", async () => {
    // A missing table is not proof that a store was never authoritative.
    const root = await tempRepo();
    const store = fakeStore({
      status: 503,
      body: { ok: false, error: "store_unavailable", detail: "no config_documents table" },
    });

    const reply = await handleConfigRequest(put({ ops: [alphaOp(0.01, 0.05)], slug: "sensitivity" }), {
      repoRoot: root,
      store: store.lane,
    });

    expect(reply.status).toBe(503);
    expect(await readJson(root, "config/constants.json")).toEqual(CONSTANTS);
    expect(git(root, "status", "--porcelain")).toBe("");
    expect(git(root, "rev-list", "--count", "HEAD")).toBe("1");
  });

  it.each([
    { status: 503, body: { ok: false, error: "not_seeded" } },
    { status: 200, body: {} },
    { status: 500, body: { ok: true } },
  ])("never selects file writes after an unavailable or ambiguous store result: %j", async (answer) => {
    const root = await tempRepo();
    const store = fakeStore(answer);
    const reply = await handleConfigRequest(put({ ops: [alphaOp(0.01, 0.05)] }), {
      repoRoot: root,
      store: store.lane,
    });
    expect(reply.status).toBe(503);
    expect(await readJson(root, "config/constants.json")).toEqual(CONSTANTS);
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("keeps files unchanged after a lost confirmation, and uses the store's value after recovery", async () => {
    const root = await tempRepo();
    const request = put({ ops: [alphaOp(0.01, 0.05)] });
    const unknown = await handleConfigRequest(request, {
      repoRoot: root,
      store: { ...fakeStore({ status: 200, body: {} }).lane, apply: async () => { throw new Error("lost response"); } },
    });
    expect(unknown.status).toBe(503);
    expect(String(unknown.body.detail)).toBe("Save not confirmed — refresh before trying again");
    expect(git(root, "status", "--porcelain")).toBe("");

    // The store committed before its response was lost. A retry after a fresh
    // lane instance is still checked against the store, never the stale file.
    const recovered = await handleConfigRequest(request, {
      repoRoot: root,
      store: fakeStore({ status: 409, body: { ok: false, error: "expect_mismatch", mismatches: [{ current: 0.05 }] } }).lane,
    });
    expect(recovered.status).toBe(409);
    expect(await readJson(root, "config/constants.json")).toEqual(CONSTANTS);
  });

  it("disables Save during an outage or a positively reported uninitialized store", async () => {
    for (const state of [
      async () => { throw new Error("network failed"); },
      async () => ({ ready: false, reason: "The config store has not been initialized.", unseeded: [] }),
    ]) {
      const reply = await handleConfigRequest({ method: "GET", headers: {}, body: "" }, {
        store: { ...fakeStore({ status: 503, body: {} }).lane, state },
      });
      expect(reply.status).toBe(200);
      expect(reply.body.writable).toBe(false);
      expect(reply.body.reason).toBeTruthy();
    }
  });

  it("reports a Save that landed even when the checkout could not be updated", async () => {
    const store = fakeStore({
      status: 200,
      body: {
        ok: true,
        applied: 1,
        documents: [{ file: "config/constants.json", version: 2, body: CONSTANTS }],
      },
    });

    // A file where the installation folder belongs: the export cannot be written.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "config-lane-no-export-"));
    created.push(root);
    await fs.writeFile(path.join(root, "installation"), "not a folder\n", "utf8");
    const reply = await handleConfigRequest(put({ ops: [alphaOp(0.01, 0.05)] }), {
      repoRoot: root,
      store: store.lane,
    });

    // The value MOVED. Reporting the Save as failed would be a lie, and the
    // operator's next action — `pnpm config:export` — is not "press Save again".
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ archive: null, commit: null, exported: false });
  });

  it("says on GET where the store stands, without claiming it cannot save", async () => {
    const reply = await handleConfigRequest(
      { method: "GET", headers: {}, body: "" },
      {
        store: {
          state: async () => ({
            ready: true,
            reason: null,
            unseeded: ["config/pull.json"],
          }),
          apply: async () => ({ status: 200, body: { ok: true } }),
        },
      },
    );
    expect(reply.body).toMatchObject({
      writable: true,
      store: { ready: true },
      unseeded: ["config/pull.json"],
    });
  });
});
