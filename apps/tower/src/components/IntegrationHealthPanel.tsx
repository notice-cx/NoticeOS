import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Check, ChevronDown, CircleHelp, Plug, TriangleAlert } from 'lucide-react';
import { integrationFailureMessage } from '@noticeos/contract/integration-health';
import { acceptedAs, type IntegrationProviderStatus } from '@noticeos/contract/integrations';
import {
  connectionCounts,
  connectionHistoryGap,
  currentHealth,
  needsOperator,
  providerStatuses,
  reportOf,
  siteStatuses,
  type ConnectionCounts,
  type ConnectionStatus,
  type IntegrationHealthResponse,
  type SiteStatus,
  type WorkStatus,
} from '@shared/connection-status';
import { integrationProviderName } from '@shared/integration-status';
import { workflowRunAge } from '@shared/workflows';
import { utcRunReference } from '@shared/scheduled-jobs';
import { ConnectionFacts, IntegrationStateChip } from './IntegrationStateChip';
import { IntegrationLogo } from './IntegrationLogo';
import { StateChip, type StatusSubject } from './StateChip';
import { Kpi, KpiStrip } from './surface/KpiStrip';
import { SectionLabel } from './surface/SectionLabel';
import { cn } from '@/lib/utils';

function Age({ at, nowMs }: { at: string | null; nowMs: number }) {
  return at ? <time dateTime={at} title={`${new Date(at).toLocaleString()} · ${utcRunReference(at)}`}>{workflowRunAge(at, nowMs).toLowerCase()}</time> : <>—</>;
}

