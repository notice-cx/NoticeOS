import type { Transaction, WorkspaceStore } from "@noticeos/postgres";
import type {
  AnalysisResult, AnalysisRun, AnalysisRunSource, AnalysisRunSummary, AnalysisTrigger, AnalysisWorkflow,
  AnalysisWorkflowResponse, CreateAnalysisWorkflow,
} from "../shared/analysis-workflows";
import { analysisRunbook, buildAnalysisEvidence } from "./analysis-workflow-evidence";

const MAX_WORKFLOWS = 64;
const MAX_INPUT_BYTES = 1024 * 1024;
const RUN_HISTORY = 30;
const WORKFLOW_COLUMNS = "workflow_id, name, template, asset_ids, trigger_config, enabled, version, created_at, updated_at";
const RUN_SUMMARY_COLUMNS = "run_id, workflow_id, source, retry_of, scheduled_at, created_at, completed_at, result->>'outcome' AS outcome";
const RUN_COLUMNS = RUN_SUMMARY_COLUMNS + ", input, result";

type WorkflowRow = {
  workflow_id: string; name: string; template: AnalysisWorkflow["template"]; asset_ids: string[]; trigger_config: string;
  enabled: boolean; version: number; created_at: string; updated_at: string;
};
type RunSummaryRow = {
  run_id: string; workflow_id: string; source: AnalysisRunSource; retry_of: string | null; scheduled_at: string | null;
  created_at: string; completed_at: string | null; outcome: AnalysisResult["outcome"] | null;
};
type RunRow = RunSummaryRow & { input: string; result: string | null };
type RunInput = Pick<AnalysisRun, "workflow" | "runbook" | "evidence">;
type StartAnalysisRun = { source: "manual"; key: string; retryOf?: string } | { source: "weekly"; scheduledAt: string };
export interface AnalysisActor { principalId: string; clientId?: string }

export class AnalysisWorkflowRefused extends Error {
  constructor(readonly status: 400 | 404 | 409, readonly code: string) { super(code); }
}
const refuse = (status: AnalysisWorkflowRefused["status"], code: string): never => {
  throw new AnalysisWorkflowRefused(status, code);
};

