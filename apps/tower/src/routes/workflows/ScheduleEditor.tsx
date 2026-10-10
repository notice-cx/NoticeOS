import { Lock } from 'lucide-react';
import { useState } from 'react';
import { Cron } from 'croner';
import { SCHEDULES_FILE, SCHEDULES_POINTER, WEEKDAYS, scheduleFor, scheduleTimezone, scheduleCronRefusal, scheduleLabel, formatNextRun, utcRunReference, localTimezone, localTimezoneLabel, localScheduleFields, type JobSchedule, type ScheduleOverrides, type ScheduledJob } from '@shared/scheduled-jobs';
import type { JsonValue, SettingOp } from '@shared/changeset';
import { InlineSaveState, type InlineSave } from '@/components/InlineSaveState';
import { Button } from '@/components/ui/button';
import { fieldClass } from '@/components/ui/field';
import { type FieldUndoOutcome, useConfigSave, useFieldConfigSave, useLandmarkSave } from '@/hooks/useConfigSave';
import { cn } from '@/lib/utils';

function initialFrequency(cron: string): string {
  const [minute, hour, , , day] = cron.split(' ');
  if ((minute === '*' || minute?.startsWith('*/')) && hour === '*' && day === '*') return 'minutes';
  if (/^\d+$/.test(minute ?? '') && hour === '*' && day === '*') return 'hourly';
  if (/^\d+$/.test(minute ?? '') && /^\d+$/.test(hour ?? '')) return day === '*' ? 'daily' : /^\d$/.test(day ?? '') ? 'weekly' : 'current';
  return 'current';
}

/** A schedule as the editor's controls hold it: whether it runs, and its
 * timing as the fields show it in `displayTimezone`. */
interface ScheduleFields { enabled: boolean; frequency: string; interval: string; atMinute: string; time: string; weekday: string }

function fieldsOf(current: JobSchedule, displayTimezone: string): ScheduleFields {
  const [minute] = current.cron.split(' ');
  const local = localScheduleFields(current.cron, scheduleTimezone(current), displayTimezone);
  return {
    enabled: current.enabled,
    frequency: initialFrequency(current.cron),
    interval: minute === '*' ? '1' : minute?.startsWith('*/') ? minute.slice(2) : '15',
    atMinute: local.minute,
    time: local.time,
    weekday: local.weekday,
  };
}

/**
 * The one answer to "what do these fields save", shared by the form and the
 * row, so a schedule picked in Settings and one set in System health can
 * never be two different crons for the same choice. Timing the operator did
 * not touch keeps its saved cron and zone exactly; timing they changed is
 * written in the zone the fields are shown in.
 */
function scheduleFrom(current: JobSchedule, initial: ScheduleFields, fields: ScheduleFields, displayTimezone: string) {
  const { frequency, interval, atMinute, time, weekday, enabled } = fields;
  const [hours, minutes] = time.split(':');
  const timingChanged = frequency !== initial.frequency || (frequency === 'minutes' && interval !== initial.interval) || (frequency === 'hourly' && atMinute !== initial.atMinute) || (['daily', 'weekly'].includes(frequency) && time !== initial.time) || (frequency === 'weekly' && weekday !== initial.weekday);
  const cron = !timingChanged || frequency === 'current' ? current.cron : frequency === 'minutes' ? interval === '1' ? '* * * * *' : `*/${interval} * * * *`
    : frequency === 'hourly' ? `${atMinute} * * * *` : `${Number(minutes)} ${Number(hours)} * * ${frequency === 'weekly' ? weekday : '*'}`;
  const timezone = timingChanged && frequency !== 'current' ? displayTimezone : scheduleTimezone(current);
  const schedule: JobSchedule = { ...current, enabled, cron, ...(timingChanged ? { timezone } : {}) };
  return { cron, timezone, timingChanged, changed: enabled !== current.enabled || timingChanged, schedule };
}

