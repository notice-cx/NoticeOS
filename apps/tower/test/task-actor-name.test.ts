// @vitest-environment node
import { describe, expect, it } from "vitest";
import { actorName, taskActorLabel } from "@shared/tasks";

describe("the name an actor is shown under", () => {
  it("shows a service acting for an agent by the agent's name", () => {
    expect(actorName("service:demo/claude")).toBe("claude");
    expect(actorName("service:noticeos/os-up-panel-filer")).toBe("os-up-panel-filer");
    // A credential's name never holds a slash; an agent's may.
    expect(actorName("service:noticeos/team/codex")).toBe("team/codex");
  });

  it("keeps every other actor as recorded", () => {
    for (const actor of ["claude", "Dana", "agent:Claude Code (ntasks)", "service:noticeos", "service:demo/", "person:service:demo/claude"]) {
      expect(actorName(actor)).toBe(actor);
    }
  });

  it("applies the rule with and without a workspace's member list, which still names its own members", () => {
    const member = "0f6c2a3e-1b2c-4d5e-8f90-123456789abc";
    const actors = [{ principalId: member, displayName: "Dana" }];
    expect(taskActorLabel("service:demo/claude")).toBe("claude");
    expect(taskActorLabel("service:demo/claude", actors)).toBe("claude");
    expect(taskActorLabel(member, actors)).toBe("Dana");
    expect(taskActorLabel("9a8b7c6d-1b2c-4d5e-8f90-123456789abc", actors)).toBe("Unknown actor");
  });
});
