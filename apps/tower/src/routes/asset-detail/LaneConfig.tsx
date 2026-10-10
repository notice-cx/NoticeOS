import { Check, Lock } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { AssetGa4Config } from "@shared/asset-detail";
import { integrationLabel, type AssetIntegrationLane } from "@shared/integrations";
import { DATAFORSEO_BASELINE, DATAFORSEO_MARKETS, marketLabel } from "@shared/site-markets";
import { InlineSaveState, type InlineSave } from "@/components/InlineSaveState";
import { fieldClass } from "@/components/ui/field";
import type { GoogleDiscoveredProperty } from "@shared/integrations-page";
import type { DiscoveredSite, PosthogFunnel } from "@noticeos/contract";
import {
  LANE_FALLBACK_LABEL,
  LANE_MAPPED_LABEL,
  LANE_MAPPING,
  LANE_MAPPING_TIMING_LABEL,
  fieldOf,
  fieldRefusal,
  laneMappingTiming,
} from "@shared/config-registers";
import { changesetSlug, type JsonValue } from "@shared/changeset";
import { LANE_REGISTER, laneFieldOp, laneFieldUnsetOp } from "@shared/lane-mapping-ops";
import { declineOps, declineReason, resumeOps, undeclineOps } from "@shared/lane-decline";
import { CollectionEditor } from "@/components/CollectionEditor";
import { DeclineReasons } from "@/components/DeclineReasons";
import { FunnelListEditor } from "@/components/FunnelListEditor";
import { IntegrationStateChip } from "@/components/IntegrationStateChip";
import { StateChip } from "@/components/StateChip";
import { KnobEditor, type KnobControl } from "@/components/KnobEditor";
import { type FieldUndoOutcome, useConfigSave, useFieldConfigSave } from "@/hooks/useConfigSave";
import { Button } from "@/components/ui/button";
import { validateRegisterField } from "@/lib/knob-validators";
import { CONFIG_READ_ONLY_FALLBACK, useConfigWritable } from "@/hooks/useConfigWritable";
import { useAccountSites } from "@/hooks/useAccountSites";
import { useGoogleProperties } from "@/hooks/useGoogleProperties";
import { cn } from "@/lib/utils";

// --- one lane's own configuration -----------------------------------------
// The editable half of the Sources tab: what a lane is mapped to on this asset,
// what posture it is in, and the two GA4 declarations. Moved out whole with the
// per-tab split (bead `ro-78qo.2`).

/** The GA4 lane's own id in `config/integrations.json`'s catalog. */
export const GA4_LANE_ID = "ga4";

/**
 * WHAT THIS ASSET'S ENTRY FOR ONE DATA SOURCE SAYS, editable in place
 * (bead `ro-vu8d.4`).
 *
 * Until this landed, the per-asset half of an integration — which GA4 property,
 * which Search Console site, which DataForSEO scope, and whether the lane is
 * declined — was hand-edited JSON in `config/integrations.json`, which is to say
 * it was not editable by the operator this product is for.
 *
 * THREE THINGS, IN THIS ORDER, and the order is the question being answered:
 *
 *  1. **What is still owed** — the setup steps, derived from the asset's own
 *     state on every read. Nothing here is tickable, exactly as the asset's own
 *     checklist is not: a box somebody could tick without doing the work would
 *     be the one part of this card that can lie. Saved mappings and dated
 *     successful collections are different kinds of proof; neither verifies
 *     that today's provider account still grants the same access.
 *  2. **The mapping** — which property/site/scope this asset is. Only lanes
 *     that HAVE one render fields (`LANE_MAPPING`), and each wears one chip for
 *     what the collector reads today — "Mapped here", or the lane's fallback —
 *     and one for when a save applies (bead `ro-ujb9.96.6.4`), because a field
 *     whose consequence is overstated is worse than one with none.
 *  3. **What blocks it**, when the file says — one line, read-only. The one
 *     posture the operator decides (in use, or Not using) is the row's own
 *     action, `LanePostureAction` below (bead `ro-ujb9.96.7.13`). The
 *     observed chip in the header above is untouched by any of it — this system
 *     has never had a health toggle and does not grow one here.
 *
 * OPEN WHEN IT WANTS THE OPERATOR, closed when it does not: a lane that is
 * working with its mapping written down is a detail, and a lane that is not is
 * the reason they opened this tab.
 */
