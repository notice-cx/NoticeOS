// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "vite";
import { createTestViteServer } from "../../../scripts/test-vite-server.mjs";
import {
  ALLOWED_VERBS,
  defaultRun,
  handleTasksRequest,
  prefixOf,
  readSpokes,
  resolveBdBin,
  taskLane,
} from "../vite/task-lane";
import { toLiveTask } from "../../../scripts/task-row.mjs";

// The Tower's write path to the portfolio's task hub. It spawns a CLI with
// the operator's own credentials, so what is asserted is the three guards, in
// the order they run, and the exact argv that reaches `bd`.
//
// Every case runs against a real subprocess: a fake `bd` placed first on this
// process's PATH that records its argv to a file and prints canned JSON per
// subcommand. A verb the lane will not run leaves the argv log untouched.

const SPOKES = {
  hub: { host: "127.0.0.1", port: 3308, user: "root", dataDir: ".local/beads-dolt" },
  spokes: [
    { asset: "root-os", prefix: "ro", database: "ro", repo: "." },
    { asset: "other.example", prefix: "ox", database: "ox", repo: "../other.example" },
  ],
};

/** One task as `bd list --json` reports it, with every field the lane reads. */
const LIST_ROW = {
  id: "ro-aaa",
  title: "A bead the board renders",
  description: "why",
  acceptance_criteria: "how we know",
  status: "open",
  priority: 1,
  issue_type: "task",
  assignee: null,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-02T00:00:00Z",
  labels: ["tower", "tasks"],
  dependencies: [
    { issue_id: "ro-aaa", depends_on_id: "ro-epic", type: "parent-child" },
    { issue_id: "ro-aaa", depends_on_id: "ro-bbb", type: "blocks" },
  ],
  comment_count: 2,
  metadata: { reindex_kind: "finding", reindex_key: "item-openers" },
  parent: "ro-epic",
};

const SECOND_ROW = { ...LIST_ROW, id: "ro-bbb", title: "Not claimable yet", parent: null };
const HUMAN_ROW = { ...LIST_ROW, labels: ["human"] };
/** A decision waiting on the operator: an answer closes it with `bd human respond`. */
const DECISION_ROW = { ...HUMAN_ROW, issue_type: "decision" };
const PICK = { question: "Which page keeps the traffic?", options: [{ key: "a", label: "Keep the old page" },
  { key: "b", label: "Redirect to the new page", recommended: true }, { key: "c", label: "Keep both" }] };

const CANNED: Record<string, string> = {
  list: JSON.stringify([LIST_ROW, SECOND_ROW]),
  ready: JSON.stringify([{ id: "ro-aaa" }]),
  show: JSON.stringify([LIST_ROW]),
  comments: JSON.stringify([
    { id: "c1", issue_id: "ro-aaa", author: "Example Operator", text: "answered", created_at: "2026-09-03T00:00:00Z" },
  ]),
  "epic status": JSON.stringify([
    {
      epic: { id: "ro-epic", title: "An epic", status: "open", priority: 1 },
      total_children: 5,
      closed_children: 2,
      eligible_for_close: false,
    },
  ]),
  create: JSON.stringify({ id: "ro-new", title: "filed", status: "open" }),
};

/** The fake. Extensionless and CommonJS, run by whatever `node` is on PATH.
 *
 * `FAKE_BD_FAIL` names a verb it should refuse, so the stderr-passthrough case
 * is `bd` failing for real rather than a stubbed return value. */
const FAKE_BD = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_BD_LOG, JSON.stringify(argv) + "\\n");
// argv is: -C <dir> <verb tokens...> <args...> --json [--actor <name>]
const one = argv[2];
const two = argv[3];
const verb = ["epic status", "comments add", "human respond", "human dismiss", "gate resolve"]
  .includes(one + " " + two)
  ? one + " " + two
  : one;
