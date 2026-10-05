import { useDemoReadonly } from '@/lib/browser-context';
import { useTowerApi } from '@/lib/browser-context';
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { CalendarUpcoming } from "@noticeos/contract";


/** Isolated from the Wall read model, like the realtime poll: a slow or broken
 * calendar feed must never delay the asset cards. The panel's own time math
 * runs off the wall clock, so a held snapshot keeps aging correctly between
 * polls — sixty seconds is fine for a surface whose smallest unit is a minute.
 *
 * A HIDDEN TAB DOES NOT POLL (bead `ro-ujb9.105`), as `useWall` since
 * `ro-ujb9.63`. This hook polled "in the background" because the TV is never
 * focused, but TanStack's background is `visibilityState === "hidden"`, not a
 * missing focus: the TV is on screen and keeps its minute. A desk tab behind
 * another stops asking, and refetches at once on return once its snapshot is
 * older than `staleTime`. */
export function useCalendarUpcoming() {
  const demoReadonly = useDemoReadonly();
  const { fetchCalendarUpcoming } = useTowerApi();
  return useQuery<CalendarUpcoming>({
    enabled: !demoReadonly,
    queryKey: ["calendar-upcoming"],
    queryFn: async ({ signal }) => {
      const snapshot = await fetchCalendarUpcoming(signal);
      // A configured calendar that answered with no readable feed is a failed
      // read, not a successful empty day. Reject so Query retains its last data.
      if (snapshot.feedsConfigured > 0 && snapshot.feedsOk === 0) {
        throw new Error("Calendar feeds are unavailable");
      }
      return snapshot;
    },
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: 1,
  });
}
