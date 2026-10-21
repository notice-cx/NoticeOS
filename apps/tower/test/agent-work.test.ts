import { describe, expect, it } from "vitest";
import { agentMaker, evidenceParts } from "@/lib/agent-work";

describe("agentMaker", () => {
  it("reads the maker from the worker's name first, then the models it named", () => {
    expect(agentMaker("claude")).toBe("anthropic");
    expect(agentMaker("claude-code", ["GPT-5-Codex"])).toBe("anthropic");
    expect(agentMaker("codex")).toBe("openai");
    expect(agentMaker("gemini-cli")).toBe("google");
    expect(agentMaker("build-bot", [null, "Sonnet 5.5"])).toBe("anthropic");
    expect(agentMaker("build-bot", ["o3"])).toBe("openai");
    expect(agentMaker("verifier", ["GPT-5-Codex"])).toBe("openai");
  });

  it("leaves a person and an unknown maker without one", () => {
    expect(agentMaker("Mara")).toBeNull();
    expect(agentMaker("Mara", [null])).toBeNull();
    expect(agentMaker("deploy-bot", ["Verifier 1"])).toBeNull();
    // A maker's word inside another word is not that maker.
    expect(agentMaker("Claudette")).toBeNull();
    expect(agentMaker("Joshua")).toBeNull();
  });
});

describe("evidenceParts", () => {
  it("splits a close reason into its sentence, commit and links", () => {
    expect(evidenceParts("Exports pass · 3f2a91c · lightbrief.example/briefs · https://example.com/run/1")).toEqual([
      { kind: "text", text: "Exports pass", href: null },
      { kind: "commit", text: "3f2a91c", href: null },
      { kind: "link", text: "lightbrief.example/briefs", href: null },
      { kind: "link", text: "example.com/run/1", href: "https://example.com/run/1" },
    ]);
    expect(evidenceParts("Fixed in abc1234 with tests")).toEqual([{ kind: "text", text: "Fixed in abc1234 with tests", href: null }]);
  });
});
