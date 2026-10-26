import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { createDemoActivity } from '../../../scripts/demo-activity.mjs';
import { generateDemoScenario } from '../../../scripts/demo-scenario.mjs';
import { JourneyMonitor } from '../src/components/JourneyMonitor';

const scenario = generateDemoScenario({ seed: 'journey-render', cutoff: '2026-10-26T12:00:00.000Z', release: 'a'.repeat(40) });
const reports = createDemoActivity(scenario).seededReports();

it('renders demo conversion bars, prior comparisons, and weekly history with the released monitor', () => {
  const snapshot = reports.find(report => report.asset === 'weeknightpantry.example')!.journeys;
  const { container } = render(<JourneyMonitor definitions={snapshot.definitions} snapshot={snapshot} readOnlyReason="Synthetic demo" />);
  expect(container.querySelectorAll('[data-step-index]')).toHaveLength(4);
  expect(container.querySelectorAll('.journey-prior')).toHaveLength(4);
  expect(container.querySelectorAll('[data-outcome="true"]')).toHaveLength(1);
  expect(container.querySelector('.journey-history')).toBeInTheDocument();
  expect(screen.queryByText('Ordered conversion is unavailable')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '7 days' }));
  expect(container.querySelectorAll('.journey-prior')).toHaveLength(4);
  expect(screen.getByRole('button', { name: 'Inspect Saved it' })).toBeInTheDocument();
});

it('retains the young demo asset’s missing month and renders its available week', () => {
  const snapshot = reports.find(report => report.asset === 'freshrows.example')!.journeys;
  const { container } = render(<JourneyMonitor definitions={snapshot.definitions} snapshot={snapshot} readOnlyReason="Synthetic demo" />);
  expect(screen.getByText('Ordered conversion is unavailable')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '7 days' }));
  expect(screen.queryByText('Ordered conversion is unavailable')).not.toBeInTheDocument();
  expect(container.querySelectorAll('[data-step-index]')).toHaveLength(3);
});
