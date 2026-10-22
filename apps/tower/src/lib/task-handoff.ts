/** One task prefill for the Tower composer and copied MCP instructions. */

import { HANDOFF_LABEL, taskHandoffMetadataOf, type TaskHandoffMetadata } from "@noticeos/contract/task-metadata";

/** The label shared by every task filed from a Tower handoff. */
export const HANDOFF_SOURCE_LABEL = HANDOFF_LABEL;

/** Site keys identify the source; MCP project UUIDs come from list_projects. */
const ASSET_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Which Tower surface produced a handoff: the `noticeos_kind` metadata field
 * the poller joins on. `query` and `finding` also name `decisions.kind`
 * values; `page` and `alert` do not, because neither has an operator
 * disposition to record there, and the task is the marker. `alert` is the one
 * kind whose key is a database id, a flag's `flags.id`, the only value that
 * distinguishes two firings of one rule on one asset.
 */
export type TaskHandoffKind = "query" | "finding" | "page" | "alert";

export interface TaskHandoff {
  /** The receiving asset's id (`config/beads.json` `spokes[].asset`). */
  asset: string;
  /** Which Tower surface produced this. */
  kind: TaskHandoffKind;
  /** `decisions.key`: the normalized query, the finding's card key, the page
   * URL, or the flag id. The join key between the task and its row. */
  key: string;
  /** The rule that produced it: the decision kind for a query, the card key for
   * a finding, the flag's `rule_id` for an alert. */
  rule: string;
  /** Imperative task title, already short. */
  title: string;
  /** One line: what the work is, plus where it came from. */
  summary: string;
  /** Safety/evidence context must survive the compact work-summary cap. */
  applicabilityReview?: string;
  /** Where the evidence lives in the Tower — an absolute http(s) link, kept
   * whole (never clipped with the summary) so the filed task can be followed
   * back to what raised it. */
  evidenceUrl?: string;
  /** Priority, 0 (highest) to 4. */
  priority: number;
}

export type { TaskHandoffMetadata } from "@noticeos/contract/task-metadata";

/** The task the composer files. `project` is the site's logical key; copied
 * instructions resolve it to a projectId before calling create_task. */
export interface TaskHandoffPrefill {
  /** The `config/beads.json` spoke this files in — the asset id. */
  project: string;
  title: string;
  /** Every handoff starts as a task. */
  type: "task";
  /** Priority, 0–4. */
  priority: number;
  /** `noticeos-handoff`, `asset:<id>`, and the `rule:` / `key:` slugs — in the
   * order the payload writes them. Locked in the composer: they are the join
   * the badge and the poller read, not the operator's taxonomy. */
  labels: string[];
  /** Work summary and evidence. */
  description: string;
  metadata: TaskHandoffMetadata;
  /** Repeated out of the metadata so a surface can say "Linked to <kind>"
   * without reaching into a `Record<string, unknown>`. */
  kind: TaskHandoffKind;
  key: string;
}

/** The task this handoff would file, or `null` when it cannot name one. The
 * single source of the grammar: the copied payload below is rendered from
 * this, and the composer files this. */
export function taskHandoffPrefill(
  handoff: TaskHandoff | null,
): TaskHandoffPrefill | null {
  if (!handoff) return null;
  const asset = handoff.asset.trim();
  const key = handoff.key;
  const rule = handoff.rule;
  const title = oneLine(handoff.title);
  const metadata = taskHandoffMetadataOf({
    noticeos_source: HANDOFF_SOURCE_LABEL,
    noticeos_asset: asset,
    noticeos_kind: handoff.kind,
    noticeos_rule: rule,
    noticeos_key: key,
  });
  if (!metadata || !title) return null;

  const keyLabel = labelSlug(key);
  const ruleLabel = labelSlug(rule);
  return {
    project: asset,
    title: clip(title, 110),
    type: "task",
    priority: priorityDigit(handoff.priority),
    labels: [
      HANDOFF_SOURCE_LABEL,
      `asset:${asset}`,
      ...(ruleLabel ? [`rule:${ruleLabel}`] : []),
      ...(keyLabel ? [`key:${keyLabel}`] : []),
    ],
    description: [
      clip(oneLine(handoff.summary), 300),
      evidenceLink(handoff.evidenceUrl ?? findingEvidenceUrl(asset)),
      handoff.applicabilityReview ? oneLine(handoff.applicabilityReview) : null,
    ].filter(Boolean).join(" "),
    metadata,
    kind: handoff.kind,
    key,
  };
}

