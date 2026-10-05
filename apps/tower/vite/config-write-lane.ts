// The config write lane — how a Save in the Tower becomes a config commit.
//
// WHY THIS EXISTS. Config is version-controlled files (docs/06), and a Worker has
// no filesystem, so until 2026-09-04 the Tower could not write config at all: an
// edit was staged into a browser-local cart, exported as a changeset, and applied
// by the operator running `pnpm config:apply` in a terminal. D18 retired that —
// a setting saves the normal way, with an Undo toast — and this is the half that
// makes it possible. The only deployment that exists is the local `os:up` dev
// server, a NODE process with the repo checked out beside it (vite.config.ts:
// "this dev server IS production"), so a middleware in that process can do
// everything the CLI did.
//
// AND IT DOES EXACTLY WHAT THE CLI DID. Validation, the safety allowlist, the
// expect guard, the read-modify-write and the archive all come from
// scripts/config-apply-core.mjs — the same module `pnpm config:apply` runs. Two
// implementations of "what may the Tower edit" would be two answers; there is
// one, and apps/tower/test/config-write-lane.test.ts runs both entry points over
// identical temp repos and compares what each left behind.
//
// WHAT GUARDS IT. There is no authentication on the Tower and there must not be
// (docs/10: single operator, LAN-served, no credential a LAN request could
// borrow). So the boundary is the same one the write routes in the Worker use —
// SAME ORIGIN: a request whose Origin/Referer host is not this server's Host is
// refused, which is what stops a page on another site from steering the
// operator's browser into a config write. Plus the allowlists, which mean even
// an accepted request can only SET a value in four named files at named
// pointers, or ADD/REMOVE one asset-keyed entry in one named container per
// per-asset register (ro-z349.1). Both live in the shared core.
//
// AND IT IS COMPILED OUT OF EVERY BUILD BY CONSTRUCTION. `apply: "serve"` means
// this plugin does not run for `vite build`, so a deployed Tower has no write
// lane here — its Worker answers `/api/config` itself.
//
// NEVER PUSHES. It commits, on the current branch, the files it changed plus the
// archive. Where those commits go is the operator's business, as it always was.
//
// ── SINCE 2026-09-05 IT IS A THIN CLIENT OF THE STORE (epic `ro-syok`) ────────
//
// db/0029 gives the store a document per config file, so `PUT /api/config` works
// in every deployment now — the Tower Worker applies it over the private INGEST
// binding. This lane stays for the one thing a Worker still cannot do: keep the
// CHECKOUT in step. A Save goes to the store first, through the same validating
// door `pnpm config:seed` uses; then this writes the returned documents to their
// files, archives the changeset and commits, exactly as before. The file is the
// export (docs/06), and a repo that quietly drifted from the store would make
// every later diff a lie.
//
// A CONFIGURED STORE IS AUTHORITATIVE. A missing table, an unseeded document,
// an outage and an ambiguous response all refuse the save. None proves that
// this installation has never used stored config, so none permits writing a
// fallback copy that recovered Workers would silently ignore (ro-ujb9.19).
//
// THE STORE CLIENT IS INJECTED, AND THERE IS NO DEFAULT. `handleConfigRequest`
// with no `store` runs the file pipeline and speaks to nothing — which is what
// every test in apps/tower/test/config-write-lane.test.ts does, and it is
// deliberate: a default door address would mean a test run in any checkout
// writing to whatever OS happens to be listening on this machine. Only
// `configWriteLane()` — the plugin, constructed once by vite.config.ts inside
// the operator's own `os:up` — wires the real door.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Connect, Plugin, ViteDevServer } from "vite";
import {
  ChangesetError,
  MISSING,
  applyFileOps,
  archiveChangeset,
  resolve,
  validateSchemaAndSafety,
  writeDocumentFile,
  type Changeset as CoreChangeset,
  type JsonValue,
  type Mismatch,
} from "../../../scripts/config-apply-core.mjs";
import {
  CONFIG_APPLY_PATH,
  CONFIG_DOCUMENTS_PATH,
  configStoreRequest,
} from "../../../scripts/config-store-client.mjs";
import { buildChangeset, defaultSlug, type ChangesetOp } from "../shared/changeset";
import {
  DEFAULT_REPO_ROOT,
  crossOrigin,
  isJson,
  laneMiddleware,
  type LaneReply,
  type LaneRequest,
} from "./lane";

