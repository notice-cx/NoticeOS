import { WORKFLOW_DEFINITIONS, type WorkflowRun } from '@shared/workflows';
import { copyText } from '@/lib/clipboard';
import { act, cleanup, fireEvent, render, screen, within } from './render';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowStepOutputView, WorkflowStages } from '@/components/WorkflowVisuals';
import { OUTCOME_WORDS } from '@/lib/agents-week';
import { captureWorkflowOutput } from '../../../scripts/workflow-output.mjs';

vi.mock('@/lib/clipboard', () => ({ copyText: vi.fn(async () => {}) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('visual step output', () => {
  it('renders actual counts and per-asset outcomes before the optional data disclosure', () => {
    render(<WorkflowStepOutputView output={captureWorkflowOutput({ attempted: 2, succeeded: 1, failed: 1, outcomes: [
      { asset: 'meadow.example', ok: true, status: 200, written: 12 }, { asset: 'northwind.example', ok: false, status: 503 },
    ] })} />);
    const table = screen.getByRole('table', { name: 'Output results' });
    expect(within(table).getByText('meadow.example')).toBeInTheDocument();
    expect(within(table).getByText('12')).toBeInTheDocument();
    expect(within(table).getByText('503')).toBeInTheDocument();
    const disclosure = screen.getByText('Captured data').closest('details')!;
    expect(disclosure.open).toBe(false);
    fireEvent.click(screen.getByText('Captured data'));
    expect(disclosure.open).toBe(true);
  });
  it.each(Object.entries(OUTCOME_WORDS))('renders %s in product language while keeping captured evidence', (verdict, words) => {
    const output = captureWorkflowOutput({ outcome: verdict, closed: [{ id: 'window-1', outcome: verdict }] })!;
    const saved = JSON.stringify(output);
    render(<WorkflowStepOutputView output={output} />);
    expect(screen.getAllByText(words)).toHaveLength(2);
    expect(within(screen.getByRole('table')).getByText(words)).toBeInTheDocument();
    const disclosure = screen.getByText('Captured data').closest('details')!;
    expect(disclosure).toHaveTextContent(verdict);
    expect(disclosure.open).toBe(false);
    fireEvent.click(screen.getByText('Captured data'));
    expect(disclosure.open).toBe(true);
    expect(JSON.stringify(output)).toBe(saved);
  });
  it('preserves non-verdict strings, booleans, numbers and arbitrary values', () => {
    render(<WorkflowStepOutputView output={{ version: 1, metrics: [], items: [], totalItems: 0, truncated: false, fields: [
      { key: 'report', label: 'Report', value: 'ship_confirmed' },
      { key: 'verdict', label: 'Outcome', value: 'future-verdict' },
      { key: 'check', label: 'Check', value: 'toString' },
      { key: 'ok', label: 'Operation confirmed', value: false },
      { key: 'written', label: 'Rows written', value: 1234 },
      { key: 'costUsd', label: 'Provider cost', value: 0.000153, unit: 'USD' },
    ] }} />);
    expect(screen.getByText('ship_confirmed')).toBeInTheDocument();
    expect(screen.getByText('future-verdict')).toBeInTheDocument();
    expect(screen.getByText('toString')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument();
    expect(screen.getByText('1,234')).toBeInTheDocument();
    expect(screen.getByText('$0.000153')).toBeInTheDocument();
  });
  it('distinguishes missing and pending output from an actual zero result', () => {
    const view = render(<WorkflowStepOutputView />);
    expect(screen.getByText('Output was not captured for this execution.')).toBeInTheDocument();
    view.rerender(<WorkflowStepOutputView pending />);
    expect(screen.getByText('Output will appear when this step finishes.')).toBeInTheDocument();
    view.rerender(<WorkflowStepOutputView output={captureWorkflowOutput({ attempted: 0, succeeded: 0, failed: 0 })} />);
    expect(screen.getAllByText('0')).toHaveLength(3);
    expect(screen.queryByText('Output was not captured for this execution.')).toBeNull();
  });
});


describe('actual run diagnostics', () => {
  const at = '2026-11-06T12:00:00.000Z';
  const snapshot = (text: string, flags = {}) => ({ text, truncated: false, redacted: false, ...flags });
  function show(diagnostics?: NonNullable<WorkflowRun['steps']>[number]['diagnostics'], workflowId = 'portfolio-brief', state: WorkflowRun['state'] = 'failed') {
    const definition = WORKFLOW_DEFINITIONS.find(workflow => workflow.id === workflowId)!;
    const step = definition.stages.find(stage => stage.id !== 'config')!;
    const run: WorkflowRun = { id: `${workflowId}@${at}`, workflowId, definitionVersion: 1, state, startedAt: at, finishedAt: at,
      steps: [{ id: step.id, attempt: 1, state: state === 'failed' ? 'failed' : 'succeeded', startedAt: at, finishedAt: at, diagnostics }] };
    const view = render(<WorkflowStages definition={definition} run={run} />);
    if (state !== 'failed') fireEvent.click(screen.getByRole('button', { name: new RegExp(step.label) }));
    return { ...view, definition, step, run };
  }
  const code = (text: string) => screen.getByText((_content, element) => element?.tagName === 'CODE' && element.textContent === text);
  function openStage(container: HTMLElement) {
    return container.querySelector('[aria-label="Stage details"] [data-stage-attempt]')!.querySelectorAll('details');
  }
  it('selects the failed stage first and switches the attempt evidence with stage selection', () => {
    const { definition, step, run, rerender } = show({ output: snapshot('Failed model output') });
    const first = definition.stages.find(item => item.id !== step.id)!;
    expect(screen.getByRole('button', { name: new RegExp(step.label) })).toHaveAttribute('aria-pressed', 'true');
    rerender(<WorkflowStages definition={definition} run={{ ...run, steps: [
      ...run.steps!, { id: first.id, attempt: 1, state: 'succeeded', startedAt: at, finishedAt: at,
        diagnostics: { output: snapshot('Settings loaded') } },
    ] }} />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(first.label) }));
    expect(screen.queryByText('Failed model output')).toBeNull();
    fireEvent.click(screen.getByText('Output', { exact: true }));
    expect(screen.getByText('Settings loaded')).toBeVisible();
    expect(screen.queryByText('Run diagnostics')).toBeNull();
  });
  it('keeps a failed model prompt and actual answer collapsed, copies exact text, and never executes markup', async () => {
    const input = '<script>throw new Error("not executable")</script>\nSources: S1';
    const output = 'Headline: Review the release\nSummary: A review is needed';
    const { container } = show({ input: snapshot(input), output: snapshot(output) });
    expect(code(input)).not.toBeVisible();
    expect(code(output)).not.toBeVisible();
    expect(container.querySelector('script')).toBeNull();
    const panels = openStage(container);
    fireEvent.click(panels[0]!.querySelector('summary')!);
    expect(code(input)).toBeVisible();
    expect(code(output)).not.toBeVisible();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy inputs' })); });
    expect(copyText).toHaveBeenCalledWith(input);
    fireEvent.click(panels[1]!.querySelector('summary')!);
    expect(code(output)).toBeVisible();
    expect(screen.queryByText('Truncated')).toBeNull();
    expect(screen.queryByText('Sensitive values removed')).toBeNull();
  });
  it('shows actual non-model result and error snapshots with capture indicators', () => {
    const { container } = show({ output: snapshot('{"attempted":3,"written":2}', { truncated: true }), error: snapshot('The synthetic source was unavailable.', { redacted: true }) }, 'counters', 'succeeded');
    const panels = openStage(container);
    fireEvent.click(panels[1]!.querySelector('summary')!);
    expect(screen.getByText('{"attempted":3,"written":2}')).toBeVisible();
    expect(screen.getByText('The synthetic source was unavailable.')).toBeVisible();
    expect(screen.getByText('Error')).toBeVisible();
    expect(screen.getByText('Truncated')).toBeVisible();
    expect(screen.getByText('Sensitive values removed')).toBeVisible();
    expect(container.querySelectorAll('pre')[0]).toHaveClass('whitespace-pre-wrap', 'max-h-80');
  });
  it('keeps unknown historical capture availability inside the disclosure', () => {
    show();
    expect(screen.getByText('Inputs were not captured for this step.')).not.toBeVisible();
    fireEvent.click(screen.getByText('Inputs', { exact: true }));
    expect(screen.getByText('Inputs were not captured for this step.')).toBeVisible();
    expect(screen.queryByText('0')).toBeNull();
  });
});
