import { describe, expect, it } from "vitest";
import { workflowsAnswer } from "@/routes/WorkflowsRoute";

describe("the Workflows index's one answer", () => {
  it("marks failed and unknown workflows as needing attention", () => {
    expect(workflowsAnswer(["failed", "unknown", "succeeded", "succeeded", "never"], "workflows").mark).toBe("attention");
  });

  it("says nothing needs attention when nothing failed or went unconfirmed", () => {
    expect(workflowsAnswer(["running", "succeeded", "paused"], "operations").mark).toBe("clear");
  });

  it("names an empty install rather than claiming all is well", () => {
    expect(workflowsAnswer([], "workflows").mark).toBe("empty");
  });
});
