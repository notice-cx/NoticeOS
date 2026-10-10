import { ArrowRight, ExternalLink, Loader2, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { CollectNowRefusal, CollectNowResult, CollectNowSite, IntegrationProvider } from "@noticeos/contract";
import { integrationFailureMessage } from "@noticeos/contract/integration-health";
import type { ConnectionKind, SiteStatus } from "@shared/connection-status";
import { providerName } from "@shared/connect-panel";
import {
  chosenSite,
  initialSelection,
  marketOf,
  planSites,
  rowCollectable,
  rowDecision,
  rowFunnels,
  spendFor,
  startPlan,
  unclaimedSites,
  type RowDecision,
  type SiteExclusion,
  type SiteLane,
  type SiteRow,
  type SitePlan,
  type SiteSelection,
  type SitesPayload,
  type StartPlan,
} from "@shared/site-discovery";
import { marketLabel } from "@shared/site-markets";
import { siteCount } from "@shared/site-noun";
import { DeclineReasons } from "@/components/DeclineReasons";
import { IntegrationStateChip } from "@/components/IntegrationStateChip";
import { Meter } from "@/components/Meter";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { StateChip, type StatusSubject } from "@/components/StateChip";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface SitePickerProps {
  provider: IntegrationProvider;
  /** `GET …/sites`; undefined while it is read. */
  payload: SitesPayload | undefined;
  /** The read itself failed (the Tower could not ask). */
  failed?: boolean;
  onRetry?: () => void;
  /** The asset the panel was opened from: it leads the list, ticked. */
  preselect?: string | null;
  /** Save the confirmed mapping (and any Not using) and collect. Resolves with
   * the run's answer; `"saved"` when the plan collects nothing and only its
   * writes were made; null when the save was refused (the refusal has been
   * said already). */
  onStart: (plan: StartPlan) => Promise<CollectNowResult | "saved" | null>;
  /** The connection model's status for one collected site, once it is read. */
  siteStatus?: (asset: string) => { kind: ConnectionKind; site: SiteStatus | null } | null;
  /** Told once Start has been pressed, so the panel's header can switch from
   * the key's answer to the connection's status. */
  onStarted?: () => void;
  onClose: () => void;
}

const NOTHING_CHOSEN: SiteSelection = { checked: new Set(), picks: {}, declined: {} };

type Phase =
  | { phase: "choosing" }
  | { phase: "starting"; assets: string[]; declined: string[] }
  /** `result` is null when the press only saved (every row was Not using). */
  | { phase: "started"; assets: string[]; declined: string[]; result: CollectNowResult | null };

/**
 * The connect panel's second screen. Every portfolio asset is a row: ticked
 * where the account holds a site on its own domain (a suggestion — nothing is
 * written before Start), with what the account holds for it, or why it cannot
 * be collected. Sites the account holds that match no asset are listed under
 * the rows; none is dropped. Start writes the Data sources tab's own mapping
 * operations for the ticked rows and runs the first collection through the
 * scheduled job's step; each row then wears the connection model's status —
 * Collecting until a result is stored, then Working or Failing.
 *
 * A metered provider (DataForSEO) states its spend before the press: the
 * typical week from the OS's own cost records, and this month against the cap.
 *
 * An unticked box is not a decision. Unticking a row the scheduled job
 * collects anyway opens the Not using reason chips, and the row reads "Still
 * collected" until one is picked; the reason is saved with Start
 * (`declineOps`). No reason is preselected. The spend preview counts every
 * site the weekly job will bill, undecided ones included.
 */
export function SitePicker({
  provider,
  payload,
  failed = false,
  onRetry,
  preselect = null,
  onStart,
  siteStatus,
  onStarted,
  onClose,
}: SitePickerProps) {
  const plan = useMemo(() => (payload ? planSites(payload, preselect) : null), [payload, preselect]);
  // The selection belongs to the plan it was made on: a new plan starts from
  // its own suggestions in the same render, so Start is never drawn disabled
  // for one frame over rows that are already ticked.
  const [chosen, setChosen] = useState<{ plan: SitePlan | null; selection: SiteSelection }>({ plan: null, selection: NOTHING_CHOSEN });
  if (plan !== null && chosen.plan !== plan) setChosen({ plan, selection: initialSelection(plan) });
  const selection = plan !== null && chosen.plan === plan ? chosen.selection : plan ? initialSelection(plan) : NOTHING_CHOSEN;
  const setSelection = (change: (current: SiteSelection) => SiteSelection) =>
    setChosen((current) => ({ plan: current.plan, selection: change(current.selection) }));
  const [phase, setPhase] = useState<Phase>({ phase: "choosing" });
  // Focus follows the panel's primary action: the form the key was typed in
  // has just gone, so Start (then Open, or Done) is where Enter should land.
  // Never away from the operator, though: once they have
  // pressed a key or pointed while the list loads — Tab to Replace, say — a
  // list that arrives late leaves focus where they put it, unless the control
  // it was on has gone. Otherwise their next Enter would press Start.
  const primary = useRef<HTMLElement | null>(null);
  const keep = (node: HTMLElement | null) => { primary.current = node; };
  const steered = useRef(false);
  useEffect(() => {
    const steer = () => { steered.current = true; };
    document.addEventListener("keydown", steer, true);
    document.addEventListener("pointerdown", steer, true);
    return () => {
      document.removeEventListener("keydown", steer, true);
      document.removeEventListener("pointerdown", steer, true);
    };
  }, []);
  useEffect(() => {
    if (!plan || phase.phase === "starting") return;
    const dropped = document.activeElement === null || document.activeElement === document.body;
    if (dropped || !steered.current) primary.current?.focus();
  }, [plan, phase.phase]);

  const name = providerName(provider);
  const discovery = payload?.discovery;
  const refused = discovery !== undefined && !discovery.ok;

  if (phase.phase !== "choosing" && plan) {
    const rows = plan.rows.filter((row) => phase.assets.includes(row.asset.id));
    const declinedRows = plan.rows.filter((row) => phase.declined.includes(row.asset.id));
    const result = phase.phase === "started" ? phase.result : null;
    const outcome = (asset: string) => (result?.ok ? result.sites.find((site) => site.asset === asset) ?? null : null);
    const only = rows.length === 1 ? rows[0]! : null;
    return (
      <div className="flex flex-1 flex-col gap-4" data-site-picker={provider.id} data-sites-phase={phase.phase}>
        <ul className="overflow-hidden rounded-xl border border-border">
          {rows.map((row) => {
            const shown = phase.phase === "starting" || (result !== null && !result.ok) ? null : siteStatus?.(row.asset.id) ?? null;
            const kind: ConnectionKind = result !== null && !result.ok ? "not-checked" : shown?.kind ?? "collecting";
            return (
              <li key={row.asset.id} className="flex min-h-14 items-center gap-3 border-t border-border px-4 py-3 first:border-t-0" data-site-row={row.asset.id} data-subject={`site:${provider.id}:${row.asset.id}`}>
                <PropertyFavicon domain={row.asset.domain ?? row.asset.id} displayName={row.asset.label} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{row.asset.label}</span>
                  <StartedCaption
                    row={row}
                    outcome={outcome(row.asset.id)}
                    status={shown}
                    detail={row.lanes.map((lane) => choiceDetail(row, lane, selection, plan.kind)).filter(Boolean).join(" · ")}
                  />
                </span>
                {result === null || result.ok ? (
                  <IntegrationStateChip state={kind} subject={`site:${provider.id}:${row.asset.id}`} />
                ) : null}
              </li>
            );
          })}
          {/* Saved as Not using in the same press: the reason in the
              operator's words, and the state the Data sources row now reads. */}
          {declinedRows.map((row) => (
            <li key={row.asset.id} className="flex min-h-14 items-center gap-3 border-t border-border px-4 py-3 first:border-t-0" data-site-row={row.asset.id} data-site-decision="not-using" data-subject={`site:${provider.id}:${row.asset.id}`}>
              <PropertyFavicon domain={row.asset.domain ?? row.asset.id} displayName={row.asset.label} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{row.asset.label}</span>
                <span className="truncate text-xs text-muted-foreground">{selection.declined?.[row.asset.id] ?? ""}</span>
              </span>
              <IntegrationStateChip state="not-using" subject={`site:${provider.id}:${row.asset.id}`} />
            </li>
          ))}
        </ul>
        {result !== null && !result.ok ? <Refusal error={result.error} /> : null}
        {result !== null && result.ok && payload?.spend ? <SpentFact sites={result.sites} /> : null}
        <div className="mt-auto flex flex-col gap-2">
          {only && result !== null && result.ok ? (
            <Button asChild variant="outline" className="w-full">
              <Link ref={keep} to={`/assets/${encodeURIComponent(only.asset.id)}`} onClick={onClose}>
                Open {only.asset.label}
                <ArrowRight aria-hidden />
              </Link>
            </Button>
          ) : (
            <Button ref={keep} type="button" variant="outline" className="w-full" onClick={onClose} disabled={phase.phase === "starting"}>
              Done
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (!plan || refused || failed) {
    return (
      <div className="flex flex-1 flex-col gap-4" data-site-picker={provider.id}>
        {failed || refused ? (
          <p className="flex items-center gap-2 text-sm text-error" data-sites-state="failed">
            <TriangleAlert className="size-4 shrink-0" aria-hidden />
            {refused && discovery?.reason === "refused" ? `${name} refused the key` : `${name} did not answer`}
            {onRetry ? (
              <Button type="button" size="sm" variant="outline" className="ms-auto" onClick={onRetry}>
                Try again
              </Button>
            ) : null}
          </p>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" data-sites-state="loading">
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
            Finding sites
          </p>
        )}
        <Button type="button" variant="outline" className="mt-auto w-full" onClick={onClose}>
          Done
        </Button>
      </div>
    );
  }

  const decisions = new Map(plan.rows.map((row) => [row.asset.id, rowDecision(row, selection)]));
  const tally = (decision: RowDecision) => plan.rows.filter((row) => decisions.get(row.asset.id) === decision).length;
  const confirmed = plan.rows.filter((row) => decisions.get(row.asset.id) === "collect");
  const notUsing = tally("not-using");
  const undecided = tally("undecided");
  const others = unclaimedSites(plan, selection);
  const metered = payload?.spend ?? null;
  const verb = metered ? "Start weekly reports" : "Start collecting";
  const count = siteCount(confirmed.length);
  // A press that only declines is a save, not a start; a press that does
  // both says both.
  const label = [confirmed.length > 0 || notUsing === 0 ? `${verb} · ${count}` : "Save", notUsing > 0 ? `${notUsing} not using` : null]
    .filter(Boolean)
    .join(" · ");

  const toggle = (row: SiteRow, on: boolean) => setSelection((current) => {
    const checked = new Set(current.checked);
    const declined = { ...(current.declined ?? {}) };
    if (on) {
      checked.add(row.asset.id);
      // Ticked again: collected, so no longer declined.
      delete declined[row.asset.id];
    } else checked.delete(row.asset.id);
    return { ...current, checked, declined };
  });
  const decline = (row: SiteRow, reason: string) => setSelection((current) => ({
    ...current,
    declined: { ...(current.declined ?? {}), [row.asset.id]: reason },
  }));
  const pick = (row: SiteRow, lane: SiteLane, ref: string) => setSelection((current) => {
    const lanes = { ...(current.picks[row.asset.id] ?? {}) };
    if (ref === "") delete lanes[lane.lane];
    else lanes[lane.lane] = ref;
    const checked = new Set(current.checked);
    if (ref === "") checked.delete(row.asset.id);
    else checked.add(row.asset.id);
    return { checked, picks: { ...current.picks, [row.asset.id]: lanes } };
  });

  async function start() {
    const next = startPlan(plan!, selection);
    if (next.assets.length === 0 && next.declined.length === 0) return;
    setPhase({ phase: "starting", assets: next.assets, declined: next.declined });
    onStarted?.();
    const result = await onStart(next).catch(() => null);
    if (result === null) {
      setPhase({ phase: "choosing" });
      return;
    }
    setPhase({ phase: "started", assets: next.assets, declined: next.declined, result: result === "saved" ? null : result });
  }

  return (
    <div className="flex flex-1 flex-col gap-4" data-site-picker={provider.id} data-sites-phase="choosing">
      {plan.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-sites-state="empty">No sites yet</p>
      ) : (
        <ul aria-label="Sites" className="overflow-hidden rounded-xl border border-border">
          {plan.rows.map((row) => (
            <ChoiceRow
              key={row.asset.id}
              provider={provider}
              row={row}
              selection={selection}
              kind={plan.kind}
              decision={decisions.get(row.asset.id) ?? null}
              onToggle={(on) => toggle(row, on)}
              onPick={(lane, ref) => pick(row, lane, ref)}
              onDecline={(reason) => decline(row, reason)}
            />
          ))}
        </ul>
      )}
      {others.length > 0 ? (
        <section aria-labelledby={`${provider.id}-other-sites`} className="flex flex-col gap-2" data-other-sites>
          <h3 id={`${provider.id}-other-sites`} className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            No matching site · <span className="tabular-nums">{others.length}</span>
          </h3>
          <ul className="overflow-hidden rounded-xl border border-border">
            {others.map((site) => (
              <li key={site.ref} className="flex min-h-11 items-center gap-3 border-t border-border px-4 py-2 first:border-t-0" data-other-site={site.ref} data-subject={`account-site:${provider.id}:${site.ref}`}>
                <code className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{site.label}</code>
                {site.ready ? null : <StateChip tone="na" label="Not verified" subject={`account-site:${provider.id}:${site.ref}`} />}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {/* Every site the weekly job will bill: the ticked ones, and the
          unticked ones nobody has declined yet. */}
      {metered ? <SpendPreview spend={metered} sites={confirmed.length + undecided} /> : null}
      <Button ref={keep} type="button" className="mt-auto w-full tabular-nums" disabled={confirmed.length === 0 && notUsing === 0} onClick={() => void start()} data-sites-start>
        {label}
      </Button>
    </div>
  );
}

/** What a row's picker chooses, where a provider collects more than one kind
 * of site on one row (Google: a GA4 property and a Search Console site). */
const LANE_PICK: Record<string, string> = {
  ga4: "GA4 property",
  gsc: "Search Console site",
};

const EXCLUSION: Record<SiteExclusion, string> = {
  "not-using": "Not using",
  "not-applicable": "Doesn't apply",
  "pre-launch": "Pre-launch",
  "no-domain": "No domain",
};

/** One asset on the choosing screen. */
function ChoiceRow({
  provider,
  row,
  selection,
  kind,
  decision,
  onToggle,
  onPick,
  onDecline,
}: {
  provider: IntegrationProvider;
  row: SiteRow;
  selection: SiteSelection;
  kind: "account" | "portfolio";
  /** What Start will do with this row (`rowDecision`). */
  decision: RowDecision | null;
  onToggle: (on: boolean) => void;
  onPick: (lane: SiteLane, ref: string) => void;
  onDecline: (reason: string) => void;
}) {
  const collectable = rowCollectable(row, selection);
  const checked = collectable && selection.checked.has(row.asset.id);
  const unlisted = row.lanes.filter((lane) => lane.state === "unlisted");
  const choosable = row.excluded === null ? unlisted.filter((lane) => lane.choices.length > 0) : [];
  const addSite = provider.connect?.addSite;
  const id = `site-${provider.id}-${row.asset.id}`;
  const reason = selection.declined?.[row.asset.id] ?? null;
  const funnels = rowFunnels(row, selection);
  let action: ReactNode = null;
  const subject: StatusSubject = `site:${provider.id}:${row.asset.id}`;
  if (row.excluded) action = <StateChip tone={row.excluded === "not-using" ? "declined" : "na"} label={EXCLUSION[row.excluded]} dot="hollow" subject={subject} />;
  // Unticked but still on the job's schedule: the row says what will happen
  // until a reason says otherwise.
  else if (decision === "undecided") action = <StateChip tone="caution" label="Still collected" subject={subject} />;
  else if (decision === "not-using") action = <StateChip tone="declined" label="Not using" dot="hollow" subject={subject} />;
  else if (row.lanes.some((lane) => lane.state === "not-ready")) action = <StateChip tone="na" label="Not verified" subject={subject} />;
  // PostHog: the funnels this row brings from its project's saved insights,
  // picked up, never typed.
  else if (funnels > 0) action = <StateChip tone="neutral" label={`${funnels} ${funnels === 1 ? "funnel" : "funnels"}`} subject={subject} />;
  else if (choosable.length === 0 && unlisted.length === row.lanes.length && kind === "account" && addSite) {
    action = (
      <Button asChild variant="outline" size="sm">
        <a href={addSite.url} target="_blank" rel="noreferrer">
          {addSite.label}
          <ExternalLink aria-hidden />
        </a>
      </Button>
    );
  }
  return (
    <li
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-4 py-3 first:border-t-0"
      data-site-row={row.asset.id}
      data-subject={subject}
      data-site-state={row.excluded ?? row.lanes.map((lane) => lane.state).join(" ")}
      data-site-checked={checked ? "" : undefined}
      data-site-decision={decision === "undecided" || decision === "not-using" ? decision : undefined}
    >
      {/* Wide enough to read its detail whole: on a phone the row's action
          drops under it rather than clipping "Not in this account". */}
      <label htmlFor={id} className={cn("flex min-h-11 min-w-[13rem] flex-1 items-center gap-3", collectable ? "cursor-pointer" : "cursor-default")}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={!collectable}
          onChange={(event) => onToggle(event.target.checked)}
          className="size-4 shrink-0 accent-primary disabled:opacity-40"
        />
        <PropertyFavicon domain={row.asset.domain ?? row.asset.id} displayName={row.asset.label} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{row.asset.label}</span>
          <span className="truncate font-mono text-xs text-muted-foreground" data-site-detail>
            {row.lanes.map((lane) => choiceDetail(row, lane, selection, kind)).filter(Boolean).join(" · ") || "Not in this account"}
          </span>
        </span>
      </label>
      {action}
      {choosable.map((lane) => (
        <select
          key={lane.lane}
          aria-label={`${LANE_PICK[lane.lane] ?? "Site"} for ${row.asset.label}`}
          value={selection.picks[row.asset.id]?.[lane.lane] ?? ""}
          onChange={(event) => onPick(lane, event.target.value)}
          className={cn(fieldClass, "h-11 max-w-full basis-full px-2 text-sm sm:h-9 sm:basis-auto")}
          data-site-pick={lane.lane}
        >
          <option value="">{LANE_PICK[lane.lane] ?? "Choose site"}</option>
          {lane.choices.map((site) => (
            <option key={site.ref} value={site.ref}>
              {site.label}
            </option>
          ))}
        </select>
      ))}
      {/* The reason, on the row, the moment it is unticked — the same chips
          the Data sources row offers. Saved with Start; ticking the row again
          takes the decline back. */}
      {decision === "undecided" || decision === "not-using" ? (
        <div className="basis-full ps-7">
          <DeclineReasons subject={row.asset.label} selected={reason} onChoose={onDecline} />
        </div>
      ) : null}
    </li>
  );
}

/** What a row says under its name while choosing: the site it will be
 * collected from, its market, or that the account lists nothing for it. */
function choiceDetail(row: SiteRow, lane: SiteLane, selection: SiteSelection, kind: "account" | "portfolio"): string {
  if (kind === "portfolio") return lane.site ? marketLabel(marketOf(lane)) : "";
  const site = chosenSite(row, lane, selection) ?? lane.site;
  if (!site) return lane.choices.length > 0 ? "" : "Not in this account";
  // A PostHog project reads as its name and the number its PostHog address
  // shows; a GA4 property as its number.
  const project = site.mapping.projectId;
  if (project !== undefined) return `${site.label} · ${project}`;
  const property = site.mapping.propertyId;
  return property !== undefined ? `GA4 ${property}` : site.label;
}

/** Under a collected row: why it failed, what it cost, or the site itself. */
function StartedCaption({
  row,
  outcome,
  status,
  detail,
}: {
  row: SiteRow;
  outcome: CollectNowSite | null;
  status: { kind: ConnectionKind; site: SiteStatus | null } | null;
  /** What the row read while choosing: the site it is collected from. */
  detail: string;
}) {
  const failure = status?.kind === "failing" ? status.site?.failure ?? null : null;
  if (failure) return <span className="truncate text-xs text-error">{integrationFailureMessage(failure)}</span>;
  if (outcome?.outcome === "unmeasured") return <span className="truncate text-xs text-muted-foreground">Not reached</span>;
  if (outcome?.reports !== undefined && outcome.outcome === "collected") {
    return (
      <span className="truncate text-xs text-muted-foreground tabular-nums">
        {outcome.reports} {outcome.reports === 1 ? "report" : "reports"}
        {outcome.costUsd !== undefined ? ` · ${formatUsd(outcome.costUsd, { cents: true })}` : ""}
      </span>
    );
  }
  return <span className="truncate font-mono text-xs text-muted-foreground">{detail || row.asset.domain || ""}</span>;
}

const REFUSAL: Record<CollectNowRefusal, string> = {
  paused: "Schedule paused",
  "in-flight": "Already collecting · try again soon",
  "not-connected": "Not connected",
  "no-sites": "Nothing to collect",
  "not-supported": "Collects on its schedule",
};

function Refusal({ error }: { error: CollectNowRefusal }) {
  return (
    <p className="flex items-center gap-2 text-sm text-warn" data-collect-refusal={error}>
      <TriangleAlert className="size-4 shrink-0" aria-hidden />
      {REFUSAL[error]}
      {error === "paused" ? (
        <Link to="/health/operations" className="ms-auto text-xs underline underline-offset-4">
          Schedules
        </Link>
      ) : null}
    </p>
  );
}

/** A metered provider's spend, before the press: the typical week for the
 * ticked sites (or its ceiling, before any cost has been recorded) and this
 * month against the cap, as label/value pairs. */
function SpendPreview({ spend, sites }: { spend: NonNullable<SitesPayload["spend"]>; sites: number }) {
  const { weekUsd, ceilingUsd } = spendFor(spend, sites);
  const projected = spend.spentUsd + (weekUsd ?? ceilingUsd);
  return (
    <div className="flex flex-col gap-2" data-spend-preview>
      <Meter value={projected} max={spend.capUsd} ariaLabel="This month's spend with these reports" />
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{weekUsd === null ? "First reports, at most" : "Weekly cost"}</dt>
        <dd className="text-end tabular-nums" data-spend-week>
          {weekUsd === null ? formatUsd(ceilingUsd, { cents: true }) : `≈ ${formatUsd(weekUsd, { cents: true })}`}
        </dd>
        <dt className="text-muted-foreground">This month</dt>
        <dd className="text-end tabular-nums" data-spend-month>
          {formatUsd(spend.spentUsd, { cents: true })} of {formatUsd(spend.capUsd)}
          <UnknownPriceCount count={spend.unknownPrices} />
        </dd>
      </dl>
    </div>
  );
}

/** What the first paid collection actually cost, from the run's own record. */
function SpentFact({ sites }: { sites: CollectNowSite[] }) {
  const total = sites.reduce((sum, site) => sum + (site.costUsd ?? 0), 0);
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 text-sm" data-spend-spent>
      <dt className="text-muted-foreground">Spent</dt>
      <dd className="text-end tabular-nums">{formatUsd(total, { cents: true })}</dd>
    </dl>
  );
}

export default SitePicker;
import { UnknownPriceCount } from "@/components/UnknownPriceCount";
