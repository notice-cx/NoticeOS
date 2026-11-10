// @vitest-environment node
import { describe, expect, it } from "vitest";
import { claimedModel, closeAttribution } from "@shared/tasks";

// Who closed a task is written onto it after its close; only a record made
// for the close the task now shows may name a closer.
describe("closeAttribution", () => {
  const closed = {
    status: "closed",
    closedAt: "2026-10-15T16:00:00Z",
    metadata: { noticeos_closed_by: "claude", noticeos_closed_model: "claude-opus-5.5", noticeos_closed_at: "2026-10-15T16:00:00.000Z" },
  };

  it("names the closer as recorded and the model recorded for this close by its display name", () => {
    expect(closeAttribution(closed)).toEqual({ by: "claude", model: "Claude Opus 5.5" });
    expect(closeAttribution({ ...closed, metadata: { ...closed.metadata, noticeos_closed_model: undefined } })).toEqual({ by: "claude", model: null });
  });

  it("names nobody for an open task, an unrecorded close, or a later close", () => {
    expect(closeAttribution({ ...closed, status: "open" })).toBeNull();
    expect(closeAttribution({ ...closed, metadata: null })).toBeNull();
    expect(closeAttribution({ ...closed, closedAt: "2026-10-16T09:00:00Z" })).toBeNull();
  });

  it("reads the claimer's model by its display name", () => {
    expect(claimedModel({ metadata: { noticeos_claimed_model: "Sonnet 5.5" } })).toBe("Claude Sonnet 5.5");
    expect(claimedModel({ metadata: { noticeos_claimed_model: " " } })).toBeNull();
    expect(claimedModel({ metadata: null })).toBeNull();
  });
});
