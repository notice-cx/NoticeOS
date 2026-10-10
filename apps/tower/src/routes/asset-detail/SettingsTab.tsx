import { useDemoReadonly } from '@/lib/browser-context';
import type { AssetDetailFor } from "@shared/asset-detail-views";
import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ASSET_STATUS_LABEL as STATUS_LABEL } from "@shared/asset-detail";
import type {
  AssetInfo,
  AssetPanelConfig,
  AssetStatus,
  PortfolioConfig,
  RulesInForce,
  Wiring,
} from "@shared/asset-detail";
import { type AssetIntegrations } from "@shared/integrations";
import {
  FIXED_FIELD_LABEL,
  configRegister,
  liveSearchLaneRefusal,
  rowValue,
} from "@shared/config-registers";
import {
  SERP_PANEL_DEVICES,
  SERP_PANEL_QUERY_LIMIT,
  SERP_PANEL_TERM_WEEKLY_USD,
} from "@noticeos/contract/dataforseo";
import { ArrowRight, ChevronRight, Lock, Pencil } from "lucide-react";
import { scheduleLabel, scheduleTimezone } from "@shared/scheduled-jobs";
import { CollectionEditor } from "@/components/CollectionEditor";
import { Meter } from "@/components/Meter";
import { formatInt, formatUsd } from "@/lib/format";
import {
  entityLabel,
  entityMoveOps,
  entityOfAsset,
} from "@shared/entities";
import {
  ASSET_STATUS,
  type EditableFile,
  type JsonValue,
  type SettingOp,
  type StoreColumn,
  toPointer,
} from "@shared/changeset";
import { CADENCE_HOURS } from "@shared/wall";
import { ageMs, formatAge } from "@shared/freshness";
import { AgeBadge } from "@/components/AgeBadge";
import { KnobEditor } from "@/components/KnobEditor";
import { SavesPaused } from "@/components/SavesPaused";
import { KnobRow } from "@/components/KnobRow";
import { SeverityDot } from "@/components/SeverityDot";
import { StateChip } from "@/components/StateChip";
import { Stepper, lifecycleStepper } from "@/components/Stepper";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { validateDisplayLabel, validateUrl } from "@/lib/knob-validators";
import { useSettings } from "@/hooks/useSettings";
import { SectionLabel } from "@/components/surface/SectionLabel";
import { Hero, Panel } from "@/routes/asset-detail/shared";
import { CardTotalsCard, FetchEndpointEditor } from "@/routes/asset-detail/CollectionSetup";
import { ArchiveCard } from "@/routes/asset-detail/AssetRetirement";
import { useAssetLifecycle } from "@/hooks/useAssetLifecycle";
import { NightlyReportScope } from "@/routes/asset-detail/NightlyReportSwitch";

// --- edit op builders (what a Save writes) ---------------------------------
/** A file-json-set op factory: `expect` is baked to the current value the UI
 * saw (the concurrency guard both write lanes check); the factory's arg
 * becomes the new value. */
function fileOp(file: EditableFile, pointer: string, expect: JsonValue) {
  return (value: JsonValue): SettingOp => ({ kind: "file-json-set", file, pointer, expect, value });
}

function storeOp(asset: string, column: StoreColumn, expect: JsonValue) {
  return (value: JsonValue): SettingOp => ({ kind: "store-asset-set", asset, column, expect, value });
}

function modeChip(mode: "pull" | "push", assetId: string): ReactNode {
  return (
    <StateChip
      tone="neutral"
      label={mode === "pull" ? "We fetch it" : "The site sends it"}
      subject={`collection:${assetId}`}
      title={
        mode === "pull"
          ? "The OS fetches this site's metrics endpoint on a schedule."
          : "This site sends its own nightly report to the OS."
      }
    />
  );
}

// --- configuration panel (secondary; collapsed until the operator needs it) -
/**
 * The Settings tab: only what belongs to this asset. What it is called, where
 * it is in its lifecycle, whether the OS may act on it, how its data is
 * collected, and how to retire it. Portfolio-wide numbers live on `/settings`,
 * and this page points at them in one line each.
 */
