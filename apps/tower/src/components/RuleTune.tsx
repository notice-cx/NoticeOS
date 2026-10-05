import { useOwnerToast } from '@/lib/browser-context';
import { useTowerApi } from '@/lib/browser-context';
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { Globe, SlidersHorizontal } from "lucide-react";

import {
  isBacktestableRule,
  type RuleBacktest,
} from "@noticeos/contract/rule-backtest";
import type { RuleConfig } from "@noticeos/contract/rules";
import {
  type AlertRuleStatsPayload,
  findRuleStat,
  ruleLabel,
} from "@shared/alert-rules";
import type { KnobFact } from "@shared/asset-detail";
import type { JsonValue, SettingOp } from "@shared/changeset";
import type { TunedSetting } from "@shared/tune";
import { BacktestStrip } from "@/components/BacktestStrip";
import { KnobEditor } from "@/components/KnobEditor";
import { TuneRate } from "@/components/TuneRate";
import { Button } from "@/components/ui/button";
import { useAlertRuleStats } from "@/hooks/useAlertRuleStats";
import { useRuleBacktest } from "@/hooks/useRuleBacktest";
import { useSettings } from "@/hooks/useSettings";
import { ApiError } from "@/lib/api";
import { FLAG_DEFAULT_VALIDATOR } from "@/lib/knob-validators";
import { cn } from "@/lib/utils";

/** `config/constants.json` `flag_defaults` key → the detector's own field name.
 * The three settings ARE the rule config; anything else in that object is not
 * something these rules read, and is left to `/settings`. */
const CONFIG_FIELD: Record<string, keyof RuleConfig> = {
  alpha: "alpha",
  min_baseline_per_day: "minBaselinePerDay",
  low_volume_window_hours: "lowVolumeWindowHours",
};

/**
 * The settings rows a replay is a picture OF — the three the detector reads,
 * out of whatever else `flag_defaults` holds.
 *
 * Exported because `/settings#alert-rules` previews the same edit (bead
 * `ro-w35m`) and a second filter there would be a second answer to "which of
 * these settings does the preview actually cover".
 */
export function backtestableKnobs(knobs: readonly KnobFact[]): KnobFact[] {
  return knobs.filter((knob) => knob.key in CONFIG_FIELD);
}

const PANEL_WIDTH = 380;

export interface TuneRuleActionProps {
  asset: string;
  /** `flags.rule_id`. A rule with no honest replay renders no trigger at all. */
  ruleId: string;
  /** `flags.metric` — the preview follows the alert the operator is looking at. */
  metric?: string | null;
  /**
   * `flags.id` — the alert this panel was opened FROM, so a saved change can be
   * recorded on it as `disposition='tune'` (bead `ro-van6`).
   *
   * Optional because the trigger is a rule's, not a row's: a surface that opens
   * the panel with no alert in front of it edits the same settings and simply
   * has nothing to disposition. What it must never do is invent a flag to
   * disposition — the false-positive rate this record feeds is only worth
   * reading if every `tune` in it came from an alert somebody was actually
   * looking at.
   */
  flagId?: number;
  className?: string;
}

/**
 * TUNE THIS RULE, from the alert it is being noisy on (bead `ro-u072`).
 *
 * WHY THE TRIGGER LIVES ON THE ROW. docs/15 flow E names six dispositions and
 * the OS shipped two; a rule-driven alert had no path from "this rule is noisy"
 * to a changed threshold except reading `config/constants.json`. `ro-kukv.6`
 * measured what that costs: four byte-identical rows aged 25–28 days that nobody
 * acted on.
 *
 * WHY IT OPENS A PANEL RATHER THAN LINKING TO `/settings`. The link already
 * exists and is not the missing piece — the missing piece is docs/15 principle 1,
 * *show, then ask*: a threshold typed on the settings page saves blind, and
 * nothing there can say what the new value would have done, because that page
 * has no asset in front of it. This panel does.
 *
 * WHAT IT IS NOT. It is not the per-asset rule editor doc 10 deliberately
 * removed on 2026-09-04. These three settings are PORTFOLIO-WIDE and the panel
 * leads with that fact as its first mark — an "Applies to every site" chip
 * above everything else — and ends in a link to `/settings#alert-rules`, which
 * remains where the rules live.
 *
 * A RULE WITH NO HONEST REPLAY GETS NO TRIGGER. `ingest-freshness`,
 * `asset-declared` and the watch-window verdicts are not steered by these
 * settings and are not reproducible from stored pulses; offering Tune on them
 * would promise a preview that could only be invented.
 */
