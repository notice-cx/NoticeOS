import { ChevronRight, Layers } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { translateAlert } from "@shared/alert-language";
import { siteAddress } from "@shared/first-run";
import { ageMs, formatAge } from "@shared/freshness";
import type { AttentionItem } from "@shared/wall";
import { ALERT_EVIDENCE_QUESTION, Recurrence, alertPopoverEvidence } from "@/components/AlertRow";
import { AlertVerification } from "@/components/AlertVerification";
import { ChangeChip } from "@/components/ChangeChip";
import { Drill } from "@/components/Drill";
import { EvidencePopover } from "@/components/EvidencePopover";
import { FlagActions } from "@/components/FlagActions";
import { HandoffBeadBadge } from "@/components/HandoffBeadBadge";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { FileTaskButton } from "@/components/TaskComposer";
import { Button } from "@/components/ui/button";
import { BarStrip } from "@/components/viz/BarStrip";
import { NormalBand } from "@/components/viz/NormalBand";
import { useSitePath } from "@/hooks/useSitePath";
import { alertBoard, alertNormal, readingNights, shortHeadline, type BoardSite } from "@/lib/alerts-board";
import { alertTaskHandoff, isGrouped, memberNames } from "@/lib/attention";
import { formatInt } from "@/lib/format";
import { taskHandoffPrefill } from "@/lib/task-handoff";
import { cn } from "@/lib/utils";
import { AlertMark, BoardRow, ROW_GRID } from "@/routes/alerts/BoardRow";

/**
 * The open alerts as one board: a section per site, worst site first, each
 * alert's reading drawn against the normal its rule computed; what has been
 * open for over a week folds under its own heading at the end, so an old
 * fault never sits as loud as a fresh one. Every matching row is here: a
 * triage page never keeps work out of sight behind a "Show more".
 */
