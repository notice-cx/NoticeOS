// THE ENVIRONMENT VARIABLES NOTICEOS READS, BY THEIR NOTICEOS NAMES
// (bead ro-ujb9.77.4, decision D26).
//
// Every variable the product itself defines is named NOTICEOS_*. A running
// installation may still set the name an earlier release read — the managed
// service's launchd plist is installed once and is operator-only to change, so
// the owner's own sets REINDEX_OS_MANAGED and REINDEX_OS_HOME — and those
// keep working: the NoticeOS name wins when it is set, the legacy one is read
// when it is not. Writers (the runner, `pnpm start`, the plist template a new
// `pnpm os:install` renders) set only the NoticeOS names.
//
// The four bootstrap secrets (CREDENTIALS_KEY, OPERATOR_TOKEN, ASSET_TOKENS,
// DATABASE_URL) carry no product name and are not here; docs/06-operations.md
// § Bootstrap secrets names them.
//
// Authored TypeScript: `pnpm config:generate` writes the `.mjs` the runner, the
// scripts and the Tower's dev server import, and the `.d.mts` beside it.

export interface ProductEnvVariable {
  /** The name NoticeOS sets and reads first. */
  readonly name: string;
  /** The name an installation from before the rename may still set. */
  readonly legacy?: string;
}

export const PRODUCT_ENV = Object.freeze({
  /** The home checkout the managed service's state lives in (scripts/os-runtime.mjs). */
  home: Object.freeze({ name: "NOTICEOS_HOME", legacy: "REINDEX_OS_HOME" }),
  /** The installation's own folder (scripts/installation.mts). */
  installationDir: Object.freeze({ name: "NOTICEOS_INSTALLATION_DIR", legacy: "REINDEX_OS_INSTALLATION_DIR" }),
  /** "1" when launchd runs the runner as the managed service (scripts/os-up.mjs). */
  managed: Object.freeze({ name: "NOTICEOS_MANAGED", legacy: "REINDEX_OS_MANAGED" }),
  /** Where both Worker configs are read from when an installation runs out of a folder of its own (`pnpm start`). */
  workerConfigRoot: Object.freeze({ name: "NOTICEOS_WORKER_CONFIG_ROOT", legacy: "REINDEX_OS_WORKER_CONFIG_ROOT" }),
  /** A second name for OPERATOR_TOKEN, read by the CLI imports after OPERATOR_TOKEN itself. */
  operatorToken: Object.freeze({ name: "NOTICEOS_OPERATOR_TOKEN", legacy: "REINDEX_OPERATOR_TOKEN" }),
  /** Server-selected workspace entry; never a VITE/client value. */
  workspaceProfile: Object.freeze({ name: "NOTICEOS_WORKSPACE_PROFILE" }),
  workspaceOrigin: Object.freeze({ name: "NOTICEOS_WORKSPACE_ORIGIN" }),
  workspaceDatabase: Object.freeze({ name: "NOTICEOS_WORKSPACE_DATABASE_URL" }),
  identityDatabase: Object.freeze({ name: "NOTICEOS_IDENTITY_DATABASE_URL" }),
  identitySecret: Object.freeze({ name: "NOTICEOS_IDENTITY_SESSION_SECRET" }),
  identityEdge: Object.freeze({ name: "NOTICEOS_IDENTITY_EDGE" }),
  identityEmailFrom: Object.freeze({ name: "NOTICEOS_IDENTITY_EMAIL_FROM" }),
  demoWorkspace: Object.freeze({ name: "NOTICEOS_DEMO_WORKSPACE_ID" }),
  demoActivityService: Object.freeze({ name: "NOTICEOS_DEMO_ACTIVITY_SERVICE_ID" }),
  demoScenarioHash: Object.freeze({ name: "NOTICEOS_DEMO_SCENARIO_HASH" }),
} satisfies Record<string, ProductEnvVariable>);

export type ProductEnvName = keyof typeof PRODUCT_ENV;
export type WorkspaceProfile = 'standalone' | 'hosted' | 'demo';

/** Authority is selected by server composition, never by a client or fallback.
 * Unlike ordinary optional settings, whitespace and absence are refused. */
export function workspaceProfile(env: object): WorkspaceProfile {
  if (!env || typeof env !== 'object') throw new Error('Workspace profile is unavailable.');
  const selected = (env as Record<string, unknown>)[PRODUCT_ENV.workspaceProfile.name];
  if (selected !== 'standalone' && selected !== 'hosted' && selected !== 'demo') {
    throw new Error('Workspace profile is unavailable.');
  }
  return selected;
}

/**
 * The variable's value, trimmed: the NoticeOS name when it holds anything,
 * else the legacy name, else undefined. Blank counts as unset, the way every
 * reader of these variables already treated it.
 */
export function readProductEnv(
  env: Readonly<Record<string, string | undefined>> | undefined,
  variable: ProductEnvName,
): string | undefined {
  const { name, legacy }: ProductEnvVariable = PRODUCT_ENV[variable];
  for (const key of [name, legacy]) {
    if (key === undefined) continue;
    const value = env?.[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}
