import { cleanup, fireEvent, render, screen, within } from './render';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowStepOutputView } from '@/components/WorkflowVisuals';
import { captureWorkflowOutput } from '../../../scripts/workflow-output.mjs';

afterEach(cleanup);
describe('visual step output', () => {
  it('renders actual counts and per-asset outcomes before the optional data disclosure', () => {
    render(<WorkflowStepOutputView output={captureWorkflowOutput({ attempted: 2, succeeded: 1, failed: 1, outcomes: [
      { asset: 'meals.example', ok: true, status: 200, written: 12 }, { asset: 'nosh.example', ok: false, status: 503 },
    ] })} />);
    expect(screen.getByText('Attempted')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Output results' });
    expect(within(table).getByText('meals.example')).toBeInTheDocument();
    expect(within(table).getByText('12')).toBeInTheDocument();
    expect(within(table).getByText('503')).toBeInTheDocument();
    const disclosure = screen.getByText('Captured data').closest('details')!;
    expect(disclosure.open).toBe(false);
    fireEvent.click(screen.getByText('Captured data'));
    expect(disclosure.open).toBe(true);
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