/** The saved schedules with this job's set to `next`, or put back on its
 * default when `next` is null. */
function withSchedule(overrides: ScheduleOverrides | null, jobId: string, next: JobSchedule | null): ScheduleOverrides {
  const value: ScheduleOverrides = { ...overrides };
  if (next === null) delete value[jobId];
  else value[jobId] = next;
  return value;
}

/**
 * One job's schedule, edited in place, fields in local time. A refused save
 * keeps the operator's values and offers reloading what is saved.
 * `variant="row"` is the same editor as one Settings row ({@link ScheduleRow}).
 */
export function ScheduleEditor(props: {
  job: ScheduledJob;
  overrides: ScheduleOverrides | null;
  writable: boolean;
  variant?: 'form';
  onClose: () => void;
  onReload?: () => Promise<void>;
} | {
  job: ScheduledJob;
  overrides: ScheduleOverrides | null;
  writable: boolean;
  variant: 'row';
  /** What the row just wrote (or its Undo put back), so the next row's guard
   * is the schedules as they now are, before the page's read catches up. */
  onWritten?: (next: ScheduleOverrides | null) => void;
}) {
  if (props.variant === 'row') return <ScheduleRow job={props.job} overrides={props.overrides} writable={props.writable} onWritten={props.onWritten} />;
  return <ScheduleForm job={props.job} overrides={props.overrides} writable={props.writable} onClose={props.onClose} onReload={props.onReload} />;
}

