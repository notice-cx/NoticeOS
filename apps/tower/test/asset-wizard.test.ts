// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  type AssetDraft,
  applicableLanes,
  assetIdFromDomain,
  counterIssues,
  countersEntryOp,
  domainIssue,
  emptyDraft,
  planWrites,
  pullEntryOp,
  siteDraft,
  siteNameFromDomain,
  validateDraft,
} from "@shared/asset-wizard";
import type { EntityRow } from "@shared/entities";
import type { SourceSetting } from "@shared/settings";
import { buildChangeset } from "@shared/changeset";
import { configRegister, rowRefusal } from "@shared/config-registers";
import { validateSchemaAndSafety } from "../../../scripts/config-documents.mjs";

// Adding a site's decisions, without a browser (bead `ro-qsoo`; one screen
// since `ro-ujb9.96.7.5`).
//
// This is where "what Add will write" is pinned. The screen renders these
// values and calls two functions with them; if the composition were only
// assertable through a click handler, "a site added in one screen writes what
// the five-step wizard wrote" would be untestable prose.

/** A catalog shaped like `config/integrations.json`'s: two asset lanes, one
 * `both`, and one `portfolio` lane that is the System's and never an asset's. */
const CATALOG: SourceSetting[] = [
  {
    id: "gsc",
    label: "Google Search Console (GSC API)",
    scope: "property",
    layer: "provider",
    credential: "shared",
  },
  {
    id: "ad-network",
    label: "Ad network reporting",
    scope: "property",
    layer: "provider",
    credential: "shared",
  },
  {
    id: "uptime",
    label: "Uptime / monitoring",
    scope: "both",
    layer: "provider",
    credential: "shared",
  },
  {
    id: "discord-webhooks",
    label: "Discord operator-notification webhooks",
    scope: "portfolio",
    layer: "provider",
    credential: "shared",
  },
];

/** The entities a portfolio has declared, as `config/entities.json` holds them
 * (bead `ro-aodz`): one that already owns an asset, and one that owns nothing —
 * which is the row whose first asset is a FIRST write rather than an ordinary
 * one, because it carries no `assets` key at all. */
const ENTITIES: EntityRow[] = [
  { slug: "reindex-ventures", name: "Reindex Ventures LLC", assets: ["nosh.example"] },
  { slug: "second-co", name: "Second Co" },
];

const AT = new Date("2026-09-04T12:00:00.000Z");

function filled(over: Partial<AssetDraft> = {}): AssetDraft {
  return { ...emptyDraft(), displayName: "Meal Planner", domain: "meals.example", ...over };
}

describe("the id is derived from the domain, never typed", () => {
  it("strips everything that is not the host", () => {
    expect(assetIdFromDomain("https://www.Meals.example/api/metrics?x=1")).toBe("meals.example");
    expect(assetIdFromDomain("  nosh.example  ")).toBe("nosh.example");
    expect(assetIdFromDomain("http://pullups.example:8080/")).toBe("pullups.example");
    expect(assetIdFromDomain("areas.example.")).toBe("areas.example");
  });

  it("returns nothing when nothing usable is left", () => {
    expect(assetIdFromDomain("https://")).toBe("");
    expect(assetIdFromDomain("   ")).toBe("");
  });
});

describe("the name is read off the domain, never typed (bead ro-ujb9.96.7.5)", () => {
  it("title-cases the domain's words and keeps a domain hack's ending", () => {
    expect(siteNameFromDomain("journey.example")).toBe("Journey Example");
    expect(siteNameFromDomain("second.example")).toBe("Second Example");
    expect(siteNameFromDomain("tide-tables.cafe")).toBe("Tide Tables Cafe");
    expect(siteNameFromDomain("recipes.example")).toBe("Recipes Example");
  });

  it("drops a generic ending, a two-label public suffix and anything that is not the host", () => {
    expect(siteNameFromDomain("fieldnotes.com")).toBe("Fieldnotes");
    expect(siteNameFromDomain("https://www.second-site.co.uk/pricing")).toBe("Second Site");
    expect(siteNameFromDomain("blog.example.com")).toBe("Blog Example");
  });

  it("answers nothing when the domain leaves no id", () => {
    expect(siteNameFromDomain("https://")).toBe("");
    expect(siteNameFromDomain("   ")).toBe("");
  });
});