function workflowFrom(row: WorkflowRow): AnalysisWorkflow {
  return {
    id: row.workflow_id, name: row.name, template: row.template, assetIds: row.asset_ids, trigger: JSON.parse(row.trigger_config) as AnalysisTrigger,
    enabled: row.enabled, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function summaryFrom(row: RunSummaryRow): AnalysisRunSummary {
  return { id: row.run_id, workflowId: row.workflow_id, source: row.source, retryOf: row.retry_of,
    createdAt: row.created_at, completedAt: row.completed_at, scheduledAt: row.scheduled_at, outcome: row.outcome };
}

function runFrom(row: RunRow): AnalysisRun {
  return { ...summaryFrom(row), ...(JSON.parse(row.input) as RunInput), result: row.result === null ? null : JSON.parse(row.result) as AnalysisResult };
}

async function findWorkflow(tx: Transaction, workflowId: string, lock = false): Promise<AnalysisWorkflow> {
  const [row] = await tx.query<WorkflowRow>(`SELECT ${WORKFLOW_COLUMNS} FROM noticeos.analysis_workflows
    WHERE workspace_id=$1::uuid AND workflow_id=$2::uuid ${lock ? "FOR UPDATE" : ""}`, [tx.workspaceId, workflowId]);
  return row ? workflowFrom(row) : refuse(404, "analysis_workflow_not_found");
}

async function findRun(tx: Transaction, workflowId: string, runId: string, lock = false): Promise<RunRow> {
  const [row] = await tx.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM noticeos.analysis_workflow_runs
    WHERE workspace_id=$1::uuid AND workflow_id=$2::uuid AND run_id=$3::uuid ${lock ? "FOR UPDATE" : ""}`, [tx.workspaceId, workflowId, runId]);
  return row ?? refuse(404, "analysis_run_not_found");
}

async function requireAssets(tx: Transaction, assetIds: readonly string[]): Promise<void> {
  const rows = await tx.query(`SELECT asset_id FROM noticeos.assets
    WHERE workspace_id=$1::uuid AND asset_id=ANY($2::text[]) AND status<>'retired' AND NOT is_os`, [tx.workspaceId, assetIds]);
  if (rows.length !== assetIds.length) refuse(409, "analysis_assets_unavailable");
}

export async function listAnalysisWorkflows(store: WorkspaceStore): Promise<AnalysisWorkflow[]> {
  return store.read(async tx => {
    const rows = await tx.query<WorkflowRow>(`SELECT ${WORKFLOW_COLUMNS} FROM noticeos.analysis_workflows
      WHERE workspace_id=$1::uuid ORDER BY name, workflow_id LIMIT ${MAX_WORKFLOWS}`, [tx.workspaceId]);
    return rows.map(workflowFrom);
  });
}

export async function readAnalysisWorkflow(store: WorkspaceStore, workflowId: string): Promise<AnalysisWorkflowResponse> {
  return store.read(async tx => {
    const workflow = await findWorkflow(tx, workflowId);
    const history = await tx.query<RunSummaryRow>(`SELECT ${RUN_SUMMARY_COLUMNS} FROM noticeos.analysis_workflow_runs
      WHERE workspace_id=$1::uuid AND workflow_id=$2::uuid ORDER BY created_at DESC, run_id DESC LIMIT ${RUN_HISTORY}`, [tx.workspaceId, workflowId]);
    return { workflow, runs: history.map(summaryFrom) };
  });
}

export async function createAnalysisWorkflow(store: WorkspaceStore, input: CreateAnalysisWorkflow, key: string, actor: AnalysisActor): Promise<AnalysisWorkflow> {
  return store.write(async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('analysis-workflows/' || $1::text, 0))", [tx.workspaceId]);
    const trigger = JSON.stringify(input.trigger);
    const [match] = await tx.query<WorkflowRow & { same: boolean }>(`SELECT ${WORKFLOW_COLUMNS},
        name=$3 AND template=$4 AND asset_ids=$5::text[] AND trigger_config=$6::jsonb AS same
      FROM noticeos.analysis_workflows WHERE workspace_id=$1::uuid AND create_key=$2`,
    [tx.workspaceId, key, input.name, input.template, input.assetIds, trigger]);
    if (match) return match.same ? workflowFrom(match) : refuse(409, "analysis_request_conflict");
    const [counter] = await tx.query<{ count: number }>(`SELECT count(*)::int AS count FROM noticeos.analysis_workflows
      WHERE workspace_id=$1::uuid`, [tx.workspaceId]);
    if ((counter?.count ?? MAX_WORKFLOWS) >= MAX_WORKFLOWS) refuse(409, "analysis_workflow_limit");
    await requireAssets(tx, input.assetIds);
    const [created] = await tx.query<WorkflowRow>(`INSERT INTO noticeos.analysis_workflows
      (workspace_id, workflow_id, create_key, name, template, asset_ids, trigger_config, created_by)
      VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::text[],$7::jsonb,$8::uuid) RETURNING ${WORKFLOW_COLUMNS}`,
    [tx.workspaceId, crypto.randomUUID(), key, input.name, input.template, input.assetIds, trigger, actor.principalId]);
    return workflowFrom(created!);
  });
}

export async function setAnalysisWorkflowEnabled(store: WorkspaceStore, workflowId: string, enabled: boolean, version: number): Promise<AnalysisWorkflow> {
  return store.write(async tx => {
    const workflow = await findWorkflow(tx, workflowId, true);
    if (workflow.enabled === enabled && (workflow.version === version || workflow.version === version + 1)) return workflow;
    if (workflow.version !== version) refuse(409, "analysis_workflow_changed");
    const [updated] = await tx.query<WorkflowRow>(`UPDATE noticeos.analysis_workflows SET enabled=$3,version=version+1,updated_at=clock_timestamp()
      WHERE workspace_id=$1::uuid AND workflow_id=$2::uuid RETURNING ${WORKFLOW_COLUMNS}`, [tx.workspaceId, workflowId, enabled]);
    return workflowFrom(updated!);
  });
}

function weeklyDay(trigger: AnalysisTrigger, scheduledAt: string): string {
  if (trigger.kind !== "weekly" || !Number.isFinite(Date.parse(scheduledAt))) return refuse(409, "analysis_schedule_changed");
  const pieces = new Intl.DateTimeFormat("en-GB", { timeZone: trigger.timeZone, weekday: "short", year: "numeric",
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(scheduledAt));
  const value = (kind: Intl.DateTimeFormatPartTypes) => pieces.find(piece => piece.type === kind)?.value;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(value("weekday") ?? "");
  if (weekday !== trigger.weekday || Number(value("hour")) !== trigger.hour || Number(value("minute")) !== trigger.minute)
    return refuse(409, "analysis_schedule_changed");
  return `${value("year")}-${value("month")}-${value("day")}`;
}

async function findRequest(tx: Transaction, id: string, key: string, expectedRetry: string | null): Promise<AnalysisRun | null> {
  const [row] = await tx.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM noticeos.analysis_workflow_runs
    WHERE workspace_id=$1::uuid AND workflow_id=$2::uuid AND request_key=$3`, [tx.workspaceId, id, key]);
  if (row && row.retry_of !== expectedRetry) refuse(409, "analysis_request_conflict");
  return row ? runFrom(row) : null;
}

