import { type ReactNode, useState } from "react";
import type { AssetGa4Config } from "@shared/asset-detail";
import { integrationLabel, type AssetIntegrationLane } from "@shared/integrations";
import { DATAFORSEO_BASELINE, DATAFORSEO_MARKETS, marketLabel } from "@shared/site-markets";
import { InlineSaveState, type InlineSave } from "@/components/InlineSaveState";
import { fieldClass } from "@/components/ui/field";
import { fieldOf } from "@shared/config-registers";
import { changesetSlug } from "@shared/changeset";
import { LANE_REGISTER, laneFieldOp, laneFieldUnsetOp } from "@shared/lane-mapping-ops";
import { declineOps, resumeOps, undeclineOps } from "@shared/lane-decline";
import { CollectionEditor } from "@/components/CollectionEditor";
import { DeclineReasons } from "@/components/DeclineReasons";
import { IntegrationStateChip } from "@/components/IntegrationStateChip";
import { StateChip } from "@/components/StateChip";
import { KnobEditor, type KnobControl } from "@/components/KnobEditor";
import { type FieldUndoOutcome, useConfigSave, useFieldConfigSave } from "@/hooks/useConfigSave";
import { Button } from "@/components/ui/button";
import { validateRegisterField } from "@/lib/knob-validators";
import { useConfigWritable } from "@/hooks/useConfigWritable";
import { cn } from "@/lib/utils";

/** The GA4 lane's own id in `config/integrations.json`'s catalog. */
export const GA4_LANE_ID = "ga4";

export function LaneConfig({ lane, asset }: { lane: AssetIntegrationLane; asset: string }) {
  const { cell, mapping } = lane;
  const { writable } = useConfigWritable();
  if (mapping.length === 0 || !writable) return null;
  const market = cell.laneId === DATAFORSEO_LANE_ID;
  const open = cell.effective !== "skipped" && cell.effective !== "not-applicable"
    && (cell.effective === "needs-setup" || mapping.some(({ value }) => value === null || value === ""));
  return (
    <details className="rounded-md border border-dashed border-border px-3 py-2" data-lane-config={cell.laneId} open={open}>
      <summary className="cursor-pointer text-xs font-medium text-foreground max-sm:flex max-sm:min-h-11 max-sm:items-center">
        {market ? "Market" : "Mapping"}
      </summary>
      <div className="mt-2" data-lane-mapping={cell.laneId}>
        {market ? <DataForSeoMarketField asset={asset} mapping={mapping} /> : mapping.map(({ name, value }) => (
          <LaneMappingField key={name} asset={asset} laneId={cell.laneId} name={name} value={value} />
        ))}
      </div>
    </details>
  );
}

/** DataForSEO's lane id in the register. */
const DATAFORSEO_LANE_ID = "dataforseo";

