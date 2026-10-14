// Types for rewritten-read.mjs, which the TypeScript journeys import and the
// plain-JS flow gate shares.
import type { APIResponse, Route } from "@playwright/test";
export function fetchToRewrite(route: Route): Promise<{ response: APIResponse; headers: Record<string, string> }>;
