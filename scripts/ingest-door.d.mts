// Types for the parts of ingest-door.mjs that TypeScript callers use
// (task-service.mts) — hand-written, because the door is plain Node ESM.
// Keep in lockstep with the .mjs.

export const MANAGED_DOOR: string;
export function doorFromEnv(env?: Readonly<Record<string, string | undefined>>): string;
export const DEFAULT_DOOR: string;
export function doorUrl(door: string, route: string, params?: Record<string, string | number | null | undefined>): string;
/** The operator bearer the ingest routes require, from the installation's dev-secrets file. */
export function operatorToken(): Promise<string>;
