// @vitest-environment node
import { describe, expect, it } from "vitest";
import { actorName, holderLabel, taskActorLabel } from "@shared/tasks";

describe("the name an actor is shown under", () => {
  it("shows every spelling of one agent by one name, a service acting for an agent as that agent", () => {
    for (const actor of ["service:demo/claude", "claude", "agent:Claude Code (ntasks)"]) expect(actorName(actor)).toBe("Claude Code");
    expect(actorName("service:noticeos/os-up-panel-filer")).toBe("os-up-panel-filer");
    // A credential's name never holds a slash; an agent's may.
    expect(actorName("service:noticeos/team/codex")).toBe("team/codex");
  });

  it("applies the rule with and without a workspace's member list, which still names its own members", () => {
    const member = "0f6c2a3e-1b2c-4d5e-8f90-123456789abc";
    const actors = [{ principalId: member, displayName: "Dana" }];
    expect(taskActorLabel("service:demo/claude")).toBe("Claude Code");
    expect(taskActorLabel("service:demo/claude", actors)).toBe("Claude Code");
    expect(taskActorLabel(member, actors)).toBe("Dana");
    expect(taskActorLabel("9a8b7c6d-1b2c-4d5e-8f90-123456789abc", actors)).toBe("Unknown actor");
  });
});

describe("a holder's label among others", () => {
  it("adds the kind only where holders of different kinds share a name", () => {
    const holders = [["service:ci/nightly-triage", "nightly-triage"], ["nightly-triage", "nightly-triage"], ["claude", "Claude Code"]] as const;
    expect(holders.map(([actor, name]) => holderLabel(actor, name, holders))).toEqual(["nightly-triage (agent)", "nightly-triage (person)", "Claude Code"]);
  });
});
