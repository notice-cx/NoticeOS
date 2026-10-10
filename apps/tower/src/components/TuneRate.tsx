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
 * How often the operator answered this rule by tuning it: the false-positive
 * rate, on both surfaces a rule is looked at. The amber segment is the alerts
 * answered by changing the rule, against the muted rest.
 */
export interface TuneRateProps {
  /** This rule's counts, or `null` for a rule that has not fired in the
   * window, which is not a rule at zero. */
  stat: AlertRuleStat | null;
  /** The window the counts cover, so the sentence states its own scope. */
  windowDays: number;
  /** File the proposal's task somewhere else; the gallery passes a fake. */
  onFileTask?: FileTaskButtonProps["onFile"];
  /** Stand in for the write lane's own answer, so the gallery can show the
   * proposal on a deployment that cannot file anything. */
  taskCapabilities?: FileTaskButtonProps["capabilities"];
  /** Whether a decline is remembered across reloads. `false` in the gallery,
   * whose demo rule ids are real ones. */
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
        // Fired, none settled: an empty track would read as a measured 0%.
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
            {/* The proposal line is a tick on the bar, not a sentence. */}
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

      {/* Every figure above counts alerts; this counts what the operator did. */}
      {stat.tunes > 0 ? (
        <p
          className="text-[11px] leading-snug tabular-nums text-muted-foreground"
          data-tune-rate-tunes
        >
          Tuned {stat.tunes} {stat.tunes === 1 ? "time" : "times"} in {windowDays}{" "}
          days
        </p>
      ) : null}

      {/* Tuning does not close the firing, so a tune already given sits
          outside the rate until the alert itself settles. */}
      {stat.tunedOpen > 0 ? (
        <p
          className="text-[11px] leading-snug tabular-nums text-muted-foreground"
          data-tune-rate-pending
        >
          +{stat.tunedOpen} tuned, not settled
        </p>
      ) : null}

      {/* Under the figures: a reading that arrives before the evidence is an
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

// --- the OS proposes, and only proposes ------------------------------------

/** Where a declined proposal is remembered: rule id → the evidence it was
 * declined on. */
const TUNE_PROPOSAL_NAME = "tune-proposal";
export const TUNE_PROPOSAL_KEY = storageKey(TUNE_PROPOSAL_NAME);

/** A proposal is declined against the evidence, never forever: the signature
 * is the counts, and a proposal comes back the moment they move. */
function evidenceSignature(facts: TuneProposalFacts): string {
  return `${facts.tuned}/${facts.settled}`;
}

/** A decline that cannot be read or persisted simply shows again, which is
 * the safe direction. */
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
    /* storage disabled or full: the proposal comes back, and that is fine */
  }
}

/** The task the OS proposes filing, as data the operator still judges in the
 * composer. It files against the OS's own project (`osAssetId`, the
 * `assets.is_os` row), because these settings belong to no asset; unknown,
 * the prefill names no project and the composer asks. */
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
  /** `null` (below the line, or too little settled) renders nothing at all. */
  facts: TuneProposalFacts | null;
  windowDays: number;
  onFileTask?: FileTaskButtonProps["onFile"];
  taskCapabilities?: FileTaskButtonProps["capabilities"];
  /** Persist a decline across reloads. `false` in the gallery. */
  remember?: boolean;
  className?: string;
}

/**
 * The OS's proposal to quieten a rule whose tune rate crossed the line. It
 * never changes a setting: guardrail thresholds are operator-only, so it
 * offers a sentence and two answers. File task is the accept and outlives the
 * page; Keep it as it is is deliberately weaker, a per-viewer note against
 * this evidence, so the rule asks again when the counts move.
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
  // Storage is read at render, not seeded into state: `facts` is null while
  // the read is in flight, and state seeded then would forget the decline.
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
      {/* Nothing here changes a setting. */}
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

/** Its own component so the OS-asset read happens only where a proposal is drawn. */
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
