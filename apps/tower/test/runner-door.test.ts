// @vitest-environment node
// The LAN boundary, at the unit level. One workerd runtime serves both
// Workers, so the ingest has no listener of its own and the Tower's listener
// is on the LAN. What keeps the ingest's unauthenticated scheduled trigger off
// the LAN is the loopback door plus the guard below, and every way a LAN
// request could try to look like a door request has a case here.

import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DOOR_HOST,
  DEFAULT_DOOR_PORT,
  doorHostFromEnv,
  doorPortFromEnv,
  runnerGuard,
  serveDoorRequest,
} from "../vite/runner-door";
import {
  RUNNER_DOOR_HEADER,
  RUNNER_DOOR_HEADER_VALUE,
  RUNNER_INGEST_PREFIX,
  RUNNER_SCHEDULED_PATH,
  isLoopbackAddress,
  runnerDoorTarget,
  runnerTarget,
} from "../shared/runner-lane";

type FakeReq = {
  url: string;
  headers: Record<string, string | undefined>;
  rawHeaders: string[];
  socket?: { remoteAddress?: string };
};

/**
 * A fake request carries both header representations, because the real one
 * does and only one of them is the wire: the Cloudflare plugin builds the
 * Worker's `Request` from `rawHeaders`, so a guard that edited only the map
 * would stamp nothing the Worker could see and strip nothing an attacker sent.
 */
function req(url: string, headers: Record<string, string> = {}, remoteAddress = "127.0.0.1"): FakeReq {
  const rawHeaders: string[] = [];
  for (const [name, value] of Object.entries(headers)) rawHeaders.push(name, value);
  return { url, headers: { ...headers }, rawHeaders, socket: { remoteAddress } };
}

/** What the Cloudflare plugin will actually send to workerd: `rawHeaders`,
 * read as pairs. Assertions go through this, never through `req.headers`. */
function wireHeader(r: FakeReq, name: string): string | undefined {
  for (let i = 0; i < r.rawHeaders.length; i += 2) {
    if (r.rawHeaders[i]?.toLowerCase() === name) return r.rawHeaders[i + 1];
  }
  return undefined;
}

