import { Suspense, useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { viewCovers, type AssetDetailResponse } from "@shared/asset-detail-views";
import type { WatchSeed } from "@shared/watch-windows";
import { ReadFailed } from "@/components/ReadFailed";
import { RouteLoading } from "@/components/RouteLoading";
import { TabPanel } from "@/components/Tabs";
import { RecommendationEvidenceProvider } from "@/components/AnalysisEvidence";
import { useAssetDetail, usePrefetchAssetDetail } from "@/hooks/useAssetDetail";
import { useNow } from "@/hooks/useNow";
import { ApiError } from "@/lib/api";
import { Header } from "@/routes/asset-detail/AssetHeader";
import {
  ASSET_TABS,
  AssetTabs,
  HASH_TAB,
  HASH_ANCHOR,
  TAB_IDS,
  TAB_PANEL_ID,
  tabFromParam,
  tabPath,
  type AssetTab,
} from "@/routes/asset-detail/AssetTabs";
// Each tab's code arrives when the tab is opened (bead `ro-ujb9.84`); these are
// the lazy stand-ins, not the tab modules. See `asset-detail/lazy-tabs.ts`.
import {
  ActivityTab,
  AlertsTab,
  AssetSettingsPanel,
  FinancialsTab,
  GrowthTab,
  OverviewTab,
  SearchTab,
  SourcesTab,
  TasksTab,
  preloadAssetTab,
} from "@/routes/asset-detail/lazy-tabs";
import { NotFound } from "@/routes/asset-detail/RouteStates";

// The tab identity — which tabs exist, where each one lives in the URL, and
// which hash selects which — is `asset-detail/AssetTabs.tsx`'s, and re-exported
// here because this module is the page's public name: App.tsx routes at it and
// the route tests address tabs through it.
export { ASSET_TABS, type AssetTab };


export function AssetDetailRoute() {
  const { id = "", tab: tabParam } = useParams();
  const now = useNow();
  const { hash, search } = useLocation();
  const navigate = useNavigate();
  const tab = tabFromParam(tabParam);
  // Deep links land here with a hash: a matrix cell click as #integrations, an
  // alert's change chip as #timeline. The section only exists while its tab is
  // mounted, so select the tab first (replace: the hash's tab is not a step in
  // the operator's history).
  const hashTab = HASH_TAB[hash] ?? null;
  // The tab this page is about to show. A hash that names a tab is where the
  // page is going, not the segment it is leaving.
  const showing = hashTab ?? tab;
  // ONE READ PER TAB (bead `ro-ujb9.64`): the poll asks for the view of the tab
  // on screen, and a pointer resting on another tab starts that tab's read.
  const { data, isFetching, error, refetch } = useAssetDetail(id, showing);
  const prefetchView = usePrefetchAssetDetail(id);

  // A check some OTHER section asked to open (bead `ro-5e8.5`). It lives at the
  // route because the composer lives in the Timeline section and the surfaces
  // that raise one are pages away from it — one seed at a time, since two
  // half-designed comparisons is the same defect as two open composers. The
  // route is ONE component across every tab (App.tsx's optional `:tab`
  // segment), which is what lets the seed survive the switch to Activity.
  const [watchSeed, setWatchSeed] = useState<WatchSeed | null>(null);

  /** A query row lives on Search and a finding on Overview; the composer lives
   * in the Timeline section on Activity. Switch tabs FIRST, then hand over the
   * seed — otherwise the click opens a form on a panel nobody is looking at. */
  function openWatch(seed: WatchSeed) {
    if (tab !== "activity") navigate(tabPath(id, "activity", search));
    setWatchSeed(seed);
  }

  const notFound = error instanceof ApiError && error.status === 404;
  // A failed poll keeps the last-good payload (TanStack Query); the header's age
  // badge says so rather than letting a held page look current (doc 10 principle 2).
  const lastGood = Boolean(error) && Boolean(data);

  useEffect(() => {
    if (hashTab === null || hashTab === tab) return;
    navigate(`${tabPath(id, hashTab, search)}${hash}`, { replace: true });
  }, [hashTab, tab, id, hash, search, navigate]);

  // A segment nobody built renders Overview — but `Tabs` matches the active tab
  // on the PATH, so `/assets/:id/nonsense` left alone shows Overview under a bar
  // with nothing selected, and a panel whose `aria-labelledby` names a tab that
  // is not selected (bead `ro-02rn`). Canonicalise instead: the URL becomes the
  // tab it is already showing, keeping the query string and the hash, because a
  // mistyped tab is still the asset the operator asked for. `replace`, because a
  // typo is not a step in the operator's history. A mapped hash outranks this —
  // that redirect names a real tab, this one only corrects a segment — so this
  // stands down while the hash still has a tab to select.
  const canonical =
    tabParam !== undefined &&
    tabParam !== tab &&
    (hashTab === null || hashTab === tab);
  useEffect(() => {
    if (!canonical) return;
    navigate(`${tabPath(id, tab)}${search}${hash}`, { replace: true });
  }, [canonical, hash, id, navigate, search, tab]);

  // Start fetching the code of the tab this page is about to show while the
  // asset's report is still on its way (bead `ro-ujb9.84`), so the two arrive
  // side by side rather than one after the other. Until the redirect above has
  // moved the URL to a hash's tab, the panel holds its neutral frame rather
  // than drawing (and so downloading) a tab nobody asked to see.
  const leaving = showing !== tab;
  useEffect(() => {
    void preloadAssetTab(showing);
  }, [showing]);

  return (
    <div className="asset-detail-root mx-auto flex w-full max-w-[1600px] flex-col gap-4 p-4 md:p-6">
      {notFound ? (
        <NotFound id={id} />
      ) : !data ? (
        error ? (
          <ReadFailed title="Couldn't load this site" subject="read:site" detail={<span className="font-mono">{id}</span>} error={error} retrying={isFetching} onRetry={() => void refetch()} />
        ) : (
          <div className="grid min-h-[40vh] flex-1 place-items-center text-muted-foreground">
            Loading…
          </div>
        )
      ) : (
        <>
          <Header
            asset={data.asset}
            integrations={data.integrations}
            pulseReceivedAt={data.freshness.pulseReceivedAt}
            nowMs={now}
            lastGood={lastGood}
            rangeLabel={tab === "financials" ? "Revenue period" : "Traffic period"}
            showRange={tab === "overview" || tab === "growth" || tab === "financials"}
          />
          <AssetTabs
            data={data}
            assetId={id}
            nowMs={now}
            onPrefetch={(key) => {
              void preloadAssetTab(key);
              prefetchView(key);
            }}
          />
          <TabPanel id={TAB_PANEL_ID} idBase={TAB_IDS} activeKey={tab}>
            {/* ONE boundary for every tab, and never keyed by tab (bead
                `ro-ujb9.84`). Switching tabs is a router transition, and React
                keeps an already-drawn boundary on screen through one, so the
                tab being left stays until the next tab's code is here; the
                neutral frame is only ever seen on a first load whose tab code
                is slower than the asset's report. */}
            <Suspense fallback={<RouteLoading surface="panel" />}>
              {leaving ? (
                <RouteLoading surface="panel" />
              ) : (
                tabContent(tab, data, {
                  nowMs: now,
                  onWatch: openWatch,
                  watchSeed,
                  onSeedDone: () => setWatchSeed(null),
                }) ??
                // The read on screen was cut for another tab and does not carry
                // this one's sections: the header and tab bar keep their facts
                // while this tab's own read arrives, or say it failed.
                (error ? (
                  <ReadFailed title="Couldn't load this site" subject="read:site" detail={<span className="font-mono">{id}</span>} error={error} retrying={isFetching} onRetry={() => void refetch()} />
                ) : (
                  <RouteLoading surface="panel" />
                ))
              )}
              <ScrollToSection data={data} hash={hash} landed={hashTab !== null && hashTab === tab} />
            </Suspense>
          </TabPanel>
        </>
      )}
    </div>
  );
}

/**
 * …then bring a deep link's section into view, once its tab has drawn it. SPA
 * navigation doesn't auto-scroll to a hash.
 *
 * It rides INSIDE the tab panel's `<Suspense>`, beside the tab (bead
 * `ro-ujb9.84`): React commits a boundary's children together, so this effect
 * runs only once the tab's code has arrived and the section exists. As a plain
 * effect on the page it ran when the report arrived — before a lazily fetched
 * tab had drawn anything — found no section, and never looked again. It re-runs
 * on a new report exactly as it did before the split.
 */
function ScrollToSection({
  data,
  hash,
  landed,
}: {
  data: AssetDetailResponse;
  hash: string;
  /** The hash names a section on the tab now showing. */
  landed: boolean;
}) {
  useEffect(() => {
    if (!landed) return;
    const target = document.getElementById(HASH_ANCHOR[hash] ?? hash.slice(1));
    if (!target) return;
    const frame = window.requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [data, hash, landed]);
  return null;
}

interface TabHandlers {
  nowMs: number;
  onWatch: (seed: WatchSeed) => void;
  watchSeed: WatchSeed | null;
  onSeedDone: () => void;
}

/**
 * The tab, drawn from a read that carries its sections — or null when the read
 * on screen does not (bead `ro-ujb9.64`). Each branch asks `viewCovers` for its
 * OWN tab, so every tab is typed on exactly the read it may use.
 *
 * The three tabs that show recommendations get the recommendation-evidence
 * provider around them. It sits inside the panel's one `<Suspense>`, so the
 * boundary above stays the same element whichever tab is open (`ro-ujb9.84`).
 */
function tabContent(tab: AssetTab, data: AssetDetailResponse, handlers: TabHandlers): ReactNode | null {
  const { nowMs, onWatch, watchSeed, onSeedDone } = handlers;
  switch (tab) {
    case "overview":
      return viewCovers(data, "overview") ? (
        <RecommendationEvidenceProvider data={data} nowMs={nowMs}>
          <OverviewTab data={data} nowMs={nowMs} onWatch={onWatch} />
        </RecommendationEvidenceProvider>
      ) : null;
    case "growth":
      return viewCovers(data, "growth") ? (
        <RecommendationEvidenceProvider data={data} nowMs={nowMs}>
          <GrowthTab data={data} nowMs={nowMs} onWatch={onWatch} />
        </RecommendationEvidenceProvider>
      ) : null;
    case "financials":
      return viewCovers(data, "financials") ? <FinancialsTab data={data} nowMs={nowMs} /> : null;
    case "search":
      return viewCovers(data, "search") ? (
        <RecommendationEvidenceProvider data={data} nowMs={nowMs}>
          <SearchTab data={data} nowMs={nowMs} onWatch={onWatch} />
        </RecommendationEvidenceProvider>
      ) : null;
    case "alerts":
      return viewCovers(data, "alerts") ? <AlertsTab data={data} nowMs={nowMs} /> : null;
    case "tasks":
      return viewCovers(data, "tasks") ? <TasksTab data={data} /> : null;
    case "activity":
      return viewCovers(data, "activity") ? (
        <ActivityTab data={data} nowMs={nowMs} seed={watchSeed} onSeedDone={onSeedDone} />
      ) : null;
    case "sources":
      return viewCovers(data, "sources") ? <SourcesTab data={data} nowMs={nowMs} /> : null;
    case "settings":
      return viewCovers(data, "settings") ? (
        <AssetSettingsPanel data={data} nowMs={nowMs} />
      ) : null;
  }
}

export default AssetDetailRoute;
