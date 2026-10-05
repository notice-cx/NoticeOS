import type { SourceVersion } from '../apps/tower/shared/source-version.js';

export declare function gitSourceVersion(root: string, options?: {declared?: boolean}): SourceVersion | null;
export declare function sourceVersion(root: string): SourceVersion | null;
