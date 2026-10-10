import { useDemoReadonly } from '@/lib/browser-context';
import { useOwnerToast } from '@/lib/browser-context';
import type { AssetDetailFor } from "@shared/asset-detail-views";
import {
  Ban,
  Check,
  Inbox,
  MailOpen,
  MousePointerClick,
  Reply,
  Send,
  Unlink,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type {
  AnnotationKind,
  AssetDetailPayload,
  HandoffBead,
  ReclamationSlice,
  ReclamationStatus,
} from "@shared/asset-detail";
import { lifecycleMoveSentence, parseLifecycleMoveRef } from "@shared/asset-detail";
import { ANNOTATION_NOTE_MAX } from "@shared/annotations";
import { ageMs, formatAge } from "@shared/freshness";
import { type WatchSeed } from "@shared/watch-windows";
import { HandoffBeadBadge } from "@/components/HandoffBeadBadge";
import { PanelReviewLine } from "@/components/PanelReviewLine";
import { ANNOTATION_KIND } from "@/components/annotation-kind";
import { useAnnotationWriter } from "@/hooks/useAnnotationWriter";
import { ListPanel, ListRow, type ListRowTone } from "@/components/surface/ListPanel";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { pillChoiceClass, pillChoiceStateClass } from "@/components/ui/pill";
import { toLocalDateTimeInput } from "@/lib/countdown";
import { formatCalendarDate, formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Hero, Panel, betsFact } from "@/routes/asset-detail/shared";
import { PageAnswer } from "@/components/surface/PageAnswer";
import { WatchComposer, WatchesStrip } from "@/routes/asset-detail/WatchComposer";

/**
 * The Activity tab: what has already happened to this asset. The timeline is
 * the hero. The composers are behind the header action: one "Record →" opens
 * one composer, and the choice of which is inside it, so only one form is
 * ever open.
 */
export function ActivityTab({
  data,
  nowMs,
  seed,
  onSeedDone,
}: {
  data: AssetDetailFor<"activity">;
  nowMs: number;
  seed: WatchSeed | null;
  onSeedDone: () => void;
}) {
  return (
    <div className="flex flex-col gap-3.5">
      <TimelineSection data={data} nowMs={nowMs} seed={seed} onSeedDone={onSeedDone} />
      {/* The weekly panel review's obligation: an overdue badge on the Wall
          means "open this page and act", and the page must name what is owed.
          It sits under the timeline it is a review of, renders nothing for an
          asset with no collection in the window, and only the overdue row
          leaves the quiet surface. */}
      <PanelReviewLine
        review={data.panelReview}
        latestPanelDate={data.latestPanelDate}
        nowMs={nowMs}
        className="px-1"
      />
      <ReclamationSection reclamation={data.reclamation} />
      {/* No "about this history": the timeline's own Record action says it is
          written by hand, a watch's progress and verdict are drawn on its row,
          and link outreach offers no control. */}
    </div>
  );
}

// --- timeline: what changed, and what is being watched because of it -------
/**
 * `seed` is a check somewhere else on the page asking to open: a query row, a
 * finding card. It opens the same composer in the same place, because a watch
 * belongs to the asset's timeline and is reported by the strip below. The page
 * scrolls the form into view, since an action whose whole effect happens
 * off-screen reads as an action that did nothing.
 */
function TimelineSection({
  data,
  nowMs,
  seed,
  onSeedDone,
}: {
  data: AssetDetailFor<"activity">;
  nowMs: number;
  seed: WatchSeed | null;
  onSeedDone: () => void;
}) {
  const demoReadonly = useDemoReadonly();
  // ONE composer at a time. Recording what happened and pre-registering how it
  // will be judged are two different sentences, and two open forms on one
  // section is two half-finished thoughts.
  const [composing, setComposing] = useState<null | "event" | "watch">(null);
  const writable = !demoReadonly;
  const anchor = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!seed || !writable) return;
    setComposing("watch");
    anchor.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, [seed, writable]);

  /** Closing the composer clears the seed too, so the next click from a row
   * counts as a new request rather than being swallowed as "already open". */
  function close() {
    setComposing(null);
    onSeedDone();
  }

  const items = data.annotations.items;
  const watching = data.watches.open.length;
  const counted = [
    items.length > 0 ? `${items.length} logged` : null,
    data.annotations.olderCount > 0 ? `${data.annotations.olderCount} older` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  // One answer first: when this site last changed, and its bets in the
  // Overview's own words (`betsFact`).
  const lastChange = data.freshness.annotationAt ? ageMs(nowMs, data.freshness.annotationAt) : null;
  // The age of the newest recorded change rides in the header beside the
  // count, including the word it prints when nothing has ever been recorded,
  // because an em dash there reads as a rendering failure rather than "never".
  const count = counted || undefined;

  return (
    <>
      <PageAnswer
        answer={lastChange !== null ? `Last change ${formatAge(lastChange)} ago` : data.freshness.annotationAt ? "Last change date unreadable" : "No changes logged yet"}
        detail={watching > 0 ? betsFact(data.watches, nowMs) : undefined}
        marks={{ "data-activity-answer": lastChange !== null ? "logged" : data.freshness.annotationAt ? "unreadable" : "none" }}
      />
      <div ref={anchor} />
      {composing && writable ? (
        <Panel
          title="Record"
          action={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={close}
            >
              Cancel
            </Button>
          }
        >
          {/* WHICH composer is a choice INSIDE the one open form, not two
              buttons on the page. Both write to the same timeline and only one
              may be open, so they are two answers to one question. */}
          <div className="mb-3 flex flex-wrap gap-1.5">
            <button
              type="button"
              className={cn(pillChoiceClass, pillChoiceStateClass(composing === "event"))}
              aria-pressed={composing === "event"}
              onClick={() => setComposing("event")}
            >
              Something happened
            </button>
            <button
              type="button"
              className={cn(pillChoiceClass, pillChoiceStateClass(composing === "watch"))}
              aria-pressed={composing === "watch"}
              onClick={() => setComposing("watch")}
            >
              Watch an outcome
            </button>
          </div>
          {composing === "event" ? (
            <AnnotationComposer
              assetId={data.asset.id}
              beads={data.handoffBeads}
              onDone={() => setComposing(null)}
            />
          ) : (
            <WatchComposer
              // A second click from a different row is a different question, so
              // it gets a fresh form rather than a stale one with one field
              // changed.
              key={
                seed
                  ? `${seed.subject}:${seed.series.integration}:${seed.series.metric}`
                  : "timeline"
              }
              assetId={data.asset.id}
              changes={data.annotations.items}
              lanes={data.integrations.lanes}
              history={data.watches.history}
              seed={seed}
              nowMs={nowMs}
              onDone={close}
            />
          )}
        </Panel>
      ) : null}

      {/* `#timeline` is a live deep link: an alert's change chip points at it,
          and `HASH_TAB` brings the page to this tab to land on it. */}
      <Hero id="timeline">
        <ListPanel
          title="Timeline"
          count={count}
          action={writable ? { label: "Log a change", onClick: () => setComposing("event") } : undefined}
          limit={3}
          // The answer above already says there are none; the panel says
          // what comes next.
          empty="Log the first change to see it here"
        >
          {items.map((item) => (
            <TimelineRow
              key={item.id}
              item={item}
              beads={data.handoffBeads}
              nowMs={nowMs}
            />
          ))}
          {/* The end of the read, said out loud. A history that simply stops
              reads as a history that ends — so the cut names its own size and
              says the rows are still in the store. */}
          {data.annotations.olderCount > 0 ? (
            <ListRow
              tone="info"
              glyph="…"
              title={`${data.annotations.olderCount} older ${
                data.annotations.olderCount === 1 ? "change" : "changes"
              } not shown`}
            />
          ) : null}
        </ListPanel>
      </Hero>

      {/* The strip is its own `ListPanel`, so it needs no `Panel` around it to
          carry a heading. */}
      <WatchesStrip watches={data.watches} beads={data.handoffBeads} />
    </>
  );
}

