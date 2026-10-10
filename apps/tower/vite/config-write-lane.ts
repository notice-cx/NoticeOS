// The config write lane: dev-server middleware that applies a Save to the
// store first, then keeps the checkout in step by writing the returned
// documents to their files, archiving the changeset and committing (never
// pushing). Validation, the safety allowlist, the expect guard and the archive
// come from scripts/config-apply-core.mjs, the module `pnpm config:apply` runs.
//
// A configured store is authoritative: a missing table, an unseeded document,
// an outage and an ambiguous response all refuse the save, and no fallback
// file is ever written. The store client is injected with no default, so a
// test run in any checkout can never write to whatever OS is listening on
// this machine; only the plugin wires the real door.

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

/** The one path this lane answers on. */
export const CONFIG_PATH = "/api/config";

/** What the store answered a write with: the ingest's own body, verbatim. */
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

/** The store, as this lane reaches it. Injected; absent means no door is opened. */
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
  /** The checkout the lane edits and commits. */
  repoRoot?: string;
  /** One line per apply. */
  log?: (line: string) => void;
  /** The clock behind `createdAt` and the default slug. */
  now?: () => Date;
  /** Runs one command in `repoRoot`. */
  run?: (command: string, args: string[], cwd: string) => { ok: boolean; output: string };
  /** Where a Save lands first. Absent: the file pipeline, and no door is opened. */
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

/** The two states a paused save is in, as the Tower shows them. */
export const STORE_UNREACHABLE = "Config store unreachable — saves paused";
export const STORE_NOT_READY = "Config store not ready — saves paused";

/** The real store, over the loopback ingest door `pnpm config:seed` and
 * `pnpm config:export` use. An unreachable door disables saves; it never
 * selects file mode. */
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

/** A lost response may follow a committed write: claim neither success nor
 * rollback, and never make a second write to a different source of truth. */
function storeUnknownReply(): ConfigStoreReply {
  return {
    status: 503,
    body: {
      ok: false,
      error: "store_unavailable",
      detail: "Save not confirmed — refresh before trying again",
    },
  };
}

/** The mismatch list the browser renders. MISSING is not JSON, so an absent
 * pointer says so in a field of its own. */
function serializeMismatch(m: Mismatch): Record<string, unknown> {
  const where =
    m.op.kind === "store-asset-set"
      ? { asset: m.op.asset, column: m.op.column }
      : { file: m.op.file, pointer: m.op.pointer };
  // An insert expects absence; `expect: null` alone would claim it expected a null.
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
 * GET answers whether a Save can work; PUT validates, applies, archives and
 * commits. Store ops are refused by name rather than silently ignored: the
 * Worker writes those columns over its ingest Service Binding.
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

  // Minted here and nowhere else, so what is archived is exactly what was
  // applied. The cast crosses from the UI's `EditableFile` union to the core's
  // plain string, which the allowlist checks a line later.
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

  // The store first: it refuses a stale value or version and records a
  // `config_changes` row. What is left for the lane afterwards is the checkout.
  if (opts.store !== null) {
    const reply = await opts.store.apply({
      ops: changeset.ops,
      slug: changeset.slug,
      actor: "operator",
    }).catch(() => storeUnknownReply());
    if (reply.status >= 200 && reply.status < 300 && reply.body?.ok === true) {
      return exportAfterStoreWrite(changeset, reply, opts);
    }
    // A confirmed refusal passes through; a malformed or contradictory
    // response is unknown, not permission to use the file.
    const refusal = reply.status >= 400 && reply.body?.ok !== true && typeof reply.body?.error === "string"
      ? reply
      : storeUnknownReply();
    const { ok: _ok, ...body } = refusal.body;
    return { status: refusal.status, body };
  }

  try {
    // One stale op refuses the whole set; nothing is half-applied.
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
      // So a stamp the write refreshes names the same day the archive does.
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
 * The checkout half, after the store took the write: each document is written
 * in the bytes `pnpm config:export` would write, and one commit carries them
 * with the archive. A failure here is not a failed save: the value moved, only
 * the checkout did not, so the response still reports success with a null
 * commit and the operator's next action is `pnpm config:export`.
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
      // The installation's own copy, never the product default in config/.
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
 * Commit the changed files and the archive, and nothing else: the operator's
 * checkout may have unrelated work staged. Returns the short sha, or `null`
 * when the commit did not happen (the file is already written). Only in a
 * checkout: from a plain installation folder, git would find whatever
 * repository encloses it.
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

/** `enforce: "pre"`: it must answer before the Cloudflare plugin dispatches
 * the path into the Worker. */
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
          // The one place the real door is wired.
          store: options.store === undefined ? doorConfigStore() : options.store,
        }),
      );
    },
  };
}
