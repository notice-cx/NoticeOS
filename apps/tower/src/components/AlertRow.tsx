import { CircleCheck, Send, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { AlertHistoryAsset } from "@shared/alert-history";
import { alertOpenMs } from "@shared/alert-history";
import type { FlagRecord } from "@shared/asset-detail";
import type { AlertEvidence } from "@shared/alert-language";
import { translateAlert } from "@shared/alert-language";
import { siteAddress } from "@shared/first-run";
import { decisionNoteOnly, tunedSettingNote, wasTuned } from "@shared/tune";
import { ageMs, formatAge } from "@shared/freshness";
import type { AttentionItem } from "@shared/wall";
import { ChangeChip } from "@/components/ChangeChip";
import { EvidencePopover } from "@/components/EvidencePopover";
import { FlagActions } from "@/components/FlagActions";
import { AlertVerification, verificationEvidence } from "@/components/AlertVerification";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { SnoozeUntil } from "@/components/SnoozeUntil";
import { StateChip, type StatusSubject } from "@/components/StateChip";
import { ListRow, type ListRowTone } from "@/components/surface/ListPanel";
import { Badge } from "@/components/ui/badge";
import { watchOutcome } from "@/components/watch-outcome";
import { cn } from "@/lib/utils";

/** The `16× in 27d` chip: how often a condition has re-fired, over the span
 * since it first did. Rendered only when a row stands for more than one firing. */
export function Recurrence({
  item,
  nowMs,
}: {
  item: Pick<AttentionItem, "occurrences" | "firstFiredAt">;
  nowMs: number;
}) {
  if (item.occurrences <= 1) return null;
  return (
    <span
      className="shrink-0 rounded border border-warn/40 bg-warn/10 px-1.5 py-px text-xs font-semibold tabular-nums text-warn"
      title={`${item.occurrences} firings, first ${item.firstFiredAt}`}
    >
      {item.occurrences}× in {formatAge(ageMs(nowMs, item.firstFiredAt))}
    </span>
  );
}

/** The one all-clear line, so a page never invents its own wording for
 * "nothing is wrong". */
export function AttentionAllClear({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-xl border border-healthy/30 bg-healthy-soft text-sm",
        "px-4 py-3",
        className,
      )}
      aria-label="Attention status"
    >
      <CircleCheck className="size-4 shrink-0 text-healthy" aria-hidden />
      <span className="font-medium text-foreground">All clear</span>
      <span className="text-muted-foreground">
        No open warnings or errors.
      </span>
    </div>
  );
}

/**
 * One alert as a `ListRow`, on the asset page and on the portfolio's history.
 * A closed row is a scan line, an open one is what to do, and the Evidence
 * panel is why. It renders an `<li>`, so every caller wraps it in
 * {@link AlertList}.
 */
export interface AlertRowProps {
  flag: FlagRecord;
  nowMs: number;
  /** The id the change chip and the actions are scoped by. */
  assetId: string;
  /** Settled: no actions, the resolved mark, and the open-duration glyph. */
  history?: boolean;
  /** Parked: the muted mark, when it comes back, and Unsnooze. */
  snoozed?: boolean;
  /** Identity for a portfolio surface. Absent on the asset's own page. */
  asset?: AlertHistoryAsset | null;
  className?: string;
}

const DISPOSITION_LABEL: Record<string, string> = {
  ack: "Acknowledged",
  snooze: "Snoozed",
  tune: "Rule tuned",
  incident: "Incident opened",
  hypothesis: "Hypothesis spawned",
};

/**
 * The `<ul>` an alert row needs. Deliberately not `ListPanel`: these lists
 * already sit under a heading their own surface owns.
 */
export function AlertList({
  children,
  label,
  id,
  className,
}: {
  children: ReactNode;
  /** Names the list for a screen reader; the visible heading belongs to the
   * surface around it. */
  label: string;
  /** An anchor the page links to. */
  id?: string;
  className?: string;
}) {
  return (
    <ul
      id={id}
      aria-label={label}
      className={cn("m-0 flex list-none flex-col gap-0.5 p-0", className)}
      data-alert-list
    >
      {children}
    </ul>
  );
}

/** The ring carries how bad and the mark what kind, so neither is colour
 * alone. A settled row keeps the severity it had, because that is the axis
 * History is filtered on. */
