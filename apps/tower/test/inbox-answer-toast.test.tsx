import { act, fireEvent, render, screen, within } from './render';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Toaster, toast } from 'sonner';
import { afterEach, expect, it, vi } from 'vitest';
import { useInboxAnswer } from '@/hooks/useTasks';
import { flushAnswers, resetAnswerQueue } from '@/lib/answer-queue';

const respond = vi.hoisted(() => vi.fn<() => Promise<void>>().mockResolvedValue(undefined));
vi.mock('@/lib/api', async (original) => ({ ...await original<typeof import('@/lib/api')>(), respondToTask: respond }));

function Answer() {
  const answer = useInboxAnswer();
  return <button onClick={() => answer({ kind: 'answer', id: 'ex-question', title: 'Choose a day', text: 'Tuesday' })}>Send answer</button>;
}

afterEach(() => {
  toast.dismiss();
  resetAnswerQueue();
  vi.useRealTimers();
  vi.clearAllMocks();
});

it('shows a fresh toast with working Undo when the same task is answered during the previous toast exit', async () => {
  vi.useFakeTimers();
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  const { container, unmount } = render(<QueryClientProvider client={client}><MemoryRouter><Answer /><Toaster /></MemoryRouter></QueryClientProvider>);
  const answer = () => fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
  const visibleToast = () => container.querySelector<HTMLElement>('[data-sonner-toast][data-removed="false"]')!;
  answer();
  await act(async () => { await vi.advanceTimersByTimeAsync(40); });
  const first = visibleToast();
  expect(first).toHaveTextContent('Answered');
  fireEvent.click(within(first).getByRole('button', { name: 'Undo' }));
  answer();
  await act(async () => { await vi.advanceTimersByTimeAsync(40); });
  const second = visibleToast();
  expect(second).not.toBe(first);
  expect(second).toHaveAttribute('data-mounted', 'true');
  expect(second).toHaveTextContent('Answered');
  // Let the first toast's removal timer expire while the next answer waits.
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(second).toBeInTheDocument();
  fireEvent.click(within(second).getByRole('button', { name: 'Undo' }));
  await act(async () => { flushAnswers(); await vi.advanceTimersByTimeAsync(5_001); });
  expect(respond).not.toHaveBeenCalled();
  unmount();
  client.clear();
});
