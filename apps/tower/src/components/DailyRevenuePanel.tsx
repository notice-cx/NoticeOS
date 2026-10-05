import { useId, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { DailyRevenueHistory } from '@shared/daily-revenue';
import { MEDIAVINE_REPORTING_CLOCK } from '@shared/daily-revenue';
import { HeroChart } from '@/components/surface/HeroChart';
import { Kpi, KpiStrip } from '@/components/surface/KpiStrip';
import { SectionLabel } from '@/components/surface/SectionLabel';
import { formatCalendarDate, formatUsd } from '@/lib/format';

/**
 * Daily observations are estimates; monthly accounting owns booked money.
 *
 * NOTHING HERE IS EXPLAINED IN A SENTENCE (bead `ro-ujb9.96.6.9`). A partial day
 * is an outlined bar the chart keys with its count, the missing source is that
 * day's own readout, and an empty window says what is missing and links to
 * where it is set up — the panel used to carry a paragraph for each.
 */
export function DailyRevenuePanel({ history, range, title = 'Daily revenue', context, notesByDate, partialDates = [], setupHref, aside }: {
  history: DailyRevenueHistory;
  range: number;
  title?: string;
  /** The end of the header row — Home's one-site lead puts the site there. */
  aside?: ReactNode;
  /** One line under the dates: the portfolio's per-source coverage. */
  context?: ReactNode;
  notesByDate?: Readonly<Record<string, string>>;
  partialDates?: readonly string[];
  /** Where ad revenue is connected, offered when nothing has ever reported. */
  setupHref?: string;
}) {
  const id = useId();
  const chartId = `${id}-chart`;
  const total = history.days.reduce((sum, day) => sum + day.amountMinor, 0);
  const count = history.days.length;
  const latest = history.days.at(-1);
  const currency = (value: number) => formatUsd(value, { cents: true });
  return <section aria-labelledby={id} data-daily-revenue className="min-w-0 overflow-hidden rounded-[10px] border border-border bg-card">
    <SectionLabel id={id} title={title} caption={`Mediavine · ${MEDIAVINE_REPORTING_CLOCK.label} · estimates`} className="px-4 pt-3">{aside}</SectionLabel>
    <p className="px-4 pt-1 text-xs text-muted-foreground">{range === 0 ? 'Reporting has not started for this period.' : <>{formatCalendarDate(history.from)} – {formatCalendarDate(history.to)}</>}</p>
    {context ? <div className="px-4 pt-2 text-xs text-muted-foreground">{context}</div> : null}
    {count > 0 ? <>
      <KpiStrip columns={3} className="border-0 bg-transparent">
        <Kpi label={partialDates.length ? 'Reported subtotal' : 'Reported earnings'} value={currency(total / 100)} caption={`${count} of ${range} days reported`} improvement="none" seriesChartId={chartId} />
        <Kpi label="Average / reported day" value={partialDates.length ? '—' : currency(total / count / 100)} caption={partialDates.length ? 'Incomplete site coverage' : 'Excludes missing days'} improvement="none" seriesChartId={chartId} />
        <Kpi label={partialDates.includes(latest!.date) ? 'Latest day · partial' : 'Latest reported day'} value={currency(latest!.amountMinor / 100)} caption={formatCalendarDate(latest!.date)} improvement="none" seriesChartId={chartId} />
      </KpiStrip>
      <div id={chartId} className="px-4 pb-4">
        <HeroChart variant="bars" range={range} end={history.to} height={240}
          series={[{ name: 'Estimated ad revenue', tone: 'revenue', points: history.days.map(day => ({ t: day.date, v: day.amountMinor / 100 })) }]}
          notesByDate={notesByDate} partialDates={partialDates}
          format={value => formatUsd(value)} formatValue={currency} ariaLabel={`${title} by day`}
          footnote={<>Saved estimates may be revised. Missing dates are gaps, not $0.</>} />
      </div>
    </> : <div className="px-4 py-8" data-daily-revenue-empty="">
      <p className="text-sm font-medium">{range === 0 ? 'No completed reporting days yet' : 'No daily revenue reports in this period'}</p>
      {history.reportedThrough
        ? <p className="mt-1 text-sm tabular-nums text-muted-foreground">Last report {formatCalendarDate(history.reportedThrough)}</p>
        : setupHref
          ? <Link to={setupHref} className="mt-1 inline-flex text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline max-sm:min-h-11 max-sm:items-center">Ad revenue setup →</Link>
          : null}
    </div>}
  </section>;
}
