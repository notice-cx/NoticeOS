import { useDemoReadonly } from '@/lib/browser-context';
import { Archive, ArchiveRestore, Bell, Check, Database, LayoutGrid } from "lucide-react";
import { useState } from "react";
// The lifecycle words moved to the contract when Home's assets table began
// stating them too (bead `ro-pbzu.3`); the local name is kept so the five call
// sites below read as they always did.
import { ASSET_STATUS_LABEL as STATUS_LABEL, stageBeforeRetire } from "@shared/asset-detail";
import type { AnnotationTimeline, AssetInfo, AssetStatus } from "@shared/asset-detail";
import { RESTORE_HASH } from "@shared/asset-detail-views";
import { ASSET_STATUS } from "@shared/changeset";
import { OwnerChip } from "@/components/OwnerChip";
import { StateChip, type StatusSubject } from "@/components/StateChip";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { Panel } from "@/routes/asset-detail/shared";
import { useAssetLifecycle } from "@/hooks/useAssetLifecycle";

// --- how an asset is retired ----------------------------------------------
// The end of the Settings tab: Archive, reversible and recorded on the
// timeline, and Restore. It is the one way out of the site list: a site is
// never deleted (db/postgres/README.md, choice 5), and the operator removed
// the Delete card on 2026-09-29 (bead `ro-ujb9.76.4.5`). Adding the domain
// again opens the archived site here. Moved out whole with the per-tab split
// (bead `ro-78qo.2`).

/** What stops when an asset is archived — one glyph row each, so the operator
 * reads the consequences BEFORE the button rather than a sentence after it.
 * Archiving stops the collectors and takes the asset off Home and the Wall, so it
 * is the preview-then-commit half of doc 15 principle 5, not the undo half.
 * Nouns, not clauses (bead `ro-ujb9.96.6.4`): the heading says they stop. */
const ARCHIVE_STOPS: { key: string; icon: typeof Bell; what: string }[] = [
  { key: "collection", icon: Database, what: "Data collection" },
  { key: "alerts", icon: Bell, what: "Alerts" },
  { key: "card", icon: LayoutGrid, what: "Its card on Home and the TV dashboard" },
];

/**
 * THE ARCHIVE CONFIRMATION'S BODY: what stops, what is kept, and the two
 * buttons (bead `ro-ujb9.96.6.4`).
 */
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
          {saving ? "Archiving…" : "Archive site"}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </>
  );
}

/**
 * Archive, and the way back (bead `ro-pbzu.4`).
 *
 * The confirmation NAMES what stops before the write, and only then does it move
 * `assets.status` to retired through the store lane — which works in every
 * deployment, files or no files (D18).
 *
 * The way back is a Restore that returns the asset to the stage it left — READ,
 * since bead `ro-3085`, from the lifecycle move the archive itself recorded on
 * the timeline (`useAssetLifecycle`), not remembered in this component. An
 * asset archived out of Baselining and restored a week later in a different
 * browser goes back to Baselining, instead of silently going Live and arming its
 * alert rules early.
 *
 * WHERE THE STAGE CAME FROM IS PART OF THE CONTROL (bead `ro-ujb9.96.6.4`).
 * With a record, the button names the stage and a chip dates the move it read.
 * Without one — an asset archived before moves were kept — there is nothing to
 * name, so the card offers the choice instead: a stage picker set to Live and a
 * "No recorded stage" chip, rather than a paragraph saying Live is a guess and
 * pointing at another card to pick something else.
 */
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
  const [picked, setPicked] = useState<AssetStatus>("live");
  const restoreTo: AssetStatus = recorded?.stage ?? picked;

  function move(target: AssetStatus) {
    if (!writable) return;
    const from = asset.status;
    setSaving(true);
    void moveStage(from, target, `Lifecycle stage → ${STATUS_LABEL[target]}`)
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
        action={<OwnerChip path="db · assets row" />}
      >
        <div className="flex flex-wrap items-center gap-2">
          {recorded ? null : (
            <select
              value={picked}
              aria-label="Restore to stage"
              disabled={saving || !writable}
              onChange={(e) => setPicked(e.target.value as AssetStatus)}
              className={fieldClass}
              data-restore-stage
            >
              {ASSET_STATUS.filter((stage) => stage !== "retired").map((stage) => (
                <option key={stage} value={stage}>
                  {STATUS_LABEL[stage]}
                </option>
              ))}
            </select>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving || !writable}
            onClick={() => move(restoreTo)}
          >
            <ArchiveRestore className="size-3.5" aria-hidden />
            {saving ? "Restoring…" : recorded ? `Restore to ${STATUS_LABEL[restoreTo]}` : "Restore"}
          </Button>
          {recorded ? (
            <StateChip
              tone="na"
              label={`Archived ${new Date(recorded.at).toISOString().slice(0, 10)}`}
              subject={`lifecycle:${asset.id}`}
            />
          ) : (
            <span data-restore-default>
              <StateChip tone="na" dot="hollow" label="No recorded stage" subject={`lifecycle:${asset.id}`} />
            </span>
          )}
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Archive" action={<OwnerChip path="db · assets row" />}>
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
          Archive site…
        </Button>
      )}
    </Panel>
  );
}
