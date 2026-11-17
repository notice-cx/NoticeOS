import type { BeadsProjectInput } from '../packages/contract/src/task-snapshot.mjs';

type Project = Pick<BeadsProjectInput, 'asset' | 'prefix'>;
export const TASK_CLOSES_DAYS: number;
export function tasksClosedSince(now: number): string;
export function tasksClosesSince(now: number): string;
export function taskProjectError(project: Project, error: string): BeadsProjectInput;
export function summarizeTaskProject(project: Project, reads: Record<string, unknown>,
  options?: { closedSince?: string; closesSince?: string }): BeadsProjectInput;
