import type { AnalysisEvidence, AnalysisRunbook, AnalysisTemplateId } from "./analysis-runbooks";

export type { AnalysisEvidence, AnalysisRunbook, AnalysisTemplateId } from "./analysis-runbooks";

export {
  ANALYSIS_WORKFLOWS_PATH,
  analysisAssignmentRequest,
  analysisId,
  analysisWorkflowRequest,
  type AnalysisAssignmentRequest,
  type AnalysisWorkflowRequest,
} from "../../../scripts/analysis-workflow-request.mjs";

export type AnalysisTrigger = { kind: "manual" } | {
  kind: "weekly";
  /** 0 is Sunday, 6 is Saturday. */
  weekday: number;
  hour: number;
  minute: number;
  timeZone: string;
};

export interface CreateAnalysisWorkflow {
  name: string;
  template: AnalysisTemplateId;
  assetIds: string[];
  trigger: AnalysisTrigger;
}

export interface AnalysisWorkflow extends CreateAnalysisWorkflow {
  id: string;
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type AnalysisRunSource = "manual" | "weekly" | "retry";

export interface AnalysisFinding {
  title: string;
  detail: string;
  citationIds: string[];
}

export interface AnalysisResult {
  outcome: "findings" | "no-action" | "insufficient-evidence" | "failed";
  summary: string;
  findings: AnalysisFinding[];
}

export interface AnalysisRunSummary {
  id: string;
  workflowId: string;
  source: AnalysisRunSource;
  retryOf: string | null;
  createdAt: string;
  scheduledAt: string | null;
  completedAt: string | null;
  outcome: AnalysisResult["outcome"] | null;
}

export interface AnalysisRun extends AnalysisRunSummary {
  workflow: AnalysisWorkflow;
  runbook: AnalysisRunbook;
  evidence: AnalysisEvidence;
  result: AnalysisResult | null;
  assignment?: AnalysisAssignment | null;
}

export interface AnalysisAssignment {
  projectId: string;
  startedAt: string;
  deliveryStartedAt: string | null;
  taskId: string | null;
}

export interface AnalysisAssignmentProject {
  projectId: string;
  displayName: string;
}

export interface AnalysisWorkflowsResponse {
  workflows: AnalysisWorkflow[];
  runbooks: readonly AnalysisRunbook[];
}

export interface AnalysisWorkflowResponse {
  workflow: AnalysisWorkflow;
  runs: AnalysisRunSummary[];
}
