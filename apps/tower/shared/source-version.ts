export interface SourceVersion {
  commit: string;
  committedAt: string;
  modified: boolean;
}

declare const __NOTICEOS_SOURCE_VERSION__: SourceVersion | null | undefined;
declare const __NOTICEOS_LIVE_SOURCE__: boolean | undefined;

export function compiledLiveSource(): boolean {
  return typeof __NOTICEOS_LIVE_SOURCE__ !== 'undefined' && __NOTICEOS_LIVE_SOURCE__ === true;
}

/** Compiled from the served source, independent of the dashboard's workspace. */
export function compiledSourceVersion(): SourceVersion | null {
  return typeof __NOTICEOS_SOURCE_VERSION__ === 'undefined' ? null : __NOTICEOS_SOURCE_VERSION__;
}
