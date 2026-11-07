import { describe, expect, it } from "vitest";
import type { ConnectionStatus } from "@shared/connection-status";
import { integrationsAnswer } from "@/routes/IntegrationsRoute";

const shown = (kind: ConnectionStatus["kind"], sitesFailing = 0): ConnectionStatus => ({
  provider: "p", kind, sites: [], sitesFailing, sitesMeasured: 0, sitesOverdue: 0, missing: 0, incomplete: 0,
});

describe("the Integrations page's one answer", () => {
  it("marks a failed connection as needing attention", () => {
    expect(integrationsAnswer([{ name: "Google", shown: shown("failing") }, { name: "Bing", shown: shown("working") }]).mark).toBe("problem");
  });

  it("counts a working connection that fails on an asset as needing you", () => {
    expect(integrationsAnswer([
      { name: "Google", shown: shown("working", 1) },
      { name: "PostHog", shown: shown("working") },
    ]).mark).toBe("problem");
  });
});
