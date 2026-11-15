import { connectionCollections } from '@shared/scheduled-jobs';
import { useConfigWritable } from '@/hooks/useConfigWritable';
import { useSettings } from '@/hooks/useSettings';
import { ScheduleRows } from '@/routes/workflows/ScheduleEditor';

export function ConnectionSchedule({ provider }: { provider: string }) {
  const jobs = connectionCollections(provider);
  const { data } = useSettings();
  const { writable } = useConfigWritable();
  if (!data) return null;
  return <ScheduleRows jobs={jobs} overrides={data.collection.schedules} writable={writable} />;
}