function res() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: "",
    ended: false,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    end(chunk?: string) {
      this.body = chunk ?? "";
      this.ended = true;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The guard on the shared middleware stack.
// ─────────────────────────────────────────────────────────────────────────────

describe("the runner guard", () => {
  it("lets every non-runner path through untouched", () => {
    const guard = runnerGuard();
    const next = vi.fn();
    const r = req("/api/wall");
    guard(r as unknown as IncomingMessage, res() as unknown as ServerResponse, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("refuses a runner path that did not arrive on the loopback door", () => {
    const guard = runnerGuard();
    const next = vi.fn();
    const response = res();
    guard(
      req(`${RUNNER_SCHEDULED_PATH}?cron=*/15 * * * *`) as unknown as IncomingMessage,
      response as unknown as ServerResponse,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: "runner_lane_loopback_only" });
  });

  // The Cloudflare plugin serves /cdn-cgi/handler/* unconditionally and the
  // Tower binds the LAN, so the guard refuses every trigger path outright.
  // Door requests never present these paths: the door rewrites them first.
  it("refuses the plugin's trigger paths from anywhere — the door rewrites, so these are always foreign", () => {
    const guard = runnerGuard();
    for (const path of ["/cdn-cgi/handler/scheduled?cron=* * * * *", "/cdn-cgi/handler/email", "/cdn-cgi/mf/scheduled"]) {
      const next = vi.fn();
      const response = res();
      guard(req(path, {}, "192.168.2.44") as unknown as IncomingMessage, response as unknown as ServerResponse, next);
      expect(next).not.toHaveBeenCalled();
      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body)).toEqual({ error: "runner_lane_loopback_only" });
    }
  });

  // A LAN client may send the header, so the header is deleted from every
  // request before the door mark is consulted.
  it("strips a forged door header off a LAN request — from the wire, not just the map", () => {
    const guard = runnerGuard();
    const next = vi.fn();
    const r = req(RUNNER_SCHEDULED_PATH, { [RUNNER_DOOR_HEADER]: RUNNER_DOOR_HEADER_VALUE }, "192.168.2.44");
    const response = res();
    guard(r as unknown as IncomingMessage, response as unknown as ServerResponse, next);
    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(403);
    expect(r.headers[RUNNER_DOOR_HEADER]).toBeUndefined();
    expect(wireHeader(r, RUNNER_DOOR_HEADER)).toBeUndefined();
  });

  it("strips a forged header sent under a different casing", () => {
    const guard = runnerGuard();
    const next = vi.fn();
    const r = req(RUNNER_SCHEDULED_PATH, {}, "192.168.2.44");
    // Node lowercases `headers` but leaves `rawHeaders` exactly as sent, so a
    // capitalised forgery is only visible on the wire.
    r.rawHeaders.push("X-NoticeOS-Runner-Door", "1");
    guard(r as unknown as IncomingMessage, res() as unknown as ServerResponse, next);
    expect(wireHeader(r, RUNNER_DOOR_HEADER)).toBeUndefined();
  });

  it("stamps the door mark ON THE WIRE for a request the door itself created", () => {
    const guard = runnerGuard();
    const next = vi.fn();
    const r = req("/anything");
    const response = res();

    // Through the door first: that is the only way the mark is set.
    serveDoorRequest(
      r as unknown as IncomingMessage,
      response as unknown as ServerResponse,
      (inner) => guard(inner, response as unknown as ServerResponse, next),
    );

    expect(next).toHaveBeenCalledOnce();
    expect(r.headers[RUNNER_DOOR_HEADER]).toBe(RUNNER_DOOR_HEADER_VALUE);
    // The plugin reads `rawHeaders`, so a mark that exists only in the map is no mark.
    expect(wireHeader(r, RUNNER_DOOR_HEADER)).toBe(RUNNER_DOOR_HEADER_VALUE);
  });

  it("re-stamps rather than trusts: a door request carrying junk still ends up canonical", () => {
    const guard = runnerGuard();
    const next = vi.fn();
    const r = req("/healthz", { [RUNNER_DOOR_HEADER]: "not-the-value" });
    const response = res();
    serveDoorRequest(
      r as unknown as IncomingMessage,
      response as unknown as ServerResponse,
      (inner) => guard(inner, response as unknown as ServerResponse, next),
    );
    expect(next).toHaveBeenCalledOnce();
    expect(r.headers[RUNNER_DOOR_HEADER]).toBe(RUNNER_DOOR_HEADER_VALUE);
    // Exactly one, and it is ours: a stale pair left beside the canonical one
    // would leave the Worker reading a comma-joined value.
    expect(r.rawHeaders.filter((h) => h.toLowerCase() === RUNNER_DOOR_HEADER)).toHaveLength(1);
    expect(wireHeader(r, RUNNER_DOOR_HEADER)).toBe(RUNNER_DOOR_HEADER_VALUE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The door itself.
// ─────────────────────────────────────────────────────────────────────────────

describe("the ingest door", () => {
  it("refuses a non-loopback peer even though the bind address already should have", () => {
    const response = res();
    const forwarded = vi.fn();
    serveDoorRequest(
      req("/healthz", {}, "192.168.2.44") as unknown as IncomingMessage,
      response as unknown as ServerResponse,
      forwarded,
    );
    expect(forwarded).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(403);
  });

  it("rewrites a cron fire to the Tower's scheduled lane, query intact", () => {
    const r = req("/cdn-cgi/handler/scheduled?cron=%2A%2F15%20%2A%20%2A%20%2A%20%2A");
    serveDoorRequest(r as unknown as IncomingMessage, res() as unknown as ServerResponse, () => {});
    expect(r.url).toBe(`${RUNNER_SCHEDULED_PATH}?cron=%2A%2F15%20%2A%20%2A%20%2A%20%2A`);
  });

  it("proxies ordinary ingest paths verbatim", () => {
    const r = req("/api/pulse");
    serveDoorRequest(r as unknown as IncomingMessage, res() as unknown as ServerResponse, () => {});
    expect(r.url).toBe(`${RUNNER_INGEST_PREFIX}/api/pulse`);
  });

  it("keeps native D1 backup requests on the authenticated Tower receiver", () => {
    const url = "/api/backup/cloudflare-d1?view=artifact&runId=fixture";
    const r = req(url);
    serveDoorRequest(r as unknown as IncomingMessage, res() as unknown as ServerResponse, () => {});
    expect(r.url).toBe(url);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Path vocabulary: the sentences `scripts/os-up.mjs`, `scripts/pulse-relay.mjs`
// and workers/ingest/README.md speak.
// ─────────────────────────────────────────────────────────────────────────────

describe("door path rewriting", () => {
  it.each([
    ["/cdn-cgi/handler/scheduled?cron=0+*+*+*+*", `${RUNNER_SCHEDULED_PATH}?cron=0+*+*+*+*`],
    ["/cdn-cgi/mf/scheduled?cron=0+*+*+*+*", `${RUNNER_SCHEDULED_PATH}?cron=0+*+*+*+*`],
    ["/__scheduled?cron=0+*+*+*+*", `${RUNNER_SCHEDULED_PATH}?cron=0+*+*+*+*`],
    ["/healthz", `${RUNNER_INGEST_PREFIX}/healthz`],
    ["/api/beads-snapshot", `${RUNNER_INGEST_PREFIX}/api/beads-snapshot`],
    ["/api/backup/cloudflare-d1", "/api/backup/cloudflare-d1"],
    ["/api/backup/cloudflare-d1?view=artifact", "/api/backup/cloudflare-d1?view=artifact"],
    ["/api/backup/cloudflare-d1/other", `${RUNNER_INGEST_PREFIX}/api/backup/cloudflare-d1/other`],
    ["/api/serp-panel-landings?asset=nom", `${RUNNER_INGEST_PREFIX}/api/serp-panel-landings?asset=nom`],
    // The door is the ingest's address, not a second front door for the
    // Tower: `/` gets the ingest's own 404, never the SPA.
    ["/", `${RUNNER_INGEST_PREFIX}/`],
    // A path that is already a runner path is left alone: prefixing it again
    // would ask the ingest for `/api/runner/scheduled` and get its 404.
    [RUNNER_SCHEDULED_PATH, RUNNER_SCHEDULED_PATH],
    [`${RUNNER_SCHEDULED_PATH}?cron=0+*+*+*+*`, `${RUNNER_SCHEDULED_PATH}?cron=0+*+*+*+*`],
    [`${RUNNER_INGEST_PREFIX}/healthz`, `${RUNNER_INGEST_PREFIX}/healthz`],
  ])("maps %s to %s", (from, to) => {
    expect(runnerDoorTarget(from)).toBe(to);
  });
});

describe("runner target parsing", () => {
  it("reads the scheduled lane", () => {
    expect(runnerTarget(RUNNER_SCHEDULED_PATH)).toEqual({ kind: "scheduled" });
  });

  it("reads a proxied ingest path back out", () => {
    expect(runnerTarget(`${RUNNER_INGEST_PREFIX}/api/pulse`)).toEqual({
      kind: "ingest",
      path: "/api/pulse",
    });
  });

  it("refuses a runner path that is neither", () => {
    expect(runnerTarget("/api/runner/")).toBeNull();
    expect(runnerTarget("/api/runner/whatever")).toBeNull();
    expect(runnerTarget("/api/runner/ingestible")).toBeNull();
  });
});

describe("loopback recognition", () => {
  it.each(["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1", "::FFFF:127.0.0.1"])(
    "%s is loopback",
    (address) => {
      expect(isLoopbackAddress(address)).toBe(true);
    },
  );

  it.each(["192.168.2.44", "10.0.0.1", "::ffff:192.168.2.44", "fe80::1%en0", "", undefined])(
    "%s is not loopback",
    (address) => {
      expect(isLoopbackAddress(address)).toBe(false);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// The port is os:up's config, passed in.
// ─────────────────────────────────────────────────────────────────────────────

describe("door address resolution", () => {
  it("falls back to the pinned defaults for a bare `pnpm dev`", () => {
    expect(doorPortFromEnv({})).toBe(DEFAULT_DOOR_PORT);
    expect(doorHostFromEnv({})).toBe(DEFAULT_DOOR_HOST);
  });

  it("takes what the runner passes", () => {
    expect(doorPortFromEnv({ OS_UP_INGEST_DOOR_PORT: "9999" })).toBe(9999);
    expect(doorHostFromEnv({ OS_UP_INGEST_DOOR_HOST: "127.0.0.2" })).toBe("127.0.0.2");
  });

  it("refuses a port that is not one, rather than silently binding the default", () => {
    expect(() => doorPortFromEnv({ OS_UP_INGEST_DOOR_PORT: "nope" })).toThrow(/TCP port/);
    expect(() => doorPortFromEnv({ OS_UP_INGEST_DOOR_PORT: "70000" })).toThrow(/TCP port/);
  });
});
