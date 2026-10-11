import { Brain, Gavel, Hammer, Radar, Scale } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { sourceReadings, type ConnectionReads } from "@shared/connection-status";
import { sitePath } from "@shared/first-run";
import type { WallLayout } from "@shared/wall-layout";
import type { WallPayload } from "@shared/wall";
import { WallCanvas } from "@/components/WallCanvas";
import { RevenueHero } from "@/components/wall/RevenueHero";
import { SiteRows } from "@/components/wall/SiteRows";
import { EventTimeline } from "@/components/viz/EventTimeline";
import { FlowGraph, type FlowNode } from "@/components/viz/FlowGraph";
import { HealthGrid } from "@/components/viz/HealthGrid";
import { IncidentList } from "@/components/viz/IncidentList";
import { WorkFlow } from "@/components/viz/WorkFlow";
import { useCalendarUpcoming } from "@/hooks/useCalendarUpcoming";
import { useConnections } from "@/hooks/useConnections";
import { useGa4Realtime } from "@/hooks/useGa4Realtime";
import { useNow } from "@/hooks/useNow";
import { useWall } from "@/hooks/useWall";
import { useWallFeed } from "@/hooks/useWallFeed";
import { calendarReadState } from "@/lib/meetings";
import { cn } from "@/lib/utils";
import { healthGridRows, incidentsFromIssues, sourceColumns, timelineFromWall, workFlowRows } from "@/lib/viz-adapters";
import { wallIssues } from "@/lib/wall-issues";
import { withSystemIssues } from "@/lib/wall-system-state";

/** The strip alone, drawn by the Wall's own canvas. */
const STRIP_ONLY: WallLayout = {
  version: 1,
  rows: [{ id: "strip", height: "auto", widgets: [{ id: "strip", type: "strip", width: 1 }] }],
} as WallLayout;

/** The kit's desk sizes, enlarged to the Wall's reading distance. */
function Tv({ children, className, zoom = 1.3 }: { children: ReactNode; className?: string; zoom?: number }) {
  return (
    <div className={cn("min-h-0 min-w-0", className)} style={{ zoom } as CSSProperties}>
      {children}
    </div>
  );
}

/** A region of the TV: true black, one hairline. */
function Region({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn("min-h-0 min-w-0 overflow-hidden rounded-2xl border border-border/50 p-5", className)}>{children}</section>;
}

/**
 * Directions for the TV Wall, drawn from the Wall's own reads and the visual
 * kit, at the television's size. A development surface for choosing one; the
 * chosen direction becomes widget types in the Wall's layout contract.
 */
export function WallConceptsRoute() {
  const [params] = useSearchParams();
  const concept = params.get("c") ?? "a";
  const { data } = useWall();
  const realtime = useGa4Realtime();
  const upcoming = useCalendarUpcoming();
  const { credentials, items } = useConnections();
  const feed = useWallFeed();
  const nowMs = useNow();
  if (!data) return <div className="wall-root min-h-screen bg-background" />;
  const connections: ConnectionReads = { credentials, items };
  const issues = withSystemIssues(wallIssues({ assets: data.assets, attention: data.attention, connections, nowMs }), data.system, nowMs);
  const strip = (
    <WallCanvas layout={STRIP_ONLY} data={data} nowMs={nowMs} meetings={upcoming.data} calendarState={calendarReadState(upcoming)} ga4Realtime={realtime.data} ga4RealtimeError={realtime.isError} connections={connections} />
  );
  const shared = { data, issues, connections, nowMs, feed: feed.data?.items ?? [], since: feed.data?.since ?? null, realtime: realtime.data, realtimeError: realtime.isError };
  return (
    <div className="wall-root flex h-screen flex-col gap-wall-region overflow-hidden bg-background px-wall-inset-x py-wall-inset-y" data-wall-layout="tv" data-wall-concept={concept}>
      <div className="flex-none">{strip}</div>
      {concept === "b" ? <ConceptB {...shared} /> : concept === "c" ? <ConceptC {...shared} /> : <ConceptA {...shared} />}
    </div>
  );
}

interface ConceptProps {
  data: WallPayload;
  issues: ReturnType<typeof withSystemIssues>;
  connections: ConnectionReads;
  nowMs: number;
  feed: NonNullable<ReturnType<typeof useWallFeed>["data"]>["items"];
  since: string | null;
  realtime: ReturnType<typeof useGa4Realtime>["data"];
  realtimeError: boolean;
}

function Sites({ data, issues, realtime, realtimeError, nowMs }: ConceptProps) {
  return <SiteRows assets={data.assets} issues={issues} ga4Realtime={realtime} ga4RealtimeError={realtimeError} nowMs={nowMs} />;
}

function Health({ data, connections, nowMs, withSystem = true }: ConceptProps & { withSystem?: boolean }) {
  return <HealthGrid rows={healthGridRows(data.assets, withSystem ? data.system : undefined, connections, nowMs, sitePath)} columns={sourceColumns(data.assets)} nowMs={nowMs} calm />;
}

function Work({ data }: ConceptProps) {
  return <WorkFlow rows={workFlowRows(data.assets)} waiting={data.operator ? { count: data.operator.waiting, urgent: data.operator.urgent } : null} title="Work this week" compact />;
}

/** The left of every direction: the money over the site rows, as the TV has them. */
function MoneyOverSites(props: ConceptProps) {
  return (
    <div className="flex min-h-0 flex-col gap-wall-region">
      <RevenueHero portfolio={props.data.portfolio} assets={props.data.assets} nowMs={props.nowMs} />
      <div className="min-h-0 flex-1"><Sites {...props} /></div>
    </div>
  );
}

