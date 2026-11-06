import { type ReactNode, useEffect, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Link } from 'react-router-dom';
import type { PortfolioBriefRead } from '@noticeos/contract/portfolio-brief';

function actionDestination(href: string): string | null {
  if (/^\/tasks(?:\/[^/?#]+)?(?:\?project=[a-zA-Z0-9_%.-]+)?$/.test(href)) return 'Review tasks';
  if (href === '/financials') return 'Review financials';
  if (href === '/health') return 'Review health';
  if (href === '/alerts') return 'Review alerts';
  if (/^\/assets\/[^/?#]+(?:\/(?:sources|product|search))?$/.test(href)) return 'Review asset';
  return null;
}

export function ExecutiveBrief({ read, readFailed = false, fallback }: { read?: PortfolioBriefRead; readFailed?: boolean; fallback: ReactNode }) {
  const brief = read?.briefing;
  const count = Math.min(brief?.result.insights.length ?? 0, 3);
  const [highlight, setHighlight] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [hidden, setHidden] = useState(() => document.hidden);
  const [reduced, setReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  useEffect(() => {
    setHovered(false);
    setFocused(false);
    setDetailsOpen(false);
    setHighlight(0);
  }, [brief?.generatedAt, count]);

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const motion = () => setReduced(media?.matches ?? false);
    const visibility = () => setHidden(document.hidden);
    media?.addEventListener('change', motion);
    document.addEventListener('visibilitychange', visibility);
    return () => { media?.removeEventListener('change', motion); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  const cycling = count > 1 && !paused && !hovered && !focused && !detailsOpen && !hidden && !reduced;
  useEffect(() => {
    if (!cycling) return;
    const timer = window.setInterval(() => setHighlight(current => (current + 1) % count), 9_000);
    return () => window.clearInterval(timer);
  }, [cycling, count]);

  if (!brief || brief.result.insights.length === 0) return <>
    {fallback}
    {!brief && read?.state === 'disconnected' ? <p className="text-sm text-muted-foreground"><Link to="/integrations?connect=local-model" className="underline underline-offset-4">Connect a model</Link> for an executive briefing.</p>
      : !brief && (readFailed || read?.state === 'unavailable') ? <p className="text-sm text-muted-foreground">Briefing unavailable.</p> : null}
  </>;
  const sources = new Map(brief.sources.map(source => [source.id, source]));
  const linkedDestinations = new Set<string>();
  const outdated = readFailed || read?.stale || read?.state === 'unavailable';
  return <section aria-labelledby="executive-brief-title" className="flex flex-col gap-4" data-executive-brief="" data-brief-cycle={cycling ? 'running' : 'paused'}>
    <div className="flex items-start justify-between gap-3">
    <div className="min-w-0 max-w-prose">
      <h2 id="executive-brief-title" className="m-0 text-figure-sm [text-wrap:balance]">{brief.result.headline}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{brief.result.assessment}</p>
    </div>
    {count > 1 && !reduced ? <Button type="button" variant="ghost" size="sm" className="shrink-0" aria-label={paused ? 'Resume card highlights' : 'Pause card highlights'}
      onClick={() => setPaused(current => !current)}>
      {paused ? <Play className="size-3" aria-hidden /> : <Pause className="size-3" aria-hidden />}
      <span className="hidden sm:inline">{paused ? 'Resume highlights' : 'Pause highlights'}</span>
    </Button> : null}
    </div>
    {outdated ? <p className="text-sm text-warn" role="status" data-status-for="read:portfolio-brief">{readFailed || read?.state === 'unavailable' ? 'Refresh failed. Showing the previous briefing.' : 'This briefing is out of date.'}</p> : null}
    <ol onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }} className={brief.result.insights.length === 1 ? 'grid items-start gap-4' : brief.result.insights.length === 2 ? 'grid items-start gap-4 @3xl:grid-cols-2' : 'grid items-start gap-4 @3xl:grid-cols-2 @5xl:grid-cols-3'}>
      {brief.result.insights.slice(0, 3).map((insight, index) => {
        const destination = insight.evidenceIds.map(id => sources.get(id)).find(source => source && actionDestination(source.href) && !linkedDestinations.has(source.href));
        if (destination) linkedDestinations.add(destination.href);
        return <li key={`${brief.generatedAt}:${index}`} onMouseEnter={() => { setHovered(true); setHighlight(index); }} onMouseLeave={() => setHovered(false)} onFocusCapture={() => setHighlight(index)}
          data-brief-highlight={count > 1 && index === highlight % count ? 'active' : 'inactive'}
          className={cn('min-w-0 rounded-xl p-4 ring-1 motion-safe:transition-[background-color,box-shadow] motion-safe:duration-700 motion-reduce:transition-none',
            count > 1 && index === highlight % count ? 'bg-primary/5 ring-primary/60' : 'bg-card ring-border/70')}>
          <h3 className="text-base font-medium">{insight.title}</h3>
          <details className="mt-2" onToggle={event => setDetailsOpen(Boolean(event.currentTarget.closest('ol')?.querySelector('details[open]')))}>
            <summary className="w-fit cursor-pointer text-sm text-muted-foreground underline underline-offset-4">Details<span className="sr-only">: {insight.title}</span></summary>
            <div className="mt-3 space-y-3">
              <p className="text-sm leading-relaxed">{insight.observation}</p>
              <p className="text-sm leading-relaxed text-muted-foreground">{insight.why}</p>
              <div><p className="text-xs font-medium uppercase tracking-wide">Next</p><p className="mt-1 text-sm leading-relaxed">{insight.action}</p></div>
              {destination ? <Link to={destination.href} className="inline-block text-sm underline underline-offset-4">{actionDestination(destination.href)}</Link> : null}
            </div>
          </details>
        </li>;
      })}
    </ol>
  </section>;
}
