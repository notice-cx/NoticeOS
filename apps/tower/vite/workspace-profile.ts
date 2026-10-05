// Node-only composition. One server profile selects native plugins and both
// Worker bindings. Local secrets cannot replace this reserved plain variable.
import { unstable_getVarsForDev } from 'wrangler';
import type { WorkerConfig } from '@cloudflare/vite-plugin';
import { PRODUCT_ENV, workspaceProfile, type WorkspaceProfile } from '../../../scripts/product-env.mjs';

const selector = PRODUCT_ENV.workspaceProfile.name;
function refused(): never { throw new Error('Workspace server configuration is inconsistent.'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refused();
  return value as Record<string, unknown>;
}

/** Config files and process environment belong to the server. Environment
 * vars are non-inheritable in Wrangler, so a selected environment must declare
 * its own profile. An explicit process selection must agree, never override. */
export function serverWorkspaceProfile(configs: readonly unknown[], env: Readonly<Record<string, string | undefined>>): WorkspaceProfile {
  if (configs.length !== 2) refused();
  const profiles = configs.map(config => {
    const raw = record(config);
    const environment = env.CLOUDFLARE_ENV;
    const selected = environment === undefined ? raw : record(record(raw.env)[environment]);
    return workspaceProfile(record(selected.vars));
  });
  const profile = profiles[0]!;
  if (profiles.some(other => other !== profile)) refused();
  if (env[selector] !== undefined && env[selector] !== profile) refused();
  return profile;
}

/** Public Wrangler API, pinned by the fixture against the plugin's actual
 * final bindings. Only currently resolved key names become dev-only required
 * secrets; previously optional legacy bindings remain optional. The reserved
 * profile is excluded even if an identical local declaration exists. On a
 * later secret-file reload it therefore cannot acquire authority. */
export function workspaceDevSecretKeys(configPath: string | undefined, profile: WorkspaceProfile, environment?: string): string[] {
  const local = unstable_getVarsForDev(configPath, undefined, {}, environment, true);
  if (local[selector] !== undefined && local[selector].value !== profile) refused();
  return Object.keys(local).filter(key => key !== selector);
}
export function workspaceWorkerConfig(config: WorkerConfig, profile: WorkspaceProfile, command: 'serve' | 'build', environment?: string): Partial<WorkerConfig> {
  if (workspaceProfile(config.vars) !== profile) refused();
  const vars = { ...config.vars, [selector]: profile };
  if (command !== 'serve') return { vars };
  const required = [...new Set([...workspaceDevSecretKeys(config.userConfigPath, profile, environment), ...(config.secrets?.required ?? [])])]
    .filter(key => key !== selector);
  // The plugin merges returned arrays with the input config. Mutate the exact
  // required list too, so an existing reserved entry cannot be appended back.
  config.secrets = { ...config.secrets, required };
  return { vars };
}
