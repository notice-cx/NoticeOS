import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StripeReport } from '../src/routes/asset-detail/StripeReport';
import type { StripeSubscriptionReport } from '@noticeos/contract/stripe-report';

const latest = { currency: 'JPY', observedAt: '2026-09-29T12:00:00Z', activeSubscriptions: 2, trials: 1, pastDue: 1,
  canceling: 1, unmeasuredSubscriptions: 0, mrrMinor: 2500, paidCustomers: 2 };
const report: StripeSubscriptionReport = { latest, history: [latest], comparisons: [{ days: 28, growth: null }] };

describe('Stripe reporting panel', () => {
  it('keeps missing history distinct from zero churn and formats zero-decimal currency correctly', () => {
    const { container } = render(<StripeReport report={report} days={28} nowMs={Date.parse('2026-10-01T12:00:00Z')} />);
    expect(container.textContent).toContain('2,500');
    expect(container.textContent).not.toContain('25.00');
    expect(container.textContent).toContain('overdue');
    expect(screen.getByText('Growth needs comparable reports 28 days apart.')).toBeInTheDocument();
    expect(screen.queryByText('Opening customer churn')).toBeNull();
  });

  it('renders unsupported MRR as unavailable while retaining trial and past-due counts', () => {
    render(<StripeReport report={{ ...report, latest: { ...latest, mrrMinor: null, paidCustomers: null, unmeasuredSubscriptions: 1 } }} days={28} nowMs={Date.parse(latest.observedAt)} />);
    expect(screen.getAllByText('Pricing not measured')).toHaveLength(2);
    expect(screen.getByText('Past-due subscriptions')).toBeInTheDocument();
    expect(screen.getByText(/unsupported pricing/)).toBeInTheDocument();
  });

  it('omits disconnected Stripe reports', () => {
    const { container } = render(<StripeReport report={null} days={7} nowMs={0} />);
    expect(container).toBeEmptyDOMElement();
  });
});
