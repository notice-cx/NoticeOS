import { useQuery } from '@tanstack/react-query';
import { useTowerApi } from '@/lib/browser-context';

/** The installation as its host sees it (Settings > Installation); facts that change only when the stack does. */
export function useInstallation(enabled = true) {
  const { fetchInstallation } = useTowerApi();
  return useQuery({ queryKey: ['installation'], queryFn: ({ signal }) => fetchInstallation(signal), enabled, staleTime: 60_000, retry: false });
}