if (process.env.FAKE_BD_FAIL === verb) {
  process.stderr.write(process.env.FAKE_BD_ERROR || "bd: " + verb + " is unhappy about something\\n");
  process.exit(3);
}
if (verb === "human respond" && process.env.FAKE_BD_NIL_RESPONSE === "1") {
  process.stdout.write(JSON.stringify({error: "resolving issue ID " + argv[4] + ": cannot resolve issue ID: storage is nil", schema_version: "1"}));
  process.exit(3);
}
let canned = JSON.parse(process.env.FAKE_BD_CANNED)[verb];
if (verb === "list" && canned !== undefined) {
  // Match bd's default exclusion: a fixture gate must not appear just because
  // the fake ignored the missing --include-gates switch.
  const statuses = argv[argv.indexOf("--status") + 1].split(",");
  canned = JSON.stringify(JSON.parse(canned).filter((row) =>
    (row.issue_type !== "gate" || argv.includes("--include-gates")) &&
    statuses.includes(row.status)
  ));
}
process.stdout.write(canned === undefined ? "ok\\n" : canned);
`;

let root = "";
let binDir = "";
let logFile = "";
let previousPath = "";

const SAME_ORIGIN = {
  host: "office-mac.local:5173",
  origin: "http://office-mac.local:5173",
  "content-type": "application/json",
  "sec-fetch-site": "same-origin",
};

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "task-lane-"));
  binDir = path.join(root, "bin");
  logFile = path.join(root, "argv.log");
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "bd"), FAKE_BD, { mode: 0o755 });

  // A repo root the lane can walk to, with the spoke map it reads per request
  // and the sibling checkout the second spoke points at.
  const repo = path.join(root, "repo");
  await fs.mkdir(path.join(repo, "config"), { recursive: true });
  await fs.mkdir(path.join(root, "other.example"), { recursive: true });
  await fs.writeFile(path.join(repo, "pnpm-workspace.yaml"), "packages: []\n");
  await fs.writeFile(
    path.join(repo, "config/beads.json"),
    JSON.stringify(SPOKES, null, 2) + "\n",
  );
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "Operator Under Test"], { cwd: repo });

  previousPath = process.env.PATH ?? "";
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  process.env.FAKE_BD_LOG = logFile;
  process.env.FAKE_BD_CANNED = JSON.stringify(CANNED);
});

afterAll(async () => {
  process.env.PATH = previousPath;
  delete process.env.FAKE_BD_LOG;
  delete process.env.FAKE_BD_CANNED;
  delete process.env.FAKE_BD_FAIL;
  delete process.env.FAKE_BD_ERROR;
  delete process.env.FAKE_BD_NIL_RESPONSE;
  await fs.rm(root, { recursive: true, force: true });
});

/** The argv of every `bd` the lane spawned since the last reset. */
async function spawned(): Promise<string[][]> {
  let text = "";
  try {
    text = await fs.readFile(logFile, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as string[]);
}

async function reset(): Promise<void> {
  await fs.rm(logFile, { force: true });
  delete process.env.FAKE_BD_FAIL;
  delete process.env.FAKE_BD_ERROR;
  delete process.env.FAKE_BD_NIL_RESPONSE;
  process.env.FAKE_BD_CANNED = JSON.stringify(CANNED);
}

function repoRoot(): string {
  return path.join(root, "repo");
}

async function fixtureProjects() {
  return readSpokes(repoRoot(), {
    token: "op",
    fetchImpl: async () => Response.json({ ready: true, documents: [
      { file: "config/beads.json", version: 3, body: SPOKES },
    ] }),
    readHost: async () => JSON.stringify({ repositories: SPOKES.spokes }),
  });
}

function ask(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = SAME_ORIGIN,
) {
  return handleTasksRequest(
    { method, url, headers, body: body === undefined ? "" : JSON.stringify(body) },
    { repoRoot: repoRoot(), readProjects: fixtureProjects, actor: "test-operator", now: () => new Date("2026-09-04T12:00:00Z") },
  );
}

describe("capabilities", () => {
  it("says the lane is live, without touching bd", async () => {
    await reset();
    const reply = await ask("GET", "/api/tasks/capabilities");
    expect(reply).toEqual({ status: 200, body: { live: true, reason: null } });
    expect(await spawned()).toEqual([]);
  });
});

describe("the guards", () => {
  it("refuses a request from another origin, before any read", async () => {
    await reset();
    const reply = await ask("GET", "/api/tasks?project=root-os", undefined, {
      ...SAME_ORIGIN,
      origin: "https://elsewhere.example",
    });
    expect(reply.status).toBe(403);
    expect(reply.body).toEqual({ error: "forbidden" });
    expect(await spawned()).toEqual([]);
  });

  it("refuses a verb outside the allowlist BEFORE spawning anything", async () => {
    await reset();
    const reply = await ask("POST", "/api/tasks/ro-aaa/delete", { reason: "gone" });
    expect(reply.status).toBe(400);
    expect(reply.body.error).toBe("verb_not_allowed");
    expect(await spawned()).toEqual([]);
  });

  it("refuses an edit to a field outside the allowlist, before spawning", async () => {
    await reset();
    const reply = await ask("PATCH", "/api/tasks/ro-aaa", { metadata: { a: 1 } });
    expect(reply.status).toBe(400);
    expect(reply.body.error).toBe("field_not_allowed");
    expect(await spawned()).toEqual([]);
  });

  it("keeps `bd`'s destructive and store-level verbs out of the list entirely", () => {
    for (const verb of ["delete", "sql", "dolt", "import", "export", "federation", "backup"]) {
      expect(ALLOWED_VERBS[verb]).toBeUndefined();
    }
    expect(Object.keys(ALLOWED_VERBS).sort()).toEqual([
      "close",
      "comments",
      "comments add",
      "create",
      "dep add",
      "epic status",
      "gate resolve",
      "human dismiss",
      "human respond",
      "list",
      "ready",
      "show",
      "update",
    ]);
  });

  it("refuses a JSON-less write rather than guessing at the body", async () => {
    await reset();
    const reply = await ask("POST", "/api/tasks", { title: "x" }, { host: "office-mac.local:5173" });
    expect(reply.status).toBe(415);
    expect(await spawned()).toEqual([]);
  });
});

describe("which repo bd runs in", () => {
  it("runs in the spoke config/beads.json names for the project", async () => {
    await reset();
    const reply = await ask("GET", "/api/tasks?project=other.example");
    expect(reply.status).toBe(200);
    const dirs = (await spawned()).map((argv) => argv[1]);
    expect(dirs.length).toBeGreaterThan(0);
    expect(new Set(dirs)).toEqual(new Set([path.resolve(repoRoot(), "../other.example")]));
  });

  it("derives the spoke from the id's prefix when only an id is given", async () => {
    await reset();
    const reply = await ask("GET", "/api/tasks/ro-aaa");
    expect(reply.status).toBe(200);
    for (const argv of await spawned()) {
      expect(argv.slice(0, 2)).toEqual(["-C", path.resolve(repoRoot(), ".")]);
    }
  });

  it("404s a project no spoke owns, and names the ones that exist", async () => {
    await reset();
    const reply = await ask("GET", "/api/tasks?project=nope.example");
    expect(reply.status).toBe(404);
    expect(reply.body.error).toBe("unknown_project");
    expect(String(reply.body.detail)).toContain("other.example");
    // The door to the fix is the page that edits the projects, never a file.
    expect(String(reply.body.detail)).toContain("Settings → Task projects");
    expect(String(reply.body.detail)).not.toContain("config/beads.json");
    expect(await spawned()).toEqual([]);
  });

  it("404s an id whose prefix no spoke owns", async () => {
    await reset();
    const reply = await ask("GET", "/api/tasks/zz-9999");
    expect(reply.status).toBe(404);
    expect(reply.body.error).toBe("unknown_project");
    expect(String(reply.body.detail)).toContain("Settings → Task projects");
    expect(String(reply.body.detail)).not.toContain("config/beads.json");
    expect(await spawned()).toEqual([]);
  });
});

describe("the reads", () => {
  it("asks bd for JSON, unlimited, and marks the rows bd calls ready", async () => {
    await reset();
    const reply = await ask("GET", "/api/tasks?project=root-os");
    expect(reply.status).toBe(200);

    const calls = await spawned();
    // Active list + complete date-bounded closed list + ready + epic status.
    expect(calls).toHaveLength(4);
    for (const argv of calls) {
      expect(argv).toContain("--json");
      expect(argv).not.toContain("--actor");
    }
    expect(calls.some((argv) => argv.includes("list") && argv.includes("--limit"))).toBe(true);

    const payload = reply.body as unknown as {
      project: string;
      tasks: { id: string; ready: boolean; comments: number; labels: string[]; parent: string | null }[];
      epics: { id: string; total: number; closed: number }[] | null;
    };
    expect(payload.project).toBe("root-os");
    expect(payload.tasks.map((task) => [task.id, task.ready])).toEqual([
      ["ro-aaa", true],
      ["ro-bbb", false],
    ]);
    expect(payload.tasks[0]?.comments).toBe(2);
    expect(payload.tasks[0]?.labels).toEqual(["tower", "tasks"]);
    expect(payload.epics).toEqual([
      {
        id: "ro-epic",
        title: "An epic",
        status: "open",
        priority: 1,
        total: 5,
        closed: 2,
        eligibleForClose: false,
      },
    ]);
  });

  it("still answers when bd cannot group by epic — flat, not failed", async () => {
    await reset();
    process.env.FAKE_BD_FAIL = "epic status";
    const reply = await ask("GET", "/api/tasks?project=root-os");
    expect(reply.status).toBe(200);
    expect((reply.body as { epics: unknown }).epics).toBeNull();
    expect((reply.body as { tasks: unknown[] }).tasks).toHaveLength(2);
  });

  it.each([
    { status: undefined, ids: ["ro-aaa", "ro-human", "ro-timer", "ro-resolved"] },
    { status: "open", ids: ["ro-aaa", "ro-human", "ro-timer"] },
    { status: "closed", ids: ["ro-resolved"] },
  ])("includes gates without changing the $status status filter or their types", async ({ status, ids }) => {
    await reset();
    const human = {
      id: "ro-human", title: "Gate: human", description: "Reason: Confirm the decision.",
      status: "open", priority: 2, issue_type: "gate", await_type: "human",
      created_at: "2026-08-05T01:45:22Z", updated_at: "2026-08-05T01:45:22Z",
    };
    process.env.FAKE_BD_CANNED = JSON.stringify({
      ...CANNED,
      list: JSON.stringify([
        LIST_ROW,
        human,
        { ...human, id: "ro-timer", title: "Gate: timer", await_type: "timer" },
        { ...human, id: "ro-resolved", status: "closed", closed_at: "2026-09-03T09:00:00Z" },
        { ...human, id: "ro-old", status: "closed", closed_at: "2026-08-01T00:00:00Z" },
      ]),
    });

    const reply = await ask("GET", `/api/tasks?project=root-os${status === undefined ? "" : `&status=${status}`}`);
    expect(reply.status).toBe(200);
    const tasks = reply.body.tasks as { id: string; issueType: string; awaitType: string | null; ready: boolean; description: string }[];
    expect(tasks.map((task) => task.id)).toEqual(ids);
    for (const task of tasks.filter((task) => task.id !== "ro-aaa")) {
      expect(task.issueType).toBe("gate");
      expect(task.awaitType).toBe(task.id === "ro-timer" ? "timer" : "human");
      expect(task.ready).toBe(false);
      // Only the open human gate waits on the operator, so only its ask's text
      // rides the list; the others' is on their own read.
      expect(task.description).toBe(task.id === "ro-human" ? "Reason: Confirm the decision." : "");
    }
    const lists = (await spawned()).filter((argv) => argv[2] === "list");
    expect(lists).toHaveLength(status === undefined ? 2 : 1);
    for (const argv of lists) {
      expect(argv).toContain("--include-gates");
      expect(argv[argv.indexOf("--limit") + 1]).toBe("0");
      expect(argv).not.toContain("--actor");
      if (status !== undefined) expect(argv[argv.indexOf("--status") + 1]).toBe(status);
    }
    const closed = lists.find((argv) => argv.includes("--closed-after"));
    if (status !== "open") {
      expect(closed?.[closed.indexOf("--closed-after") + 1]).toBe("2026-08-28");
      expect(closed?.[closed.indexOf("--closed-before") + 1]).toBe("2026-09-04T12:00:00.000Z");
    }
  });

  it("carries a task's description and acceptance in a list only when it waits on the operator; its own read always does", async () => {
    await reset();
    process.env.FAKE_BD_CANNED = JSON.stringify({
      ...CANNED,
      list: JSON.stringify([LIST_ROW, { ...LIST_ROW, id: "ro-ask", labels: ["human"], description: "Pick the launch date", acceptance_criteria: "A date is chosen" }]),
      ready: JSON.stringify([{ id: "ro-aaa" }, { id: "ro-ask" }]),
    });
    const list = await ask("GET", "/api/tasks?project=root-os&status=open");
    const tasks = list.body.tasks as { id: string; description: string; acceptance: string }[];
    expect(tasks.find((task) => task.id === "ro-aaa")).toMatchObject({ description: "", acceptance: "" });
    expect(tasks.find((task) => task.id === "ro-ask")).toMatchObject({ description: "Pick the launch date", acceptance: "A date is chosen" });
    const own = await ask("GET", "/api/tasks/ro-aaa");
    expect((own.body as unknown as { task: { description: string } }).task.description).toBe("why");
  });

  it("returns one task with its conversation", async () => {
    await reset();
    const reply = await ask("GET", "/api/tasks/ro-aaa");
    expect(reply.status).toBe(200);
    const detail = reply.body as unknown as {
      task: { id: string; description: string; acceptance: string; dependencies: unknown[] };
      comments: { author: string; text: string }[];
    };
    expect(detail.task.id).toBe("ro-aaa");
    expect(detail.task.acceptance).toBe("how we know");
    expect(detail.comments).toEqual([
      { id: "c1", author: "Example Operator", text: "answered", createdAt: "2026-09-03T00:00:00.000Z" },
    ]);
  });

  it("refuses a status filter that is not a status list", async () => {
    await reset();
    const reply = await ask("GET", "/api/tasks?project=root-os&status=open;rm%20-rf");
    expect(reply.status).toBe(422);
    expect(reply.body.error).toBe("invalid_status");
    expect(await spawned()).toEqual([]);
  });

  it("reads every closure in the same bounded window, not the snapshot's five-row head", async () => {
    const calls: string[][] = [];
    const closed = Array.from({ length: 60 }, (_, index) => ({
      ...LIST_ROW,
      id: `ro-done${index}`,
      status: "closed",
      closed_at: "2026-09-03T09:00:00Z",
    }));
    // Normalization must include the lower boundary even when its source date
    // is yesterday in a negative UTC offset.
    closed[0]!.closed_at = "2026-08-27T17:00:00-07:00";
    const reply = await handleTasksRequest(
      { method: "GET", url: "/api/tasks?project=root-os", headers: SAME_ORIGIN, body: "" },
      {
        repoRoot: repoRoot(), readProjects: fixtureProjects,
        now: () => new Date("2026-09-04T12:00:00Z"),
        run: (argv) => {
          calls.push(argv);
          const isList = argv[2] === "list";
          const isClosed = argv[argv.indexOf("--status") + 1] === "closed";
          const output = isList ? isClosed ? [
            ...closed,
            { ...closed[0], id: "ro-old", closed_at: "2026-08-27T23:59:59Z" },
            { ...closed[0], id: "ro-old-offset", closed_at: "2026-08-28T00:59:59+01:00" },
            { ...closed[0], id: "ro-future", closed_at: "2026-09-05T00:00:00Z" },
            { ...closed[0], id: "ro-invalid-date", closed_at: "unparseable" },
          ] : [LIST_ROW] : [];
          return { code: 0, stdout: JSON.stringify(output), stderr: "" };
        },
      },
    );
    expect(reply.status).toBe(200);
    expect(reply.body.closedSince).toBe("2026-08-28");
    const tasks = reply.body.tasks as { id: string; status: string }[];
    expect(tasks).toHaveLength(61);
    expect(tasks.filter((task) => task.status === "closed")).toHaveLength(60);
    const command = calls.find((argv) => argv.includes("--closed-after"))!;
    expect(command).toContain("2026-08-28");
    expect(command).toContain("2026-09-04T12:00:00.000Z");
    expect(command[command.indexOf("--limit") + 1]).toBe("0");
  });

  it.each(["unreadable", "failed"])("fails the complete read when closed history is %s", async (failure) => {
    const reply = await handleTasksRequest(
      { method: "GET", url: "/api/tasks?project=root-os", headers: SAME_ORIGIN, body: "" },
      {
        repoRoot: repoRoot(), readProjects: fixtureProjects,
        run: (argv) => argv.includes("--closed-after")
          ? { code: failure === "failed" ? 1 : 0, stdout: "not JSON", stderr: "closed query failed" }
          : { code: 0, stdout: "[]", stderr: "" },
      },
    );
    expect(reply.status).toBe(502);
    expect(reply.body).not.toHaveProperty("tasks");
  });
});

describe("the writes", () => {
  it("files a task and answers with the id the hub minted", async () => {
    await reset();
    const reply = await ask("POST", "/api/tasks", {
      project: "root-os",
      title: "Filed from the Tower",
      description: "why",
      type: "task",
      priority: 1,
      labels: ["tower", "tasks"],
      parent: "ro-epic",
      acceptance: "how we know",
      metadata: { reindex_key: "item-openers" },
    });
    expect(reply).toEqual({ status: 201, body: { id: "ro-new", project: "root-os" } });

    const [argv] = await spawned();
    expect(argv?.slice(0, 4)).toEqual(["-C", repoRoot(), "create", "Filed from the Tower"]);
    expect(argv).toContain("--description");
    expect(argv).toContain("--labels");
    expect(argv?.[argv.indexOf("--labels") + 1]).toBe("tower,tasks");
    expect(argv?.[argv.indexOf("--metadata") + 1]).toBe('{"reindex_key":"item-openers"}');
    // A child carries only its own labels, never its parent's human label.
    expect(argv?.slice(argv.indexOf("--parent"), argv.indexOf("--parent") + 3)).toEqual(["--parent", "ro-epic", "--no-inherit-labels"]);
  });

  it("claims atomically, with --claim rather than two field writes", async () => {
    await reset();
    const reply = await ask("PATCH", "/api/tasks/ro-aaa", { claim: true });
    expect(reply.status).toBe(200);
    const [argv] = await spawned();
    expect(argv?.slice(0, 5)).toEqual(["-C", repoRoot(), "update", "ro-aaa", "--claim"]);
  });

  it("maps each allowlisted edit onto its own bd flag", async () => {
    await reset();
    await ask("PATCH", "/api/tasks/ro-aaa", {
      priority: 0,
      defer: "+1w",
      addLabels: ["blocked-on-operator"],
      removeLabels: ["stale"],
    });
    const [argv] = await spawned();
    expect(argv?.[argv.indexOf("--priority") + 1]).toBe("0");
    expect(argv?.[argv.indexOf("--defer") + 1]).toBe("+1w");
    expect(argv?.[argv.indexOf("--add-label") + 1]).toBe("blocked-on-operator");
    expect(argv?.[argv.indexOf("--remove-label") + 1]).toBe("stale");
  });

  it("will not close a bead without the evidence that closes it", async () => {
    await reset();
    const reply = await ask("POST", "/api/tasks/ro-aaa/close", {});
    expect(reply.status).toBe(422);
    expect(await spawned()).toEqual([]);
  });

  it("closes with the reason, comments, answers a decision and declines", async () => {
    await reset();
    process.env.FAKE_BD_CANNED = JSON.stringify({ ...CANNED, show: JSON.stringify([DECISION_ROW]) });
    await ask("POST", "/api/tasks/ro-aaa/close", { reason: "abc1234: done" });
    await ask("POST", "/api/tasks/ro-aaa/comments", { text: "a note" });
    await ask("POST", "/api/tasks/ro-aaa/respond", { response: "use OAuth2" });
    await ask("POST", "/api/tasks/ro-aaa/dismiss", { reason: "not applicable" });
    await ask("POST", "/api/gates/ro-5n5/resolve", { reason: "key added" });

    const calls = await spawned();
    expect(calls.map((argv) => argv.slice(2, 5))).toEqual([
      ["close", "ro-aaa", "--reason"],
      ["comments", "add", "ro-aaa"],
      ["show", "ro-aaa", "--json"],
      ["human", "respond", "ro-aaa"],
      ["human", "dismiss", "ro-aaa"],
      // The dismissal's close time, read for its record; this one is not closed, so nothing is written.
      ["show", "ro-aaa", "--json"],
      ["gate", "resolve", "ro-5n5"],
    ]);
  });

  it("records a dismissed ask as closed as won't do by the operator who dismissed it", async () => {
    await reset();
    const closedAt = "2026-10-17T12:00:00Z";
    process.env.FAKE_BD_CANNED = JSON.stringify({ ...CANNED, show: JSON.stringify([{ ...HUMAN_ROW, status: "closed", closed_at: closedAt }]) });
    expect((await ask("POST", "/api/tasks/ro-aaa/dismiss", {})).status).toBe(200);
    const calls = (await spawned()).map((argv) => argv.slice(2));
    expect(calls.map((argv) => argv.slice(0, 2))).toEqual([["human", "dismiss"], ["show", "ro-aaa"], ["update", "ro-aaa"]]);
    expect(JSON.parse(calls[2]?.[3] ?? "{}")).toEqual({ noticeos_closed_by: "test-operator", noticeos_closed_at: closedAt,
      noticeos_resolution: "wont-do" });

    // Another resolution for what was declined, and a duplicate linked first; a dismissal is never done.
    await reset();
    process.env.FAKE_BD_CANNED = JSON.stringify({ ...CANNED, show: JSON.stringify([{ ...SECOND_ROW, status: "closed", closed_at: closedAt }]) });
    expect((await ask("POST", "/api/tasks/ro-aaa/dismiss", { reason: "Asked twice", resolution: "duplicate", duplicateOf: "ro-bbb" })).status)
      .toBe(200);
    expect((await spawned()).map((argv) => argv.slice(2, 4))).toEqual([["show", "ro-bbb"], ["dep", "add"], ["human", "dismiss"], ["show", "ro-aaa"]]);
    await reset();
    expect((await ask("POST", "/api/tasks/ro-aaa/dismiss", { resolution: "done" })).status).toBe(422);
    expect(await spawned()).toEqual([]);
  });

  it("closes with a resolution, the reason as given, and a duplicate linked to the task it names", async () => {
    const closedAt = "2026-10-17T12:00:00Z";
    const closing = { ...CANNED, close: JSON.stringify([{ ...LIST_ROW, status: "closed", closed_at: closedAt }]) };
    await reset();
    process.env.FAKE_BD_CANNED = JSON.stringify(closing);
    expect((await ask("POST", "/api/tasks/ro-aaa/close", { reason: "Nobody asked for it", resolution: "wont-do" })).status).toBe(200);
    const plain = (await spawned()).map((argv) => argv.slice(2));
    expect(plain[0]).toEqual(["close", "ro-aaa", "--reason", "Nobody asked for it", "--json", "--actor", "test-operator"]);
    expect(JSON.parse(plain[1]?.[3] ?? "{}")).toEqual({ noticeos_closed_by: "test-operator", noticeos_closed_at: closedAt,
      noticeos_resolution: "wont-do" });

    await reset();
    // The other task is read first: a show of it answers with it.
    process.env.FAKE_BD_CANNED = JSON.stringify({ ...closing, show: JSON.stringify([SECOND_ROW]) });
    expect((await ask("POST", "/api/tasks/ro-aaa/close", { reason: "Same work as ro-bbb", resolution: "duplicate", duplicateOf: "ro-bbb" })).status)
      .toBe(200);
    const duplicate = (await spawned()).map((argv) => argv.slice(2));
    expect(duplicate.map((argv) => argv.slice(0, 2))).toEqual([["show", "ro-bbb"], ["dep", "add"], ["close", "ro-aaa"], ["update", "ro-aaa"]]);
    expect(duplicate[1]).toEqual(["dep", "add", "ro-aaa", "ro-bbb", "--type", "related", "--json", "--actor", "test-operator"]);
    expect(JSON.parse(duplicate[3]?.[3] ?? "{}")).toEqual({ noticeos_closed_by: "test-operator", noticeos_closed_at: closedAt,
      noticeos_resolution: "duplicate", noticeos_duplicate_of: "ro-bbb" });
  });

  it("refuses a close's resolution with its cause named, before writing anything", async () => {
    for (const [body, status, detail] of [
      [{ reason: "x", resolution: "fixed" }, 422, "resolution is one of done, wont-do, duplicate, cant-reproduce, already-handled"],
      [{ reason: "x", resolution: "duplicate" }, 422, "duplicateOf is required with resolution duplicate"],
      [{ reason: "x", resolution: "wont-do", duplicateOf: "ro-bbb" }, 422, "duplicateOf goes with resolution duplicate only"],
      [{ reason: "x", resolution: "duplicate", duplicateOf: "ro-aaa" }, 422, "duplicateOf is the id of another task"],
      [{ reason: "x", resolution: "duplicate", duplicateOf: "ox-111" }, 409, "ox-111 is not a task in this project, whose tasks start ro-."],
    ] as const) {
      await reset();
      const reply = await ask("POST", "/api/tasks/ro-aaa/close", body);
      expect(reply).toEqual({ status, body: { error: status === 409 ? "task_refused" : "invalid_body", detail } });
      expect(await spawned()).toEqual([]);
    }
    // A task this project does not hold is read and refused.
    await reset();
    process.env.FAKE_BD_FAIL = "show";
    try {
      expect(await ask("POST", "/api/tasks/ro-aaa/close", { reason: "x", resolution: "duplicate", duplicateOf: "ro-zzz" }))
        .toEqual({ status: 409, body: { error: "task_refused", detail: "ro-zzz is not a task in this project." } });
    } finally {
      delete process.env.FAKE_BD_FAIL;
    }
    expect((await spawned()).map((argv) => argv[2])).toEqual(["show"]);
  });

  it("hands a task that is not a decision back to ready work with the answer as a comment", async () => {
    await reset();
    process.env.FAKE_BD_CANNED = JSON.stringify({ ...CANNED, show: JSON.stringify([{ ...HUMAN_ROW, status: "in_progress", assignee: "claude" }]) });
    const reply = await ask("POST", "/api/tasks/ro-aaa/respond", { response: "use OAuth2" });
    expect(reply.status).toBe(200);
    expect((await spawned()).map((argv) => argv.slice(2))).toEqual([
      ["show", "ro-aaa", "--json"],
      ["comments", "add", "ro-aaa", "Answered: use OAuth2", "--json", "--actor", "test-operator"],
      ["update", "ro-aaa", "--status", "open", "--assignee", "", "--if-assignee", "claude", "--remove-label", "human", "--json", "--actor", "test-operator"],
    ]);

    // A task nobody asked the operator about takes no answer, and nothing is written.
    await reset();
    const refused = await ask("POST", "/api/tasks/ro-aaa/respond", { response: "use OAuth2" });
    expect(refused).toEqual({ status: 409, body: { error: "task_refused", detail: "ro-aaa is not waiting on your answer." } });
    expect((await spawned()).map((argv) => argv[2])).toEqual(["show"]);
  });

  it("records a pick, comments it and hands the task back; a decision closes on it", async () => {
    await reset();
    process.env.FAKE_BD_CANNED = JSON.stringify({ ...CANNED, show: JSON.stringify([{ ...HUMAN_ROW, metadata: { noticeos_choices: PICK } }]) });
    const reply = await ask("POST", "/api/tasks/ro-aaa/choose", { option: "b", note: "Ship it Friday" });
    expect(reply).toEqual({ status: 200, body: { id: "ro-aaa", project: "root-os" } });
    const calls = (await spawned()).map((argv) => argv.slice(2));
    expect(calls.map((argv) => argv.slice(0, 2))).toEqual([["show", "ro-aaa"], ["comments", "ro-aaa"], ["update", "ro-aaa"],
      ["comments", "add"], ["update", "ro-aaa"]]);
    expect(calls[0]).toContain("--include-dependents");
    expect(JSON.parse(calls[2]?.[calls[2].indexOf("--metadata") + 1] ?? "{}")).toEqual({ noticeos_choice: { option: "b",
      label: "Redirect to the new page", by: "test-operator", at: "2026-09-04T12:00:00.000Z", note: "Ship it Friday" } });
    expect(calls[3]).toEqual(["comments", "add", "ro-aaa", "Chose (b) Redirect to the new page. Ship it Friday", "--json", "--actor", "test-operator"]);
    expect(calls[4]).toEqual(["update", "ro-aaa", "--status", "open", "--assignee", "", "--if-assignee", "", "--remove-label", "human",
      "--json", "--actor", "test-operator"]);

    await reset();
    const closedAt = "2026-09-04T12:00:01Z";
    // As `bd show` embeds a dependency: the whole task, with the edge's type. An open blocker is closed past.
    process.env.FAKE_BD_CANNED = JSON.stringify({ ...CANNED, show: JSON.stringify([{ ...DECISION_ROW, metadata: { noticeos_choices: PICK },
      dependencies: [{ id: "ro-bbb", status: "open", issue_type: "task", dependency_type: "blocks" }] }]),
      close: JSON.stringify([{ ...DECISION_ROW, status: "closed", closed_at: closedAt }]) });
    expect((await ask("POST", "/api/tasks/ro-aaa/choose", { option: "c" })).status).toBe(200);
    const decided = (await spawned()).map((argv) => argv.slice(2));
    expect(decided.map((argv) => argv[0])).toEqual(["show", "comments", "update", "comments", "close", "update"]);
    expect(decided[4]).toEqual(["close", "ro-aaa", "--reason", "Chose (c) Keep both", "--force", "--json", "--actor", "test-operator"]);
    expect(JSON.parse(decided[5]?.[3] ?? "{}")).toEqual({ noticeos_closed_by: "test-operator", noticeos_closed_at: closedAt,
      noticeos_resolution: "done" });
  });

  it("refuses a pick with its cause named, before writing anything", async () => {
    const chosen = { option: "b", label: "Redirect to the new page", by: "someone-else", at: "2026-09-01T00:00:00Z" };
    for (const [row, body, status, detail] of [
      [HUMAN_ROW, { option: "a" }, 409, "ro-aaa offers no options to choose from."],
      [{ ...HUMAN_ROW, metadata: { noticeos_choices: PICK } }, { option: "e" }, 409, "ro-aaa offers (a), (b) and (c), not (e)."],
      [{ ...HUMAN_ROW, metadata: { noticeos_choices: PICK, noticeos_choice: chosen } }, { option: "b" }, 409, "ro-aaa already has a choice: (b) Redirect to the new page."],
      [{ ...HUMAN_ROW, status: "closed", metadata: { noticeos_choices: PICK } }, { option: "b" }, 409, "ro-aaa is already closed."],
    ] as const) {
      await reset();
      process.env.FAKE_BD_CANNED = JSON.stringify({ ...CANNED, show: JSON.stringify([row]) });
      expect(await ask("POST", "/api/tasks/ro-aaa/choose", body)).toEqual({ status, body: { error: "task_refused", detail } });
      expect((await spawned()).map((argv) => argv[2])).toEqual(["show", "comments"]);
    }
    for (const body of [{}, { option: "z" }, { option: 2 }]) {
      await reset();
      expect((await ask("POST", "/api/tasks/ro-aaa/choose", body)).status).toBe(422);
      expect(await spawned()).toEqual([]);
    }
  });

  it("records who closed a task after the close, and the close stands without it", async () => {
    await reset();
    const closedAt = "2026-10-15T16:00:00Z";
    process.env.FAKE_BD_CANNED = JSON.stringify({ ...CANNED, close: JSON.stringify([{ ...LIST_ROW, status: "closed", closed_at: closedAt }]) });
    await ask("POST", "/api/tasks/ro-aaa/close", { reason: "abc1234: done" });
    const [close, record] = await spawned();
    expect(close?.slice(2, 4)).toEqual(["close", "ro-aaa"]);
    expect(record?.slice(2, 5)).toEqual(["update", "ro-aaa", "--metadata"]);
    expect(JSON.parse(record?.[5] ?? "{}")).toEqual({ noticeos_closed_by: "test-operator", noticeos_closed_at: closedAt,
      noticeos_resolution: "done" });
    expect(record?.[record.indexOf("--actor") + 1]).toBe("test-operator");

    await reset();
    process.env.FAKE_BD_CANNED = JSON.stringify({ ...CANNED, close: JSON.stringify([{ ...LIST_ROW, status: "closed", closed_at: closedAt }]) });
    process.env.FAKE_BD_FAIL = "update";
    try {
      expect((await ask("POST", "/api/tasks/ro-aaa/close", { reason: "abc1234: done" })).status).toBe(200);
    } finally {
      delete process.env.FAKE_BD_FAIL;
    }
  });

  it("reads eight weeks of closed work only when a closed-only read asks", async () => {
    await reset();
    const reply = await ask("GET", "/api/tasks?project=root-os&status=closed&closedDays=56");
    expect(reply.status).toBe(200);
    const calls = await spawned();
    expect(calls.map((argv) => argv[2])).toEqual(["list"]);
    const since = calls[0]?.[calls[0].indexOf("--closed-after") + 1];
    expect(since).toBe(reply.body.closedSince);
    for (const query of ["closedDays=56", "status=open,closed&closedDays=56", "status=closed&closedDays=57", "status=closed&closedDays=0"]) {
      expect((await ask("GET", `/api/tasks?project=root-os&${query}`)).status, query).toBe(422);
    }
  });

  it("names the operator on EVERY write, and on no read", async () => {
    await reset();
    process.env.FAKE_BD_CANNED = JSON.stringify({ ...CANNED, show: JSON.stringify([DECISION_ROW]) });
    await ask("POST", "/api/tasks", { project: "root-os", title: "t" });
    await ask("PATCH", "/api/tasks/ro-aaa", { claim: true });
    await ask("POST", "/api/tasks/ro-aaa/close", { reason: "r" });
    await ask("POST", "/api/tasks/ro-aaa/comments", { text: "c" });
    await ask("POST", "/api/tasks/ro-aaa/respond", { response: "r" });
    await ask("POST", "/api/tasks/ro-aaa/dismiss", {});
    await ask("POST", "/api/gates/ro-5n5/resolve", {});

    const calls = await spawned();
    // An answer reads its task first, to tell a decision from a task that goes back to ready work,
    // and a dismissal reads its close time after.
    const reads = calls.filter((argv) => argv[2] === "show");
    expect(reads).toHaveLength(2);
    for (const argv of reads) expect(argv).not.toContain("--actor");
    const writes = calls.filter((argv) => argv[2] !== "show");
    expect(writes).toHaveLength(7);
    for (const argv of writes) {
      expect(argv[argv.indexOf("--actor") + 1]).toBe("test-operator");
    }

    await reset();
    await ask("GET", "/api/tasks?project=root-os");
    for (const argv of await spawned()) {
      expect(argv).not.toContain("--actor");
    }
  });

  it("defaults the actor to the checkout's own git identity", async () => {
    await reset();
    await handleTasksRequest(
      {
        method: "PATCH",
        url: "/api/tasks/ro-aaa",
        headers: SAME_ORIGIN,
        body: JSON.stringify({ claim: true }),
      },
      { repoRoot: repoRoot(), readProjects: fixtureProjects },
    );
    const [argv] = await spawned();
    expect(argv?.[argv.indexOf("--actor") + 1]).toBe("Operator Under Test");
  });

  it("logs one line per write, and none per read", async () => {
    await reset();
    const lines: string[] = [];
    const options = { repoRoot: repoRoot(), readProjects: fixtureProjects, actor: "test-operator", log: (line: string) => lines.push(line) };
    await handleTasksRequest(
      { method: "GET", url: "/api/tasks?project=root-os", headers: SAME_ORIGIN, body: "" },
      options,
    );
    expect(lines).toEqual([]);
    await handleTasksRequest(
      {
        method: "POST",
        url: "/api/tasks/ro-aaa/close",
        headers: SAME_ORIGIN,
        body: JSON.stringify({ reason: "abc1234" }),
      },
      options,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("root-os");
    expect(lines[0]).toContain("test-operator");
  });
});

describe("when bd refuses", () => {
  it("records and closes a server-mode human response with the same operator and project", async () => {
    await reset();
    process.env.FAKE_BD_NIL_RESPONSE = "1";
    process.env.FAKE_BD_CANNED = JSON.stringify({ ...CANNED, show: JSON.stringify([DECISION_ROW]) });
    const reply = await ask("POST", "/api/tasks/ro-aaa/respond", { response: "Use the chosen option" });
    expect(reply.status).toBe(200);
    const calls = await spawned();
    expect(calls.map(argv => argv.slice(2))).toEqual([
      ["show", "ro-aaa", "--json"],
      ["human", "respond", "ro-aaa", "--response", "Use the chosen option", "--json", "--actor", "test-operator"],
      ["show", "ro-aaa", "--json"],
      ["comments", "add", "ro-aaa", "Response: Use the chosen option", "--json", "--actor", "test-operator"],
      ["close", "ro-aaa", "--reason", "Responded", "--json", "--actor", "test-operator"],
    ]);
    for (const argv of calls) expect(argv.slice(0, 2)).toEqual(["-C", repoRoot()]);
    for (const argv of calls.filter(argv => argv[2] !== "show")) expect(argv.slice(-2)).toEqual(["--actor", "test-operator"]);
    for (const argv of calls.filter(argv => argv[2] === "show")) expect(argv).not.toContain("--actor");
  });

  it("does not replay a response for another native failure", async () => {
    for (const error of [
      "adding comment: unavailable",
      "closing bead: unavailable",
      "cannot resolve issue ID: storage is nil",
      "resolving issue ID ro-other: cannot resolve issue ID: storage is nil",
      "resolving issue ID ro-aaa: cannot resolve issue ID: storage is nil\nadding comment: unavailable",
    ]) {
      await reset();
      process.env.FAKE_BD_CANNED = JSON.stringify({ ...CANNED, show: JSON.stringify([DECISION_ROW]) });
      process.env.FAKE_BD_FAIL = "human respond";
      process.env.FAKE_BD_ERROR = error;
      expect((await ask("POST", "/api/tasks/ro-aaa/respond", { response: "An answer" })).status).toBe(502);
      expect((await spawned()).map(argv => argv[2])).toEqual(["show", "human"]);
    }
  });

  it("keeps the checkout's operator on each fallback write for an active human task", async () => {
    for (const status of ["open", "in_progress", "blocked", "deferred"]) {
      await reset();
      process.env.FAKE_BD_NIL_RESPONSE = "1";
      process.env.FAKE_BD_CANNED = JSON.stringify({ ...CANNED, show: JSON.stringify([{ ...DECISION_ROW, status }]) });
      const reply = await handleTasksRequest(
        { method: "POST", url: "/api/tasks/ro-aaa/respond", headers: SAME_ORIGIN, body: JSON.stringify({ response: "An answer" }) },
        { repoRoot: repoRoot(), readProjects: fixtureProjects },
      );
      expect(reply.status).toBe(200);
      const calls = await spawned();
      expect(calls.filter(argv => argv[2] !== "show").map(argv => argv.slice(-2)))
        .toEqual(Array(3).fill(["--actor", "Operator Under Test"]));
    }
  });

  it("refuses a closed or unreadable task before fallback writes", async () => {
    // A decision the fallback's own read finds no longer active.
    for (const shown of [
      [{ ...DECISION_ROW, status: "closed" }], [{ ...DECISION_ROW, labels: undefined }], [{ ...DECISION_ROW, labels: "human" }],
      [{ ...DECISION_ROW, labels: ["ui"] }], [{ ...DECISION_ROW, status: "unknown" }], [{ ...DECISION_ROW, status: undefined }],
    ]) {
      await reset();
      process.env.FAKE_BD_NIL_RESPONSE = "1";
      process.env.FAKE_BD_CANNED = JSON.stringify({ ...CANNED, show: JSON.stringify(shown) });
      expect((await ask("POST", "/api/tasks/ro-aaa/respond", { response: "An answer" })).status).toBe(502);
      expect((await spawned()).map(argv => argv[2])).toEqual(["show", "human", "show"]);
    }
    // A task the first read cannot place takes no answer at all.
    for (const shown of [[], [{ ...DECISION_ROW, id: "ox-other" }], [{ ...DECISION_ROW, id: "ro-other" }], "not JSON"]) {
      await reset();
      process.env.FAKE_BD_NIL_RESPONSE = "1";
      process.env.FAKE_BD_CANNED = JSON.stringify({ ...CANNED, show: typeof shown === "string" ? shown : JSON.stringify(shown) });
      expect((await ask("POST", "/api/tasks/ro-aaa/respond", { response: "An answer" })).status).toBe(502);
      expect((await spawned()).map(argv => argv[2])).toEqual(["show"]);
    }
  });

  it("stops before any write when the task read fails", async () => {
    await reset();
    process.env.FAKE_BD_NIL_RESPONSE = "1";
    process.env.FAKE_BD_FAIL = "show";
    expect((await ask("POST", "/api/tasks/ro-aaa/respond", { response: "An answer" })).status).toBe(502);
    expect((await spawned()).map(argv => argv[2])).toEqual(["show"]);
  });

  it("does not close after a failed comment or replay a saved comment after a failed close", async () => {
    for (const failing of ["comments add", "close"]) {
      await reset();
      process.env.FAKE_BD_NIL_RESPONSE = "1";
      process.env.FAKE_BD_CANNED = JSON.stringify({ ...CANNED, show: JSON.stringify([DECISION_ROW]) });
      process.env.FAKE_BD_FAIL = failing;
      const reply = await ask("POST", "/api/tasks/ro-aaa/respond", { response: "An answer" });
      expect(reply.status).toBe(502);
      const calls = await spawned();
      expect(calls.filter(argv => argv[2] === "comments" && argv[3] === "add")).toHaveLength(1);
      expect(calls.filter(argv => argv[2] === "close")).toHaveLength(failing === "close" ? 1 : 0);
      if (failing === "close") expect(reply.body.detail).toContain("Response saved; closing failed.");
    }
  });

  it("hands back bd's own words rather than a sentence written here", async () => {
    await reset();
    process.env.FAKE_BD_FAIL = "close";
    const reply = await ask("POST", "/api/tasks/ro-aaa/close", { reason: "abc1234" });
    expect(reply.status).toBe(502);
    expect(reply.body).toEqual({
      error: "bd_failed",
      detail: "bd: close is unhappy about something",
    });
  });

  it("fails the whole board read when the list itself cannot be read", async () => {
    await reset();
    process.env.FAKE_BD_FAIL = "list";
    const reply = await ask("GET", "/api/tasks?project=root-os");
    expect(reply.status).toBe(502);
    expect(String(reply.body.detail)).toContain("list is unhappy");
  });
});

describe("the pieces underneath", () => {
  it("the actual native plugin passes trusted demo sandbox to real read children, with ordinary argv unchanged", async () => {
    const own = await fs.mkdtemp(path.join(os.tmpdir(), "noticeos-demo-task-args-"));
    try {
      const binary = path.join(own, "bd");
      const log = path.join(own, "args.jsonl");
      await fs.writeFile(binary, `#!${process.execPath}\nconst fs=require('node:fs'); const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n'); console.log(JSON.stringify(args.includes('show')?${JSON.stringify([LIST_ROW])}:[]));\n`, { mode: 0o700 });
      vi.stubEnv("PATH", own); vi.stubEnv("HOME", own);
      const viewer = { version: 1 as const, synthetic: true as const, release: "1".repeat(40), scenarioHash: "2".repeat(64),
        workspaceId: "11111111-1111-4111-8111-111111111111", cutoff: "2025-10-16T12:00:00.000Z", generatedAt: null };
      for (const demoViewer of [null, viewer, null]) {
        await fs.writeFile(log, "");
        const server = await createTestViteServer(createServer, { configFile: false, root: own, logLevel: "silent",
          plugins: [taskLane({ demoViewer, repoRoot: own, readProjects: async () => [{ asset: "root-os", prefix: "ro", database: "ro", repo: own }] })],
          server: { host: "127.0.0.1", port: 0, strictPort: true } }, { pages: false });
        try {
          await server.listen();
          const address = server.httpServer?.address();
          if (!address || typeof address === "string") throw new Error("Missing owned test listener");
          const response = await fetch(`http://127.0.0.1:${address.port}/api/tasks/ro-aaa`, { signal: AbortSignal.timeout(5000) });
          expect(response.status).toBe(200);
          const calls = (await fs.readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
          expect(calls.length).toBeGreaterThan(0);
          for (const args of calls) {
            expect(args.includes("--sandbox")).toBe(demoViewer !== null);
            expect(args.filter(arg => arg === "--sandbox")).toHaveLength(demoViewer === null ? 0 : 1);
            expect(args.includes("--actor")).toBe(false);
          }
        } finally { await server.close(); }
      }
    } finally { vi.unstubAllEnvs(); await fs.rm(own, { recursive: true, force: true }); }
  });

  it("runs the real bd child with only its declared task profile and private client HOME", async () => {
    const own = await fs.mkdtemp(path.join(os.tmpdir(), "noticeos-task-child-env-"));
    try {
      const home = path.join(own, "home");
      const bin = path.join(own, "bin");
      await fs.mkdir(path.join(home, "dolt"), { recursive: true });
      await fs.mkdir(bin);
      const profile = { project: "noticeos-start-0123456789abcdef", composeFile: path.join(own, "compose.yaml"),
        secretsDir: path.join(home, "dolt", "secrets"), credentialsFile: path.join(home, "dolt", "credentials"), port: 5453 };
      await fs.writeFile(path.join(home, "dolt", "profile.json"), JSON.stringify(profile));
      await fs.writeFile(path.join(bin, "bd"), `#!${process.execPath}\nconsole.log(JSON.stringify({home:process.env.HOME, credentials:process.env.BEADS_CREDENTIALS_FILE, port:process.env.BEADS_DOLT_SERVER_PORT, user:process.env.BEADS_DOLT_SERVER_USER, inherited:['BD_DOLT_SERVER_SOCKET','BEADS_DOLT_PASSWORD','DOLT_ROOT_PATH','MYSQL_PWD'].some(k=>process.env[k]!==undefined)}));\n`, { mode: 0o700 });
      const result = defaultRun(["list", "--json"], own, { PATH: bin, HOME: path.join(own, "global-home"), NOTICEOS_HOME: home,
        BD_DOLT_SERVER_SOCKET: "synthetic-sentinel", BEADS_DOLT_PASSWORD: "synthetic-sentinel", DOLT_ROOT_PATH: "synthetic-sentinel", MYSQL_PWD: "synthetic-sentinel" });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ home: path.join(home, "dolt", "client-home"), credentials: profile.credentialsFile, port: "5453", user: "noticeos", inherited: false });
      await fs.writeFile(path.join(home, "dolt", "profile.json"), "invalid");
      const invalid = defaultRun(["list"], own, { PATH: bin, NOTICEOS_HOME: home });
      expect(invalid.code).toBe(-1);
      expect(invalid.stdout).toBe("");
    } finally { await fs.rm(own, { recursive: true, force: true }); }
  });

  it("finds the fake bd first, because PATH comes before the install locations", () => {
    expect(resolveBdBin({ PATH: binDir })).toBe(path.join(binDir, "bd"));
  });

  it("reads the stored map joined to the same host links as the poller", async () => {
    expect(await fixtureProjects()).toEqual(SPOKES.spokes);
  });

  it("takes the prefix off an id, including a child task's", () => {
    expect(prefixOf("ro-l1ed.1")).toBe("ro");
    expect(prefixOf("pb-abc")).toBe("pb");
    expect(prefixOf("nonsense")).toBe("");
  });

  it("reads a parent off the dependency edge when bd sends no parent field", () => {
    const task = toLiveTask({ ...LIST_ROW, parent: undefined }, new Set<string>());
    expect(task.parent).toBe("ro-epic");
    // A plain `bd list` edge carries neither the other task's title nor its
    // status; `bd show` embeds the whole issue and carries both. The null says
    // which read this one came from.
    expect(task.dependencies).toEqual([
      { id: "ro-epic", type: "parent-child", title: null, status: null },
      { id: "ro-bbb", type: "blocks", title: null, status: null },
    ]);
  });

  it("keeps what a show read knows that a list read does not", () => {
    // `bd show` embeds the whole issue on each edge and stamps `started_at`:
    // a blocker's own status decides whether it is still in the way, and a
    // claim is dated by when it was claimed.
    const task = toLiveTask(
      {
        id: "ro-aaa",
        started_at: "2026-09-03T08:00:00Z",
        dependencies: [
          { id: "ro-bbb", title: "The lane", dependency_type: "blocks", status: "closed" },
        ],
      },
      new Set<string>(),
    );
    expect(task.startedAt).toBe("2026-09-03T08:00:00.000Z");
    expect(task.dependencies).toEqual([
      { id: "ro-bbb", type: "blocks", title: "The lane", status: "closed" },
    ]);
  });

  it("titles a human gate with the ask it holds, the way the snapshot does", () => {
    // `bd gate create -r` writes the ask into the description; the title is
    // always "Gate: human". The runner's snapshot reads it through the same
    // helper (scripts/os-up.test.mjs pins that).
    const gate = {
      id: "ro-g1",
      title: "Gate: human",
      issue_type: "gate",
      await_type: "human",
      description: "Ad-hoc gate blocking ro-aaa\n\nReason: Approve the price change",
    };
    expect(toLiveTask(gate, new Set<string>()).title).toBe("Approve the price change");
    expect(toLiveTask({ ...gate, description: "Ad-hoc gate blocking ro-aaa" }, new Set<string>()).title).toBe("Gate: human");
    // Only a human gate is an ask: a timer gate and a task that happens to
    // say "Reason:" keep their titles.
    expect(toLiveTask({ ...gate, await_type: "timer" }, new Set<string>()).title).toBe("Gate: human");
    expect(
      toLiveTask({ id: "ro-t", title: "Write the FAQ", await_type: null, description: "Reason: users ask" }, new Set<string>()).title,
    ).toBe("Write the FAQ");
  });

  it("renders a task bd describes in a status this build has never seen", () => {
    const task = toLiveTask({ id: "ro-x", status: "marinating" }, new Set<string>());
    expect(task.status).toBe("marinating");
    expect(task.title).toBe("ro-x");
    expect(task.priority).toBe(2);
  });
});


