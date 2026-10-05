import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Columns2, Minus, Plus, Trash2 } from "lucide-react";
import type { CountdownConfig, DashboardRefusal } from "@shared/dashboard";
import type { AssetCard } from "@shared/wall";
import {
  WALL_WIDTH_MAX,
  WALL_WIDTH_MIN,
  WALL_WIDTH_STEP,
  WALL_WIDGET_LIBRARY,
  wallLayoutWidgets,
  type WallLayout,
  type WallWidgetSettings,
} from "@shared/wall-layout";
import { CountdownEditor } from "@/components/DashboardWidgets";
import { OwnerChip } from "@/components/OwnerChip";
import { StateChip } from "@/components/StateChip";
import { Button } from "@/components/ui/button";
import { canNudge, canStack, roundWallWidth, wallWidgetAt, wallWidthShare, type WallNudge } from "@/lib/wall-editor";
import { cn } from "@/lib/utils";
import { availablePulseCounters, selectedPulseMetrics, type WallPulseMetrics } from "@/lib/wall-counters";
import { formatInt } from "@/lib/format";

export interface WallWidgetPanelProps {
  layout: WallLayout;
  selectedId: string | null;
  /** The assets the payload actually carries — the only ids a filter may name. */
  assets: AssetCard[];
  /** For the widget whose own configuration lives at `/countdown`. */
  countdown?: CountdownConfig;
  /** A saved countdown the Tower refused (bead `ro-trai.45`): the form saves
   * over it, guarded by the value as stored. The save bar names it. */
  countdownRefused?: DashboardRefusal | null;
  nowMs: number;
  /** Pick a widget to edit, as a click on it in the preview does. */
  onSelect: (widgetId: string) => void;
  onWidth: (widgetId: string, width: number) => void;
  onSettings: (widgetId: string, settings: WallWidgetSettings | undefined) => void;
  onNudge: (widgetId: string, direction: WallNudge) => void;
  /** Stack the widget in a column, or take it out of one (bead `ro-trai.2`). */
  onStack: (widgetId: string) => void;
  onRemove: (widgetId: string) => void;
  disabled?: boolean;
  className?: string;
}

const NUDGES: { direction: WallNudge; label: string; icon: typeof ArrowLeft }[] = [
  { direction: "left", label: "Move left", icon: ArrowLeft },
  { direction: "right", label: "Move right", icon: ArrowRight },
  { direction: "up", label: "Move up a row", icon: ArrowUp },
  { direction: "down", label: "Move down a row", icon: ArrowDown },
];

/**
 * The selected widget's settings (bead `ro-lzmq.2`).
 *
 * ONE REPRESENTATION PER FACT, twice over. The countdown's emoji, words and
 * target are not widget settings — they live at `/countdown`, where Home, the
 * Wall and `/settings` already read them — so the panel for that widget renders
 * `CountdownEditor`, the very form the Settings page shows, rather than a second
 * set of fields that could disagree with it. And a widget setting only appears
 * here when the RENDERER applies it: the contract's `spec.settings` decides,
 * which today means the asset filter on the two widgets whose content is per
 * asset.
 *
 * THE BUTTONS ARE THE KEYBOARD'S HALF OF THE DRAG. Arranging by dragging the
 * preview is the fast way and the only way a mouse wants; move left / right /
 * up / down is the same move for somebody who is not holding one, and a
 * direction with nowhere to go is disabled rather than silently inert.
 */
