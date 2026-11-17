export interface NtasksProject { readonly projectId: string; readonly logicalKey: string; readonly displayName: string; readonly prefix: string }

/** A saved asset and the Ntasks project whose prefix matches its task IDs. */
export interface MappedTaskProject {
  readonly asset: string;
  readonly prefix: string;
  readonly project: NtasksProject | null;
}
export function mapTaskProjects(spokes: readonly { readonly asset: string; readonly prefix: string }[],
  projects: readonly NtasksProject[]): MappedTaskProject[] {
  return spokes.map(spoke => ({ asset: spoke.asset, prefix: spoke.prefix,
    project: projects.find(project => project.prefix.toLowerCase() === spoke.prefix.toLowerCase()) ?? null }));
}
