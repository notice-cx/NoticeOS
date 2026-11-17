import { createHash } from 'node:crypto';

/** The journal identity of a server registry. Callers validate their registry
 * before using this pure serialization; callbacks never enter its digest. */
export function hostedJobDefinitionHash(version: string, steps: readonly {
  readonly key: string; readonly kind: 'database' | 'effect'; readonly action: string;
  readonly terminalReportedFailure?: true;
}[]): string {
  return createHash('sha256').update(JSON.stringify({ version,
    steps: steps.map(({ key, kind, action, terminalReportedFailure }) => ({ key, kind, action, terminalReportedFailure })),
  })).digest('hex');
}
