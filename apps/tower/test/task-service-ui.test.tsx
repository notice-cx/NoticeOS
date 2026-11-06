import { act, fireEvent, render, screen } from './render';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Toaster, toast } from 'sonner';
import { afterEach, expect, it, vi } from 'vitest';
import { useInboxAnswer } from '@/hooks/useTasks';
import { TASK_SERVICE_KEY } from '@/hooks/useTaskService';
import { resetAnswerQueue } from '@/lib/answer-queue';
import { ntasksProjectColumn } from '@/routes/settings/TaskServicePanel';

// While tasks live in Ntasks an inbox answer reads as done only after Ntasks
// confirms it, and Settings → Task projects names each site's Ntasks project.

const { resolve } = vi.hoisted(() => ({ resolve: vi.fn<() => Promise<void>>() }));
vi.mock('@/lib/api', async (original) => ({ ...await original<typeof import('@/lib/api')>(), resolveGate: resolve }));

function Approve() {
  const answer = useInboxAnswer();
  return <button onClick={() => answer({ kind: 'approve', id: 'ex-gate', title: 'Approve the launch' })}>Approve</button>;
}
function mount(connected: boolean | null) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  client.setQueryData(TASK_SERVICE_KEY, { connected, origin: connected ? 'https://ntasks.example.com' : null, projects: null });
  const view = render(<QueryClientProvider client={client}><MemoryRouter><Approve /><Toaster /></MemoryRouter></QueryClientProvider>);
  const shown = () => [...view.container.querySelectorAll<HTMLElement>('[data-sonner-toast][data-removed="false"]')].map(node => node.textContent ?? '');
  return { ...view, shown, client };
}

afterEach(() => { toast.dismiss(); resetAnswerQueue(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it.each([
  ['confirmed', true],
  ['refused', false],
] as const)('says Approved only once Ntasks has confirmed the approval (%s)', async (_label, confirmed) => {
  vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
  vi.useFakeTimers();
  if (confirmed) resolve.mockResolvedValue(undefined);
  else resolve.mockRejectedValue(new Error('Ntasks could not be reached, so nothing was saved.'));
  const { shown, unmount, client } = mount(true);
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(40); });
  expect(shown().join(' ')).toContain('Approving');
  expect(shown().join(' ')).not.toMatch(/Approved/u);
  // The Undo window ends; the answer is sent and Ntasks answers.
  await act(async () => { await vi.advanceTimersByTimeAsync(5_001); });
  await act(async () => { await vi.advanceTimersByTimeAsync(40); });
  expect(resolve).toHaveBeenCalledTimes(1);
  const after = shown().join(' ');
  if (confirmed) expect(after).toContain('Approved');
  else { expect(after).not.toMatch(/Approved/u); expect(after).toContain('nothing was saved'); }
  unmount(); client.clear();
});

it('waits for the confirmation while the ingest cannot say where the tasks live', async () => {
  vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
  vi.useFakeTimers();
  resolve.mockResolvedValue(undefined);
  const { shown, unmount, client } = mount(null);
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(40); });
  expect(shown().join(' ')).toContain('Approving');
  expect(shown().join(' ')).not.toMatch(/Approved/u);
  unmount(); client.clear();
});

it('keeps the Undo-window wording while tasks stay on the local task database', async () => {
  vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
  vi.useFakeTimers();
  resolve.mockResolvedValue(undefined);
  const { shown, unmount, client } = mount(false);
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(40); });
  expect(shown().join(' ')).toContain('Approved');
  unmount(); client.clear();
});

it('names the Ntasks project of each site, and a site whose prefix none has', () => {
  const column = ntasksProjectColumn({ connected: true, origin: 'https://ntasks.example.com', projects: [
    { asset: 'example.com', prefix: 'ex', project: { displayName: 'Example', logicalKey: 'example.com' } },
    { asset: 'shop.example', prefix: 'shop', project: null },
  ] });
  const cell = (key: string) => render(<>{column.render({ key, values: {} } as never)}</>).container;
  expect(cell('example.com').querySelector('[data-ntasks-project="example.com"]')).toHaveTextContent('Example');
  expect(cell('shop.example').querySelector('[data-ntasks-unmapped]')).toHaveTextContent('No project with this prefix');
  const unknown = ntasksProjectColumn({ connected: true, origin: null, projects: null, reason: 'https://ntasks.example.com did not answer (network).' });
  expect(render(<>{unknown.render({ key: 'example.com', values: {} } as never)}</>).container.querySelector('[data-ntasks-project-unknown]')).toHaveTextContent('Unknown');
});
