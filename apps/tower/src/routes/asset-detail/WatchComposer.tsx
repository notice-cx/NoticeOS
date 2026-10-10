import { useOwnerToast } from '@/lib/browser-context';
import { Check, RefreshCw, Target, Timer } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";

import type { HandoffBead, WatchSlice } from "@shared/asset-detail";
import { isTaskId } from "@shared/tasks";
import { type AssetIntegrationLane } from "@shared/integrations";
import { type AnnotationItem } from "@shared/annotations";
import {
  WATCH_DEFAULT_DELTA_PCT,
  WATCH_VERDICT_DAYS,
  watchBaselineFor,
  watchCalibration,
  watchCalibrationBasis,
  watchCheckDates,
  watchDayOf,
  watchDaySpan,
  watchDraftBody,
  watchDraftIssues,
  watchScopeFor,
  watchScopeState,
  watchScopeText,
  watchSeriesLabel,
  type WatchCalibration,
  type WatchCalibrationBasis,
  type WatchDraft,
  type WatchSeed,
  type WatchSeriesHistory,
} from "@shared/watch-windows";
import {
  WATCH_SERIES,
  watchScopeRequired,
  type WatchSeries,
} from "@noticeos/contract/create-watch-window";
import { HandoffBeadBadge } from "@/components/HandoffBeadBadge";
import { Meter } from "@/components/Meter";
import { ProgressRing } from "@/components/ProgressRing";
import { StateChip, type StateTone } from "@/components/StateChip";
import { ListPanel, ListRow } from "@/components/surface/ListPanel";
import { ANNOTATION_KIND } from "@/components/annotation-kind";
import { WATCH_OUTCOME } from "@/components/watch-outcome";
import { useWatchQueryHistory } from "@/hooks/useWatchQueryHistory";
import { useWatchWindowWriter } from "@/hooks/useWatchWindowWriter";
import { Button } from "@/components/ui/button";
import { formatCalendarDate, formatCalendarRange, formatInt, formatSeriesDate } from "@/lib/format";

// --- the outcome check an operator opens on a change -----------------------
// The Activity tab's composer and the strip of checks it files.

/**
 * Open a pre-registered outcome check on this asset. Everything here is a
 * prefill, so registering is one click and every field is editable; what it
 * will not do is relax a rule: `watchDraftIssues` mirrors the ingest route's
 * own 422s and blocks the button, and the route re-checks every one anyway.
 *
 * No backdating control, though the route allows it: a backdated window's
 * final check may already have passed, closing on numbers the operator has
 * seen. The baseline may be as old as the change; the checks start now.
 *
 * The threshold is calibrated from this asset's own series, the same
 * comparison the evaluator will make, run over every adjacent pair of
 * baseline-length windows the archives hold; it re-derives when the series or
 * the baseline length changes. The plan is drawn under the fields, and a rule
 * the route would refuse is prevented where it can be, so the refusal line is
 * a guard, not an explanation.
 */
