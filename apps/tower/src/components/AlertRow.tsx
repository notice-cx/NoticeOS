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

/**
 * How long a condition has been running, and how often it has re-fired
 * (`ro-kukv.1`) — the `16× in 27d` chip.
 *
 * Rendered ONLY when a row stands for more than one firing, so an ordinary
 * event carries no extra ink. The count is the glyph, not a word: `16×` is a
 * shape you can scan a column for. A DURATION, never an age: the count spans a
 * period, it did not happen at one. It takes the two fields it reads, so an
 * asset page's `FlagRecord` and /alerts' `AttentionItem` wear one shape. It
 * moved here, where every alert row lives, when the desk table it was born in
 * left the Tower (bead `ro-trai.25`).
 */
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

/**
 * The one all-clear line (bead `ro-pbzu.3`) — a calm state rather than an
 * empty card, so a page never invents its own wording for "nothing is wrong".
 * Beside the alert rows since bead `ro-trai.25`.
 */
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
 * ONE ALERT, as doc 14's row — the asset page's Current signals and Alert
 * history, and `/alerts/history` across the portfolio (beads `ro-ju7f`,
 * `ro-78qo.17`).
 *
 * It was a route-local `FlagRow` inside `asset-detail/CurrentState.tsx` until a
 * second surface needed it. That is the registry's own rule stated in code: a
 * fact rendered on two surfaces is a component, and the second surface is where
 * you find out. Copying it would have been how a settled alert came to say one
 * thing on its asset's page and another on the portfolio's history — the
 * translated headline, the evidence popover, the recurrence chip, the change
 * chip and the disposition footer are five separate vocabularies to keep in
 * step by hand.
 *
 * IT IS A `ListRow` NOW (2026-09-05, bead `ro-78qo.17`). It used to draw a
 * bordered card with everything on it at once: headline, kind, age, notified
 * mark, three action buttons and a settled footer, all visible on every row of
 * every list. `/alerts` was rebuilt to doc 14's one-line row (`ro-78qo.7`) and
 * this was the other half of the same fact wearing the other shape — two
 * layouts for one alert, which is the doc 14 failure doc 14 exists to end.
 *
 * So the row is now: a severity ring and a mark, the headline (with the asset
 * on a portfolio surface), one caption line, and the age or the open span at
 * the end. Everything the card used to print by default is one or two presses
 * away: opening the row reveals the correlated change, the note and the verbs
 * IN PLACE, and its Evidence chip opens the rule's numbers, the checks behind
 * the verification, the kind, the stored message and the rule id (bead
 * `ro-ujb9.96.6.7`). Nothing was removed; a closed row is a scan line, an open
 * one is what to do, and the panel is why.
 *
 * IT RENDERS AN `<li>`, because `ListRow` does. Every caller therefore wraps it
 * in {@link AlertList} rather than in a bare `<div>` — one place holds the list
 * chrome, so three surfaces cannot land on three gaps.
 *
 * THREE MODES, one difference each:
 *
 * - `history` — the alert is SETTLED. It loses the Mark read / Resolve pair,
 *   because there is nothing left to act on; its mark becomes the `✓` doc 14
 *   gives a finished thing; its caption states the disposition; and its value
 *   becomes the open-span glyph below.
 * - `snoozed` — the alert is PARKED (bead `ro-ujb9.194`): not settled, and back
 *   on its date. The muted `◦` `/alerts`' Snoozed panel gives it, the date it
 *   comes back as its caption, and Unsnooze as its one action.
 * - `asset` — a PORTFOLIO surface names which asset this happened to, with the
 *   favicon and a link into that asset's Alerts tab. The asset page passes
 *   nothing: naming the asset on its own page would be the same fact twice.
 */
