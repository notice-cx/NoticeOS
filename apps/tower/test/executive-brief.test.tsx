import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PortfolioBriefRead } from '@noticeos/contract/portfolio-brief';
import { ExecutiveBrief } from '@/routes/home/ExecutiveBrief';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const empty: PortfolioBriefRead = { state: 'disconnected', briefing: null, stale: false, error: null, lastAttemptAt: null, nextAttemptAt: null };
const comparison = { current: { start: '2026-01-01', end: '2026-01-28' }, previous: { start: '2025-12-04', end: '2025-12-31' }, timeZone: 'America/Los_Angeles' };
const ready: PortfolioBriefRead = { ...empty, state: 'ready', briefing: {
  generatedAt: '2026-11-06T12:00:00Z', evidenceAsOf: '2026-11-06T11:00:00Z', model: 'example-model', limitations: ['One asset has no revenue report.'],
  result: { headline: 'Investigate the checkout decline before expanding acquisition.', assessment: 'A lower checkout completion rate warrants investigation before increasing acquisition spend.', insights: [{ title: 'Investigate checkout completion', observation: 'Over the latest 28 days, checkout completion declined versus the previous 28 while traffic stayed level.', why: 'Additional acquisition spend may underperform while the completion decline remains unexplained.', action: 'Compare checkout completion by device and acquisition source.', evidenceIds: ['checkout'], confidence: 'medium' }] },
  sources: [{ id: 'checkout', label: 'Checkout report', href: '/assets/example.com/product', observedAt: '2026-11-06T11:00:00Z', period: null, comparison }],
} };
const generousInsights: NonNullable<PortfolioBriefRead['briefing']>['result']['insights'] = [
  {
    "title": "Investigate checkout completion",
    "observation": "Over the latest 28 days versus the previous 28, checkout completion declined while visits remained broadly steady. The decline is visible across the full reporting window, but the aggregate figures do not establish whether visitor mix, device behavior, product changes or an issue during checkout explains the difference.",
    "why": "Increasing acquisition before understanding that relationship could increase spending without a corresponding improvement in completed purchases. The figures support investigation rather than a conclusion about the cause.",
    "action": "Compare completion by device and acquisition source, then inspect the largest affected segment before changing the spending plan.",
    "evidenceIds": [
      "checkout"
    ],
    "confidence": "medium"
  },
  {
    "title": "Inspect the source of search growth",
    "observation": "Over the latest 28 days versus the previous 28, one asset gained search visits while the others declined. That makes the growing asset a useful comparison, but its stronger result alone does not establish that the same changes would work elsewhere in the portfolio.",
    "why": "Understanding which queries and landing pages contributed to the difference would make a targeted review more useful than copying a broad publishing or acquisition strategy.",
    "action": "Compare the growing landing pages with their own earlier performance and inspect the queries responsible for the change.",
    "evidenceIds": [
      "search"
    ],
    "confidence": "medium"
  },
  {
    "title": "Resolve the release dependency",
    "observation": "Currently, the release task depends on a separate review that has not been completed. The dependency records a concrete reason the release cannot proceed; it does not establish that every other task in the project should stop.",
    "why": "Completing unrelated implementation work will not remove that dependency. Focusing the next review on the blocking task can clarify whether a release decision is ready.",
    "action": "Review the blocking task and its acceptance conditions, then confirm which remaining work can proceed independently.",
    "evidenceIds": [
      "tasks"
    ],
    "confidence": "high"
  }
];

