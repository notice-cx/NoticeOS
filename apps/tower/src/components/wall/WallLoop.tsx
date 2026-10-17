import { Brain, Gavel, Hammer, Radar, Scale } from "lucide-react";
import { isRetired } from "@shared/asset-setup";
import { sourceReadings, type ConnectionReads } from "@shared/connection-status";
import type { WallPayload } from "@shared/wall";
import { FlowGraph, type FlowEdge, type FlowNode } from "@/components/viz/FlowGraph";
import { operatorWaiting } from "@/lib/operator-posture";

// The loop NoticeOS runs, Sense → Attribute → Decide → Act → Learn and back,
// each stage with the one live count the payload has for it, so the room sees
// where the business is in its own cycle. A stage nothing measures yet says
// so; no stage draws a number its read did not produce.

const EDGES: readonly FlowEdge[] = [
  { from: "sense", to: "attribute" },
  { from: "attribute", to: "decide" },
  { from: "decide", to: "act" },
  { from: "act", to: "learn" },
  { from: "learn", to: "sense", loop: true, label: "next round" },
];

/** The five stages from what the payload and the connection reads know. */
export function loopNodes(data: Pick<WallPayload, "assets" | "attention" | "operator">, connections: ConnectionReads, nowMs: number): FlowNode[] {
  // A retired site is in none of the counts, even on a TV that shows it.
  const watched = data.assets.filter((asset) => !isRetired(asset.status));
  const retired = new Set(data.assets.filter((asset) => isRetired(asset.status)).map((asset) => asset.id));
  const readings = watched.flatMap((asset) => sourceReadings(asset.id, asset.dataSources, connections, nowMs));
  const owed = readings.filter((reading) => reading.kind !== "not-using" && reading.kind !== "not-applicable");
  const live = owed.filter((reading) => reading.kind === "working" || reading.kind === "collecting").length;
  const failing = owed.filter((reading) => reading.kind === "failing").length;
  const counted = watched.filter((asset) => asset.work);
  const inProgress = counted.reduce((sum, asset) => sum + (asset.work?.inProgress ?? 0), 0);
  const outcomes = data.attention.filter((item) => item.ruleId === "watch-window-closed" && !retired.has(item.asset)).length;
  const waiting = operatorWaiting(data.operator, nowMs);
  const more = waiting?.partial ? "+" : "";
  const waitingKnown = waiting !== null && !(waiting.count === 0 && (waiting.partial || waiting.stale));

  const sense: FlowNode = owed.length === 0
    ? { id: "sense", label: "Sense", column: 0, icon: Radar, caption: "no sources yet", state: "idle" }
    : {
        id: "sense", label: "Sense", column: 0, icon: Radar, value: `${live} of ${owed.length}`,
        caption: failing > 0 ? `live · ${failing} failing` : "sources live",
        state: failing > 0 ? "warn" : "ok",
      };
  const decide: FlowNode = waiting === null
    ? { id: "decide", label: "Decide", column: 2, icon: Gavel, caption: "not read", state: "idle" }
    : waitingKnown
      ? {
          id: "decide", label: "Decide", column: 2, icon: Gavel, value: `${waiting.count}${more}`,
          caption: waiting.urgent > 0 ? `for you to decide · ${waiting.urgent}${more} urgent` : "for you to decide",
          state: waiting.urgent > 0 ? "warn" : "ok",
        }
      : { id: "decide", label: "Decide", column: 2, icon: Gavel, caption: waiting.partial ? "for you to decide · unknown" : "for you to decide · stale", state: "idle" };
  const act: FlowNode = counted.length === 0
    ? { id: "act", label: "Act", column: 3, icon: Hammer, caption: "not read", state: "idle" }
    : { id: "act", label: "Act", column: 3, icon: Hammer, value: String(inProgress), caption: "in progress", state: inProgress > 0 ? "active" : "idle" };
  return [
    sense,
    { id: "attribute", label: "Attribute", column: 1, icon: Scale, caption: "not measured yet", state: "absent", stateLabel: "Not measured" },
    decide,
    act,
    {
      id: "learn", label: "Learn", column: 4, icon: Brain,
      value: outcomes > 0 ? String(outcomes) : undefined,
      caption: outcomes > 0 ? "outcomes ready" : "no reading due",
      state: outcomes > 0 ? "ok" : "idle",
    },
  ];
}

export interface WallLoopProps {
  data: Pick<WallPayload, "assets" | "attention" | "operator">;
  connections: ConnectionReads;
  nowMs: number;
}

/** The loop as one band across the TV; a narrow screen stacks it. */
export function WallLoop({ data, connections, nowMs }: WallLoopProps) {
  return (
    <section aria-label="The loop" className="min-w-0" data-wall-loop>
      <FlowGraph
        nodes={loopNodes(data, connections, nowMs)}
        edges={EDGES}
        nowMs={nowMs}
        surface="background"
        dense
        ariaLabel="The loop NoticeOS runs"
      />
    </section>
  );
}
