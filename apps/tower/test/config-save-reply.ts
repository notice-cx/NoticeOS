import type { ConfigSaveResult } from "@/lib/api";

/** A successful store save acknowledges every operation in the request. */
export function configSaveReply(
  init: RequestInit | undefined,
  receipt: Pick<ConfigSaveResult, "archive" | "commit"> = { archive: null, commit: null },
): ConfigSaveResult {
  const request: unknown = JSON.parse(String(init?.body));
  if (typeof request !== "object" || request === null || !("ops" in request) || !Array.isArray(request.ops)) {
    throw new Error("The config-save fixture needs an operation request.");
  }
  return { applied: request.ops.length, ...receipt };
}
