// Direct site fixtures retain identity, metadata, insertion order and isolation.
import { describe, expect, it } from "vitest";
import { createTestStore, postgresUnavailable } from "./postgres-store";
import { readSite, readSites } from "../worker/asset-registry";
import { addSites } from "./sites";
import { seedAssets } from "./invented-sites";
import INVENTED from "../../../db/fixtures/invented-sites.json";

describe.skipIf(postgresUnavailable() !== null)("direct Postgres site fixtures", () => {
  it("keeps rows added after a reader's first call in the same copy", async () => {
    const fixture = await createTestStore();
    const store = fixture.call;
    await addSites(fixture, [{ id: "z.example", displayName: "Z", status: "live", senseOnly: 0 }]);
    expect((await readSites(store)).map((site) => site.id)).toEqual(["z.example"]);
    await addSites(fixture, [{ id: "a.example", domain: null, displayName: "A", status: "pre-launch" }]);
    expect((await readSites(store)).map((site) => site.id)).toEqual(["z.example", "a.example"]);
    expect(await readSite(store, "a.example")).toMatchObject({ domain: null, status: "pre-launch", senseOnly: 1 });
  });

  it("keeps separate fixture copies isolated, even after closing one", async () => {
    const first = await createTestStore();
    const second = await createTestStore();
    await addSites(first, [{ id: "os.example", displayName: "OS", status: "live", isOs: 1 }]);
    expect(await readSite(first.call, "os.example")).toMatchObject({ isOs: 1 });
    expect(await readSites(second.call)).toEqual([]);
    await first.close();
    await first.close();
    const third = await createTestStore();
    expect(await readSites(third.call)).toEqual([]);
  });

  it("takes all six sample rows directly from the invented metadata", async () => {
    const fixture = await createTestStore();
    await seedAssets(fixture);
    const expected = [INVENTED.os, ...INVENTED.sites.slice(0, 5)];
    expect(await readSites(fixture.call)).toEqual(expected);
  });
});
