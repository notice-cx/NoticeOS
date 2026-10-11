import { describe, expect, it } from "vitest";
import { installationCommand, updateState } from "@shared/installation";
import { createInstallationHandler, hostFacts } from "../vite/installation-lane";

const get = { method: "GET", headers: {}, body: "", url: "/api/installation" };
const host = { NOTICEOS_HOST_FOLDER: "/srv/noticeos", NOTICEOS_HOST_TOWER_ADDRESS: "0.0.0.0", NOTICEOS_HOST_TOWER_PORT: "5180",
  NOTICEOS_HOST_POSTGRES_PORT: "5432", NOTICEOS_HOST_TASK_PORT: "3307", NOTICEOS_HOST_LAUNCHER: "/srv/noticeos/noticeos" };

describe("/api/installation", () => {
  it("reads the host's facts the stack hands the app, and nothing it was not told", () => {
    expect(hostFacts(host)).toEqual({ folder: "/srv/noticeos", tower: { address: "0.0.0.0", port: 5180 }, postgresPort: 5432, taskPort: 3307, launcher: "/srv/noticeos/noticeos" });
    expect(hostFacts({})).toEqual({ folder: null, tower: null, postgresPort: null, taskPort: null, launcher: null });
    expect(hostFacts({ NOTICEOS_HOST_TOWER_PORT: "5173", NOTICEOS_HOST_TASK_PORT: "not a port" })).toMatchObject({ tower: { address: "127.0.0.1", port: 5173 }, taskPort: null });
  });

  it("asks the registry at most once an hour, and never for a checkout's live source", async () => {
    let asked = 0;
    let at = 0;
    const handle = createInstallationHandler({ commit: "a".repeat(40), live: false, env: host, now: () => at, published: async () => { asked += 1; return "b".repeat(40); } });
    const first = await handle(get);
    expect(first).toEqual({ status: 200, body: { ...hostFacts(host), commit: "a".repeat(40), live: false, published: "b".repeat(40) } });
    at = 59 * 60_000;
    await handle(get);
    expect(asked).toBe(1);
    at = 60 * 60_000;
    await handle(get);
    expect(asked).toBe(2);
    const live = createInstallationHandler({ commit: "a".repeat(40), live: true, env: host, published: async () => { throw new Error("the registry was asked"); } });
    expect((await live(get)).body).toMatchObject({ live: true, published: null });
    expect((await live({ ...get, method: "POST" })).status).toBe(405);
  });
});

describe("the installation's update state and commands", () => {
  it("says current only when the app runs the newest published commit, and unknown when either is unknown", () => {
    expect(updateState({ commit: "a", live: false, published: "a" })).toBe("current");
    expect(updateState({ commit: "a", live: false, published: "b" })).toBe("available");
    expect(updateState({ commit: null, live: false, published: "b" })).toBe("unknown");
    expect(updateState({ commit: "a", live: false, published: null })).toBe("unknown");
    expect(updateState({ commit: "a", live: true, published: "b" })).toBe("live");
  });

  it("names the launcher an installation without a checkout has, and pnpm os:* otherwise", () => {
    expect(installationCommand({ launcher: "/srv/noticeos/noticeos" }, "update")).toBe("/srv/noticeos/noticeos update");
    expect(installationCommand({ launcher: null }, "update")).toBe("pnpm os:update");
  });
});