const shortDate = (date: string) => new Date(`${date}T00:00:00.000Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const WORK_ORDER: Record<WorkStatus['kind'], number> = { failing: 0, overdue: 1, unknown: 2, collecting: 3, working: 4, 'not-using': 5, idle: 6 };

/** Distinct report dates, oldest first; past six, the first five and a count. */
function dateList(items: WorkStatus['missing']): string {
  const dates = [...new Set(items.map((item) => reportOf(item).date).filter(Boolean))].sort();
  const shown = dates.length > 6 ? [...dates.slice(0, 5).map(shortDate), `+${dates.length - 5}`] : dates.map(shortDate);
  return shown.join(' · ');
}

/** One operation on a site, its reports folded together: the status it is in
 * when that is not simply working, and the dates it is missing. */
function Operation({ works, subject, site }: { works: WorkStatus[]; subject: StatusSubject; site: SiteStatus['kind'] }) {
  const kind = [...works].sort((a, b) => WORK_ORDER[a.kind] - WORK_ORDER[b.kind])[0]!.kind;
  const failing = works.filter((work) => work.kind === 'failing' && work.report).length;
  const missing = works.flatMap((work) => work.missing);
  const incomplete = works.flatMap((work) => work.incomplete);
  // Under its provider's heading an operation never repeats the provider's
  // name: "Bing daily reports" reads "Daily reports" there.
  const label = works[0]!.label.replace(/^(Bing|Google|Mediavine|PostHog|Clarity|Discord|Calendar)\s+(\w)/, (_, _name: string, first: string) => first.toUpperCase());
  return <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 py-2.5 first:border-t-0" data-work={works[0]!.capability} data-subject={`${subject}:${works[0]!.capability}`}>
    <span className="flex items-center gap-1.5 text-sm font-medium">
      {kind === 'failing' && site === 'failing' ? <TriangleAlert className="size-3.5 shrink-0 text-error" aria-label="Failing" /> : null}
      {label}
    </span>
    {kind !== 'working' && kind !== 'idle' && kind !== site ? <IntegrationStateChip state={kind} subject={`${subject}:${works[0]!.capability}`} /> : null}
    {failing > 1 ? <span className="text-xs tabular-nums text-muted-foreground">{failing} reports</span> : null}
    {missing.length > 0 ? <span className="text-xs tabular-nums text-muted-foreground" data-missing-dates>{missing.length} missing · {dateList(missing)}</span> : null}
    {incomplete.length > 0 ? <span className="text-xs tabular-nums text-muted-foreground" data-incomplete-dates>{incomplete.length} incomplete · {dateList(incomplete)}</span> : null}
  </li>;
}

/** One site under its provider: its own status, facts and — when it fails —
 * why, on the row; open it for what to do and which operations and dates. */
function Site({ site, provider, nowMs }: { site: SiteStatus; provider: string; nowMs: number }) {
  const [open, setOpen] = useState(false);
  const subject: StatusSubject = `site:${provider}:${site.key || 'account'}`;
  const byCapability = new Map<string, WorkStatus[]>();
  for (const work of site.works) {
    if ((work.kind === 'working' || work.kind === 'idle') && work.missing.length === 0 && work.incomplete.length === 0) continue;
    byCapability.set(work.capability, [...(byCapability.get(work.capability) ?? []), work]);
  }
  const reason = site.kind === 'failing' && site.failure ? integrationFailureMessage(site.failure) : null;
  const name = site.asset ?? (site.key || 'Account');
  const head = <>
    <span className="min-w-0 truncate text-sm font-medium">{name}</span>
    {reason ? <span className="flex items-center gap-1 text-xs text-error" data-site-reason><TriangleAlert className="size-3.5 shrink-0" aria-hidden />{reason}</span> : null}
    <span className="flex flex-wrap items-center gap-1.5 sm:ms-auto">
      <IntegrationStateChip state={site.kind} subject={subject} />
      <ConnectionFacts status={site} subject={subject} />
    </span>
    <span className="hidden w-28 shrink-0 items-center justify-end gap-1 text-xs tabular-nums text-muted-foreground sm:flex" title="Last success">
      {site.lastSuccessAt ? <><Check className="size-3" aria-label="Last success" /><Age at={site.lastSuccessAt} nowMs={nowMs} /></> : '—'}
    </span>
  </>;
  if (byCapability.size === 0) {
    return <li className="flex min-h-12 flex-col items-start gap-1 border-t border-border/60 px-4 py-2 sm:flex-row sm:items-center sm:gap-3 md:px-6" data-site={site.key} data-subject={subject}>{head}<span className="size-4 shrink-0" aria-hidden /></li>;
  }
  return <li className="border-t border-border/60" data-site={site.key} data-subject={subject}>
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="group/site">
      <summary className="flex min-h-12 cursor-pointer list-none flex-col items-start gap-1 px-4 py-2 outline-none hover:bg-muted/25 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:flex-row sm:items-center sm:gap-3 md:px-6 [&::-webkit-details-marker]:hidden">
        {head}
        <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open/site:rotate-180 max-sm:hidden" aria-hidden />
      </summary>
      {open ? <div className="bg-muted/15 px-4 pb-2 md:px-6">
        {site.kind === 'failing' && site.failure ? <p className="pt-2 text-xs text-foreground" data-site-action>{site.failure.action}</p> : null}
        <ul aria-label={`${name} operations`}>{[...byCapability.values()].map((works) => <Operation key={works[0]!.capability} works={works} subject={subject} site={site.kind} />)}</ul>
        {site.asset ? <Link to={`/assets/${encodeURIComponent(site.asset)}/sources`} className="inline-flex min-h-11 items-center text-xs font-medium underline underline-offset-4">Open {site.asset}</Link> : null}
      </div> : null}
    </details>
  </li>;
}

/** Does this connection need the operator now? Unknown is never quietly fine. */
const needsYou = (status: ConnectionStatus) => needsOperator(status) > 0 || status.kind === 'unknown';

/**
 * CONNECTIONS, GROUPED BY PROVIDER, THEN SITE (bead `ro-ujb9.96.7.3`). Every
 * operation used to be its own row wearing its provider's name and its worst
 * result, so one outage painted five providers red and Google appeared eight
 * times. Now a provider is one row with its one status and its facts, and the
 * sites that need the operator sit under it with their own status. Scoped to
 * one provider (its own page), it is that provider's sites.
 */
export function IntegrationHealthPanel({ data, isError = false, nowMs, provider, providers }: {
  data?: IntegrationHealthResponse;
  isError?: boolean;
  nowMs: number;
  /** Scope to one provider's sites (its own page). */
  provider?: string;
  /** The stored credentials, for each provider's connection status. */
  providers?: readonly IntegrationProviderStatus[];
}) {
  const health = currentHealth(data, isError, nowMs);
  const [chosen, setChosen] = useState<'needs' | 'all' | null>(null);
  const section = useRef<HTMLElement>(null);
  const headingId = useId();
  const { hash } = useLocation();
  const hasData = Boolean(data);
  useEffect(() => {
    if (provider || !['#integration-health', '#live-traffic'].includes(hash)) return;
    section.current?.scrollIntoView?.({ block: 'start' }); section.current?.focus({ preventScroll: true });
  }, [hash, provider, hasData]);

  if (provider) {
    const sites = siteStatuses(health.items.filter((item) => item.provider === provider && item.state !== 'disconnected'));
    if (sites.length === 0) return null;
    return <section aria-labelledby={headingId} className="flex flex-col gap-2" data-provider-sites={provider}>
      <SectionLabel id={headingId} title="Sites" caption={<span className="tabular-nums">{sites.length}</span>} />
      <ul aria-label="Sites" className="overflow-hidden rounded-xl border border-border bg-card [&>li:first-child]:border-t-0">
        {sites.map((site) => <Site key={site.key} site={site} provider={provider} nowMs={nowMs} />)}
      </ul>
    </section>;
  }

  const statuses = providerStatuses(providers ?? [], health.items);
  const pressing = statuses.filter(({ status }) => needsYou(status));
  // Needs you first, always (D45): with nothing pressing it says "Nothing
  // needs you" rather than opening on every provider again — the whole list
  // is Integrations', one press away under All.
  const filter = chosen ?? 'needs';
  const shown = filter === 'needs' ? pressing : statuses;
  // The connection model's four counts, from its one derivation (bead
  // ro-ujb9.96.7.15) — the same one the daily record of them uses
  // (worker/connection-status-daily.ts, bead ro-ujb9.96.7.26).
  const counts = connectionCounts(statuses.map(({ status }) => status));
  // Both reads, current, or nothing here may read as fine.
  const known = hasData && health.current && providers !== undefined;
  // Each count's own daily line, or the one reason there is none yet.
  const gap = connectionHistoryGap(data?.countsHistory);
  const history = (key: keyof ConnectionCounts) => ({
    spark: gap === null ? data?.countsHistory?.series[key] : undefined,
    seriesUnavailable: gap ?? undefined,
    sparkAverage: false,
    sparkProvisionalFrom: new Date(nowMs).toISOString().slice(0, 10),
  });

  return <section ref={section} id="integration-health" tabIndex={-1} aria-labelledby={headingId} className="scroll-mt-20 overflow-hidden rounded-xl border border-border bg-card outline-none md:scroll-mt-6" data-connections>
    <div className="flex flex-wrap items-center justify-between gap-3 p-4 md:px-6">
      <h2 id={headingId} className="flex items-center gap-2 text-base font-semibold"><Plug className="size-4 text-muted-foreground" aria-hidden />Connections</h2>
      <span className="flex flex-wrap items-center gap-2 text-xs tabular-nums text-muted-foreground">
        {!health.available ? <span role="status" data-status-for="monitoring:connections"><StateChip tone="na" label="Monitoring incomplete" subject="monitoring:connections" /></span> : null}
        {data ? <>Updated <Age at={data.generatedAt} nowMs={nowMs} /></> : null}
      </span>
    </div>
    <KpiStrip columns={4} className="border-t border-border">
      <Kpi label="Sites failing" value={known ? counts.sitesFailing : '—'} valueTone={known && counts.sitesFailing ? 'error' : 'default'} caption="latest attempt" improvement="down" {...history('sitesFailing')} />
      <Kpi label="Sites overdue" value={known ? counts.sitesOverdue : '—'} valueTone={known && counts.sitesOverdue ? 'warn' : 'default'} caption="past schedule" improvement="down" {...history('sitesOverdue')} />
      <Kpi label="Reports missing" value={known ? counts.reportsMissing : '—'} caption="not yet re-collected" improvement="down" {...history('reportsMissing')} />
      <Kpi label="Sites working" value={known ? counts.sitesWorking : '—'} valueTone={known && counts.sitesWorking ? 'healthy' : 'default'} caption="latest attempt" {...history('sitesWorking')} />
    </KpiStrip>
    <div className="flex items-center gap-1 border-t border-border px-4 py-2 md:px-6" aria-label="Show connections" role="group">
      {([['needs', `Needs you · ${pressing.length}`], ['all', `All · ${statuses.length}`]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setChosen(value)} className={cn('min-h-11 rounded-md px-3 text-xs font-medium tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring', filter === value ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted')}>{label}</button>)}
    </div>
    {!known ? <p className="flex items-center gap-2 border-t border-border px-4 py-6 text-sm text-muted-foreground md:px-6" data-connections-unconfirmed><CircleHelp className="size-4" aria-hidden />Not confirmed</p>
      : shown.length === 0 ? <p className="flex items-center gap-2 border-t border-border px-4 py-6 text-sm text-muted-foreground md:px-6"><Check className="size-4 text-connected" aria-hidden />Nothing needs you</p> : null}
    <ul aria-label="Connections">
      {shown.map(({ entry, status }) => {
        const id = entry.provider.id;
        const name = integrationProviderName(id);
        const subject: StatusSubject = `integration:${id}`;
        const listed = filter === 'needs' ? status.sites.filter((site) => site.kind === 'failing' || site.kind === 'overdue' || site.kind === 'unknown') : status.sites;
        return <li key={id} className="border-t border-border" data-subject={subject} data-connection-row={id}>
          <div className="flex min-h-14 items-center gap-3 px-4 py-2 md:px-6">
            <IntegrationLogo provider={id} size="small" />
            <div className="flex min-w-0 flex-1 flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-3">
              <span className="min-w-0 truncate text-sm font-semibold">{name}</span>
              <span className="flex flex-wrap items-center gap-1.5">
                <IntegrationStateChip state={status.kind} accepted={acceptedAs(entry.provider, entry.credential.auth)} subject={subject} />
                <ConnectionFacts status={status} subject={subject} />
              </span>
            </div>
            <Link to={`/integrations?provider=${encodeURIComponent(id)}`} className="inline-flex min-h-11 shrink-0 items-center text-xs font-medium underline-offset-4 hover:underline" aria-label={`${status.kind === 'not-connected' ? 'Connect' : 'Manage'} ${name}`}>{status.kind === 'not-connected' ? 'Connect' : 'Manage'}</Link>
          </div>
          {listed.length > 0 ? <ul aria-label={`${name} sites`} className="bg-muted/10">{listed.map((site) => <Site key={site.key} site={site} provider={id} nowMs={nowMs} />)}</ul> : null}
        </li>;
      })}
    </ul>
    {!!data?.events.length && <details className="border-t border-border"><summary className="flex min-h-11 cursor-pointer items-center px-4 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:px-6">Recent changes</summary><ol className="space-y-3 px-4 pb-4 md:px-6" aria-label="Integration changes" data-order="chronological">{data.events.slice(0, 8).map((event) => <li key={event.id} className="flex items-start gap-3 text-xs"><span className={cn('mt-0.5', event.kind === 'recovered' ? 'text-healthy' : 'text-error')}>{event.kind === 'recovered' ? <Check className="size-4" aria-hidden /> : <TriangleAlert className="size-4" aria-hidden />}</span><div className="min-w-0 flex-1"><p className="font-medium">{event.kind === 'recovered' ? 'Recovered' : event.kind === 'changed' ? 'Failure changed' : 'Failure recorded'} · {event.label}</p><p className="mt-1 break-words text-muted-foreground">{integrationProviderName(event.provider)}{event.asset ? ` · ${event.asset}` : ''}</p></div><span className="shrink-0 text-muted-foreground tabular-nums"><Age at={event.at} nowMs={nowMs} /></span></li>)}</ol></details>}
  </section>;
}