function rowTone(flag: FlagRecord, snoozed: boolean): ListRowTone {
  // A parked row is not asking for anything, whatever its severity.
  if (snoozed) return "info";
  // A milestone is the one flag that is good news.
  return flag.kind === "milestone" ? "ok" : flag.severity;
}

function rowGlyph(flag: FlagRecord, history: boolean, snoozed: boolean): string {
  if (history) return "✓";
  if (snoozed) return "◦";
  return flag.kind === "milestone" ? "◦" : "△";
}

export function AlertRow({
  flag,
  nowMs,
  assetId,
  history = false,
  snoozed = false,
  asset = null,
  className,
}: AlertRowProps) {
  const alert = translateAlert(flag);
  // A tune does not settle the row, so the settled caption and open span are
  // not its record yet.
  const tunedAndOpen = !history && flag.disposition === "tune";
  const settled = !snoozed && Boolean(flag.disposition ?? flag.resolvedAt) && !tunedAndOpen;
  const openMs = alertOpenMs(flag);
  const owed = !snoozed && flag.liveness.state === "awaiting-decision";
  const recordedClosed = settled && flag.verification?.state === "recorded-closed";

  return (
    <ListRow
      className={className}
      tone={rowTone(flag, snoozed)}
      glyph={rowGlyph(flag, history, snoozed)}
      marks={{
        "data-flag-kind": flag.kind,
        "data-flag-severity": flag.severity,
        "data-visual-state": snoozed ? "snoozed" : flag.severity,
        ...(history || snoozed
          ? {}
          : {
              "data-material-condition": `open-flags${
                isRollbackFailure(flag) ? " rollback-failure" : ""
              }`,
            }),
      }}
      /* Inline content, not a flex row: `ListRow` truncates a closed row's
         title with `nowrap`, and a flex child inside that cannot break, so a
         long headline would run off a phone with no ellipsis. */
      title={
        <>
          {asset ? (
            <>
              <AssetName asset={asset} />{" "}
            </>
          ) : null}
          {alert.headline} <Recurrence item={flag} nowMs={nowMs} />
        </>
      }
      caption={<>
        {/* A settled row's caption is its disposition; "Recorded closed"
            beside it would say the same closure twice. It stays in the
            Evidence panel. */}
        {recordedClosed ? null : (
          <AlertVerification verification={flag.verification} firstDetectedAt={flag.firstFiredAt} nowMs={nowMs} interactive={false} />
        )}
        {!recordedClosed && (settled || owed || snoozed || alert.hint) ? " · " : null}
        {snoozed && flag.snoozeUntil ? (
          <SnoozeUntil until={flag.snoozeUntil} nowMs={nowMs} />
        ) : settled ? (
          <SettledCaption flag={flag} nowMs={nowMs} />
        ) : owed ? (
          <DecisionOwed liveness={flag.liveness} subject={`alert:${flag.id}`} />
        ) : (
          alert.hint
        )}
      </>}
      /* A settled row's value is its open span; an open row's is its age from
         onset, not from the latest re-reading. */
      value={
        history && openMs !== null ? (
          <OpenSpan flag={flag} />
        ) : (
          formatAge(ageMs(nowMs, flag.firstFiredAt))
        )
      }
      valueLabel={history ? (openMs !== null ? "open for" : "first seen") : "first seen"}
      // Snooze and Resolve sit on the row; Mark read and Tune wait in the
      // opened row, after the evidence.
      rowActions={history || snoozed ? undefined : <FlagActions flagId={flag.id} assetId={assetId} only={["snooze", "resolve"]} />}
      actions={
        history ? undefined : snoozed ? (
          <FlagActions flagId={flag.id} assetId={assetId} snoozed />
        ) : (
          <>
            <FlagActions
              flagId={flag.id}
              assetId={assetId}
              ruleId={flag.ruleId}
              metric={flag.metric}
              only={["acknowledge", "tune"]}
            />
            <TunedChip flag={flag} />
          </>
        )
      }
    >
      {/* The hint, when the caption was spent on something louder. */}
      {alert.hint && (settled || owed || snoozed) ? <span>{alert.hint}</span> : null}

      {/* One line of chips; the rule's numbers are one press away in the
          evidence panel. */}
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <EvidencePopover
          evidence={alertPopoverEvidence(alert, flag, nowMs)}
          question={ALERT_EVIDENCE_QUESTION}
          contextLabel={flag.ruleId}
          nowMs={nowMs}
          triggerLabel="Evidence"
        />
        <ChangeChip
          changes={flag.correlatedChanges}
          firedAt={flag.firstFiredAt}
          to={siteAddress(assetId, "#timeline")}
          interactive
        />
        {/* Most alerts are anomalies; only the other kinds name themselves. */}
        {flag.kind !== "anomaly" ? (
          <span className="capitalize" data-alert-kind={flag.kind}>{flag.kind}</span>
        ) : null}
        <NotifiedChip flag={flag} nowMs={nowMs} />
        {/* The caption says what was done with the firing; this says what was
            done to the rule. Not drawn when the caption already reads "Rule
            tuned", and not while the row is open, where it rides the actions. */}
        {(history || snoozed) && flag.disposition !== "tune" ? <TunedChip flag={flag} /> : null}
      </span>

      {settled ? <SettledDetail flag={flag} nowMs={nowMs} /> : null}
    </ListRow>
  );
}

