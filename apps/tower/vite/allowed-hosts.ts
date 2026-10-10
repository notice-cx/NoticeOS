// The names the Tower's dev server answers to. Vite's DNS-rebinding guard
// admits `localhost` and IP addresses itself; a machine name has to be listed,
// so the list is this machine's own names read at start, plus any the operator
// adds in `TOWER_ALLOWED_HOSTS` (comma or space separated, Vite's own syntax:
// `.example.com` also admits every subdomain).

import os from "node:os";

/** The environment variable that adds names beyond the machine's own. */
export const EXTRA_HOSTS_ENV = "TOWER_ALLOWED_HOSTS";

/** A host name as a Host header carries it: lowercase letters, digits, dots
 * and dashes, optionally led by one dot (Vite's subdomain wildcard). */
const HOST_NAME = /^\.?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

function normalized(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * The names a machine called `hostname` is reached by on a LAN: the name as the
 * operating system reports it, its first label alone, and that label's `.local`
 * form (the name mDNS/Bonjour answers).
 */
export function machineHostNames(hostname: string): string[] {
  const full = normalized(hostname);
  if (!HOST_NAME.test(full) || full.startsWith(".")) return [];
  const [label = full] = full.split(".");
  return [...new Set([full, label, `${label}.local`])];
}

export interface AllowedHostsOptions {
  /** The machine's name; `os.hostname()` when left out. */
  hostname?: string;
  /** Where `TOWER_ALLOWED_HOSTS` is read. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** `server.allowedHosts` for the Tower's dev server, resolved at start. */
export function towerAllowedHosts({
  hostname = os.hostname(),
  env = process.env,
}: AllowedHostsOptions = {}): string[] {
  const extra = (env[EXTRA_HOSTS_ENV] ?? "")
    .split(/[\s,]+/)
    .map(normalized)
    .filter((name) => HOST_NAME.test(name));
  return [...new Set(["localhost", ...machineHostNames(hostname), ...extra])];
}