/** A: the Wall's arrangement kept, its text regions redrawn: Needs you
 * becomes the ranked problems list and the feed becomes data-source health
 * over work. */
function ConceptA(props: ConceptProps) {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[1.55fr_1fr] grid-rows-[minmax(0,1fr)] gap-x-wall-region-x">
      <MoneyOverSites {...props} />
      <div className="flex min-h-0 flex-col gap-wall-region">
        <Tv zoom={1.05}>
          <IncidentList items={incidentsFromIssues(props.issues, { besideGrid: true })} nowMs={props.nowMs} marker={props.since} title="Needs you" className="bg-transparent ring-border/50" />
        </Tv>
        <Region className="py-4"><Tv zoom={1}><Health {...props} withSystem={false} /></Tv></Region>
        <Region className="flex-1 py-4"><Tv zoom={1}><Work {...props} /></Tv></Region>
      </div>
    </div>
  );
}

/** B: a status board: every site's data sources and the OS's own parts as
 * one grid beside the money and the sites, work under it. Needs you folds
 * into the grid. */
function ConceptB(props: ConceptProps) {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[1.4fr_1fr] grid-rows-[minmax(0,1fr)] gap-x-wall-region-x">
      <MoneyOverSites {...props} />
      <div className="flex min-h-0 flex-col gap-wall-region">
        <Region className="py-4"><Tv zoom={1}><Health {...props} /></Tv></Region>
        <Region className="flex-1 py-4"><Tv zoom={1}><Work {...props} /></Tv></Region>
      </div>
    </div>
  );
}

/** C: the loop across the top, so the Wall says where the business is in its
 * own cycle; the money and sites below it, beside the last 24 hours of
 * problems on a time axis and work. */
function ConceptC(props: ConceptProps) {
  const timeline = timelineFromWall(props.data.assets, props.issues, props.feed, sitePath);
  const from = new Date(props.nowMs - 24 * 3_600_000).toISOString();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-wall-region">
      <Region className="flex-none py-1">
        <Tv zoom={0.8}>
          <FlowGraph
            nodes={loopNodes(props.data, props.connections, props.nowMs)}
            edges={[
              { from: "sense", to: "attribute" },
              { from: "attribute", to: "decide" },
              { from: "decide", to: "act" },
              { from: "act", to: "learn" },
              { from: "learn", to: "sense", loop: true, label: "next round" },
            ]}
            nowMs={props.nowMs}
            direction="horizontal"
            ariaLabel="The loop NoticeOS runs"
          />
        </Tv>
      </Region>
      <div className="grid min-h-0 flex-1 grid-cols-[1.4fr_1fr] grid-rows-[minmax(0,1fr)] gap-x-wall-region-x">
        <MoneyOverSites {...props} />
        <div className="flex min-h-0 flex-col gap-wall-region">
          <Region className="py-3">
            <Tv zoom={1}>
              <EventTimeline
                lanes={timeline.lanes}
                spans={timeline.spans}
                events={timeline.events}
                window={{ from, to: new Date(props.nowMs).toISOString() }}
                nowMs={props.nowMs}
                marker={props.since ? { at: props.since, label: "Since 6 PM yesterday" } : undefined}
                ariaLabel="The last 24 hours"
              />
            </Tv>
          </Region>
          <Region className="flex-1 py-4"><Tv zoom={1}><Work {...props} /></Tv></Region>
        </div>
      </div>
    </div>
  );
}

/** The loop's five stages from what the payload knows; a stage nothing
 * measures yet says so. */
function loopNodes(data: WallPayload, connections: ConnectionReads, nowMs: number): FlowNode[] {
  const readings = data.assets.flatMap((asset) => sourceReadings(asset.id, asset.dataSources, connections, nowMs));
  const owed = readings.filter((reading) => reading.kind !== "not-using" && reading.kind !== "not-applicable");
  const live = owed.filter((reading) => reading.kind === "working" || reading.kind === "collecting").length;
  const failing = owed.filter((reading) => reading.kind === "failing").length;
  const inProgress = data.assets.reduce((sum, asset) => sum + (asset.work?.inProgress ?? 0), 0);
  const outcomes = data.attention.filter((item) => item.ruleId === "watch-window-closed").length;
  return [
    { id: "sense", label: "Sense", column: 0, icon: Radar, value: `${live} of ${owed.length}`, caption: failing > 0 ? `sources live · ${failing} failing` : "sources live", state: failing > 0 ? "warn" : "ok" },
    { id: "attribute", label: "Attribute", column: 1, icon: Scale, caption: "not measured yet", state: "absent" },
    { id: "decide", label: "Decide", column: 2, icon: Gavel, value: data.operator ? String(data.operator.waiting) : undefined, caption: data.operator ? `waiting on you · ${data.operator.urgent} urgent` : "not read", state: data.operator && data.operator.urgent > 0 ? "warn" : "ok" },
    { id: "act", label: "Act", column: 3, icon: Hammer, value: String(inProgress), caption: "in progress", state: inProgress > 0 ? "active" : "idle" },
    { id: "learn", label: "Learn", column: 4, icon: Brain, value: outcomes > 0 ? String(outcomes) : undefined, caption: outcomes > 0 ? "outcomes ready" : "no reading due", state: outcomes > 0 ? "ok" : "idle" },
  ];
}

export default WallConceptsRoute;
