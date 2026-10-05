// Importing the legacy env credentials — the one path, and the one vocabulary
// (bead `ro-vu8d.7`).
//
// Three runtimes have to agree about this route and none of them can import the
// others: the Vite lane that ANSWERS it (a Node process with the repo beside
// it), the Worker that answers it honestly everywhere else, and the browser that
// calls it. `shared/` is the only place all three already reach — the vite
// config cannot import `@noticeos/contract` at all (see the note at the top of
// vite.config.ts), so this is where the path and the result shape live.
//
// NOTHING HERE CARRIES A VALUE. The result names providers and field NAMES,
// which is the same thing the CLI prints and the same thing the credential
// summaries already show.

/** The one path. Written once, matched by the lane, the Worker and the client. */
export const ENV_IMPORT_PATH = "/api/integrations/import-env";

/**
 * Why the import cannot run from here, as a code the card draws (bead
 * `ro-ujb9.96.6.1`), never a sentence it prints:
 *
 * `elsewhere` — a deployed Worker has no filesystem and no secrets file; the
 * import runs on the machine that runs the OS, so the card labels the command
 * with where it runs.
 * `no-file` — this machine has no `workers/ingest/.dev.secrets.json` yet. The
 * operator never migrated, so there is only a hand-written `.dev.vars`, and the
 * card shows the migrate command before the import one. (Importing a generated
 * `.dev.vars` would store Google's routing map with its service-account
 * POINTERS and no key, which the store would then rank above a working
 * binding — so migrate, not import, comes first.)
 */
export type EnvImportBlock = "elsewhere" | "no-file";

/** Whether THIS deployment can read a secrets file off the machine it runs on,
 * and — when it cannot — why, as a code. */
export interface EnvImportAvailability {
  importable: boolean;
  reason: EnvImportBlock | null;
}

/** The command that turns a hand-written `.dev.vars` into the secrets file the
 * import reads — shown first when there is no file. */
export const ENV_MIGRATE_COMMAND = "pnpm dev:secrets:migrate";

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
export const ENV_IMPORT_NO_FILE_DETAIL = `No secrets file on this machine — run ${ENV_MIGRATE_COMMAND} first.`;

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
