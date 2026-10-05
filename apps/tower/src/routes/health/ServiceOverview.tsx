import { Activity, ArrowUpRight, CircleHelp, HeartPulse, Radio, Timer, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PUSH_STATE_JOB, backgroundWorkSummary, installedWorkflows, unreadSites, workflowBasePath, workflowState, workflowRunAge } from '@shared/workflows';
import { utcRunReference } from '@shared/scheduled-jobs';
import type { IntegrationStatus } from '@shared/integration-status';
import { siteCount, siteNoun } from '@shared/site-noun';
import { WorkflowStateLabel } from '@/components/WorkflowVisuals';
import { useWorkflows } from '@/hooks/useWorkflows';
import { useNow } from '@/hooks/useNow';
import { cn } from '@/lib/utils';

export function ServiceOverview({ dataCurrent, degraded, unverified, setup, integrations }: { dataCurrent: boolean; degraded: number; unverified: number; setup: number; integrations: IntegrationStatus }) {
  const query = useWorkflows();
  const now = useNow(5_000);
  const payload = query.data;
  const recent = Boolean(payload && !query.isError && now - Date.parse(payload.generatedAt) >= -10_000 && now - Date.parse(payload.generatedAt) < 45_000);
  const scheduler = Boolean(recent && payload?.runtimeFresh && payload.runtime?.jobs.length);
  const observations = Boolean(recent && payload?.observationsFresh);
  const history = Boolean(recent && payload?.historyAvailable);
  const data = payload ? { ...payload, runtimeFresh: scheduler } : undefined;
  const internal = installedWorkflows(data).filter((item) => item.surface === 'system');
  const operations = data?.workflows.flatMap((summary) => {
    const definition = internal.find((item) => item.id === summary.id);
    return definition ? [{ definition, summary, state: workflowState(summary, data) }] : [];
  }) ?? [];
  const failures = operations.filter((item) => item.state === 'failed');
  // Sites whose unpublished commits the runner could not check, and why (bead
  // ro-ujb9.188): unknown, not failed — the sites' own state is what is unread.
  const pushCheck = installedWorkflows(data).find((item) => item.id === PUSH_STATE_JOB);
  const unread = history && pushCheck ? unreadSites(data?.workflows.find((summary) => summary.id === pushCheck.id)?.latest) : null;
  const covered = internal.every((definition) => operations.some((item) => item.definition.id === definition.id && item.state !== 'unknown'));
  const noRuns = operations.some((item) => item.state === 'never');
  const paused = operations.some((item) => item.state === 'paused');
  const integrationsConfirmed = integrations.available && integrations.unconfirmed === 0;
  const confirmed = covered && scheduler && observations && history && dataCurrent && integrationsConfirmed && !payload?.runtime?.error;
  const issues = (dataCurrent ? degraded : 0) + failures.length + integrations.attention;
  const title = payload?.runtime?.error && scheduler ? 'Schedule settings need attention' : issues ? 'Needs attention' : !confirmed ? 'Current health is unconfirmed' : noRuns ? 'Some operations have not run yet' : paused ? 'Some background operations are paused' : unverified ? 'Some connections need verification' : setup ? 'Some connections need setup' : 'Checks are reporting normally';
  const Icon = issues ? TriangleAlert : !confirmed || unverified || noRuns || paused ? CircleHelp : HeartPulse;
  const tone = issues ? 'text-error' : !confirmed || unverified || noRuns || paused ? 'text-muted-foreground' : setup ? 'text-warn' : 'text-healthy';
  const statusItems = [
    { label: 'Scheduler', icon: Timer, ok: scheduler && !payload?.runtime?.error, text: !scheduler ? 'Unconfirmed' : payload?.runtime?.error ? 'Settings refresh delayed' : 'Reporting', detail: !scheduler ? 'No recent scheduler confirmation' : payload?.runtime?.error ? 'Previously confirmed schedules remain active' : 'Schedules acknowledged by the local service' },
    { label: 'Live execution tracking', icon: Radio, ok: observations, text: observations ? 'Reporting' : 'Unconfirmed', detail: observations ? 'Run observations are current' : 'Current progress cannot be confirmed' },
    { label: 'Execution history', icon: Activity, ok: history, text: history ? 'Available' : 'Unavailable', detail: history ? 'Retained runs can be inspected' : 'Past runs could not be read' },
    { label: 'Integrations', icon: Radio, ok: integrationsConfirmed && !integrations.attention && integrations.working > 0, failed: integrations.attention > 0, text: integrations.attention ? `${integrations.attention} ${integrations.attention === 1 ? 'connection needs' : 'connections need'} attention` : !integrationsConfirmed ? 'Unconfirmed' : integrations.working ? 'Reporting' : 'No active operations', detail: !integrations.available ? 'Monitoring coverage is incomplete' : integrations.affectedAssets.length ? `${integrations.affectedAssets.length} affected ${siteNoun(integrations.affectedAssets.length)} · details below` : `${siteCount(integrations.working)} working · ${integrations.unconfirmed} awaiting a result` },
  ];
  return <section className="overflow-hidden rounded-xl border border-border bg-card" aria-label="System status">
    <div className="flex flex-wrap items-start justify-between gap-4 p-5 md:p-6">
      <div className="flex min-w-0 gap-3"><span className={cn('flex size-11 shrink-0 items-center justify-center rounded-lg border border-current/20', tone)}><Icon className="size-5" aria-hidden /></span><div>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{issues ? [integrations.attention ? `${integrations.attention} ${integrations.attention === 1 ? 'connection needs' : 'connections need'} attention` : null, failures.length ? `${failures.length} background ${failures.length === 1 ? 'operation' : 'operations'} failed` : null, !dataCurrent ? 'Other sources unconfirmed' : degraded ? `${degraded} other ${degraded === 1 ? 'source' : 'sources'} not working` : null].filter(Boolean).join(' · ') : !confirmed ? null : 'Service activity, live feeds and scheduled data collection are checked separately.'}</p>
      </div></div>
      {payload && <time dateTime={payload.generatedAt} title={utcRunReference(payload.generatedAt)} className="text-xs text-muted-foreground tabular-nums">Updated {workflowRunAge(payload.generatedAt, now).toLowerCase()}</time>}
    </div>
    <div className="grid divide-y divide-border border-t border-border md:grid-cols-4 md:divide-x md:divide-y-0">{statusItems.map((item) => <div key={item.label} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2 p-4 md:block md:space-y-2 md:px-6">
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><item.icon className="size-3.5" aria-hidden />{item.label}</div>
      <p className={cn('text-sm font-medium', item.failed ? 'text-error' : item.ok ? 'text-healthy' : 'text-muted-foreground')}>{item.text}</p><p className={cn("col-span-2 text-xs text-muted-foreground", item.ok && "hidden md:block")}>{item.detail}</p>
    </div>)}</div>
    {failures.length > 0 && <div className="space-y-1 border-t border-border p-3" aria-label="Failed background operations">{failures.slice(0, 3).map(({ definition, summary }) => <Link key={definition.id} to={`/health/operations/${definition.id}${summary.latest ? `?run=${encodeURIComponent(summary.latest.id)}` : ''}`} className="flex min-h-12 flex-wrap items-center justify-between gap-3 rounded-md px-3 py-2 text-sm outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"><span className="font-medium">{definition.label}</span><span className="flex items-center gap-4"><WorkflowStateLabel state="failed" />{summary.latest && <time dateTime={summary.latest.startedAt} title={utcRunReference(summary.latest.startedAt)} className="text-xs text-muted-foreground">{workflowRunAge(summary.latest.startedAt, now)}</time>}<ArrowUpRight className="size-4" aria-hidden /></span></Link>)}</div>}
    {unread && pushCheck && <Link data-unread-sites to={`${workflowBasePath(pushCheck.surface)}/${pushCheck.id}?run=${encodeURIComponent(unread.runId)}`} className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border px-5 py-2 text-sm outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring md:px-6">
      <span className="font-medium">{pushCheck.label}</span>
      <span className="flex flex-wrap items-center gap-x-4 gap-y-1"><WorkflowStateLabel state="unknown" label={`Unknown · ${unread.sites.length <= 2 ? unread.sites.join(', ') : siteCount(unread.sites.length)}`} />{unread.reasons.length > 0 && <span className="text-xs text-muted-foreground">{unread.reasons.join(' · ')}</span>}<ArrowUpRight className="size-4" aria-hidden /></span>
    </Link>}
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3 text-xs text-muted-foreground"><p>{backgroundWorkSummary(installedWorkflows(data))}</p><Link to="/health/operations" className="inline-flex min-h-8 items-center gap-1 font-medium text-foreground hover:underline">{failures.length > 3 ? `Inspect all ${failures.length} failures` : 'View background operations'}<ArrowUpRight className="size-3.5" aria-hidden /></Link></div>
  </section>;
}
