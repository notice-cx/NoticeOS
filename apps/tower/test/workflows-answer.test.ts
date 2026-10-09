import { describe, expect, it } from "vitest";
import { workflowsAnswer } from "@/routes/WorkflowsRoute";

describe("the Workflows index's one answer (D44)", () => {
  it("counts what needs you, then every state once in its own label", () => {
    expect(workflowsAnswer(["failed", "unknown", "succeeded", "succeeded", "never"], "workflows")).toEqual({
      answer: "2 of 5 workflows need you",
      detail: "1 failed · 1 unknown · 2 succeeded · 1 no runs",
      mark: "attention",
    });
  });

  it("says nothing needs you when nothing failed or went unconfirmed", () => {
    expect(workflowsAnswer(["running", "succeeded", "paused"], "operations")).toEqual({
      answer: "No operations need you",
      detail: "1 running · 1 succeeded · 1 paused",
      mark: "clear",
    });
  });

  it("names an empty install rather than claiming all is well", () => {
    expect(workflowsAnswer([], "workflows").answer).toBe("No workflows installed");
  });
});
