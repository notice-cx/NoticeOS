// The task lane — how the Tower creates, claims, closes and answers work.
//
// WHY THIS EXISTS. The portfolio's task hub is a Dolt (MySQL) server on the
// operator's Mac at 127.0.0.1:3308, and the `bd` CLI is the only client that
// speaks to it. A Worker can reach neither: no socket to that host, no process
// to spawn. So until 2026-09-04 the Tower's /work board was a photograph — the
// runner shelled `bd` once a minute and the board rendered the result, read-only
// and saying so. Every claim, close, comment and answer happened in a terminal.
//
// D19 changed that for the OPERATOR, and only for the operator. The `os:up` dev
// server is a Node process with the repo checked out beside it and `bd` on the
// machine, so a middleware there can run the same commands a terminal would.
// This is that middleware.
//
// WHAT DID NOT CHANGE, and is restated here because the code is where it will be
// read: **an agent still uses `bd` in the repo where the work happens.** That
// rule (config/beads.README.md, AGENTS.md) was never about the mechanism — it
// exists because an agent claiming and closing work has the context to be honest
// about it, and a button in a browser does not confer that context. This lane is
// the operator's hands, not an agent path.
//
// THREE GUARDS, all of them load-bearing:
//
//   1. SAME ORIGIN (vite/lane.ts, shared with the config lane). There is no
//      authentication on the Tower and there must not be (docs/10: single
//      operator, LAN-served, no credential a LAN request could borrow), so the
//      boundary is that a page on another site cannot steer the operator's
//      browser into a write here.
//   2. AN ALLOWLIST OF VERBS. `bd` has seventy-odd commands, including `delete`,
//      `sql`, `import`, `federation` and `dolt`. Twelve are reachable from here
//      (`ALLOWED_VERBS`), and the check happens BEFORE anything is spawned —
//      a verb outside the list is refused, not attempted and reported.
//   3. `--actor`, ON EVERY WRITE. The hub keeps a per-machine interaction audit
//      and every bead carries who touched it. A write through this lane is the
//      operator's, so it says so — the repo's own `git user.name`. A write whose
//      actor was ambiguous would corrupt the one thing the audit is for.
//
// AND IT IS COMPILED OUT OF EVERY BUILD BY CONSTRUCTION. `apply: "serve"`: this
// plugin does not run for `vite build`, so a deployed Tower has no task lane to
// guard — its Worker answers `{live: false}` with the reason and 501 on
// everything else (worker/tasks-route.ts), and the board falls back to the
// snapshot it has always had.
//
// NOTHING HERE INTERPRETS A BEAD. `bd`'s output is flattened into
// shared/tasks.ts's vocabulary and nothing more: no derived status, no
// re-implemented blocker semantics (that is what `bd ready` is for), no
// invented grouping. Two implementations of `bd`'s meaning would drift the
// first time it learns a new status.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readTaskProjects, type TaskProjectReadOptions } from "../../../scripts/task-project-config.mjs";
import { taskChildEnvironment } from "../../../scripts/task-client.mjs";
import { validateDemoViewer, type DemoViewerDescriptor } from "../shared/demo-viewer";
import os from "node:os";
import path from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import type {
  LiveEpic,
  LiveTask,
  LiveTaskDetail,
  LiveTasksPayload,
} from "../shared/tasks";
import { isTaskId, TASKS_CLOSED_WINDOW_DAYS } from "../shared/tasks";
import { toLiveTask, toEpic, toComment, taskRowText as text } from "../../../scripts/task-row.mjs";
export { toLiveTask } from "../../../scripts/task-row.mjs";
import {
  DEFAULT_REPO_ROOT,
  crossOrigin,
  isJson,
  laneMiddleware,
  type LaneReply,
  type LaneRequest,
} from "./lane";

/** The two path roots this lane owns. Gates live beside tasks rather than under
 * them because a gate is not a task: it is a wait condition holding one out of
 * `bd ready`, with its own id space and its own verb. */
export const TASKS_PATH = "/api/tasks";
export const GATES_PATH = "/api/gates";

/** Asked once per session by the browser, before anything else — so it must
 * never depend on a spoke, a project, or `bd` being installed. */
export const CAPABILITIES_PATH = `${TASKS_PATH}/capabilities`;