export function TuneRuleAction({
  asset,
  ruleId,
  metric,
  flagId,
  className,
}: TuneRuleActionProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - PANEL_WIDTH - 8);
    setPos({ top: rect.bottom + 6, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (
        !panelRef.current?.contains(e.target as Node) &&
        !triggerRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    // A scroll or resize invalidates the measured anchor — close rather than drift.
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  if (!isBacktestableRule(ruleId)) return null;

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        aria-label="Tune rule"
        className={className}
      >
        <SlidersHorizontal className="size-3.5" aria-hidden />
        Tune rule
      </Button>

      {open && pos
        ? createPortal(
            <div
              ref={panelRef}
              role="dialog"
              aria-label={`Tune rule — ${ruleLabel(ruleId)}`}
              style={{ position: "fixed", top: pos.top, left: pos.left, width: PANEL_WIDTH }}
              className="z-50 max-h-[70vh] overflow-y-auto rounded-lg border border-border bg-background p-3 text-left shadow-xl"
            >
              <TuneRulePanelLive
                asset={asset}
                ruleId={ruleId}
                metric={metric ?? null}
                flagId={flagId ?? null}
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/** The panel with its two reads wired up: the portfolio settings it edits, and
 * the replay it previews. Split from the presentational half below so the
 * gallery and the tests can render every state without a store. */
function TuneRulePanelLive({
  asset,
  ruleId,
  metric,
  flagId,
}: {
  asset: string;
  ruleId: string;
  metric: string | null;
  flagId: number | null;
}) {
  const toast = useOwnerToast();
  const { updateFlag } = useTowerApi();
  const queryClient = useQueryClient();
  const { data: settings } = useSettings();
  // What this rule has already cost (bead `ro-ayxy`) — the same read, the same
  // cache key and the same component `/settings#alert-rules` draws, so the panel
  // an operator tunes FROM cannot show a different figure from the page they
  // land on afterwards.
  const { data: stats } = useAlertRuleStats();
  const knobs = useMemo(
    () => backtestableKnobs(settings?.alertRules.knobs ?? []),
    [settings],
  );

  // The values the operator is currently looking at, which is what the preview
  // must be a picture of: the saved value until a field is edited, the edited
  // value after, and `null` for a field holding something it would refuse.
  const [drafts, setDrafts] = useState<Record<string, JsonValue | null>>({});
  const preview = useRulePreview({ asset, ruleId, metric, knobs, drafts });

  /**
   * The alert this panel was opened from now carries the sixth disposition
   * (bead `ro-van6`) — `disposition='tune'`, with the setting and its two values
   * as the note.
   *
   * IT IS RECORDED AFTER THE CHANGE, NEVER INSTEAD OF IT. The setting has
   * already moved by the time this runs, so a refusal here gets its own line and
   * never turns a save that worked into a save that failed — the same contract
   * `useConfigSave`'s `record` keeps for timeline events. The row is refused
   * (409) when it is no longer open, or when it already carries a different
   * decision: an ack or a snooze is the operator's own record and this write may
   * not overwrite it.
   *
   * THE ROW STAYS OPEN. Tuning the detector is not resolving the firing — see
   * `worker/flag-scope.ts` — so the invalidations below repaint it with its
   * "tuned" chip rather than removing it from the queue.
   */
  async function recordTune(tuned: TunedSetting) {
    if (flagId === null) return;
    try {
      await updateFlag(flagId, "tune", { tuned });
    } catch {
      toast.error("Setting saved — this alert was not marked tuned");
      return;
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["wall"] }),
      queryClient.invalidateQueries({ queryKey: ["asset-detail", asset] }),
      // The tune this write just recorded is one of the counts above (bead
      // `ro-ayxy`): a figure that did not move after the operator acted would
      // read as "that did not count".
      queryClient.invalidateQueries({ queryKey: ["alert-rule-stats"] }),
    ]);
  }

  return (
    <RuleTunePanel
      asset={asset}
      ruleId={ruleId}
      metric={metric}
      knobs={knobs}
      stats={stats ?? null}
      onDraftChange={(key, value) =>
        setDrafts((current) => ({ ...current, [key]: value }))
      }
      {...(flagId === null ? {} : { onSaved: recordTune })}
      preview={preview}
    />
  );
}

/**
 * THE REPLAY, AS A PREVIEW STATE — the one implementation of "what would these
 * values have done to this asset", for every surface that asks.
 *
 * Extracted when `/settings#alert-rules` became the second asker (bead
 * `ro-w35m`). The alert row has an asset in front of it and the settings page
 * picks one, but everything after that choice is identical: the same three
 * settings become the same `RuleConfig`, the same debounced RPC answers it, and
 * the same four states describe what came back. Two copies of that would be two
 * answers to the one question the operator is being asked to trust a number
 * about.
 */
export function useRulePreview({
  asset,
  ruleId,
  metric,
  knobs,
  drafts,
}: {
  asset: string;
  ruleId: string;
  metric: string | null;
  knobs: readonly KnobFact[];
  /** The buffered value per setting key — `null` while a field holds something
   * it would refuse. Keys the operator has not touched are simply absent. */
  drafts: Record<string, JsonValue | null>;
}): RuleTunePreview {
  const config = useMemo(() => ruleConfig(knobs, drafts), [knobs, drafts]);
  const { data, error } = useRuleBacktest(
    config === null ? null : { asset, ruleId, metric, config },
  );
  if (config === null) return { state: "invalid" };
  if (data) return { state: "ready", backtest: data };
  if (error) return { state: "failed", message: previewRefusal(error) };
  return { state: "loading" };
}

/** The preview's own state, so the panel renders one of four honest things and
 * never an empty box. */
export type RuleTunePreview =
  | { state: "loading" }
  | { state: "ready"; backtest: RuleBacktest }
  | { state: "failed"; message: string }
  /** A field is holding a value the detector would refuse — the field itself is
   * already saying why, and asking anyway would answer about a value nobody can
   * save. */
  | { state: "invalid" };

export interface RuleTunePanelProps {
  asset: string;
  ruleId: string;
  metric: string | null;
  knobs: KnobFact[];
  preview: RuleTunePreview;
  /**
   * What every rule has cost (bead `ro-ayxy`), from which this panel reads its
   * OWN rule's row.
   *
   * The whole payload rather than one row, so the lookup is
   * `findRuleStat` on both surfaces instead of two callers deciding for
   * themselves what a missing rule means. `null` — the gallery, a test, a
   * deployment whose read failed — renders no figure at all: a panel that
   * printed "no firings yet" because a fetch did not answer would be inventing
   * evidence about the rule it is asking the operator to change.
   */
  stats?: AlertRuleStatsPayload | null;
  onDraftChange: (key: string, value: JsonValue | null) => void;
  /** A setting that LANDED, so the caller can record the tune on the alert it
   * was opened from (bead `ro-van6`). Absent when there is no alert to
   * disposition, and the panel then behaves exactly as it did before. */
  onSaved?: (tuned: TunedSetting) => void;
  /** Write the op somewhere else — the gallery's escape hatch, exactly as
   * `KnobEditor` takes one, so a demo is a real control that never touches the
   * operator's repo. */
  onSave?: (op: SettingOp) => Promise<void>;
}

export function RuleTunePanel({
  asset,
  ruleId,
  metric,
  knobs,
  preview,
  stats,
  onDraftChange,
  onSaved,
  onSave,
}: RuleTunePanelProps) {
  return (
    <div className="flex flex-col gap-3" data-rule-tune={ruleId}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-wall-label font-semibold uppercase tracking-widest text-muted-foreground">
          Tune rule
        </span>
        {/* The rule NAMED, with its id in the hover — doc 17's tune row: an
            id is a name for the code, not for the operator. */}
        <span className="truncate text-[11px] text-muted-foreground" title={ruleId}>
          {ruleLabel(ruleId)}
        </span>
      </div>

      {/* The scope is the LEAD fact, not small print: these three settings judge
          the whole portfolio, and doc 10 removed the per-asset editor precisely
          because a small note under one asset's fields did not say so loudly
          enough. It is a chip at the top rather than a sentence (bead
          `ro-ujb9.96.6.7`), stated once for the panel instead of once under
          every field, and the replay below names its own asset in its heading. */}
      <span
        className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs font-medium text-foreground"
        data-rule-tune-scope
      >
        <Globe className="size-3.5 shrink-0" aria-hidden />
        Applies to every site
      </span>

      {/* WHAT THIS RULE HAS ALREADY COST, before what a change would do (bead
          `ro-ayxy`). The operator opening this panel has just decided one alert
          was noise; the fact that changes the decision is whether they have
          decided that about this rule five times already. It leads the replay
          because it is a measurement and the replay is a projection. */}
      {stats ? (
        <div className="flex flex-col gap-1" data-rule-tune-rate={ruleId}>
          <span className="text-wall-label font-semibold uppercase tracking-widest text-muted-foreground">
            Answered by tuning
          </span>
          <TuneRate
            stat={findRuleStat(stats, ruleId)}
            windowDays={stats.windowDays}
          />
        </div>
      ) : null}

      <div className="flex flex-col gap-1" data-rule-tune-replay>
        <span className="truncate text-wall-label font-semibold uppercase tracking-widest text-muted-foreground">
          Replay · {asset}
          {metric ? ` · ${metric}` : ""}
        </span>
        <RulePreview preview={preview} />
      </div>

      <div className="flex flex-col">
        {knobs.map((knob) => (
          <KnobEditor
            key={knob.key}
            label={knob.label}
            explain={knob.explain}
            current={knob.raw}
            format={(v) => String(v)}
            slug="alert-rules"
            makeOp={(value) => ({
              kind: "file-json-set",
              file: "config/constants.json",
              pointer: knob.pointer,
              expect: knob.raw,
              value,
            })}
            control={{
              type: "number",
              validate: FLAG_DEFAULT_VALIDATOR[knob.key]!,
              step: knob.key === "alpha" ? "0.001" : "1",
            }}
            onDraft={(value) => onDraftChange(knob.key, value)}
            {...(onSaved
              ? {
                  // The two values are the reason the tune is recorded WITH, and
                  // both are read here rather than composed downstream: `raw` is
                  // the value this field was showing when the operator changed
                  // it, which is the only place that "before" still exists once
                  // the save has landed.
                  onSaved: (value: JsonValue) => {
                    if (typeof knob.raw !== "number" || typeof value !== "number") return;
                    onSaved({ setting: knob.key, from: knob.raw, to: value });
                  },
                }
              : {})}
            {...(onSave ? { onSave } : {})}
          />
        ))}
      </div>

      <Link
        to="/settings#alert-rules"
        className="text-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        Every alert rule, on Settings
      </Link>
    </div>
  );
}

/** Four states, four sentences. A preview that could not be produced says so —
 * it never renders a strip of zeros, which would read as "this would never
 * fire" (docs/17 rule 6: missing says missing).
 *
 * Exported for `/settings#alert-rules` (bead `ro-w35m`): the same four states
 * arrive there, and a second set of sentences for them would be the settings
 * page and the alert row disagreeing about what a missing answer means. */
export function RulePreview({ preview }: { preview: RuleTunePreview }) {
  if (preview.state === "ready") {
    return <BacktestStrip backtest={preview.backtest} />;
  }
  const message =
    preview.state === "loading"
      ? "Replaying the stored reports…"
      : preview.state === "invalid"
        ? "Fix the value above and the replay comes back."
        : preview.message;
  return (
    <p
      className={cn(
        "text-xs leading-snug",
        preview.state === "failed" ? "text-error" : "text-muted-foreground",
      )}
      data-rule-tune-preview={preview.state}
    >
      {message}
    </p>
  );
}

/** What a refused replay says out loud. Each code is a different next move, so
 * each gets its own sentence rather than one "could not load". */
export function previewRefusal(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "unsupported_rule") {
      return "No preview for this rule — it is not judged by these settings.";
    }
    if (err.code === "unknown_asset") {
      return "The store no longer has this site, so there is nothing to replay.";
    }
    if (err.code === "validation") {
      return "The detector refused one of these values. Change it and the replay comes back.";
    }
    return "The replay did not answer. The settings above are unchanged.";
  }
  return "The replay did not answer. The settings above are unchanged.";
}

/**
 * The settings the preview should be a picture of: the saved value for every
 * untouched field, the draft for an edited one.
 *
 * `null` when any field is missing or is holding a value it would refuse — the
 * panel then asks nothing, because an answer about a value nobody can save is
 * worse than no answer.
 */
function ruleConfig(
  knobs: readonly KnobFact[],
  drafts: Record<string, JsonValue | null>,
): RuleConfig | null {
  const config: Partial<RuleConfig> = {};
  for (const knob of knobs) {
    const field = CONFIG_FIELD[knob.key];
    if (!field) continue;
    const value = knob.key in drafts ? drafts[knob.key] : knob.raw;
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    config[field] = value;
  }
  if (
    config.alpha === undefined ||
    config.minBaselinePerDay === undefined ||
    config.lowVolumeWindowHours === undefined
  ) {
    return null;
  }
  return config as RuleConfig;
}
