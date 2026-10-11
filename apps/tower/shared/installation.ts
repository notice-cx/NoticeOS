/**
 * The installation as its host sees it, for Settings > Installation:
 * /api/installation (vite/installation-lane.ts) reads what the stack tells
 * the app (deploy/compose/compose.yaml) and asks the registry for the newest
 * published version. Read-only; every change is made with the commands.
 */
export interface InstallationFacts {
  /** The folder holding installation.env, or null when the app was not told (an older declaration). */
  folder: string | null;
  /** Where the Tower listens on the host. */
  tower: { address: string; port: number } | null;
  postgresPort: number | null;
  taskPort: number | null;
  /** The launcher an installation without a checkout runs its commands through; null runs `pnpm os:*` in the checkout. */
  launcher: string | null;
  /** The commit the app runs, and whether that is a checkout's live source rather than a fixed version. */
  commit: string | null;
  live: boolean;
  /** The commit main's newest published version was built from, or null when the registry does not say. */
  published: string | null;
}

export type UpdateState = "current" | "available" | "live" | "unknown";

/** Whether a newer version is published than the one the app runs. */
export function updateState(facts: Pick<InstallationFacts, "commit" | "live" | "published">): UpdateState {
  if (facts.live) return "live";
  if (!facts.commit || !facts.published) return "unknown";
  return facts.commit === facts.published ? "current" : "available";
}

/** The command that runs `verb` for this installation, as the operator types it. */
export function installationCommand(facts: Pick<InstallationFacts, "launcher">, verb: string): string {
  return facts.launcher ? `${facts.launcher} ${verb}` : `pnpm os:${verb}`;
}
