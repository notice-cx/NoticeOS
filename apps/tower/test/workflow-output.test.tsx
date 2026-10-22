import { cleanup, fireEvent, render, screen, within } from './render';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowStepOutputView } from '@/components/WorkflowVisuals';
import { OUTCOME_WORDS } from '@/lib/agents-week';
import { captureWorkflowOutput } from '../../../scripts/workflow-output.mjs';

afterEach(cleanup);
describe('visual step output', () => {
  it('renders actual counts and per-asset outcomes before the optional data disclosure', () => {
    render(<WorkflowStepOutputView output={captureWorkflowOutput({ attempted: 2, succeeded: 1, failed: 1, outcomes: [
      { asset: 'meadow.example', ok: true, status: 200, written: 12 }, { asset: 'northwind.example', ok: false, status: 503 },
    ] })} />);
    expect(screen.getByText('Attempted')).toBeInTheDocument();
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
