// GET /api/calendar/upcoming — the Wall's next-meetings read. Ingest holds the
// feed URLs (a secret); this route forwards only the plain-data snapshot.

import type { CalendarUpcoming } from "@noticeos/contract";
import { JSON_HEADERS, jsonError } from "./http";

const READ_REASONS = new Set([
  "calendar_read_in_progress", "calendar_read_cache_unavailable",
  "calendar_read_coordination_unavailable", "calendar_read_ownership_unavailable",
  "calendar_read_unavailable",
]);

/** Declared here rather than imported from the binding so this file stays free
 * of Workers globals (the test project typechecks it). */
export interface CalendarReader {
  calendarUpcoming(originalProof?: Request): Promise<CalendarUpcoming>;
}

/** 503 calendar_upcoming_unavailable, the GA4 route's code: no fresh snapshot
 * this poll. */
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
  } catch (error) {
    // Keep provider/internal details behind the service boundary. A failed poll
    // is not an empty calendar, so the browser holds its last-good snapshot and
    // a browser that never had one cannot claim its calendar is clear.
    const detail = error !== null && typeof error === "object" ? error : {};
    const reason = "code" in detail && typeof detail.code === "string" && READ_REASONS.has(detail.code)
      ? detail.code : "calendar_read_unavailable";
    const next = "nextAttemptAt" in detail && typeof detail.nextAttemptAt === "string"
      ? Date.parse(detail.nextAttemptAt) : NaN;
    const retryAfter = Number.isFinite(next) ? Math.max(1, Math.ceil((next - Date.now()) / 1_000)) : 30;
    console.warn(JSON.stringify({ event: "calendar_read_deferred", reason, retryAfterSeconds: retryAfter }));
    return Response.json({ error: "calendar_upcoming_unavailable", reason },
      { status: 503, headers: { ...JSON_HEADERS, "retry-after": String(retryAfter) } });
  }
}
