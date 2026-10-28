import { fireEvent, render, screen, waitFor } from "./render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JourneyMonitorProps } from "@/components/JourneyMonitor";
import { JourneysTab } from "@/routes/asset-detail/JourneysTab";
import { JOURNEY_DEMO_DEFINITIONS } from "@/routes/kitchen-sink/journey-fixture";
import { everyTabPayload } from "./asset-detail-fixture";

const calls = vi.hoisted(() => ({ save: vi.fn(), seed: vi.fn() }));
vi.mock("@/hooks/useWall", () => ({ useWall: () => ({ data: undefined }) }));
vi.mock("@/hooks/useConfigSave", () => ({ useFieldConfigSave: () => calls.save }));
vi.mock("@/hooks/useCollectionSave", () => ({ useFieldCollectionSave: () => calls.seed }));
vi.mock("@/hooks/useConfigWritable", () => ({ useConfigWritable: () => ({ writable: true, reason: null }) }));
vi.mock("@/components/JourneyMonitor", () => ({ JourneyMonitor: (props: JourneyMonitorProps) => <button onClick={() => void props.onSave?.([JOURNEY_DEMO_DEFINITIONS[0]!])}>Save test journey</button> }));

beforeEach(() => { calls.save.mockReset().mockResolvedValue({ saved: true }); calls.seed.mockReset().mockResolvedValue({ saved: true }); });

describe("JourneysTab guarded writes", () => {
  it("uses a filename-safe slug and exact whole-list guard for a domain asset", async () => {
    const data = everyTabPayload();
    data.asset.id = "journey.example";
    data.ga4Config.journeys = [];
    render(<JourneysTab data={data} />);
    fireEvent.click(screen.getByRole("button", { name: "Save test journey" }));
    await waitFor(() => expect(calls.save).toHaveBeenCalledOnce());
    expect(calls.save).toHaveBeenCalledWith(expect.objectContaining({ slug: "journey-example-journeys", ops: [expect.objectContaining({ pointer: "/assets/journey.example/journeys", expect: [], value: [JOURNEY_DEMO_DEFINITIONS[0]] })] }));
    expect(calls.seed).not.toHaveBeenCalled();
  });

  it("seeds a missing list without replacing a sibling declaration", async () => {
    const data = everyTabPayload();
    data.asset.id = "journey.example";
    data.ga4Config.journeys = null;
    data.ga4Config.valueEventsEntryExists = true;
    render(<JourneysTab data={data} />);
    fireEvent.click(screen.getByRole("button", { name: "Save test journey" }));
    await waitFor(() => expect(calls.seed).toHaveBeenCalledOnce());
    expect(calls.seed).toHaveBeenCalledWith(expect.objectContaining({ slug: "journey-example-journeys", params: { asset: "journey.example" }, change: { kind: "seed", row: JOURNEY_DEMO_DEFINITIONS[0], holderExists: true } }));
    expect(calls.save).not.toHaveBeenCalled();
  });
});
