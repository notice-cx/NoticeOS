// Types for journey-port.mjs (beads ro-ujb9.107, ro-ujb9.167), which the TypeScript journey
// files import and the plain-JS flow gate shares.
export declare const JOURNEY_PORT_ENV: "JOURNEY_SUITE_PORT";
export declare const OWNER_PORTS: readonly number[];
export declare function checkedPort(port: number): number;
export declare function freeLoopbackPort(): number;
export declare function pinnedPort(index?: number, env?: Record<string, string | undefined>): number | null;
export declare function journeyOrigin(port: number): string;
