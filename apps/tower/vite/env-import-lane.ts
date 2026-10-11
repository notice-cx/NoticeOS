// The env-import lane: what "Import from this machine" on a Legacy env card
// presses. It calls `importDevSecrets` (scripts/dev-secrets.mjs) in process
// rather than spawning anything. The request carries no
// argument: the file on this machine is the whole input, and the answer names
// providers and field names, never a value.

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

/** Where the local secret source lives, relative to a checkout. */
export const DEV_SECRETS_RELATIVE = path.join("workers", "ingest", ".dev.secrets.json");

export interface EnvImportLaneOptions {
  /** The checkout whose secrets file is read. */
  repoRoot?: string;
  /** Where the credential PUTs go; defaults to the host this request arrived on. */
  origin?: string;
  /** The Tower's own HTTP surface. */
  fetchImpl?: typeof fetch;
  /** One line per import. */
  log?: (line: string) => void;
}

function secretsFileIn(repoRoot: string): string {
  return path.join(repoRoot, DEV_SECRETS_RELATIVE);
}

/** This same server, by the name the browser reached it under: a fixed
 * loopback default would break the LAN address. */
function requestOrigin(request: LaneRequest, override?: string): string {
  if (override !== undefined) return override;
  const host = request.headers.host;
  return host === undefined || host === "" ? "http://127.0.0.1:5173" : `http://${host}`;
}

/** GET says whether a secrets file is there, so the card never draws a button
 * that fails; POST reads the file, PUTs every complete provider, answers with
 * what moved. */
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
  // The body carries nothing and must still declare itself, so a form post
  // from another page cannot reach this without an Origin the check above sees.
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
      // `fields` is the card's word for this list.
      imported: outcome.imported.map((entry) => ({
        provider: entry.provider,
        fields: entry.names,
      })),
      skipped: outcome.skipped,
      failed: outcome.failed,
    };
  } catch (err) {
    // The message may name the file and the origin, never the file's content.
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

/** `enforce: "pre"`: it must answer before the Cloudflare plugin dispatches
 * the path into the Worker. */
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
