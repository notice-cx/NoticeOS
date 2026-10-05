import { useOwnerPreferences } from '@/lib/browser-context';
import { CircleDashed, TriangleAlert } from "lucide-react";
import { useState } from "react";
import {
  TUNE_PROPOSAL_SHARE,
  type AlertRuleStat,
  type TuneProposalFacts,
  ruleLabel,
  tuneProposal,
  tuneShare,
} from "@shared/alert-rules";
import { SegmentBar } from "@/components/SegmentBar";
import {
  FileTaskButton,
  type FileTaskButtonProps,
  type TaskComposerPrefill,
} from "@/components/TaskComposer";
import { Button } from "@/components/ui/button";
import { useOsAssetId } from "@/hooks/useOsAssetId";
import { formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import { storageKey } from "@/lib/browser-storage";

/**
 * HOW OFTEN THE OPERATOR ANSWERED THIS RULE BY TUNING IT (bead `ro-ayxy`) —
 * docs/15 flow E's false-positive rate, on the two surfaces where a rule is
 * looked at: `/settings#alert-rules`, and the Tune panel on the alert the rule
 * just fired.
 *
 * ONE COMPONENT, TWO SURFACES, on purpose. The panel is where the operator is
 * about to quieten a rule and the settings page is where they go when nothing is
 * firing; a second spelling of the same figure would let the two disagree about
 * a number the OS is meant to eventually act on by itself.
 *
 * REGISTRY JUSTIFICATION. Nothing here draws a share WITH its counts and its own
 * missing states. `SegmentBar` is the shape and is composed here rather than
 * duplicated — it holds no figures, no denominator and no empty state. `Meter`
 * is one value against a CAP with over-cap as its own amber, and a tune rate has
 * no cap. `ProgressRing` counts DISCRETE steps finished out of a known total —
 * this total is not known in advance and grows every time the rule fires.
 * `EmptyState` is a section's blank slate, block-sized with a `text-base` title;
 * what a rule with no firings needs is ONE quiet line inside a list of rules.
 *
 * THE BAR IS THE SHAPE, THE TEXT IS THE FIGURES — `SegmentBar`'s own rule. The
 * amber segment says "the operator answered by changing the rule", against the
 * muted rest of the alerts they finished with some other way.
 */
export interface TuneRateProps {
  /** This rule's counts, or `null` when the read returned nothing for it —
   * which is a rule that has not fired in the window, not a rule at zero. */
  stat: AlertRuleStat | null;
  /** The window the counts cover, so the sentence states its own scope. */
  windowDays: number;
  /**
   * File the proposal's task somewhere other than the operator's own task
   * database — the gallery's escape hatch, handed straight to
   * `FileTaskButton`, exactly as `KnobEditor` and `TaskComposer` take one. A
   * demo is then a real form whose commit is a promise.
   */
  onFileTask?: FileTaskButtonProps["onFile"];
  /** Stand in for the write lane's own answer, so the gallery can show the
   * proposal on a deployment that cannot file anything. */
  taskCapabilities?: FileTaskButtonProps["capabilities"];
  /** Whether a decline is remembered across reloads. `false` in the gallery —
   * the demo rule ids are REAL rule ids, and a reviewer pressing the demo's
   * decline would otherwise silence the operator's own proposal. */
  rememberDecline?: boolean;
  className?: string;
}

export function TuneRate({
  stat,
  windowDays,
  onFileTask,
  taskCapabilities,
  rememberDecline = true,
  className,
}: TuneRateProps) {
  if (stat === null || stat.fired === 0) {
    return (
      <p
        className={cn(
          "flex items-center gap-1.5 text-xs leading-snug text-muted-foreground",
          className,
        )}
        data-tune-rate="never-fired"
      >
        <CircleDashed className="size-3.5 shrink-0" aria-hidden />
        No firings yet — nothing in the last {windowDays} days.
      </p>
    );
  }

  const share = tuneShare(stat);
  const fired = `${stat.fired} fired in ${windowDays} days`;

  return (
    <div className={cn("flex flex-col gap-1", className)} data-tune-rate={stat.ruleId}>
      {share === null ? (
        // Fired, but the operator has not finished with any of them. An empty
        // track here would read as a measured 0% — a rule this page has cleared
        // — which is the one thing the store cannot say yet.
        <p
          className="flex items-center gap-1.5 text-xs leading-snug text-muted-foreground"
          data-tune-rate-state="unsettled"
        >
          <CircleDashed className="size-3.5 shrink-0" aria-hidden />
          {fired} · none settled yet
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            {/* THE PROPOSAL LINE IS DRAWN, NOT DESCRIBED (bead
                `ro-ujb9.96.6.7`). A tick at the share the OS proposes tuning at
                sits on the bar, so "is this rule over the line" is where the
                amber ends relative to the mark — the sentence that used to
                state the threshold under the proposal is the tick. */}
            <span className="relative flex w-full max-w-[7rem] items-center">
              <SegmentBar
                ariaLabel={`${stat.tuned} of ${stat.settled} settled alerts from this rule were answered by tuning it`}
                segments={[
                  { name: "tuned", value: stat.tuned, fill: "bg-warn" },
                  {
                    name: "settled-otherwise",
                    value: stat.settled - stat.tuned,
                    fill: "bg-muted-foreground/30",
                  },
                ]}
              />
              <span
                aria-hidden
                className="absolute -inset-y-0.5 w-px bg-foreground/70"
                style={{ left: `${Math.round(TUNE_PROPOSAL_SHARE * 100)}%` }}
                title={`Proposal line · ${Math.round(TUNE_PROPOSAL_SHARE * 100)}%`}
                data-tune-rate-line
              />
            </span>
            <span
              className="text-xs font-medium tabular-nums text-foreground"
              data-tune-rate-share
            >
              {formatPercent(share * 100)}%
            </span>
          </div>
          <p className="text-[11px] leading-snug tabular-nums text-muted-foreground">
            <span data-tune-rate-counts>
              {stat.tuned} of {stat.settled} settled
            </span>
            {" · "}
            {fired}
          </p>
        </>
      )}

      {/* HOW MANY TIMES, once the store keeps a row per tune (bead `ro-6d1t`).
          Every figure above counts ALERTS; this counts what the operator DID,
          which is the question a rule that has been fiddled with repeatedly is
          actually asking. Absent until the operator applies the migration, and
          absent is `null` — a rule at zero prints nothing rather than a "0" that
          would read the same on a store that cannot count. */}
      {stat.tunes > 0 ? (
        <p
          className="text-[11px] leading-snug tabular-nums text-muted-foreground"
          data-tune-rate-tunes
        >
          Tuned {stat.tunes} {stat.tunes === 1 ? "time" : "times"} in {windowDays}{" "}
          days
        </p>
      ) : null}

      {/* Tuning does not close the firing, and a tuned alert the operator then
          snoozed is parked rather than settled (`flag-open.ts`), so an answer
          the operator has already given sits outside the rate until the alert
          itself settles. Saying so beside the figure is the difference between a
          quiet 0% and "you have tuned this three times this week". */}
      {stat.tunedOpen > 0 ? (
        <p
          className="text-[11px] leading-snug tabular-nums text-muted-foreground"
          data-tune-rate-pending
        >
          +{stat.tunedOpen} tuned, not settled
        </p>
      ) : null}

      {/* And what the OS makes of all that (bead `ro-bgny`). It sits UNDER the
          figures rather than above them: the proposal is a reading of the
          counts, and a reading that arrives before the evidence is an
          instruction. */}
      <TuneProposal
        facts={tuneProposal(stat)}
        windowDays={windowDays}
        remember={rememberDecline}
        {...(onFileTask ? { onFileTask } : {})}
        {...(taskCapabilities ? { taskCapabilities } : {})}
      />
    </div>
  );
}

// --- THE OS PROPOSES, AND ONLY PROPOSES (bead `ro-bgny`) -------------------

/** Where a declined proposal is remembered: rule id → the evidence it was
 * declined ON. Namespaced like every other desk key. */
const TUNE_PROPOSAL_NAME = "tune-proposal";
export const TUNE_PROPOSAL_KEY = storageKey(TUNE_PROPOSAL_NAME);

/**
 * A proposal is declined against the EVIDENCE, never forever.
 *
 * "Keep it as it is" is an answer about four tunes out of six, not about the
 * rule for all time — the eleventh alert is new evidence and deserves to be
 * asked about again. So the signature is the counts, and a proposal comes back
 * the moment they move.
 */
function evidenceSignature(facts: TuneProposalFacts): string {
  return `${facts.tuned}/${facts.settled}`;
}

/**
 * Guarded like every other storage read on the desk (`useTheme`, the sidebar's
 * asset list): a private window or hand-edited JSON must leave the operator
 * with a working page. A decline that cannot be persisted simply shows again,
 * which is the safe direction — the durable answer is the task, or the tune.
 */
function readDeclined(preferences: ReturnType<typeof useOwnerPreferences>): Record<string, string> {
  try {
    const raw = preferences.read(TUNE_PROPOSAL_NAME);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function writeDeclined(preferences: ReturnType<typeof useOwnerPreferences>, ruleId: string, signature: string): void {
  try {
    preferences.write(
      TUNE_PROPOSAL_NAME,
      JSON.stringify({ ...readDeclined(preferences), [ruleId]: signature }),
    );
  } catch {
    /* storage disabled or full — the proposal comes back, and that is fine */
  }
}

/** The task the OS proposes filing, as data — the composer opens with this and
 * the operator still judges it (D19: the button replaces the paste, not the
 * judgment). It files against the OS's own project, because these three
 * settings are portfolio-wide and belong to no asset.
 *
 * WHICH PROJECT THAT IS COMES FROM THE STORE (bead `ro-ujb9.118`): `osAssetId`
 * is the `assets.is_os` row's id. Unknown (null), the prefill names no project
 * and the composer asks, rather than filing into an id the product guessed.
 *
 * THE BODY IS FACTS, ONE PER LINE (bead `ro-ujb9.96.6.7`). It used to be two
 * paragraphs the operator had to read in the composer before filing; the same
 * WHAT, WHY, WHERE and acceptance now arrive as labelled lines, the shape a
 * task body scans in — and every figure the paragraph carried is still here. */
export function tuneProposalTask(
  facts: TuneProposalFacts,
  windowDays: number,
  osAssetId: string | null,
): TaskComposerPrefill {
  const percent = `${formatPercent(facts.share * 100)}%`;
  const line = `${Math.round(TUNE_PROPOSAL_SHARE * 100)}%`;
  return {
    ...(osAssetId ? { project: osAssetId } : {}),
    title: `Quieten the ${ruleLabel(facts.ruleId)} alert rule`,
    type: "task",
    priority: 3,
    labels: ["alerts"],
    description: [
      `- Rule: ${facts.ruleId}`,
      `- Answered by tuning: ${facts.tuned} of ${facts.settled} settled (${percent}) in ${windowDays} days`,
      `- Proposal line: ${line}`,
      "- Settings: config/constants.json → flag_defaults (the default for every site)",
      "- Preview: the Tune panel on any alert from this rule",
    ].join("\n"),
    acceptance: [
      "- Setting changed after the replay; the alert records the tune",
      "- Or the proposal declined, with the reason recorded",
    ].join("\n"),
  };
}

export interface TuneProposalProps {
  /** `null` — below the line, or too little settled to have an opinion —
   * renders nothing at all. */
  facts: TuneProposalFacts | null;
  windowDays: number;
  onFileTask?: FileTaskButtonProps["onFile"];
  taskCapabilities?: FileTaskButtonProps["capabilities"];
  /** Persist a decline across reloads. `false` keeps the gallery out of the
   * operator's own storage — its demo rule ids are real ones. */
  remember?: boolean;
  className?: string;
}

/**
 * WHAT THE OS MAKES OF ITS OWN TELEMETRY — docs/15 flow E's "rules above ~40%
 * FP get auto-proposed for tuning", which was prose for as long as the doc has
 * existed (bead `ro-bgny`).
 *
 * IT LIVES INSIDE {@link TuneRate} AND NOWHERE ELSE, so it reaches both
 * surfaces a rule is looked at — `/settings#alert-rules` and the Tune panel on
 * the alert the rule just fired — from the one component that already holds the
 * counts it is derived from. A panel of its own would be a second place to
 * learn the same thing, and a third opinion about the same number.
 *
 * IT NEVER CHANGES A SETTING. Guardrail thresholds are operator-only and
 * forever-forbidden on the autonomy ladder (AGENTS.md), so crossing the line
 * produces a sentence, two answers, and no write. The sentence says so out
 * loud rather than leaving the operator to wonder what pressing something
 * would do.
 *
 * TWO ANSWERS, AND THEY ARE NOT SYMMETRIC. **File task** is the accept, and it
 * is the OS's own mechanism for a proposal somebody agreed to (D19): it opens
 * the shipped composer prefilled against NoticeOS itself, so the proposal
 * outlives the page instead of dying when the panel closes, and the operator
 * still edits and judges it. **Keep it as it is** is the decline, and it is
 * deliberately the weaker of the two — a per-viewer note against THIS evidence
 * rather than a record, so a rule the operator declined at 4-of-6 asks again at
 * 6-of-9. The durable answers are the task and the tune itself; a decline that
 * pretended to be either would be muting without a reason, which docs/15 flow E
 * says does not exist.
 *
 * WARN TONE, no new token and no new severity: a noisy rule is an ordinary
 * warning about the OS's own instruments.
 */
export function TuneProposal({
  facts,
  windowDays,
  onFileTask,
  taskCapabilities,
  remember = true,
  className,
}: TuneProposalProps) {
  const preferences = useOwnerPreferences();
  // Storage is read at RENDER, not seeded into state: `facts` is null while the
  // read is in flight on `/settings`, and a state seeded from that first render
  // would forget a decline the moment the counts arrived.
  const [justDeclined, setJustDeclined] = useState<string | null>(null);
  if (facts === null) return null;
  const signature = evidenceSignature(facts);
  if (
    justDeclined === signature ||
    (remember && readDeclined(preferences)[facts.ruleId] === signature)
  ) {
    return null;
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded border border-warn/40 bg-warn/10 p-2",
        className,
      )}
      data-tune-proposal={facts.ruleId}
    >
      {/* What the OS proposes and the line it crossed; the two buttons are the
          whole of what it will do about it — nothing here changes a setting. */}
      <p className="flex items-start gap-1.5 text-xs font-medium leading-snug text-warn">
        <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
        Proposed: make this rule quieter
        <span className="font-normal tabular-nums text-muted-foreground">
          · over {Math.round(TUNE_PROPOSAL_SHARE * 100)}%
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-1">
        <TuneProposalFileTask
          facts={facts}
          windowDays={windowDays}
          {...(onFileTask ? { onFileTask } : {})}
          {...(taskCapabilities ? { taskCapabilities } : {})}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            if (remember) writeDeclined(preferences, facts.ruleId, signature);
            setJustDeclined(signature);
          }}
          data-tune-proposal-decline
        >
          Keep it as it is
        </Button>
      </div>
    </div>
  );
}

/** The accept, filed against the OS's own project as the store names it. Its
 * own component so the OS-asset read happens only where a proposal is drawn —
 * the same place the composer's task-lane read already does. */
function TuneProposalFileTask({
  facts,
  windowDays,
  onFileTask,
  taskCapabilities,
}: {
  facts: TuneProposalFacts;
  windowDays: number;
  onFileTask?: FileTaskButtonProps["onFile"];
  taskCapabilities?: FileTaskButtonProps["capabilities"];
}) {
  const osAssetId = useOsAssetId();
  return (
    <FileTaskButton
      label="File task"
      subject={`quietening ${ruleLabel(facts.ruleId)}`}
      prefill={tuneProposalTask(facts, windowDays, osAssetId)}
      {...(onFileTask ? { onFile: onFileTask } : {})}
      {...(taskCapabilities ? { capabilities: taskCapabilities } : {})}
    />
  );
}