export interface AlertRowProps {
  flag: FlagRecord;
  nowMs: number;
  /** The asset this alert belongs to — the id the change chip and the actions
   * are scoped by. */
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
 * The `<ul>` an alert row needs, with the list chrome `ListPanel` would give it.
 *
 * `ListRow` renders an `<li>`, so a caller that dropped one into a `<div>` would
 * be handing the browser a stray list item — a bullet on some surfaces, and a
 * list a screen reader cannot count on any. This is that `<ul>`, exported beside
 * the row rather than restated at each of the three call sites, and it is
 * deliberately NOT `ListPanel`: these lists already sit under a heading their
 * own surface owns (the asset page's section card, `/alerts/history`'s tabs), so
 * a second eyebrow and a second count would be doc 14's duplication rather than
 * doc 14's panel.
 */
export function AlertList({
  children,
  label,
  id,
  className,
}: {
  children: ReactNode;
  /** Names the list for a screen reader, since the visible heading belongs to
   * the surface around it rather than to this element. */
  label: string;
  /** An anchor the page links to — the asset page's `#alert-history`. */
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

/**
 * The row's tone and mark.
 *
 * The ring carries HOW BAD and the mark carries WHAT KIND, so neither is colour
 * alone (doc 14). A settled row keeps the severity it had — "how bad was it" is
 * the axis History is filtered on, and painting every closed row green would
 * throw that away — and takes doc 14's `✓` to say it is finished. A milestone is
 * an event rather than a condition: info severity, and the quiet `◦` doc 14
 * gives a discovery.
 */
function rowTone(flag: FlagRecord, snoozed: boolean): ListRowTone {
  // A parked row is not asking for anything, so it wears the muted mark
  // whatever its severity — the same call `/alerts`' Snoozed panel makes.
  if (snoozed) return "info";
  // A milestone is the one flag that is GOOD NEWS, so it takes the health green
  // `ok` rather than the muted info ink — the same call the asset tab's row made
  // before the two were folded (`ro-78qo.5`), and the reason `ro-w13s` insisted
  // a parked milestone keep an accent of its own.
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
  // A tune does not settle the row (bead `ro-van6`), so the settled treatment
  // below — the disposition caption and the open-span glyph — is not this row's
  // record yet: the span would measure a row that is still open, and the
  // caption would say beside the actions what the chip among them already says.
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
      /* THE MATERIALITY MARKS ARE THE ROW'S, and they sit on the row (bead
         `ro-78qo.40`). They rode the title span for one commit, because
         `ListRow` forwarded only `className` and a mark describing the whole row
         had nowhere else to go; `marks` is the passthrough that put them back,
         so the subtree each one claims is the subtree it means. */
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
      /* NOT A FLEX ROW. `ListRow` truncates a closed row's title, which sets
         `nowrap` on the line — and a flex child inside that cannot break, so a
         long headline runs off the edge of a phone with no ellipsis to say it
         had (bead `ro-78qo.7` hit exactly this on `/alerts`). Inline content
         lets the ellipsis do its job, and an open row drops the truncation and
         wraps the whole line. */
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
        {/* ONE STATUS PER SUBJECT (bead `ro-ujb9.96.6.7`). A settled row's
            caption is its disposition ("Acknowledged · resolved 5d ago");
            "Recorded closed" beside it said the same closure a second time. It
            stays in the Evidence panel, with "recovery not checked". */}
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
      /* WHICH OF THESE DRAGGED ON. "fired 9d ago" and "resolved 2d ago" are both
         recencies; the question an operator brings to a list of closed alerts is
         a DURATION, so a settled row spends its value slot on the span. An open
         row spends it on the age, aged from the ONSET like every other age on
         this desk — a condition is as old as it has been true, not as old as
         tonight's re-reading. */
      value={
        history && openMs !== null ? (
          <OpenSpan flag={flag} />
        ) : (
          formatAge(ageMs(nowMs, flag.firstFiredAt))
        )
      }
      valueLabel={history ? (openMs !== null ? "open for" : "first seen") : "first seen"}
      // VERBS IN THE ROW (D45): an open alert's Snooze and Resolve are on the
      // row; Mark read and Tune wait in the opened row, after the evidence.
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

      {/* ONE LINE OF CHIPS, AND THE NUMBERS ONE PRESS AWAY (bead
          `ro-ujb9.96.6.7`). An opened row used to print the rule's stored
          message, the kind and "fired 2d ago", the rule id, three labelled
          statistics rows and a second copy of the caption's verification — the
          statistics were the loudest thing on the line, under a headline that
          had already said what happened. The operator's rule is that an alert
          leads with what happened and what to do, and its statistics sit in the
          evidence panel: so the panel holds the rule's numbers, the checks
          behind "Confirmed"/"Last known", the stored message and the rule id,
          and the row keeps the chips that answer "what else was going on". */}
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
        {/* Most alerts are anomalies; the kind is named only when it is the
            other kind — a good-news milestone or an opportunity — so the one
            row that differs is the one that says so. */}
        {flag.kind !== "anomaly" ? (
          <span className="capitalize" data-alert-kind={flag.kind}>{flag.kind}</span>
        ) : null}
        <NotifiedChip flag={flag} nowMs={nowMs} />
        {/* A row that was tuned and then answered another way keeps the chip
            (bead `ro-bkcl`): the caption says what the operator did with the
            FIRING, this says what they did to the RULE. Not drawn for
            `disposition='tune'`, whose caption already reads "Rule tuned", and
            not here while the row is open — there it rides the actions, where
            the decision is being made. */}
        {(history || snoozed) && flag.disposition !== "tune" ? <TunedChip flag={flag} /> : null}
      </span>

      {settled ? <SettledDetail flag={flag} nowMs={nowMs} /> : null}
    </ListRow>
  );
}

/** The evidence panel's heading on every alert surface — one question, asked
 * the same way on `/alerts`, the asset's Alerts tab and the attention band. */
export const ALERT_EVIDENCE_QUESTION = "Why this fired";

/**
 * EVERYTHING CHECKABLE ABOUT ONE ALERT, as the rows of its evidence panel
 * (bead `ro-ujb9.96.6.7`): the rule's own numbers first, then the checks behind
 * the caption's "Confirmed"/"Last known". The panel's heading carries the rule
 * id.
 *
 * The rule's stored message joins only when the translator had no numbers of
 * its own to show: a translated rule's rows ARE its `rule_inputs`, the figures
 * the stored sentence was written from, and quoting that sentence under them
 * would be every number twice. A message the headline already contains is not
 * quoted either (doc 14, one representation per fact).
 *
 * Exported because `/alerts` opens its rows onto the same panel; two builders
 * would be two answers to "why this fired".
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

/**
 * WHAT WAS DECIDED, on the one line a closed row has for it.
 *
 * One representation per fact (doc 14, bead `ro-c7qq`): a snooze already states
 * itself as the chip in the expanded row — with the date and the time left — so
 * a badge here would repeat the weaker half of it. Every other disposition is
 * permanent and has no date, so it keeps the badge it always had.
 */
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

/** The rest of a settled row's record: what the operator wrote, when an
 * acknowledgement lapses, and where a snooze runs to. Evidence rather than
 * headline, so it lives in the expansion (docs/17 rule 4). */
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

/**
 * THE OPERATOR HAS ALREADY BEEN TOLD ABOUT THIS ONE (bead `ro-vu8d.23`).
 *
 * The OS sends a message for a new open error alert, and until this the only
 * record of having done so was a row in a table. On the row itself it answers a
 * question the operator brings to every alert list: *did I already know about
 * this, or is the desk the first place it has appeared?* An alert with no mark
 * is one they were never interrupted for — either because it did not qualify
 * (a warning; the OS does not send those), or because the channel is not
 * connected.
 *
 * IT IS EVIDENCE, NOT INTENT. The record is written only when a message
 * actually landed, so the mark cannot appear over a delivery that failed.
 *
 * A glyph and a time, in the same muted ink as the age beside it, and no tone
 * token: being notified is not a severity and not a disposition — it is one more
 * dated fact about this row, and it sits among the other dated facts.
 */
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

/**
 * THIS ROW'S RULE HAS BEEN TUNED (bead `ro-van6`).
 *
 * The sixth disposition is the only one that does not settle the alert — the
 * drop that fired is still there and still unanswered; what changed is what
 * would produce it next time — so it cannot be told in the settled caption with
 * the others. It is told among the ACTIONS instead, where the operator is
 * deciding what to do with this row, and it answers the question that decision
 * needs: has somebody already been here?
 *
 * A glyph and its own words, not a color: a tuned alert is not more or less
 * urgent than an untuned one, and severity owns the row's only color (doc 14).
 * The same `SlidersHorizontal` the Tune trigger wears, because it is the same
 * concept, and the setting that moved rides in the hover — evidence, never a
 * headline (docs/17 rule 4).
 *
 * IT SURVIVES THE NEXT DECISION (bead `ro-bkcl`). `disposition` holds one slot,
 * so Mark read and Snooze used to overwrite the tune and take this chip with
 * it — the alert then said nothing about the rule change the operator had
 * already made. The tune is now carried in the note, `wasTuned` is the one
 * predicate that reads it (`shared/tune.ts`, and its SQL half feeds the
 * false-positive rate), and the chip appears wherever the row was ever tuned:
 * among the actions while it is open, among the dated facts once it is not.
 */
function TunedChip({ flag }: { flag: FlagRecord }) {
  if (!wasTuned(flag)) return null;
  const setting = tunedSettingNote(flag);
  // The hover names the setting and its two values — the fact. Where the row
  // sits (still in the queue, or settled some other way) is already shown by
  // the list it is in, so it is not said again here.
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

/** WHICH ASSET, on a surface that holds several — the favicon the asset page's
 * own heading wears, and the link into that asset's Alerts tab, so a row in the
 * portfolio's history is one click from the rest of that asset's alerts. */
function AssetName({ asset }: { asset: AlertHistoryAsset }) {
  return (
    <Link
      to={siteAddress(asset.id, "/alerts")}
      // The row it sits in is a button, so this link stops the press from
      // reaching it: following the asset and opening the row in place are two
      // different intentions and the same click cannot serve both.
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

/** The widest the span rule is drawn, in pixels. */
const SPAN_MAX_PX = 44;
const SPAN_MIN_PX = 10;
const HOUR_MS = 3_600_000;
/** The span the rule's full width means: a month open is the long end of what
 * this store holds, and anything longer pins there rather than off the row. */
const SPAN_CEILING_MS = 30 * 24 * HOUR_MS;

/**
 * HOW LONG THIS ALERT WAS OPEN — the fact its two dates do not state.
 *
 * "fired 9d ago" and "resolved 2d ago" are both recencies. Reading a list of
 * settled alerts, the operator's question is which of these dragged on, and
 * that is a duration; deriving it from two relative ages in your head, per row,
 * is exactly the arithmetic doc 14's 2026-09-04 rule says a shape should do
 * instead. So the rule's LENGTH is the duration, on a log scale from an hour to
 * a month, and the eye ranks the rows before it reads one.
 *
 * Neutral ink on purpose: severity already owns the row's only color, and a
 * long-running warning is not a more severe warning. Absent — rendering
 * nothing — when the row carries no closing time to measure to, because an
 * unmeasurable span is not a zero-length one.
 */
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
 * What a decision-owed row says instead of pretending to be a live signal
 * (`ro-wlq5`).
 *
 * These come from a watch window that has ALREADY CLOSED and recorded its
 * verdict — the evaluation is finished. Rendered like every other alert they
 * read as "something is happening now", and the operator had four of them
 * sitting for nine days with no way to tell whether the decision had been made.
 *
 * So the row states the verdict the window reached and, more importantly, WHERE
 * THE DECISION LIVES. On every window in the store today that is nowhere:
 * db/0024 added `readback_bead` for exactly this and nothing populates it. A
 * surface that stayed quiet about that would leave a Resolve button implying a
 * decision was captured when the store holds none.
 *
 * It takes the row's one caption line rather than riding below the headline,
 * because a row that owes a decision is not an ordinary open alert and the
 * caption is the loudest thing under the title.
 */
function DecisionOwed({ liveness, subject }: { liveness: FlagRecord["liveness"]; subject: StatusSubject }) {
  if (liveness.state !== "awaiting-decision") return null;
  // The verdict in the checks list's own words and glyph, never the stored
  // enum (bead `ro-ujb9.96.6.14`): one verdict, one chip, on both surfaces.
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
