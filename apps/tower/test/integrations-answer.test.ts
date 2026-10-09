import { describe, expect, it } from "vitest";
import type { ConnectionStatus } from "@shared/connection-status";
import { integrationsAnswer } from "@/routes/IntegrationsRoute";

const shown = (kind: ConnectionStatus["kind"], sitesFailing = 0): ConnectionStatus => ({
  provider: "p", kind, sites: [], sitesFailing, sitesMeasured: 0, sitesOverdue: 0, missing: 0, incomplete: 0,
});

describe("the Integrations page's one answer (D44)", () => {
  it("names the one connection that needs you, and says why", () => {
    expect(integrationsAnswer([{ name: "Google", shown: shown("failing") }, { name: "Bing", shown: shown("working") }]))
      .toEqual({ answer: "Google needs you", detail: "Google failing", mark: "problem" });
  });

  it("counts a working connection that fails on a site as needing you", () => {
    expect(integrationsAnswer([
      { name: "Google", shown: shown("working", 1) },
      { name: "Bing", shown: shown("overdue") },
      { name: "PostHog", shown: shown("working") },
    ])).toEqual({ answer: "2 of 3 integrations need you", detail: "Google failing · Bing overdue", mark: "problem" });
  });

  it("counts what is connected when nothing needs you", () => {
    expect(integrationsAnswer([{ name: "Google", shown: shown("working") }, { name: "Bing", shown: shown("not-connected") }]).answer)
      .toBe("1 of 2 integrations connected");
    expect(integrationsAnswer([{ name: "Google", shown: shown("working") }, { name: "Bing", shown: shown("collecting") }]).answer)
      .toBe("All 2 integrations connected");
    expect(integrationsAnswer([{ name: "Bing", shown: shown("not-connected") }]).answer).toBe("Nothing connected yet");
  });
});
