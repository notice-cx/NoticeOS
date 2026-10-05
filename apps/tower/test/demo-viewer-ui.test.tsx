import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from './render';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateDemoViewer } from '../shared/demo-viewer';
import { DemoViewerStatus } from '@/components/DemoViewerStatus';
import { PropertyFavicon } from '@/components/PropertyFavicon';
import { useCalendarUpcoming } from '@/hooks/useCalendarUpcoming';
import { useGa4Realtime } from '@/hooks/useGa4Realtime';
import { useConfigWritable } from '@/hooks/useConfigWritable';
import { FileTaskButton } from '@/components/TaskComposer';
import { FlagActions } from '@/components/FlagActions';

const clock = vi.hoisted(() => ({ now: Date.parse('2026-09-16T12:00:00.000Z') }));
vi.mock('@/hooks/useNow', () => ({ useNow: () => clock.now }));
const descriptor = (generatedAt: string | null = null) => validateDemoViewer({ version: 1, synthetic: true,
  release: '1'.repeat(40), scenarioHash: '2'.repeat(64), workspaceId: '11111111-1111-4111-8111-111111111111',
  cutoff: '2026-09-15T12:00:00.000Z', generatedAt });
afterEach(() => { vi.unstubAllGlobals(); clock.now = Date.parse('2026-09-16T12:00:00.000Z'); });

function Reads() {
  useCalendarUpcoming(); useGa4Realtime();
  const capability = useConfigWritable();
  return <span data-testid="config-writable">{String(capability.writable)}</span>;
}
describe('the synthetic viewer screen state', () => {
  it('states unknown generation time rather than borrowing the cutoff or a page read', () => {
    vi.stubGlobal('__DEMO_VIEWER__', descriptor());
    render(<DemoViewerStatus />);
    expect(screen.getAllByText('Synthetic demo · Read only')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveAttribute('data-status-for', 'mode:demo');
    expect(screen.getByText('Generation time unknown')).toBeInTheDocument();
  });
  it('keeps the real generation timestamp and ages when the page refreshes', () => {
    vi.stubGlobal('__DEMO_VIEWER__', descriptor('2026-09-16T11:55:00.000Z'));
    const view = render(<DemoViewerStatus />);
    expect(screen.getByText('Generated 5m ago')).toHaveAttribute('title', '2026-09-16T11:55:00.000Z');
    clock.now += 60 * 60 * 1000; view.rerender(<DemoViewerStatus />);
    expect(screen.getByText('Generated 1h ago')).toHaveAttribute('title', '2026-09-16T11:55:00.000Z');
  });
  it('two independent visitors never request providers or external favicons and start read-only', async () => {
    vi.stubGlobal('__DEMO_VIEWER__', descriptor());
    const fetch = vi.fn(async (path: unknown) => {
      expect(path).toBe('/api/config');
      return Response.json({ writable: true, reason: null, sources: { 'config/beads.json': 'store' } });
    });
    vi.stubGlobal('fetch', fetch);
    for (let visitor = 0; visitor < 2; visitor++) {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
      const view = render(<QueryClientProvider client={client}><Reads /><PropertyFavicon domain="sentinel.example" displayName="Example" /></QueryClientProvider>);
      expect(screen.getByTestId('config-writable')).toHaveTextContent('false');
      expect(view.container.querySelector('img')).toBeNull();
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(visitor + 1));
      view.unmount(); client.clear();
    }
    expect(fetch.mock.calls.every(([path]) => path === '/api/config')).toBe(true);
  });
  it('ordinary installations show their existing favicon and no demo identity', () => {
    const view = render(<><DemoViewerStatus /><PropertyFavicon domain="example.com" displayName="Example" /></>);
    expect(view.container.querySelector('[data-demo-viewer]')).toBeNull();
    expect(view.container.querySelector('img')).toHaveAttribute('src', 'https://example.com/favicon.ico');
  });
  it('disables a task composer even with an optimistic or gallery capability, and shows no alert mutation controls', () => {
    vi.stubGlobal('__DEMO_VIEWER__', descriptor());
    const onFile = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ live: true, reason: null })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const view = render(<QueryClientProvider client={client}>
      <FileTaskButton capabilities={{ live: true, reason: null }} onFile={onFile} />
      <FlagActions flagId={1} assetId="example.com" />
    </QueryClientProvider>);
    expect(screen.getByRole('button', { name: 'File task' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Resolve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Snooze' })).toBeNull();
    expect(onFile).not.toHaveBeenCalled();
    view.unmount(); client.clear();
  });
});
