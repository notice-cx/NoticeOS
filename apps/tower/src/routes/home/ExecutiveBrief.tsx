import { type ReactNode, useEffect, useState } from 'react';
import { Layers3, Pause, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PropertyFavicon } from '@/components/PropertyFavicon';
import { cn } from '@/lib/utils';
import { Link } from 'react-router-dom';
import type { PortfolioBrief, PortfolioBriefRead } from '@noticeos/contract/portfolio-brief';
import { CONFIG_ASSET_KEY_RE } from '@noticeos/contract/configuration';
import type { AssetCard } from '@shared/wall';

type BriefAsset = Pick<AssetCard, 'id' | 'displayName' | 'icons'>;

/** Source routes and identifiers are application-owned; model prose never assigns identity. */
function sourceAsset(source: PortfolioBrief['sources'][number]): string | null {
  try {
    const path = /^\/assets\/([^/?#]+)(?:\/|$)/.exec(source.href);
    const project = /^\/tasks(?:\/[^/?#]+)?\?/.test(source.href) ? new URLSearchParams(source.href.split('?')[1]).get('project') : null;
    const id = path ? decodeURIComponent(path[1]!) : project ?? /^(?:asset|work|task|task-dependency|acquisition|product):([^:]+):[^:]+$/.exec(source.id)?.[1];
    return id && CONFIG_ASSET_KEY_RE.test(id) ? id : null;
  } catch { return null; }
}

function actionDestination(href: string): string | null {
  if (/^\/tasks(?:\/[^/?#]+)?(?:\?project=[a-zA-Z0-9_%.-]+)?$/.test(href)) return 'Review tasks';
  if (href === '/financials') return 'Review financials';
  if (href === '/health') return 'Review health';
  if (href === '/alerts') return 'Review alerts';
  if (/^\/assets\/[^/?#]+(?:\/(?:sources|product|search))?$/.test(href)) return 'Review asset';
  return null;
}

export function ExecutiveBrief({ read, readFailed = false, fallback, assets = [] }: { read?: PortfolioBriefRead; readFailed?: boolean; fallback: ReactNode; assets?: readonly BriefAsset[] }) {
  const brief = read?.briefing;
  const [paused, setPaused] = useState(false);
  if (!brief || brief.result.insights.length === 0) return <>
    {fallback}
    {!brief && read?.state === 'disconnected' ? <p className="text-sm text-muted-foreground"><Link to="/integrations?connect=local-model" className="underline underline-offset-4">Connect a model</Link> for an executive briefing.</p>
      : !brief && (readFailed || read?.state === 'unavailable') ? <p className="text-sm text-muted-foreground">Briefing unavailable.</p> : null}
  </>;
  const outdated = readFailed || read?.stale || read?.state === 'unavailable';
  const warning = !outdated ? null : readFailed || read?.state === 'unavailable' ? 'Refresh failed. Showing the previous briefing.' : 'This briefing is out of date.';
  return <BriefingFindings key={`${brief.generatedAt}:${brief.result.insights.length}`} brief={brief} assets={assets} warning={warning} paused={paused} onPausedChange={setPaused} />;
}

function BriefingFindings({ brief, assets, warning, paused, onPausedChange }: { brief: PortfolioBrief; assets: readonly BriefAsset[]; warning: string | null; paused: boolean; onPausedChange: (paused: boolean) => void }) {
  const findings = brief.result.insights.slice(0, 3);
  const count = findings.length;
  const [index, setIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [hidden, setHidden] = useState(() => document.hidden);
  const [reduced, setReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
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
    const timer = window.setInterval(() => setIndex(current => (current + 1) % count), 7_000);
    return () => window.clearInterval(timer);
  }, [cycling, count]);

  const insight = findings[index]!;
  const sources = new Map(brief.sources.map(source => [source.id, source]));
  const identities = [...new Set(insight.evidenceIds.flatMap(id => { const source = sources.get(id); const asset = source && sourceAsset(source); return asset ? [asset] : []; }))]
    .map(id => assets.find(asset => asset.id === id) ?? { id, displayName: id, icons: null });
  const destination = insight.evidenceIds.map(id => sources.get(id)).find(source => source && actionDestination(source.href));
  return <section aria-label="Portfolio briefing" aria-roledescription="carousel" className="w-full min-w-0 rounded-xl bg-card p-5 ring-1 ring-border/70"
    data-executive-brief="" data-brief-cycle={cycling ? 'running' : 'paused'}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    {warning ? <p className="mb-4 text-sm text-warn" role="status" data-status-for="read:portfolio-brief">{warning}</p> : null}
    <div className="flex items-start gap-3 sm:gap-5">
      <div className="min-w-0 flex-1" aria-live={cycling ? 'off' : 'polite'} aria-atomic="true">
        <div key={index} role="group" aria-roledescription="slide" aria-label={`${index + 1} of ${count}`} data-brief-finding={index}
          className="viz-arrive flex min-h-48 flex-col gap-4 sm:min-h-40">
          <div className="flex items-start gap-3">
            {identities.length ? <span role="img" aria-label={`About ${identities.map(asset => asset.displayName).join(', ')}`} title={identities.map(asset => asset.displayName).join(', ')} className="flex shrink-0 flex-wrap items-center gap-1">
              {identities.slice(0, 3).map(asset => <PropertyFavicon key={asset.id} domain={asset.id} displayName={asset.displayName} icons={asset.icons} className="size-7" />)}
              {identities.length > 3 ? <span aria-hidden className="text-xs text-muted-foreground">+{identities.length - 3}</span> : null}
            </span> : <span role="img" aria-label="Portfolio finding" title="Portfolio" className="shrink-0 text-muted-foreground"><Layers3 aria-hidden className="size-7" /></span>}
            <h2 className="m-0 min-w-0 text-figure-sm [text-wrap:balance]">{insight.title}</h2>
          </div>
          <div><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Next</p><p className="mt-1 max-w-prose text-sm leading-relaxed">{insight.action}</p></div>
          <details onToggle={event => setDetailsOpen(event.currentTarget.open)}>
            <summary className="w-fit cursor-pointer text-sm text-muted-foreground underline underline-offset-4">Details<span className="sr-only">: {insight.title}</span></summary>
            <div className="mt-3 max-w-prose space-y-3">
              <p className="text-sm leading-relaxed">{insight.observation}</p>
              <p className="text-sm leading-relaxed text-muted-foreground">{insight.why}</p>
              {destination ? <Link to={destination.href} className="inline-block text-sm underline underline-offset-4">{actionDestination(destination.href)}</Link> : null}
            </div>
          </details>
        </div>
      </div>
      {count > 1 ? <div className="flex shrink-0 flex-col items-center gap-2">
        {!reduced ? <Button type="button" variant="ghost" size="icon" aria-label={paused ? 'Resume finding rotation' : 'Pause finding rotation'}
          title={paused ? 'Resume rotation' : 'Pause rotation'} onClick={() => onPausedChange(!paused)}>
          {paused ? <Play aria-hidden /> : <Pause aria-hidden />}
        </Button> : null}
        <div className="flex flex-col" role="group" aria-label="Choose a finding">
          {findings.map((finding, position) => <Button key={position} type="button" variant="ghost" size="icon"
            aria-label={`Show finding ${position + 1}: ${finding.title}`} aria-current={position === index ? 'true' : undefined}
            onClick={() => { if (position !== index) { setIndex(position); setDetailsOpen(false); } onPausedChange(true); }}>
            <span aria-hidden className={cn('size-2 rounded-full motion-safe:transition-colors', position === index ? 'bg-primary ring-2 ring-primary/30 ring-offset-2 ring-offset-card' : 'bg-muted-foreground/40')} />
          </Button>)}
        </div>
      </div> : null}
    </div>
  </section>;
}
