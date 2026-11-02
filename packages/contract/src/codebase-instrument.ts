/** Legacy reports can compare with other legacy reports of the same versions.
 * Reconstructed reports require both a pinned image and identical settings. */
export function comparableCodebaseTools(
  a: { image?: string; profile?: string; scc: string; jscpd: string; lizard: string },
  b: { image?: string; profile?: string; scc: string; jscpd: string; lizard: string },
): boolean {
  return a.scc === b.scc && a.jscpd === b.jscpd && a.lizard === b.lizard
    && a.image === b.image && a.profile === b.profile;
}

export function comparableCodebaseReports(
  a: { tools: Parameters<typeof comparableCodebaseTools>[0]; paths?: readonly string[] },
  b: { tools: Parameters<typeof comparableCodebaseTools>[0]; paths?: readonly string[] },
): boolean {
  return comparableCodebaseTools(a.tools, b.tools)
    && JSON.stringify([...(a.paths ?? [])].sort()) === JSON.stringify([...(b.paths ?? [])].sort());
}
