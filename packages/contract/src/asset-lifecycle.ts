import type { AssetStatus } from "./configuration.mjs";

/** A launch hold and retirement are decisions; every active stage is observed.
 * Historical active-stage assignments carry no collection evidence. */
export function assetLifecycleStatus(storedStatus: string, hasCollectedData: boolean): AssetStatus {
  if (storedStatus === "retired" || storedStatus === "pre-launch") return storedStatus;
  return hasCollectedData ? "live" : "onboarding";
}

/** Legacy active values may be restored by Undo, but cannot assign progress
 * to a monitored site. Their displayed stage is always derived again. */
export function canSetLifecycleControl(current: string, target: string): boolean {
  return target === current || target === "retired" || target === "pre-launch"
    || current === "retired" || current === "pre-launch";
}

/** Active control values only mean monitoring is enabled, never a stage. */
export function lifecycleControlValue(target: string): AssetStatus {
  return target === "retired" || target === "pre-launch" ? target : "onboarding";
}
