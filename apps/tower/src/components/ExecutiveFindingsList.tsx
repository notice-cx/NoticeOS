import { useDemoReadonly } from '@/lib/browser-context';
import { useOwnerToast } from '@/lib/browser-context';
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bookmark } from "lucide-react";

import type {
  AssetDecision,
  ExecutiveInsight,
  ExecutiveInsightKind,
  ExecutiveSnapshot,
  HandoffBead,
  SuppressedInsight,
} from "@shared/asset-detail";
import { EmptyState } from "@/components/EmptyState";
import { AnalysisEvidence } from "@/components/AnalysisEvidence";
import {
  EXECUTIVE_INSIGHT_META,
  ExecutiveInsightRow,
} from "@/components/ExecutiveInsightRow";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { WatchSeed } from "@shared/watch-windows";
import { useOwnerPreferences } from '@/lib/browser-context';

/** The two states a finding can be left in. `null` is not a third state — it is
 * the absence of a decision, and the store holds no row for it. */
export type FindingDecision = "marked" | "dismissed";

/** Persist one finding decision; `null` clears it (Restore). */
export type FindingDecisionWriter = (
  key: string,
  status: FindingDecision | null,
) => Promise<void>;

interface FindingPreferences {
  marked: string[];
  dismissed: string[];
}

const FINDING_KIND_RANK = {
  warning: 0,
  recommendation: 1,
  discovery: 2,
  insight: 3,
} as const;

/** The stored name of one asset's finding choices (lib/browser-storage). */
function findingPreferenceName(asset: string): string {
  return `property-findings:${asset}`;
}

function readFindingPreferences(preferences: ReturnType<typeof useOwnerPreferences>, asset: string): FindingPreferences {
  if (typeof window === "undefined") return { marked: [], dismissed: [] };
  try {
    const value: unknown = JSON.parse(
      preferences.read(findingPreferenceName(asset)) ?? "{}",
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { marked: [], dismissed: [] };
    }
    const record = value as Partial<FindingPreferences>;
    return {
      marked: Array.isArray(record.marked)
        ? record.marked.filter((key): key is string => typeof key === "string")
        : [],
      dismissed: Array.isArray(record.dismissed)
        ? record.dismissed.filter(
            (key): key is string => typeof key === "string",
          )
        : [],
    };
  } catch {
    return { marked: [], dismissed: [] };
  }
}

function forgetFindingPreferences(preferences: ReturnType<typeof useOwnerPreferences>, asset: string): void {
  try {
    preferences.forget(findingPreferenceName(asset));
  } catch {
    // A blocked local store is not worth surfacing: the decisions are already
    // in the OS by this point, and a stale key is only read when the server
    // has nothing.
  }
}

/** Ranked archive findings plus the operator's reversible decisions about them.
 * The decisions live in the OS (db/0013), not in this browser; alert lifecycle
 * remains elsewhere and this list never mutates provider evidence. */