/** The four tones a change wears. An incident is the one kind of recorded event
 * that is bad news, so it is the one that is not muted; everything else is
 * history, not attention. */
const KIND_TONE: Partial<Record<AnnotationKind, ListRowTone>> = {
  incident: "error",
};

/** One recorded change, as a row. The glyph is the kind's own
 * (`ANNOTATION_KIND`, the same table the alert surfaces' change chip reads),
 * inside `ListRow`'s tone ring. */
function TimelineRow({
  item,
  beads,
  nowMs,
}: {
  item: AssetDetailPayload["annotations"]["items"][number];
  beads: HandoffBead[] | null;
  nowMs: number;
}) {
  const meta = ANNOTATION_KIND[item.kind];
  const Icon = meta.icon;
  // A lifecycle move stores the two stages in its `ref`, because that is the
  // row's identity and the field Restore reads. The ref is machine text, so
  // the row renders the sentence instead of it.
  const move = parseLifecycleMoveRef(item.ref);
  const task = item.ref ? (beads ?? []).find((b) => b.beadId === item.ref) : undefined;
  // A move with no note IS the row's headline (below), so it is not repeated
  // as the row's evidence — and its machine ref is never shown.
  const evidence = (item.note ? move : null) ?? task ?? (move ? null : item.ref);
  // The row says the headline; the rest is inside it. The first sentence of a
  // note is the change; everything after it is the operator's reasoning. A
  // lifecycle move carries no note, and its sentence is what happened, so it
  // is the headline.
  const headline = item.note
    ? firstSentence(item.note)
    : move
      ? lifecycleMoveSentence(move)
      : meta.label;
  const rest =
    item.note && item.note.length > headline.length
      ? item.note.slice(headline.length).trim()
      : null;
  return (
    <ListRow
      tone={KIND_TONE[item.kind] ?? "info"}
      glyph={<Icon className="size-2.5" />}
      title={headline}
      caption={item.note || move ? meta.label : undefined}
      value={formatAge(ageMs(nowMs, item.at))}
      valueLabel="ago"
    >
      {rest ? <p className="m-0 max-w-[68ch]">{rest}</p> : null}
      {/* One representation of the ref: a resolved task is the ref rendered
          richer, never a second marker beside a mono string. A closed task
          here is still not a measured outcome: the verdict comes from a watch
          window carrying the same id. */}
      {evidence ? (
        <span className="flex flex-wrap items-center gap-2">
          {move && item.note ? (
            <span className="text-foreground">{lifecycleMoveSentence(move)}</span>
          ) : task ? (
            <HandoffBeadBadge bead={task} />
          ) : (
            <span className="break-all font-mono">{item.ref}</span>
          )}
        </span>
      ) : null}
      <span className="tabular-nums">{new Date(item.at).toISOString()}</span>
    </ListRow>
  );
}

