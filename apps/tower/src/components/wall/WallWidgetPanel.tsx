import { Trash2 } from "lucide-react";
import type { CountdownConfig, DashboardRefusal } from "@shared/dashboard";
import type { AssetCard } from "@shared/wall";
import { isRetired } from "@shared/asset-setup";
import { siteShownOn, type SiteDisplay } from "@shared/site-display";
import { RetiredChip } from "@/components/SiteArrange";
import {
  WALL_WIDGET_LIBRARY,
  wallLayoutWidgets,
  type WallColumn,
  type WallColumnRow,
  type WallLayout,
  type WallWidgetSettings,
} from "@shared/wall-layout";
import { CountdownEditor } from "@/components/DashboardWidgets";
import { OwnerChip } from "@/components/OwnerChip";
import { StateChip } from "@/components/StateChip";
import { WallMoveMenu } from "@/components/wall/WallMoveMenu";
import { Button } from "@/components/ui/button";
import {
  WALL_SHARE_PRESETS,
  wallWidgetWhere,
  wallShareLabel,
  wallShareWidth,
  wallSlotOf,
  wallStackShareSizes,
  wallWidgetAt,
  type WallMove,
} from "@/lib/wall-editor";
import { cn } from "@/lib/utils";
import { availablePulseCounters, selectedPulseMetrics, type WallPulseMetrics } from "@/lib/wall-counters";
import { formatInt } from "@/lib/format";

export interface WallWidgetPanelProps {
  layout: WallLayout;
  selectedId: string | null;
  /** The assets the payload actually carries — the only ids a filter may name. */
  assets: AssetCard[];
  /** The switches set for where each site shows: a site off the TV by its
   * own setting is in no widget, so no widget's list can tick it. */
  display?: SiteDisplay;
  /** For the widget whose own configuration lives at `/countdown`. */
  countdown?: CountdownConfig;
  /** A saved countdown the Tower refused: the form saves
   * over it, guarded by the value as stored. The save bar names it. */
  countdownRefused?: DashboardRefusal | null;
  nowMs: number;
  /** Pick a widget to edit, as a click on it in the preview does. */
  onSelect: (widgetId: string) => void;
  onSettings: (widgetId: string, settings: WallWidgetSettings | undefined) => void;
  /** A width preset: new widths by slot id. */
  onWidths: (widths: Record<string, number>) => void;
  /** A stacked height preset: new height weights by column-row id. */
  onSizes: (sizes: Record<string, number | null>) => void;
  /** Its row takes the height left over, or fits its content. */
  onHeight: (rowId: string, height: "fill" | "fit") => void;
  onMove: (widgetId: string, move: WallMove) => void;
  onRemove: (widgetId: string) => void;
  disabled?: boolean;
  className?: string;
}

/** The presets offered for a stacked widget's height. */
const HEIGHT_PRESETS = WALL_SHARE_PRESETS.filter((p) => [1 / 3, 1 / 2, 2 / 3].includes(p.share));

const SHARE_WORDS: Record<string, string> = {
  "¼": "A quarter",
  "⅓": "A third",
  "½": "Half",
  "⅔": "Two thirds",
  "¾": "Three quarters",
};

/** A column row's share of its column's height, when every row has a weight. */
function heightShare(column: WallColumn, row: WallColumnRow): number | null {
  const weights = column.rows.map((r) => r.size ?? (r.height === "fill" ? 1 : null));
  if (weights.some((w) => w === null)) return null;
  const total = weights.reduce<number>((sum, w) => sum + (w ?? 0), 0);
  const own = row.size ?? (row.height === "fill" ? 1 : 0);
  return total > 0 ? own / total : null;
}

/**
 * The selected widget's settings. Its size comes first: one press gives it a
 * quarter, a third, a half, two thirds or three quarters of its row (a
 * stacked widget's column takes the share), and its height fits its content,
 * fills the rest, or takes a share of its column. Move opens the same menu
 * its toolbar on the TV does, for a phone or a keyboard. Then the settings its
 * renderer applies (`spec.settings`), and for the strip the countdown's own
 * form (`CountdownEditor`), because the countdown lives at `/countdown`.
 */
