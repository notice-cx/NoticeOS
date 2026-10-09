import { fireEvent, render, screen, within } from './render';
import { describe, expect, it } from 'vitest';
import { DailyRevenuePanel } from '@/components/DailyRevenuePanel';
import { HeroChart } from '@/components/surface/HeroChart';

describe('daily revenue bars', () => {
  it('marks incomplete portfolio subtotals visually and discloses the missing asset', async () => {
    const { container } = render(<DailyRevenuePanel range={2} history={{ from: '2026-09-08', to: '2026-09-09', reportedThrough: '2026-09-09', days: [
      { date: '2026-09-08', amountMinor: 1735 }, { date: '2026-09-09', amountMinor: 0 },
    ] }} partialDates={['2026-09-09']} notesByDate={{ '2026-09-09': '1 of 2 daily sources reported · Missing: Nosh' }} />);
    expect(container.querySelectorAll('[data-hero-bar][data-partial]')).toHaveLength(1);
    expect(screen.getByText('Reported subtotal')).toBeInTheDocument();
    // Business altitude (D45): ad revenue, not the network; the reporting
    // clock is one press away rather than in the caption.
    expect(screen.getByText(/^Ad revenue · estimates/)).toBeInTheDocument();
    expect(screen.queryByText(/Mediavine/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'About the reporting day' }));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Days end at midnight Pacific time');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByText('Incomplete site coverage')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('group', { name: 'Explore Estimated ad revenue values' }), { key: 'End' });
    expect(screen.getByRole('status')).toHaveTextContent('Missing: Nosh');
    expect(screen.getByRole('status')).toHaveTextContent('$0.00');
    fireEvent.click(screen.getByText('View data · 2 days'));
    expect(await screen.findByRole('region', { name: 'Chart data table' })).toHaveTextContent('Missing: Nosh');
  });
  it('keeps zero, gaps and the missing final date distinct for keyboard and table readers', async () => {
    const { container } = render(<DailyRevenuePanel range={4} history={{ from: '2026-09-06', to: '2026-09-09', reportedThrough: '2026-09-08', days: [
      { date: '2026-09-06', amountMinor: 4321 }, { date: '2026-09-08', amountMinor: 0 },
    ] }} />);
    expect(container.querySelectorAll('[data-hero-bar]')).toHaveLength(2);
    expect(screen.getByText('2 of 4 days reported')).toBeInTheDocument();
    expect(screen.getByText('$21.61')).toBeInTheDocument();
    const summaries = [...container.querySelectorAll('[data-kpi]')];
    expect(summaries).toHaveLength(3);
    const chartIds = new Set(summaries.map(summary => summary.getAttribute('aria-details')));
    expect(chartIds.size).toBe(1);
    const chartId = [...chartIds][0]!;
    expect(document.getElementById(chartId)?.querySelector('[data-hero-chart]')).not.toBeNull();
    const plot = screen.getByRole('group', { name: 'Explore Estimated ad revenue values' });
    fireEvent.keyDown(plot, { key: 'End' });
    expect(screen.getByRole('status')).toHaveTextContent('Not reported');
    fireEvent.keyDown(plot, { key: 'ArrowLeft' });
    expect(screen.getByRole('status')).toHaveTextContent('$0.00');
    fireEvent.click(screen.getByText('View data · 4 days'));
    const table = await screen.findByRole('region', { name: 'Chart data table' });
    expect(within(table).getAllByRole('row')).toHaveLength(5);
    expect(within(table).getAllByText('Not reported')).toHaveLength(2);
  });
  it('draws signed observations from zero and keeps first and last bars inside the plot', () => {
    const { container } = render(<HeroChart variant="bars" range={3} series={[{ name: 'Revenue', points: [
      { t: '2026-09-07', v: -10 }, { t: '2026-09-08', v: 0 }, { t: '2026-09-09', v: 20 },
    ] }]} />);
    const bars = [...container.querySelectorAll('[data-hero-bar]')];
    const baseline = Number(container.querySelector('[data-hero-zero]')!.getAttribute('y1'));
    expect(Number(bars[0]!.getAttribute('y'))).toBe(baseline);
    expect(Number(bars[2]!.getAttribute('y'))).toBeLessThan(baseline);
    for (const bar of bars) {
      expect(Number(bar.getAttribute('x'))).toBeGreaterThanOrEqual(0);
      expect(Number(bar.getAttribute('x')) + Number(bar.getAttribute('width'))).toBeLessThanOrEqual(1000);
    }
  });
  it('does not fabricate totals when no reports exist', () => {
    const { container } = render(<DailyRevenuePanel range={7} history={{ from: '2026-09-03', to: '2026-09-09', days: [], reportedThrough: null }} />);
    expect(screen.getByText('No daily revenue reports in this period')).toBeInTheDocument();
    expect(container.querySelector('[data-hero-bar]')).toBeNull();
    expect(container.textContent).not.toContain('$0.00');
  });
});