// The boundary is shared with the task lane (vite/lane.ts): same-origin, the
// JSON check, the capped body read, the repo root, and the middleware shell.
// Re-exported because this module was the first to own them and callers (and
// tests) still name them here.
export { DEFAULT_REPO_ROOT, crossOrigin };
export type { LaneReply, LaneRequest };

/** The one path this lane answers on. */
export const CONFIG_PATH = "/api/config";

/** What the store answered a write with — the ingest's own body, verbatim. */
export interface ConfigStoreReply {
  status: number;
  body: {
    ok?: boolean;
    error?: string;
    applied?: number;
    documents?: { file: string; version: number; body: JsonValue }[];
    [key: string]: unknown;
  };
}

/**
 * The store, as this lane reaches it. Injected and defaulting to ABSENT: a
 * default door address would mean any test run in any checkout writing to
 * whatever OS is listening on this machine.
 */
export interface ConfigStoreLane {
  /** Whether the store can take a write, for the GET. */
  state(): Promise<{ ready: boolean; reason: string | null; unseeded: string[] }>;
  /** Apply one changeset. Answers the ingest's own status and body. */
  apply(input: {
    ops: unknown[];
    slug: string;
    actor: string;
  }): Promise<ConfigStoreReply>;
}

export interface ConfigWriteLaneOptions {
  /** The checkout the lane edits and commits. Tests pass a temp repo. */
  repoRoot?: string;
  /** One line per apply. The plugin passes Vite's logger. */
  log?: (line: string) => void;
  /** The clock behind `createdAt` and the default slug. */
  now?: () => Date;
  /** Runs one command in `repoRoot`. Injectable so a test can watch, or refuse. */
  run?: (command: string, args: string[], cwd: string) => { ok: boolean; output: string };
  /** Where a Save lands first. Absent ⇒ the file pipeline, and no door is opened. */
  store?: ConfigStoreLane | null;
}

interface Resolved {
  repoRoot: string;
  log: (line: string) => void;
  now: () => Date;
  run: NonNullable<ConfigWriteLaneOptions["run"]>;
  store: ConfigStoreLane | null;
}

function defaultRun(command: string, args: string[], cwd: string) {
  const res = spawnSync(command, args, { cwd, encoding: "utf8" });
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
  if (res.error) return { ok: false, output: res.error.message };
  return { ok: res.status === 0, output };
}

function resolveOptions(options: ConfigWriteLaneOptions = {}): Resolved {
  return {
    repoRoot: options.repoRoot ?? DEFAULT_REPO_ROOT,
    log: options.log ?? (() => {}),
    now: options.now ?? (() => new Date()),
    run: options.run ?? defaultRun,
    store: options.store ?? null,
  };
}

/**
 * The real store, over the loopback ingest door — the same door
 * `pnpm config:seed` and `pnpm config:export` use, with the same operator bearer
 * its routes require.
 *
 * Constructed ONLY by the plugin below, which exists only inside a running
 * `os:up`. An unreachable door disables saves; it never selects file mode.
 */
/** The two states a paused save is in, as the Tower shows them (bead
 * `ro-ujb9.96.6.4`): a state, not a paragraph. No fallback file is ever
 * written while the store is unavailable. */
export const STORE_UNREACHABLE = "Config store unreachable — saves paused";
export const STORE_NOT_READY = "Config store not ready — saves paused";

