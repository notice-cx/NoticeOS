// The env-import lane — how "Import from this machine" on a Legacy env card
// becomes the credential store (bead `ro-vu8d.7`).
//
// WHY THIS EXISTS. Epic `ro-vu8d` moves provider credentials out of
// `workers/ingest/.dev.secrets.json` and into an encrypted store an operator
// fills in from the product. `pnpm dev:secrets:import` has done the moving since
// `ro-vu8d.1` — but the card that says "this credential is still in the
// environment file" handed the operator a command to copy, on the page built to
// remove exactly that kind of errand. The move is one press away, so it is a
// button; this lane is what the button presses.
//
// AND IT DOES EXACTLY WHAT THE CLI DOES. Reading the file, deciding which
// providers are complete, and PUTting each one are all `importDevSecrets` in
// scripts/dev-secrets.mjs — the same function `pnpm dev:secrets:import` runs.
// It is CALLED, not spawned: a web route that shells out to a package manager is
// a far larger thing to guard than one that reads a file, and the CLI is not
// reachable from a deployed build anyway.
//
// WHAT GUARDS IT. The same boundary as the config and task lanes (vite/lane.ts):
// SAME ORIGIN, so a page on another site cannot steer the operator's browser
// into moving their secrets, plus the JSON check and the capped body. There is
// nothing else to check — the request carries no argument at all: the file on
// this machine is the whole input, and the PUTs it makes are refused by the
// Worker's own validation exactly as the CLI's are.
//
// AND IT IS COMPILED OUT OF EVERY BUILD BY CONSTRUCTION. `apply: "serve"`, so a
// deployed Tower has no import lane — its Worker answers the same path with
// `importable: false` and the reason, and the card keeps the command text.
//
// NOTHING HERE HOLDS OR REPORTS A VALUE. The answer names providers and field
// NAMES, which is what the CLI prints and what the credential summaries already
// show. The secrets themselves go straight from the file into the same PUT the
// Connect form makes.

import { existsSync } from "node:fs";
import path from "node:path";
import type { Connect, Plugin, ViteDevServer } from "vite";
import { importDevSecrets } from "../../../scripts/dev-secrets.mjs";
import {
  ENV_IMPORT_NO_FILE_DETAIL,
  ENV_IMPORT_PATH,
  type EnvImportResult,
} from "../shared/env-import";
import {
  DEFAULT_REPO_ROOT,
  crossOrigin,
  isJson,
  laneMiddleware,
  type LaneReply,
  type LaneRequest,
} from "./lane";

/** Where the readable local secret source lives, relative to a checkout. The
 * repo root is WALKED (lane.ts) rather than derived from `import.meta.url`,
 * because Vite bundles this file before running it. */
export const DEV_SECRETS_RELATIVE = path.join("workers", "ingest", ".dev.secrets.json");

export interface EnvImportLaneOptions {
  /** The checkout whose secrets file is read. Tests pass a temp directory. */
  repoRoot?: string;
  /** Where the credential PUTs go. Defaults to the host this request arrived
   * on, which is what makes the lane work on loopback and on the LAN alike. */
  origin?: string;
  /** The Tower's own HTTP surface, injected by tests. */
  fetchImpl?: typeof fetch;
  /** One line per import. The plugin passes Vite's logger. */
  log?: (line: string) => void;
}

function secretsFileIn(repoRoot: string): string {
  return path.join(repoRoot, DEV_SECRETS_RELATIVE);
}

/** The origin the credential PUTs are aimed at: this same server, by the name
 * the browser reached it under. A fixed loopback default would break the LAN
 * address the wall and the phone use. */
function requestOrigin(request: LaneRequest, override?: string): string {
  if (override !== undefined) return override;
  const host = request.headers.host;
  return host === undefined || host === "" ? "http://127.0.0.1:5173" : `http://${host}`;
}

/**
 * One request to the lane.
 *
 * GET  → `{importable: true}` when a secrets file is actually there, and
 *        `{importable: false, reason}` when it is not. A button that fails is
 *        the thing this bead exists to remove, so the card is told before it
 *        draws one.
 * POST → read the file, PUT every complete provider, answer with what moved.
 */
export async function handleEnvImportRequest(
  request: LaneRequest,
  options: EnvImportLaneOptions = {},
): Promise<LaneReply> {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const secretsFile = secretsFileIn(repoRoot);

  if (request.method === "GET") {
    return existsSync(secretsFile)
      ? { status: 200, body: { importable: true, reason: null } }
      : { status: 200, body: { importable: false, reason: "no-file" } };
  }
  if (request.method !== "POST") {
    return { status: 405, body: { error: "method_not_allowed" } };
  }
  if (crossOrigin(request.headers)) {
    return { status: 403, body: { error: "forbidden" } };
  }
  // The body carries nothing and must still declare itself, so a form post from
  // another page cannot reach this without an Origin the check above sees.
  if (!isJson(request.headers)) {
    return { status: 415, body: { error: "unsupported_media_type" } };
  }
  if (!existsSync(secretsFile)) {
    return {
      status: 409,
      body: { error: "no_secrets_file", detail: ENV_IMPORT_NO_FILE_DETAIL },
    };
  }

  let result: EnvImportResult;
  try {
    const outcome = await importDevSecrets({
      secretsFile,
      origin: requestOrigin(request, options.origin),
      fetchImpl: options.fetchImpl ?? fetch,
    });
    result = {
      // `names` is renamed to `fields` on the way out: the browser's vocabulary
      // for "which field names does this credential hold" is `fields`
      // everywhere else on the card, and two words for one list would be two
      // things to learn.
      imported: outcome.imported.map((entry) => ({
        provider: entry.provider,
        fields: entry.names,
      })),
      skipped: outcome.skipped,
      failed: outcome.failed,
    };
  } catch (err) {
    // The message can name the file and the origin; neither is a secret. What is
    // never copied out is the secrets file's CONTENT, which nothing here reads
    // into a message.
    const detail = err instanceof Error ? err.message : String(err);
    return { status: 500, body: { error: "env_import_failed", detail } };
  }

  const log = options.log ?? (() => {});
  log(
    `${result.imported.length} imported${
      result.imported.length > 0
        ? ` (${result.imported.map((entry) => entry.provider).join(", ")})`
        : ""
    }, ${result.skipped.length} skipped, ${result.failed.length} failed`,
  );
  return { status: 200, body: { ...result } };
}

export function envImportMiddleware(
  options: EnvImportLaneOptions = {},
): Connect.NextHandleFunction {
  return laneMiddleware({
    matches: (pathname) => pathname === ENV_IMPORT_PATH,
    handle: (request) => handleEnvImportRequest(request, options),
    failure: "env_import_failed",
  });
}

/**
 * The plugin. Dev only, `enforce: "pre"` — it has to answer the path before the
 * Cloudflare plugin dispatches it into the Worker, which is where the deployed
 * (nothing-to-read) answer lives.
 */
export function envImportLane(options: EnvImportLaneOptions = {}): Plugin {
  return {
    name: "noticeos:env-import-lane",
    enforce: "pre",
    apply: "serve",
    configureServer(viteDevServer: ViteDevServer) {
      const logger = viteDevServer.config.logger;
      viteDevServer.middlewares.use(
        envImportMiddleware({
          ...options,
          log: options.log ?? ((line) => logger.info(`  [import-env] ${line}`)),
        }),
      );
    },
  };
}