function DataForSeoMarketField({ asset, mapping }: { asset: string; mapping: AssetIntegrationLane["mapping"] }) {
  const saveField = useFieldConfigSave();
  const [saving, setSaving] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [outcome, setOutcome] = useState<{ kind: "saved"; undo: () => Promise<FieldUndoOutcome> } | { kind: "refused"; refusal: string } | null>(null);
  const held = (name: string) => mapping.find((field) => field.name === name)?.value ?? null;
  const heldLocation = held("locationCode");
  const heldLanguage = held("languageCode");
  const current = {
    locationCode: typeof heldLocation === "number" ? heldLocation : Number(heldLocation ?? DATAFORSEO_BASELINE.locationCode) || DATAFORSEO_BASELINE.locationCode,
    languageCode: typeof heldLanguage === "string" && heldLanguage !== "" ? heldLanguage : DATAFORSEO_BASELINE.languageCode,
  };
  const key = (market: { locationCode: number; languageCode: string }) => `${market.locationCode}:${market.languageCode}`;
  const options = DATAFORSEO_MARKETS.some((market) => key(market) === key(current)) ? DATAFORSEO_MARKETS : [current, ...DATAFORSEO_MARKETS];

  async function pick(value: string) {
    const market = options.find((entry) => key(entry) === value);
    if (!market || value === key(current)) return;
    const ops = [
      ...(heldLocation === market.locationCode ? [] : [laneFieldOp(asset, DATAFORSEO_LANE_ID, "locationCode", heldLocation, market.locationCode)]),
      ...(heldLanguage === market.languageCode ? [] : [laneFieldOp(asset, DATAFORSEO_LANE_ID, "languageCode", heldLanguage, market.languageCode)]),
    ];
    if (ops.length === 0) return;
    setSaving(true);
    setOutcome(null);
    try {
      const result = await saveField({ ops, label: `Market (${marketLabel(market)})`, slug: changesetSlug(asset, DATAFORSEO_LANE_ID, "market") });
      setOutcome(result.saved ? { kind: "saved", undo: result.undo } : { kind: "refused", refusal: result.refusal });
    } finally {
      setSaving(false);
    }
  }

  async function undo() {
    if (outcome?.kind !== "saved") return;
    setUndoing(true);
    try {
      const back = await outcome.undo();
      setOutcome(back.undone ? null : { kind: "refused", refusal: back.refusal });
    } finally {
      setUndoing(false);
    }
  }

  const save: InlineSave = saving
    ? { state: "saving" }
    : outcome?.kind === "saved"
      ? { state: "saved", undoing, onUndo: () => void undo() }
      : outcome?.kind === "refused"
        ? { state: "refused", refusal: outcome.refusal }
        : { state: "idle" };
  return (
    <div className="flex flex-wrap items-center gap-2 py-1" data-lane-market={asset}>
      <select
        aria-label="Market"
        className={cn(fieldClass, "h-11 max-w-full sm:h-9")}
        value={key(current)}
        disabled={saving || undoing}
        onChange={(event) => void pick(event.target.value)}
      >
        {options.map((market) => (
          <option key={key(market)} value={key(market)}>{marketLabel(market)}</option>
        ))}
      </select>
      <InlineSaveState save={save} subject={`field:market:${asset}`} />
    </div>
  );
}

function LaneMappingField({ asset, laneId, name, value }: {
  asset: string;
  laneId: string;
  name: string;
  value: string | number | null;
}) {
  const save = useConfigSave();
  const [removing, setRemoving] = useState(false);
  const field = fieldOf(LANE_REGISTER, name);
  if (field === null) return null;
  const validate = validateRegisterField(field);
  const control: KnobControl = field.type === "enum" && field.values
    ? { type: "select", options: field.values.map((entry) => ({ value: entry, label: entry })) }
    : field.type === "integer" || field.type === "number"
      ? { type: "number", validate, step: "1", placeholder: "not set" }
      : { type: "text", mono: true, validate, placeholder: "not set" };
  const slug = changesetSlug(asset, laneId, name);
  return (
    <div>
      <KnobEditor label={field.label} assetId={asset} current={value ?? ""}
        format={(entry) => entry === "" || entry === null ? "not set" : String(entry)}
        control={control} makeOp={(next) => laneFieldOp(asset, laneId, name, value, next)} slug={slug} />
      {value !== null && !field.required ? <Button type="button" size="sm" variant="ghost" disabled={removing}
        data-lane-mapping-remove={`${laneId}-${name}`} onClick={() => {
          setRemoving(true);
          void save({ ops: [laneFieldUnsetOp(asset, laneId, name, value)], label: field.label, slug })
            .finally(() => setRemoving(false));
        }}>Remove mapping</Button> : null}
    </div>
  );
}

/**
 * The one state decision the file owns: is this asset using this source.
 * `live` and `degraded` are observed and `not-applicable` is the scope rule's.
 * The reason chip pressed is the save, reason and posture in one changeset
 * (`declineOps`); the reason's prefix is `shared/lane-decline.ts`'s.
 */