export function AssetSettingsPanel({
  data,
  nowMs,
}: {
  data: AssetDetailFor<"settings">;
  nowMs: number;
}) {
  const { wiring, rules, asset } = data;
  return (
    <div id="configuration" className="flex scroll-mt-4 flex-col gap-3.5">
      {/* When saves are paused the tab says so once; each editor below shows
          only its lock. */}
      <SavesPaused />
      {/* Identity is the hero: it is what the operator came to change nine
          times out of ten, and it is the only card whose fields name the asset
          itself rather than the machinery around it. */}
      <Hero>
        <IdentityCard asset={asset} />
      </Hero>
      <LifecycleCard asset={asset} />
      <AutomationCard asset={asset} />
      <DataCollectionCard wiring={wiring} asset={asset} nowMs={nowMs} />
      <CardTotalsCard asset={asset.id} stored={data.countersConfig} />
      <AlertRulesCard rules={rules} />
      <PanelSettings
        assetId={asset.id}
        panelConfig={data.panelConfig}
        portfolio={data.portfolio}
        integrations={data.integrations}
      />
      <ArchiveCard asset={asset} timeline={data.annotations} />
    </div>
  );
}

/** A value that cannot change here: the value, a lock, and the state in words,
 * the same "Fixed once added" a register's locked column wears. */
function FixedValue({ field, children }: { field: string; children: ReactNode }) {
  // Each lock is a fact about ITS field, so the status names that field as its
  // subject: two locks on one card are two facts, not one repeated state.
  return (
    <span
      className="inline-flex flex-wrap items-center justify-end gap-2"
      data-fixed-value
    >
      {children}
      <StateChip
        tone="na"
        glyph={<Lock className="size-3" aria-hidden />}
        label={FIXED_FIELD_LABEL}
        subject={`field:${field}`}
      />
    </span>
  );
}

/** Which secret authenticates, and that it is never shown: its name, a lock
 * and the state in two words. The name is a plain word ("Site token"), never
 * the environment binding's expression. */
function SecretPointer({ children }: { children: ReactNode }) {
  return (
    <span
      className="inline-flex min-w-0 flex-wrap items-center justify-end gap-2"
      data-secret-pointer
    >
      <span className="wrap-anywhere">{children}</span>
      <StateChip tone="na" glyph={<Lock className="size-3" aria-hidden />} label="Never shown" subject="field:auth-source" />
    </span>
  );
}

/**
 * Identity: the display name is editable (a store column, so it saves in every
 * deployment); the domain and id cannot move, because every observation and
 * all history are filed under them. The OS's own row has no name field.
 */
function IdentityCard({ asset }: { asset: AssetInfo }) {
  return (
    <Panel title="Identity">
      {asset.isOs ? null : (
        <KnobEditor
          statesReadOnly={false}
          label="Display name"
          assetId={asset.id}
          current={asset.displayName}
          format={(v) => String(v)}
          makeOp={storeOp(asset.id, "display_name", asset.displayName)}
          control={{ type: "text", validate: validateDisplayLabel }}
        />
      )}
      <OwningEntity asset={asset} />
      <div>
        <KnobRow
          label="Domain"
          value={
            <FixedValue field="domain">
              {asset.domain ? (
                <span className="font-mono text-xs">{asset.domain}</span>
              ) : (
                <span className="text-muted-foreground">None</span>
              )}
            </FixedValue>
          }
        />
        <KnobRow
          label="Site id"
          value={
            <FixedValue field="asset-id">
              <span className="font-mono text-xs">{asset.id}</span>
            </FixedValue>
          }
        />
      </div>
    </Panel>
  );
}

/**
 * Which entity owns this asset. Stored once, as this asset's id on the
 * entity's list in `config/entities.json`, so a change moves the id between
 * two lists in one guarded write. With no entity declared it points at the
 * page that declares one rather than showing an empty picker.
 */
