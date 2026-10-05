import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { MediavineStatus, RevenueHolidayCalendar } from '@noticeos/contract';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Meter } from '@/components/Meter';
import { StateChip } from '@/components/StateChip';
import { useBrowserRuntime, useTowerApi } from '@/lib/browser-context';
import { useConfigWritable } from '@/hooks/useConfigWritable';

const money = (minor: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(minor / 100);
/** Days of saved daily revenue the Wall's forecast needs before it learns
 * weekday and holiday effects (three weeks). A meter toward it replaces the
 * sentence that asked the operator to backfill (bead `ro-ujb9.96.6.4`). */
const FORECAST_DAYS = 21;
/** The earliest start one backfill request may ask for: a year before its end.
 * The date picker enforces it, so the limit needs no sentence. */
function yearBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() - 364);
  return d.toISOString().slice(0, 10);
}
/**
 * A SITE'S MEDIAVINE REVENUE, once it is collected: how far it reaches, a
 * refresh, a backfill, the forecast calendar and the saved days.
 *
 * Which Mediavine site this is — and starting the sync — is the connect
 * panel's (bead `ro-ujb9.96.7.6`): the row's Connect opens it over this page
 * with this site first, and Start saves the site and collects. Stopping is the
 * row's own Not using, as for every source. So nothing here picks a site, loads
 * the account's sites or switches the sync on and off, and nothing shows until
 * a site is mapped. The row's chip is the one status; this adds none.
 */
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
    try { const value = await work(); if (active()) { setStatus(value); await cache.invalidateQueries(); } }
    catch (error) { if (active()) setMessage(error instanceof Error ? error.message : 'The action failed. Try again.'); }
    finally { if (active()) setBusy(false); }
  }
  const stamp = (value: string | null) => value ? new Date(value).toLocaleString() : 'Never';
  const days = status?.daily.length ?? 0;
  // Nothing mapped, or no login: the row's Connect is the one action.
  if (status && (!status.connected || status.siteId === null)) return null;
  return <section aria-label="Mediavine revenue" className="flex min-w-0 flex-col gap-3 border-t border-border pt-3">
    {/* The schedule is a chip, not a sentence (bead `ro-ujb9.96.6.4`): the
        sync collects yesterday, once a day, at 6:10 a.m. Pacific. */}
    <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold text-foreground">Mediavine revenue</h3>
      <StateChip label="Daily · 6:10 a.m. PT" tone="neutral" dot="hollow" subject={`revenue:${asset}`} />
      {status?.enabled ? <Button size="sm" variant="outline" className="ms-auto" disabled={busy || !writable} onClick={() => void action(() => api.syncMediavine({ asset }))}>{busy ? 'Working…' : 'Refresh revenue'}</Button> : null}
    </div>
    {message ? <p role="alert" className="m-0 text-foreground">{message}</p> : null}
    {status ? <>
      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        {/* Saved figures are Mediavine's estimates until a payment reconciles
            them: a chip on the figure, not a sentence above the card. */}
        <div><dt className="text-muted-foreground">Reported through</dt><dd className="m-0 flex flex-wrap items-center gap-2 font-medium text-foreground">{status.reportedThrough ?? 'No revenue collected yet'}{status.reportedThrough ? <StateChip label="Estimates" tone="na" subject={`revenue:${asset}`} /> : null}</dd></div>
        <div><dt className="text-muted-foreground">Last successful sync</dt><dd className="m-0">{stamp(status.lastSuccessAt)}</dd></div>
        <div><dt className="text-muted-foreground">Last attempt</dt><dd className="m-0">{stamp(status.lastAttemptAt)}</dd></div>
        {status.nextAttemptAt ? <div><dt>Next retry</dt><dd className="m-0">{stamp(status.nextAttemptAt)}</dd></div> : null}
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
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-col gap-1">Forecast holiday calendar
          <select className="min-h-11 rounded-md border border-input bg-background px-3 text-foreground" value={holidayCalendar} disabled={busy || !writable} onChange={event => setHolidayCalendar(event.target.value as RevenueHolidayCalendar)}>
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
      {status.daily.length ? <details><summary className="min-h-11 cursor-pointer py-3 font-medium">Saved daily revenue · {status.daily.length} days</summary>
        <div className="max-h-80 overflow-auto"><table className="w-full text-sm"><caption className="sr-only">Mediavine daily revenue estimates in USD</caption><thead><tr><th className="text-left">Report date</th><th className="text-right">Estimated revenue</th></tr></thead><tbody>{status.daily.map(day => <tr key={day.date}><td className="py-2">{day.date}</td><td className="text-right tabular-nums">{money(day.amountMinor)}</td></tr>)}</tbody></table></div>
      </details> : null}
    </> : !message ? <p role="status" data-status-for={`revenue:${asset}`}>Loading saved revenue…</p> : null}
  </section>;
}
