// Types for fixture-server.mjs (bead ro-ujb9.167), which the TypeScript journey
// fixture imports and the plain-JS flow gate and harness test share.
import type { ChildProcess } from "node:child_process";
import type { TestClusterHandle } from "../../../scripts/postgres-test-copies.mjs";

export interface FixtureServer {
  readonly port: number;
  readonly origin: string;
  readonly child: ChildProcess;
  output(): string;
  violations(from?: number): string[];
  /** Why each handler that failed since `from` failed (bead ro-ujb9.76.56). */
  failures(from?: number): string[];
  /** Rejects unless the server exits 0 (bead ro-ujb9.192). */
  stop(): Promise<void>;
}

export declare const JOURNEY_POSTGRES: "NOTICEOS_JOURNEY_POSTGRES";
export declare function journeyPostgres(env?: Record<string, string | undefined>): Promise<TestClusterHandle>;
export declare function parallelServers(env?: Record<string, string | undefined>, cores?: number): number;
export declare function startFixtureServer(options?: { port?: number | null; timeoutMs?: number }): Promise<FixtureServer>;
