import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/utils/combine";
import { ArrowDown, ArrowUp, Check, CircleSlash2, EyeOff, GripVertical } from "lucide-react";
import { ASSET_STATUS_LABEL } from "@shared/asset-detail";
import { isRetired } from "@shared/asset-setup";
import { useEffect, useRef, useState } from "react";
import {
  SHOWN_ON,
  SHOWN_ON_LABEL,
  shownOnChange,
  siteDisplayOf,
  siteShownOn,
  type ShownOnSurface,
  type SiteDisplay,
} from "@shared/site-display";
import { changesetSlug } from "@shared/changeset";
import { DropLine } from "@/components/DropLine";
import { StateChip } from "@/components/StateChip";
import { Button } from "@/components/ui/button";
import { pillChoiceClass, pillChoiceStateClass } from "@/components/ui/pill";
import { useStructuralSave } from "@/hooks/useConfigSave";
import { CONFIG_READ_ONLY_FALLBACK, useConfigWritable } from "@/hooks/useConfigWritable";
import { useSiteMove } from "@/hooks/useSiteMove";
import { useWall } from "@/hooks/useWall";
import { formatInt } from "@/lib/format";
import { movedOrder, rowDropEdge, shownOnLabel, siteDropTarget, type RowEdge } from "@/lib/site-arrange";
import { cn } from "@/lib/utils";

/** The fields a row draws. */
export interface ArrangedSite {
  id: string;
  displayName: string;
  status: string;
}

export interface SiteArrangeProps {
  /** Every site, hidden ones included, in the order every surface uses. */
  sites: readonly ArrangedSite[];
  /** The switches the operator set (`config/tower.json` `/sites`). */
  display: SiteDisplay | undefined;
  /** Move `asset` into the place `to` holds. */
  onMove: (asset: string, to: string) => void;
  /** Turn one switch of one site on or off. */
  onSwitch: (site: ArrangedSite, surface: ShownOnSurface, on: boolean) => void;
  disabled?: boolean;
  /** Why the controls are disabled, said once above the list. */
  disabledReason?: string | null;
  /** Whether the list also says why it is disabled. A page that says once
   * that saves are paused passes `false`; the controls are dark either way. */
  statesReadOnly?: boolean;
  /** A move is still landing: the next one waits for the order it leaves. */
  moving?: boolean;
  /** A switch whose save is still landing: drawn as asked and not pressable. */
  busy?: ReadonlySet<string>;
  className?: string;
}

/** What a row's drag carries, under a key no other drag on the page uses. */
const SITE_DRAG = "arrangeSite";
const SITE_DROP = "arrangeOnto";

interface Landing {
  onto: string;
  edge: RowEdge;
  to: string;
}

/** The key a busy switch is tracked by. */
export function switchKey(site: string, surface: ShownOnSurface): string {
  return `${site}:${surface}`;
}

/**
 * The sites in their order, to drag into a new one, with each site's three
 * switches for where it shows. A row is dragged by its grip; a line and a
 * label ("Above Northwind") show where it lands before the drop, and only
 * where a drop moves it, as the TV editor draws them. Move up and Move down on
 * every row are the same move for a keyboard and a phone. Each move and each
 * switch saves at once, with Undo in its toast.
 */