export function ExecutiveFindingsList({
  snapshot,
  recordedDecisions = [],
  handoffBeads = null,
  onDecide,
  onWatch,
}: {
  snapshot: ExecutiveSnapshot;
  /** This asset's stored decisions (payload slice). A finding with no row
   * here has not been touched. */
  recordedDecisions?: AssetDecision[];
  /** What the task hub holds for this asset (payload slice, bead `ro-248`).
   * `null` means it could not be asked — no snapshot, not a spoke, or a poller
   * one generation behind — and is why the absent case is never phrased as
   * "nothing filed" anywhere in this list. */
  handoffBeads?: HandoffBead[] | null;
  /** Persist a decision. Optimistic: the list reorders immediately and rolls
   * back if the write fails. Omitted in the component gallery, where there is
   * no asset behind the demo snapshot. */
  onDecide?: FindingDecisionWriter;
  /** Open the asset page's outcome-check composer, seeded from one finding
   * (bead `ro-5e8.5`). Absent — the gallery — renders no action, rather than a
   * button with no composer behind it. */
  onWatch?: (seed: WatchSeed) => void;
}) {
  const demoReadonly = useDemoReadonly();
  const toast = useOwnerToast();
  const preferences = useOwnerPreferences();
  // Decisions this session has taken but the next poll has not returned yet.
  // A key present with `null` is an explicit clear, so it must beat the server
  // value rather than fall through to it.
  const [local, setLocal] = useState<Record<string, FindingDecision | null>>({});
  const [showDismissed, setShowDismissed] = useState(false);
  const migrated = useRef(false);

  const stored = new Map(
    recordedDecisions
      .filter(
        (item) =>
          item.kind === "finding" &&
          (item.status === "marked" || item.status === "dismissed"),
      )
      .map((item) => [item.key, item.status as FindingDecision]),
  );
  const decisionOf = (key: string): FindingDecision | null =>
    key in local ? (local[key] ?? null) : (stored.get(key) ?? null);

  // The register's answer for these same keys. Filtered to `finding` because a
  // query decision's key is a normalized search query, and a rule id that
  // happened to equal one would otherwise borrow its bead.
  const filed = new Map(
    (handoffBeads ?? [])
      .filter((entry) => entry.kind === "finding")
      .map((entry) => [entry.key, entry]),
  );
  const beadOf = (key: string): HandoffBead | null => filed.get(key) ?? null;

  // One-time lift of the per-device preferences this list used to keep. It runs
  // only when the OS holds nothing for this asset, so a device that already
  // synced never overwrites the shared state — and it stays silent, because the
  // operator did not ask for a migration.
  useEffect(() => {
    if (demoReadonly || migrated.current || !onDecide) return;
    migrated.current = true;
    if (stored.size > 0) return;
    const previous = readFindingPreferences(preferences, snapshot.asset);
    const entries: Array<[string, FindingDecision]> = [
      ...previous.marked.map((key): [string, FindingDecision] => [key, "marked"]),
      ...previous.dismissed.map((key): [string, FindingDecision] => [
        key,
        "dismissed",
      ]),
    ];
    if (entries.length === 0) return;
    void (async () => {
      try {
        for (const [key, status] of entries) {
          await onDecide(key, status);
        }
      } catch {
        // Leave the browser copy in place; the next mount retries.
        return;
      }
      setLocal((current) => ({ ...Object.fromEntries(entries), ...current }));
      forgetFindingPreferences(preferences, snapshot.asset);
    })();
    // Mount-only: the browser copy is read once, and only when the OS is empty.
  }, []);

  const originalRank = new Map(
    snapshot.items.map((item, index) => [item.key, index]),
  );
  const activeItems = snapshot.items
    .filter((item) => decisionOf(item.key) !== "dismissed")
    .sort(
      (left, right) =>
        Number(decisionOf(right.key) === "marked") -
          Number(decisionOf(left.key) === "marked") ||
        FINDING_KIND_RANK[left.kind] - FINDING_KIND_RANK[right.kind] ||
        (originalRank.get(left.key) ?? 0) - (originalRank.get(right.key) ?? 0),
    );
  const dismissedItems = snapshot.items.filter(
    (item) => decisionOf(item.key) === "dismissed",
  );

  function decide(key: string, next: FindingDecision | null) {
    if (demoReadonly) return;
    const previous = decisionOf(key);
    setLocal((current) => ({ ...current, [key]: next }));
    if (!onDecide) return;
    onDecide(key, next).catch(() => {
      setLocal((current) => ({ ...current, [key]: previous }));
      toast.error("Not saved — this finding is unchanged");
    });
  }

  function toggleMarked(key: string) {
    decide(key, decisionOf(key) === "marked" ? null : "marked");
  }

  // Reversible by construction, and SHOWN to be: the dismissal answers with an
  // Undo rather than a sentence promising one (bead `ro-ujb9.96.6.8`).
  function dismissFinding(key: string) {
    if (demoReadonly) return;
    decide(key, "dismissed");
    toast.success("Finding dismissed", {
      action: { label: "Undo", onClick: () => restoreFinding(key) },
    });
  }

  function restoreFinding(key: string) {
    decide(key, null);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <AnalysisEvidence snapshot={snapshot} />
          <span>{snapshot.sourceArchiveCount} archived reports</span>
        </div>
        {dismissedItems.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7"
            onClick={() => setShowDismissed((value) => !value)}
            aria-expanded={showDismissed}
          >
            {showDismissed ? "Hide" : "Review"} {dismissedItems.length} dismissed
          </Button>
        ) : null}
      </div>
      {activeItems.length === 0 ? (
        <EmptyState title="All saved findings are dismissed" />
      ) : (
        <FindingGroups
          items={activeItems}
          marked={(key) => decisionOf(key) === "marked"}
          render={(insight, rank, grouped) => (
            <ExecutiveInsightRow
              key={insight.key}
              insight={insight}
              asset={snapshot.asset}
              rank={rank}
              bead={beadOf(insight.key)}
              marked={decisionOf(insight.key) === "marked"}
              grouped={grouped}
              initiallyExpanded={rank === 1}
              disclosureGroup={`current-findings-${snapshot.asset}`}
              onToggleMarked={() => toggleMarked(insight.key)}
              onDismiss={() => dismissFinding(insight.key)}
              onWatch={onWatch}
            />
          )}
        />
      )}
      {showDismissed && dismissedItems.length > 0 ? (
        <div className="rounded-lg border border-dashed border-border p-3">
          <h3 className="text-wall-label font-semibold uppercase tracking-widest text-muted-foreground">
            Dismissed findings
          </h3>
          <div className="mt-2 divide-y divide-border border-y border-border">
            {dismissedItems.map((insight, index) => (
              <ExecutiveInsightRow
                key={insight.key}
                insight={insight}
                asset={snapshot.asset}
                bead={beadOf(insight.key)}
                dismissed
                initiallyExpanded={index === 0}
                disclosureGroup={`dismissed-findings-${snapshot.asset}`}
                onRestore={() => restoreFinding(insight.key)}
              />
            ))}
          </div>
        </div>
      ) : null}
      <SuppressedFindings
        items={snapshot.suppressedItems}
        shown={snapshot.items.length}
      />
      <details className="rounded-lg border border-dashed border-border p-3">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
          How these findings are produced
        </summary>
        <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground">
          {snapshot.methodology.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/** What the eight-card cut dropped (bead `ro-wwm`). The producer already names
 * every dropped card in `suppressedItems` — the OS may decide not to *show* a
 * finding but never not to *mention* it — and this is where the Tower keeps
 * that promise.
 *
 * A count and a reveal, not a second list. The cap is a display and attention
 * decision, so the answer to it is disclosure, not a longer wall of cards:
 * closed, this is one quiet line; opened, it is titles and their kind dot and
 * nothing else. These carry no evidence, no window, and no mark/dismiss
 * controls, because they are mentions. The summary says where the line was
 * drawn ("below the top 8"); the titles themselves show nothing was lost. */
function SuppressedFindings({
  items,
  shown,
}: {
  items: SuppressedInsight[];
  shown: number;
}) {
  if (items.length === 0) return null;
  return (
    <details
      data-suppressed-findings
      className="rounded-lg border border-dashed border-border p-3"
    >
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground max-sm:py-3.5">
        <span className="tabular-nums font-semibold text-foreground">
          {items.length}
        </span>{" "}
        more below the top {shown}
      </summary>
      <ul className="mt-2 space-y-1.5">
        {items.map((item) => (
          <li
            key={item.key}
            className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"
          >
            <span
              className={cn(
                "mt-1.5 size-1.5 shrink-0 rounded-full",
                EXECUTIVE_INSIGHT_META[item.kind].dot,
              )}
              aria-hidden
            />
            <span>{item.title}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * THE RANKED LIST, GROUPED BY KIND (bead `ro-ujb9.96.6.8`). The order was
 * already marked-first, then kind, then the producer's rank; the headings make
 * that order visible and carry each kind's count, so neither a separate count
 * strip nor a kind word on every row is needed. The rank runs on unbroken
 * across the groups, because it is still one ranked list. Empty kinds render
 * nothing.
 */
function FindingGroups({
  items,
  marked,
  render,
}: {
  items: ExecutiveInsight[];
  marked: (key: string) => boolean;
  render: (insight: ExecutiveInsight, rank: number, grouped: boolean) => ReactNode;
}) {
  const groups: Array<{ key: "marked" | ExecutiveInsightKind; items: Array<{ insight: ExecutiveInsight; rank: number }> }> = [];
  items.forEach((insight, index) => {
    const key = marked(insight.key) ? "marked" : insight.kind;
    const last = groups.at(-1);
    if (last?.key === key) last.items.push({ insight, rank: index + 1 });
    else groups.push({ key, items: [{ insight, rank: index + 1 }] });
  });
  return (
    <div className="flex flex-col gap-3" data-finding-groups>
      {groups.map((group) => {
        const label =
          group.key === "marked"
            ? "Marked"
            : findingCountLabel(group.key, group.items.length);
        return (
          <section
            key={group.key}
            aria-label={label}
            data-finding-group={group.key}
          >
            <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {group.key === "marked" ? (
                <Bookmark className="size-3 fill-current" aria-hidden />
              ) : (
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    EXECUTIVE_INSIGHT_META[group.key].dot,
                  )}
                  aria-hidden
                />
              )}
              {label}
              <span className="font-normal tabular-nums">
                {group.items.length}
              </span>
            </h3>
            <div className="mt-1.5 divide-y divide-border border-y border-border">
              {group.items.map(({ insight, rank }) => render(insight, rank, true))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function findingCountLabel(
  kind: ExecutiveInsightKind,
  count: number,
): string {
  if (count === 1) return EXECUTIVE_INSIGHT_META[kind].label;
  if (kind === "warning") return "Warning signs";
  if (kind === "discovery") return "Discoveries";
  return `${EXECUTIVE_INSIGHT_META[kind].label}s`;
}
