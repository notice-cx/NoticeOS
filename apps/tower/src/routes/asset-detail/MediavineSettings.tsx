import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { MediavineStatus, RevenueHolidayCalendar } from '@noticeos/contract';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InfoTooltip } from '@/components/InfoTooltip';
import { Meter } from '@/components/Meter';
import { StateChip } from '@/components/StateChip';
import { useBrowserRuntime, useTowerApi } from '@/lib/browser-context';
import { useConfigWritable } from '@/hooks/useConfigWritable';

const money = (minor: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(minor / 100);
/** Days of saved daily revenue the Wall's forecast needs before it learns
 * weekday and holiday effects (three weeks). A meter toward it, rather than a
 * sentence asking the operator to backfill. */
const FORECAST_DAYS = 21;
/** The earliest start one backfill request may ask for: a year before its end.
 * The date picker enforces it, so the limit needs no sentence. */
function yearBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() - 364);
  return d.toISOString().slice(0, 10);
}
/** Refresh or backfill a mapped asset’s revenue from its Money tab. */
export function MediavineSettings({ asset }: { asset: string }) {
  const { writable } = useConfigWritable();
  const api = useTowerApi();
  const runtime = useBrowserRuntime();
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const active = () => mounted.current && runtime.guard(() => true)() === true;
  const cache = useQueryClient();
  const [status, setStatus] = useState<MediavineStatus | null>(null);
  const [siteId, setSiteId] = useState('');
  const [holidayCalendar, setHolidayCalendar] = useState<RevenueHolidayCalendar>('none');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [start, setStart] = useState(''); const [end, setEnd] = useState('');
  useEffect(() => {
    let active = true;
    api.fetchMediavineStatus(asset).then(value => {
      if (!active || runtime.guard(() => true)() !== true) return;
      setStatus(value); setSiteId(value.siteId ?? '');
      setHolidayCalendar(value.holidayCalendar ?? 'none');
      setStart(`${value.availableThrough.slice(0, 7)}-01`); setEnd(value.availableThrough);
    }).catch(error => { if (active && runtime.guard(() => true)() === true) setMessage(error instanceof Error ? error.message : 'Could not load Mediavine.'); });
    return () => { active = false; };
  }, [asset, api, runtime]);
  async function action(work: () => Promise<MediavineStatus>) {
    if (!writable || !active()) return;
    setBusy(true); setMessage(null);
    try { const value = await work(); if (active()) {
      setStatus(value);
      // The reads revenue reaches, not every read on the page.
      await Promise.all([['wall'], ['asset-detail', asset], ['financials']].map(queryKey => cache.invalidateQueries({ queryKey })));
    } }
    catch (error) { if (active()) setMessage(error instanceof Error ? error.message : 'The action failed. Try again.'); }
    finally { if (active()) setBusy(false); }
  }
  const stamp = (value: string | null) => value ? new Date(value).toLocaleString() : 'Never';
  const days = status?.daily.length ?? 0;
  // Nothing mapped, or no login: the row's Connect is the one action.
  if (status && (!status.connected || status.siteId === null)) return null;
  return <section id="mediavine" aria-label="Mediavine revenue" className="flex min-w-0 scroll-mt-6 flex-col gap-3 rounded-xl border border-border bg-card p-4">
    <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold text-foreground">Mediavine revenue</h3>
      {status ? <InfoTooltip label="Mediavine sync details">
        <span>Daily · 6:10 a.m. PT</span>
        <span>Last successful sync · {stamp(status.lastSuccessAt)}</span>
        <span>Last attempt · {stamp(status.lastAttemptAt)}</span>
        {status.nextAttemptAt ? <span>Next retry · {stamp(status.nextAttemptAt)}</span> : null}
      </InfoTooltip> : null}
      {status?.enabled ? <Button size="sm" variant="outline" className="ms-auto" disabled={busy || !writable} onClick={() => void action(() => api.syncMediavine({ asset }))}>{busy ? 'Working…' : 'Refresh revenue'}</Button> : null}
    </div>
    {message ? <p role="alert" className="m-0 text-foreground">{message}</p> : null}
    {status ? <>
      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        {/* Saved figures are Mediavine's estimates until a payment reconciles
            them: a chip on the figure, not a sentence above the card. */}
        <div><dt className="text-muted-foreground">Reported through</dt><dd className="m-0 flex flex-wrap items-center gap-2 font-medium text-foreground">{status.reportedThrough ?? 'No revenue collected yet'}{status.reportedThrough ? <StateChip label="Estimates" tone="na" subject={`revenue:${asset}`} /> : null}</dd></div>
        {/* Mediavine's own two totals for the same days, when they disagree:
            one labelled figure rather than a sentence. */}
        {status.differenceMinor !== null && status.differenceMinor !== 0 ? <div data-mediavine-difference><dt className="text-muted-foreground">Summary vs daily rows · {status.comparisonStart}–{status.comparisonEnd}</dt><dd className="m-0 tabular-nums">{money(status.summaryMinor!)} vs {money(status.dailyMinor!)} · off by {money(status.differenceMinor)}</dd></div> : null}
      </dl>
      {status.error ? <p className="m-0">Last attempt: {status.error}</p> : null}
      <details><summary className="min-h-11 cursor-pointer py-3 font-medium">Backfill or recheck dates</summary>
        <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); void action(() => api.syncMediavine({ asset, start, end })); }}>
          <label className="flex flex-col gap-1">Start date<input className="min-h-11 rounded-md border border-input bg-background px-3 text-foreground" type="date" disabled={!writable} required value={start} min={yearBefore(end)} max={end} onChange={event => setStart(event.target.value)} /></label>
          <label className="flex flex-col gap-1">End date<input className="min-h-11 rounded-md border border-input bg-background px-3 text-foreground" type="date" disabled={!writable} required value={end} min={start} max={status.availableThrough} onChange={event => setEnd(event.target.value)} /></label>
          <Button type="submit" disabled={busy || !writable || !status.enabled}>Fetch dates</Button>
        </form>
      </details>
      <details><summary className="min-h-11 cursor-pointer py-3 font-medium">Forecast settings</summary>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-col gap-1">Forecast holiday calendar
            <select className="min-h-11 rounded-md border border-input bg-background px-3 pe-9 text-foreground" value={holidayCalendar} disabled={busy || !writable} onChange={event => setHolidayCalendar(event.target.value as RevenueHolidayCalendar)}>
              <option value="none">Weekday patterns only</option><option value="US">United States</option><option value="CA">Canada</option><option value="US,CA">United States and Canada</option>
            </select>
          </label>
          <Button disabled={busy || !writable || !siteId || holidayCalendar === (status.holidayCalendar ?? 'none')} onClick={() => void action(() => api.saveMediavineSettings({ asset, siteId, enabled: status.enabled, holidayCalendar }))}>Save forecast calendar</Button>
          <div className="flex w-full flex-col gap-1" data-forecast-history>
            <span className="flex items-center justify-between gap-2 text-xs"><span className="text-muted-foreground">Forecast history</span>
              {days >= FORECAST_DAYS
                ? <StateChip label="Enough to forecast" tone="affirmative" glyph={<Check className="size-3" aria-hidden />} subject={`revenue:${asset}`} />
                : <span className="tabular-nums text-foreground">{days} of {FORECAST_DAYS} days</span>}
            </span>
            {days >= FORECAST_DAYS ? null : <Meter value={days} max={FORECAST_DAYS} ariaLabel={`${days} of ${FORECAST_DAYS} days of daily revenue saved`} />}
          </div>
        </div>
      </details>
      {status.daily.length ? <details><summary className="min-h-11 cursor-pointer py-3 font-medium">Saved daily revenue · {status.daily.length} days</summary>
        <div className="max-h-80 overflow-auto"><table className="w-full text-sm"><caption className="sr-only">Mediavine daily revenue estimates in USD</caption><thead><tr><th className="text-left">Report date</th><th className="text-right">Estimated revenue</th></tr></thead><tbody>{status.daily.map(day => <tr key={day.date}><td className="py-2">{day.date}</td><td className="text-right tabular-nums">{money(day.amountMinor)}</td></tr>)}</tbody></table></div>
      </details> : null}
    </> : !message ? <p role="status" data-status-for={`revenue:${asset}`}>Loading saved revenue…</p> : null}
  </section>;
}