export function WallWidgetPanel({
  layout,
  selectedId,
  assets,
  countdown,
  countdownRefused = null,
  nowMs,
  onSelect,
  onWidth,
  onSettings,
  onNudge,
  onStack,
  onRemove,
  disabled = false,
  className,
}: WallWidgetPanelProps) {
  const at = selectedId ? wallWidgetAt(layout, selectedId) : null;

  if (!at) {
    // NOTHING SELECTED IS A STATE, NOT AN INSTRUCTION (bead `ro-trai.15`): the
    // widgets on the Wall are the choice, one press each, the same selection a
    // click in the preview makes. With nothing placed there is nothing to pick,
    // and the library's Add is the next action.
    return (
      <div className={cn("flex flex-col gap-2", className)} data-wall-widget-panel="none">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Widget
        </h2>
        <ul className="flex flex-col gap-1.5" data-wall-widget-picker>
          {wallLayoutWidgets(layout).map((widget) => (
            <li key={widget.id}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full justify-start"
                onClick={() => onSelect(widget.id)}
                data-wall-widget-pick={widget.id}
              >
                {WALL_WIDGET_LIBRARY[widget.type].label}
              </Button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const { widget, row, rowIndex, index, column, parent } = at;
  const spec = WALL_WIDGET_LIBRARY[widget.type];
  const share = Math.round(wallWidthShare(row, widget.id));
  const filtered = widget.settings?.assets ?? null;

  return (
    <div
      className={cn("flex flex-col gap-2", className)}
      data-wall-widget-panel={widget.id}
    >
      <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        Widget
      </h2>
      <div className="flex flex-col gap-3 border border-border bg-card p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{spec.label}</p>
            <p className="text-xs text-muted-foreground">
              {column && parent
                ? `Row ${layout.rows.indexOf(parent) + 1} column, row ${rowIndex + 1}, position ${index + 1} of ${row.widgets.length}`
                : `Row ${rowIndex + 1}, position ${index + 1} of ${row.widgets.length}`}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0"
            disabled={disabled}
            onClick={() => onRemove(widget.id)}
          >
            <Trash2 className="size-4" />
            Remove
          </Button>
        </div>

        {/* WIDTH. The share is what the operator reads — a weight means
            nothing until you know what it is a weight OF — and the slider moves
            the weight behind it. The renderer's minimum width is the preview's
            to show, not a sentence's to explain (bead `ro-ujb9.96.6.12`). */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <label className="text-xs text-muted-foreground" htmlFor={`wall-width-${widget.id}`}>
              Width
            </label>
            <span className="text-xs tabular-nums text-foreground" data-wall-width-share>
              {share}% of the row
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="shrink-0"
              aria-label="Narrower"
              disabled={disabled || widget.width <= WALL_WIDTH_MIN}
              onClick={() => onWidth(widget.id, roundWallWidth(widget.width - WALL_WIDTH_STEP))}
            >
              <Minus className="size-4" />
            </Button>
            <input
              id={`wall-width-${widget.id}`}
              type="range"
              className="min-w-0 flex-1 accent-foreground max-sm:min-h-11"
              min={WALL_WIDTH_MIN}
              max={WALL_WIDTH_MAX}
              step={WALL_WIDTH_STEP}
              value={widget.width}
              disabled={disabled}
              onChange={(event) => onWidth(widget.id, Number(event.target.value))}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="shrink-0"
              aria-label="Wider"
              disabled={disabled || widget.width >= WALL_WIDTH_MAX}
              onClick={() => onWidth(widget.id, roundWallWidth(widget.width + WALL_WIDTH_STEP))}
            >
              <Plus className="size-4" />
            </Button>
          </div>
        </div>

        {/* ARRANGE. The same moves as the drag, for a keyboard. */}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">Move</span>
          <div className="flex flex-wrap gap-1.5">
            {NUDGES.map(({ direction, label, icon: Icon }) => (
              <Button
                key={direction}
                type="button"
                variant="outline"
                size="sm"
                aria-label={label}
                disabled={disabled || !canNudge(layout, widget.id, direction)}
                onClick={() => onNudge(widget.id, direction)}
              >
                <Icon className="size-4" />
              </Button>
            ))}
            {/* A COLUMN stacks widgets beside a full-height one (bead
                `ro-trai.2`). One press puts this widget in its row's column,
                or takes it back out; a drop on a column row does the rest. */}
            <Button
              type="button"
              variant={column ? "default" : "outline"}
              size="sm"
              aria-pressed={column !== null}
              disabled={disabled || !canStack(layout, widget.id)}
              onClick={() => onStack(widget.id)}
              data-wall-stack
            >
              <Columns2 className="size-4" />
              {column ? "Take out of column" : "Stack in column"}
            </Button>
          </div>
        </div>

        {spec.settings.includes("assets") ? (
          <AssetFilter
            assets={assets}
            selected={filtered}
            disabled={disabled}
            label={spec.label}
            pulseMetrics={widget.settings?.pulseMetrics}
            showPulseMetrics={spec.settings.includes("pulseMetrics")}
            onPulseMetrics={(pulseMetrics) => onSettings(widget.id, { ...widget.settings, pulseMetrics })}
            onChange={(next) => {
              const { assets: _assets, ...rest } = widget.settings ?? {};
              onSettings(widget.id, next === null
                ? Object.keys(rest).length ? rest : undefined
                : { ...rest, assets: next });
            }}
          />
        ) : null}

        {spec.configuredAt ? (
          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-2 text-xs font-medium text-foreground">
                {spec.label} settings
                {/* Nothing to count down to is a STATE, and the form below is
                    where it is set — no detour to Settings (bead
                    `ro-ujb9.96.6.12`). */}
                {countdown || countdownRefused ? null : (
                  <span data-wall-countdown-absent>
                    <StateChip label="Not set" tone="na" subject="wall:countdown" />
                  </span>
                )}
              </span>
              <OwnerChip path="config/tower.json" />
            </div>
            {/* `embedded`: the heading and the chip above are this panel's, for
                ANY widget configured elsewhere. The form drawing its own copy of
                both put the pair on screen twice, one line apart (bead
                `ro-mgqo`). With no countdown yet, the same form makes the first
                one. */}
            <CountdownEditor config={countdown} refused={countdownRefused} nowMs={nowMs} embedded />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Which assets a per-asset widget shows.
 *
 * NOTHING TICKED MEANS EVERY ASSET, and the panel says so rather than
 * pre-ticking the lot: a filter that starts full would put a list in the file
 * that has to be maintained every time an asset is added, and the Wall's job is
 * to show the portfolio unless told otherwise. Un-ticking the last one restores
 * that state, because an empty list is the one thing the contract refuses.
 */
function AssetFilter({
  assets,
  selected,
  disabled,
  label,
  onChange,
  pulseMetrics,
  showPulseMetrics = false,
  onPulseMetrics,
}: {
  assets: AssetCard[];
  selected: string[] | null;
  disabled: boolean;
  label: string;
  onChange: (next: string[] | null) => void;
  pulseMetrics: WallPulseMetrics;
  showPulseMetrics?: boolean;
  onPulseMetrics: (next: NonNullable<WallPulseMetrics>) => void;
}) {
  const toggle = (id: string) => {
    const current = selected ?? assets.map((asset) => asset.id);
    const next = current.includes(id)
      ? current.filter((value) => value !== id)
      : assets.filter((asset) => current.includes(asset.id) || asset.id === id).map((a) => a.id);
    onChange(next.length === 0 || next.length === assets.length ? null : next);
  };

  return (
    <div className="flex flex-col gap-1.5 border-t border-border pt-3" data-wall-asset-filter>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted-foreground">Sites</span>
        <span className="text-xs text-foreground">
          {selected === null ? "Every site" : `${selected.length} of ${assets.length}`}
        </span>
      </div>
      {assets.length === 0 ? (
        <p className="text-xs leading-snug text-muted-foreground">
          The store holds no sites yet, so there is nothing to filter.
        </p>
      ) : (
        <ul className="flex flex-col">
          {assets.map((asset) => (
            <li key={asset.id}>
              <label className="flex items-center gap-2 py-1 text-xs text-foreground max-sm:min-h-11">
                <input
                  type="checkbox"
                  className="size-4 accent-foreground"
                  checked={selected === null || selected.includes(asset.id)}
                  disabled={disabled}
                  onChange={() => toggle(asset.id)}
                />
                <span className="min-w-0 truncate">{asset.displayName}</span>
              </label>
              {showPulseMetrics && (selected === null || selected.includes(asset.id)) ? (
                <fieldset className="mb-3 ml-6 flex min-w-0 flex-col gap-1" data-wall-pulse-picker={asset.id}>
                  <legend className="mb-1 text-xs text-muted-foreground">Totals</legend>
                  {availablePulseCounters(asset, pulseMetrics).length === 0 ? (
                    <span className="text-xs text-muted-foreground">No totals yet</span>
                  ) : availablePulseCounters(asset, pulseMetrics).map((card) => {
                    const current = selectedPulseMetrics(asset, pulseMetrics);
                    return (
                      <label key={card.metric} className="flex min-w-0 items-center gap-2 py-1 text-xs max-sm:min-h-11">
                        <input
                          type="checkbox"
                          className="size-4 accent-foreground"
                          checked={current.includes(card.metric)}
                          disabled={disabled}
                          onChange={() => onPulseMetrics({
                            ...pulseMetrics,
                            [asset.id]: current.includes(card.metric)
                              ? current.filter((metric) => metric !== card.metric)
                              : [...current, card.metric],
                          })}
                        />
                        <span className="min-w-0 flex-1 break-words">{card.label}</span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">{card.value === null ? "No reading" : formatInt(card.value)}</span>
                      </label>
                    );
                  })}
                </fieldset>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs leading-snug text-muted-foreground">
        {selected === null
          ? `${label} shows every site, including any added later.`
          : `${label} shows only these, in this order.`}
      </p>
    </div>
  );
}