export function AlertBoard({
  items,
  total,
  filtering,
  nowMs,
  focusId,
}: {
  items: readonly AttentionItem[];
  /** Every open alert, for "3 of 10 open" when a filter narrows the board. */
  total: number;
  filtering: boolean;
  nowMs: number;
  /** The row a timeline bar linked to. */
  focusId: number | null;
}) {
  const board = alertBoard(items, nowMs);
  const [showOld, setShowOld] = useState(false);
  const oldFocused = focusId !== null && board.longStanding.some((item) => item.id === focusId);
  // The old fold only under something fresher: a board of nothing but a
  // folded line would keep every open alert out of sight.
  const foldable = board.sites.length > 0;
  const unfolded = !foldable || showOld || oldFocused;
  const shown = [...board.sites.flatMap((site) => site.items), ...(unfolded ? board.longStanding : [])];
  const hasReadings = shown.some((item) => alertNormal(item) !== null);

  return (
    <section aria-label="Open alerts" data-alert-board="" className="@container flex flex-col rounded-xl bg-card pt-2 ring-1 ring-border/70">
      {/* No title: the tab above already says Open. The answer owns the
          total, so a count appears only when a filter has made the board
          show fewer. */}
      <ColumnHeads reading={hasReadings} rows={shown.length > 0} count={filtering ? `${formatInt(items.length)} of ${formatInt(total)} open` : null} />

      <ul className="m-0 list-none p-0">
        {board.sites.map((site) => (
          <SiteSection key={site.key} site={site} nowMs={nowMs} focusId={focusId} />
        ))}
      </ul>

      {board.longStanding.length > 0 ? (
        <div className={cn(foldable && "border-t border-border/60")} data-alert-long-standing={board.longStanding.length}>
          {foldable ? (
            <button
              type="button"
              aria-expanded={unfolded}
              onClick={() => setShowOld((value) => !value)}
              className="flex w-full items-center gap-2 px-5 pb-1 pt-3 text-start text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 motion-safe:transition-transform", unfolded && "rotate-90")} />
              <LongStandingTitle count={board.longStanding.length} />
            </button>
          ) : (
            <h3 className="m-0 px-5 pb-1 pt-3 text-xs font-medium text-muted-foreground">
              <LongStandingTitle count={board.longStanding.length} />
            </h3>
          )}
          {unfolded ? (
            <ul className="m-0 list-none px-2 pb-2 pt-1">
              {board.longStanding.map((item) => (
                <AlertBoardRow key={item.id} item={item} nowMs={nowMs} focused={item.id === focusId} quiet showSite />
              ))}
            </ul>
          ) : (
            <div className="px-5 pb-3 ps-10.5">
              <p className="m-0 text-xs text-muted-foreground">
                {board.longStanding.map((item) => `${shortHeadline(translateAlert(item).headline)} on ${siteName(item)}`).join(" · ")}
              </p>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function LongStandingTitle({ count }: { count: number }) {
  return (
    <span className="whitespace-nowrap">
      Open for over a week <span className="tabular-nums">· {formatInt(count)}</span>
    </span>
  );
}

function siteName(item: AttentionItem): string {
  return isGrouped(item) ? (memberNames(item) ?? item.assetDisplayName) : item.assetDisplayName;
}

/** The column heads, said once for the board rather than under every row,
 * with the filtered count where the titles' column starts. */
function ColumnHeads({ reading, rows, count }: { reading: boolean; rows: boolean; count: string | null }) {
  if (!rows && count === null) return null;
  return (
    <div className={cn(ROW_GRID, "mx-2 px-3 pt-1 text-micro text-muted-foreground", count === null && "hidden @2xl:grid")}>
      <span aria-hidden className="col-start-1 row-start-1 size-5" />
      <span className="col-start-2 row-start-1 whitespace-nowrap text-xs tabular-nums">{count}</span>
      <span aria-hidden className="hidden whitespace-nowrap @2xl:col-start-3 @2xl:row-start-1 @2xl:block">{reading ? "Reading against usual" : ""}</span>
      {rows ? <span aria-hidden className="hidden whitespace-nowrap text-end @2xl:col-start-4 @2xl:row-start-1 @2xl:block">First detected</span> : null}
    </div>
  );
}

function SiteSection({ site, nowMs, focusId }: { site: BoardSite; nowMs: number; focusId: number | null }) {
  const sitePath = useSitePath();
  const errors = site.items.filter((item) => item.severity === "error").length;
  const warnings = site.items.length - errors;
  const counts = [errors > 0 ? `${formatInt(errors)} ${errors === 1 ? "error" : "errors"}` : null, warnings > 0 ? `${formatInt(warnings)} ${warnings === 1 ? "warning" : "warnings"}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="m-0 border-t border-border/60 first:border-t-0" data-alert-site={site.key}>
      <h3 className="m-0 flex min-w-0 items-center gap-2 px-5 pb-0.5 pt-3 text-sm">
        {site.asset ? (
          <>
            <PropertyFavicon domain={site.asset} displayName={site.name} className="size-4" />
            <Link to={sitePath(site.asset)} className="min-w-0 font-semibold text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring" title={site.name}>
              {site.name}
            </Link>
          </>
        ) : (
          <>
            <Layers aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="font-semibold text-foreground">{site.name}</span>
          </>
        )}
        {/* Read as "Plume Studio 2 warnings"; a flex gap is not a space. */}
        {" "}
        <span className="whitespace-nowrap text-xs font-normal tabular-nums text-muted-foreground">{counts}</span>
      </h3>
      <ul className="m-0 list-none px-2 pb-2">
        {site.items.map((item) => (
          <AlertBoardRow key={item.id} item={item} nowMs={nowMs} focused={item.id === focusId} />
        ))}
      </ul>
    </li>
  );
}

function AlertBoardRow(props: { item: AttentionItem; nowMs: number; focused: boolean; quiet?: boolean; showSite?: boolean }) {
  return isGrouped(props.item) ? <GroupedAlertRow {...props} /> : <OpenAlertRow {...props} />;
}

/** The reading drawn against its rule's normal, or nothing when the rule kept none. */
function Reading({ item }: { item: AttentionItem }) {
  const normal = alertNormal(item);
  if (!normal) return null;
  return (
    <NormalBand
      value={normal.value}
      low={normal.low}
      high={normal.high}
      label={normal.label}
      unit={normal.unit}
      bad={normal.bad}
      severity={item.severity === "error" ? "error" : "warn"}
      format={normal.format}
      compact
    />
  );
}

/** The nights behind the condition, one bar each, against the rule's usual
 * level: whether tonight is a dip or the latest of a run. */
function Nights({ item }: { item: AttentionItem }) {
  const nights = readingNights(item);
  const normal = alertNormal(item);
  if (!nights || !normal) return null;
  return (
    <div className="w-full max-w-sm" data-alert-nights={nights.length}>
      <BarStrip
        data={nights}
        tone={item.severity === "error" ? "text-error" : "text-warn"}
        baseline={normal.level}
        format={normal.format}
        ariaLabel={`${normal.label}, each night it was read`}
        className="h-10"
      />
    </div>
  );
}

/** Which site, where a list holds several: the favicon its own page wears. */
function SiteTag({ id, name }: { id: string; name: string }) {
  return (
    <>
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <PropertyFavicon domain={id} displayName={name} className="size-4" />
        {name}
      </span>
      <span aria-hidden className="text-muted-foreground">
        {" · "}
      </span>
    </>
  );
}

/**
 * One open alert. The age is the recorded first-seen time, not tonight's
 * re-reading; it does not prove the condition stayed true between checks.
 * Snooze and Resolve sit on the row; Mark read, Tune, a task and the site are
 * in the opened row, after the evidence.
 */
function OpenAlertRow({ item, nowMs, focused, quiet = false, showSite = false }: { item: AttentionItem; nowMs: number; focused: boolean; quiet?: boolean; showSite?: boolean }) {
  const alert = translateAlert(item);
  const openSite = useSitePath();
  return (
    <BoardRow
      marks={{ "data-alert-row": String(item.id), "data-flag-severity": item.severity, "data-flag-kind": item.kind }}
      focused={focused}
      quiet={quiet}
      mark={<AlertMark severity={item.severity} quiet={quiet} />}
      title={
        <>
          {showSite ? <SiteTag id={item.asset} name={item.assetDisplayName} /> : null}
          {alert.headline} <Recurrence item={item} nowMs={nowMs} />
        </>
      }
      caption={
        <>
          <AlertVerification verification={item.verification} firstDetectedAt={item.firstFiredAt} nowMs={nowMs} interactive={false} />
          {alert.hint ? ` · ${alert.hint}` : null}
        </>
      }
      evidence={<Reading item={item} />}
      age={formatAge(ageMs(nowMs, item.firstFiredAt))}
      ageLabel="first detected"
      rowActions={<FlagActions flagId={item.id} assetId={item.asset} only={["snooze", "resolve"]} />}
      actions={
        <>
          {item.handoffBeads?.map((bead) => <HandoffBeadBadge key={bead.beadId} bead={bead} />)}
          <FlagActions flagId={item.id} assetId={item.asset} ruleId={item.ruleId} metric={item.metric} only={["acknowledge", "tune"]} />
          {/* Mark read and Resolve say what was done with the ALERT; a task is
              what is being done about the CONDITION, so filing leaves the
              alert open until the condition clears. */}
          <FileTaskButton prefill={taskHandoffPrefill(alertTaskHandoff(item))} subject={alert.headline} variant="outline" />
          <Button asChild size="sm" variant="outline">
            <Link to={openSite(item.asset)}>Open {item.assetDisplayName}</Link>
          </Button>
        </>
      }
    >
      <Nights item={item} />
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <EvidencePopover
          evidence={alertPopoverEvidence(alert, item, nowMs)}
          question={ALERT_EVIDENCE_QUESTION}
          contextLabel={item.ruleId}
          nowMs={nowMs}
          triggerLabel="Evidence"
        />
        <ChangeChip changes={item.correlatedChanges} firedAt={item.firedAt} to={siteAddress(item.asset, "#timeline")} interactive />
        {/* Most alerts are anomalies; only the other kinds name themselves. */}
        {item.kind !== "anomaly" ? <span className="capitalize" data-alert-kind={item.kind}>{item.kind}</span> : null}
      </span>
    </BoardRow>
  );
}

/**
 * One row for one fact true of several sites, still actionable per site:
 * the members are inside, each with its own link, age and verbs. No
 * recurrence chip (`occurrences` here counts sites) and no File task (there
 * is no single firing to name). The age is the oldest member's.
 */
function GroupedAlertRow({ item, nowMs, focused, quiet = false }: { item: AttentionItem; nowMs: number; focused: boolean; quiet?: boolean }) {
  const alert = translateAlert(item);
  const openSite = useSitePath();
  const members = item.members ?? [];
  return (
    <BoardRow
      marks={{ "data-alert-row": String(item.id), "data-flag-severity": item.severity, "data-flag-kind": item.kind }}
      focused={focused}
      quiet={quiet}
      mark={<AlertMark severity={item.severity} quiet={quiet} />}
      // No site tag: the row has no single site, and naming the
      // representative would pin the portfolio's fact on one of its members.
      title={<span title={memberNames(item)}>{alert.headline}</span>}
      caption={
        <>
          <AlertVerification verification={item.verification} firstDetectedAt={item.firstFiredAt} nowMs={nowMs} interactive={false} />
          {` · ${alert.hint ?? memberNames(item) ?? "Grouped sites"}`}
        </>
      }
      evidence={<Reading item={item} />}
      age={formatAge(ageMs(nowMs, item.firstFiredAt))}
      ageLabel="first detected"
    >
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <EvidencePopover
          evidence={alertPopoverEvidence(alert, item, nowMs)}
          question={ALERT_EVIDENCE_QUESTION}
          contextLabel={item.ruleId}
          nowMs={nowMs}
          triggerLabel="Evidence"
        />
      </span>
      <span className="flex flex-col gap-1.5" data-attention-group={item.ruleId}>
        {members.map((member): ReactNode => (
          <span key={member.id} className="flex flex-wrap items-center gap-x-2 gap-y-1" data-attention-group-member={member.asset}>
            <Drill interactive to={openSite(member.asset)} className="font-medium">
              {member.assetDisplayName}
            </Drill>
            <span className="tabular-nums text-muted-foreground">First detected {formatAge(ageMs(nowMs, member.firedAt))} ago</span>
            <AlertVerification verification={member.verification} firstDetectedAt={member.firedAt} nowMs={nowMs} />
            <FlagActions flagId={member.id} assetId={member.asset} />
          </span>
        ))}
      </span>
    </BoardRow>
  );
}
