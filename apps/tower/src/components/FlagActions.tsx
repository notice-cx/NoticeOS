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
  /** `flags.rule_id`. Given, `TuneRuleAction` decides whether this rule offers Tune. */
  ruleId?: string;
  /** `flags.metric`, so the preview follows the alert being looked at. */
  metric?: string | null;
  /**
   * Which verbs this placement draws: a closed alert row carries Snooze and
   * Resolve, the opened row Mark read and Tune. Absent, all four.
   */
  only?: readonly FlagVerb[];
}

export type FlagVerb = "acknowledge" | "snooze" | "resolve" | "tune";

/** What a completed action says, in the operator's words. */
function toastFor(action: FlagAction, until: string | null): string {
  if (action === "acknowledge") return "Alert marked read";
  if (action === "resolve") return "Alert resolved";
  if (action === "unsnooze") return "Alert back on the open list";
  return `Alert quiet until ${formatCalendarDate((until ?? "").slice(0, 10))}`;
}

/**
 * The alert lifecycle, under the row it acts on. Snooze expands in place
 * rather than floating, since a positioned panel would be clipped by the
 * alerts table's horizontal scroll; Escape puts the buttons back. A snooze
 * commits at once and the toast carries its real inverse.
 *
 * Tune changes what would produce the alert, not what the operator did with
 * it, and appears only on an open row. A save records `disposition='tune'` on
 * this flag with the setting's two values and the row stays open, which is
 * what makes a rule's false-positive rate measurable.
 */
export function FlagActions({
  flagId,
  assetId,
  snoozed = false,
  ruleId,
  metric,
  only,
}: FlagActionsProps) {
  const shows = (verb: FlagVerb) => !only || only.includes(verb);
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
      // Everything that counts this alert re-reads, so the open list, the
      // site's page and the settled archive move without a reload.
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
      {shows("acknowledge") ? <Button
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
      </Button> : null}
      {shows("snooze") ? <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() => setPicking(true)}
        aria-label="Snooze alert"
      >
        Snooze
      </Button> : null}
      {shows("resolve") ? <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => void act("resolve")}
        title="The issue is fixed"
        aria-label="Resolve alert"
      >
        Resolve
      </Button> : null}
      {/* Tune decides for itself whether this rule has an honest replay. */}
      {ruleId && shows("tune") ? (
        <TuneRuleAction
          asset={assetId}
          ruleId={ruleId}
          metric={metric ?? null}
          // The flag a save from the panel dispositions `tune`; it stays open,
          // because tuning the detector is not resolving the firing.
          flagId={flagId}
        />
      ) : null}
    </div>
  );
}
