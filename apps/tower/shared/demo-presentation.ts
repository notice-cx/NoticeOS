/** Read-only presentation from the fixed demo's completed activity journal:
 * its latest synthetic write, and the last simulated day once one completed. */
export interface DemoPresentation {
  generatedAt: string | null;
  through: string | null;
}
export const DEMO_PRESENTATION_PATH = '/api/demo/presentation';
export function decodeDemoPresentation(value: unknown): DemoPresentation {
  const invalid = (): never => { throw new Error('Demo generation unavailable.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || !('generatedAt' in record) || !('through' in record)) return invalid();
  if (record.generatedAt === null && record.through === null) return { generatedAt: null, through: null };
  if (typeof record.generatedAt !== 'string' || !Number.isFinite(Date.parse(record.generatedAt))
    || new Date(record.generatedAt).toISOString() !== record.generatedAt) return invalid();
  if (record.through === null) return { generatedAt: record.generatedAt, through: null };
  if (typeof record.through !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(record.through)
    || !Number.isFinite(Date.parse(record.through)) || new Date(record.through).toISOString().slice(0, 10) !== record.through) return invalid();
  return { generatedAt: record.generatedAt, through: record.through };
}
