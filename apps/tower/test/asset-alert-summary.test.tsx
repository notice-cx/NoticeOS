import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from './render';
import { everyTabPayload } from './asset-detail-fixture';
import { AlertsTab } from '@/routes/asset-detail/AlertsTab';
import type { Severity } from '@shared/wall';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/hooks/useView', () => ({ useView: () => ({ view: { id: 'overview' } }) }));

describe('asset alert severity summary', () => {
  it.each<[Severity[], string]>([
    [[], 'No open alerts'],
    [['info'], '1 open alert, informational'],
    [['info', 'info'], '2 open alerts, both informational'],
    [['info', 'info', 'info'], '3 open alerts, all informational'],
    [['warn'], '1 open alert, a warning'],
    [['error'], '1 open alert, an error'],
    [['error', 'warn', 'info'], '3 open alerts, 1 error, 1 warning, 1 informational'],
  ])('counts %j accurately', (severities, summary) => {
    const data = everyTabPayload();
    const flag = data.flags.open[0]!;
    data.flags = { open: severities.map((severity, index) => ({ ...flag, id: index + 1, severity })),
      notCurrent: [], snoozed: [], history: [],
      openError: severities.filter(value => value === 'error').length,
      openWarn: severities.filter(value => value === 'warn').length };
    const { container } = render(<QueryClientProvider client={new QueryClient()}><MemoryRouter>
      <AlertsTab data={data} nowMs={Date.parse(data.generatedAt)} />
    </MemoryRouter></QueryClientProvider>);
    expect(screen.getByRole('heading', { name: summary })).toBeInTheDocument();
    if (severities.length > 0 && severities.every(value => value === 'info')) {
      expect(container.querySelector('[data-site-alerts-answer]')).toHaveAttribute('data-site-alerts-answer', 'info');
    }
  });
});
