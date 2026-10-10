import { useDemoReadonly } from '@/lib/browser-context';
import { useBrowserRuntime } from '@/lib/browser-context';
import { keepPreviousData, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { CalendarUpcoming } from "@noticeos/contract";
import { useMemo } from "react";
import { CalendarUpcomingReadError } from "@/lib/api";
import { createCalendarCache, retainCalendarEvents } from "@/lib/calendar-cache";
import { demoViewer } from "@shared/demo-viewer";

// Observers of the same owner-bound query share the attempt count and deadline.
// Leaving and returning to the editor cannot bypass a held retry time.
const attempts = new WeakMap<QueryClient, { failures: number; retryAt: number }>();

/** Isolated from the Wall read model, like the realtime poll: a slow or broken
 * calendar feed must never delay the asset cards. The panel's own time math
 * runs off the wall clock, so a held snapshot keeps aging correctly between
 * polls — sixty seconds is fine for a surface whose smallest unit is a minute.
 *
 * A hidden tab does not poll, as `useWall`: TanStack's background is
 * `visibilityState === "hidden"`, not a missing focus, so the TV is on screen
 * and keeps its minute while a desk tab behind another stops asking. Return
 * respects the current retry deadline. */
export function useCalendarUpcoming() {
  const demoReadonly = useDemoReadonly();
  const runtime = useBrowserRuntime();
  const client = useQueryClient();
  const read = useMemo(() => {
    let storage: Storage | undefined;
    try { storage = window.sessionStorage; } catch { /* The in-memory cache still works. */ }
    const active = () => { if (runtime.guard(() => true)() !== true) throw new Error("This browser context is no longer active."); };
    const cache = createCalendarCache(runtime.owner, storage, active, runtime.assertReadable);
    let state = attempts.get(client);
    if (!state) {
      state = { failures: 0, retryAt: 0 };
      attempts.set(client, state);
    }
    return { cache, saved: demoReadonly ? undefined : cache.read(), state };
  }, [runtime, demoReadonly, client]);
  // A hosted demo visitor reads too, as for realtime: that demo answers with a
  // synthetic schedule. The local demo viewer refuses this provider read, so
  // it asks nothing there. The saved snapshot above stays off for any visitor.
  const query = useQuery<CalendarUpcoming>({
    enabled: demoViewer() === null,
    queryKey: ["calendar-upcoming"],
    initialData: read.saved,
    initialDataUpdatedAt: read.saved ? Date.parse(read.saved.fetchedAt) : undefined,
    queryFn: async ({ signal }) => {
      try {
        const snapshot = await runtime.api.fetchCalendarUpcoming(signal);
        // An unreadable configured calendar cannot replace saved event information.
        if (snapshot.feedsConfigured > 0 && snapshot.feedsOk === 0) {
          throw new CalendarUpcomingReadError("Calendar feeds are unavailable", Date.parse(snapshot.fetchedAt) + 300_000);
        }
        const held = retainCalendarEvents(snapshot, client.getQueryData<CalendarUpcoming>(["calendar-upcoming"]));
        read.cache.write(held);
        if (snapshot.feedsOk < snapshot.feedsConfigured) {
          read.state.failures += 1;
          read.state.retryAt = Math.max(Date.now() + 30_000, Date.parse(snapshot.fetchedAt) + 300_000);
        } else {
          read.state.failures = 0;
          read.state.retryAt = 0;
        }
        return held;
      } catch (error) {
        if (!signal.aborted && runtime.guard(() => true)() === true) {
          read.state.failures += 1;
          const delay = Math.min(30_000 * 2 ** Math.min(read.state.failures - 1, 4), 300_000);
          read.state.retryAt = Math.max(Date.now() + delay, error instanceof CalendarUpcomingReadError ? error.retryAt ?? 0 : 0);
          throw new CalendarUpcomingReadError("Calendar read failed", read.state.retryAt, read.state.failures);
        }
        throw error;
      }
    },
    refetchInterval: () => read.state.failures > 0 ? Math.max(1_000, read.state.retryAt - Date.now()) : 60_000,
    refetchIntervalInBackground: false,
    refetchOnMount: () => Date.now() >= read.state.retryAt,
    retryOnMount: Date.now() >= read.state.retryAt,
    refetchOnWindowFocus: () => Date.now() >= read.state.retryAt,
    refetchOnReconnect: () => Date.now() >= read.state.retryAt,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    // Each scheduled read is one attempt. TanStack's immediate retries would
    // inflate the failure count and ask again inside the server's cooldown.
    retry: false,
  });
  return { ...query, consecutiveFailures: query.error instanceof CalendarUpcomingReadError ? query.error.consecutiveFailures : read.state.failures };
}