export function doorConfigStore(): ConfigStoreLane {
  const swallow = async (route: string, init: Record<string, unknown>) => {
    try {
      return await configStoreRequest(route, init);
    } catch {
      // Transport failures must not expose credentials or raw response bodies.
      return null;
    }
  };
  return {
    async state() {
      const answer = await swallow(CONFIG_DOCUMENTS_PATH, {});
      const body = (answer?.body ?? null) as {
        ready?: boolean;
        reason?: string;
        unseeded?: string[];
      } | null;
      if (answer?.status !== 200 || body === null || typeof body.ready !== "boolean") {
        return { ready: false, reason: STORE_UNREACHABLE, unseeded: [] };
      }
      return {
        ready: body.ready === true,
        reason: body.ready ? null : (body.reason ?? STORE_NOT_READY),
        unseeded: Array.isArray(body.unseeded) ? body.unseeded.filter((file): file is string => typeof file === "string") : [],
      };
    },
    async apply(input) {
      const answer = await swallow(CONFIG_APPLY_PATH, { method: "POST", body: input });
      if (answer === null) {
        return storeUnknownReply();
      }
      return { status: answer.status, body: answer.body as ConfigStoreReply["body"] };
    },
  };
}

/** A lost response may follow a committed write. Never claim either success or
 * rollback, and never make a second write to a different source of truth. */
function storeUnknownReply(): ConfigStoreReply {
  return {
    status: 503,
    body: {
      ok: false,
      error: "store_unavailable",
      // Never a claim of success or rollback, and no fallback file was touched.
      detail: "Save not confirmed — refresh before trying again",
    },
  };
}

/** The mismatch list the browser renders: what it expected, what is there now.
 * MISSING is not JSON, so an absent pointer says so in a field of its own. */
function serializeMismatch(m: Mismatch): Record<string, unknown> {
  const where =
    m.op.kind === "store-asset-set"
      ? { asset: m.op.asset, column: m.op.column }
      : { file: m.op.file, pointer: m.op.pointer };
  // An insert expects ABSENCE, which is not a JSON value. Saying `expect: null`
  // and stopping would claim the caller expected a null; the extra flag is what
  // lets the browser render "this asset is already configured here" rather than
  // "the value changed".
  const expectAbsent = m.expect === MISSING;
  return {
    ...where,
    expect: expectAbsent ? null : m.expect,
    ...(expectAbsent ? { expectAbsent: true } : {}),
    current: m.current === MISSING ? null : (m.current as JsonValue),
    absent: m.current === MISSING,
  };
}

/**
 * One request to the lane.
 *
 * GET  → `{writable: true}`. The Worker answers the same question with `false`
 *        and a reason, so a deployed build's fields render disabled instead of
 *        offering a Save that cannot work.
 * PUT  → validate → resolve against the files → apply → archive → commit.
 *
 * Store ops are refused here by name rather than silently ignored: they are a
 * real part of the changeset vocabulary, they are just not this lane's — the
 * Worker writes those two columns over its ingest Service Binding, in both
 * deployments, so a browser that sent one has aimed at the wrong route.
 */
