import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, cleanup } from './render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduleEditor } from '@/routes/workflows/ScheduleEditor';
import { SCHEDULED_JOBS, type ScheduledJobsPayload, type ScheduleStatus } from '@shared/scheduled-jobs';
import { handleScheduledJobsRequest } from '../vite/scheduled-jobs-lane';

const mock = vi.hoisted(() => ({ save: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/api', async (original) => ({ ...await original<typeof import('@/lib/api')>(), saveConfig: mock.save }));
vi.mock('sonner', () => ({ toast: { success: mock.success, error: mock.error } }));
vi.mock('@/hooks/useConfigWritable', () => ({ useConfigWritable: () => ({ writable: true, reason: null, sources: {} }) }));
const backup = SCHEDULED_JOBS.find((job) => job.id === 'backup')!;
const overrides = { backup: { enabled: true, cron: '0 4 * * *' }, 'task-map': { enabled: false, cron: '5 * * * *' } };
let client: QueryClient;
let data: ScheduledJobsPayload;

function mount(element = <ScheduleEditor job={backup} overrides={null} writable onClose={() => {}} />) {
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mock.save.mockResolvedValue({ applied: 1 });
  data = { overrides: null, runtimeFresh: true, runtime: { updatedAt: new Date().toISOString(), error: null,
    jobs: SCHEDULED_JOBS.map((job) => ({ id: job.id, enabled: true, cron: job.cron, nextRun: '2026-09-10T04:00:00.000Z' })) } };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(data), { status: 200 })));
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); });