/** Copied instructions carry data, never a checkout-dependent shell command. */
export function taskHandoffSection(handoff: TaskHandoff | null): string[] {
  const prefill = taskHandoffPrefill(handoff);
  if (!prefill) return [];
  const { project: asset, kind: _kind, key: _key, ...task } = prefill;
  const payload = JSON.stringify(task, null, 2);
  const fence = fenceFor(payload);

  return [
    "## File this task",
    "",
    "The **File task** button opens the same task already filled in. To file it through the NoticeOS MCP task tools:",
    "",
    "1. Call `list_workspaces`, select the workspace that owns this site, and read `get_task_guide`.",
    `2. Call \`list_projects\` with that workspace. Match the site's logical key ${JSON.stringify(asset)} to the project's \`key\`, and use its \`projectId\` as \`project\`. The site key is not a project UUID. If no project matches, stop and ask the operator.`,
    "3. Search with `list_tasks` before filing, as the guide requires. Add evidence to matching work with `comment_on_task`; otherwise call `create_task` with the task fields below, the selected `workspace` and `project`, your `model`, and a fresh `idempotency_key`. Reuse the same key and arguments on retries. Keep the labels, metadata and evidence link intact.",
    "",
    `${fence}json`,
    payload,
    fence,
    "",
    "4. Use the returned task id in commits. Call `claim_task` when starting and `close_task` when complete, with the selected `workspace` and `project`, the returned id as `task`, your `model`, and a fresh `idempotency_key` for each operation. Reuse each key and its arguments on retries. The close reason must cite the decision and evidence, such as a commit or URL. A closed task records a decision, **not proof of shipment or outcome**. Verify the change and its measured result separately.",
    "",
    "If the task tools are unavailable, reconnect the NoticeOS server with `/mcp` before filing. Nothing files, closes, or measures it on your behalf.",
    "",
  ];
}

/** Where a finding and its evidence live in the Tower, as an absolute link a
 * filed task can carry. Undefined outside a browser or for something that is
 * not an asset id. */
export function findingEvidenceUrl(asset: string): string | undefined {
  if (typeof window === "undefined" || !ASSET_ID.test(asset)) return undefined;
  return `${window.location.origin}/assets/${encodeURIComponent(asset)}`;
}

/** `Evidence: <url>` for an http(s) link, nothing for anything else — a
 * description never carries a scheme a shell or a reader would mistake. */
function evidenceLink(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return `Evidence: ${oneLine(parsed.href)}`;
  } catch {
    return null;
  }
}

/** Labels aid discovery; exact identity stays in metadata even when slugs collide. */
function labelSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .slice(0, 48)
    .replace(/^-+|-+$/g, "");
}

/** Display text stays on one line without control or format characters. */
function oneLine(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

function priorityDigit(priority: number): number {
  if (!Number.isFinite(priority)) return 2;
  return Math.min(4, Math.max(0, Math.round(priority)));
}

/** A query may contain backticks; the fence has to outrun the longest run in
 * the block or the payload spills out of it. */
function fenceFor(block: string): string {
  const longest = (block.match(/`+/g) ?? []).reduce(
    (max, run) => Math.max(max, run.length),
    0,
  );
  return "`".repeat(Math.max(3, longest + 1));
}