export function LaneConfig({ lane, asset }: { lane: AssetIntegrationLane; asset: string }) {
  const { cell, mapping, mappingSource } = lane;
  // When configuration saves are unavailable, this section answers that by
  // rendering no control rather than four disabled ones — the mapping is worth
  // reading either way, and a display with nothing to save needs no sentence
  // explaining it. The save refusal is said once on the tab by SavesPaused.
  const { writable, sources } = useConfigWritable();
  // WHEN A SAVE HERE TAKES EFFECT, derived rather than stated (beads `ro-syok.7`,
  // `ro-7xv2`). A deployment reading the stored document collects on the saved
  // value at the next run; one still on the copy compiled into it does not until
  // it restarts. The chip is picked with the same field the payload was built
  // from — so the promise and the behaviour cannot disagree.
  const mappingTiming = laneMappingTiming(sources["config/integrations.json"]);
  const fallback = LANE_MAPPING[cell.laneId]?.fallback ?? null;
  // WHAT THE CONNECTED GOOGLE ACCOUNT CAN SEE (bead `ro-vu8d.17`), for the two
  // lanes it can answer for. Asked only where it could be used: a deployment
  // that cannot save, a lane with no mapping, and every non-Google lane never
  // reach Google at all. Both Google cards share one query key, so a tab
  // showing both makes one round trip.
  const pickerLane = GOOGLE_PICKER_LANES[cell.laneId];
  const discovery = useGoogleProperties(
    writable && pickerLane !== undefined && mapping.length > 0,
  );
  const picker = pickerLane === undefined ? null : lanePicker(pickerLane, discovery);
  // WHAT THE CONNECTED POSTHOG ACCOUNT HOLDS (bead `ro-ujb9.96.7.24`): its
  // projects and their saved funnels, so this row picks them as the connect
  // panel did instead of asking for a project number and event names typed.
  const posthog = cell.laneId === POSTHOG_LANE_ID;
  const account = useAccountSites(POSTHOG_LANE_ID, writable && posthog);
  const projects = posthog ? posthogProjects(account) : null;
  const inactive = cell.effective === "skipped" || cell.effective === "not-applicable";
  const lists = lane.mappingLists ?? [];
  // WHAT BLOCKS IT, as the file says, one line (bead `ro-ujb9.96.7.13`). A
  // declined source's reason is its row's caption, so it is not said again
  // here; a decline reason left on a source in use again is history, not a
  // blocker (`declineReason`).
  const blocker = cell.declared !== "skipped" && cell.note !== null && cell.note.trim() !== "" && declineReason(cell.note) === null ? cell.note : null;
  // NOTHING BUT THE MAPPING (bead `ro-ujb9.96.7.4`): the row's chip is the
  // connection's one status, so the setup checklist that restated it in
  // weaker words ("Provider account access: unverified") is gone, and a source
  // with nothing mapped and nothing blocking has nothing to open.
  if (mapping.length === 0 && lists.length === 0 && blocker === null) return null;
  const wantsAttention =
    !inactive && (
      cell.effective === "needs-setup" ||
      cell.effective === "degraded" ||
      mapping.some((f) => f.value === null || f.value === "")
    );
  const market = cell.laneId === DATAFORSEO_LANE_ID;
  return (
    <details
      className="rounded-md border border-dashed border-border px-3 py-2"
      data-lane-config={cell.laneId}
      open={wantsAttention}
    >
      <summary className="cursor-pointer text-xs font-medium text-foreground marker:text-muted-foreground max-sm:flex max-sm:min-h-11 max-sm:items-center">
        {market ? "Market" : "Mapping"}
      </summary>

      {mapping.length > 0 || lists.length > 0 ? (
        <div className="mt-2" data-lane-mapping={cell.laneId}>
          {/* Said ONCE above the fields, as two states (bead
              `ro-ujb9.96.6.4`): what the collector reads for this asset right
              now, and when a save reaches it. */}
          <div
            className="flex flex-wrap items-center gap-1.5 pb-1"
            data-lane-mapping-state={mappingSource}
          >
            {mappingSource === "register" ? (
              <StateChip
                tone="affirmative"
                glyph={<Check className="size-3" aria-hidden />}
                label={LANE_MAPPED_LABEL}
                subject={`source:${asset}:${cell.laneId}`}
              />
            ) : fallback !== null ? (
              <StateChip
                tone={fallback === "none" ? "caution" : "neutral"}
                dot={fallback === "none" ? "solid" : "hollow"}
                label={LANE_FALLBACK_LABEL[fallback]}
                subject={`source:${asset}:${cell.laneId}`}
              />
            ) : null}
            {writable ? (
              <StateChip
                tone={mappingTiming === "after-restart" ? "caution" : "neutral"}
                label={LANE_MAPPING_TIMING_LABEL[mappingTiming]}
                subject={`source:${asset}:${cell.laneId}`}
              />
            ) : null}
          </div>
          {market && writable ? (
            // One market, picked (bead `ro-ujb9.96.7.4`): a place and its
            // language, never DataForSEO's numeric codes typed by hand.
            <DataForSeoMarketField asset={asset} mapping={mapping} />
          ) : writable && projects !== null && projects.state !== "unavailable" ? (
            // One project, picked from the account (bead `ro-ujb9.96.7.24`);
            // the typed fields below only when the account cannot be read.
            <PosthogProjectField asset={asset} mapping={mapping} projects={projects} />
          ) : writable
            ? mapping.map((field) => (
                <LaneMappingField
                  key={field.name}
                  asset={asset}
                  laneId={cell.laneId}
                  name={field.name}
                  value={field.value}
                  picker={picker}
                />
              ))
            : mapping.map((field) => (
                <p key={field.name} className="mt-1 text-xs text-foreground">
                  <span className="text-muted-foreground">
                    {fieldOf(LANE_REGISTER, field.name)?.label ?? field.name}
                  </span>{" "}
                  <span className="font-mono">{field.value === null ? "not set" : field.value}</span>
                </p>
              ))}
          {lists.map((list) => (
            <LaneMappingList
              key={list.name}
              asset={asset}
              laneId={cell.laneId}
              name={list.name}
              value={list.value}
              saved={projects === null || projects.state === "unavailable" ? undefined : savedFunnels(projects, mapping)}
            />
          ))}
        </div>
      ) : null}

      {blocker !== null ? (
        <p className="mt-2 truncate border-t border-border pt-2 text-xs text-foreground" data-lane-note>
          {blocker}
        </p>
      ) : null}
    </details>
  );
}

