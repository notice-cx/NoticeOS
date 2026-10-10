/**
 * The "File this task" section every copied handoff carries, and the same
 * task as data for the Tower's own composer. A copied handoff is executed by
 * an agent working in the asset's own repo, a spoke on the portfolio task hub
 * (`config/beads.json`); the task id becomes the ref the commit quotes, the
 * annotation carries, and the outcome watch window is keyed to.
 *
 * Two consumers, one grammar: `taskHandoffPrefill` is the single computation
 * of what the task is, `taskHandoffSection` renders it as the shell command an
 * agent pastes, and `TaskComposer` renders it as a form. They cannot drift,
 * because the command is built from the prefill; `test/task-composer.test.tsx`
 * pins that by parsing the emitted command back apart.
 *
 * Everything interpolated into the command is POSIX single-quoted (`'\''` for
 * an embedded quote), never double-quoted: inside single quotes a backtick,
 * `$(…)`, or `"` is inert. The prefill carries the same values unquoted, since
 * the lane passes `bd` its arguments as an array.
 */

import { HANDOFF_LABEL } from "@noticeos/contract/task-metadata";

/** The fixed label every task filed from a Tower handoff carries, so the whole
 * lane is one `bd list -l noticeos-handoff` away (older tasks carry
 * `reindex-handoff`, and every reader finds both:
 * packages/contract/src/task-metadata.mts). */
export const HANDOFF_SOURCE_LABEL = HANDOFF_LABEL;

/** Asset ids come from the seeded `assets` table and are what
 * `config/beads.json` joins a spoke on. A value outside this shape is not an
 * asset id, and the section that tells an agent which repo to file in is
 * dropped rather than guessed. */
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
  /** `bd` priority, 0 (highest) to 4. */
  priority: number;
}

/** The `noticeos_*` grammar, in the ONE order both consumers emit it. Key order
 * is load-bearing for the copied command (it is `JSON.stringify`d into
 * `--metadata`) and irrelevant to the lane, so the stricter reader wins.
 *
 * A `type` rather than an `interface` on purpose: only a type alias picks up an
 * implicit index signature, and the composer hands this straight to the lane's
 * `metadata?: Record<string, unknown>` without a cast that would let a renamed
 * field through. */
export type TaskHandoffMetadata = {
  noticeos_source: typeof HANDOFF_SOURCE_LABEL;
  noticeos_asset: string;
  noticeos_kind: TaskHandoffKind;
  noticeos_rule: string;
  noticeos_key: string;
};

/**
 * The task a handoff files, as data: what `TaskComposer` opens with and what
 * `POST /api/tasks` receives, byte-for-byte the same task the copied `bd
 * create` makes. `null` where the command would also be dropped.
 */
export interface TaskHandoffPrefill {
  /** The `config/beads.json` spoke this files in — the asset id. */
  project: string;
  title: string;
  /** `bd -t`. Every handoff is a `task`; the composer lets the operator change
   * it before filing. */
  type: "task";
  /** `bd -p`, 0–4. */
  priority: number;
  /** `noticeos-handoff`, `asset:<id>`, and the `rule:` / `key:` slugs — in the
   * order the command writes them. Locked in the composer: they are the join
   * the badge and the poller read, not the operator's taxonomy. */
  labels: string[];
  /** `bd -d`. */
  description: string;
  metadata: TaskHandoffMetadata;
  /** Repeated out of the metadata so a surface can say "Linked to <kind>"
   * without reaching into a `Record<string, unknown>`. */
  kind: TaskHandoffKind;
  key: string;
}

/** The task this handoff would file, or `null` when it cannot name one. The
 * single source of the grammar: the copied command below is rendered from
 * this, and the composer files this. */
export function taskHandoffPrefill(
  handoff: TaskHandoff | null,
): TaskHandoffPrefill | null {
  if (!handoff) return null;
  const asset = handoff.asset.trim();
  const key = oneLine(handoff.key);
  const rule = oneLine(handoff.rule);
  const title = oneLine(handoff.title);
  if (!ASSET_ID.test(asset) || !key || !rule || !title) return null;

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
      evidenceLink(handoff.evidenceUrl),
      handoff.applicabilityReview ? oneLine(handoff.applicabilityReview) : null,
    ].filter(Boolean).join(" "),
    metadata: {
      noticeos_source: HANDOFF_SOURCE_LABEL,
      noticeos_asset: asset,
      noticeos_kind: handoff.kind,
      noticeos_rule: rule,
      noticeos_key: key,
    },
    kind: handoff.kind,
    key,
  };
}

/** The section's lines, or `[]` when the handoff cannot name a real repo and a
 * real key — a snapshot vintage that predates either degrades to the handoff
 * it always was rather than emitting a command that files against nothing. */
export function taskHandoffSection(handoff: TaskHandoff | null): string[] {
  const prefill = taskHandoffPrefill(handoff);
  if (!prefill) return [];
  const asset = prefill.project;

  const command = [
    `bd create ${shellQuote(prefill.title)} \\`,
    `  -t ${prefill.type} \\`,
    `  -p ${prefill.priority} \\`,
    ...prefill.labels.map((label) => `  -l ${shellQuote(label)} \\`),
    `  --metadata ${shellQuote(JSON.stringify(prefill.metadata))} \\`,
    `  -d ${shellQuote(prefill.description)}`,
  ].join("\n");
  const fence = fenceFor(command);

  return [
    "## File this task",
    "",
    "The row this came from has a **File task** button, which opens this already filled in and files it for you. That is the path if NoticeOS is in front of you. What follows is the same task for a reader who does not have it open — an agent standing in the asset's own repository.",
    "",
    `Run it in the \`${asset}\` asset repo — the \`repo\` path recorded for that asset in NoticeOS \`config/beads.json\`. The command takes its project from the directory it runs in, so running it anywhere else files against the wrong asset.`,
    "",
    `${fence}sh`,
    command,
    fence,
    "",
    `Quote the id it prints in every commit for this work, and close it with \`bd close <id> -r '<decision and evidence>'\` once the work is complete. A closed task records a decision, **not proof of shipment or outcome**. Verify any claimed change and its measured result separately. Nothing files, closes, or measures it on your behalf.`,
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

/** Labels are a comma-separated list to `bd`, so a comma inside one value
 * silently becomes two labels. The label carries a slug; the exact key travels
 * in metadata, which `bd list --metadata-field` queries verbatim. */
function labelSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .slice(0, 48)
    .replace(/^-+|-+$/g, "");
}

/** POSIX single-quoting: the only shell quoting with no escape sequences
 * inside it. A literal quote closes the string, escapes, and reopens. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** One line, no control or format characters: a newline would break the command
 * across lines it does not own, and a bidi override would let the rendered
 * command read differently from the one that runs. */
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
 * the block or the command spills out of it. */
function fenceFor(block: string): string {
  const longest = (block.match(/`+/g) ?? []).reduce(
    (max, run) => Math.max(max, run.length),
    0,
  );
  return "`".repeat(Math.max(3, longest + 1));
}