export function ownsPath(pathname: string): boolean {
  return (
    pathname === TASKS_PATH ||
    pathname.startsWith(`${TASKS_PATH}/`) ||
    pathname.startsWith(`${GATES_PATH}/`)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The allowlist
// ─────────────────────────────────────────────────────────────────────────────

export interface BdVerb {
  /** The subcommand tokens, exactly as `bd` takes them. */
  tokens: readonly string[];
  /** A write carries `--actor` and gets a line in the dev-server log. A read
   * carries neither: nothing to attribute, nothing worth a line per poll. */
  write: boolean;
}

/**
 * Every `bd` command this lane can run. Keyed by the verb as a human would say
 * it, which is also what a refusal names.
 *
 * The reads are the five the board and the task page need. The writes are the
 * operator's seven: file, edit (claim, status, priority, assignee, labels,
 * parent, defer, title, description, acceptance — see `UPDATE_FIELDS`), close
 * with a reason, comment, answer or decline an ask, and release a gate.
 *
 * Absent, deliberately: `delete`, `sql`, `dolt`, `import`, `export`,
 * `federation`, `backup`, `restore`, `config`, `hooks`, `compact`. Several of
 * those would let a browser request rewrite or destroy the portfolio's register
 * of work; none of them is something an operator does from a task board.
 */
export const ALLOWED_VERBS: Readonly<Record<string, BdVerb>> = {
  list: { tokens: ["list"], write: false },
  ready: { tokens: ["ready"], write: false },
  show: { tokens: ["show"], write: false },
  comments: { tokens: ["comments"], write: false },
  "epic status": { tokens: ["epic", "status"], write: false },
  create: { tokens: ["create"], write: true },
  update: { tokens: ["update"], write: true },
  close: { tokens: ["close"], write: true },
  "comments add": { tokens: ["comments", "add"], write: true },
  "human respond": { tokens: ["human", "respond"], write: true },
  "human dismiss": { tokens: ["human", "dismiss"], write: true },
  "gate resolve": { tokens: ["gate", "resolve"], write: true },
};

/**
 * The fields `PATCH /api/tasks/:id` may set, and the `bd update` flag each one
 * becomes. A body key that is not here is refused by name — the same rule as
 * the verb list, one level down: `bd update` alone can set metadata, spec ids,
 * ephemerality and Dolt history flags, and none of those is a thing an operator
 * edits from a task page.
 */
export const UPDATE_FIELDS: Readonly<Record<string, string>> = {
  status: "--status",
  priority: "--priority",
  assignee: "--assignee",
  parent: "--parent",
  defer: "--defer",
  title: "--title",
  description: "--description",
  acceptance: "--acceptance",
};

/** The two list-valued edits, kept apart because they are repeatable flags
 * rather than a single value. */
export const UPDATE_LABEL_FIELDS: Readonly<Record<string, string>> = {
  addLabels: "--add-label",
  removeLabels: "--remove-label",
};

/** The sub-actions `POST /api/tasks/:id/<action>` accepts. Anything else is a
 * verb this lane does not run, and says so. */
export const TASK_ACTION_VERBS: Readonly<Record<string, string>> = {
  close: "close",
  comments: "comments add",
  respond: "human respond",
  dismiss: "human dismiss",
};

// ─────────────────────────────────────────────────────────────────────────────
// Options and wiring
// ─────────────────────────────────────────────────────────────────────────────

export interface BdResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface TaskLaneOptions {
  /** Trusted native configuration, never a request-controlled selector. */
  demoViewer?: DemoViewerDescriptor | null;
  /** The checkout a task project saved with the repository `.` runs in. */
  repoRoot?: string;
  /** Stored project reader; tests can supply a disposable configuration door. */
  readProjects?: () => Promise<Spoke[]>;
  /** One line per write. The plugin passes Vite's logger. */
  log?: (line: string) => void;
  now?: () => Date;
  /** Runs one `bd` invocation. Injectable so a test can watch, or refuse. */
  run?: (argv: string[], cwd: string) => BdResult;
  /** The audit name every write carries. Defaults to the repo's `git
   * user.name` — the operator, because this lane is the operator's. */
  actor?: string;
}

interface Resolved {
  repoRoot: string;
  readProjects: () => Promise<Spoke[]>;
  log: (line: string) => void;
  now: () => Date;
  run: NonNullable<TaskLaneOptions["run"]>;
  actor: string | null;
}

/** `bd` is not reliably on PATH. `os:up` may be started by launchd, which hands
 * a minimal environment, so the runner looks where the installer puts it
 * (scripts/runner/host-tools.mjs `BD_CANDIDATES`) — and this process is its child.
 *
 * PATH IS CONSULTED FIRST, which is what makes this testable at all: the test
 * puts a fake `bd` at the front of PATH and every spawn goes there. A machine
 * with a real `bd` on PATH gets the same one a terminal would. */
export function resolveBdBin(env: NodeJS.ProcessEnv = process.env): string {
  const fromPath = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const fallbacks = [
    path.join(os.homedir(), ".local", "bin", "bd"),
    "/opt/homebrew/bin/bd",
    "/usr/local/bin/bd",
  ];
  for (const dir of fromPath) {
    const candidate = path.join(dir, "bd");
    if (existsSync(candidate)) return candidate;
  }
  for (const candidate of fallbacks) {
    if (existsSync(candidate)) return candidate;
  }
  return "bd"; // let the spawn fail with a message that names it
}

/** A `bd` call is a subprocess against a local SQL server: fast when the hub is
 * up, and hung forever when it is not. The bound is generous enough for a
 * portfolio-sized `bd list` and short enough that a dead hub answers the
 * browser rather than holding the socket. */
const BD_TIMEOUT_MS = 30_000;

export function defaultRun(argv: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): BdResult {
  let childEnv = env;
  try {
    childEnv = taskChildEnvironment(env);
  } catch {
    return { code: -1, stdout: "", stderr: "The installation's task profile is invalid." };
  }
  const res = spawnSync(resolveBdBin(env), argv, {
    cwd,
    env: childEnv,
    encoding: "utf8",
    timeout: BD_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) return { code: -1, stdout: "", stderr: res.error.message };
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function resolveOptions(options: TaskLaneOptions = {}): Resolved {
  const viewer = options.demoViewer == null ? null : validateDemoViewer(options.demoViewer);
  const run = options.run ?? defaultRun;
  return {
    repoRoot: options.repoRoot ?? DEFAULT_REPO_ROOT,
    readProjects: options.readProjects ?? (() => readSpokes(options.repoRoot ?? DEFAULT_REPO_ROOT)),
    log: options.log ?? (() => {}),
    now: options.now ?? (() => new Date()),
    run: viewer === null ? run : (argv, cwd) => run(argv.includes("--sandbox") ? argv : ["--sandbox", ...argv], cwd),
    actor: options.actor ?? null,
  };
}

/** Who the hub records. The repo's own `git user.name` — the same name every
 * commit in this checkout carries — because a write from this lane IS the
 * operator's. `operator` when git cannot say, which is honest rather than
 * silently attributing the write to whatever `bd` would have guessed. */
export function operatorActor(repoRoot: string): string {
  const res = spawnSync("git", ["-C", repoRoot, "config", "user.name"], {
    encoding: "utf8",
  });
  const name = (res.stdout ?? "").trim();
  return name === "" ? "operator" : name;
}

// ─────────────────────────────────────────────────────────────────────────────
// The spoke map
// ─────────────────────────────────────────────────────────────────────────────

export interface Spoke {
  asset: string;
  prefix: string;
  /** As configured, relative to the repo root — what the page shows. */
  repo: string;
  unavailableReason?: string;
}

/** Saved membership, joined to this host's explicit repository links per request. */
export async function readSpokes(repoRoot: string, options: TaskProjectReadOptions = {}): Promise<Spoke[]> {
  return readTaskProjects({ ...options, repoRoot });
}

/** The bead id's prefix — `ro-l1ed.1` → `ro`. Ids are `<prefix>-<hash>` and the
 * prefix is NOT derivable from the asset (`ex` is not `example.com`), which is
 * exactly why a saved task project records its prefix (Settings → Task
 * projects). */
export function prefixOf(id: string): string {
  const dash = id.indexOf("-");
  return dash <= 0 ? "" : id.slice(0, dash);
}

// ─────────────────────────────────────────────────────────────────────────────
// Refusals
// ─────────────────────────────────────────────────────────────────────────────

/** A refusal, thrown so a handler reads top to bottom instead of threading an
 * error shape through every step. Caught once, at the entry point. */
class Refused extends Error {
  constructor(readonly reply: LaneReply) {
    super(typeof reply.body.error === "string" ? reply.body.error : "refused");
    this.name = "Refused";
  }
}

function refuse(status: number, error: string, detail?: string): Refused {
  return new Refused({
    status,
    body: detail === undefined ? { error } : { error, detail },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Running bd
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One `bd` invocation, guarded.
 *
 * The allowlist is consulted BEFORE the spawn, which is the whole point: a verb
 * this lane does not run never becomes a process. A non-zero exit comes back as
 * 502 with `bd`'s own stderr verbatim in `detail` — the operator is looking at a
 * board, and "bd said this" is more useful than any sentence written here.
 */
export function runVerb(
  verb: string,
  args: string[],
  spoke: Spoke,
  opts: Resolved,
): { result: BdResult; json: unknown } {
  const allowed = ALLOWED_VERBS[verb];
  if (allowed === undefined) {
    throw refuse(
      400,
      "verb_not_allowed",
      `This lane runs ${Object.keys(ALLOWED_VERBS).join(", ")} — not "${verb}".`,
    );
  }
  const repoDir = path.resolve(opts.repoRoot, spoke.repo);
  const actor = allowed.write ? (opts.actor ?? operatorActor(opts.repoRoot)) : null;
  const argv = [
    "-C",
    repoDir,
    ...allowed.tokens,
    ...args,
    "--json",
    ...(actor === null ? [] : ["--actor", actor]),
  ];
  const result = opts.run(argv, opts.repoRoot);
  if (allowed.write) {
    opts.log(
      `${spoke.asset}: bd ${verb} ${args.join(" ")} as ${actor} → ` +
        (result.code === 0 ? "ok" : `exit ${result.code}`),
    );
  }
  if (result.code !== 0) {
    throw refuse(
      502,
      "bd_failed",
      (result.stderr.trim() || result.stdout.trim() || `bd ${verb} exited ${result.code}`),
    );
  }
  return { result, json: parseJson(result.stdout) };
}

/** `bd` writes its JSON to stdout and its notices ("Showing 1 of 59 ready
 * issues…") to stderr, so stdout parses cleanly — but a write verb may answer
 * in prose, and that is not a failure. Unparseable output becomes `undefined`
 * and the caller decides whether it needed it. */
function parseJson(stdout: string): unknown {
  const text = stdout.trim();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Flattening bd's rows
// ─────────────────────────────────────────────────────────────────────────────

function rows(json: unknown): unknown[] {
  return Array.isArray(json) ? json : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Request parsing
// ─────────────────────────────────────────────────────────────────────────────

/** The statuses a caller may filter a list by. Passed through to `bd` rather
 * than reinterpreted, but shaped: this becomes a CLI argument, and a free-form
 * string there is an argument-injection surface for no gain. */
const STATUS_PATTERN = /^[a-z_]+(,[a-z_]+)*$/;

/** Active and parked work, plus the complete recent closed window. Parked work
 * stays visible without becoming queued; closed work explains the completion
 * count rather than being a sampled afterthought. */
const DEFAULT_STATUSES = "open,in_progress,blocked,deferred,closed";

function body(request: LaneRequest): Record<string, unknown> {
  if (!isJson(request.headers)) {
    throw refuse(415, "unsupported_media_type");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body === "" ? "{}" : request.body);
  } catch {
    throw refuse(400, "bad_request", "body is not JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw refuse(422, "invalid_body", "body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function requiredString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw refuse(422, "invalid_body", `${key} is required`);
  }
  return value;
}

function optionalString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw refuse(422, "invalid_body", `${key} must be a string`);
  }
  return value;
}

/** The spoke a request names, or a 404 that says which projects exist. An
 * unknown project is not an error to swallow: the operator's next move is
 * Settings → Task projects, where the saved task projects are edited
 * (`readTaskProjects`), and the answer says so (bead `ro-ujb9.215`). */
async function spokeByAsset(asset: string | null, opts: Resolved): Promise<Spoke> {
  const spokes = await opts.readProjects();
  if (asset === null || asset === "") {
    throw refuse(400, "project_required", `Name a project: ${spokes.map((s) => s.asset).join(", ")}`);
  }
  const spoke = spokes.find((entry) => entry.asset === asset);
  if (spoke === undefined) {
    throw refuse(
      404,
      "unknown_project",
      `Settings → Task projects has no project "${asset}" — it lists ${spokes.map((s) => s.asset).join(", ")}.`,
    );
  }
  if (spoke.unavailableReason) throw refuse(409, "project_not_linked", spoke.unavailableReason);
  return spoke;
}

/** The spoke a bead id belongs to, read off its prefix. A task page is reached
 * by id alone, and the id already says which repo answers for it. */
async function spokeById(id: string, opts: Resolved): Promise<Spoke> {
  const spokes = await opts.readProjects();
  const prefix = prefixOf(id);
  const spoke = spokes.find((entry) => entry.prefix === prefix);
  if (spoke === undefined) {
    throw refuse(
      404,
      "unknown_project",
      `No project in Settings → Task projects uses the prefix "${prefix}" — it lists ${spokes
        .map((s) => `${s.prefix} (${s.asset})`)
        .join(", ")}.`,
    );
  }
  if (spoke.unavailableReason) throw refuse(409, "project_not_linked", spoke.unavailableReason);
  return spoke;
}

/**
 * Bead ids are `<prefix>-<hash>` with optional `.n` child segments; a gate's may
 * carry a doubled dash (`bd show --help` names `gt--xyz`). Checked because the
 * id reaches a command line — and note what the shape guarantees: an id starts
 * with an alphanumeric, so it can never arrive looking like a flag.
 */
function beadId(raw: string): string {
  const id = decodeURIComponent(raw);
  if (!isTaskId(id)) {
    throw refuse(422, "invalid_id", `"${id}" is not a bead id`);
  }
  return id;
}

// ─────────────────────────────────────────────────────────────────────────────
// The reads
// ─────────────────────────────────────────────────────────────────────────────

function readReady(spoke: Spoke, opts: Resolved): Set<string> {
  const { json } = runVerb("ready", ["--limit", "0"], spoke, opts);
  const ids = new Set<string>();
  for (const row of rows(json)) {
    const id = text((row as Record<string, unknown>).id);
    if (id !== "") ids.add(id);
  }
  return ids;
}

/**
 * `bd epic status` is an ENHANCEMENT, not the work itself: it supplies the
 * all-time child denominator a trailing list read cannot. A spoke whose `bd`
 * cannot answer it still gets a board — `epics: null`, and the index falls back
 * to flat lists. Same rule the poller applies (`BEADS_OPTIONAL_READS`).
 */
function readEpics(spoke: Spoke, opts: Resolved): LiveEpic[] | null {
  try {
    const { json } = runVerb("epic status", [], spoke, opts);
    const out: LiveEpic[] = [];
    for (const row of rows(json)) {
      const epic = toEpic(row);
      if (epic !== null) out.push(epic);
    }
    return out;
  } catch {
    return null;
  }
}

function listTasks(spoke: Spoke, statuses: string, opts: Resolved): LiveTasksPayload {
  // Match the snapshot's UTC day boundary, but keep every matching closure.
  // The row-count cap lives only in the browser's 25-row display pagination.
  const readAt = opts.now().toISOString();
  const closedSince = new Date(Date.parse(readAt) - TASKS_CLOSED_WINDOW_DAYS * 86_400_000)
    .toISOString().slice(0, 10);
  const ready = readReady(spoke, opts);
  const requested = new Set(statuses.split(","));
  const tasks = new Map<string, LiveTask>();
  const read = (args: string[], closed: boolean) => {
    // bd hides gate issues unless explicitly included. They must survive the
    // live refresh, with their original awaitType deciding who can resolve them.
    const { json } = runVerb("list", [...args, "--include-gates"], spoke, opts);
    if (!Array.isArray(json)) {
      throw refuse(502, "bd_failed", "The task database returned an unreadable list. Refresh to try again.");
    }
    for (const row of json) {
      const task = toLiveTask(row, ready);
      if (task.id === "") throw refuse(502, "bd_failed", "The task database returned a task without an id.");
      // A closed result cannot resurrect an open row, include an older close,
      // or move the query's upper boundary while several calls are running.
      if (closed && (
        task.status !== "closed" || task.closedAt === null ||
        task.closedAt < `${closedSince}T00:00:00.000Z` || task.closedAt > readAt
      )) continue;
      tasks.set(task.id, task);
    }
  };
  const activeStatuses = [...requested].filter((status) => status !== "closed");
  if (activeStatuses.length > 0) read(["--status", activeStatuses.join(","), "--limit", "0"], false);
  if (requested.has("closed")) {
    read(["--status", "closed", "--closed-after", closedSince, "--closed-before", readAt, "--limit", "0"], true);
  }
  return {
    project: spoke.asset,
    prefix: spoke.prefix,
    repo: spoke.repo,
    readAt,
    closedSince,
    tasks: [...tasks.values()],
    epics: readEpics(spoke, opts),
  };
}

function showTask(id: string, spoke: Spoke, opts: Resolved): LiveTaskDetail {
  const { json } = runVerb("show", [id], spoke, opts);
  // `bd show --json` answers with an array even for one id.
  const row = Array.isArray(json) ? json[0] : json;
  if (row === undefined || row === null || text((row as Record<string, unknown>).id) === "") {
    throw refuse(404, "unknown_task", `${spoke.asset} has no bead ${id}.`);
  }
  const ready = readReady(spoke, opts);
  const { json: commentJson } = runVerb("comments", [id], spoke, opts);
  return {
    project: spoke.asset,
    prefix: spoke.prefix,
    repo: spoke.repo,
    readAt: opts.now().toISOString(),
    task: toLiveTask(row, ready),
    comments: rows(commentJson).map(toComment),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The writes
// ─────────────────────────────────────────────────────────────────────────────

async function createTask(request: LaneRequest, opts: Resolved): Promise<LaneReply> {
  const input = body(request);
  const spoke = await spokeByAsset(optionalString(input, "project"), opts);
  const title = requiredString(input, "title");
  const args: string[] = [title];

  const description = optionalString(input, "description");
  if (description !== null) args.push("--description", description);
  const type = optionalString(input, "type");
  if (type !== null) args.push("--type", type);
  const priority = input.priority;
  if (priority !== undefined && priority !== null) {
    if (!Number.isInteger(priority) || (priority as number) < 0 || (priority as number) > 4) {
      throw refuse(422, "invalid_body", "priority must be 0–4");
    }
    args.push("--priority", String(priority));
  }
  const labels = input.labels;
  if (Array.isArray(labels) && labels.length > 0) {
    if (!labels.every((label) => typeof label === "string")) {
      throw refuse(422, "invalid_body", "labels must be strings");
    }
    args.push("--labels", (labels as string[]).join(","));
  }
  const parent = optionalString(input, "parent");
  if (parent !== null) args.push("--parent", parent);
  const acceptance = optionalString(input, "acceptance");
  if (acceptance !== null) args.push("--acceptance", acceptance);
  // The handoff grammar (config/beads.README.md §Handoff metadata) travels as a
  // JSON object and reaches `bd` as one, so a bead filed from a finding carries
  // the same `noticeos_*` keys the copied command would have written.
  const metadata = input.metadata;
  if (metadata !== undefined && metadata !== null) {
    if (typeof metadata !== "object" || Array.isArray(metadata)) {
      throw refuse(422, "invalid_body", "metadata must be a JSON object");
    }
    args.push("--metadata", JSON.stringify(metadata));
  }

  const { result, json } = runVerb("create", args, spoke, opts);
  const created = (json ?? {}) as Record<string, unknown>;
  const id = text(created.id);
  if (id === "") {
    // The bead may well exist; what is missing is the id, and a task page
    // cannot be opened without one. Say that rather than invent an id.
    throw refuse(502, "bd_failed", result.stdout.trim() || "bd create returned no id");
  }
  return { status: 201, body: { id, project: spoke.asset } };
}

async function updateTask(id: string, request: LaneRequest, opts: Resolved): Promise<LaneReply> {
  const input = body(request);
  const spoke = await spokeById(id, opts);
  const args: string[] = [id];

  // `--claim` is atomic (assignee + in_progress in one step, idempotent), which
  // is why it is a flag rather than two field writes that could half-land.
  if (input.claim === true) args.push("--claim");

  for (const [key, value] of Object.entries(input)) {
    if (key === "claim") continue;
    const flag = UPDATE_FIELDS[key];
    if (flag !== undefined) {
      if (typeof value === "number" && key === "priority") {
        args.push(flag, String(value));
        continue;
      }
      if (typeof value !== "string") {
        throw refuse(422, "invalid_body", `${key} must be a string`);
      }
      // An empty string is meaningful for two of these: `--defer ""` clears a
      // deferral and `--parent ""` un-parents. Passed through rather than
      // filtered out, because "clear this" is an edit.
      args.push(flag, value);
      continue;
    }
    const labelFlag = UPDATE_LABEL_FIELDS[key];
    if (labelFlag !== undefined) {
      if (!Array.isArray(value) || !value.every((label) => typeof label === "string")) {
        throw refuse(422, "invalid_body", `${key} must be an array of strings`);
      }
      if (value.length > 0) args.push(labelFlag, (value as string[]).join(","));
      continue;
    }
    throw refuse(
      400,
      "field_not_allowed",
      `This lane edits ${["claim", ...Object.keys(UPDATE_FIELDS), ...Object.keys(UPDATE_LABEL_FIELDS)].join(", ")} — not "${key}".`,
    );
  }

  if (args.length === 1) {
    throw refuse(422, "invalid_body", "nothing to update");
  }
  runVerb("update", args, spoke, opts);
  return { status: 200, body: { id, project: spoke.asset } };
}

/**
 * The four things done TO a task: close it, comment on it, answer it, decline
 * it. An action outside this set is refused as a verb this lane does not run —
 * the allowlist rule, expressed at the URL where a caller would meet it.
 */
async function actOnTask(
  id: string,
  action: string,
  request: LaneRequest,
  opts: Resolved,
): Promise<LaneReply> {
  const verb = TASK_ACTION_VERBS[action];
  if (verb === undefined) {
    throw refuse(
      400,
      "verb_not_allowed",
      `This lane does ${Object.keys(TASK_ACTION_VERBS).join(", ")} on a task — not "${action}".`,
    );
  }
  const input = body(request);
  const spoke = await spokeById(id, opts);

  if (action === "close") {
    // Completion is evidence (config/beads.README.md): a close without a reason
    // is a close nobody can audit, so the lane will not make one.
    const reason = requiredString(input, "reason");
    runVerb(verb, [id, "--reason", reason], spoke, opts);
  } else if (action === "comments") {
    const commentText = requiredString(input, "text");
    runVerb(verb, [id, commentText], spoke, opts);
  } else if (action === "respond") {
    const response = requiredString(input, "response");
    respondToHuman(id, response, spoke, opts);
  } else {
    // `bd human dismiss` takes an OPTIONAL reason: declining an ask is itself
    // the answer, and forcing prose for it would only produce empty prose.
    const reason = optionalString(input, "reason");
    runVerb(verb, reason === null ? [id] : [id, "--reason", reason], spoke, opts);
  }
  return { status: 200, body: { id, project: spoke.asset } };
}

/** bd 1.1.2 can leave its server-mode store inactive in human respond.
 * Only its known ID-resolution failure happens before the response write;
 * every other failure remains a failure, without replaying any write. */
function respondToHuman(id: string, response: string, spoke: Spoke, opts: Resolved): void {
  // Resolve the operator once, so every write in this action has one actor.
  const operatorOpts = { ...opts, actor: opts.actor ?? operatorActor(opts.repoRoot) };
  try {
    runVerb("human respond", [id, "--response", response], spoke, operatorOpts);
    return;
  } catch (error) {
    if (!(error instanceof Refused) || error.reply.status !== 502) throw error;
    const detail = String(error.reply.body.detail);
    const parsed = parseJson(detail) as { error?: unknown } | undefined;
    const message = parsed && typeof parsed.error === "string" ? parsed.error : detail;
    const expected = `resolving issue ID ${id}: cannot resolve issue ID: storage is nil`;
    if (message.trim() !== expected && message.trim() !== `Error: ${expected}`) throw error;
  }
  const { json } = runVerb("show", [id], spoke, opts);
  const row = Array.isArray(json) && json.length === 1 ? json[0] : json;
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw refuse(502, "bd_failed", "The task could not be read before recording a response.");
  }
  const issue = row as Record<string, unknown>;
  const resolvedId = text(issue.id);
  if (resolvedId !== id || prefixOf(resolvedId) !== spoke.prefix || text(issue.status) === "") {
    throw refuse(502, "bd_failed", "The task could not be read before recording a response.");
  }
  if (issue.status === "closed") throw refuse(502, "bd_failed", "This task is already closed.");
  if (typeof issue.status !== "string" || !["open", "in_progress", "blocked", "deferred"].includes(issue.status) ||
      !Array.isArray(issue.labels) || !issue.labels.includes("human")) {
    throw refuse(502, "bd_failed", "This task is not an active human decision.");
  }
  // Match bd human respond's comment and close reason exactly. Both writes
  // retain the same operator actor and explicit project as the native call.
  runVerb("comments add", [resolvedId, `Response: ${response}`], spoke, operatorOpts);
  try {
    runVerb("close", [resolvedId, "--reason", "Responded"], spoke, operatorOpts);
  } catch (error) {
    if (error instanceof Refused) {
      throw refuse(error.reply.status, "bd_failed", `Response saved; closing failed. ${String(error.reply.body.detail ?? "")}`.trim());
    }
    throw error;
  }
}

/** Releasing a gate. Its own path because a gate is its own thing: it holds a
 * bead out of `bd ready` until a person says the condition is met, and
 * `bd gate resolve` is the verb that says so. */
async function resolveGate(id: string, request: LaneRequest, opts: Resolved): Promise<LaneReply> {
  const input = body(request);
  const spoke = await spokeById(id, opts);
  const reason = optionalString(input, "reason");
  runVerb("gate resolve", reason === null ? [id] : [id, "--reason", reason], spoke, opts);
  return { status: 200, body: { id, project: spoke.asset } };
}

// ─────────────────────────────────────────────────────────────────────────────
// The router
// ─────────────────────────────────────────────────────────────────────────────

export async function handleTasksRequest(
  request: LaneRequest,
  options: TaskLaneOptions = {},
): Promise<LaneReply> {
  const opts = resolveOptions(options);
  const url = new URL(request.url ?? TASKS_PATH, "http://lane.local");
  const pathname = url.pathname;

  // Asked before anything else and answered before anything else: no spoke, no
  // project, no `bd`. A browser that cannot get this far renders the snapshot
  // board, which is the correct fallback whatever the reason.
  if (pathname === CAPABILITIES_PATH) {
    if (request.method !== "GET") return { status: 405, body: { error: "method_not_allowed" } };
    return { status: 200, body: { live: true, reason: null } };
  }

  // Same origin for READS too, not only writes. Every path here spawns a
  // process against the operator's own task hub; a foreign page has no business
  // enumerating the portfolio's work any more than closing a bead in it.
  if (crossOrigin(request.headers)) {
    return { status: 403, body: { error: "forbidden" } };
  }

  try {
    return await route(pathname, url, request, opts);
  } catch (err) {
    if (err instanceof Refused) return err.reply;
    const detail = err instanceof Error ? err.message : String(err);
    return { status: 500, body: { error: "task_lane_failed", detail } };
  }
}

async function route(
  pathname: string,
  url: URL,
  request: LaneRequest,
  opts: Resolved,
): Promise<LaneReply> {
  const method = request.method;

  if (pathname === TASKS_PATH) {
    if (method === "GET") {
      const statuses = url.searchParams.get("status") ?? DEFAULT_STATUSES;
      if (!STATUS_PATTERN.test(statuses)) {
        throw refuse(422, "invalid_status", `"${statuses}" is not a comma-separated status list`);
      }
      const spoke = await spokeByAsset(url.searchParams.get("project"), opts);
      return { status: 200, body: listTasks(spoke, statuses, opts) as unknown as Record<string, unknown> };
    }
    if (method === "POST") return createTask(request, opts);
    return { status: 405, body: { error: "method_not_allowed" } };
  }

  const gate = pathname.match(/^\/api\/gates\/([^/]+)\/resolve$/);
  if (gate) {
    if (method !== "POST") return { status: 405, body: { error: "method_not_allowed" } };
    return resolveGate(beadId(gate[1] ?? ""), request, opts);
  }

  const action = pathname.match(/^\/api\/tasks\/([^/]+)\/([^/]+)$/);
  if (action) {
    if (method !== "POST") return { status: 405, body: { error: "method_not_allowed" } };
    return actOnTask(beadId(action[1] ?? ""), action[2] ?? "", request, opts);
  }

  const one = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (one) {
    const id = beadId(one[1] ?? "");
    if (method === "GET") {
      const spoke = await spokeById(id, opts);
      return { status: 200, body: showTask(id, spoke, opts) as unknown as Record<string, unknown> };
    }
    if (method === "PATCH") return updateTask(id, request, opts);
    return { status: 405, body: { error: "method_not_allowed" } };
  }

  return { status: 404, body: { error: "not_found" } };
}

// ─────────────────────────────────────────────────────────────────────────────
// The plugin
// ─────────────────────────────────────────────────────────────────────────────

export function taskLaneMiddleware(options: TaskLaneOptions = {}) {
  return laneMiddleware({
    matches: ownsPath,
    handle: (request) => handleTasksRequest(request, options),
    failure: "task_lane_failed",
  });
}

/**
 * The plugin. Dev only, `enforce: "pre"` — it has to answer `/api/tasks/*`
 * before the Cloudflare plugin dispatches those paths into the Worker, which is
 * where the deployed (read-only) answer lives.
 */
export function taskLane(options: TaskLaneOptions = {}): Plugin {
  return {
    name: "noticeos:task-lane",
    enforce: "pre",
    apply: "serve",
    configureServer(viteDevServer: ViteDevServer) {
      const logger = viteDevServer.config.logger;
      viteDevServer.middlewares.use(
        taskLaneMiddleware({
          ...options,
          log: options.log ?? ((line) => logger.info(`  [tasks] ${line}`)),
        }),
      );
    },
  };
}