/** DataForSEO's lane id in the register. */
const DATAFORSEO_LANE_ID = "dataforseo";

/** PostHog's lane id in the register, which is also its provider id. */
const POSTHOG_LANE_ID = "posthog";

/** The connected PostHog account's projects, as a row reads them: still being
 * read, read (each project a discovered site: its name, `host` + `projectId`
 * mapping and saved funnels), or not readable — no account key, refused, no
 * answer — which is when the row's typed fields come back. */
type PosthogProjects =
  | { state: "loading" }
  | { state: "ready"; sites: DiscoveredSite[] }
  | { state: "unavailable" };

function posthogProjects(query: ReturnType<typeof useAccountSites>): PosthogProjects {
  if (query.isPending && query.fetchStatus !== "idle") return { state: "loading" };
  const discovery = query.data?.discovery;
  if (query.isError || discovery === undefined || !discovery.ok) return { state: "unavailable" };
  return { state: "ready", sites: discovery.sites.filter((site) => site.lane === POSTHOG_LANE_ID) };
}

/** One mapping field's held value, as a string (`null` when unmapped). */
function heldField(mapping: AssetIntegrationLane["mapping"], name: string): string | null {
  const value = mapping.find((field) => field.name === name)?.value;
  return value === null || value === undefined || value === "" ? null : String(value);
}

/** The project this row maps to, among the account's. */
function heldProject(projects: PosthogProjects, mapping: AssetIntegrationLane["mapping"]): DiscoveredSite | null {
  if (projects.state !== "ready") return null;
  const host = heldField(mapping, "host");
  const projectId = heldField(mapping, "projectId");
  return projects.sites.find((site) => String(site.mapping.projectId) === projectId && (host === null || site.mapping.host === host)) ?? null;
}

/** The saved funnels the row's funnel list picks from: the mapped project's,
 * or none while the account is read or the project is not in it. */
function savedFunnels(projects: PosthogProjects, mapping: AssetIntegrationLane["mapping"]): PosthogFunnel[] {
  return heldProject(projects, mapping)?.funnels ?? [];
}