describe("a site's draft is the wizard's defaults plus the screen's answers", () => {
  it("changes nothing but the domain, the name and, when asked, the starting stage", () => {
    const draft = siteDraft({ domain: "journey.example", displayName: "Journey Example", prelaunch: false });
    expect(draft).toEqual({ ...emptyDraft(), domain: "journey.example", displayName: "Journey Example" });
    expect(siteDraft({ domain: "journey.example", displayName: "Journey Example", prelaunch: true }).status).toBe("pre-launch");
  });
});

describe("the refusals are short states beside the field that can fix them", () => {
  it("says nothing about an empty domain — Add simply is not offered yet", () => {
    expect(domainIssue("", { existingIds: [] })).toBeNull();
    expect(domainIssue("   ", { existingIds: [] })).toBeNull();
  });

  it("refuses a malformed domain by example", () => {
    expect(domainIssue("not a domain", { existingIds: [] })).toEqual({
      field: "domain",
      message: "Not a domain — like example.com",
    });
    expect(domainIssue("localhost", { existingIds: [] })?.message).toContain("Not a domain");
  });

  it("refuses a domain the portfolio already holds and names the asset to open", () => {
    expect(domainIssue("https://www.Meals.example/", { existingIds: ["meals.example"] })).toEqual({
      field: "domain",
      message: "Already added",
      existing: "meals.example",
    });
  });

  it("the whole draft needs a name and a domain", () => {
    expect(validateDraft(emptyDraft(), { existingIds: [] }).map((issue) => issue.field)).toEqual([
      "displayName",
      "domain",
    ]);
  });

  it("a pull endpoint has to be a URL the OS could fetch", () => {
    const bare = filled({ collection: "pull", pullUrl: "meals.example/metrics" });
    expect(validateDraft(bare, { existingIds: [] })).toEqual([
      { field: "pullUrl", message: "A full https:// URL" },
    ]);
    const full = filled({ collection: "pull", pullUrl: "https://meals.example/metrics" });
    expect(validateDraft(full, { existingIds: [] })).toEqual([]);
    // A push asset is asked for no endpoint at all, so an empty one is not a
    // refusal — it is the field not existing.
    expect(validateDraft(filled(), { existingIds: [] })).toEqual([]);
  });

  it("a total needs both a metric key and a label", () => {
    const issues = counterIssues([{ metric: "", label: "Accounts" }, { metric: "sign ups", label: "" }]);
    expect(issues.map((issue) => issue.field)).toEqual([
      "counter-metric-0",
      "counter-metric-1",
      "counter-label-1",
    ]);
  });

  it("a complete draft refuses nothing", () => {
    expect(validateDraft(filled(), { existingIds: ["nosh.example"] })).toEqual([]);
  });
});

