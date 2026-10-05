// GET /api/calendar/upcoming — the Wall's next-meetings read (bead `ro-c0d2`).
//
// Same boundary as the GA4 realtime read: ingest holds the feed URLs (an
// operator secret) and this route only forwards the plain-data snapshot its
// WorkerEntrypoint returns. Nothing about a provider failure crosses the
// service boundary. The browser retains its last-good snapshot and shows the
// failed read; without a snapshot it shows an unavailable calendar rather than
// telling the operator their calendar is empty.
//
// Extracted into its own module rather than inlined beside the GA4 route so it
// can be unit-tested against a stubbed binding; index.ts cannot be imported by
// a test, since its build-time `declare const` config globals do not exist
// outside the Vite bundle.

import type { CalendarUpcoming } from "@noticeos/contract";
import { JSON_HEADERS, jsonError } from "./http";

/**
 * The one ingest RPC this route calls. `env.INGEST` satisfies it structurally;
 * declaring the surface here rather than importing the binding's type keeps this
 * file free of Workers globals (the test project typechecks it too) and lets a
 * test bind a double. Same trick as `AnnotationWriter` in ./annotation-route.
 */
export interface CalendarReader {
  calendarUpcoming(originalProof?: Request): Promise<CalendarUpcoming>;
}

/**
 * Handle one upcoming-meetings read. 405 method_not_allowed ·
 * 503 calendar_upcoming_unavailable — the GA4 route's vocabulary, because both
 * failures mean the same thing to the client: no fresh snapshot this poll.
 */
export async function handleCalendarUpcomingRequest(
  request: Request,
  ingest: CalendarReader,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonError("method_not_allowed", 405);
  }
  try {
    const payload = await ingest.calendarUpcoming();
    return Response.json(payload, { headers: JSON_HEADERS });
  } catch {
    // Keep provider/internal details behind the service boundary. A failed poll
    // is not an empty calendar, so the browser holds its last-good snapshot and
    // a browser that never had one shows an unavailable calendar.
    return jsonError("calendar_upcoming_unavailable", 503);
  }
}