/**
 * A POSTHOG SITE'S PROJECT, PICKED (bead `ro-ujb9.96.7.24`): the connected
 * account's projects by name, number and region — the list the connect panel
 * matched — saved on the pick, region and number in one write, with Undo
 * beside it. It replaced a region select and a project number typed off
 * PostHog's address bar, each with its own Save. A project the account no
 * longer lists stays selected as itself, so opening the list never proposes
 * replacing it.
 */
function PosthogProjectField({
  asset,
  mapping,
  projects,
}: {
  asset: string;
  mapping: AssetIntegrationLane["mapping"];
  projects: Exclude<PosthogProjects, { state: "unavailable" }>;
}) {
  const saveField = useFieldConfigSave();
  const [saving, setSaving] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [outcome, setOutcome] = useState<{ kind: "saved"; undo: () => Promise<FieldUndoOutcome> } | { kind: "refused"; refusal: string } | null>(null);
  const host = heldField(mapping, "host");
  const projectId = heldField(mapping, "projectId");
  const key = (h: string | null, id: string | null) => `${h ?? ""}:${id ?? ""}`;
  const current = key(host, projectId);
  const sites = projects.state === "ready" ? projects.sites : [];
  const listed = sites.some((site) => key(String(site.mapping.host), String(site.mapping.projectId)) === current);

  async function pick(value: string) {
    const site = sites.find((entry) => key(String(entry.mapping.host), String(entry.mapping.projectId)) === value);
    if (!site || value === current) return;
    const nextHost = String(site.mapping.host);
    const nextId = String(site.mapping.projectId);
    const heldHost = mapping.find((field) => field.name === "host")?.value ?? null;
    const heldId = mapping.find((field) => field.name === "projectId")?.value ?? null;
    const ops = [
      ...(heldHost === nextHost ? [] : [laneFieldOp(asset, POSTHOG_LANE_ID, "host", heldHost, nextHost)]),
      ...(heldId === nextId ? [] : [laneFieldOp(asset, POSTHOG_LANE_ID, "projectId", heldId, nextId)]),
    ];
    if (ops.length === 0) return;
    setSaving(true);
    setOutcome(null);
    try {
      const result = await saveField({ ops, label: `PostHog project (${site.label})`, slug: changesetSlug(asset, POSTHOG_LANE_ID, "project") });
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
    <div className="flex flex-wrap items-center gap-2 py-1" data-lane-project={asset} data-lane-project-state={projects.state}>
      <select
        aria-label="PostHog project"
        className={cn(fieldClass, "h-11 max-w-full sm:h-9")}
        value={projects.state === "loading" ? "" : current}
        disabled={projects.state === "loading" || saving || undoing}
        onChange={(event) => void pick(event.target.value)}
      >
        {projects.state === "loading" ? <option value="">Reading PostHog…</option> : null}
        {projects.state === "ready" && projectId === null ? <option value={current}>Pick a project</option> : null}
        {projects.state === "ready" && projectId !== null && !listed ? <option value={current}>{projectId} · not in this account</option> : null}
        {sites.map((site) => (
          <option key={site.ref} value={key(String(site.mapping.host), String(site.mapping.projectId))}>
            {site.label} · {site.mapping.projectId} · {String(site.mapping.host).toUpperCase()}
          </option>
        ))}
      </select>
      <InlineSaveState save={save} subject={`field:posthog-project:${asset}`} />
    </div>
  );
}

/**
 * A DATAFORSEO SITE'S MARKET, PICKED (bead `ro-ujb9.96.7.4`): one select of
 * places in their language ("United Kingdom · English"), saved the moment it
 * is picked, with Undo beside it — instead of the two register fields typed as
 * DataForSEO's numeric location code and language code under two sentences
 * explaining the codes. The write is the same two `laneFieldOp`s the fields
 * made, in one changeset; a pair the list does not name stays selectable as
 * itself.
 */
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

/**
 * The two lanes the connected Google account can answer for, mapped to the half
 * of `GooglePropertyDiscovery` each reads (bead `ro-vu8d.17`). Bing and
 * DataForSEO are typed: nothing lists their scopes for us.
 */
const GOOGLE_PICKER_LANES: Record<string, "ga4" | "gsc" | undefined> = {
  ga4: "ga4",
  gsc: "gsc",
};

/** One lane's half of the discovery read, as its field renders it. */
interface LanePickerState {
  lane: "ga4" | "gsc";
  /** The account is still answering. The text box stays usable meanwhile. */
  loading: boolean;
  /** What this account can see on this lane, in Google's own order. */
  options: GoogleDiscoveredProperty[];
  /** Why there is no list — in Google's own sentence where it had one — or null
   * when there is one. */
  unavailable: string | null;
}

/**
 * The discovery read, narrowed to one lane and to the states a field has to
 * draw: loading, a list, an empty list, and no answer at all.
 *
 * A FAILED READ IS NOT AN ERROR STATE HERE. The field underneath works without
 * it — typing the id is what the operator did before this existed — so the
 * honest degrade is a sentence and a text box, never a blocked field or a red
 * one. The payload is defended rather than trusted: it crosses a network, and a
 * field that threw on a surprising body would take the whole tab with it.
 */
function lanePicker(
  lane: "ga4" | "gsc",
  query: ReturnType<typeof useGoogleProperties>,
): LanePickerState {
  const payload = query.data;
  const listed = Array.isArray(payload?.properties) ? payload.properties : [];
  const options = listed.filter((entry) => entry?.lane === lane);
  const loading = query.isPending || query.isFetching;
  const label = lane === "ga4" ? "GA4 properties" : "Search Console sites";
  // Why there is no list, as a state beside the field that still takes a typed
  // value (bead `ro-ujb9.96.7.4`) — never a sentence telling the operator to type.
  const unavailable = loading
    ? null
    : query.isError || payload === undefined
      ? "Google did not answer"
      : payload.ok === false
        ? (payload.account ? "Google gave no list" : "Google not connected")
        : options.length === 0
          ? `No ${label}`
          : null;
  return { lane, loading, options, unavailable };
}

/**
 * One mapping field — the GA4 property id, the Search Console or Bing site, a
 * DataForSEO location or language.
 *
 * The rule, the label and the sentence under the input all come from the
 * `asset-lane` declaration, and `validateRegisterField` refuses a value with the
 * exact sentence a 422 would have carried — so a typo'd property id names the
 * field's expected format rather than failing as a collector error
 * next Monday.
 *
 * WHERE THE ACCOUNT CAN ANSWER, IT ANSWERS (bead `ro-vu8d.17`). Typing a numeric
 * property id read off a browser URL is the most error-prone step in setting up
 * an asset, and the connected account already knows the list — so the two Google
 * fields become a picker whose `ref` is exactly what the field stores. Nothing
 * about the write changes: the same `file-json-set` at the same pointer, the
 * same validation, the same Undo in the toast.
 *
 * THE TEXT BOX NEVER GOES AWAY. A service-account install has no sign-in to ask,
 * a property the account cannot see is in no list, and a discovery that failed
 * must cost the operator nothing — so it stays, one disclosure below the picker,
 * writing through the same op.
 *
 * AND IT COMES BACK OFF (bead `ro-pkpz`). Mapping was a one-way door: emptying
 * the box is refused, because a field rule reads `""` as a blank string rather
 * than as "take this away", so an asset that should go back to reading its
 * fallback source could not be put back there from the Tower. Remove mapping is
 * that door's other side — one `file-json-delete` at the field's own pointer,
 * guarded by the value being removed, undone by writing it again.
 */
function LaneMappingField({
  asset,
  laneId,
  name,
  value,
  picker = null,
}: {
  asset: string;
  laneId: string;
  name: string;
  value: string | number | null;
  picker?: LanePickerState | null;
}) {
  const save = useConfigSave();
  const [removing, setRemoving] = useState(false);
  const field = fieldOf(LANE_REGISTER, name);
  if (field === null) return null;
  // TWO READINGS OF ONE FIELD, and they are not the same fact (bead `ro-j71v`).
  // `current` is what the CONTROL shows: an unmapped field renders as an empty
  // box, which is what "not set" looks like. `value` is what the FILE holds, and
  // `null` there means the key is not written down at all — which is what the
  // op's guard has to say, because a first save is not a stale one.
  const current: JsonValue = value === null ? "" : value;
  // The declaration picks the control, the same way it picks the refusal: an
  // enum is a list to choose from, a number is a number box, everything else is
  // monospace text because these are identifiers and a proportional font hides
  // a transposed digit.
  const validate = validateRegisterField(field);
  const control: KnobControl =
    field.type === "enum" && field.values
      ? { type: "select", options: field.values.map((v) => ({ value: v, label: v })) }
      : field.type === "integer" || field.type === "number"
        ? { type: "number", validate, step: "1", placeholder: "not set" }
        : { type: "text", mono: true, validate, placeholder: "not set" };
  const editor = (label: string, chosen: KnobControl) => (
    <KnobEditor
      label={label}
      assetId={asset}
      current={current}
      format={(v) => (v === "" || v === null ? "not set" : String(v))}
      makeOp={(v) => laneFieldOp(asset, laneId, name, value, v)}
      control={chosen}
      slug={changesetSlug(asset, laneId, name)}
    />
  );

  // OFFERED ONLY WHERE THERE IS SOMETHING TO REMOVE, and only for a field the
  // declaration marks optional: a required field has no absent state to go back
  // to, and a field nothing has written is already where Remove would leave it.
  // No confirm — the toast carries the way back (docs/15 principle 5).
  const removeMapping =
    value === null || field.required === true
      ? null
      : async () => {
          setRemoving(true);
          try {
            await save({
              ops: [laneFieldUnsetOp(asset, laneId, name, value)],
              label: `${field.label} (${field.name})`,
              slug: changesetSlug(asset, laneId, name),
            });
          } finally {
            setRemoving(false);
          }
        };
  const remove =
    removeMapping === null ? null : (
      <div className="pb-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={removing}
          onClick={() => void removeMapping()}
          data-lane-mapping-remove={`${laneId}-${name}`}
        >
          Remove mapping
        </Button>
      </div>
    );

  // Every lane but the two Google ones, and either of those before the account
  // has listed anything for it: the field it always was, plus one line saying
  // why there is no list to pick from.
  if (picker === null || picker.options.length === 0) {
    return (
      <div
        data-lane-picker={picker === null ? undefined : laneId}
        data-lane-picker-state={
          picker === null ? undefined : picker.loading ? "loading" : "unavailable"
        }
      >
        {editor(field.label, control)}
        {picker === null ? null : (
          <p className="pb-2 text-[11px] leading-snug text-muted-foreground">
            {picker.loading ? "Reading Google…" : picker.unavailable}
          </p>
        )}
        {remove}
      </div>
    );
  }

  // The value the file holds but the account does not list — a property shared
  // with a different login, or a service-account install. It stays selected and
  // is labelled for what it is, so opening the picker can never quietly propose
  // replacing it.
  const unlisted =
    current !== "" && !picker.options.some((entry) => entry.ref === current)
      ? [{ value: String(current), label: `${current} — not in the connected account` }]
      : [];
  const options = [
    ...(current === "" ? [{ value: "", label: "Pick one…" }] : []),
    ...unlisted,
    // The REF rides beside the name, because the ref is what gets stored and
    // what a collector error will name — a list of pretty labels alone would
    // hide the one string that matters.
    ...picker.options.map((entry) => ({
      value: entry.ref,
      label: entry.detail
        ? `${entry.label} — ${entry.detail} (${entry.ref})`
        : `${entry.label} (${entry.ref})`,
    })),
  ];

  return (
    <div data-lane-picker={laneId} data-lane-picker-state="ready">
      {editor(field.label, { type: "select", options })}
      <details className="pb-2">
        <summary className="cursor-pointer text-[11px] text-muted-foreground marker:text-muted-foreground">
          Not in the list? Type it instead
        </summary>
        <div className="mt-1" data-lane-picker-typed={laneId}>
          {editor(`${field.label}, typed`, control)}
        </div>
      </details>
      {remove}
    </div>
  );
}

/**
 * One structured list field of a lane — today only PostHog's funnels (bead
 * `ro-ghis.1`). The whole list is one value at one pointer, so it is written by
 * the same `laneFieldOp` as a scalar field (a first write says the key was
 * absent), and judged by the same declared rule the write lane runs.
 */
function LaneMappingList({
  asset,
  laneId,
  name,
  value,
  saved,
}: {
  asset: string;
  laneId: string;
  name: string;
  value: unknown[] | null;
  /** The funnels the list picks from, read from the account; absent when it
   * cannot be read and the list is typed (bead `ro-ujb9.96.7.24`). */
  saved?: readonly PosthogFunnel[];
}) {
  const field = fieldOf(LANE_REGISTER, name);
  if (field === null || field.type !== "posthog-funnels") return null;
  return (
    <FunnelListEditor
      label={field.label}
      explain={field.describe}
      assetId={asset}
      current={value as PosthogFunnel[] | null}
      refusal={(draft) => fieldRefusal(field, draft)}
      makeOp={(draft) => laneFieldOp(asset, laneId, name, value as JsonValue | null, draft as unknown as JsonValue)}
      slug={changesetSlug(asset, laneId, name)}
      saved={saved}
    />
  );
}

/**
 * THE ONE STATE DECISION THE FILE OWNS, AS ONE PRESS (bead `ro-ujb9.96.7.13`,
 * operator answer A, 2026-09-23).
 *
 * `live` and `degraded` are observed and `not-applicable` is the scope rule's,
 * so an operator decides exactly one thing here: is this asset using this
 * source. "Not using" opens the reason chips in place, and the chip pressed IS
 * the save — the reason and the posture in one changeset (`declineOps`), with
 * Undo in the toast. A declined source offers "Use again", one press back to
 * be set up.
 *
 * It replaced two fields and two Saves: a typed Reason the operator had to
 * start with "REASON:" (later written for them, bead `ro-ujb9.96.6.4`) and a
 * Posture select. The register's rule is unchanged — every decline carries its
 * reason — and the prefix is still the product's to write, never the
 * operator's to type (`shared/lane-decline.ts`).
 *
 * The row's own actions, under its evidence (doc 14: a row expands in place
 * to show its actions), so the verdict is read before the decision is offered.
 * A deployment that cannot save renders nothing: a control that cannot act is
 * not offered.
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
 * WHAT THIS ASSET HAS DECLARED ABOUT ITS GA4 PROPERTY, editable in place
 * (bead `ro-x5gu.3`).
 *
 * Two operator declarations lived only as JSON until now — the events this
 * asset calls value events (`config/value-events.json`) and the event
 * parameters already registered as custom dimensions on its GA4 property
 * (`config/ga4-custom-dimensions.json`). Both decide what the collectors do
 * with this asset, and both are FACTS ABOUT GA4 that only the operator holds,
 * so they belong on the GA4 lane's own card rather than in a settings page
 * across the desk: the card already answers "is this lane working", and this
 * answers "and what have we told it".
 *
 * NEITHER LIST TOUCHES GA4. The measurement channel is `forbidden`-class
 * (AGENTS.md) — operator-only, forever. Listing an event here does not make it
 * a GA4 key event, and listing a parameter does not register a custom
 * dimension; each list records a claim the OS then reads back against what GA4
 * reports. Each carries what reads it in a few words, and its empty state is
 * the state it leaves (bead `ro-ujb9.96.6.4`): "Conversion counts unchecked".
 *
 * The read-only sentence is said ONCE for the pair, above them, the way
 * /settings' Budget says it once above three fields instead of leaving each to
 * whisper it (doc 10).
 *
 * `ro-vu8d.4` adds this asset's GA4 provider mapping (its property id) to this
 * same card — the marked slot below is where it goes, above the declarations,
 * because which property we are talking to comes before what we have said
 * about it.
 */
export function Ga4LaneConfig({ asset, config }: { asset: string; config: AssetGa4Config }) {
  const { writable, reason } = useConfigWritable();
  return (
    <div
      className="flex flex-col gap-4 border-t border-border pt-3"
      data-ga4-config={asset}
    >
      {writable ? null : (
        <p
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
          data-ga4-config-read-only
        >
          <Lock className="size-3 shrink-0" aria-hidden />
          {reason ?? CONFIG_READ_ONLY_FALLBACK}
        </p>
      )}
      {/* ro-vu8d.4: this asset's GA4 property mapping belongs here — which
          property we are talking to comes before what we have said about it. */}
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
        emptyHint="JavaScript-error report skips this site"
      />
    </div>
  );
}

/**
 * WHY A SOURCE DOES NOT APPLY, as a state (bead `ro-ujb9.96.6.4`). A cell the
 * scope rule answers (`since` empty) wears the rule as a chip — a portfolio
 * source on a content asset is the System's own, a content source on the
 * System is for content assets — and one nobody has decided says so; a
 * decided one shows its one-line reason.
 */
function notApplicableWhy(lane: AssetIntegrationLane, asset: string, isOs: boolean): ReactNode {
  const { cell, catalog } = lane;
  if (cell.since !== "") {
    return cell.note ? <span className="block truncate">{cell.note}</span> : null;
  }
  const ruled =
    catalog.scope === "portfolio" && !isOs
      ? "System only"
      : catalog.scope === "property" && isOs
        ? "Content sites only"
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