function ScheduleForm({ job, overrides, writable, onClose, onReload }: { job: ScheduledJob; overrides: ScheduleOverrides | null; writable: boolean; onClose: () => void; onReload?: () => Promise<void> }) {
  const current = scheduleFor(job, overrides ?? {});
  const [displayTimezone] = useState(localTimezone);
  const [initial] = useState(() => fieldsOf(current, displayTimezone));
  const [enabled, setEnabled] = useState(current.enabled);
  const [frequency, setFrequency] = useState(initial.frequency);
  const [interval, setInterval] = useState(initial.interval);
  const [atMinute, setAtMinute] = useState(initial.atMinute);
  const [time, setTime] = useState(initial.time);
  const [weekday, setWeekday] = useState(initial.weekday);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const save = useConfigSave();
  const insert = useLandmarkSave();
  const { cron, timezone, changed, schedule } = scheduleFrom(current, initial, { enabled, frequency, interval, atMinute, time, weekday }, displayTimezone);
  const invalid = scheduleCronRefusal(cron);
  let next: string[] = [];
  if (!invalid && enabled) {
    const preview = new Cron(cron, { timezone, paused: true });
    next = preview.nextRuns(3).map((date) => date.toISOString());
    preview.stop();
  }
  async function write(reset = false) {
    if (!writable || busy || (!reset && invalid)) return;
    setBusy(true); setFailed(false);
    const value = withSchedule(overrides, job.id, reset ? null : schedule);
    const label = `${job.label} schedule`;
    const slug = `schedule-${job.id}`;
    const saved = overrides === null
      ? await insert({ op: { kind: 'file-json-insert', file: SCHEDULES_FILE, pointer: SCHEDULES_POINTER, value: value as unknown as JsonValue }, label, slug })
      : await save({ ops: [{ kind: 'file-json-set', file: SCHEDULES_FILE, pointer: SCHEDULES_POINTER, expect: overrides as unknown as JsonValue, value: value as unknown as JsonValue }], label, slug });
    setBusy(false);
    if (saved) onClose(); else setFailed(true);
  }
  return <form className="mt-4 space-y-4 rounded-md border border-border bg-muted/30 p-4" aria-label={`${job.label} schedule`} onSubmit={(event) => { event.preventDefault(); void write(); }}>
    <fieldset disabled={busy || !writable} className="flex flex-wrap items-end gap-4">
      <label className="flex flex-col gap-1.5 text-sm">Status
        <select autoFocus className={fieldClass} value={enabled ? 'enabled' : 'paused'} onChange={(event) => setEnabled(event.target.value === 'enabled')}><option value="enabled">Enabled</option><option value="paused">Paused</option></select>
      </label>
      <label className="flex flex-col gap-1.5 text-sm">Frequency
        <select className={fieldClass} value={frequency} onChange={(event) => setFrequency(event.target.value)}>
          <option value="minutes">Every few minutes</option><option value="hourly">Hourly</option><option value="daily">Daily</option><option value="weekly">Weekly</option>
          {initial.frequency === 'current' && <option value="current">Keep current timing</option>}
        </select>
      </label>
      {frequency === 'minutes' && <label className="flex flex-col gap-1.5 text-sm">Minutes
        <select className={cn(fieldClass, 'tabular-nums')} value={interval} onChange={(event) => setInterval(event.target.value)}>{[...new Set(['1', '5', '10', '15', '20', '30', interval])].map((n) => <option key={n}>{n}</option>)}</select>
      </label>}
      {frequency === 'hourly' && <label className="flex flex-col gap-1.5 text-sm">Minute past the hour
        <input className={cn(fieldClass, 'w-24 tabular-nums')} type="number" min="0" max="59" required value={atMinute} onChange={(event) => setAtMinute(event.target.value)} />
      </label>}
      {(frequency === 'daily' || frequency === 'weekly') && <label className="flex flex-col gap-1.5 text-sm">Local time · {localTimezoneLabel(Date.now(), displayTimezone)}
        <input className={cn(fieldClass, 'tabular-nums')} type="time" required value={time} onChange={(event) => setTime(event.target.value)} />
      </label>}
      {frequency === 'weekly' && <label className="flex flex-col gap-1.5 text-sm">Day
        <select className={fieldClass} value={weekday} onChange={(event) => setWeekday(event.target.value)}>{WEEKDAYS.map((name, index) => <option key={name} value={index}>{name}</option>)}</select>
      </label>}
    </fieldset>
    <p className="text-xs text-muted-foreground tabular-nums">{!enabled ? 'Future runs and recovery after downtime will be paused.' : next.length ? <>Next runs: {next.map((date, index) => <span key={date}>{index > 0 && ' · '}<time dateTime={date} title={utcRunReference(date)}>{formatNextRun(date, displayTimezone)}</time></span>)}</> : invalid}</p>
    {failed && <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-error">Not saved — the schedule may have changed.
      {onReload && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { setBusy(true); void onReload().finally(() => { setBusy(false); setFailed(false); }); }}>Reload saved schedule</Button>}
    </p>}
    <div className="flex flex-wrap gap-2">
      <Button type="submit" size="sm" disabled={busy || !writable || Boolean(invalid) || !changed}>{busy ? 'Saving…' : 'Save schedule'}</Button>
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onClose}>Cancel</Button>
      {overrides?.[job.id] && <Button type="button" variant="ghost" size="sm" disabled={busy || !writable} onClick={() => void write(true)}>Restore default</Button>}
    </div>
  </form>;
}

/** Every quarter hour of the day, plus the saved time when it sits between them. */
function timeOptions(time: string): string[] {
  const grid = Array.from({ length: 96 }, (_, index) => `${String(Math.floor(index / 4)).padStart(2, '0')}:${String((index % 4) * 15).padStart(2, '0')}`);
  return grid.includes(time) ? grid : [...grid, time].sort();
}

/** Every five minutes past the hour, plus the saved minute when it is between. */
function minuteOptions(minute: string): string[] {
  const grid = Array.from({ length: 12 }, (_, index) => String(index * 5));
  return grid.includes(minute) ? grid : [...grid, minute].sort((a, b) => Number(a) - Number(b));
}

/**
 * One collection's schedule as one Settings row. Every control is a select and
 * every pick saves, so there is no half-typed state (a time is a pick, not a
 * box). The same write as the form: one `file-json-set` of
 * `config/constants.json` `/schedules`, guarded by the whole saved object.
 */