/** The evidence panel's heading on every alert surface. */
export const ALERT_EVIDENCE_QUESTION = "Why this fired";

/**
 * The rows of an alert's evidence panel: the rule's own numbers, then the
 * checks behind the verification. The stored message joins only when the
 * translator had no numbers to show and the headline does not already contain
 * it. Exported because `/alerts` opens its rows onto the same panel.
 */
export function alertPopoverEvidence(
  alert: { headline: string; evidence: AlertEvidence[] },
  facts: {
    message: string | null;
    firstFiredAt: string;
    verification?: FlagRecord["verification"];
  },
  nowMs: number,
): AlertEvidence[] {
  const rows: AlertEvidence[] = [
    ...alert.evidence,
    ...verificationEvidence(facts.verification, facts.firstFiredAt, nowMs),
  ];
  const message = facts.message?.trim();
  if (alert.evidence.length === 0 && message && !alert.headline.includes(message)) {
    rows.push({ polarity: "supporting", source: "Stored message", detail: message, at: null });
  }
  return rows;
}

/** What was decided. A snooze states itself as the chip in the expanded row,
 * so it carries no badge here. */
function SettledCaption({ flag, nowMs }: { flag: FlagRecord; nowMs: number }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      {flag.disposition && flag.disposition !== "snooze" ? (
        <Badge variant="secondary">
          {DISPOSITION_LABEL[flag.disposition] ?? flag.disposition}
        </Badge>
      ) : null}
      {flag.resolvedAt ? (
        <span className="tabular-nums">
          resolved {formatAge(ageMs(nowMs, flag.resolvedAt))} ago
        </span>
      ) : null}
    </span>
  );
}

/** The rest of a settled row's record: the note, when an acknowledgement
 * lapses, and where a snooze runs to. */
function SettledDetail({ flag, nowMs }: { flag: FlagRecord; nowMs: number }) {
  const note = decisionNoteOnly(flag.dispositionNote);
  const snoozeUntil = flag.resolvedAt ? null : flag.snoozeUntil;
  if (!note && !flag.ackExpiry && !snoozeUntil) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {note ? <span>&ldquo;{note}&rdquo;</span> : null}
      {flag.ackExpiry ? (
        <span className="tabular-nums">
          expires {new Date(flag.ackExpiry).toISOString().slice(0, 10)}
        </span>
      ) : null}
      {snoozeUntil ? <SnoozeUntil until={snoozeUntil} nowMs={nowMs} /> : null}
    </span>
  );
}

/** The operator has already been told about this one. Evidence, not intent:
 * the record is written only when a message actually landed. */
function NotifiedChip({ flag, nowMs }: { flag: FlagRecord; nowMs: number }) {
  if (!flag.notifiedAt) return null;
  return (
    <span
      className="inline-flex items-center gap-1 tabular-nums"
      data-notified-at={flag.notifiedAt}
      title={`Sent to your notification channel at ${new Date(flag.notifiedAt).toISOString()}`}
    >
      <Send className="size-3" aria-hidden />
      notified {formatAge(ageMs(nowMs, flag.notifiedAt))} ago
    </span>
  );
}

