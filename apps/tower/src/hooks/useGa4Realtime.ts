import { useDemoReadonly } from '@/lib/browser-context';
import { useTowerApi } from '@/lib/browser-context';
import { keepPreviousData, replaceEqualDeep, useQuery } from "@tanstack/react-query";
import type { Ga4RealtimeAsset, Ga4RealtimePayload } from "@noticeos/contract";
import { revenueCalendarDate } from "@shared/daily-revenue";


/** Realtime is isolated from the Wall read model: a slow provider must never
 * delay or blank the asset cards. Failed polls retain the last-good values,
 * and a read merely in progress keeps what the Wall drew (`keepReadingsInProgress`). */
export function useGa4Realtime() {
  const demoReadonly = useDemoReadonly();
  const { fetchGa4Realtime } = useTowerApi();
  return useQuery<Ga4RealtimePayload>({
    enabled: !demoReadonly,
    queryKey: ["ga4-realtime"],
    queryFn: ({ signal }) => fetchGa4Realtime(signal),
    refetchInterval: (query) => {
      const assets = query.state.data?.assets;
      if (!assets?.length || assets.some((asset) => asset.status === 'success')) return 30_000;
      const next = Math.min(...assets.map((asset) => Date.parse(asset.nextAttemptAt ?? '') || 0));
      return Math.max(30_000, Math.min(300_000, next - Date.now()));
    },
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
    structuralSharing: (previous, next) =>
      replaceEqualDeep(previous, keepReadingsInProgress(previous as Ga4RealtimePayload | undefined, next as Ga4RealtimePayload)),
    staleTime: 20_000,
    retry: 1,
  });
}

/** Ingest's answer when another caller holds the read: nothing failed. */
const READ_IN_PROGRESS = "ga4_read_in_progress";

type Reading = Extract<Ga4RealtimeAsset, { status: "success" }>;

/**
 * A read that is merely in progress says nothing new about a site, so it never
 * replaces what the Wall last drew with a dash (bead `ro-trai.40`). The site
 * keeps its last reading, still dated by its own `observedAt`, so an old one
 * reads as out of date. Today's hours stay only while they are today's on the
 * clock they were bucketed on. Every other answer, a refusal included,
 * replaces the reading as before.
 */
export function keepReadingsInProgress(
  previous: Ga4RealtimePayload | undefined,
  next: Ga4RealtimePayload,
): Ga4RealtimePayload {
  if (!previous) return next;
  const last = new Map(previous.assets.map((asset) => [asset.asset, asset]));
  const assets = next.assets.map((asset): Ga4RealtimeAsset => {
    const kept = last.get(asset.asset);
    if (kept?.status !== "success") return asset;
    if (asset.status === "error") {
      if (asset.errorCode !== READ_IN_PROGRESS) return asset;
      return kept.hourlyActiveUsers === null || hoursStillToday(kept, kept.timeZone, next.generatedAt)
        ? kept
        : { ...kept, hourlyActiveUsers: null, hourlyErrorCode: READ_IN_PROGRESS };
    }
    if (asset.hourlyErrorCode !== READ_IN_PROGRESS || !hoursStillToday(kept, asset.timeZone, next.generatedAt)) return asset;
    return {
      ...asset,
      hourlyActiveUsers: kept.hourlyActiveUsers,
      hourlyErrorCode: kept.hourlyErrorCode,
      hourlyObservedAt: kept.hourlyObservedAt,
      hourlyNextAttemptAt: kept.hourlyNextAttemptAt,
    };
  });
  return { ...next, assets };
}

/** The kept hours were read today on `timeZone`, the clock now in use. */
function hoursStillToday(kept: Reading, timeZone: string, nowIso: string): boolean {
  if (kept.hourlyActiveUsers === null || !kept.hourlyObservedAt || kept.timeZone !== timeZone) return false;
  try {
    return revenueCalendarDate(new Date(kept.hourlyObservedAt), timeZone) === revenueCalendarDate(new Date(nowIso), timeZone);
  } catch {
    return false;
  }
}