describe("the writes Create will make", () => {
  it.each(["meals.example", "journey.example", "sub.example-site.test"])("produces a changeset the real validator accepts for %s without changing its identity", (domain) => {
    const plan = planWrites(filled({ domain }), CATALOG, ENTITIES, AT);
    expect(plan.id).toBe(domain);
    expect(plan.row.domain).toBe(domain);
    expect(plan.ops[0]?.pointer).toBe(`/assets/${domain}`);
    expect(() => validateSchemaAndSafety(buildChangeset(plan.ops, { slug: plan.slug, createdAt: AT.toISOString() }))).not.toThrow();
  });

  it("names the store row and the config entries, in that order", () => {
    const plan = planWrites(filled(), CATALOG, ENTITIES, AT);

    expect(plan.id).toBe("meals.example");
    expect(plan.slug).toBe("add-asset-meals-example");
    expect(plan.row).toEqual({
      id: "meals.example",
      displayName: "Meal Planner",
      domain: "meals.example",
      status: "onboarding",
      senseOnly: 1,
    });

    // The integrations entry and the panel roster row: a push asset writes no
    // fetch endpoint, and no totals means no counters entry. An op nobody asked
    // for is a file changed for nothing — but the roster is not asked for, it is
    // an invariant (config/signal-panels.README.md: every asset has a row,
    // including the ones that are off, and its validation refuses a roster whose
    // keys differ from config/integrations.json's).
    expect(plan.ops).toEqual([
      {
        kind: "file-json-insert",
        file: "config/integrations.json",
        pointer: "/assets/meals.example",
        value: {
          gsc: { status: "needs-setup", since: "2026-09-04" },
          "ad-network": { status: "needs-setup", since: "2026-09-04" },
          uptime: { status: "needs-setup", since: "2026-09-04" },
        },
      },
      {
        kind: "file-json-insert",
        file: "config/signal-panels.json",
        pointer: "/assets/meals.example",
        value: {
          enabled: false,
          reason: "no-lane-yet",
          since: "2026-09-04",
        },
      },
    ]);
  });

  it("never buys a tracked SERP panel at creation", () => {
    // config/serp-panel.README.md is the opposite rule to the roster's: "an
    // asset with no entry here is skipped silently — no call, no manifest row,
    // no attempt". A panel is a weekly bill AND a weekly review obligation, and
    // that is a decision made from a collection, not from a create form. The
    // DELETE half still knows the file (bead ro-sk7q); only the create does not.
    const plan = planWrites(filled(), CATALOG, ENTITIES, AT);
    expect(plan.ops.map((op) => op.file)).not.toContain("config/serp-panel.json");
  });

  it("asks only about lanes that can apply to an asset", () => {
    expect(applicableLanes(CATALOG).map((lane) => lane.id)).toEqual([
      "gsc",
      "ad-network",
      "uptime",
    ]);
  });

  // ONE SHAPE FOR A DECLINE (bead `ro-ujb9.96.7.22`). Adding a site asks no
  // question about its sources, so every one starts Not set up; a decline is
  // made on its Data sources row, in the one shape a decline has. The
  // wizard's "Skipped at setup: …" second shape is gone with the wizard.
  it("writes every source Not set up, with no setup-time skip", () => {
    const plan = planWrites(siteDraft({ domain: "shop.example.com", displayName: "Example Shop", prelaunch: false }), CATALOG, ENTITIES, AT);
    const entry = plan.ops[0]?.value as Record<string, { status: string; note: string }>;
    expect(Object.values(entry).map((cell) => cell.status)).toEqual(["needs-setup", "needs-setup", "needs-setup"]);
    expect(JSON.stringify(entry)).not.toContain("Skipped at setup");
  });

  // Bead ro-ujb9.96.7.22: a new site's cells carry NO note — never the blank one
  // the `asset-lane` register refuses on every later write — so each cell is a
  // row the register accepts, and passes the per-cell checks of
  // config/integrations.README.md's validation snippet.
  it("writes cells the data-source register accepts, with no blank note", () => {
    const plan = planWrites(siteDraft({ domain: "shop.example.com", displayName: "Example Shop", prelaunch: false }), CATALOG, ENTITIES, AT);
    const entry = plan.ops[0]?.value as Record<string, Record<string, unknown>>;
    const lane = configRegister("asset-lane");
    for (const [id, cell] of Object.entries(entry)) {
      expect(cell, id).toEqual({ status: "needs-setup", since: "2026-09-04" });
      expect(rowRefusal(lane, cell), id).toBeNull();
      // The README snippet's per-cell rules, as it states them.
      expect(["live", "degraded", "needs-setup", "skipped", "not-applicable"]).toContain(cell.status);
      expect(cell.status === "skipped" && !/reason/i.test(String(cell.note))).toBe(false);
      expect(String(cell.since)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // A blank note is still a refusal: absent is the only "nothing said".
    expect(rowRefusal(lane, { status: "needs-setup", note: "", since: "2026-09-04" })).toBe("Reason must not be blank");
  });


  // WHERE THE OWNING ENTITY GOES (bead `ro-aodz`). It was the first sentence of
  // the ad-network source's note, which is where D5 makes it matter and where
  // nobody asking who owns an asset would look. It is now a set on that
  // entity's own list, and every source's note is back to one subject.
  it("puts the owning entity on the entity's own list, and nowhere else", () => {
    const plan = planWrites(filled({ entity: "reindex-ventures" }), CATALOG, ENTITIES, AT);
    const entry = plan.ops[0]?.value as Record<string, { note?: string }>;
    expect(entry["ad-network"]).not.toHaveProperty("note");
    expect(entry.gsc).not.toHaveProperty("note");
    expect(plan.ops.at(-1)).toEqual({
      kind: "file-json-set",
      file: "config/entities.json",
      pointer: "/entities/0/assets",
      expect: ["nosh.example"],
      value: ["nosh.example", "meals.example"],
    });
  });

  // An entity that owns nothing carries no `assets` key at all, and a pointer
  // never creates structure — so its first asset is the one set that says the
  // key was absent, licensed at exactly one place: a declared OPTIONAL field of
  // a row that already exists.
  it("files the first asset of an entity that owns nothing as a first write", () => {
    const plan = planWrites(filled({ entity: "second-co" }), CATALOG, ENTITIES, AT);
    expect(plan.ops.at(-1)).toEqual({
      kind: "file-json-set",
      file: "config/entities.json",
      pointer: "/entities/1/assets",
      expectAbsent: true,
      value: ["meals.example"],
    });
  });

  it("writes no entity op when nobody has said who owns it", () => {
    const plan = planWrites(filled(), CATALOG, ENTITIES, AT);
    expect(plan.ops.map((op) => op.file)).not.toContain("config/entities.json");
  });

  it("adds a counters entry and a fetch endpoint only when they were asked for", () => {
    const plan = planWrites(
      filled({
        collection: "pull",
        pullUrl: " https://meals.example/api/internal/metrics ",
        pullFormat: "prometheus",
        counters: [{ metric: " signups ", label: " Accounts " }],
      }),
      CATALOG,
      ENTITIES,
      AT,
    );

    expect(plan.ops.map((op) => op.file)).toEqual([
      "config/integrations.json",
      "config/signal-panels.json",
      "config/counters.json",
      "config/pull.json",
    ]);
    expect(plan.ops[2]).toMatchObject({
      pointer: "/assets/meals.example",
      value: { cards: [{ metric: "signups", label: "Accounts" }] },
    });
    // RFC 6902's append token, and the entry carries its own `asset` id so a
    // later removal can address it (config/changesets/README.md).
    expect(plan.ops[3]).toEqual({
      kind: "file-json-insert",
      file: "config/pull.json",
      pointer: "/-",
      value: {
        asset: "meals.example",
        url: "https://meals.example/api/internal/metrics",
        enabled: true,
        format: "prometheus",
      },
    });
  });

  // THE SAME WRITE PATH (bead `ro-ujb9.96.7.5`). A site added in one screen is
  // composed by the same `planWrites` from the wizard's own defaults, so it
  // writes exactly the row and the changeset the wizard wrote when its three
  // default screens were clicked through — nothing added, nothing dropped.
  it("writes for a one-screen site exactly what the wizard wrote from its defaults", () => {
    const oneScreen = planWrites(
      siteDraft({ domain: "journey.example", displayName: "Journey Example", prelaunch: false }),
      CATALOG,
      ENTITIES,
      AT,
    );
    const wizardDefaults = planWrites(
      { ...emptyDraft(), domain: "journey.example", displayName: "Journey Example" },
      CATALOG,
      ENTITIES,
      AT,
    );
    expect(oneScreen).toEqual(wizardDefaults);
    expect(oneScreen.row).toEqual({
      id: "journey.example",
      displayName: "Journey Example",
      domain: "journey.example",
      status: "onboarding",
      senseOnly: 1,
    });
    expect(oneScreen.ops.map((op) => op.file)).toEqual(["config/integrations.json", "config/signal-panels.json"]);
    expect(() => validateSchemaAndSafety(buildChangeset(oneScreen.ops, { slug: oneScreen.slug, createdAt: AT.toISOString() }))).not.toThrow();
  });

  it("starts a site that has not launched in pre-launch, and changes nothing else", () => {
    const launched = planWrites(siteDraft({ domain: "journey.example", displayName: "J", prelaunch: false }), CATALOG, ENTITIES, AT);
    const waiting = planWrites(siteDraft({ domain: "journey.example", displayName: "J", prelaunch: true }), CATALOG, ENTITIES, AT);
    expect(waiting.row.status).toBe("pre-launch");
    expect(waiting.ops).toEqual(launched.ops);
  });

  it("the Settings tab adds totals and an endpoint with the very ops Add would have sent", () => {
    const plan = planWrites(
      filled({ collection: "pull", pullUrl: "https://nosh.example/api/admin/overview", counters: [{ metric: "signups", label: "Accounts" }] }),
      CATALOG,
      ENTITIES,
      AT,
    );
    expect(plan.ops).toContainEqual(countersEntryOp("meals.example", [{ metric: "signups", label: "Accounts" }]));
    expect(plan.ops).toContainEqual(pullEntryOp("meals.example", "https://nosh.example/api/admin/overview", "envelope"));
    expect(countersEntryOp("meals.example", [{ metric: " ", label: "" }])).toBeNull();
  });
});
