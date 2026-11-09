// The task clients the demo code runs, never an installation's: an
// installation's tasks live in Ntasks. The hosted demo's executor reads its
// own declared client file (readDeclaredTaskClient), and the synthetic viewer
// (scripts/demo-viewer.mjs) names its Dolt profile with NOTICEOS_DOLT_HOME for
// the Tower's task lane and the MCP server it starts.
import * as fs from 'node:fs';
import path from 'node:path';
import { doltEnvironment, readDoltProfile, readDoltCredentials, type DoltProfile } from './dolt-profile.mjs';

export interface TaskClient { host: string; port: number; user: string; credentialsFile: string; clientHome: string }
export type TaskClientEnvironment = Record<string, string | undefined>;

const KEYS = ['clientHome', 'credentialsFile', 'host', 'port', 'user'];
export function validateTaskClient(input: unknown): TaskClient {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid declared task client.');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).sort().join() !== KEYS.join()
    || typeof value.host !== 'string' || !/^(?:[a-zA-Z0-9][a-zA-Z0-9.-]*)$/u.test(value.host)
    || typeof value.port !== 'number' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
    || typeof value.user !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(value.user)
    || !absolutePath(value.clientHome) || !absolutePath(value.credentialsFile)) {
    throw new Error('Invalid declared task client.');
  }
  return { host: value.host, port: value.port, user: value.user, credentialsFile: value.credentialsFile, clientHome: value.clientHome };
}

function absolutePath(value: unknown): value is string {
  return typeof value === 'string' && path.isAbsolute(value) && !/[\r\n\0]/u.test(value);
}

function privateFile(file: string): string {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > 16384) throw new Error('Task client files must be private regular files.');
  return fs.readFileSync(file, 'utf8');
}

export function readDeclaredTaskClient(file: string): TaskClient {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('An absolute task client profile is required.');
  try {
    const profile = validateTaskClient(JSON.parse(privateFile(file)));
    const credentials = privateFile(profile.credentialsFile);
    const first = `[${profile.host}:${profile.port}]\npassword=`;
    if (!credentials.startsWith(first) || !/^[^\r\n\0]+\n?$/u.test(credentials.slice(first.length))) throw new Error('Credentials do not match.');
    const home = fs.lstatSync(profile.clientHome);
    if (!home.isDirectory() || home.isSymbolicLink() || (home.mode & 0o077)) throw new Error('The client home must be private.');
    return profile;
  } catch { throw new Error('The declared task client cannot be read.'); }
}

export function taskClientEnvironment(profile: TaskClient, env: TaskClientEnvironment = process.env): TaskClientEnvironment {
  validateTaskClient(profile);
  const selected: TaskClientEnvironment = {};
  for (const key of ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE']) if (env[key] !== undefined) selected[key] = env[key];
  return { ...selected, HOME: profile.clientHome, XDG_CONFIG_HOME: path.join(profile.clientHome, '.config'),
    BEADS_CREDENTIALS_FILE: profile.credentialsFile, BEADS_DOLT_SERVER_MODE: '1', BEADS_DOLT_SERVER_HOST: profile.host,
    BEADS_DOLT_SERVER_PORT: String(profile.port), BEADS_DOLT_SERVER_USER: profile.user, BEADS_DOLT_AUTO_START: '0',
    BD_DISABLE_METRICS: '1', BD_DISABLE_ERROR_REPORTING: '1', DO_NOT_TRACK: '1', DOLT_DISABLE_EVENT_FLUSH: '1' };
}

/** The Dolt profile NOTICEOS_DOLT_HOME names, or null when it names none. */
export function selectedDoltProfile(env: TaskClientEnvironment = process.env): DoltProfile | null {
  if (env.NOTICEOS_DOLT_HOME === undefined) return null;
  const home = env.NOTICEOS_DOLT_HOME;
  if (!absolutePath(home)) throw new Error('The selected Dolt home must be an absolute installation folder.');
  const profile = readDoltProfile(home);
  if (!profile) throw new Error('The selected Dolt home has no declared profile; task fallback was refused.');
  readDoltCredentials(profile);
  return profile;
}

export function declaredTaskClient(env: TaskClientEnvironment = process.env): TaskClient | null {
  const profile = selectedDoltProfile(env);
  return profile ? { host: '127.0.0.1', port: profile.port, user: 'noticeos', credentialsFile: profile.credentialsFile,
    clientHome: path.join(path.dirname(profile.credentialsFile), 'client-home') } : null;
}

export function taskChildEnvironment(env: TaskClientEnvironment = process.env): TaskClientEnvironment {
  const profile = selectedDoltProfile(env);
  return profile ? doltEnvironment(profile, env) : env;
}