export function SiteArrange({
  sites,
  display,
  onMove,
  onSwitch,
  disabled = false,
  disabledReason = null,
  statesReadOnly = true,
  moving = false,
  busy,
  className,
}: SiteArrangeProps) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [landing, setLanding] = useState<Landing | null>(null);
  const order = sites.map((site) => site.id);
  const orderRef = useRef(order);
  orderRef.current = order;
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  // One watcher for the list's drags: it turns the edge under the pointer
  // into the move it would make, and draws nothing where it would make none.
  useEffect(() => {
    if (disabled) return;
    const plan = (source: Record<string | symbol, unknown>, target: Record<string | symbol, unknown> | undefined): Landing | null => {
      const asset = source[SITE_DRAG];
      const drop = target?.[SITE_DROP] as { site: string; edge: RowEdge } | undefined;
      if (typeof asset !== "string" || !drop) return null;
      const to = siteDropTarget(orderRef.current, asset, drop.site, drop.edge);
      return to === null ? null : { onto: drop.site, edge: drop.edge, to };
    };
    return monitorForElements({
      canMonitor: ({ source }) => typeof source.data[SITE_DRAG] === "string",
      onDragStart: ({ source }) => {
        setDragging(source.data[SITE_DRAG] as string);
        setLanding(null);
      },
      onDrag: ({ source, location }) => {
        const next = plan(source.data, location.current.dropTargets[0]?.data);
        setLanding((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
      },
      onDrop: ({ source, location }) => {
        const landed = plan(source.data, location.current.dropTargets[0]?.data);
        setDragging(null);
        setLanding(null);
        if (landed) onMoveRef.current(source.data[SITE_DRAG] as string, landed.to);
      },
    });
  }, [disabled]);

  return (
    <div className={cn("flex flex-col gap-2", className)} data-site-arrange>
      {disabled && statesReadOnly ? (
        <p className="m-0 text-xs leading-snug text-muted-foreground" data-site-arrange-locked>
          {disabledReason ?? CONFIG_READ_ONLY_FALLBACK}
        </p>
      ) : null}
      <ol aria-label="Your order" className="m-0 flex list-none flex-col rounded-[10px] border border-border bg-card p-0">
        {sites.map((site, index) => (
          <SiteArrangeRow
            key={site.id}
            site={site}
            place={index + 1}
            above={sites[index - 1]?.id ?? null}
            below={sites[index + 1]?.id ?? null}
            shown={siteShownOn(site, display)}
            disabled={disabled}
            moving={moving}
            busy={busy}
            lifted={dragging === site.id}
            landing={landing?.onto === site.id ? landing.edge : null}
            onMove={onMove}
            onSwitch={onSwitch}
          />
        ))}
      </ol>
    </div>
  );
}

function SiteArrangeRow({
  site,
  place,
  above,
  below,
  shown,
  disabled,
  moving,
  busy,
  lifted,
  landing,
  onMove,
  onSwitch,
}: {
  site: ArrangedSite;
  place: number;
  above: string | null;
  below: string | null;
  shown: Record<ShownOnSurface, boolean>;
  disabled: boolean;
  moving: boolean;
  busy: ReadonlySet<string> | undefined;
  lifted: boolean;
  landing: RowEdge | null;
  onMove: (asset: string, to: string) => void;
  onSwitch: (site: ArrangedSite, surface: ShownOnSurface, on: boolean) => void;
}) {
  const rowRef = useRef<HTMLLIElement | null>(null);
  const gripRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const element = rowRef.current;
    const dragHandle = gripRef.current;
    if (!element || !dragHandle || disabled) return;
    return combine(
      draggable({ element, dragHandle, getInitialData: () => ({ [SITE_DRAG]: site.id }) }),
      dropTargetForElements({
        element,
        canDrop: ({ source }) => typeof source.data[SITE_DRAG] === "string",
        getData: ({ input, element: target }) => ({
          [SITE_DROP]: { site: site.id, edge: rowDropEdge(target.getBoundingClientRect(), input.clientY) },
        }),
      }),
    );
  }, [site.id, disabled]);

  return (
    <li
      ref={rowRef}
      data-site-arrange-row={site.id}
      data-lifted={lifted ? "" : undefined}
      className={cn(
        "relative flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-2 py-2 last:border-b-0 sm:flex-nowrap",
        lifted && "opacity-40",
      )}
    >
      <span
        ref={gripRef}
        aria-hidden
        title={disabled ? undefined : `Drag ${site.displayName}`}
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground",
          disabled ? "opacity-50" : "cursor-grab hover:bg-muted active:cursor-grabbing",
        )}
        data-site-arrange-grip
      >
        <GripVertical className="size-4" />
      </span>
      <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{formatInt(place)}</span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 break-words text-sm font-medium text-foreground">{site.displayName}</span>
        {isRetired(site.status) ? <RetiredChip site={site.id} /> : null}
      </span>
      <ShownOnSwitches
        site={site}
        shown={shown}
        disabled={disabled}
        busy={busy}
        onSwitch={onSwitch}
        className="max-sm:order-last max-sm:w-full"
      />
      <div className="flex shrink-0 gap-1">
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={`Move ${site.displayName} up`}
          disabled={disabled || moving || above === null}
          onClick={() => above !== null && onMove(site.id, above)}
        >
          <ArrowUp className="size-4" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={`Move ${site.displayName} down`}
          disabled={disabled || moving || below === null}
          onClick={() => below !== null && onMove(site.id, below)}
        >
          <ArrowDown className="size-4" />
        </Button>
      </div>
      {landing ? (
        <DropLine
          marks={{ "data-site-arrange-drop": landing }}
          box={{ left: 8, right: 8, height: 4, ...(landing === "top" ? { top: -2 } : { bottom: -2 }) }}
          label={`${landing === "top" ? "Above" : "Below"} ${site.displayName}`}
          labelStyle={{ left: "3.25rem", top: "50%", transform: "translateY(-50%)" }}
        />
      ) : null}
    </li>
  );
}

/** A retired site's stage, with the switched-off mark the sidebar gives it:
 * its switches are off because of it until one is turned on. */
export function RetiredChip({ site }: { site: string }) {
  return (
    <StateChip
      tone="na"
      glyph={<CircleSlash2 className="size-3" aria-hidden />}
      label={ASSET_STATUS_LABEL.retired}
      subject={`stage:${site}`}
    />
  );
}

/**
 * A site's three switches, each one press: on shows a tick, off a crossed-out
 * eye, so the state is never colour alone. Arrange draws them on every row and
 * a site's Settings tab draws them on its own.
 */