/** This row's rule has been tuned. A tune does not settle the alert, so it is
 * told among the actions. `disposition` holds one slot, so the tune is carried
 * in the note and `wasTuned` is the one predicate that reads it. */
function TunedChip({ flag }: { flag: FlagRecord }) {
  if (!wasTuned(flag)) return null;
  const setting = tunedSettingNote(flag);
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-px text-xs text-muted-foreground"
      data-alert-tuned
      title={setting ? `Rule tuned: ${setting}` : "Rule tuned"}
    >
      <SlidersHorizontal className="size-3" aria-hidden />
      tuned
    </span>
  );
}

/** Which asset, on a surface that holds several. */
function AssetName({ asset }: { asset: AlertHistoryAsset }) {
  return (
    <Link
      to={siteAddress(asset.id, "/alerts")}
      // The row it sits in is a button; the press must not open the row too.
      onClick={(event) => event.stopPropagation()}
      className="inline-flex shrink-0 items-center gap-1.5 rounded px-0.5 font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-alert-asset={asset.id}
    >
      <PropertyFavicon
        domain={asset.domain ?? asset.id}
        displayName={asset.displayName}
        className="size-4"
      />
      {asset.displayName}
    </Link>
  );
}

const SPAN_MAX_PX = 44;
const SPAN_MIN_PX = 10;
const HOUR_MS = 3_600_000;
/** The span the rule's full width means; anything longer pins there. */
const SPAN_CEILING_MS = 30 * 24 * HOUR_MS;

/** How long this alert was open, as a rule whose length is the duration on a
 * log scale from an hour to a month. Neutral ink: severity owns the row's
 * colour. Renders nothing when there is no closing time to measure to. */
function OpenSpan({ flag }: { flag: FlagRecord }) {
  const openMs = alertOpenMs(flag);
  if (openMs === null) return null;
  const fraction =
    openMs <= HOUR_MS
      ? 0
      : Math.min(
          1,
          Math.log(openMs / HOUR_MS) / Math.log(SPAN_CEILING_MS / HOUR_MS),
        );
  const width = SPAN_MIN_PX + fraction * (SPAN_MAX_PX - SPAN_MIN_PX);
  const label = formatAge(openMs);
  return (
    <span
      className="inline-flex items-center gap-1.5 tabular-nums font-normal text-muted-foreground"
      data-alert-open-span={label}
      title={`Open for ${label} — from ${new Date(flag.firstFiredAt).toISOString()} to ${new Date(
        flag.resolvedAt ?? flag.dispositionAt ?? flag.firstFiredAt,
      ).toISOString()}.`}
    >
      <span
        role="img"
        aria-label={`Open for ${label}`}
        className="inline-flex items-center"
      >
        <span className="size-1.5 rounded-full bg-muted-foreground/70" />
        <span
          className="h-px bg-muted-foreground/40"
          style={{ width: `${Math.round(width)}px` }}
        />
        <span className="size-1.5 rounded-full border border-muted-foreground/70" />
      </span>
      {label}
    </span>
  );
}

/**
 * A row from a watch window that has already closed and recorded its verdict
 * is not a live signal: it states the verdict and where the decision lives,
 * or says that no decision is recorded, so Resolve never implies one was.
 */
function DecisionOwed({ liveness, subject }: { liveness: FlagRecord["liveness"]; subject: StatusSubject }) {
  if (liveness.state !== "awaiting-decision") return null;
  // The checks list's own words and glyph, never the stored enum.
  const outcome = watchOutcome(liveness.verdict);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1" data-decision-owed>
      {outcome ? (
        <StateChip
          label={outcome.label}
          tone={outcome.chip}
          glyph={<span aria-hidden>{outcome.glyph}</span>}
          subject={subject}
        />
      ) : (
        <StateChip label="Verdict recorded" tone="na" subject={subject} />
      )}
      {liveness.decisionHome ? (
        <StateChip label={`decision: ${liveness.decisionHome}`} tone="neutral" subject={subject} />
      ) : (
        <StateChip label="no decision recorded" tone="caution" attention subject={subject} />
      )}
    </span>
  );
}

function isRollbackFailure(flag: FlagRecord): boolean {
  return (
    flag.ruleId === "watch-window-closed" &&
    flag.ruleInputs?.outcome === "kill_confirmed"
  );
}

export default AlertRow;
