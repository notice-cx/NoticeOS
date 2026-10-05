import path from "node:path";
import { readDoltProfile } from "../../../scripts/dolt-profile.mjs";
import type { TaskHubConnection } from "../shared/settings";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Local setup carries paths, never passwords. A build reads no host profile. */
export function taskProjectSetupHub(
  command: "build" | "serve",
  legacy: TaskHubConnection | null,
  { home, repoRoot, node = process.execPath }: { home?: string; repoRoot: string; node?: string },
): TaskHubConnection | null {
  if (command !== "serve") return null;
  if (!home) return legacy;
  const ownHome = path.resolve(home);
  const profile = readDoltProfile(ownHome);
  if (!profile) return legacy;
  return {
    host: "127.0.0.1", port: profile.port, user: "noticeos",
    dataDir: path.dirname(profile.credentialsFile),
    initCommand: `${quote(node)} ${quote(path.resolve(repoRoot, "scripts/dolt-project.mjs"))} --home ${quote(ownHome)}`,
  };
}
