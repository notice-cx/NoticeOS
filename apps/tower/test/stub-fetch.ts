// A fetch that answers every request with one JSON body (issue #21).
import { vi } from "vitest";

/** Answer every fetch with `body` as 200 JSON, until `vi.unstubAllGlobals()`. */
export function stubJsonFetch(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}
