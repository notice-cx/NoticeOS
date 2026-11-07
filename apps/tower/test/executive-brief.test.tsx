import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PortfolioBriefRead } from '@noticeos/contract/portfolio-brief';
import { ExecutiveBrief } from '@/routes/home/ExecutiveBrief';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const empty: PortfolioBriefRead = { state: 'disconnected', briefing: null, stale: false, error: null, lastAttemptAt: null, nextAttemptAt: null };
const findings = [
  { title: 'Investigate checkout completion', observation: 'Over the latest 28 days versus the previous 28, checkout completion declined. Visits stayed level.', why: 'Additional acquisition spend may underperform.', action: 'Compare completion by device and acquisition source.', evidenceIds: ['checkout'] },
  { title: 'Inspect the growing search pages', observation: 'Over the latest 28 days versus the previous 28, search visits rose for one asset.', why: 'The growing pages provide a focused comparison.', action: 'Inspect which queries contributed to the change.', evidenceIds: ['search'] },
  { title: 'Review the release dependency', observation: 'Currently, a review blocks the release task.', why: 'Other work can proceed independently.', action: 'Check the blocking review and its acceptance conditions.', evidenceIds: ['tasks'] },
];
const ready: PortfolioBriefRead = { ...empty, state: 'ready', briefing: {
  generatedAt: '2026-11-06T12:00:00Z', evidenceAsOf: '2026-11-06T11:00:00Z', model: 'example-model', limitations: ['One asset has no revenue report.'],
  result: { headline: 'An overall headline repeating checkout', assessment: 'A summary repeating the same checkout finding.', insights: findings },
  sources: [
    { id: 'checkout', label: 'Checkout report', href: '/assets/example.com/product', observedAt: '2026-11-06T11:00:00Z', period: null },
    { id: 'search', label: 'Search report', href: '/assets/example.com/search', observedAt: '2026-11-06T11:00:00Z', period: null },
    { id: 'tasks', label: 'Task report', href: '/tasks?project=example.com', observedAt: '2026-11-06T11:00:00Z', period: null },
  ],
} };
const assets = [{ id: 'example.com', displayName: 'Example', icons: null }, { id: 'another.example', displayName: 'Another', icons: null }];
const element = (read?: PortfolioBriefRead, readFailed = false) => <MemoryRouter><ExecutiveBrief read={read} readFailed={readFailed} assets={assets} /></MemoryRouter>;
const show = (read: PortfolioBriefRead | undefined = ready, readFailed = false) => render(element(read, readFailed));
const single = (): PortfolioBriefRead => ({ ...ready, briefing: { ...ready.briefing!, result: { ...ready.briefing!.result, insights: findings.slice(0, 1) } } });
const advance = () => act(() => vi.advanceTimersByTime(7_000));
const pick = (position: number) => fireEvent.click(screen.getByRole('button', { name: `Show finding ${position + 1}: ${findings[position]!.title}` }));
const heading = () => screen.getByRole('heading', { level: 2 });