function show(read?: PortfolioBriefRead, readFailed = false) { return render(<MemoryRouter><ExecutiveBrief read={read} readFailed={readFailed} fallback={<p>Observed summary</p>} /></MemoryRouter>); }
describe('ExecutiveBrief', () => {
  it('shows the judgement, reason and action without a source inventory or operational metadata', () => {
    const { container } = show(ready);
    expect(screen.queryByText('Observed summary')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(ready.briefing!.result.headline);
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Investigate checkout completion');
    expect(screen.getByText(ready.briefing!.result.insights[0]!.why)).not.toBeVisible();
    expect(screen.getByText(ready.briefing!.result.insights[0]!.action)).not.toBeVisible();
    fireEvent.click(screen.getByText('Details', { exact: true }));
    expect(screen.getByText(ready.briefing!.result.insights[0]!.why)).toBeVisible();
    expect(screen.getByText(/Compare checkout completion by device and acquisition source/)).toBeVisible();
    expect(screen.queryByText('Checkout report')).not.toBeInTheDocument();
    expect(screen.queryByText(/example-model|Evidence and coverage|Medium confidence|One asset has no revenue/)).not.toBeInTheDocument();
    expect(container.querySelector('time, [data-brief-comparison]')).toBeNull();
  });
  it('offers at most one useful action destination and excludes unsafe or unrelated links', () => {
    const source = ready.briefing!.sources[0]!;
    show({ ...ready, briefing: { ...ready.briefing!, sources: [
      { ...source, id: 'unsafe', href: 'https://external.example.com' },
      { ...source, id: 'tasks', href: '/tasks' },
      { ...source, id: 'alerts', href: '/alerts' },
    ], result: { ...ready.briefing!.result, insights: [{ ...ready.briefing!.result.insights[0]!, evidenceIds: ['unsafe', 'tasks', 'alerts'] }] } } });
    expect(screen.getAllByRole('link', { hidden: true })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Review tasks', hidden: true })).toHaveAttribute('href', '/tasks');
  });
  it.each([
    ['/assets/example.com/product', 'Review asset'], ['/tasks?project=example.com', 'Review tasks'],
    ['/financials', 'Review financials'], ['/health', 'Review health'],
  ])('uses the supplied %s action destination', (href, label) => {
    show({ ...ready, briefing: { ...ready.briefing!, sources: [{ ...ready.briefing!.sources[0]!, href }] } });
    expect(screen.getByRole('link', { name: label, hidden: true })).toHaveAttribute('href', href);
  });
  it('does not repeat an action destination across insights', () => {
    const insight = ready.briefing!.result.insights[0]!;
    show({ ...ready, briefing: { ...ready.briefing!, sources: [{ ...ready.briefing!.sources[0]!, href: '/tasks' }],
      result: { ...ready.briefing!.result, insights: [insight, { ...insight, observation: 'Currently, blocked work delays the next release.' }] } } });
    expect(screen.getAllByRole('link', { name: 'Review tasks', hidden: true })).toHaveLength(1);
    expect(screen.getByText('Currently, blocked work delays the next release.')).not.toBeVisible();
  });
  it('opens each card independently and collapses its reasoning and action again', () => {
    const { container } = show({ ...ready, briefing: { ...ready.briefing!, result: { ...ready.briefing!.result, insights: generousInsights } } });
    const controls = screen.getAllByText('Details', { exact: true });
    const panels = container.querySelectorAll('details');
    fireEvent.click(controls[0]!);
    expect(panels[0]).toHaveAttribute('open');
    expect(panels[1]).not.toHaveAttribute('open');
    expect(screen.getByText(generousInsights[0]!.action)).toBeVisible();
    expect(screen.getByText(generousInsights[1]!.action)).not.toBeVisible();
    fireEvent.click(controls[1]!);
    expect(panels[0]).toHaveAttribute('open');
    expect(panels[1]).toHaveAttribute('open');
    fireEvent.click(controls[0]!);
    expect(panels[0]).not.toHaveAttribute('open');
    expect(panels[1]).toHaveAttribute('open');
    expect(screen.getByRole('list')).toHaveClass('items-start');
  });
  it('retains useful guidance with a concise warning when refresh fails', () => {
    const { container } = show({ ...ready, state: 'unavailable', stale: true }, true);
    expect(screen.getByRole('status')).toHaveTextContent('Refresh failed. Showing the previous briefing.');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(ready.briefing!.result.headline);
    expect(container.querySelector('time')).toBeNull();
  });
  it.each([null, 'example-model'])('uses the observed summary instead of an empty briefing for model %s', model => {
    const { container } = show({ ...ready, briefing: { ...ready.briefing!, model, result: { headline: 'No material finding.', assessment: 'Nothing worthwhile.', insights: [] } } });
    expect(screen.getByText('Observed summary')).toBeVisible();
    expect(container.querySelector('[data-executive-brief]')).toBeNull();
    expect(screen.queryByText('No material finding.')).not.toBeInTheDocument();
  });
  it('caps findings at three and provides a responsive column layout', () => {
    const insight = ready.briefing!.result.insights[0]!;
    show({ ...ready, briefing: { ...ready.briefing!, result: { ...ready.briefing!.result, insights: [insight, { ...insight, title: 'Second finding', observation: 'A second measured change.' }, { ...insight, title: 'Third finding', observation: 'A third measured change.' }, { ...insight, title: 'Excess finding', observation: 'Excess finding.' }] } } });
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByRole('list')).toHaveClass('@3xl:grid-cols-2', '@5xl:grid-cols-3');
    expect(screen.queryByText('Excess finding.')).not.toBeInTheDocument();
  });
  it('formats a generous three-finding briefing into titled observations, reasons and actions', () => {
    const words = generousInsights.map(insight => `${insight.title} ${insight.observation} ${insight.why} ${insight.action}`).join(' ').split(/\s+/).length;
    expect(words).toBeGreaterThan(250);
    expect(words).toBeLessThanOrEqual(360);
    show({ ...ready, briefing: { ...ready.briefing!, result: { ...ready.briefing!.result, insights: generousInsights } } });
    expect(screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent)).toEqual(generousInsights.map(insight => insight.title));
    expect(screen.getAllByText('Next')).toHaveLength(3);
    for (const insight of generousInsights) expect(screen.getByText(insight.observation)).not.toBeVisible();
  });
  it.each(['disconnected', 'awaiting', 'unavailable', 'unsupported'] as const)('keeps the observed summary for %s', state => {
    show({ ...empty, state });
    expect(screen.getByText('Observed summary')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Connect a model' }) !== null).toBe(state === 'disconnected');
  });
  it('keeps the observed summary when its independent read fails', () => {
    show(undefined, true);
    expect(screen.getByText('Observed summary')).toBeInTheDocument();
    expect(screen.getByText(/Briefing unavailable/)).toBeInTheDocument();
  });
});


describe('briefing card highlights', () => {
  function setup() {
    vi.useFakeTimers();
    return show({ ...ready, briefing: { ...ready.briefing!, result: { ...ready.briefing!.result, insights: generousInsights } } });
  }
  const advance = () => act(() => vi.advanceTimersByTime(9_000));
  it('cycles a visual highlight without opening details or moving keyboard focus, and clears timers on unmount', () => {
    const { container, unmount } = setup();
    const cards = container.querySelectorAll('[data-brief-highlight]');
    const focus = document.activeElement;
    expect(cards[0]).toHaveAttribute('data-brief-highlight', 'active');
    advance();
    expect(cards[1]).toHaveAttribute('data-brief-highlight', 'active');
    expect(document.activeElement).toBe(focus);
    expect(container.querySelector('details[open]')).toBeNull();
    advance(); advance();
    expect(cards[0]).toHaveAttribute('data-brief-highlight', 'active');
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('supports explicit pause and resume and pauses while a card is hovered or focused', () => {
    const { container } = setup();
    const cards = container.querySelectorAll('[data-brief-highlight]');
    fireEvent.click(screen.getByRole('button', { name: 'Pause card highlights' }));
    advance();
    expect(cards[0]).toHaveAttribute('data-brief-highlight', 'active');
    fireEvent.click(screen.getByRole('button', { name: 'Resume card highlights' }));
    fireEvent.mouseEnter(cards[0]!); advance();
    expect(cards[0]).toHaveAttribute('data-brief-highlight', 'active');
    fireEvent.mouseLeave(cards[0]!);
    const summary = container.querySelector('summary')!;
    fireEvent.focus(summary); advance();
    expect(cards[0]).toHaveAttribute('data-brief-highlight', 'active');
    fireEvent.blur(summary, { relatedTarget: document.body }); advance();
    expect(cards[1]).toHaveAttribute('data-brief-highlight', 'active');
  });
  it('pauses when details are open or the page is hidden', () => {
    const { container } = setup();
    const detail = container.querySelector('details')!;
    detail.open = true; fireEvent(detail, new Event('toggle'));
    advance();
    expect(container.querySelector('[data-executive-brief]')).toHaveAttribute('data-brief-cycle', 'paused');
    detail.open = false; fireEvent(detail, new Event('toggle'));
    const visibility = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange')); advance();
    expect(container.querySelector('[data-brief-highlight]')).toHaveAttribute('data-brief-highlight', 'active');
    visibility.mockReturnValue(false); fireEvent(document, new Event('visibilitychange')); advance();
    expect(container.querySelectorAll('[data-brief-highlight]')[1]).toHaveAttribute('data-brief-highlight', 'active');
  });
  it('resumes new results after an interacted result disappears, without resetting the same cached result', () => {
    const { container, rerender } = setup();
    const cached = { ...ready, briefing: { ...ready.briefing!, result: { ...ready.briefing!.result, insights: generousInsights } } };
    const element = (read: PortfolioBriefRead) => <MemoryRouter><ExecutiveBrief read={read} fallback={<p>Observed summary</p>} /></MemoryRouter>;
    const detail = container.querySelector('details')!;
    detail.open = true; fireEvent(detail, new Event('toggle'));
    fireEvent.mouseEnter(container.querySelector('li')!);
    fireEvent.focus(container.querySelector('summary')!);
    rerender(element({ ...cached }));
    expect(container.querySelector('details')).toHaveAttribute('open');
    expect(container.querySelector('[data-executive-brief]')).toHaveAttribute('data-brief-cycle', 'paused');
    rerender(element(empty));
    const replacement = { ...cached, briefing: { ...cached.briefing, generatedAt: '2026-11-06T13:00:00Z' } };
    rerender(element(replacement));
    expect(container.querySelector('details[open]')).toBeNull();
    expect(container.querySelector('[data-executive-brief]')).toHaveAttribute('data-brief-cycle', 'running');
    advance();
    expect(container.querySelectorAll('[data-brief-highlight]')[1]).toHaveAttribute('data-brief-highlight', 'active');
  });
  it('keeps an explicit pause preference when a later briefing replaces an empty result', () => {
    const { container, rerender } = setup();
    const element = (read: PortfolioBriefRead) => <MemoryRouter><ExecutiveBrief read={read} fallback={<p>Observed summary</p>} /></MemoryRouter>;
    fireEvent.click(screen.getByRole('button', { name: 'Pause card highlights' }));
    rerender(element(empty));
    rerender(element({ ...ready, briefing: { ...ready.briefing!, generatedAt: '2026-11-06T13:00:00Z', result: { ...ready.briefing!.result, insights: generousInsights } } }));
    expect(screen.getByRole('button', { name: 'Resume card highlights' })).toBeVisible();
    advance();
    expect(container.querySelector('[data-brief-highlight]')).toHaveAttribute('data-brief-highlight', 'active');
  });
  it('does not auto-cycle with reduced motion or show autoplay controls for fewer than two cards', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const { container, unmount } = setup();
    advance();
    expect(container.querySelector('[data-brief-highlight]')).toHaveAttribute('data-brief-highlight', 'active');
    expect(screen.queryByRole('button', { name: /card highlights/ })).toBeNull();
    unmount(); vi.unstubAllGlobals(); show(ready);
    expect(screen.queryByRole('button', { name: /card highlights/ })).toBeNull();
  });
});
