import { useId, useState } from "react";
import type { DiscoveredSite, PosthogFunnel } from "@noticeos/contract";
import { TOWER_CONFIG_FILES } from "@noticeos/contract/configuration";
import { googleListingGrant } from "@shared/connect-panel";
import { changesetSlug, escapePointerToken, type FileOp, type JsonValue, type SettingOp } from "@shared/changeset";
import { fieldOf, fieldRefusal } from "@shared/config-registers";
import { declineOps, resumeOps, undeclineOps } from "@shared/lane-decline";
import { LANE_REGISTER, laneFieldOp, laneFieldUnsetOp } from "@shared/lane-mapping-ops";
import { holdsSiteMapping, planSites, type SitesAsset, type SitesPayload } from "@shared/site-discovery";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { FunnelListEditor } from "@/components/FunnelListEditor";
import { useConfigSaveDelay } from "@/hooks/config-backed-queries";
import { useFieldConfigSave, useFieldStructuralSave, type FieldSaveOutcome } from "@/hooks/useConfigSave";
import { InlineSaveState } from "@/components/InlineSaveState";
import { useConfigWritable } from "@/hooks/useConfigWritable";
import { cn } from "@/lib/utils";

const FIELDS = {
  ga4: { label: "GA4 property", keys: ["propertyId"] },
  gsc: { label: "Search Console site", keys: ["siteUrl"] },
  posthog: { label: "PostHog project", keys: ["host", "projectId"] },
} as const;

type MappingLane = keyof typeof FIELDS;
type MappingValues = Record<string, string | number>;
const REGISTER_FILE = TOWER_CONFIG_FILES.integrations;
const FUNNEL_FIELD = fieldOf(LANE_REGISTER, "funnels")!;