export function WallWidgetPanel({
  layout,
  selectedId,
  assets,
  display,
  countdown,
  countdownRefused = null,
  nowMs,
  onSelect,
  onSettings,
  onWidths,
  onSizes,
  onHeight,
  onMove,
  onRemove,
  disabled = false,
  className,
}: WallWidgetPanelProps) {
  const at = selectedId ? wallWidgetAt(layout, selectedId) : null;
  const holder = selectedId ? wallSlotOf(layout, selectedId) : null;

  if (!at || !holder) {
    // Nothing selected offers the placed widgets as the choice, one press
    // each, the same selection a click in the preview makes.
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

  const { widget, column } = at;
  const spec = WALL_WIDGET_LIBRARY[widget.type];
  const filtered = widget.settings?.assets ?? null;
  const { slot, row: topRow } = holder;
  const slotWeight = topRow.widgets.reduce((sum, s) => sum + s.width, 0);
  const share = slotWeight > 0 ? slot.width / slotWeight : 1;
  const alone = topRow.widgets.length === 1;
  const inner = column ? (at.row as WallColumnRow) : null;
  const stackShare = column && inner ? heightShare(column, inner) : null;

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
            <p className="text-xs text-muted-foreground" data-wall-widget-position>
              {wallWidgetWhere(layout, widget.id)?.where}
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

        <WallMoveMenu
          layout={layout}
          widgetId={widget.id}
          variant="panel"
          disabled={disabled}
          onMove={(move) => onMove(widget.id, move)}
          onRemove={() => onRemove(widget.id)}
        />

        {/* Sizes as shares of what holds it: the row for its width, its
            column (or the TV) for its height. */}
        <div className="flex flex-col gap-1.5 border-t border-border pt-3" data-wall-size>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-muted-foreground">{column ? "Column width" : "Width"}</span>
            <span className="text-xs tabular-nums text-foreground" data-wall-width-share>
              {alone ? "The whole row" : `${wallShareLabel(share)} of the row`}
            </span>
          </div>
          {alone ? null : (
            <div className="flex flex-wrap gap-1" role="group" aria-label={column ? "Column width" : "Width"}>
              {WALL_SHARE_PRESETS.map((preset) => {
                const width = wallShareWidth(topRow.widgets, slot.id, preset.share);
                return (
                  <Button
                    key={preset.label}
                    type="button"
                    variant={Math.abs(share - preset.share) < 0.012 ? "default" : "outline"}
                    size="sm"
                    className="min-w-10 tabular-nums"
                    aria-label={`${SHARE_WORDS[preset.label]} of the row`}
                    aria-pressed={Math.abs(share - preset.share) < 0.012}
                    disabled={disabled || width === null}
                    onClick={() => width !== null && onWidths({ [slot.id]: width })}
                    data-wall-width-preset={preset.label}
                  >
                    {preset.label}
                  </Button>
                );
              })}
            </div>
          )}

          <div className="mt-1 flex items-baseline justify-between gap-2">
            <span className="text-xs text-muted-foreground">Height</span>
          </div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Height">
            {column && inner ? (
              <>
                <Button
                  type="button"
                  variant={inner.size === undefined && inner.height === "auto" ? "default" : "outline"}
                  size="sm"
                  aria-pressed={inner.size === undefined && inner.height === "auto"}
                  disabled={disabled}
                  onClick={() => onHeight(inner.id, "fit")}
                  data-wall-height="fit"
                >
                  Fit content
                </Button>
                {HEIGHT_PRESETS.map((preset) => {
                  const on = stackShare !== null && Math.abs(stackShare - preset.share) < 0.02;
                  return (
                    <Button
                      key={preset.label}
                      type="button"
                      variant={on ? "default" : "outline"}
                      size="sm"
                      className="min-w-10 tabular-nums"
                      aria-label={`${SHARE_WORDS[preset.label]} of the column`}
                      aria-pressed={on}
                      disabled={disabled}
                      onClick={() => onSizes(wallStackShareSizes(column, inner.id, preset.share))}
                      data-wall-height={preset.label}
                    >
                      {preset.label}
                    </Button>
                  );
                })}
                <Button
                  type="button"
                  variant={inner.size === undefined && inner.height === "fill" ? "default" : "outline"}
                  size="sm"
                  aria-pressed={inner.size === undefined && inner.height === "fill"}
                  disabled={disabled}
                  onClick={() => onHeight(inner.id, "fill")}
                  data-wall-height="fill"
                >
                  Fill the rest
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  variant={topRow.height === "auto" ? "default" : "outline"}
                  size="sm"
                  aria-pressed={topRow.height === "auto"}
                  disabled={disabled}
                  onClick={() => onHeight(topRow.id, "fit")}
                  data-wall-height="fit"
                >
                  Fit content
                </Button>
                <Button
                  type="button"
                  variant={topRow.height === "fill" ? "default" : "outline"}
                  size="sm"
                  aria-pressed={topRow.height === "fill"}
                  disabled={disabled}
                  onClick={() => onHeight(topRow.id, "fill")}
                  data-wall-height="fill"
                >
                  Fill the rest
                </Button>
              </>
            )}
          </div>
        </div>

        {spec.settings.includes("assets") ? (
          <AssetFilter
            assets={assets}
            offBy={(asset) => siteOffWords(asset, display, widget.type)}
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
                {/* Nothing to count down to is a state; the form below sets it. */}
                {countdown || countdownRefused ? null : (
                  <span data-wall-countdown-absent>
                    <StateChip label="Not set" tone="na" subject="wall:countdown" />
                  </span>
                )}
              </span>
              <OwnerChip path="config/tower.json" />
            </div>
            {/* `embedded`: the heading and chip above are this panel's, so the
                form does not draw its own. */}
            <CountdownEditor config={countdown} refused={countdownRefused} nowMs={nowMs} embedded />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Why a site cannot be ticked for this widget, in the words the list shows,
 * or null when it can: off the TV by its own setting, or, for Work, off Work
 * this week by its own. */
function siteOffWords(asset: AssetCard, display: SiteDisplay | undefined, type: string): string | null {
  const shown = siteShownOn(asset, display);
  if (!shown.tv) return "Off on the TV by its own setting";
  if (type === "work" && !shown.work) return "Off in Work this week by its own setting";
  return null;
}

/**
 * Which assets a per-asset widget shows.
 *
 * Nothing ticked means every asset, so a new asset needs no edit here.
 * Un-ticking the last one restores that state, because the contract refuses
 * an empty list. A site off by its own setting is drawn unticked and cannot
 * be ticked; the widget's list keeps whatever it saved for it.
 */
function AssetFilter({
  assets,
  offBy,
  selected,
  disabled,
  label,
  onChange,
  pulseMetrics,
  showPulseMetrics = false,
  onPulseMetrics,
}: {
  assets: AssetCard[];
  offBy: (asset: AssetCard) => string | null;
  selected: string[] | null;
  disabled: boolean;
  label: string;
  onChange: (next: string[] | null) => void;
  pulseMetrics: WallPulseMetrics;
  showPulseMetrics?: boolean;
  onPulseMetrics: (next: NonNullable<WallPulseMetrics>) => void;
}) {
  const tickable = assets.filter((asset) => offBy(asset) === null);
  const toggle = (id: string) => {
    const current = selected ?? tickable.map((asset) => asset.id);
    const next = current.includes(id)
      ? current.filter((value) => value !== id)
      : assets.filter((asset) => current.includes(asset.id) || asset.id === id).map((a) => a.id);
    const everyTickable = next.length === tickable.length && tickable.every((asset) => next.includes(asset.id));
    onChange(next.length === 0 || everyTickable ? null : next);
  };
  const ticked = (asset: AssetCard) => offBy(asset) === null && (selected === null || selected.includes(asset.id));

  return (
    <div className="flex flex-col gap-1.5 border-t border-border pt-3" data-wall-asset-filter>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted-foreground">Sites</span>
        <span className="text-xs text-foreground">
          {selected === null ? "Every site" : `${tickable.filter(ticked).length} of ${tickable.length}`}
        </span>
      </div>
      {assets.length === 0 ? (
        <p className="text-xs leading-snug text-muted-foreground">
          The store holds no sites yet, so there is nothing to filter.
        </p>
      ) : (
        <ul className="flex flex-col">
          {assets.map((asset) => (
            <li key={asset.id} data-wall-asset-off={offBy(asset) === null ? undefined : ""}>
              <label className="flex items-center gap-2 py-1 text-xs text-foreground max-sm:min-h-11">
                <input
                  type="checkbox"
                  className="size-4 accent-foreground"
                  checked={ticked(asset)}
                  disabled={disabled || offBy(asset) !== null}
                  onChange={() => toggle(asset.id)}
                />
                <span className="flex min-w-0 flex-col items-start gap-0.5">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="break-words">{asset.displayName}</span>
                    {isRetired(asset.status) ? <RetiredChip site={asset.id} /> : null}
                  </span>
                  {offBy(asset) === null ? null : (
                    <span className="text-muted-foreground" data-wall-asset-off-words>{offBy(asset)}</span>
                  )}
                </span>
              </label>
              {showPulseMetrics && ticked(asset) ? (
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