export function ShownOnSwitches({
  site,
  shown,
  disabled,
  busy,
  onSwitch,
  className,
}: {
  site: ArrangedSite;
  shown: Record<ShownOnSurface, boolean>;
  disabled: boolean;
  busy: ReadonlySet<string> | undefined;
  onSwitch: (site: ArrangedSite, surface: ShownOnSurface, on: boolean) => void;
  className?: string;
}) {
  return (
    // Tighter under a thumb, so the three fit one line of a phone.
    <div role="group" aria-label={`Where ${site.displayName} shows`} className={cn("flex flex-wrap gap-1.5 max-sm:gap-1", className)}>
      {SHOWN_ON.map((surface) => {
        const on = shown[surface];
        const pending = busy?.has(switchKey(site.id, surface)) === true;
        return (
          <button
            key={surface}
            type="button"
            role="switch"
            aria-checked={on}
            aria-busy={pending || undefined}
            aria-label={`${SHOWN_ON_LABEL[surface]} for ${site.displayName}`}
            disabled={disabled || pending}
            onClick={() => onSwitch(site, surface, !on)}
            className={cn(pillChoiceClass, pillChoiceStateClass(on), "disabled:opacity-60 max-sm:px-1.5")}
            data-shown-on={surface}
            data-on={on ? "" : undefined}
          >
            {on ? <Check aria-hidden className="size-3" /> : <EyeOff aria-hidden className="size-3" />}
            {SHOWN_ON_LABEL[surface]}
          </button>
        );
      })}
    </div>
  );
}

/** Everything Arrange draws and does, ready for a page. */
export interface SiteArrangeState {
  /** Null until the wall read has answered. */
  sites: readonly ArrangedSite[] | null;
  display: SiteDisplay | undefined;
  writable: boolean;
  reason: string | null;
  moving: boolean;
  busy: ReadonlySet<string>;
  onMove: (asset: string, to: string) => void;
  onSwitch: (site: ArrangedSite, surface: ShownOnSurface, on: boolean) => void;
}

/**
 * Arrange's reads and writes: the wall read's sites and switches, the one move
 * write (`useSiteMove`) and the one switch write (`shownOnChange` through
 * `useStructuralSave`). A move or a switch is drawn as asked until the read
 * that follows its save lands, so the list does not jump back first.
 */
export function useSiteArrange(): SiteArrangeState {
  const { data } = useWall();
  const { writable, reason } = useConfigWritable();
  const { move, pending: moving } = useSiteMove();
  const save = useStructuralSave();
  const [order, setOrder] = useState<readonly string[] | null>(null);
  const [asked, setAsked] = useState<Readonly<Record<string, boolean>>>({});

  const sites = data?.assets ?? [];
  const display = siteDisplayOf(data);
  // A fresh read is the truth: whatever was drawn ahead of it is dropped.
  const readKey = `${sites.map((site) => site.id).join(" ")}|${JSON.stringify(display ?? null)}`;
  useEffect(() => {
    setOrder(null);
    setAsked({});
  }, [readKey]);

  const byId = new Map(sites.map((site) => [site.id, site]));
  const drawn = order === null ? sites : order.flatMap((id) => byId.get(id) ?? []);

  return {
    sites: data ? drawn : null,
    display: applyAsked(display, sites, asked),
    writable,
    reason,
    moving,
    busy: new Set(Object.keys(asked)),
    onMove: (asset, to) => {
      setOrder(movedOrder(drawn.map((site) => site.id), asset, to));
      void move(asset, to).then((landed) => {
        if (!landed) setOrder(null);
      });
    },
    onSwitch: (site, surface, on) => {
      const key = switchKey(site.id, surface);
      const change = shownOnChange(display, site.id, surface, on);
      setAsked((current) => ({ ...current, [key]: on }));
      void save({
        ops: change.ops,
        undo: change.undo,
        label: shownOnLabel(site.displayName, surface, on),
        slug: changesetSlug(site.id, "shown", surface),
      }).then((landed) => {
        if (landed) return;
        setAsked((current) => {
          const { [key]: _dropped, ...rest } = current;
          return rest;
        });
      });
    },
  };
}

/** Arrange as every page draws it, from `useSiteArrange`. */
export function LiveSiteArrange({ className, statesReadOnly = true }: { className?: string; statesReadOnly?: boolean }) {
  const arrange = useSiteArrange();
  if (arrange.sites === null) return null;
  return (
    <SiteArrange
      className={className}
      sites={arrange.sites}
      display={arrange.display}
      disabled={!arrange.writable}
      disabledReason={arrange.reason}
      statesReadOnly={statesReadOnly}
      moving={arrange.moving}
      busy={arrange.busy}
      onMove={arrange.onMove}
      onSwitch={arrange.onSwitch}
    />
  );
}

/** The stored switches with the ones just asked for drawn over them. */
function applyAsked(
  display: SiteDisplay | undefined,
  sites: readonly ArrangedSite[],
  asked: Readonly<Record<string, boolean>>,
): SiteDisplay | undefined {
  if (Object.keys(asked).length === 0) return display;
  const out: Record<string, Partial<Record<ShownOnSurface, boolean>>> = { ...(display ?? {}) };
  for (const site of sites) {
    for (const surface of SHOWN_ON) {
      const on = asked[switchKey(site.id, surface)];
      if (on !== undefined) out[site.id] = { ...out[site.id], [surface]: on };
    }
  }
  return out;
}