export function LanePostureAction({ asset, lane }: { asset: string; lane: AssetIntegrationLane }) {
  const { cell, catalog } = lane;
  const { writable } = useConfigWritable();
  const save = useConfigSave();
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!writable) return null;
  const label = integrationLabel(catalog.id, catalog.label);
  const slug = changesetSlug(asset, cell.laneId, "status");
  const held = { status: cell.declared, note: cell.note };

  if (cell.declared === "skipped") {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        data-lane-use-again={cell.laneId}
        onClick={() => {
          setBusy(true);
          void save({ ops: resumeOps(asset, cell.laneId, cell.declared), label: `${label}: using again`, slug })
            .finally(() => setBusy(false));
        }}
      >
        Use again
      </Button>
    );
  }

  if (!choosing) {
    return (
      <Button type="button" variant="outline" size="sm" data-lane-decline={cell.laneId} onClick={() => setChoosing(true)}>
        Not using
      </Button>
    );
  }

  return (
    <DeclineReasons
      subject={label}
      busy={busy}
      autoFocus
      onCancel={() => setChoosing(false)}
      onChoose={async (reason) => {
        setBusy(true);
        const saved = await save({
          ops: declineOps(asset, cell.laneId, held, reason),
          undo: undeclineOps(asset, cell.laneId, held, reason),
          label: `${label}: not using`,
          slug,
        });
        setBusy(false);
        if (saved) setChoosing(false);
      }}
    />
  );
}
/**
 * What this asset has declared about its GA4 property, editable in place: the
 * events it calls value events (`config/value-events.json`) and the event
 * parameters registered as custom dimensions (`config/ga4-custom-dimensions.json`).
 * Neither list touches GA4: the measurement channel is operator-only, and each
 * list records a claim the OS then reads back against what GA4 reports. The
 * read-only sentence is stated once by the Sources tab.
 */
export function Ga4LaneConfig({ asset, config }: { asset: string; config: AssetGa4Config }) {
  return (
    <div
      className="flex flex-col gap-4 border-t border-border pt-3"
      data-ga4-config={asset}
    >
      <CollectionEditor
        register="product-use-stages"
        params={{ asset }}
        rows={config.productUseStages?.map((stage) => ({ ...stage })) ?? null}
        holderExists={config.valueEventsEntryExists === true}
        statesReadOnly={false}
        describe="Shows saved event counts"
        emptyHint="No product use stages declared"
      />
      <CollectionEditor
        register="value-events"
        params={{ asset }}
        rows={config.valueEvents}
        holderExists={config.valueEventsEntryExists === true}
        statesReadOnly={false}
        describe="Checked nightly against key events"
        emptyHint="Conversion counts unchecked"
      />
      <CollectionEditor
        register="ga4-event-params"
        params={{ asset }}
        rows={config.eventParams}
        statesReadOnly={false}
        describe="Read by the error report"
        emptyHint="JavaScript-error report skips this asset"
      />
    </div>
  );
}

/**
 * Why a source does not apply, as a state. A cell the scope rule answers
 * (`since` empty) wears the rule as a chip, one nobody has decided says so,
 * and a decided one shows its one-line reason.
 */
function notApplicableWhy(lane: AssetIntegrationLane, asset: string, isOs: boolean): ReactNode {
  const { cell, catalog } = lane;
  if (cell.since !== "") {
    return cell.note ? <span className="block break-words">{cell.note}</span> : null;
  }
  const ruled =
    catalog.scope === "portfolio" && !isOs
      ? "System only"
      : catalog.scope === "property" && isOs
        ? "Content assets only"
        : null;
  return ruled === null ? (
    <StateChip tone="caution" label="Not decided yet" subject={`source:${asset}:${cell.laneId}`} />
  ) : (
    <StateChip tone="na" label={ruled} subject={`source:${asset}:${cell.laneId}`} />
  );
}

export function NotApplicableLanes({
  lanes,
  asset,
  isOs,
}: {
  lanes: AssetIntegrationLane[];
  asset: string;
  isOs: boolean;
}) {
  return (
    <details className="rounded-md border border-dashed border-border p-3">
      <summary className="cursor-pointer text-xs text-muted-foreground marker:text-muted-foreground max-sm:flex max-sm:min-h-11 max-sm:items-center max-sm:gap-x-1">
        <span className="font-medium text-foreground">
          {lanes.length === 1
            ? "1 data source doesn't apply here:"
            : `${lanes.length} data sources don't apply here:`}
        </span>{" "}
        {lanes.map((l) => l.catalog.label).join(", ")}
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        {lanes.map((l) => (
          <div key={l.cell.laneId} className="flex flex-col gap-1.5 border-t border-border pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium text-foreground">{l.catalog.label}</span>
              <IntegrationStateChip state={l.cell.effective} subject={`source:${asset}:${l.cell.laneId}`} />
            </div>
            <div className="min-w-0 text-xs text-muted-foreground" data-lane-na-why={l.cell.laneId}>
              {notApplicableWhy(l, asset, isOs)}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}
