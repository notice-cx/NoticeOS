import { useDemoReadonly } from '@/lib/browser-context';
import { Archive, ArchiveRestore, Bell, Check, Database, LayoutGrid } from "lucide-react";
import { useState } from "react";
import { stageBeforeRetire } from "@shared/asset-detail";
import type { AnnotationTimeline, AssetInfo, AssetStatus } from "@shared/asset-detail";
import { RESTORE_HASH } from "@shared/asset-detail-views";
import { StateChip, type StatusSubject } from "@/components/StateChip";
import { Button } from "@/components/ui/button";
import { Panel } from "@/routes/asset-detail/shared";
import { useAssetLifecycle } from "@/hooks/useAssetLifecycle";

// --- how an asset is retired ----------------------------------------------
// The end of the Settings tab: Archive, reversible and recorded on the
// timeline, and Restore. It is the one way out of the site list: a site is
// never deleted. Adding the domain again opens the archived site here.

/** What stops when an asset is archived, one glyph row each, so the operator
 * reads the consequences before the button rather than a sentence after it.
 * Nouns, not clauses: the heading says they stop. */
const ARCHIVE_STOPS: { key: string; icon: typeof Bell; what: string }[] = [
  { key: "collection", icon: Database, what: "Data collection" },
  { key: "alerts", icon: Bell, what: "Alerts" },
  { key: "card", icon: LayoutGrid, what: "Its card on Home and the TV dashboard" },
];

/** The archive confirmation's body: what stops, what is kept, and the two
 * buttons. */
function ArchiveConfirm({
  name,
  subject,
  saving,
  onArchive,
  onCancel,
}: {
  name: string;
  /** The site's recorded history, `history:<asset id>`. */
  subject: StatusSubject;
  saving: boolean;
  onArchive: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <span className="text-sm font-medium">Archiving {name} stops:</span>
      <ul className="flex flex-col gap-2">
        {ARCHIVE_STOPS.map(({ key, icon: Icon, what }) => (
          <li key={key} className="flex items-center gap-2 text-sm">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-background/70">
              <Icon className="size-3.5 text-muted-foreground" aria-hidden />
            </span>
            <span className="min-w-0">{what}</span>
          </li>
        ))}
      </ul>
      <span data-archive-keeps>
        <StateChip
          tone="affirmative"
          glyph={<Check className="size-3" aria-hidden />}
          label="Everything it recorded is kept"
          subject={subject}
        />
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={saving} onClick={onArchive}>
          <Archive className="size-3.5" aria-hidden />
          {saving ? "Archiving…" : "Archive asset"}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </>
  );
}

/** Restore preserves an explicit launch hold; every active stage is derived
 * again from collection history rather than restored from an old assignment. */
export function ArchiveCard({
  asset,
  timeline,
}: {
  asset: AssetInfo;
  timeline: AnnotationTimeline;
}) {
  const demoReadonly = useDemoReadonly();
  const moveStage = useAssetLifecycle(asset.id);
  const writable = !demoReadonly;
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const retired = asset.status === "retired";
  const recorded = stageBeforeRetire(timeline.items);
  const restoreTo: AssetStatus = recorded?.stage === "pre-launch" ? "pre-launch" : "onboarding";

  function move(target: AssetStatus) {
    if (!writable) return;
    const from = asset.storedStatus ?? asset.status;
    setSaving(true);
    void moveStage(from, target, target === "retired" ? "Archive asset" : "Restore asset")
      .then((ok) => {
        if (!ok) return;
        setConfirming(false);
      })
      .finally(() => setSaving(false));
  }

  if (retired) {
    return (
      <Panel
        id={RESTORE_HASH.slice(1)}
        title="Restore"
        count="archived"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving || !writable}
            onClick={() => move(restoreTo)}
          >
            <ArchiveRestore className="size-3.5" aria-hidden />
            {saving ? "Restoring…" : "Restore"}
          </Button>
          {recorded ? (
            <StateChip
              tone="na"
              label={`Archived ${new Date(recorded.at).toISOString().slice(0, 10)}`}
              subject={`lifecycle:${asset.id}`}
            />
          ) : (
            <span data-restore-default>
              <StateChip tone="na" dot="hollow" label="Stage determined from collected data" subject={`lifecycle:${asset.id}`} />
            </span>
          )}
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Archive">
      {confirming && writable ? (
        <div
          data-archive-confirm
          className="flex flex-col gap-3 rounded-lg border border-warn/35 bg-warn/10 p-3"
        >
          <ArchiveConfirm subject={`history:${asset.id}`}
            name={asset.displayName}
            saving={saving}
            onArchive={() => move("retired")}
            onCancel={() => setConfirming(false)}
          />
        </div>
      ) : (
        <Button type="button" variant="outline" size="sm" disabled={!writable} onClick={() => { if (writable) setConfirming(true); }}>
          <Archive className="size-3.5" aria-hidden />
          Archive asset…
        </Button>
      )}
    </Panel>
  );
}