function OwningEntity({ asset }: { asset: AssetInfo }) {
  const { data: settings } = useSettings();
  // `?.` on a field the payload declares: a poll that lands mid-restart, and
  // every test fixture that builds the slice it cares about, both hand over a
  // payload this key is not on yet — and a card that threw would take the whole
  // Settings tab with it.
  const rows = settings?.entities?.rows ?? [];

  // No entity declared yet: the row's value is the way to declare one, a link
  // to Settings' Ownership list. While the list is still being read, a dash.
  if (settings === undefined || rows.length === 0) {
    return (
      <KnobRow
        label="Owning entity"
        value={
          settings === undefined ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <Link
              to="/settings#entities"
              className="inline-flex min-h-11 items-center gap-1 text-foreground underline-offset-4 hover:underline sm:min-h-0"
              data-owner-declare
            >
              Add an owner
              <ArrowRight aria-hidden className="size-3 text-muted-foreground" />
            </Link>
          )
        }
      />
    );
  }

  const owner = entityOfAsset(rows, asset.id);
  return (
    <KnobEditor
      statesReadOnly={false}
      label="Owning entity"
      assetId={asset.id}
      current={owner?.slug ?? ""}
      format={(value) => rows.find((row) => row.slug === value)?.name ?? "Nobody has said"}
      makeOp={(value) =>
        entityMoveOps(rows, asset.id, value === "" ? null : String(value))
      }
      control={{
        type: "select",
        options: [
          { value: "", label: "Nobody has said" },
          ...rows.map((row) => ({ value: row.slug, label: entityLabel(row) })),
        ],
      }}
      // A slug is kebab-case and the same for every asset: an asset id carries
      // dots, which the changeset's own rule refuses, and the changeset already
      // names the asset in its ops.
      slug="entity-owner"
    />
  );
}

function LifecycleCard({ asset }: { asset: AssetInfo }) {
  const spec = lifecycleStepper(asset.status);
  return (
    <Panel title="Manual lifecycle stage">
      {/* The stepper is the one display of the current stage; the editor below
          is a "change stage…" action that never restates the current value. */}
      <Stepper steps={spec.steps} activeIndex={spec.activeIndex} terminal={spec.terminal} />
      <div className="mt-3">
        <LifecycleStageEditor asset={asset} />
      </div>
    </Panel>
  );
}

function AutomationCard({ asset }: { asset: AssetInfo }) {
  return (
    <Panel title="Automation">
      <KnobEditor
        statesReadOnly={false}
        label="Automation"
        assetId={asset.id}
        current={asset.senseOnly ? 1 : 0}
        format={(v) => (v === 1 ? "Monitor only" : "Automation enabled")}
        makeOp={storeOp(asset.id, "sense_only", asset.senseOnly ? 1 : 0)}
        control={{
          type: "toggle",
          onValue: 1,
          offValue: 0,
          onLabel: "Monitor only",
          offLabel: "Automation enabled",
          onTone: "declined",
          offTone: "affirmative",
        }}
      />
    </Panel>
  );
}

/** The lifecycle edit affordance: a "change stage…" picker that names a target
 * without restating the current stage, and a Save that moves the row. The
 * stage lives in the store, so this writes through the Worker and works in
 * every deployment. `expect` is the stage the stepper was drawn from: a page
 * left open while the row moved elsewhere is refused rather than winning. */
