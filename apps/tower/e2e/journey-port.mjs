// ONE PLACE FOR THE JOURNEY FIXTURES' PORTS (beads ro-ujb9.107, ro-ujb9.167).
//
// The journeys used to bind 127.0.0.1:4188 on every run, so two runs on one
// machine (two worktrees verifying two branches) failed at once with "already
// used". Now every fixture server a run starts — one per Playwright worker
// (journey-test.ts), one per flow-gate lane (flow-gate.mjs), one for the
// harness test — binds a loopback port the OS reports free, and each runner
// hands its own server's origin to the browser it drives, so no two servers,
// runs or worktrees ever share a port or a store. JOURNEY_SUITE_PORT pins the
// Playwright workers' ports instead (worker 0 takes it, worker 1 the next…).
//
// Owner ports stay refused whatever the environment says: this suite never
// attaches to the managed Tower (5173), the ingest door (8791) or the task hub
// (3308), and it never takes a URL — only a port on 127.0.0.1.

import { execFileSync } from "node:child_process";

/** The variable a run pins its first port in. Set it yourself to choose them. */
export const JOURNEY_PORT_ENV = "JOURNEY_SUITE_PORT";
export const OWNER_PORTS = Object.freeze([5173, 8791, 3308]);

/** `port` if a journey fixture may bind it; throws otherwise. */
export function checkedPort(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || OWNER_PORTS.includes(port)) {
    throw new Error(`Unsafe journey port ${port}: a journey binds a loopback port above 1023 and never an owner port (${OWNER_PORTS.join(", ")})`);
  }
  return port;
}

/** A loopback port the OS reports free right now. Synchronous, so any
 * runner can take one wherever it needs it. */
export function freeLoopbackPort() {
  const source = "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});";
  return checkedPort(Number(execFileSync(process.execPath, ["-e", source], { encoding: "utf8" }).trim()));
}

/** The port the `index`th server of a run binds when the run pins its first
 * one in JOURNEY_SUITE_PORT, or null: the server takes a free one. */
export function pinnedPort(index = 0, env = process.env) {
  if (!env[JOURNEY_PORT_ENV]) return null;
  return checkedPort(Number(env[JOURNEY_PORT_ENV]) + index);
}

/** The only origin a journey browser may reach. */
export function journeyOrigin(port) {
  return `http://127.0.0.1:${checkedPort(port)}`;
}
