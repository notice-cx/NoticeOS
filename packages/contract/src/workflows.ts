/** Execution evidence is separate from pulse metrics and outcome evaluations. */
export type WorkflowStepKind = 'task' | 'collection' | 'check' | 'storage' | 'llm' | 'tool' | 'approval';
export type WorkflowStepState = 'running' | 'succeeded' | 'failed' | 'skipped' | 'waiting';

export interface WorkflowStepDefinition {
  id: string;
  label: string;
  description: string;
  kind: WorkflowStepKind;
  after: string[];
}

export interface WorkflowStepRun {
  id: string;
  attempt: number;
  startedAt: string;
  finishedAt?: string;
  state: WorkflowStepState;
  summary?: string;
  output?: WorkflowStepOutput;
}

export interface WorkflowOutputValue {
  key: string;
  label: string;
  value: string | number | boolean;
  unit?: 'USD';
}

/** A bounded projection of operational results, never credentials or raw responses. */
export interface WorkflowStepOutput {
  version: 1;
  metrics: WorkflowOutputValue[];
  fields: WorkflowOutputValue[];
  items: { label: string; state: 'succeeded' | 'failed' | 'skipped' | 'unknown'; fields: WorkflowOutputValue[] }[];
  totalItems: number;
  truncated: boolean;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  definitionVersion: number | null;
  startedAt: string;
  finishedAt?: string;
  state: WorkflowStepState | 'unknown';
  /** Only observed trigger context belongs here; legacy records have none. */
  trigger?: { kind: 'schedule' | 'manual' | 'event' | 'recovery'; reference?: string };
  steps: WorkflowStepRun[] | null;
}
