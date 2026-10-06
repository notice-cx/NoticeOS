import { useDemoReadonly } from '@/lib/browser-context';
import { useBrowserRuntime } from '@/lib/browser-context';
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Ga4RealtimeAsset, Ga4RealtimePayload } from "@noticeos/contract";
import { revenueCalendarDate } from "@shared/daily-revenue";
import { useMemo } from "react";
import { createDisplayCache } from "@/lib/display-cache";
import { isGa4RealtimePayload } from "@/lib/api";


/** Realtime is isolated from the Wall read model: a slow provider must never
 * delay or blank the asset cards. Failed polls retain the last-good values,
 * and a read merely in progress keeps what the Wall drew (`keepReadingsInProgress`). */
export function useGa4Realtime() {
  const demoReadonly = useDemoReadonly();
  const runtime = useBrowserRuntime();
  const client = useQueryClient();
  const display = useMemo(() => {
    let storage: Storage | undefined;
    try { storage = window.sessionStorage; } catch { /* The in-memory cache still works. */ }
    const active = () => { if (runtime.guard(() => true)() !== true) throw new Error("This browser context is no longer active."); };
    const cache = createDisplayCache(runtime.owner, storage, active, runtime.assertReadable, "ga4-realtime",
      (value): value is Ga4RealtimePayload => isGa4RealtimePayload(value) && value.assets.some(asset => asset.status === "success"));
    const saved = demoReadonly ? undefined : cache.read();
    return { cache, saved: saved ? currentDayReadings(saved, new Date(Date.now()).toISOString()) : undefined };
  }, [runtime, demoReadonly]);
  // A demo visitor reads too: the demo answers with synthetic readings, so the
  // Wall's live pulse and today chart show there as well. Only the session
  // cache above stays off for a visitor.
  return useQuery<Ga4RealtimePayload>({
    queryKey: ["ga4-realtime"],
    initialData: display.saved,
    initialDataUpdatedAt: display.saved ? Date.parse(display.saved.generatedAt) : undefined,
    queryFn: async ({ signal }) => {
      const next = await runtime.api.fetchGa4Realtime(signal);
      const held = keepReadingsInProgress(client.getQueryData<Ga4RealtimePayload>(["ga4-realtime"]), next);
      display.cache.write(held);
      return held;
    },
    refetchInterval: (query) => {
      const assets = query.state.data?.assets;
      if (!assets?.length || assets.some((asset) => asset.status === 'success')) return 30_000;
      const next = Math.min(...assets.map((asset) => Date.parse(asset.nextAttemptAt ?? '') || 0));
      return Math.max(30_000, Math.min(300_000, next - Date.now()));
    },
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
    staleTime: 20_000,
    retry: 1,
  });
}

/** Ingest's answer when another caller holds the read: nothing failed. */
const READ_IN_PROGRESS = "ga4_read_in_progress";

type Reading = Extract<Ga4RealtimeAsset, { status: "success" }>;

/** A reload may restore live readings, but yesterday's hours cannot be Today. */
export function currentDayReadings(saved: Ga4RealtimePayload, nowIso: string): Ga4RealtimePayload {
  return { ...saved, assets: saved.assets.map(asset =>
    asset.status === "success" && asset.hourlyActiveUsers !== null && !hoursStillToday(asset, asset.timeZone, nowIso)
      ? { ...asset, hourlyActiveUsers: null, hourlyErrorCode: READ_IN_PROGRESS }
      : asset) };
}

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

/** The kept hours were read today on `timeZone`, the clock now in use. A
 * reading without its own hourly time was read with its live count, as
 * `currentHourlyReading` dates it. */
function hoursStillToday(kept: Reading, timeZone: string, nowIso: string): boolean {
  if (kept.hourlyActiveUsers === null || kept.timeZone !== timeZone) return false;
  try {
    return revenueCalendarDate(new Date(kept.hourlyObservedAt ?? kept.observedAt), timeZone) === revenueCalendarDate(new Date(nowIso), timeZone);
  } catch {
    return false;
  }
}