describe('ExecutiveBrief', () => {
  it('shows one finding and one next action, without the repeated headline, summary or metadata', () => {
    const { container } = show();
    expect(heading()).toHaveTextContent(findings[0]!.title);
    expect(screen.getAllByRole('heading')).toHaveLength(1);
    expect(screen.getByText(findings[0]!.action)).toBeVisible();
    expect(screen.getAllByText(findings[0]!.action)).toHaveLength(1);
    expect(screen.queryByText(ready.briefing!.result.headline!)).not.toBeInTheDocument();
    expect(screen.queryByText(ready.briefing!.result.assessment!)).not.toBeInTheDocument();
    expect(screen.getByText(findings[0]!.observation)).not.toBeVisible();
    expect(screen.getByText(findings[0]!.why)).not.toBeVisible();
    fireEvent.click(screen.getByText('Details', { exact: true }));
    expect(screen.getByText(findings[0]!.observation)).toBeVisible();
    expect(screen.getByText(findings[0]!.why)).toBeVisible();
    expect(screen.queryByText(/Checkout report|example-model|One asset has no revenue/)).not.toBeInTheDocument();
    expect(container.querySelector('time, [data-brief-comparison]')).toBeNull();
    expect(container.querySelector('[data-executive-brief]')).toHaveClass('w-full');
    expect(container.querySelectorAll('[data-brief-finding]')).toHaveLength(1);
  });

  it('moves directly between findings, closes old details and keeps manual selection paused', () => {
    const { container } = show();
    fireEvent.click(screen.getByText('Details', { exact: true }));
    pick(1);
    expect(heading()).toHaveTextContent(findings[1]!.title);
    expect(screen.queryByText(findings[0]!.action)).not.toBeInTheDocument();
    expect(container.querySelector('details')).not.toHaveAttribute('open');
    expect(screen.getByRole('button', { name: /Show finding 2:/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: /Show finding 1:/ })).not.toHaveAttribute('aria-current');
    expect(container.querySelector('[data-executive-brief]')).toHaveAttribute('data-brief-cycle', 'paused');
    expect(screen.getByRole('group', { name: 'Choose a finding' })).toHaveClass('flex-col');
  });

  it('caps navigation at three findings and hides controls for a single finding', () => {
    const { unmount } = show({ ...ready, briefing: { ...ready.briefing!, result: { insights: [...findings, { ...findings[0]!, title: 'Extra finding' }] } } });
    expect(screen.getAllByRole('button', { name: /^Show finding/ })).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /Extra finding/ })).not.toBeInTheDocument();
    unmount(); show(single());
    expect(screen.queryByRole('group', { name: 'Choose a finding' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /rotation/ })).not.toBeInTheDocument();
  });

  it.each([
    ['/assets/example.com/product', 'Review asset'], ['/tasks?project=example.com', 'Review tasks'],
    ['/financials', 'Review financials'], ['/health', 'Review health'],
  ])('keeps one supplied %s action destination under Details', (href, label) => {
    const read = single();
    show({ ...read, briefing: { ...read.briefing!, sources: [{ ...read.briefing!.sources[0]!, href }] } });
    expect(screen.getByRole('link', { name: label, hidden: true })).toHaveAttribute('href', href);
    expect(screen.getAllByRole('link', { hidden: true })).toHaveLength(1);
  });

  it('does not render an unsafe action destination', () => {
    const read = single();
    show({ ...read, briefing: { ...read.briefing!, sources: [{ ...read.briefing!.sources[0]!, href: 'https://external.example.com' }] } });
    expect(screen.queryByRole('link', { hidden: true })).not.toBeInTheDocument();
  });

  it('uses only cited source assets for the icon and deduplicates repeated references', () => {
    const read = single();
    const source = read.briefing!.sources[0]!;
    const { container } = show({ ...read, briefing: { ...read.briefing!, sources: [source, { ...source, id: 'other' }, { ...source, id: 'uncited', href: '/assets/another.example' }],
      result: { insights: [{ ...findings[0]!, evidenceIds: ['checkout', 'other'] }] } } });
    expect(screen.getByRole('img', { name: 'About Example' })).toBeVisible();
    expect(container.querySelectorAll('[data-property-favicon]')).toHaveLength(1);
    expect(container.querySelector('[data-property-favicon]')).toHaveAttribute('data-property-favicon', 'example.com');
  });

  it('shows multiple asset icons for a finding supported by multiple assets', () => {
    const read = single();
    const { container } = show({ ...read, briefing: { ...read.briefing!, sources: [...read.briefing!.sources,
      { ...read.briefing!.sources[0]!, id: 'second', href: '/assets/another.example/search' }],
      result: { insights: [{ ...findings[0]!, evidenceIds: ['checkout', 'second'] }] } } });
    expect(screen.getByRole('img', { name: 'About Example, Another' })).toBeVisible();
    expect(container.querySelectorAll('[data-property-favicon]')).toHaveLength(2);
  });

  it.each([
    ['/tasks/ex-1?project=example%2Ecom', 'task-source'], ['/tasks', 'work:example.com:progress'],
  ])('identifies a task project from its saved source %s', (href, id) => {
    const read = single();
    show({ ...read, briefing: { ...read.briefing!, sources: [{ ...read.briefing!.sources[0]!, href, id }],
      result: { insights: [{ ...findings[0]!, evidenceIds: [id] }] } } });
    expect(screen.getByRole('img', { name: 'About Example' })).toBeVisible();
  });

  it.each(['/financials', '/assets/%ZZ'])('uses a portfolio mark for %s rather than guessing from the model title', href => {
    const read = single();
    show({ ...read, briefing: { ...read.briefing!, sources: [{ ...read.briefing!.sources[0]!, href }],
      result: { insights: [{ ...findings[0]!, title: 'Example revenue needs a review' }] } } });
    expect(screen.getByRole('img', { name: 'Portfolio finding' })).toBeVisible();
    expect(screen.queryByRole('img', { name: 'About Example' })).not.toBeInTheDocument();
  });

  it('retains a finding with one warning when a refresh fails', () => {
    show({ ...ready, state: 'unavailable', stale: true }, true);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('Refresh failed. Showing the previous briefing.');
    expect(heading()).toHaveTextContent(findings[0]!.title);
  });

  it('omits the briefing when there are no findings', () => {
    const { container } = show({ ...ready, briefing: { ...ready.briefing!, result: { ...ready.briefing!.result, insights: [] } } });
    expect(container.querySelector('[data-executive-brief]')).toBeNull();
  });
  it.each(['disconnected', 'awaiting', 'unavailable', 'unsupported'] as const)('offers connection only for %s when no briefing exists', state => {
    show({ ...empty, state });
    expect(screen.queryByRole('link', { name: 'Connect a model' }) !== null).toBe(state === 'disconnected');
  });
  it('omits findings when its independent read fails', () => {
    render(element(undefined, true));
    expect(screen.queryByRole('heading')).toBeNull();
  });
});

