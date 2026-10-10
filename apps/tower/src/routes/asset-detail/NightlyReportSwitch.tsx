import {
  NO_NIGHTLY_REPORT_FILE,
  NO_NIGHTLY_REPORT_POINTER,
} from "@noticeos/contract/configuration";
import { expectsNightlyReport } from "@noticeos/contract/reporting";
import type { ReactNode } from "react";
import type { AssetInfo, Wiring } from "@shared/asset-detail";
import type { SettingOp } from "@shared/changeset";
import { KnobEditor } from "@/components/KnobEditor";

/** Whether this asset's SAVED list says it sends no nightly report — the one
 * reading the switch and the card it governs share. */
export function declaresNoReport(asset: Pick<AssetInfo, "id">, wiring: Pick<Wiring, "noReportDeclarations">): boolean {
  return (wiring.noReportDeclarations ?? []).includes(asset.id);
}

/**
 * The data collection card's one state. The switch leads the card. While "No
 * report" is saved it is the card's only state: the rows under it describe an
 * obligation the operator declared away. Switching back to Expected brings
 * them back unchanged.
 */
export function NightlyReportScope({
  asset,
  wiring,
  statesReadOnly = true,
  children,
}: {
  asset: AssetInfo;
  wiring: Wiring;
  /** `false` where the page says once that saves are paused. */
  statesReadOnly?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <NightlyReportSwitch asset={asset} wiring={wiring} statesReadOnly={statesReadOnly} />
      {declaresNoReport(asset, wiring) ? null : children}
    </>
  );
}

/**
 * Whether this asset sends a nightly report at all (`owesNightlyReport` in the
 * contract). One list, written whole: config/constants.json
 * `no_nightly_report`, guarded by exactly what the switch read so two tabs
 * cannot silently undo each other. The list is absent until the first asset
 * declares, so that save creates it (`expectAbsent`) and its Undo removes it.
 */
export function NightlyReportSwitch({
  asset,
  wiring,
  statesReadOnly = true,
}: {
  asset: AssetInfo;
  wiring: Wiring;
  statesReadOnly?: boolean;
}) {
  const saved = wiring.noReportDeclarations ?? null;
  const undeclared = !declaresNoReport(asset, wiring);
  // What the undeclared side means for THIS site: expected once it has sent a
  // report, not set up before then.
  const sent = expectsNightlyReport(false, wiring.lastPulseReceivedAt);
  const onLabel = sent ? "Expected" : "Not set up";
  return (
    <KnobEditor
      label="Nightly report"
      assetId={asset.id}
      current={undeclared}
      format={(value) => (value ? onLabel : "No report")}
      makeOp={(value) => noNightlyReportOps(asset.id, saved, value === false)}
      control={{
        type: "toggle",
        onValue: true,
        offValue: false,
        onLabel,
        offLabel: "No report",
        onTone: sent ? "affirmative" : "na",
        offTone: "na",
      }}
      slug="no-nightly-report"
      statesReadOnly={statesReadOnly}
    />
  );
}

/**
 * The one write the switch makes: the saved list with this asset declared (or
 * not), as the same `file-json-set` a changeset would carry. An empty array is
 * "nothing to write" — the list already says so.
 */
export function noNightlyReportOps(
  assetId: string,
  saved: readonly string[] | null,
  declare: boolean,
): SettingOp[] {
  const current = saved ?? [];
  const next = declare
    ? [...new Set([...current, assetId])].sort()
    : current.filter((id) => id !== assetId);
  if (declare === current.includes(assetId)) return [];
  if (saved === null) {
    return [
      {
        kind: "file-json-set",
        file: NO_NIGHTLY_REPORT_FILE,
        pointer: NO_NIGHTLY_REPORT_POINTER,
        expectAbsent: true,
        value: next,
      },
    ];
  }
  return [
    {
      kind: "file-json-set",
      file: NO_NIGHTLY_REPORT_FILE,
      pointer: NO_NIGHTLY_REPORT_POINTER,
      expect: [...saved],
      value: next,
    },
  ];
}