function LifecycleStageEditor({ asset }: { asset: AssetInfo }) {
  const demoReadonly = useDemoReadonly();
  const moveStage = useAssetLifecycle(asset.id);
  const writable = !demoReadonly;
  const [target, setTarget] = useState<AssetStatus | "">("");
  const [saving, setSaving] = useState(false);

  // The poll brought a new stage (this save landed, or another surface moved
  // it): a target chosen against the old one is no longer what it meant.
  useEffect(() => {
    setTarget("");
  }, [asset.status]);

  function submit() {
    if (!writable || target === "" || target === asset.status) return;
    setSaving(true);
    void moveStage(asset.status, target)
      .then((ok) => {
        if (ok) setTarget("");
      })
      .finally(() => setSaving(false));
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={target}
        aria-label="Change lifecycle stage"
        disabled={saving || !writable}
        onChange={(e) => setTarget(e.target.value as AssetStatus | "")}
        className={fieldClass}
      >
        <option value="" disabled>
          Change stage…
        </option>
        {ASSET_STATUS.filter((s) => s !== asset.status).map((s) => (
          <option key={s} value={s}>
            {STATUS_LABEL[s]}
          </option>
        ))}
      </select>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={submit}
        disabled={saving || !writable || target === ""}
      >
        {saving ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}

function DataCollectionCard({ wiring, asset, nowMs }: { wiring: Wiring; asset: AssetInfo; nowMs: number }) {
  const pull = wiring.mode === "pull" ? wiring.pull : null;
  return (
    <Panel id="data-collection" title="Data collection">
      <NightlyReportScope asset={asset} wiring={wiring} statesReadOnly={false}>
        <div>
          <KnobRow
            label="Data collection"
            value={modeChip(wiring.mode, asset.id)}
          />

          {pull ? (
            <>
              <KnobEditor
                statesReadOnly={false}
                label="Metrics endpoint"
                assetId={asset.id}
                current={pull.url}
                format={(v) => String(v)}
                makeOp={fileOp("config/pull.json", toPointer([pull.index, "url"]), pull.url)}
                control={{ type: "text", validate: validateUrl, mono: true, placeholder: "https://…" }}
              />
              <KnobEditor
                statesReadOnly={false}
                label="Nightly fetch"
                assetId={asset.id}
                current={pull.enabled}
                format={(v) => (v ? "Enabled" : "Paused")}
                makeOp={fileOp("config/pull.json", toPointer([pull.index, "enabled"]), pull.enabled)}
                control={{
                  type: "toggle",
                  onValue: true,
                  offValue: false,
                  onLabel: "Enabled",
                  offLabel: "Paused",
                  onTone: "affirmative",
                  offTone: "declined",
                }}
              />
              <KnobRow
                label="Wire format"
                value={pull.format}
              />
              <KnobRow
                label="Auth source"
                value={<SecretPointer>{pull.auth}</SecretPointer>}
              />
            </>
          ) : null}

          {wiring.mode === "push" && wiring.push ? (
            <>
              <KnobRow
                label="Report endpoint"
                value={<span className="font-mono text-xs">{wiring.push.endpoint}</span>}
              />
              <KnobRow
                label="Auth source"
                value={<SecretPointer>{wiring.push.auth}</SecretPointer>}
              />
            </>
          ) : null}
          {wiring.mode === "push" && !asset.isOs ? <FetchEndpointEditor asset={asset.id} /> : null}

          {/* The schedule as saved, and the way to change it: the job's row in
              Settings → Data collection is one pick away. A pushing asset
              sends on its own clock and has no job to move. */}
          <KnobRow
            label="Schedule"
            value={
              wiring.schedule ? (
                <Link
                  to="/settings#data-collection"
                  className="inline-flex min-h-11 items-center gap-1 tabular-nums text-foreground underline-offset-4 hover:underline sm:min-h-0"
                  data-wiring-schedule={wiring.schedule.job}
                >
                  {wiring.schedule.enabled
                    ? scheduleLabel(wiring.schedule.cron, scheduleTimezone(wiring.schedule))
                    : "Paused"}
                  <Pencil aria-hidden className="size-3 text-muted-foreground" />
                </Link>
              ) : (
                "Nightly"
              )
            }
          />

          <KnobRow
            label="Last report"
            value={
              wiring.lastPulseReceivedAt ? (
                <span className="inline-flex items-center gap-2">
                  {wiring.lastPulseDate}
                  <AgeBadge
                    iso={wiring.lastPulseReceivedAt}
                    cadenceHours={CADENCE_HOURS.pulse}
                    nowMs={nowMs}
                  />
                </span>
              ) : (
                <span className="text-muted-foreground">None received yet</span>
              )
            }
          />
        </div>

        <div className="mt-3 flex flex-col gap-3">
          {pull?.metricMap ? <MetricMap map={pull.metricMap} /> : null}
          <WiringHealth wiring={wiring} nowMs={nowMs} />
        </div>
      </NightlyReportScope>
    </Panel>
  );
}

function MetricMap({
  map,
}: {
  map: { metric: string; counter: string }[];
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-foreground">Metric mapping</span>
      </div>
      <ul className="flex flex-col gap-0.5">
        {map.map((m) => (
          <li key={m.metric} className="flex items-center gap-2 font-mono text-xs">
            <span className="text-foreground">{m.metric}</span>
            <span aria-hidden className="text-muted-foreground">
              ←
            </span>
            <span className="text-muted-foreground">{m.counter}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function WiringHealth({ wiring, nowMs }: { wiring: Wiring; nowMs: number }) {
  const { pullFailure, ingestFreshness, lastPulseReceivedAt } = wiring;
  if (!pullFailure && !ingestFreshness) {
    // Before the first report there is nothing to be late: Last report above
    // already reads "None received yet", so this says nothing a second time.
    if (!lastPulseReceivedAt) return null;
    return (
      <KnobRow
        label="Freshness alerts"
        value={
          <span className="inline-flex items-center gap-2" data-freshness-alerts="none">
            <SeverityDot severity={null} />
            None open
          </span>
        }
      />
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      {ingestFreshness ? (
        <div className="flex items-start gap-2 text-sm">
          <SeverityDot severity="error" className="mt-1" />
          <span>
            <span className="font-medium text-error">Data is stale</span> —{" "}
            {ingestFreshness.message ?? "the nightly report has not arrived"} ·{" "}
            <span className="tabular-nums text-muted-foreground">
              {formatAge(ageMs(nowMs, ingestFreshness.firedAt))} ago
            </span>
          </span>
        </div>
      ) : null}
      {pullFailure ? (
        <div className="flex items-start gap-2 text-sm">
          <SeverityDot severity="warn" className="mt-1" />
          <span>
            <span className="font-medium text-warn">Fetch failing</span> —{" "}
            {pullFailure.message ?? "the last fetch did not succeed"} ·{" "}
            <span className="tabular-nums text-muted-foreground">
              {formatAge(ageMs(nowMs, pullFailure.firedAt))} ago
            </span>
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** Which alert rules are in force here: read-only, because they are
 * portfolio-wide, and one line saying where they are changed. */
function AlertRulesCard({ rules }: { rules: RulesInForce }) {
  return (
    <Panel
      title="Alert rules in force"
      count={rules.hasOverride ? "per-site override" : "no per-site override"}
      // Where every site's rules change: the header's "All →" slot.
      action={
        <Link
          to="/settings#alert-rules"
          className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline max-sm:-my-2.5 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
        >
          All sites' rules →
        </Link>
      }
    >
      <div>
        {/* No `explain` here: the values stay visible where they act, and the
            editors, with their one-line effects, live on Settings. */}
        {rules.knobs.map((k) => (
          <KnobRow
            key={k.key}
            label={k.label}
            value={k.value}
          />
        ))}
      </div>
    </Panel>
  );
}
// --- what the panel buys, editable -----------------------------------------

/** The sources a panel refresh reads (`SEARCH_LANES`, scripts/config-registers.mts). */
const SEARCH_LANE_IDS: ReadonlySet<string> = new Set(["gsc", "ga4", "bing-webmaster"]);

/**
 * Which terms this asset buys, and whether its local directory is kept
 * current. The spend is stated where it is decided: a term is a standing
 * weekly bill and review, guarded by the portfolio's monthly data cap.
 */
function PanelSettings({
  assetId,
  panelConfig,
  portfolio,
  integrations,
}: {
  assetId: string;
  panelConfig: AssetPanelConfig;
  portfolio: PortfolioConfig;
  integrations: AssetIntegrations;
}) {
  const queries = panelConfig.trackedQueries;
  // The fact the roster rule turns on, in the shape the declaration judges:
  // each data source's status as the file holds it (`declared`), never the
  // health the Tower derives (config/signal-panels.README.md).
  const laneStatuses = Object.fromEntries(
    integrations.lanes.map((lane) => [lane.catalog.id, lane.cell.declared]),
  );
  const tracked = queries?.length ?? 0;
  const dataCapUsd =
    portfolio.knobs.find((knob) => knob.key === "monthly_caps.data_usd")?.value ??
    null;

  // Nothing to set until there is search: with no live search source and
  // nothing tracked, the one next step is the source.
  const searchLive = integrations.lanes.some((lane) => SEARCH_LANE_IDS.has(lane.catalog.id) && lane.cell.declared === "live");
  const refreshOn = typeof panelConfig.roster === "object" && panelConfig.roster !== null && !Array.isArray(panelConfig.roster) && panelConfig.roster.enabled === true;
  if (!searchLive && tracked === 0 && !refreshOn) {
    return (
      <Panel id="tracked-panels" title="Tracked search terms">
        <Link
          to={`/assets/${encodeURIComponent(assetId)}/sources`}
          className="inline-flex min-h-11 items-center text-sm font-medium text-foreground underline-offset-4 hover:underline sm:min-h-0"
          data-tracked-terms-needs-search
        >
          Connect a search source first →
        </Link>
      </Panel>
    );
  }

  return (
    <Panel
      id="tracked-panels"
      title="Tracked search terms"
      count={`${formatInt(tracked)} of ${formatInt(SERP_PANEL_QUERY_LIMIT)} terms · ${formatUsd(
        tracked * SERP_PANEL_TERM_WEEKLY_USD,
        { cents: true },
      )} a week`}
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-3">
          <div
            className="flex flex-col gap-1.5 rounded-[10px] border border-border bg-background/40 p-3"
            data-panel-spend
          >
            <Meter
              value={tracked}
              max={SERP_PANEL_QUERY_LIMIT}
              ariaLabel={`${tracked} tracked terms against the ${SERP_PANEL_QUERY_LIMIT}-term panel ceiling`}
            />
            {/* The bill as facts: when a term is bought, on how many devices,
                and the cap it is bought against, as a link to where that cap
                is edited. The weekly total is the header's count; the meter
                is the room left. */}
            <span className="flex flex-wrap items-center gap-1.5" data-panel-bill>
              <StateChip tone="neutral" label="Weekly · Mondays" subject={`serp-panel:${assetId}`} />
              <StateChip tone="neutral" label={`${SERP_PANEL_DEVICES.length} devices`} subject={`serp-panel:${assetId}`} />
              <Link
                to="/settings#budget"
                className="inline-flex min-h-11 items-center text-xs font-medium text-foreground underline-offset-4 hover:underline sm:min-h-0"
              >
                {dataCapUsd === null ? "Data cap" : `Data cap ${formatUsd(dataCapUsd)} / month`} →
              </Link>
            </span>
          </div>

          {/* The rows go behind one press: each tracked term is two inputs and
              two Save buttons, and the decision that costs money is adding a
              term, which the meter and the bill chips above state whether or
              not the list is open. The count is in the summary. */}
          <details className="group">
            {/* The disclosure owns the control, the eyebrow owns the type:
                `SectionLabel` never renders a `<summary>`, so the summary
                keeps the control chrome and the header inside it is the
                vocabulary's. */}
            <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              <ChevronRight
                aria-hidden
                className="size-3.5 shrink-0 group-open:rotate-90 motion-safe:transition-transform"
              />
              <SectionLabel title="Tracked queries" caption={formatInt(tracked)} />
            </summary>
            <CollectionEditor
              statesReadOnly={false}
              register="serp-panel-queries"
              params={{ asset: assetId }}
              rows={queries}
              // The bets this panel already names, as a picker: grouping is an
              // exact string match, and a refusal an operator can only satisfy
              // by retyping a string they cannot see is the friction the
              // picker removes.
              fieldOptions={panelClusters(queries)}
              refuseAdd={(rows) =>
                rows.length >= SERP_PANEL_QUERY_LIMIT
                  ? `Panel full at ${SERP_PANEL_QUERY_LIMIT} terms — remove one first`
                  : null
              }
              slug="tracked-queries"
            />
          </details>
        </div>

        <CollectionEditor
          statesReadOnly={false}
          register="signal-panels"
          params={{ asset: assetId }}
          rows={panelConfig.roster === null ? {} : { [assetId]: panelConfig.roster }}
          oneRow
          // Turning this row on is a claim about another file, and the rule is
          // that file's README's: an asset is on the roster when at least one
          // of its Search Console / Analytics / Bing Webmaster data sources is
          // live in config/integrations.json. A refresh pass over an asset with
          // none writes an empty panel directory, indistinguishable on disk
          // from a collapsed one.
          refuseField={(field, value) =>
            liveSearchLaneRefusal(field, laneStatuses, value)
          }
          slug="panel-refresh-roster"
          // Low risk and free (a refresh pass makes no provider call), so the
          // row saves as it is picked, with Undo under the cell. The tracked
          // terms above cost money per week and keep their Save.
          commit="auto"
          title="Panel refresh"
          describe="Rebuilt daily"
          emptyHint="Required"
        />
      </div>
    </Panel>
  );
}

/** The cluster labels this panel's own terms already carry, in file order and
 * without repeats. The catalog decides what the list means; this only gathers
 * it. */
function panelClusters(
  queries: JsonValue[] | null,
): Record<string, string[]> | undefined {
  const register = configRegister("serp-panel-queries");
  const cluster = register.clusterField;
  if (cluster === undefined || queries === null) return undefined;
  const labels: string[] = [];
  for (const row of queries) {
    const label = rowValue(register, row)[cluster];
    if (
      typeof label === "string" &&
      label.trim() !== "" &&
      !labels.includes(label)
    ) {
      labels.push(label);
    }
  }
  return labels.length === 0 ? undefined : { [cluster]: labels };
}
