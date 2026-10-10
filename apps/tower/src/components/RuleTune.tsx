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

/** `config/constants.json` `flag_defaults` key → the detector's own field
 * name. Anything else in that object is not something these rules read. */
const CONFIG_FIELD: Record<string, keyof RuleConfig> = {
  alpha: "alpha",
  min_baseline_per_day: "minBaselinePerDay",
  low_volume_window_hours: "lowVolumeWindowHours",
};

/** The settings rows a replay is a picture of. Exported because
 * `/settings#alert-rules` previews the same edit. */
export function backtestableKnobs(knobs: readonly KnobFact[]): KnobFact[] {
  return knobs.filter((knob) => knob.key in CONFIG_FIELD);
}

const PANEL_WIDTH = 380;

export interface TuneRuleActionProps {
  asset: string;
  /** `flags.rule_id`. A rule with no honest replay renders no trigger at all. */
  ruleId: string;
  /** `flags.metric`: the preview follows the alert the operator is looking at. */
  metric?: string | null;
  /** `flags.id`, the alert this panel was opened from, so a saved change can
   * be recorded on it as `disposition='tune'`. Optional because the trigger
   * is a rule's, not a row's; a flag is never invented to disposition. */
  flagId?: number;
  className?: string;
}

/**
 * Tune a rule from the alert it is being noisy on, with a replay of what the
 * new values would have done to this asset before the save. The settings are
 * portfolio-wide and the panel leads with that. A rule these settings do not
 * steer gets no trigger, because its preview could only be invented.
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

/** The panel with its reads wired up, split from the presentational half so
 * the gallery and the tests can render every state without a store. */
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
  // The same read and cache key `/settings#alert-rules` draws from.
  const { data: stats } = useAlertRuleStats();
  const knobs = useMemo(
    () => backtestableKnobs(settings?.alertRules.knobs ?? []),
    [settings],
  );

  // What the preview must be a picture of: the saved value until a field is
  // edited, the edited value after, `null` for a value the field refuses.
  const [drafts, setDrafts] = useState<Record<string, JsonValue | null>>({});
  const preview = useRulePreview({ asset, ruleId, metric, knobs, drafts });

  /**
   * Records `disposition='tune'` on the alert this panel was opened from,
   * after the change and never instead of it: the setting has already moved,
   * so a refusal here gets its own line and never turns a save that worked
   * into one that failed. The row stays open; tuning is not resolving.
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
      // The tune just recorded is one of the counts the panel shows.
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

/** The replay as a preview state: the one implementation of "what would
 * these values have done to this asset", for every surface that asks. */
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
  /** The buffered value per setting key, `null` while a field holds something
   * it would refuse. Untouched keys are absent. */
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

export type RuleTunePreview =
  | { state: "loading" }
  | { state: "ready"; backtest: RuleBacktest }
  | { state: "failed"; message: string }
  /** A field holds a value the detector would refuse; the field says why. */
  | { state: "invalid" };

export interface RuleTunePanelProps {
  asset: string;
  ruleId: string;
  metric: string | null;
  knobs: KnobFact[];
  preview: RuleTunePreview;
  /** What every rule has cost; the panel reads its own rule's row with
   * `findRuleStat`. `null` renders no figure at all, because "no firings yet"
   * from a fetch that did not answer would be invented evidence. */
  stats?: AlertRuleStatsPayload | null;
  onDraftChange: (key: string, value: JsonValue | null) => void;
  /** A setting that landed, so the caller can record the tune on the alert
   * it was opened from. */
  onSaved?: (tuned: TunedSetting) => void;
  /** Write the op somewhere else; the gallery passes a fake. */
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
        {/* The rule named, with its id in the hover. */}
        <span className="truncate text-[11px] text-muted-foreground" title={ruleId}>
          {ruleLabel(ruleId)}
        </span>
      </div>

      {/* The scope is the lead fact, stated once for the panel rather than
          under every field; the replay below names its own asset. */}
      <span
        className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs font-medium text-foreground"
        data-rule-tune-scope
      >
        <Globe className="size-3.5 shrink-0" aria-hidden />
        Applies to every site
      </span>

      {/* What this rule has already cost leads the replay: it is a
          measurement, and the replay is a projection. */}
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
                  // `raw` is the only place "before" still exists once the
                  // save has landed.
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

/** A preview that could not be produced says so; it never renders a strip of
 * zeros, which would read as "this would never fire". Exported for
 * `/settings#alert-rules`. */
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

/** Each refusal code is a different next move, so each gets its own sentence. */
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

/** The saved value for every untouched field, the draft for an edited one;
 * `null` when any field is missing or refused, and the panel asks nothing. */
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
