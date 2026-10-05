/** Explicit project selection is needed by hosted entries. Standalone callers
 * may retain their existing id-only link; a prefix never confers ownership. */
export function taskPath(id: string, project?: string): string {
  return `/tasks/${encodeURIComponent(id)}${project === undefined ? '' : `?${new URLSearchParams({ project })}`}`;
}