export async function startAnalysisWorkflowRun(store: WorkspaceStore, workflowId: string, request: StartAnalysisRun, actor: AnalysisActor,
  now = () => new Date().toISOString()): Promise<AnalysisRun> {
  const weekly = request.source === "weekly";
  const scheduledAt = weekly ? request.scheduledAt : null;
  const retryOf = request.source === "manual" ? request.retryOf ?? null : null;
  const snapshot = await store.read(async tx => {
    const workflow = await findWorkflow(tx, workflowId);
    const key = request.source === "weekly" ? `weekly:${weeklyDay(workflow.trigger, request.scheduledAt)}` : `manual:${request.key}`;
    const existing = await findRequest(tx, workflowId, key, retryOf);
    if (!existing) {
      if (!workflow.enabled) refuse(409, "analysis_workflow_paused");
      if (scheduledAt && Date.parse(scheduledAt) < Date.parse(workflow.updatedAt)) refuse(409, "analysis_schedule_changed");
      if (!retryOf) await requireAssets(tx, workflow.assetIds);
    }
    const prior = !existing && retryOf ? runFrom(await findRun(tx, workflowId, retryOf)) : null;
    return { key, workflow, existing, prior };
  });
  if (snapshot.existing) return snapshot.existing;
  const { workflow } = snapshot;
  // Evidence reads run outside the row lock, then publication verifies the same definition version.
  const input: RunInput = snapshot.prior ? { workflow: snapshot.prior.workflow, runbook: snapshot.prior.runbook, evidence: snapshot.prior.evidence }
    : { workflow, runbook: analysisRunbook(workflow.template), evidence: await buildAnalysisEvidence(store, {
      template: workflow.template, assetIds: workflow.assetIds, asOf: scheduledAt ?? now(),
    }) };
  const inputJson = JSON.stringify(input);
  if (new TextEncoder().encode(inputJson).byteLength > MAX_INPUT_BYTES) return refuse(409, "analysis_evidence_too_large");
  return store.write(async tx => {
    const current = await findWorkflow(tx, workflowId, true);
    const existing = await findRequest(tx, workflowId, snapshot.key, retryOf);
    if (existing) return existing;
    if (!current.enabled) refuse(409, "analysis_workflow_paused");
    if (current.version !== workflow.version) refuse(409, "analysis_workflow_changed");
    if (!retryOf) await requireAssets(tx, workflow.assetIds);
    const [row] = await tx.query<RunRow>(`INSERT INTO noticeos.analysis_workflow_runs
        (workspace_id, workflow_id, run_id, request_key, source, retry_of, scheduled_at, input, created_by)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7::timestamptz,$8::jsonb,$9::uuid) RETURNING ${RUN_COLUMNS}`,
    [tx.workspaceId, workflowId, crypto.randomUUID(), snapshot.key, weekly ? "weekly" : retryOf ? "retry" : "manual", retryOf,
      scheduledAt, inputJson, actor.principalId]);
    return runFrom(row!);
  });
}

export async function readAnalysisWorkflowRun(store: WorkspaceStore, workflowId: string, runId: string): Promise<AnalysisRun> {
  return store.read(async tx => runFrom(await findRun(tx, workflowId, runId)));
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resultText(input: unknown, max: number): input is string {
  return typeof input === "string" && input.trim().length > 0 && input.length <= max
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(input);
}

function resultFrom(input: unknown, known: ReadonlySet<string>): AnalysisResult {
  const invalid = () => refuse(400, "invalid_analysis_result");
  if (!record(input) || Object.keys(input).length !== 3 || !resultText(input.summary, 2_000) || !Array.isArray(input.findings)
    || (input.outcome !== "findings" && input.outcome !== "no-action" && input.outcome !== "insufficient-evidence" && input.outcome !== "failed")) return invalid();
  const findings = input.findings;
  if (findings.length > 20 || (input.outcome === "findings") !== (findings.length > 0)) return invalid();
  return {
    outcome: input.outcome,
    summary: input.summary.trim(),
    findings: findings.map((finding: unknown) => {
      if (!record(finding) || Object.keys(finding).length !== 3 || !resultText(finding.title, 160)
        || !resultText(finding.detail, 1_000) || !Array.isArray(finding.citationIds) || finding.citationIds.length < 1
        || finding.citationIds.length > 12 || new Set(finding.citationIds).size !== finding.citationIds.length
        || !finding.citationIds.every(id => typeof id === "string" && known.has(id))) return invalid();
      return { title: finding.title.trim(), detail: finding.detail.trim(), citationIds: finding.citationIds };
    }),
  };
}

export async function completeAnalysisWorkflowRun(store: WorkspaceStore, workflowId: string, runId: string,
  input: unknown, actor: AnalysisActor): Promise<AnalysisRun> {
  return store.write(async tx => {
    const row = await findRun(tx, workflowId, runId, true);
    const run = runFrom(row);
    const result = resultFrom(input, new Set(run.evidence.citations.map(citation => citation.id)));
    const json = JSON.stringify(result);
    if (row.result !== null) {
      const [match] = await tx.query<{ same: boolean }>("SELECT $1::jsonb = $2::jsonb AS same", [row.result, json]);
      return match?.same ? run : refuse(409, "analysis_result_already_recorded");
    }
    const [completed] = await tx.query<RunRow>(`UPDATE noticeos.analysis_workflow_runs
      SET result=$4::jsonb,completed_by=$5::uuid,completed_client_id=$6,completed_at=now()
      WHERE workspace_id=$1::uuid AND workflow_id=$2::uuid AND run_id=$3::uuid RETURNING ${RUN_COLUMNS}`,
    [tx.workspaceId, workflowId, runId, json, actor.principalId, actor.clientId ?? null]);
    return runFrom(completed!);
  });
}
