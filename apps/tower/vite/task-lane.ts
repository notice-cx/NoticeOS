// The task lane: dev-server middleware that runs the operator's `bd` commands
// against the task hub. A Worker can spawn no process and reach no Dolt socket,
// so a built Tower answers these paths read-only from worker/tasks-route.ts.
//
// Three guards: same origin (vite/lane.ts), an allowlist of verbs checked
// before anything is spawned, and `--actor` on every write. `bd`'s output is
// flattened into shared/tasks.ts's vocabulary and nothing more: no derived
// status, no re-implemented blocker semantics, no invented grouping.

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
import {
  DEFAULT_REPO_ROOT,
  crossOrigin,
  isJson,
  laneMiddleware,
  type LaneReply,
  type LaneRequest,
} from "./lane";

/** Gates live beside tasks because a gate has its own id space and verb. */
export const TASKS_PATH = "/api/tasks";
export const GATES_PATH = "/api/gates";

/** Asked first by the browser; must never depend on a project or on `bd`. */
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
  /** A write carries `--actor` and gets a log line; a read carries neither. */
  write: boolean;
}

/**
 * Every `bd` command this lane can run, keyed by the verb a refusal names.
 * Absent on purpose: `delete`, `sql`, `dolt`, `import`, `export`, `federation`,
 * `backup`, `restore`, `config`, `hooks`, `compact` — a browser request must
 * not be able to rewrite or destroy the register of work.
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
 * becomes. A body key not here is refused by name.
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

/** List-valued edits: repeatable flags rather than a single value. */
export const UPDATE_LABEL_FIELDS: Readonly<Record<string, string>> = {
  addLabels: "--add-label",
  removeLabels: "--remove-label",
};

/** The sub-actions `POST /api/tasks/:id/<action>` accepts. */
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
  /** The audit name every write carries; defaults to the repo's `git user.name`. */
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

/** `bd` is not reliably on PATH under a service's minimal environment, so the
 * installer's locations are the fallbacks. PATH is consulted first: a test puts
 * a fake `bd` at the front of PATH and every spawn goes there. */
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

/** A dead hub hangs `bd` forever; the bound lets it answer the browser instead. */
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

/** Who the hub records for a write: the repo's `git user.name`, or `operator`
 * when git cannot say, rather than whatever `bd` would have guessed. */
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

/** The id's prefix — `ab-x1y2.1` → `ab`. The prefix is not derivable from the
 * asset, which is why a saved task project records it. */
export function prefixOf(id: string): string {
  const dash = id.indexOf("-");
  return dash <= 0 ? "" : id.slice(0, dash);
}

// ─────────────────────────────────────────────────────────────────────────────
// Refusals
// ─────────────────────────────────────────────────────────────────────────────

/** A refusal, thrown so a handler reads top to bottom; caught once at the entry point. */
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
 * One `bd` invocation. The allowlist is consulted before the spawn, so a verb
 * this lane does not run never becomes a process. A non-zero exit comes back
 * as 502 with `bd`'s own stderr verbatim in `detail`.
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

/** `bd` writes JSON to stdout and notices to stderr, but a write verb may
 * answer in prose; unparseable output is `undefined`, not a failure. */
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

/** Shaped because it becomes a CLI argument. */
const STATUS_PATTERN = /^[a-z_]+(,[a-z_]+)*$/;

/** Active and parked work, plus the complete recent closed window. */
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

/** The spoke a request names, or a 404 that says which projects exist. */
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

/** The spoke a task id belongs to, read off its prefix. */
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
 * Checked because the id reaches a command line: the shape starts with an
 * alphanumeric, so an id can never arrive looking like a flag.
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
 * `bd epic status` supplies the all-time child denominator a list read cannot.
 * A spoke whose `bd` cannot answer it still gets a board: `epics: null`.
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
  // The handoff metadata travels as a JSON object and reaches `bd` as one.
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
    // The task may exist; only the id is missing, and a task page needs one.
    throw refuse(502, "bd_failed", result.stdout.trim() || "bd create returned no id");
  }
  return { status: 201, body: { id, project: spoke.asset } };
}

async function updateTask(id: string, request: LaneRequest, opts: Resolved): Promise<LaneReply> {
  const input = body(request);
  const spoke = await spokeById(id, opts);
  const args: string[] = [id];

  // `--claim` is atomic (assignee + in_progress), unlike two field writes.
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
      // An empty string is meaningful: `--defer ""` and `--parent ""` clear.
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
    // A close without a reason is one nobody can audit.
    const reason = requiredString(input, "reason");
    runVerb(verb, [id, "--reason", reason], spoke, opts);
  } else if (action === "comments") {
    const commentText = requiredString(input, "text");
    runVerb(verb, [id, commentText], spoke, opts);
  } else if (action === "respond") {
    const response = requiredString(input, "response");
    respondToHuman(id, response, spoke, opts);
  } else {
    // `bd human dismiss` takes an optional reason.
    const reason = optionalString(input, "reason");
    runVerb(verb, reason === null ? [id] : [id, "--reason", reason], spoke, opts);
  }
  return { status: 200, body: { id, project: spoke.asset } };
}

/** `bd human respond` can fail to resolve the id before writing anything
 * ("storage is nil"); only that failure is retried as comment + close.
 * Every other failure remains a failure, without replaying any write. */
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
  // Match `bd human respond`'s comment and close reason exactly.
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

  // Answered before anything else: no spoke, no project, no `bd`.
  if (pathname === CAPABILITIES_PATH) {
    if (request.method !== "GET") return { status: 405, body: { error: "method_not_allowed" } };
    return { status: 200, body: { live: true, reason: null } };
  }

  // Same origin for reads too: every path here spawns a process.
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

/** `enforce: "pre"`: it must answer before the Cloudflare plugin dispatches
 * these paths into the Worker. */
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