/**
 * The first sentence of a recorded note, for the row's title.
 *
 * A counter, not a parser, and tuned for the same two false positives the
 * surface audit's own `sentenceCount` is: a decimal (`±5%`, `2.5 days`) and an
 * abbreviation are not sentence ends, so a terminator only counts when a SPACE
 * and a capital follow it. A note with no terminator at all is one sentence and
 * comes back whole, which is what most of them are.
 */
function firstSentence(note: string): string {
  const match = /[.!?](\s+[A-Z(“"])/.exec(note);
  if (!match) return note;
  return note.slice(0, match.index + 1);
}

/** The six annotation kinds the store admits, in the operator's words. */
const ANNOTATION_KIND_OPTIONS: { value: AnnotationKind; label: string }[] = [
  { value: "deploy", label: "Deploy" },
  { value: "config", label: "Config change" },
  { value: "model-change", label: "Model change" },
  { value: "autonomy-change", label: "Automation change" },
  { value: "incident", label: "Incident" },
  { value: "external", label: "External event" },
];

/**
 * Record one thing the operator did, so the next alert can say what changed
 * just before it. Backdating is the point, so the time field defaults to now
 * but stays editable. It also asks which task: the chooser is the tasks this
 * asset already has filed against it, picking one is optional and the default
 * is none, because a required field here would be answered with whatever was
 * at the top of the list. Choosing a task records what caused the change; it
 * does not mean the work is proven.
 */
function AnnotationComposer({
  assetId,
  beads,
  onDone,
}: {
  assetId: string;
  /** Tasks filed against this asset, or null when the register could not be
   * asked. Both render the same: no chooser. */
  beads: HandoffBead[] | null;
  onDone: () => void;
}) {
  const toast = useOwnerToast();
  const recordAnnotation = useAnnotationWriter(assetId);
  const [kind, setKind] = useState<AnnotationKind>("deploy");
  const [note, setNote] = useState("");
  const [at, setAt] = useState(() => toLocalDateTimeInput(Date.now()));
  const [ref, setRef] = useState("");
  const [saving, setSaving] = useState(false);

  const when = new Date(at);
  const validTime = !Number.isNaN(when.getTime());
  const futureTime = validTime && when.getTime() > Date.now() + 60_000;
  const canSave = note.trim().length > 0 && validTime && !futureTime && !saving;
  // One entry per task id: a task filed from two surfaces appears twice in the
  // slice.
  const tasks = [
    ...new Map((beads ?? []).map((bead) => [bead.beadId, bead])).values(),
  ];

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      await recordAnnotation({
        kind,
        at: when.toISOString(),
        note: note.trim(),
        // Absent, not empty: `ref` is part of the store's identity
        // `(asset, at, kind, ref)`, and an empty string is a value.
        ref: ref.length > 0 ? ref : null,
      });
      toast.success("Event recorded");
      onDone();
    } catch {
      // The typed text stays exactly where it is: a failed write must not cost
      // the operator the sentence they just wrote.
      toast.error("Event not recorded — the store rejected the write");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          What happened
          <select
            className={fieldClass}
            value={kind}
            onChange={(event) => setKind(event.target.value as AnnotationKind)}
          >
            {ANNOTATION_KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {/* The label is the instruction. "When it happened" asks for the
            moment of the change, not the moment of typing, and the picker
            stops at now — so no footnote has to say either. */}
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          When it happened
          <input
            type="datetime-local"
            className={cn(fieldClass, "tabular-nums")}
            value={at}
            max={toLocalDateTimeInput(Date.now())}
            onChange={(event) => setAt(event.target.value)}
          />
        </label>
        {tasks.length > 0 ? (
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Which task
            <select
              className={cn(fieldClass, "max-w-[16rem]")}
              value={ref}
              onChange={(event) => setRef(event.target.value)}
              data-annotation-task
            >
              {/* First and default. Most changes are not a filed task, and a
                  chooser that opened on one would attribute every deploy to
                  whatever happened to be at the top of the list. */}
              <option value="">Not from a task</option>
              {tasks.map((bead) => (
                <option key={bead.beadId} value={bead.beadId}>
                  {bead.beadId} — {bead.key}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-xs text-muted-foreground">
          Description
          <input
            type="text"
            className={fieldClass}
            placeholder="July SEO batch — 240 recipe titles"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={ANNOTATION_NOTE_MAX}
          />
        </label>
        <Button type="submit" variant="outline" size="sm" disabled={!canSave}>
          {saving ? "Saving…" : "Record"}
        </Button>
      </div>
      {/* Only a refusal, and only while there is one: a time typed into the
          future is the one thing the picker's limit cannot stop. */}
      {futureTime ? (
        <span className="text-[11px] text-error" role="alert">
          Pick a time that has already happened.
        </span>
      ) : null}
    </form>
  );
}

/**
 * The link-outreach funnel, in the operator's words for `reclamation_targets`.
 * `won` carries the milestone accent because a reclaimed link is a
 * milestone-kind outcome; every other stage is quiet, and each is named in
 * text, so the line never states anything by color alone.
 */
const RECLAMATION_STAGE: Record<
  ReclamationStatus,
  { label: string; icon: typeof Send; tone: string }
> = {
  queued: { label: "to pitch", icon: Inbox, tone: "text-muted-foreground" },
  sent: { label: "sent", icon: Send, tone: "text-muted-foreground" },
  opened: { label: "opened", icon: MailOpen, tone: "text-muted-foreground" },
  clicked: { label: "clicked", icon: MousePointerClick, tone: "text-foreground" },
  replied: { label: "replied", icon: Reply, tone: "text-foreground" },
  won: { label: "link updated", icon: Check, tone: "text-milestone" },
  skip: { label: "never pitch", icon: Ban, tone: "text-muted-foreground" },
  dead: { label: "link gone", icon: Unlink, tone: "text-muted-foreground" },
};

/** The stages the arrow line walks. `skip` and `dead` are exits from the funnel,
 * not steps along it, so they follow as a separate quiet clause. */
const RECLAMATION_FUNNEL_STAGES: ReclamationStatus[] = [
  "queued",
  "sent",
  "opened",
  "clicked",
  "replied",
  "won",
];

/**
 * Broken-link outreach for this asset: who was pitched, who answered, and
 * which links actually changed. Read-only: status moves through the import
 * script, so this offers no control, and it stays silent for assets running
 * no campaign.
 */
function ReclamationSection({ reclamation }: { reclamation: ReclamationSlice | null }) {
  if (!reclamation || reclamation.counts.length === 0) return null;
  const byStatus = new Map(
    reclamation.counts.map(({ status, count }) => [status, count]),
  );
  const funnel = RECLAMATION_FUNNEL_STAGES.filter((status) => byStatus.has(status));
  const exits = (["skip", "dead"] as ReclamationStatus[]).filter((status) =>
    byStatus.has(status),
  );
  return (
    <Panel title="Link outreach" count={`${formatInt(reclamation.total)} targets in all`}>
      {/* A list holding only never-pitch hosts has no funnel to draw; the
          exits line below still states what is there. */}
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm empty:hidden">
        {funnel.map((status, index) => {
          const stage = RECLAMATION_STAGE[status];
          const Icon = stage.icon;
          return (
            <span key={status} className="flex items-center gap-1.5">
              {index > 0 ? (
                <span className="text-muted-foreground" aria-hidden>
                  →
                </span>
              ) : null}
              <Icon className={cn("size-3.5 shrink-0", stage.tone)} aria-hidden />
              <span className={cn("font-medium tabular-nums", stage.tone)}>
                {formatInt(byStatus.get(status) ?? 0)}
              </span>
              <span className="text-muted-foreground">{stage.label}</span>
            </span>
          );
        })}
      </p>
      {exits.length > 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {exits
            .map(
              (status) =>
                `${formatInt(byStatus.get(status) ?? 0)} ${RECLAMATION_STAGE[status].label}`,
            )
            .join(" · ")}
        </p>
      ) : null}
      <ul className="mt-3 flex flex-col gap-1.5 empty:hidden">
        {reclamation.recent.map((target) => {
          const stage = RECLAMATION_STAGE[target.status];
          const Icon = stage.icon;
          return (
            <li
              key={target.id}
              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs"
            >
              <Icon className={cn("size-3.5 shrink-0", stage.tone)} aria-hidden />
              <span className="font-medium text-foreground">{target.domain}</span>
              <span className={stage.tone}>{stage.label}</span>
              {target.statusAt ? (
                <span className="tabular-nums text-muted-foreground">
                  {formatCalendarDate(target.statusAt.slice(0, 10))}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
