import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { PortfolioBriefRead } from '@noticeos/contract/portfolio-brief';
import { formatTimestamp } from '@/lib/format';

export function ExecutiveBrief({ read, readFailed = false, fallback }: { read?: PortfolioBriefRead; readFailed?: boolean; fallback: ReactNode }) {
  const brief = read?.briefing;
  if (!brief) return <>
    {fallback}
    {read?.state === 'disconnected' ? <p className="text-sm text-muted-foreground"><Link to="/integrations?connect=local-model" className="underline underline-offset-4">Connect a local model</Link> for an executive briefing.</p>
      : read?.state === 'awaiting' ? <p className="text-sm text-muted-foreground">The first briefing will appear after the next scheduled refresh.</p>
      : readFailed || read?.state === 'unavailable' ? <p className="text-sm text-muted-foreground">Executive briefing unavailable. The figures below remain available.</p> : null}
  </>;
  const sources = new Map(brief.sources.map(source => [source.id, source]));
  const outdated = readFailed || read?.stale || read?.state === 'unavailable';
  return <section aria-labelledby="executive-brief-title" className="flex flex-col gap-3" data-executive-brief="">
    <div>
      <p className="text-sm text-muted-foreground">{brief.model === null ? 'Evidence reviewed' : <>Model-generated · {brief.model}</>} · <time dateTime={brief.generatedAt}>{brief.model === null ? 'Updated' : 'Generated'} {formatTimestamp(brief.generatedAt)}</time></p>
      <h2 id="executive-brief-title" className="m-0 text-figure-sm [text-wrap:balance]">{brief.result.headline}</h2>
      <p className="mt-1 max-w-prose text-sm">{brief.result.assessment}</p>
    </div>
    {outdated ? <p className="text-sm text-warn" role="status" data-status-for="read:portfolio-brief">{readFailed || read?.state === 'unavailable' ? 'The latest briefing could not be refreshed. Showing the last successful briefing.' : 'This briefing is out of date.'}</p> : null}
    {brief.result.insights.length > 0 ? <ol className={brief.result.insights.length === 1 ? "grid gap-3" : "grid gap-3 @3xl:grid-cols-2"}>
      {brief.result.insights.slice(0, 2).map((insight, index) => <li key={index} className="min-w-0 rounded-xl bg-card p-4 ring-1 ring-border/70">
        <h3 className="text-sm font-medium">{insight.observation}</h3>
        <p className="mt-2 text-sm text-muted-foreground">{insight.why}</p>
        <p className="mt-2 text-sm"><span className="font-medium">Next: </span>{insight.action}</p>
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {insight.evidenceIds.map(id => sources.get(id)).filter(source => source !== undefined).map(source => <Link key={source.id} to={source.href} className="underline underline-offset-4" title={source.observedAt ? `Observed ${formatTimestamp(source.observedAt)}` : 'Observation time unavailable'}>{source.label}</Link>)}
          {insight.confidence !== 'high' ? <span className="text-muted-foreground">{insight.confidence === 'low' ? 'Low confidence' : 'Medium confidence'}</span> : null}
        </div>
      </li>)}
    </ol> : null}
    <p className="text-xs text-muted-foreground"><time dateTime={brief.evidenceAsOf}>Data reviewed {formatTimestamp(brief.evidenceAsOf)}</time></p>
    <details className="text-xs text-muted-foreground">
      <summary className="w-fit cursor-pointer underline underline-offset-4">Evidence and coverage</summary>
      <div className="mt-2 flex max-w-prose flex-col gap-2">
        {brief.limitations.map((limitation, index) => <p key={index}>{limitation}</p>)}
        {brief.sources.map(source => <p key={source.id}><Link to={source.href} className="underline underline-offset-4">{source.label}</Link>{source.observedAt ? <> · <time dateTime={source.observedAt}>{formatTimestamp(source.observedAt)}</time></> : ' · Observation time unavailable'}{source.period ? ` · ${source.period.start} to ${source.period.end}` : ''}</p>)}
      </div>
    </details>
  </section>;
}
