// ONE WAY TO START THE ISOLATED JOURNEY SERVER (bead ro-ujb9.167).
//
// Three runners start server.mjs: every Playwright worker starts its own
// (journey-test.ts), every flow-gate lane its own (flow-gate.mjs), and the
// HTTP harness test one (harness.test.mjs). They all start it here, the same
// way, so no runner can start it with less isolation than another:
//
//   - a loopback port that is never an owner port (journey-port.mjs): a free
//     one from the OS, or one the caller pinned;
//   - an environment holding PATH, that port and the run's throwaway Postgres
//     (JOURNEY_POSTGRES, below) only — no other URL, no secrets, nothing
//     else inherited from the shell that ran the tests;
//   - ready only once the server has printed that its isolation guard is armed
//     and that it listens;
//   - its output kept, so the runner fails on any JOURNEY_ISOLATION_VIOLATION
//     line the guard prints;
//   - an IPC channel the server watches, so a runner that dies without
//     stopping it (a killed Playwright worker) never leaves it holding a port;
//   - a stop that fails the run unless the server exits 0 (bead ro-ujb9.192):
//     a server that crashed at its SIGTERM, or never exited and had to be
//     killed, is a broken fixture, not a detail of its teardown.

import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startTestCluster } from "../../../scripts/postgres-test-cluster.mjs";
import { HANDLER_FAILURE_MARK } from "./handler-failure.mjs";
import { ARMED_MARK, VIOLATION_MARK } from "./isolation-guard.mjs";
import { checkedPort, freeLoopbackPort, journeyOrigin } from "./journey-port.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READY_MARK = "Isolated journey server:";
/** Vite's refusal when another process took the port between the ask and the bind. */
const PORT_TAKEN = /already in use|EADDRINUSE/iu;
const MAX_SERVERS = 16;
/** How long a stopped server may take to exit: its close waits up to a minute
 * for Vite's dependency optimizer (scripts/test-vite-server.mts). */
const STOP_TIMEOUT_MS = 90_000;

/**
 * Where a server finds the run's throwaway Postgres (epic ro-ujb9.76): the
 * cluster's handle (scripts/postgres-test-copies.mts) as JSON — the
 * application role's address, with a password made for this run, and the copy
 * service each server asks for its own copies. The owner's way in stays with
 * whoever started the cluster.
 */
export const JOURNEY_POSTGRES = "NOTICEOS_JOURNEY_POSTGRES";
let ownCluster = null;

/**
 * The run's throwaway Postgres: the one Playwright's global setup started for
 * the whole run (postgres-global-setup.mjs), or else one this process starts
 * on first use and stops when it exits.
 */
export async function journeyPostgres(env = process.env) {
  if (env[JOURNEY_POSTGRES]) return JSON.parse(env[JOURNEY_POSTGRES]);
  ownCluster ??= startTestCluster();
  return (await ownCluster).handle;
}

/**
 * How many fixture servers a run keeps at once, each driven by its own
 * browser: `JOURNEY_WORKERS` when set (CI's override), otherwise half this
 * machine's cores, at most 4, so the live OS on the same machine keeps room.
 */
export function parallelServers(env = process.env, cores = os.availableParallelism()) {
  if (env.JOURNEY_WORKERS) {
    const count = Number(env.JOURNEY_WORKERS);
    if (!Number.isInteger(count) || count < 1 || count > MAX_SERVERS) {
      throw new Error(`JOURNEY_WORKERS must be a whole number from 1 to ${MAX_SERVERS}, not ${JSON.stringify(env.JOURNEY_WORKERS)}`);
    }
    return count;
  }
  return Math.max(1, Math.min(4, Math.floor(cores / 2)));
}

/**
 * Start server.mjs on `port` (a free loopback port when null) and resolve once
 * it listens. A free port another process took first is asked for again, twice
 * at most; a pinned port is never swapped for another.
 */
export async function startFixtureServer({ port = null, timeoutMs = 60_000 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await launch(port === null ? freeLoopbackPort() : checkedPort(port), timeoutMs);
    } catch (error) {
      if (port !== null || attempt >= 3 || !PORT_TAKEN.test(String(error?.message))) throw error;
    }
  }
}

async function launch(port, timeoutMs) {
  const postgres = await journeyPostgres();
  const child = spawn(process.execPath, [path.join(HERE, "server.mjs")], {
    cwd: path.resolve(HERE, ".."),
    env: { PATH: process.env.PATH, JOURNEY_PORT: String(port), [JOURNEY_POSTGRES]: JSON.stringify(postgres) },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  // The channel is only a lifeline for the server; it never keeps a runner alive.
  child.channel?.unref();
  let output = "";
  const read = (chunk) => { output += chunk; };
  child.stdout.on("data", read);
  child.stderr.on("data", read);
  // SIGTERM, then SIGKILL if it has not exited in time. Resolves true when it
  // had to be killed.
  let halting;
  const halt = () => (halting ??= (async () => {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    let timer;
    const hung = await Promise.race([
      exited.then(() => false),
      new Promise((resolve) => { timer = setTimeout(() => resolve(true), STOP_TIMEOUT_MS); }),
    ]);
    clearTimeout(timer);
    if (hung) {
      child.kill("SIGKILL");
      await exited;
    }
    return hung;
  })());
  const stop = async () => {
    const tail = () => output.slice(-2000);
    if (await halt()) throw new Error(`the fixture server on port ${port} had not exited ${STOP_TIMEOUT_MS / 1000}s after SIGTERM and was killed:\n${tail()}`);
    if (child.exitCode !== 0) {
      throw new Error(`the fixture server on port ${port} ended with ${child.signalCode ?? `exit code ${child.exitCode}`}, not a clean exit:\n${tail()}`);
    }
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new Error(`the fixture server did not start in ${timeoutMs / 1000}s:\n${output}`)), timeoutMs);
      const exited = (code) => done(new Error(`the fixture server exited ${code}:\n${output}`));
      const ready = () => { if (output.includes(READY_MARK)) done(); };
      function done(error) {
        clearTimeout(timer);
        child.off("exit", exited);
        child.stdout.off("data", ready);
        child.stderr.off("data", ready);
        if (error) reject(error); else resolve();
      }
      child.once("exit", exited);
      child.stdout.on("data", ready);
      child.stderr.on("data", ready);
    });
    if (!output.includes(ARMED_MARK)) throw new Error(`the fixture server started without its isolation guard:\n${output}`);
  } catch (error) {
    // A server that never started: the start's own error is the one to see.
    await halt();
    throw error;
  }
  return {
    port,
    origin: journeyOrigin(port),
    child,
    /** Everything the server has printed so far. */
    output: () => output,
    /** The isolation guard's refusals printed since `from` (an earlier `output().length`). */
    violations: (from = 0) => output.slice(from).split("\n").filter((line) => line.includes(VIOLATION_MARK)),
    /** Why each handler that failed since `from` failed, in the server's own
     * words, with no address or password (handler-failure.mjs). */
    failures: (from = 0) => output.slice(from).split("\n").filter((line) => line.includes(HANDLER_FAILURE_MARK)),
    stop,
  };
}