describe('scheduled job editing', () => {
  it('saves the first weekly schedule through the guarded document insert and offers exact Undo', async () => {
    const close = vi.fn();
    mount(<ScheduleEditor job={backup} overrides={null} writable onClose={close} />);
    fireEvent.change(screen.getByLabelText('Frequency'), { target: { value: 'weekly' } });
    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText(/^Local time/), { target: { value: '09:15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    const value = { backup: { enabled: true, cron: '15 9 * * 3', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } };
    await waitFor(() => expect(mock.save).toHaveBeenCalledWith([{ kind: 'file-json-insert', file: 'config/constants.json', pointer: '/schedules', value }], 'schedule-backup'));
    expect(close).toHaveBeenCalledOnce();
    const toast = mock.success.mock.calls[0]?.[1] as { action: { onClick: () => void } };
    toast.action.onClick();
    await waitFor(() => expect(mock.save).toHaveBeenLastCalledWith([{ kind: 'file-json-delete', file: 'config/constants.json', pointer: '/schedules', expect: value }], 'schedule-backup'));
  });

  it('pauses one job while guarding and preserving other jobs', async () => {
    mount(<ScheduleEditor job={backup} overrides={overrides} writable onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'paused' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(mock.save).toHaveBeenCalledWith([expect.objectContaining({
      kind: 'file-json-set', expect: overrides,
      value: { ...overrides, backup: { enabled: false, cron: backup.cron } },
    })], 'schedule-backup'));
  });

  it('preserves a different saved timezone when only pausing', async () => {
    const saved = { backup: { enabled: true, cron: '0 9 * * *', timezone: 'Asia/Tokyo' } };
    mount(<ScheduleEditor job={backup} overrides={saved} writable onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Save schedule' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'paused' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(mock.save).toHaveBeenCalledWith([expect.objectContaining({ value: { backup: { ...saved.backup, enabled: false } } })], 'schedule-backup'));
  });

  it('restores one default without removing another job’s pause', async () => {
    mount(<ScheduleEditor job={backup} overrides={overrides} writable onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore default' }));
    await waitFor(() => expect(mock.save).toHaveBeenCalledWith([expect.objectContaining({ value: { 'task-map': overrides['task-map'] }, expect: overrides })], 'schedule-backup'));
  });

  it('keeps failed edits visible and never reports an unconfirmed save as success', async () => {
    mock.save.mockRejectedValue(new Error('Store unavailable'));
    const close = vi.fn();
    mount(<ScheduleEditor job={backup} overrides={null} writable onClose={close} />);
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'paused' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    // What happened, and the one fix as a control rather than an instruction.
    expect(await screen.findByRole('alert')).toHaveTextContent('Not saved');
    expect(screen.getByLabelText('Status')).toHaveValue('paused');
    expect(close).not.toHaveBeenCalled();
    expect(mock.success).not.toHaveBeenCalled();
  });

  it('offers the fix for a refused save as a button that reloads and keeps the edit', async () => {
    mock.save.mockRejectedValueOnce(new Error('Changed elsewhere'));
    const reload = vi.fn(async () => {});
    mount(<ScheduleEditor job={backup} overrides={null} writable onClose={() => {}} onReload={reload} />);
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'paused' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reload saved schedule' }));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByLabelText('Status')).toHaveValue('paused');
  });

  it('validates hourly minutes and cancels without a write', async () => {
    const close = vi.fn();
    mount(<ScheduleEditor job={backup} overrides={null} writable onClose={close} />);
    fireEvent.change(screen.getByLabelText('Frequency'), { target: { value: 'hourly' } });
    fireEvent.change(screen.getByLabelText('Minute past the hour'), { target: { value: '60' } });
    expect(screen.getByRole('button', { name: 'Save schedule' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mock.save).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('a collection schedule as a row of Settings (bead ro-ujb9.96.7.12)', () => {
  const clarity = SCHEDULED_JOBS.find((job) => job.id === 'clarity')!;
  const revenue = SCHEDULED_JOBS.find((job) => job.id === 'mediavine')!;

  it('resumes a paused collection on its saved timing, through the one guarded write', async () => {
    const saved = { clarity: { enabled: false, cron: '30 4 * * *' } };
    mount(<ScheduleEditor variant="row" job={clarity} overrides={saved} writable />);
    expect(screen.getByLabelText('Clarity recordings summary · how often')).toHaveValue('paused');
    // Paused shows no timing controls at all: there is nothing to time.
    expect(screen.queryByLabelText('Clarity recordings summary · time')).toBeNull();

    fireEvent.change(screen.getByLabelText('Clarity recordings summary · how often'), { target: { value: 'daily' } });
    await waitFor(() => expect(mock.save).toHaveBeenCalledWith([{
      kind: 'file-json-set', file: 'config/constants.json', pointer: '/schedules',
      expect: saved, value: { clarity: { enabled: true, cron: '30 4 * * *' } },
    }], 'schedule-clarity'));
    // Confirmed beside the row, never in a toast.
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(mock.success).not.toHaveBeenCalled();
  });

  it('shows a timing the picks cannot express as itself, and writes nothing until changed', () => {
    mount(<ScheduleEditor variant="row" job={revenue} overrides={null} writable />);
    const how = screen.getByLabelText('Ad revenue · how often') as HTMLSelectElement;
    expect(how).toHaveValue('current');
    expect(how.selectedOptions[0]?.textContent).toMatch(/^Hourly at :\d\d, :\d\d, :\d\d$/);
    expect(mock.save).not.toHaveBeenCalled();
  });

  it('disables every pick while saves are paused', () => {
    mount(<ScheduleEditor variant="row" job={clarity} overrides={null} writable={false} />);
    for (const select of screen.getAllByRole('combobox')) expect(select).toBeDisabled();
  });
});

describe('schedule status read endpoint', () => {
  const request = { method: 'GET', headers: {}, body: '' };
  const runtime: ScheduleStatus = { updatedAt: '2026-09-09T12:00:00Z', error: null, jobs: [] };
  it('marks old and future status timestamps unconfirmed', async () => {
    for (const date of ['2026-09-09T12:01:00Z', '2026-09-09T11:59:00Z']) {
      const result = await handleScheduledJobsRequest(request, { read: async () => null, status: async () => runtime, now: () => Date.parse(date) });
      expect(result.body.runtimeFresh).toBe(false);
    }
  });
  it('returns saved configuration with absent runtime honestly and refuses writes', async () => {
    const dependencies = { read: async () => overrides, status: async () => null };
    const result = await handleScheduledJobsRequest(request, dependencies);
    expect(result.body).toEqual({ overrides, runtime: null, runtimeFresh: false });
    expect((await handleScheduledJobsRequest({ ...request, method: 'PUT' }, dependencies)).status).toBe(405);
  });
  it('does not leak a failed store response or claim a fallback schedule', async () => {
    const result = await handleScheduledJobsRequest(request, { read: async () => { throw new Error('raw provider response'); }, status: async () => runtime });
    expect(result.status).toBe(503);
    expect(JSON.stringify(result.body)).not.toContain('raw provider response');
  });
});
