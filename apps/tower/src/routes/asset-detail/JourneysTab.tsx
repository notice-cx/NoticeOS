import { useView } from "@/hooks/useView";
import type { ViewId } from "@shared/views";
import type { JourneySummaryMetric } from "@/components/JourneyMonitor";
import type { JourneyDefinition } from "@noticeos/contract/journeys";
import type { AssetDetailFor } from "@shared/asset-detail-views";
import { changesetSlug, type JsonValue } from "@shared/changeset";
import { configRegister } from "@shared/config-registers";
import { JourneyMonitor, type JourneySaveOutcome } from "@/components/JourneyMonitor";
import { useFieldCollectionSave } from "@/hooks/useCollectionSave";
import { useFieldConfigSave } from "@/hooks/useConfigSave";
import { useConfigWritable } from "@/hooks/useConfigWritable";

export function JourneysTab({ data }: { data: AssetDetailFor<"journeys"> }) {
  const { view } = useView();
  const save = useFieldConfigSave();
  const seed = useFieldCollectionSave();
  const { writable, reason } = useConfigWritable();
  const current = data.ga4Config.journeys ?? null;
  const definitions = current ?? data.journeys?.definitions ?? [];
  const asset = data.asset.id;
  const token = asset.replace(/~/g, "~0").replace(/\//g, "~1");
  const events = [...new Set([
    ...(data.ga4Config.valueEvents ?? []),
    ...(data.ga4Config.productUseStages ?? []).map((stage) => stage.eventName),
    ...definitions.flatMap((definition) => definition.steps.flatMap((step) => step.alternatives.map((alternative) => alternative.eventName))),
  ])].sort();

  async function write(next: JourneyDefinition[]): Promise<JourneySaveOutcome> {
    if (current === null && next.length === 1) {
      return seed({
        register: configRegister("journeys"),
        params: { asset },
        change: { kind: "seed", row: next[0] as unknown as JsonValue, holderExists: data.ga4Config.valueEventsEntryExists === true },
        label: "Journeys",
        slug: changesetSlug(asset, "journeys"),
      });
    }
    return save({
      ops: [{
        kind: "file-json-set",
        file: "config/value-events.json",
        pointer: `/assets/${token}/journeys`,
        ...(current === null ? { expectAbsent: true as const } : { expect: current as unknown as JsonValue }),
        value: next as unknown as JsonValue,
      }],
      label: "Journeys",
      slug: changesetSlug(asset, "journeys"),
    });
  }

  const summaryOrder: Record<ViewId, readonly JourneySummaryMetric[]> = {
    overview: ["visitors", "completion", "loss", "change"],
    growth: ["visitors", "change", "completion", "loss"],
    revenue: ["completion", "loss", "visitors", "change"],
    delivery: ["loss", "completion", "change", "visitors"],
    reliability: ["loss", "change", "visitors", "completion"],
  };
  return <div id="journeys" className="scroll-mt-4"><JourneyMonitor summaryOrder={summaryOrder[view.id]} definitions={definitions} snapshot={data.journeys} sessionExploration={data.sessionExploration} onSave={writable ? write : undefined} readOnlyReason={reason} eventNames={events} /></div>;
}
