import { Tabs } from '@/components/Tabs';

export function HealthNavigation() {
  return <Tabs label="System health views" idBase="health-view" panelId="health-view-panel" tabs={[
    { key: 'overview', label: 'Overview', to: '/health', end: true },
    { key: 'operations', label: 'Background operations', to: '/health/operations' },
  ]} />;
}