describe("saved project routing", () => {
  it("uses saved membership with trusted host paths for reads and actions, ignoring the exported roster", async () => {
    await reset();
    const saved = { asset: "new.example", prefix: "nx", database: "nx", repo: "/untrusted" };
    const readProjects = () => readSpokes(repoRoot(), {
      token: "op",
      fetchImpl: async () => Response.json({ ready: true, documents: [
        { file: "config/beads.json", version: 8, body: { spokes: [saved] } },
      ] }),
      readHost: async () => JSON.stringify({ repositories: [{ ...saved, repo: "../other.example" }] }),
    });
    const options = { repoRoot: repoRoot(), actor: "test-operator", readProjects };
    const read = await handleTasksRequest({ method: "GET", url: "/api/tasks?project=new.example", headers: SAME_ORIGIN, body: "" }, options);
    expect(read.status).toBe(200);
    const action = await handleTasksRequest({ method: "PATCH", url: "/api/tasks/nx-aaa", headers: SAME_ORIGIN, body: JSON.stringify({ claim: true }) }, options);
    expect(action.status).toBe(200);
    const old = await handleTasksRequest({ method: "GET", url: "/api/tasks?project=root-os", headers: SAME_ORIGIN, body: "" }, options);
    expect(old.status).toBe(404);
    const commands = await spawned();
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((args) => args[1] === path.join(root, "other.example"))).toBe(true);
    expect(commands.some((args) => args.includes("--claim"))).toBe(true);
  });

  it("answers a folder with no host inventory at all, as a project with no checkout linked", async () => {
    // The folder is not a checkout, so it has neither its own task-host.json
    // nor the product's default beside it.
    await reset();
    const started = await fs.mkdtemp(path.join(root, "started-"));
    const readProjects = () => readSpokes(started, {
      token: "op",
      fetchImpl: async () => Response.json({ ready: true, documents: [
        { file: "config/beads.json", version: 1, body: { spokes: [{ asset: "shop.example", prefix: "shop", database: "shop" }] } },
      ] }),
    });
    const reply = await handleTasksRequest({ method: "GET", url: "/api/tasks?project=shop.example", headers: SAME_ORIGIN, body: "" }, {
      repoRoot: started, actor: "test-operator", readProjects,
    });
    expect(reply.status).toBe(409);
    expect(reply.body).toMatchObject({ error: "project_not_linked" });
    expect(await spawned()).toEqual([]);
  });

  it("does not spawn when the store is unavailable or a saved project disagrees with its host link", async () => {
    for (const mode of ["down", "prefix", "database", "missing"] as const) {
      await reset();
      const saved = { ...SPOKES.spokes[0]!, ...(mode === "prefix" ? { prefix: "new" } : {}), ...(mode === "database" ? { database: "other" } : {}) };
      const readProjects = () => readSpokes(repoRoot(), {
        token: "op",
        fetchImpl: async () => mode === "down" ? Response.json({ ready: false }, { status: 503 }) : Response.json({ ready: true, documents: [
          { file: "config/beads.json", version: 9, body: { spokes: [saved] } },
        ] }),
        readHost: async () => JSON.stringify({ repositories: mode === "missing" ? [] : SPOKES.spokes }),
      });
      const reply = await handleTasksRequest({ method: "GET", url: "/api/tasks?project=root-os", headers: SAME_ORIGIN, body: "" }, {
        repoRoot: repoRoot(), actor: "test-operator", readProjects,
      });
      expect(reply.status).toBeGreaterThanOrEqual(400);
      expect(await spawned()).toEqual([]);
      if (mode !== "down") expect(reply.body).toMatchObject({ error: "project_not_linked" });
    }
  });
});
