import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { taskProjectSetupHub } from "../vite/task-project-setup";

const legacy = { host: "127.0.0.1", port: 3308, user: "root", dataDir: ".fixture-hub" };

describe("local task project setup", () => {
  it("reads only a declared profile and quotes the nonsecret host paths", () => {
    const own = fs.mkdtempSync(path.join(os.tmpdir(), "task-setup-'owned-"));
    try {
      const home = path.join(own, "home");
      fs.mkdirSync(path.join(home, "dolt"), { recursive: true });
      const profile = { project: "noticeos-start-0123456789abcdef", composeFile: path.join(own, "compose.yaml"),
        secretsDir: path.join(home, "dolt", "secrets"), credentialsFile: path.join(home, "dolt", "credentials"), port: 5603 };
      fs.writeFileSync(path.join(home, "dolt", "profile.json"), JSON.stringify(profile));
      const hub = taskProjectSetupHub("serve", legacy, { home, repoRoot: own, node: "/fixture/node" });
      expect(hub).toMatchObject({ host: "127.0.0.1", port: 5603, user: "noticeos", dataDir: path.join(home, "dolt") });
      expect(hub?.initCommand).toBe(`'/fixture/node' '${own.replaceAll("'", "'\\''")}/scripts/dolt-project.mjs' --home '${home.replaceAll("'", "'\\''")}'`);
      // No credentials file exists: setup renders without reading a password.
      fs.writeFileSync(path.join(home, "dolt", "profile.json"), "invalid");
      expect(() => taskProjectSetupHub("serve", legacy, { home, repoRoot: own })).toThrow();
      // Hosted compilation never reads even this malformed host profile.
      expect(taskProjectSetupHub("build", legacy, { home, repoRoot: own })).toBeNull();
    } finally { fs.rmSync(own, { recursive: true, force: true }); }
  });

  it("keeps legacy setup when no explicit profile is declared", () => {
    expect(taskProjectSetupHub("serve", legacy, { repoRoot: "/fixture/repo" })).toBe(legacy);
    expect(taskProjectSetupHub("build", legacy, { repoRoot: "/fixture/repo" })).toBeNull();
  });
});
