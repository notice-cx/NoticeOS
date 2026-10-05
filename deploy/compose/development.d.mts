export const DEPENDENCY_PATHS: string[];
export function dependencyDescription(root: string): unknown;
export function developmentDependencies(options?: {source?: string;image?: string;metadataFile?: string|null}): unknown;
export function prepareDevelopmentWorkerConfigs(options?: {source?: string;home?: string}): string;