export async function handleConfigRequest(
  request: LaneRequest,
  options: ConfigWriteLaneOptions = {},
): Promise<LaneReply> {
  const opts = resolveOptions(options);

  if (request.method === "GET") {
    const state = opts.store === null ? null : await opts.store.state().catch(() => ({
      ready: false,
      reason: STORE_UNREACHABLE,
      unseeded: [],
    }));
    return {
      status: 200,
      body: {
        writable: state === null || state.ready,
        reason: state?.ready === false ? state.reason : null,
        ...(state === null
          ? {}
          : { store: { ready: state.ready, reason: state.reason }, unseeded: state.unseeded }),
      },
    };
  }
  if (request.method !== "PUT") {
    return { status: 405, body: { error: "method_not_allowed" } };
  }
  if (crossOrigin(request.headers)) {
    return { status: 403, body: { error: "forbidden" } };
  }
  if (!isJson(request.headers)) {
    return { status: 415, body: { error: "unsupported_media_type" } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body);
  } catch {
    return { status: 400, body: { error: "bad_request" } };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: 422, body: { error: "invalid_changeset", detail: "body must be a JSON object" } };
  }
  const { ops, slug } = parsed as { ops?: unknown; slug?: unknown };
  if (!Array.isArray(ops)) {
    return { status: 422, body: { error: "invalid_changeset", detail: "ops must be an array" } };
  }
  if (slug !== undefined && typeof slug !== "string") {
    return { status: 422, body: { error: "invalid_changeset", detail: "slug must be a string" } };
  }
  if (ops.some((op) => (op as { kind?: unknown } | null)?.kind === "store-asset-set")) {
    return {
      status: 422,
      body: {
        error: "store_op_not_accepted",
        // An asset's stage, automation mode and name are store columns.
        detail: "Store columns save through PATCH /api/assets/:id",
      },
    };
  }

  // The document is minted here and nowhere else, so what is archived is exactly
  // what was applied. The cast is the boundary between the two vocabularies: the
  // UI's `EditableFile` union and the core's plain string, which is checked
  // against the allowlist a line later — the request body was never any narrower
  // than `unknown`, whatever the UI's types say.
  const at = opts.now();
  const changeset = buildChangeset(ops as ChangesetOp[], {
    slug: slug ?? defaultSlug(at),
    createdAt: at.toISOString(),
  }) as unknown as CoreChangeset;

  try {
    validateSchemaAndSafety(changeset);
  } catch (err) {
    if (err instanceof ChangesetError) {
      return { status: 422, body: { error: "invalid_changeset", detail: err.message } };
    }
    throw err;
  }

  // THE STORE FIRST. It runs this same validated changeset against the stored
  // documents, refuses on a stale value or a stale version, and records a
  // `config_changes` row — everything this lane used to be the only one doing.
  // What is left for the lane afterwards is the checkout.
  if (opts.store !== null) {
    const reply = await opts.store.apply({
      ops: changeset.ops,
      slug: changeset.slug,
      actor: "operator",
    }).catch(() => storeUnknownReply());
    if (reply.status >= 200 && reply.status < 300 && reply.body?.ok === true) {
      return exportAfterStoreWrite(changeset, reply, opts);
    }
    // Pass a confirmed refusal through. A malformed or contradictory response
    // is unknown, not a successful save and not permission to use the file.
    const refusal = reply.status >= 400 && reply.body?.ok !== true && typeof reply.body?.error === "string"
      ? reply
      : storeUnknownReply();
    const { ok: _ok, ...body } = refusal.body;
    return { status: refusal.status, body };
  }

  try {
    // Nothing is written until every op still matches what is on disk. One stale
    // op refuses the whole set, exactly as the CLI does — the operator gets the
    // current value rather than a half-applied edit.
    const { resolved, mismatches, fileCache } = await resolve(changeset, null, {
      repoRoot: opts.repoRoot,
    });
    if (mismatches.length > 0) {
      return {
        status: 409,
        body: { error: "expect_mismatch", mismatches: mismatches.map(serializeMismatch) },
      };
    }

    const changedFiles = await applyFileOps(resolved, fileCache, {
      repoRoot: opts.repoRoot,
      // The changeset's own timestamp, so a stamp the write refreshes (bead
      // `ro-auav`) names the same day the archive and the commit do.
      at: changeset.createdAt,
    });
    const archive = await archiveChangeset(changeset, { repoRoot: opts.repoRoot });
    const commit = commitChange(changeset.slug, [...changedFiles, archive], opts);

    opts.log(
      `${changeset.slug}: ${changeset.ops.length} op(s) → ${[...changedFiles, archive].join(", ")}` +
        (commit === null ? " (not committed)" : ` (${commit})`),
    );
    return { status: 200, body: { applied: changeset.ops.length, archive, commit } };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { status: 500, body: { error: "config_write_failed", detail } };
  }
}

/**
 * The checkout half, after the store took the write.
 *
 * THE FILE IS THE EXPORT (docs/06, epic `ro-syok`). The store is the source of
 * truth once seeded, and the repo keeps the audit history it always had — so
 * each document the store just wrote is written to its file in the same bytes
 * `pnpm config:export` would write, the changeset is archived, and one commit
 * carries both. An operator running `git log config/` after a Save sees exactly
 * what they saw before this epic.
 *
 * A FAILURE HERE IS NOT A FAILED SAVE. The value moved; only the checkout did
 * not. It is logged and the response still reports success with a null commit,
 * for the same reason `commitChange` returns null rather than throwing:
 * pretending the save failed would be a lie, and the operator's next action —
 * `pnpm config:export` — is different from retrying the Save.
 */
