// Types for offline-guard.mjs (bead ro-o3hv), which the TypeScript journeys
// import and the plain-JS flow gate shares.
import type { BrowserContext } from "@playwright/test";
export interface OfflineGuard {
  escapes(): string[];
  check(): string | null;
  clear(): void;
  close(): Promise<void>;
}
export interface OfflineProxy {
  proxy: { server: string; bypass: string };
  escapes(): string[];
  failed(): boolean;
  clear(): void;
  close(): Promise<void>;
}
export declare function startOfflineProxy(origin: string): Promise<OfflineProxy>;
export declare function installOfflineGuard(context: BrowserContext, origin: string, options: { transport: OfflineProxy }): Promise<OfflineGuard>;