export function ProviderMappings({ provider, googleFallbacks, payload, preselect, onClose, onRetry, onCollect, loading }: {
  provider: "google" | "posthog";
  googleFallbacks?: ReadonlySet<string>;
  payload: SitesPayload | undefined;
  preselect: string | null;
  onClose: () => void;
  onRetry: () => void;
  onCollect: () => void;
  loading: boolean;
}) {
  const { writable, reason } = useConfigWritable();
  const [pendingSaves, setPendingSaves] = useState(0);
  const onSaving = (saving: boolean) => setPendingSaves((count) => count + (saving ? 1 : -1));
  if (!payload) {
    return loading
      ? <p role="status" data-status-for={`integration:${provider}`} className="text-sm text-muted-foreground">Loading mappings…</p>
      : <Button type="button" variant="outline" onClick={onRetry}>Retry loading mappings</Button>;
  }
  const lanes: readonly MappingLane[] = provider === "google" ? ["ga4", "gsc"] : ["posthog"];
  const { discovery } = payload;
  const sites = discovery.ok ? discovery.sites : [];
  const rows = planSites(payload, preselect).rows;
  const grants = provider === "google" && discovery.ok
    ? (["ga4", "gsc"] as const)
      .filter((lane) => rows.some((row) => row.lanes.some((entry) => entry.lane === lane && entry.site === null)))
      .map((lane) => googleListingGrant(lane, discovery, "select Reload list")).filter((grant) => grant !== null)
    : [];
  return (
    <section className="grid gap-3" aria-label="Asset mappings" data-provider-mappings={provider}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Asset mappings</h3>
        <Button type="button" variant="outline" size="sm" onClick={onRetry} aria-busy={loading}>Reload list</Button>
      </div>
      {!discovery.ok ? <p className="text-sm text-muted-foreground">Couldn’t list the connected account. You can enter a mapping manually.</p> : null}
      {grants.length > 0 ? <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Missing a listing in Google?</summary>
        {grants.map((grant) => <p key={grant} className="mt-1 wrap-anywhere">{grant}</p>)}
      </details> : null}
      {!writable && reason ? <p className="text-sm text-muted-foreground">{reason}</p> : null}
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">Add an asset to create a mapping.</p> : (
        <ul className="m-0 grid min-w-0 list-none divide-y divide-border rounded-lg border border-border p-0">
          {rows.map((row) => (
            <li key={row.asset.id} data-mapping-asset={row.asset.id} className="min-w-0 space-y-2 p-3">
              <h4 className="m-0 wrap-anywhere text-sm font-semibold">{row.asset.label}</h4>
              <div className={cn("grid min-w-0 gap-3", provider === "google" && "sm:grid-cols-2")}>
                {lanes.map((lane) => (
                  <MappingField key={lane} asset={row.asset} lane={lane} sites={sites.filter((site) => site.lane === lane)}
                    suggested={row.lanes.find((entry) => entry.lane === lane && entry.state === "matched" &&
                      sites.filter((site) => site.lane === lane && site.host === entry.site?.host && site.ready).length === 1)?.site ?? null}
                    accountListed={discovery.ok} googleFallback={googleFallbacks?.has(`${row.asset.id}/${lane}`) === true} loading={loading} onSaving={onSaving} />
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={onClose}>Done</Button>
        {discovery.ok && rows.length > 0 ? <Button type="button" variant="ghost" onClick={onCollect} disabled={pendingSaves > 0 || loading}>Choose what to collect</Button> : null}
      </div>
    </section>
  );
}

function MappingField({ asset, lane, sites, suggested, accountListed, googleFallback, loading, onSaving }: {
  asset: SitesAsset;
  lane: MappingLane;
  sites: DiscoveredSite[];
  suggested: DiscoveredSite | null;
  accountListed: boolean;
  googleFallback: boolean;
  loading: boolean;
  onSaving: (saving: boolean) => void;
}) {
  const field = FIELDS[lane];
  const cell = asset.cells[lane] ?? null;
  const held = cell?.mapping ?? {};
  const current = sites.find((site) => holdsSiteMapping(held, site));
  const heldLabel = lane === "posthog" ? held.projectId : held[field.keys[0]];
  const id = useId();
  const { writable } = useConfigWritable();
  const save = useFieldConfigSave();
  const structural = useFieldStructuralSave();
  const delay = useConfigSaveDelay();
  const [selection, setSelection] = useState<string | null>(null);
  const [manual, setManual] = useState<MappingValues | null>(null);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<FieldSaveOutcome | null>(null);
  const derived = cell?.status === "skipped" ? "" : current?.ref ?? (heldLabel ? "held" : "");
  const selected = selection ?? derived;
  const available = sites.filter((site) => site.ready);
  const disabled = !writable || loading || saving || cell?.status === "not-applicable";
  const slug = changesetSlug(asset.id, lane, "mapping");

  async function waitForConfig() {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  }

  async function undo() {
    if (!outcome?.saved || disabled) return;
    onSaving(true);
    setSaving(true);
    try {
      const result = await outcome.undo();
      if (result.undone) await waitForConfig();
      setOutcome(result.undone ? null : { saved: false, refusal: result.refusal });
    } finally {
      setSaving(false);
      onSaving(false);
    }
  }

  async function commit(values: MappingValues | null) {
    if (disabled) return;
    if (values) {
      for (const name of field.keys) {
        const definition = fieldOf(LANE_REGISTER, name)!;
        const refusal = fieldRefusal(definition, values[name] ?? "");
        if (refusal) {
          setOutcome({ saved: false, refusal });
          return;
        }
      }
    } else if (!cell) return;

    setOutcome(null);
    onSaving(true);
    setSaving(true);
    try {
      const label = `${field.label} for ${asset.label}`;
      let result: FieldSaveOutcome | null = null;
      if (!cell && values) {
        const entry = { status: "needs-setup", since: new Date().toISOString().slice(0, 10), ...values };
        const holder = `/assets/${escapePointerToken(asset.id)}`;
        const pointer = asset.hasIntegrationEntry ? `${holder}/${lane}` : holder;
        const value = asset.hasIntegrationEntry ? entry : { [lane]: entry };
        const ops: FileOp[] = [{ kind: "file-json-insert", file: REGISTER_FILE, pointer, value }];
        result = await structural({ ops, undo: [{ kind: "file-json-delete", file: REGISTER_FILE, pointer, expect: value }], label, slug });
      } else if (cell) {
        const ops: SettingOp[] = [];
        const undo: SettingOp[] = [];
        const mappingChanged = field.keys.some((key) => (held[key] ?? null) !== (values?.[key] ?? null));
        for (const name of field.keys) {
          const before = held[name] ?? null;
          const after = values?.[name] ?? null;
          if (after === before) {
            // A PostHog project is the region and the id together.
            if (lane === "posthog" && before !== null && before !== "" && mappingChanged) {
              const guard = laneFieldOp(asset.id, lane, name, before, before);
              ops.push(guard);
              undo.push(guard);
            }
            continue;
          }
          if (after !== null) {
            ops.push(laneFieldOp(asset.id, lane, name, before, after));
            undo.push(before === null || before === "" ? laneFieldUnsetOp(asset.id, lane, name, after)
              : laneFieldOp(asset.id, lane, name, after, before));
          } else if (before !== null) {
            ops.push(laneFieldUnsetOp(asset.id, lane, name, before));
            if (before !== "") undo.push(laneFieldOp(asset.id, lane, name, null, before));
          }
        }
        if (lane === "posthog" && ops.length > 0) {
          const before = cell.funnels ?? null;
          const after = values ? sites.find((site) => holdsSiteMapping(values, site))?.funnels ?? [] : [];
          const next = after as unknown as JsonValue;
          ops.push(laneFieldOp(asset.id, lane, "funnels", before, next));
          undo.push(before === null ? laneFieldUnsetOp(asset.id, lane, "funnels", next)
            : laneFieldOp(asset.id, lane, "funnels", next, before));
        }
        if (values && cell.status === "skipped") {
          ops.push(...resumeOps(asset.id, lane, cell.status));
          undo.push(laneFieldOp(asset.id, lane, "status", "needs-setup", cell.status));
        }
        // A removed Google mapping must not fall back to the old credential.
        if (!values && cell.status !== "skipped") {
          const posture = { status: cell.status, note: cell.note ?? null };
          ops.push(...declineOps(asset.id, lane, posture, "Mapping removed"));
          undo.push(...undeclineOps(asset.id, lane, posture, "Mapping removed"));
        }
        if (ops.length > 0) result = await save({ ops, undo, label, slug });
      }
      if (result?.saved) {
        await waitForConfig();
        setSelection(null);
        setManual(null);
      }
      setOutcome(result);
    } finally {
      setSaving(false);
      onSaving(false);
    }
  }

  const chosen = available.find((site) => site.ref === selected);
  const needsSave = selection !== null && selected !== derived;
  const choices = available.map((site) => <option key={site.ref} value={site.ref}>{site.label}</option>);
  const funnelList = Array.isArray(cell?.funnels) ? cell.funnels as unknown as PosthogFunnel[] : null;
  const changesProject = lane === "posthog" && !!funnelList?.length && (needsSave || (manual !== null && field.keys.some((key) => manual[key] !== held[key])));
  return (
    <div className="grid min-w-0 gap-2" data-provider-mapping={lane}>
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">{field.label}</label>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <select id={id} aria-label={`${field.label} for ${asset.label}`} disabled={disabled} value={selected}
          className={cn(fieldClass, "min-h-11 min-w-0 flex-1 basis-36 px-2 sm:min-h-9")}
          onChange={(event) => { setOutcome(null); setSelection(event.target.value); }}>
          <option value="">{cell?.status === "skipped" ? "Not using" : googleFallback ? "Using saved account mapping" : "Unassigned"}</option>
          {heldLabel && derived && (!current || !current.ready) ? <option value={derived} disabled>{heldLabel} · unavailable in account</option> : null}
          {choices}
        </select>
        {needsSave ? <Button type="button" size="sm" disabled={disabled || (!chosen && selected !== "")}
          onClick={() => void commit(chosen?.mapping ?? null)}>{selected === "" ? "Remove mapping" : "Save"}</Button> : null}
      </div>
      {changesProject ? <p className="text-xs text-muted-foreground">This change replaces the selected funnels.</p> : null}
      {!heldLabel && !needsSave && suggested && cell?.status !== "skipped" && cell?.status !== "not-applicable" ? (
        <Button type="button" variant="ghost" size="sm" className="h-auto w-fit max-w-full whitespace-normal text-start"
          disabled={disabled} onClick={() => setSelection(suggested.ref)}>Use {suggested.label}</Button>
      ) : null}
      {cell && !heldLabel && cell.status !== "skipped" && !disabled && !needsSave && googleFallback ? (
        <Button type="button" variant="ghost" size="sm" className="w-fit" onClick={() => void commit(null)}>Stop collecting</Button>
      ) : null}
      {cell?.status === "not-applicable" ? <span className="text-xs text-muted-foreground">Doesn’t apply</span> : null}
      {writable && cell?.status !== "not-applicable" && (!accountListed || !current) ? (
        <details>
          <summary className="min-h-7 cursor-pointer text-xs text-muted-foreground">Enter manually</summary>
          <div className="mt-1 flex flex-wrap items-end gap-2">
            {field.keys.map((name) => (
              <label key={name} className="grid min-w-0 flex-1 basis-28 gap-1 text-xs text-muted-foreground">
                {fieldOf(LANE_REGISTER, name)!.label}
                <input className={cn(fieldClass, "h-9 min-w-0 px-2")} disabled={disabled} value={manual?.[name] ?? held[name] ?? ""}
                  onChange={(event) => { setOutcome(null); setManual({ ...held, ...manual, [name]: event.target.value }); }} />
              </label>
            ))}
            <Button type="button" size="sm" variant="outline" disabled={disabled || !manual}
              onClick={() => { if (manual) void commit(manual); }}>Save manual mapping</Button>
          </div>
        </details>
      ) : null}
      <InlineSaveState subject={`source:${asset.id}:${lane}`} save={
        saving ? { state: "saving" } : outcome?.saved ? { state: "saved", undoing: loading, onUndo: () => void undo() }
          : outcome ? { state: "refused", refusal: outcome.refusal } : { state: "idle" }
      } />
      {lane === "posthog" && cell && cell.status !== "skipped" && held.host && held.projectId && !needsSave ? (
        <details className="text-sm">
          <summary className="min-h-8 cursor-pointer text-muted-foreground">Funnels{funnelList?.length ? ` · ${funnelList.length}` : ""}</summary>
          <FunnelListEditor key={`${held.host}:${held.projectId}`} assetId={asset.id} statesReadOnly={false} current={funnelList}
            refusal={(draft) => fieldRefusal(FUNNEL_FIELD, draft)}
            makeOp={(draft) => laneFieldOp(asset.id, lane, "funnels", cell.funnels ?? null, draft as unknown as JsonValue)}
            guards={field.keys.flatMap((key) => {
              const value = held[key];
              return value === undefined ? [] : [laneFieldOp(asset.id, lane, key, value, value)];
            })}
            slug={changesetSlug(asset.id, lane, "funnels")}
            saved={current ? current.funnels ?? [] : undefined} />
        </details>
      ) : null}
    </div>
  );
}