describe('finding rotation', () => {
  function setup() { vi.useFakeTimers(); return show(); }
  it('replaces the finding without opening Details or moving focus, wraps and clears the timer on unmount', () => {
    const { container, unmount } = setup();
    const focus = document.activeElement;
    advance(); expect(heading()).toHaveTextContent(findings[1]!.title);
    expect(document.activeElement).toBe(focus);
    expect(container.querySelector('details[open]')).toBeNull();
    advance(); expect(heading()).toHaveTextContent(findings[2]!.title);
    advance(); expect(heading()).toHaveTextContent(findings[0]!.title);
    unmount(); expect(vi.getTimerCount()).toBe(0);
  });
  it('supports explicit pause and resume, and manual selection stays paused until resumed', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Pause finding rotation' }));
    advance(); expect(heading()).toHaveTextContent(findings[0]!.title);
    fireEvent.click(screen.getByRole('button', { name: 'Resume finding rotation' }));
    advance(); expect(heading()).toHaveTextContent(findings[1]!.title);
    pick(2); advance(); expect(heading()).toHaveTextContent(findings[2]!.title);
    fireEvent.click(screen.getByRole('button', { name: 'Resume finding rotation' }));
    advance(); expect(heading()).toHaveTextContent(findings[0]!.title);
  });
  it('pauses while hovered or focused', () => {
    const { container } = setup();
    const frame = container.querySelector('[data-executive-brief]')!;
    fireEvent.mouseEnter(frame); advance(); expect(heading()).toHaveTextContent(findings[0]!.title);
    fireEvent.mouseLeave(frame);
    const summary = container.querySelector('summary')!;
    fireEvent.focus(summary); advance(); expect(heading()).toHaveTextContent(findings[0]!.title);
    fireEvent.blur(summary, { relatedTarget: document.body });
    advance(); expect(heading()).toHaveTextContent(findings[1]!.title);
  });
  it('pauses while details are open or the page is hidden', () => {
    const { container } = setup();
    const detail = container.querySelector('details')!;
    detail.open = true; fireEvent(detail, new Event('toggle'));
    advance(); expect(heading()).toHaveTextContent(findings[0]!.title);
    pick(0);
    fireEvent.click(screen.getByRole('button', { name: 'Resume finding rotation' }));
    advance(); expect(heading()).toHaveTextContent(findings[0]!.title);
    expect(detail).toHaveAttribute('open');
    detail.open = false; fireEvent(detail, new Event('toggle'));
    const visibility = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange')); advance(); expect(heading()).toHaveTextContent(findings[0]!.title);
    visibility.mockReturnValue(false); fireEvent(document, new Event('visibilitychange'));
    advance(); expect(heading()).toHaveTextContent(findings[1]!.title);
  });
  it('preserves the same cached finding and details, resetting interaction on a new result', () => {
    const { container, rerender } = setup();
    advance();
    const detail = container.querySelector('details')!;
    detail.open = true; fireEvent(detail, new Event('toggle'));
    rerender(element({ ...ready }));
    expect(heading()).toHaveTextContent(findings[1]!.title);
    expect(container.querySelector('details')).toHaveAttribute('open');
    rerender(element(empty));
    rerender(element({ ...ready, briefing: { ...ready.briefing!, generatedAt: '2026-11-06T13:00:00Z' } }));
    expect(container.querySelector('details[open]')).toBeNull();
    expect(heading()).toHaveTextContent(findings[0]!.title);
    advance(); expect(heading()).toHaveTextContent(findings[1]!.title);
  });
  it('keeps explicit pause across replacement results', () => {
    const { rerender } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Pause finding rotation' }));
    rerender(element(empty));
    rerender(element({ ...ready, briefing: { ...ready.briefing!, generatedAt: '2026-11-06T13:00:00Z' } }));
    advance(); expect(heading()).toHaveTextContent(findings[0]!.title);
    expect(screen.getByRole('button', { name: 'Resume finding rotation' })).toBeVisible();
  });
  it('keeps manual dot navigation available with reduced motion, without auto-rotation', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    setup();
    advance(); expect(heading()).toHaveTextContent(findings[0]!.title);
    expect(screen.queryByRole('button', { name: /rotation/ })).not.toBeInTheDocument();
    pick(2); expect(heading()).toHaveTextContent(findings[2]!.title);
    advance(); expect(heading()).toHaveTextContent(findings[2]!.title);
  });
});
