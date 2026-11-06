import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { PortfolioBriefRead } from '@noticeos/contract/portfolio-brief';
import { ExecutiveBrief } from '@/routes/home/ExecutiveBrief';

afterEach(cleanup);
const empty: PortfolioBriefRead = { state: 'disconnected', briefing: null, stale: false, error: null, lastAttemptAt: null, nextAttemptAt: null };
const ready: PortfolioBriefRead = { ...empty, state: 'ready', briefing: {
  generatedAt: '2026-11-06T12:00:00Z', evidenceAsOf: '2026-11-06T11:00:00Z', model: 'example-model', limitations: ['One asset has no revenue report.'],
  result: { headline: 'Resolve the checkout loss before buying traffic.', assessment: 'More visits will not fix the measured checkout failure.', insights: [{ observation: 'Checkout losses rose while traffic stayed level.', why: 'Paid acquisition would send more visitors into the same failure.', action: 'Review the checkout errors.', evidenceIds: ['checkout'], confidence: 'medium' }] },
  sources: [{ id: 'checkout', label: 'Checkout report', href: '/sites/example.com/product', observedAt: '2026-11-06T11:00:00Z', period: null }],
} };
function show(read?: PortfolioBriefRead, readFailed = false) { return render(<MemoryRouter><ExecutiveBrief read={read} readFailed={readFailed} fallback={<p>Observed summary</p>} /></MemoryRouter>); }
describe('ExecutiveBrief', () => {
  it('shows judgement, reason, action and the evidence destination with dated model attribution', () => {
    show(ready);
    expect(screen.queryByText('Observed summary')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(ready.briefing!.result.headline);
    expect(screen.getByText(ready.briefing!.result.insights[0]!.why)).toBeInTheDocument();
    expect(screen.getByText(/Review the checkout errors/)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Checkout report' })[0]).toHaveAttribute('href', '/sites/example.com/product');
    expect(screen.getByText(/Model-generated/)).toHaveTextContent('example-model');
    expect(screen.getByText(/One asset has no revenue report/)).not.toBeVisible();
    expect(screen.getByText('Evidence and coverage')).toBeVisible();
    expect(screen.getByRole('list')).not.toHaveClass('@3xl:grid-cols-3');
  });
  it('retains the successful result and original generation time when a read or generation fails', () => {
    const { container } = show({ ...ready, state: 'unavailable', stale: true }, true);
    expect(screen.getByRole('status')).toHaveTextContent('last successful briefing');
    expect(container.querySelector('time')).toHaveAttribute('datetime', ready.briefing!.generatedAt);
  });
  it('allows zero findings without inventing an insight or a placeholder', () => {
    show({ ...ready, briefing: { ...ready.briefing!, result: { ...ready.briefing!.result, insights: [] } } });
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2 })).toBeInTheDocument();
  });
  it('labels a deterministic empty review without attributing it to a model', () => {
    const { container } = show({ ...ready, briefing: { ...ready.briefing!, model: null, result: { headline: 'No material finding.', assessment: 'The available data does not establish a worthwhile comparison.', insights: [] } } });
    expect(screen.getByText(/Evidence reviewed/)).toBeVisible();
    expect(screen.getByText(/Updated/)).toBeVisible();
    expect(screen.queryByText(/Model-generated/)).not.toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(container.querySelector('time')).toHaveAttribute('datetime', ready.briefing!.generatedAt);
  });
  it('caps findings at two and uses two columns for a pair', () => {
    const insight = ready.briefing!.result.insights[0]!;
    show({ ...ready, briefing: { ...ready.briefing!, result: { ...ready.briefing!.result, insights: [insight, { ...insight, observation: 'A second measured change.' }, { ...insight, observation: 'Excess finding.' }] } } });
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('list')).toHaveClass('@3xl:grid-cols-2');
    expect(screen.queryByText('Excess finding.')).not.toBeInTheDocument();
  });
  it.each(['disconnected', 'awaiting', 'unavailable', 'unsupported'] as const)('keeps the observed summary for %s', state => {
    show({ ...empty, state });
    expect(screen.getByText('Observed summary')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Connect a local model' }) !== null).toBe(state === 'disconnected');
  });
  it('keeps the observed summary when its independent read fails', () => {
    show(undefined, true);
    expect(screen.getByText('Observed summary')).toBeInTheDocument();
    expect(screen.getByText(/Executive briefing unavailable/)).toBeInTheDocument();
  });
});