async function exportAfterStoreWrite(
  changeset: CoreChangeset,
  reply: ConfigStoreReply,
  opts: Resolved,
): Promise<LaneReply> {
  const documents = reply.body.documents ?? [];
  const written: string[] = [];
  try {
    for (const doc of documents) {
      // The installation's own copy (scripts/installation.mts), never the
      // product default in config/ (bead ro-ujb9.125).
      written.push(await writeDocumentFile(doc.file, doc.body, { repoRoot: opts.repoRoot }));
    }
    const archive = await archiveChangeset(changeset, { repoRoot: opts.repoRoot });
    const commit = commitChange(changeset.slug, [...written, archive], opts);
    opts.log(
      `${changeset.slug}: ${changeset.ops.length} op(s) → the store, exported to ` +
        `${[...written, archive].join(", ")}` +
        (commit === null ? " (not committed)" : ` (${commit})`),
    );
    return {
      status: 200,
      body: { applied: reply.body.applied ?? changeset.ops.length, archive, commit, exported: true },
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    opts.log(`${changeset.slug}: saved to the store, but the checkout was not updated — ${detail}`);
    return {
      status: 200,
      body: { applied: reply.body.applied ?? changeset.ops.length, archive: null, commit: null, exported: false },
    };
  }
}

/**
 * Commit the changed files and the archive, and nothing else.
 *
 * The pathspec on the commit is not tidiness: this runs in the operator's own
 * checkout, which may have unrelated work staged, and a config Save must never
 * become a commit of whatever else was in the index. Returns the new commit's
 * short sha, or `null` when the commit did not happen — a failure to record
 * history is worth saying out loud, but the file is already written and
 * pretending the save failed would be a lie.
 *
 * ONLY IN A CHECKOUT. An installation whose home is a plain folder — the one
 * `pnpm start` makes (bead ro-ujb9.126) — keeps its history in the store's
 * `config_changes` and its exports in that folder, and nothing here runs git:
 * from inside a folder in somebody's checkout, git would find THAT repository.
 */
function commitChange(slug: string, paths: string[], opts: Resolved): string | null {
  if (!existsSync(path.join(opts.repoRoot, ".git"))) return null;
  const staged = opts.run("git", ["add", "--", ...paths], opts.repoRoot);
  if (!staged.ok) {
    opts.log(`could not stage ${paths.join(", ")}: ${staged.output}`);
    return null;
  }
  const committed = opts.run(
    "git",
    ["commit", "-m", `config: ${slug} via Tower`, "--", ...paths],
    opts.repoRoot,
  );
  if (!committed.ok) {
    opts.log(`could not commit ${paths.join(", ")}: ${committed.output}`);
    return null;
  }
  const head = opts.run("git", ["rev-parse", "--short", "HEAD"], opts.repoRoot);
  return head.ok ? head.output.trim() : null;
}

export function configWriteMiddleware(
  options: ConfigWriteLaneOptions = {},
): Connect.NextHandleFunction {
  return laneMiddleware({
    matches: (pathname) => pathname === CONFIG_PATH,
    handle: (request) => handleConfigRequest(request, options),
    failure: "config_write_failed",
  });
}

/**
 * The plugin. Dev only, `enforce: "pre"` — it has to answer `/api/config` before
 * the Cloudflare plugin dispatches that path into the Worker, which is where the
 * deployed (read-only) answer lives.
 */
export function configWriteLane(options: ConfigWriteLaneOptions = {}): Plugin {
  return {
    name: "noticeos:config-write-lane",
    enforce: "pre",
    apply: "serve",
    configureServer(viteDevServer: ViteDevServer) {
      const logger = viteDevServer.config.logger;
      viteDevServer.middlewares.use(
        configWriteMiddleware({
          ...options,
          log: options.log ?? ((line) => logger.info(`  [config] ${line}`)),
          // The one place the real door is wired. Inside `os:up` this process
          // IS the operator's OS, so the loopback door is the store; anywhere
          // else — a test, a bare `vite` — there is no default to hit.
          store: options.store === undefined ? doorConfigStore() : options.store,
        }),
      );
    },
  };
}
