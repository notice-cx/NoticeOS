// Importing the legacy env credentials: the path and result shape shared by the
// Vite lane that answers it locally, the Worker, and the browser. It lives in
// `shared/` because vite.config.ts cannot import `@noticeos/contract`. Nothing
// here carries a secret value, only provider and field names.

/** The one path. Written once, matched by the lane, the Worker and the client. */
export const ENV_IMPORT_PATH = "/api/integrations/import-env";

/**
 * Why the import cannot run from here, as a code the card draws:
 *
 * `elsewhere`: a deployed Worker has no filesystem; the import runs on the
 * machine that runs the OS.
 * `no-file`: no `workers/ingest/.dev.secrets.json` on this machine, so there
 * is nothing to import. A raw `.dev.vars` is never imported: it would store
 * Google's service-account pointers without the key, outranking a working
 * binding.
 */
export type EnvImportBlock = "elsewhere" | "no-file";

/** Whether THIS deployment can read a secrets file off the machine it runs on,
 * and — when it cannot — why, as a code. */
export interface EnvImportAvailability {
  importable: boolean;
  reason: EnvImportBlock | null;
}

/** One provider that moved into the store, with the field names that moved. */
export interface EnvImportMoved {
  provider: string;
  fields: string[];
}

/** One provider left alone, and what the file was missing for it. */
export interface EnvImportSkipped {
  provider: string;
  missing: string[];
}

/** One provider the store refused, with the route's own sentence. */
export interface EnvImportFailed {
  provider: string;
  detail: string;
}

/** What one Import press did — by name, in the three outcomes the CLI prints. */
export interface EnvImportResult {
  imported: EnvImportMoved[];
  skipped: EnvImportSkipped[];
  failed: EnvImportFailed[];
}

/** A refused POST's detail, one line each: a deployed Worker, and a local
 * machine with no secrets file. The card never presses Import in either state
 * (the GET's `reason` hides the button); these answer a caller that does. */
export const ENV_IMPORT_ELSEWHERE_DETAIL = "Run the import on the machine that runs the OS.";
export const ENV_IMPORT_NO_FILE_DETAIL = "No secrets file on this machine, so there is nothing to import.";

/** One line for a toast: what the press actually moved, named. */
export function envImportSummary(result: EnvImportResult): string {
  if (result.imported.length > 0) {
    return `Imported ${result.imported.map((entry) => entry.provider).join(", ")}`;
  }
  if (result.failed.length > 0) {
    return `Nothing imported — ${result.failed[0]!.provider}: ${result.failed[0]!.detail}`;
  }
  if (result.skipped.length > 0) {
    return `Nothing to import — ${result.skipped[0]!.provider} is missing ${result.skipped[0]!.missing.join(", ")}`;
  }
  return "Nothing to import — the secrets file holds no complete credential.";
}