function ScheduleRow({ job, overrides, writable, onWritten }: { job: ScheduledJob; overrides: ScheduleOverrides | null; writable: boolean; onWritten?: (next: ScheduleOverrides | null) => void }) {
  const current = scheduleFor(job, overrides ?? {});
  const [displayTimezone] = useState(localTimezone);
  const fields = fieldsOf(current, displayTimezone);
  const saveField = useFieldConfigSave();
  const [saving, setSaving] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [outcome, setOutcome] = useState<
    | { kind: 'saved'; undo: () => Promise<FieldUndoOutcome>; before: ScheduleOverrides | null }
    | { kind: 'refused'; refusal: string }
    | null
  >(null);

  async function pick(change: Partial<ScheduleFields>) {
    const next = { ...fields, ...change };
    const { cron, schedule, changed } = scheduleFrom(current, fields, next, displayTimezone);
    if (!changed || scheduleCronRefusal(cron) !== null) return;
    const value = withSchedule(overrides, job.id, schedule);
    const op: SettingOp = overrides === null
      ? { kind: 'file-json-set', file: SCHEDULES_FILE, pointer: SCHEDULES_POINTER, expectAbsent: true, value: value as unknown as JsonValue }
      : { kind: 'file-json-set', file: SCHEDULES_FILE, pointer: SCHEDULES_POINTER, expect: overrides as unknown as JsonValue, value: value as unknown as JsonValue };
    setSaving(true);
    setOutcome(null);
    try {
      const result = await saveField({ ops: [op], label: `${job.label} schedule`, slug: `schedule-${job.id}` });
      if (!result.saved) {
        setOutcome({ kind: 'refused', refusal: result.refusal });
        return;
      }
      setOutcome({ kind: 'saved', undo: result.undo, before: overrides });
      onWritten?.(value);
    } finally {
      setSaving(false);
    }
  }

  async function undo() {
    if (outcome?.kind !== 'saved') return;
    setUndoing(true);
    try {
      const back = await outcome.undo();
      if (back.undone) {
        setOutcome(null);
        onWritten?.(outcome.before);
      } else {
        setOutcome({ kind: 'refused', refusal: back.refusal });
      }
    } finally {
      setUndoing(false);
    }
  }

  const save: InlineSave = saving
    ? { state: 'saving' }
    : outcome?.kind === 'saved'
      ? { state: 'saved', undoing, onUndo: () => void undo() }
      : outcome?.kind === 'refused'
        ? { state: 'refused', refusal: outcome.refusal }
        : { state: 'idle' };
  const disabled = !writable || saving || undoing;
  const how = fields.enabled ? fields.frequency : 'paused';

  return (
    // The row lays out by its list's own width (`ScheduleRows`' container), not
    // the screen's: a Manage panel is 430px wide on any desk, so there the
    // label sits over its picks.
    <div className="flex flex-col gap-2 border-b border-border py-3 last:border-0 @xl:flex-row @xl:items-center @xl:justify-between @xl:gap-4" data-schedule-row={job.id}>
      <div className="flex min-w-0 flex-col">
        <span className="text-sm font-medium text-foreground">{job.label}</span>
        {job.source ? <span className="truncate text-xs text-muted-foreground">{job.source}</span> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 @xl:justify-end">
        <select
          aria-label={`${job.label} · how often`}
          className={fieldClass}
          value={how}
          disabled={disabled}
          onChange={(event) => {
            const value = event.target.value;
            void pick(value === 'paused' ? { enabled: false } : { enabled: true, frequency: value });
          }}
        >
          <option value="paused">Paused</option>
          <option value="minutes">Every few minutes</option>
          <option value="hourly">Hourly</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          {fields.frequency === 'current' ? <option value="current">{scheduleLabel(current.cron, scheduleTimezone(current), Date.now(), displayTimezone)}</option> : null}
        </select>
        {how === 'minutes' ? (
          <select aria-label={`${job.label} · every`} className={cn(fieldClass, 'tabular-nums')} value={fields.interval} disabled={disabled} onChange={(event) => void pick({ interval: event.target.value })}>
            {[...new Set(['1', '5', '10', '15', '20', '30', fields.interval])].map((n) => <option key={n} value={n}>{n === '1' ? 'Every minute' : `Every ${n} min`}</option>)}
          </select>
        ) : null}
        {how === 'hourly' ? (
          <select aria-label={`${job.label} · minute past the hour`} className={cn(fieldClass, 'tabular-nums')} value={fields.atMinute} disabled={disabled} onChange={(event) => void pick({ atMinute: event.target.value })}>
            {minuteOptions(fields.atMinute).map((m) => <option key={m} value={m}>:{m.padStart(2, '0')}</option>)}
          </select>
        ) : null}
        {how === 'weekly' ? (
          <select aria-label={`${job.label} · day`} className={fieldClass} value={fields.weekday} disabled={disabled} onChange={(event) => void pick({ weekday: event.target.value })}>
            {WEEKDAYS.map((name, index) => <option key={name} value={index}>{name}</option>)}
          </select>
        ) : null}
        {how === 'daily' || how === 'weekly' ? (
          <select aria-label={`${job.label} · time`} className={cn(fieldClass, 'tabular-nums')} value={fields.time} disabled={disabled} onChange={(event) => void pick({ time: event.target.value })}>
            {timeOptions(fields.time).map((time) => <option key={time} value={time}>{time}</option>)}
          </select>
        ) : null}
        <InlineSaveState save={save} subject={`field:schedule:${job.id}`} />
      </div>
    </div>
  );
}

/** Canonical text of a schedules object, key order aside — two reads of the
 * same saved value compare equal however the store orders its keys. */
function scheduleKey(value: ScheduleOverrides | null): string {
  if (value === null) return 'null';
  return JSON.stringify(Object.keys(value).sort().map((id) => [id, value[id]!.enabled, value[id]!.cron, value[id]!.timezone ?? null]));
}

/**
 * The collection schedules, one row each. All rows write one saved object
 * guarded by what it held, so the list keeps its own writes until the page's
 * read catches up; otherwise a second pick before the refresh would be refused
 * as "changed elsewhere". The kept value drops once the read shows a foreign write.
 */
export function ScheduleRows({ jobs, overrides, writable }: { jobs: readonly ScheduledJob[]; overrides: ScheduleOverrides | null; writable: boolean }) {
  const [local, setLocal] = useState<{ value: ScheduleOverrides | null; trail: string[] } | null>(null);
  const read = scheduleKey(overrides);
  const effective = local !== null && local.trail.includes(read) ? local.value : overrides;
  const [zone] = useState(localTimezone);
  function written(next: ScheduleOverrides | null) {
    setLocal((was) => {
      const trail = was !== null && was.trail.includes(read) ? was.trail : [read];
      return { value: next, trail: [...new Set([...trail, scheduleKey(effective)])].filter((key) => key !== scheduleKey(next)) };
    });
  }
  return (
    <div className="@container flex flex-col" data-collection-schedules={jobs.length}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 pb-1">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
          Collection schedule
          {writable ? null : (
            // The page says why once (`SavesPaused`); the rows show the state
            // as a lock, and say it to a screen reader.
            <span className="inline-flex items-center text-muted-foreground" data-schedules-locked>
              <Lock aria-hidden className="size-3.5" />
              <span className="sr-only">Saves paused</span>
            </span>
          )}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">Local time · {localTimezoneLabel(Date.now(), zone)}</span>
      </div>
      {jobs.map((job) => <ScheduleEditor key={job.id} variant="row" job={job} overrides={effective} writable={writable} onWritten={written} />)}
    </div>
  );
}
