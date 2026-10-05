export function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "That did not work.";
}
