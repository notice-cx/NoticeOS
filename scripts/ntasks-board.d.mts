interface NtasksReads {
  call(input: { method: 'GET'; path: string }): Promise<{ status: number; body: unknown }>;
}

export const FEED_PAGE: number;
export const FEED_PAGES: number;
export const LABEL_PAGE: number;
export const LABEL_PAGES: number;
export const LABEL_READS: Readonly<Record<'handoffs' | 'panelReview', readonly string[]>>;
export function runnerRow(task: Record<string, unknown>): Record<string, unknown>;
export function readLabelled(service: NtasksReads, projectId: string, label: string,
  options?: { pages?: number }): Promise<Record<string, unknown>[]>;
export function readLabels(service: NtasksReads, projectId: string, labels: readonly string[]): Promise<Record<string, unknown>[]>;
export function boardReads(board: unknown, closes: unknown, labelled?: Record<string, unknown>): Record<string, unknown>;
export function readFeed(service: NtasksReads, cursor: number, options?: { pages?: number; limit?: number; checkHiddenEvents?: boolean }): Promise<{
  changed: Set<string>; cursor: number; complete: boolean;
}>;