export function WatchComposer({
  assetId,
  changes,
  lanes,
  history,
  seed,
  nowMs,
  onDone,
}: {
  assetId: string;
  changes: AnnotationItem[];
  lanes: AssetIntegrationLane[];
  history: WatchSeriesHistory[];
  /** What a query row or finding card asked to watch, or null when the operator
   * opened the form from the section header. */
  seed: WatchSeed | null;
  nowMs: number;
  onDone: () => void;
}) {
  const toast = useOwnerToast();
  const registerWatch = useWatchWindowWriter(assetId);
  const today = watchDayOf(new Date(nowMs).toISOString());

  // A seeded composer opens on "Something else" and NOT on the newest timeline
  // event: the operator is watching a query or a finding, and quietly attaching
  // their check to yesterday's unrelated deploy would give the window a ref that
  // names the wrong change.
  const [changeId, setChangeId] = useState<number | "manual">(
    seed ? "manual" : (changes[0]?.id ?? "manual"),
  );
  // The ref is the task when the surface knew one, and the operator's own
  // words otherwise. The subject still travels as the note, so the pending
  // list says what is being watched while the ref stays the id a later
  // reading joins on.
  const [manualRef, setManualRef] = useState(
    seed?.beadId ?? seed?.subject ?? "",
  );
  const [series, setSeries] = useState<WatchSeries>(
    () => seed?.series ?? defaultWatchSeries(lanes),
  );
  // An edit REPLACES the prefill; changing what is being watched clears it, so
  // the dates never keep describing a change the operator has moved on from.
  const [baselineEdit, setBaselineEdit] = useState<
    { start: string; end: string } | null
  >(null);
  const [noteEdit, setNoteEdit] = useState<string | null>(seed?.subject ?? null);
  const [verdictDays, setVerdictDays] = useState<number>(WATCH_VERDICT_DAYS[0]);
  // Same prefill-with-edit shape as the baseline: null means "whatever this
  // asset's own history says", a number means the operator has overruled it.
  const [deltaEdit, setDeltaEdit] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const change = changes.find((item) => item.id === changeId) ?? null;
  const changeDay = change ? watchDayOf(change.at) : today;
  const baseline = baselineEdit ?? watchBaselineFor(changeDay);
  const note = noteEdit ?? (change?.note ?? "");

  // Calibrated at the BASELINE's own span, because that is the window the
  // evaluator will compare against. Widening the baseline quietens the series,
  // so a floor measured at 28 days would be too high for a 90-day check and the
  // number under the form would describe a comparison nobody registered.
  const queryScope = watchScopeFor(seed, series);
  const queryHistoryRead = useWatchQueryHistory(
    assetId,
    queryScope?.query ?? null,
    series.metric,
  );
  // `placeholderData` can retain the prior query while a changed selector
  // loads. The echo check is the guard that prevents that convenient visual
  // continuity from becoming a threshold borrowed from another query.
  const queryHistory =
    queryScope &&
    queryHistoryRead.data?.query === queryScope.query &&
    queryHistoryRead.data.metric === series.metric
      ? queryHistoryRead.data
      : null;
  const baselineDays = watchDaySpan(baseline.start, baseline.end);
  const calibration = queryScope
    ? watchCalibration(queryHistory, baselineDays)
    : watchCalibration(
        history.find(
          (entry) =>
            entry.integration === series.integration && entry.metric === series.metric,
        ) ?? null,
        baselineDays,
      );
  const basis = watchCalibrationBasis(calibration, queryScope, queryHistory);
  const minDeltaPct =
    deltaEdit ?? (basis.kind === "none" ? WATCH_DEFAULT_DELTA_PCT : basis.calibration.suggestedPct);

  function pickChange(value: string) {
    setChangeId(value === "manual" ? "manual" : Number(value));
    setBaselineEdit(null);
    setNoteEdit(null);
  }

  /** Changing WHICH NUMBER is watched drops an overridden threshold, exactly as
   * changing what is watched drops an edited baseline. A percentage chosen for
   * Google clicks is not a statement about average position, and carrying it
   * across would silently re-create the invented threshold this prefill exists
   * to end. Editing the baseline does NOT drop it: that is the operator moving
   * the window under a number they already decided on. */
  function pickSeries(next: WatchSeries) {
    setSeries(next);
    setDeltaEdit(null);
  }

  const draft: WatchDraft = {
    refKind: change ? "annotation" : "manual",
    ref: change ? String(change.id) : manualRef,
    series,
    baselineStart: baseline.start,
    baselineEnd: baseline.end,
    verdictDays,
    minDeltaPct,
    note,
    scope: queryScope,
  };
  const issues = watchDraftIssues(draft, today);
  const canSave = issues.length === 0 && !saving;
  const scope = watchScopeState(seed, series);
  const queryScoped = draft.scope !== null;
  const queryCalibrationLoading =
    queryScoped &&
    (queryHistoryRead.isPending || (queryHistoryRead.isFetching && !queryHistory));
  const queryCalibrationFailed = queryScoped && queryHistoryRead.isError;
  const calibrationState: CalibrationState =
    deltaEdit !== null
      ? "custom"
      : queryCalibrationLoading
        ? "loading"
        : queryCalibrationFailed
          ? "unavailable"
          : basis.kind === "none"
            ? "uncalibrated"
            : basis.calibration.changeCalendarComplete
              ? "calibrated"
              : "historical";
  // A seeded query can be followed by an average; without one, an average
  // would read the query mix rather than the change, so those series are
  // offered but disabled rather than refused after the fact.
  const averagesAllowed = Boolean(seed?.query);

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      await registerWatch(watchDraftBody(draft));
      toast.success("Outcome check registered");
      onDone();
    } catch (err) {
      // The operator's choices stay exactly where they are: a refused
      // registration must not cost them the comparison they just designed.
      toast.error(
        err instanceof Error && err.message.length > 0
          ? err.message
          : "Not registered — the store refused the check",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="mb-3 flex flex-col gap-2.5 rounded-lg border border-border bg-background/40 p-3"
      aria-label="Register an outcome check"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          What changed
          <select
            className="h-8 max-w-[18rem] rounded-md border border-border bg-card px-2 text-sm text-foreground"
            value={change ? String(change.id) : "manual"}
            onChange={(event) => pickChange(event.target.value)}
          >
            {changes.map((item) => (
              <option key={item.id} value={String(item.id)}>
                {watchChangeLabel(item)}
              </option>
            ))}
            <option value="manual">Something else…</option>
          </select>
        </label>
        {change ? null : (
          <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs text-muted-foreground">
            What are you watching
            <input
              type="text"
              className="h-8 rounded-md border border-border bg-card px-2 text-sm text-foreground"
              placeholder="July title batch"
              value={manualRef}
              onChange={(event) => setManualRef(event.target.value)}
              maxLength={256}
            />
          </label>
        )}
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Which number
          <select
            className="h-8 rounded-md border border-border bg-card px-2 text-sm text-foreground"
            value={`${series.integration}:${series.metric}`}
            onChange={(event) =>
              pickSeries(
                WATCH_SERIES.find(
                  (option) =>
                    `${option.integration}:${option.metric}` === event.target.value,
                ) ?? series,
              )
            }
          >
            {WATCH_SERIES.filter((option) => !watchScopeRequired(option)).map(seriesOption)}
            <optgroup label="One query only" disabled={!averagesAllowed}>
              {WATCH_SERIES.filter((option) => watchScopeRequired(option)).map(seriesOption)}
            </optgroup>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Baseline from
          <input
            type="date"
            className="h-8 rounded-md border border-border bg-card px-2 text-sm tabular-nums text-foreground"
            value={baseline.start}
            max={today}
            onChange={(event) =>
              setBaselineEdit({ ...baseline, start: event.target.value })
            }
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Baseline to
          <input
            type="date"
            className="h-8 rounded-md border border-border bg-card px-2 text-sm tabular-nums text-foreground"
            value={baseline.end}
            max={today}
            onChange={(event) =>
              setBaselineEdit({ ...baseline, end: event.target.value })
            }
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Verdict in
          <select
            className="h-8 rounded-md border border-border bg-card px-2 text-sm tabular-nums text-foreground"
            value={verdictDays}
            onChange={(event) => setVerdictDays(Number(event.target.value))}
          >
            {WATCH_VERDICT_DAYS.map((days) => (
              // A verdict shorter than the baseline would read a post window
              // that reaches back over the change, so it is not offered.
              <option key={days} value={days} disabled={days < baselineDays}>
                {days} days
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Smallest move that counts %
          <input
            type="number"
            min={1}
            max={100}
            step={1}
            className="h-8 w-20 rounded-md border border-border bg-card px-2 text-sm tabular-nums text-foreground"
            value={minDeltaPct}
            onChange={(event) => setDeltaEdit(Number(event.target.value))}
          />
        </label>
        <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs text-muted-foreground">
          Note
          <input
            type="text"
            className="h-8 rounded-md border border-border bg-card px-2 text-sm text-foreground"
            placeholder="July title batch"
            value={note}
            onChange={(event) => setNoteEdit(event.target.value)}
            maxLength={1000}
          />
        </label>
        <Button
          type="submit"
          variant="outline"
          size="sm"
          className="h-8"
          disabled={!canSave}
        >
          {saving ? "Registering…" : "Register"}
        </Button>
      </div>
      {/* The first thing standing in the way, if anything is: one short guard
          line, because the controls above already prevent what they can. */}
      {issues[0] ? (
        <p className="text-[11px] text-error" data-watch-refusal role="alert">
          {issues[0].message}
        </p>
      ) : null}
      <WatchPlan
        improvesWhen={series.improvesWhen}
        minDeltaPct={minDeltaPct}
        checkDates={watchCheckDates(today, verdictDays)}
      />
      <CalibrationLine
        state={calibrationState}
        basis={basis}
        minDeltaPct={minDeltaPct}
      />
      {scope ? (
        <div className="flex flex-wrap items-center gap-2 text-xs" data-watch-scope={scope.kind}>
          <StateChip
            className="min-w-0 max-w-full"
            tone={scope.kind === "query" ? "affirmative" : "caution"}
            glyph={<Target className="size-3" aria-hidden />}
            subject="watch:draft"
            label={
              <span className="truncate">
                {scope.kind === "query" ? `Only “${scope.query}”` : "Whole site"}
              </span>
            }
          />
          {scope.kind === "widened" ? (
            // The fix is a button, not an instruction: back to the Google
            // series that can follow this one query.
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() =>
                pickSeries(
                  seed?.series.integration === "gsc"
                    ? seed.series
                    : (WATCH_SERIES.find((option) => option.integration === "gsc") ?? series),
                )
              }
            >
              Follow “{scope.query}”
            </Button>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

function seriesOption(option: WatchSeries) {
  return (
    <option
      key={`${option.integration}:${option.metric}`}
      value={`${option.integration}:${option.metric}`}
    >
      {option.label}
    </option>
  );
}

/** A labelled figure in the composer's plan: a micro label over a number. */
function PlanFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-[10.5px] uppercase tracking-[0.04em] text-muted-foreground">
        {label}
      </span>
      <span className="font-medium tabular-nums text-foreground">{children}</span>
    </span>
  );
}

/**
 * The registration as a plan: what counts as a win and a loss, and when it is
 * read. The arrows carry the direction, so average position (better when it
 * falls) needs no parenthesis to say so; the series and the baseline dates are
 * the fields right above and are not repeated.
 */
function WatchPlan({
  improvesWhen,
  minDeltaPct,
  checkDates,
}: {
  improvesWhen: "up" | "down";
  minDeltaPct: number;
  checkDates: string[];
}) {
  const up = `▲ +${minDeltaPct}%`;
  const down = `▼ −${minDeltaPct}%`;
  const verdict = checkDates.at(-1);
  const interim = checkDates.slice(0, -1);
  return (
    <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-xs" data-watch-summary>
      <PlanFact label="Win">{improvesWhen === "up" ? up : down}</PlanFact>
      <PlanFact label="Loss">{improvesWhen === "up" ? down : up}</PlanFact>
      {interim.length > 0 ? (
        <PlanFact label="Checks">{interim.map(formatSeriesDate).join(" · ")}</PlanFact>
      ) : null}
      {verdict ? <PlanFact label="Verdict">{formatCalendarDate(verdict)}</PlanFact> : null}
    </div>
  );
}

type CalibrationState =
  | "custom"
  | "loading"
  | "unavailable"
  | "uncalibrated"
  | "historical"
  | "calibrated";

const CALIBRATION_CHIP: Record<
  Exclude<CalibrationState, "calibrated">,
  { label: string; tone: StateTone }
> = {
  custom: { label: "Your number", tone: "neutral" },
  loading: { label: "Checking query history", tone: "na" },
  unavailable: { label: "Query history unavailable", tone: "caution" },
  uncalibrated: { label: "Not calibrated", tone: "caution" },
  historical: { label: "Changes not excluded", tone: "caution" },
};

/**
 * Where the threshold came from, as a chip and a shape: the chip names the
 * basis; when there is a floor, a bar shows the asset's normal noise (nine in
 * ten historical moves stayed under it) against the threshold, amber once the
 * threshold sits inside it. With nothing to measure from, the chip says so and
 * the one fact beside it says why.
 */
function CalibrationLine({
  state,
  basis,
  minDeltaPct,
}: {
  state: CalibrationState;
  basis: WatchCalibrationBasis;
  minDeltaPct: number;
}) {
  const calibration = basis.kind === "none" ? null : basis.calibration;
  const chip =
    state === "calibrated"
      ? { label: basis.kind === "query" ? "Query calibrated" : "Calibrated", tone: "affirmative" as const }
      : CALIBRATION_CHIP[state];
  const measuring = state !== "loading" && state !== "unavailable";
  const inside = measuring && calibration !== null && calibration.floorPct >= minDeltaPct;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs"
      data-watch-calibration
      data-watch-calibration-state={state}
    >
      <StateChip
        label={chip.label}
        tone={chip.tone}
        glyph={state === "loading" ? <RefreshCw className="size-3 animate-spin" aria-hidden /> : undefined}
        subject="watch:draft"
      />
      {measuring && calibration ? (
        <span className="inline-flex items-center gap-2" data-watch-noise>
          <span className="text-muted-foreground">Noise</span>
          <Meter
            value={calibration.floorPct}
            max={minDeltaPct}
            className="w-20"
            ariaLabel={`Normal noise ${calibration.floorPct}% against a ${minDeltaPct}% threshold`}
          />
          <span className="tabular-nums text-foreground">{calibration.floorPct}%</span>
        </span>
      ) : null}
      {inside ? <StateChip label="Inside normal noise" tone="caution" subject="watch:draft" /> : null}
      {measuring
        ? calibrationFacts(basis).map((fact) => (
            <span key={fact} className="tabular-nums text-muted-foreground">
              {fact}
            </span>
          ))
        : null}
      {state === "custom" || calibration !== null ? null : (
        <span className="tabular-nums text-muted-foreground">
          Default {WATCH_DEFAULT_DELTA_PCT}%
        </span>
      )}
    </div>
  );
}

/** The evidence behind a basis, each a figure with its label. */
function calibrationFacts(basis: WatchCalibrationBasis): string[] {
  if (basis.kind === "none") {
    return [
      basis.gap === "short-history"
        ? "Too little history"
        : basis.gap === "no-query-archive"
          ? "No query history"
          : "Too few days with this query",
    ];
  }
  const calibration: WatchCalibration = basis.calibration;
  const archive =
    basis.kind === "query" && basis.history.archiveFirstDay && basis.history.archiveLastDay
      ? { first: basis.history.archiveFirstDay, last: basis.history.archiveLastDay }
      : { first: calibration.firstDay, last: calibration.lastDay };
  const facts = [
    `Typical move ${calibration.typicalPct}%`,
    `${formatInt(calibration.comparisons)} comparisons · ${formatCalendarRange(archive.first, archive.last)}`,
  ];
  if (basis.kind === "query") {
    facts.push(`${formatInt(basis.history.observedDays)} of ${formatInt(basis.history.archiveDays)} days carry this query`);
  }
  if (calibration.changeCalendarComplete && calibration.excludedComparisons > 0) {
    facts.push(
      `${formatInt(calibration.excludedComparisons)} skipped · ${formatInt(calibration.recordedChangeDays)} recorded ${calibration.recordedChangeDays === 1 ? "change" : "changes"}`,
    );
  }
  return facts;
}

/** The first series this asset actually reports, so the composer opens on a
 * check that can be answered. Every sum series stays selectable — the operator
 * may be registering against a lane they are about to connect — but the default
 * is never a number nobody is collecting. */
function defaultWatchSeries(lanes: AssetIntegrationLane[]): WatchSeries {
  const live = new Set(
    lanes
      .filter((lane) => lane.cell.effective === "live")
      .map((lane) => lane.catalog.id),
  );
  return (
    WATCH_SERIES.find((series) => live.has(series.integration)) ??
    WATCH_SERIES[0]!
  );
}

/** A timeline event as one option: when, what kind, and the operator's own
 * words for it. Same date and kind vocabulary the timeline below uses. */
function watchChangeLabel(item: AnnotationItem): string {
  const kind = ANNOTATION_KIND[item.kind].label;
  const what = item.note ?? item.ref ?? "";
  // `at` is an instant; the option names its calendar day.
  const head = `${formatCalendarDate(item.at.slice(0, 10))} · ${kind}`;
  return what.length > 0 ? `${head} — ${what}` : head;
}

/** What a watch measures: the series, and, when it is narrowed, the one query
 * or page, so a verdict about one query never reads as the whole site's. */
function watchSubject(
  watch: Pick<WatchSlice["open"][number], "metricIntegration" | "metric" | "scope">,
): ReactNode {
  const series = watchSeriesLabel(watch.metricIntegration, watch.metric);
  if (!watch.scope) return series;
  return (
    <>
      <span>{series}</span>
      <span className="min-w-0 break-all text-muted-foreground" data-watch-scope-subject>
        {watchScopeText(watch.scope)}
      </span>
    </>
  );
}

/**
 * The ref a watch was registered against: the task badge when it resolves, the
 * raw id when it does not (never both).
 */
function watchRef(
  watch: Pick<WatchSlice["open"][number], "ref" | "refKind">,
  byId: Map<string, HandoffBead>,
): ReactNode {
  const bead = byId.get(watch.ref);
  const unresolvedLabel =
    watch.refKind === "annotation"
      ? `event ${watch.ref}`
      : watch.refKind === "decision"
        ? `decision ${watch.ref}`
        : `ref ${watch.ref}`;
  return bead ? (
    <HandoffBeadBadge bead={bead} />
  ) : (
    <span
      className="break-all font-mono text-[11px] text-muted-foreground"
      data-watch-ref-unresolved
    >
      {unresolvedLabel}
    </span>
  );
}

/**
 * The pre-registered checks, with their progress and verdict drawn. A running
 * check's value is its progress, a segmented ring filled as each check is
 * read, beside the date it is waiting on; a read check's verdict is one chip
 * on the title. Tone is the verdict, not the status: an open check is muted.
 * It offers no control: a registered comparison is the one thing that must
 * survive learning the answer, and evaluation belongs to the nightly job.
 */
export function WatchesStrip({
  watches,
  beads,
}: {
  watches: WatchSlice;
  beads: HandoffBead[] | null;
}) {
  if (watches.open.length === 0 && watches.closed.length === 0) return null;
  const byId = new Map((beads ?? []).map((bead) => [bead.beadId, bead]));
  const open = watches.open.length;
  const closed = watches.closed.length;
  // The Overview's word for the same subject (watch window → Bets).
  const count = [
    open > 0 ? `${open} being watched` : null,
    closed > 0 ? `${closed} with a verdict` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <ListPanel title="Bets" count={count || undefined} limit={5}>
      {watches.open.map((watch) => (
        <ListRow
          key={watch.id}
          tone="info"
          glyph={<Timer className="size-2.5" />}
          title={
            <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
              {watchSubject(watch)}
            </span>
          }
          caption={watch.note ?? undefined}
          // Progress, then the date the row is waiting on. A window whose
          // checks are all read but which has not closed says so instead of
          // showing a date it no longer has.
          value={
            <span className="inline-flex items-center gap-2" data-watch-progress>
              <ProgressRing
                done={watch.readings}
                total={watch.checks}
                title={`${watch.readings} of ${watch.checks} checks read`}
              />
              {watch.nextCheckDate ? formatCalendarDate(watch.nextCheckDate) : "all read"}
            </span>
          }
          valueLabel={watch.nextCheckDate ? "next check" : "closing"}
        >
          <span className="flex flex-wrap items-center gap-2" data-watch-id={watch.id}>
            {watchRef(watch, byId)}
          </span>
        </ListRow>
      ))}
      {watches.closed.map((watch) => {
        const outcome = watch.outcome ? WATCH_OUTCOME[watch.outcome] : null;
        return (
          <ListRow
            key={watch.id}
            tone={outcome?.tone ?? "info"}
            glyph={<Check className="size-2.5" />}
            title={
              <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                {watchSubject(watch)}
                {outcome ? (
                  <StateChip
                    label={outcome.label}
                    tone={outcome.chip}
                    glyph={<span aria-hidden>{outcome.glyph}</span>}
                    subject={`watch:${watch.id}`}
                  />
                ) : null}
              </span>
            }
            caption={watch.note ?? undefined}
            value={watch.closedAt ? formatCalendarDate(watch.closedAt.slice(0, 10)) : "—"}
            valueLabel="read"
          >
            <span className="flex flex-wrap items-center gap-2" data-watch-id={watch.id}>
              {watchRef(watch, byId)}
            </span>
            {/* The evaluator's own figure for the verdict — the evidence behind
                the chip. */}
            {watch.outcomeNote ? <span className="tabular-nums">{watch.outcomeNote}</span> : null}
            {isTaskId(watch.readbackTaskId) ? (
              <Button asChild variant="ghost" className="h-11 justify-start">
                <Link to={`/tasks/${encodeURIComponent(watch.readbackTaskId)}`}>
                  Readback {watch.readbackTaskId}
                </Link>
              </Button>
            ) : null}
          </ListRow>
        );
      })}
    </ListPanel>
  );
}
