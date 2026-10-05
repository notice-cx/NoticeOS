import { useDemoReadonly } from '@/lib/browser-context';
import { useOwnerToast } from '@/lib/browser-context';
import { useTowerApi } from '@/lib/browser-context';
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  SNOOZE_PRESETS,
  checkSnoozeUntil,
  earliestSnoozeDate,
  latestSnoozeDate,
  snoozeUntilFromDate,
  snoozeUntilFromDays,
} from "@shared/snooze";
import { TuneRuleAction } from "@/components/RuleTune";
import { ALERT_HISTORY_KEY } from "@/hooks/useAlertHistory";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { formatCalendarDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { type FlagAction } from "@/lib/api";

export interface FlagActionsProps {
  flagId: number;
  assetId: string;
  /**
   * Set on a row that is CURRENTLY parked: the three lifecycle buttons collapse
   * to the one action that row has, Unsnooze. The Snoozed panels — `/alerts`'
   * and a site's Alerts tab — are the only callers; an open row never passes it.
   */
  snoozed?: boolean;
  /** `flags.rule_id`. Given, a rule the detector's own settings steer offers
   * Tune beside the lifecycle actions; every other rule renders nothing extra,
   * which is `TuneRuleAction`'s own decision, not this row's (bead `ro-u072`). */
  ruleId?: string;
  /** `flags.metric`, so the preview follows the alert being looked at. */
  metric?: string | null;
}

/** What a completed action says, in the operator's words. */
function toastFor(action: FlagAction, until: string | null): string {
  if (action === "acknowledge") return "Alert marked read";
  if (action === "resolve") return "Alert resolved";
  if (action === "unsnooze") return "Alert back on the open list";
  return `Alert quiet until ${formatCalendarDate((until ?? "").slice(0, 10))}`;
}

/**
 * The alert lifecycle, under the row it acts on (docs/15 flow E).
 *
 * SNOOZE IS HERE AND NOT ON THE PAGE because both surfaces that render an open
 * alert already render this component — the `/alerts` table and the asset
 * page's state hero — so the verb arrives on both from one place, saying one
 * thing. It was the missing verb every alerting product has: `ro-kukv.6` found
 * four identical month-old rows the operator had not acted on in four weeks,
 * which is not a triage failure, it is a queue with no "not now" in it.
 *
 * THE MENU EXPANDS IN PLACE rather than floating. Three presets and a date do
 * not justify a popover primitive the registry does not have, and an absolutely
 * positioned panel inside the alerts table would be clipped by its own
 * horizontal scroll container. Clicking Snooze swaps the button row for the
 * horizons; picking one or pressing Escape puts it back.
 *
 * UNDO, NOT CONFIRM (docs/15 principle 5). A snooze is reversible and local, so
 * it commits immediately and the toast carries its inverse — which is a real
 * inverse and not a second write with a different name: unsnooze ends the
 * snooze now, and the row returns as the same condition.
 *
 * TUNE IS THE FOURTH VERB, and it is a different KIND of verb (bead `ro-u072`).
 * Mark read, Snooze and Resolve all say what the operator did with this EVENT;
 * Tune changes what would produce it. It arrives as its own component, so this
 * row never has to learn which rules a pulse replay can honestly serve, and it
 * appears only on the OPEN row — the parked branch below is deliberately the one
 * action that row has, and the picker branch is a decision already in progress.
 *
 * IT IS ALSO THE ONE VERB THAT LEAVES THE ROW WHERE IT IS (bead `ro-van6`). A
 * save from its panel records `disposition='tune'` on THIS flag, with the
 * setting and its two values as the note, and the row stays in the queue wearing
 * a "tuned" chip: the rule got quieter, the drop that fired did not go away.
 * That record is what makes each rule's false-positive rate measurable at all —
 * without it, a rule the operator quietened by hand is indistinguishable in the
 * store from one nobody ever complained about.
 */
export function FlagActions({
  flagId,
  assetId,
  snoozed = false,
  ruleId,
  metric,
}: FlagActionsProps) {
  const demoReadonly = useDemoReadonly();
  const toast = useOwnerToast();
  const { updateFlag } = useTowerApi();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [picking, setPicking] = useState(false);
  const [date, setDate] = useState("");

  async function act(action: FlagAction, until: string | null = null) {
    if (demoReadonly) return;
    setPending(true);
    try {
      await updateFlag(flagId, action, until === null ? {} : { until });
      setPending(false);
      setPicking(false);
      toast.success(toastFor(action, until), {
        action:
          action === "snooze"
            ? { label: "Undo", onClick: () => void act("unsnooze") }
            : undefined,
      });
      // Everything that counts this alert re-reads: the open list, the site's
      // page, and the settled archive — "Settled · 7d" and History move the
      // moment the row leaves Open, not after a reload (bead `ro-ujb9.195`).
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["wall"] }),
        queryClient.invalidateQueries({ queryKey: ["asset-detail", assetId] }),
        queryClient.invalidateQueries({ queryKey: ALERT_HISTORY_KEY }),
      ]);
    } catch {
      setPending(false);
      toast.error("Could not update the alert");
    }
  }

  function snoozeDays(days: number) {
    void act("snooze", snoozeUntilFromDays(new Date().toISOString(), days));
  }

  function snoozeOnDate() {
    const nowIso = new Date().toISOString();
    const until = snoozeUntilFromDate(date);
    // The same check the Worker runs. Refusing here keeps the operator's own
    // typo out of a round trip; the Worker refuses it again regardless.
    const checked = checkSnoozeUntil(until, nowIso);
    if (!checked.ok) {
      toast.error("Pick a date in the next 90 days");
      return;
    }
    void act("snooze", checked.until);
  }

  if (demoReadonly) return null;
  if (snoozed) {
    return (
      <div className="flex flex-wrap items-center gap-1 sm:flex-nowrap sm:shrink-0">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => void act("unsnooze")}
          aria-label="Unsnooze alert"
        >
          Unsnooze
        </Button>
      </div>
    );
  }

  if (picking) {
    const nowIso = new Date().toISOString();
    return (
      <div
        className="flex flex-wrap items-center gap-1"
        data-snooze-picker
        onKeyDown={(event) => {
          if (event.key === "Escape") setPicking(false);
        }}
      >
        <span className="text-xs text-muted-foreground">Quiet for</span>
        {SNOOZE_PRESETS.map((preset) => (
          <Button
            key={preset.days}
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => snoozeDays(preset.days)}
            // The date the preset lands on, so the choice is a date and not
            // arithmetic — the same "quiet until" the parked row then shows.
            title={`Until ${formatCalendarDate(
              snoozeUntilFromDays(nowIso, preset.days).slice(0, 10),
            )}`}
          >
            {preset.label}
          </Button>
        ))}
        <input
          type="date"
          className={cn(fieldClass, "text-xs tabular-nums")}
          value={date}
          min={earliestSnoozeDate(nowIso)}
          max={latestSnoozeDate(nowIso)}
          onChange={(event) => setDate(event.target.value)}
          aria-label="Snooze until date"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending || date === ""}
          onClick={snoozeOnDate}
        >
          Until date
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => setPicking(false)}
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1 sm:flex-nowrap sm:shrink-0">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() => void act("acknowledge")}
        // What each verb does to the queue, in the fewest words that say it:
        // the two that settle differ in whether the issue is over.
        title="Clears it; alerts again if it recurs"
        aria-label="Mark alert read"
      >
        Mark read
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() => setPicking(true)}
        aria-label="Snooze alert"
      >
        Snooze
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => void act("resolve")}
        title="The issue is fixed"
        aria-label="Resolve alert"
      >
        Resolve
      </Button>
      {/* The fourth verb — see the note above. It decides for itself whether
          this rule has an honest replay, so the row stays one line. */}
      {ruleId ? (
        <TuneRuleAction
          asset={assetId}
          ruleId={ruleId}
          metric={metric ?? null}
          // Which alert the change is recorded ON (bead `ro-van6`): a save from
          // the panel dispositions THIS row `tune`, and the row stays open,
          // because tuning the detector is not resolving the firing.
          flagId={flagId}
        />
      ) : null}
    </div>
  );
}
