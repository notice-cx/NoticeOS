/** Cross-Worker contract for the Wall's upcoming-meetings read.
 *
 * The ingest Worker owns the calendar feed URLs (an operator secret) and returns
 * plain data through a private Service Binding; the Tower proxies that shape to
 * the browser. Same boundary as the GA4 realtime read: no feed URL, credential,
 * or provider response leaves ingest.
 */

/** One event inside the window. Times are ISO UTC instants — the surface that
 * renders them owns the timezone, because the TV and the desk browser are the
 * only things that know which local day this is. */
export interface UpcomingMeeting {
  /** The feed's operator-given label: `work`, `personal`, or anything named in
   * the secret. Carries calendar identity only, never state. */
  calendar: string;
  title: string;
  startsAt: string;
  endsAt: string;
  /** An all-day event has no clock time to be early or late for; consumers must
   * not read `startsAt` as a meeting time. */
  allDay: boolean;
  location: string | null;
}

/** One configured feed, present whether or not it has an event in the window. */
export interface CalendarFeed {
  /** The feed's operator-given name, matching `UpcomingMeeting.calendar`. */
  id: string;
  /**
   * The color the operator pinned on this feed, in any notation CSS accepts, or
   * `null` to leave the choice to the surface. A pinned color is the operator's
   * own association — the one their calendar app already trained them on — so a
   * renderer prefers it over anything it would pick itself.
   */
  color: string | null;
  /**
   * How this feed fared in the round `fetchedAt` names. `feedsOk` is exactly the
   * count of `ok` here, so this is the same fact per feed rather than a new one.
   *
   * - `ok` — fetched AND parsed. Its meetings are in the list.
   * - `misconfigured` — the entry is unusable as written and ingest knew it
   *   before asking the network: no url, an unparseable one, or a scheme that is
   *   not http(s). Only the operator can fix it.
   * - `unreachable` — the round asked and no calendar came back: a timeout, a
   *   refused connection, an HTTP error, a response too large, or a body that
   *   was not a calendar at all.
   *
   * The line between the last two is "could ingest tell without asking", not
   * "who has to act": do not render `unreachable` as purely transient, since a
   * `403` or a sign-in page served as `200` most often means the secret link
   * was rotated.
   */
  status: 'ok' | 'unreachable' | 'misconfigured';
}

export interface CalendarUpcoming {
  monitoringAvailable?: boolean;
  /**
   * When the ICS fetch behind this payload happened — NOT when it was asked
   * for. Ingest caches each fetch round for five minutes (the feeds throttle)
   * and recomputes the window from it on every call, so a cached round keeps
   * its original stamp. Stale feeds are therefore visible as a stale stamp
   * rather than hidden behind a fresh-looking response.
   */
  fetchedAt: string;
  /**
   * How many feeds the operator has configured. `0` means the secret is not set
   * up, which is a different fact from "configured and quiet" — the Wall renders
   * nothing at all for it rather than nagging about setup.
   */
  feedsConfigured: number;
  /** How many of those feeds answered. `feedsOk < feedsConfigured` is partial
   * coverage: the meetings present are real, the absent ones are unknown. */
  feedsOk: number;
  /**
   * The configured feeds, in CONFIG order — the order is part of the contract,
   * because it is the only stable thing a surface can key an identity color off.
   * Which feeds have an event today is not stable, and feed names are the
   * operator's own words, so neither can decide what a feed looks like.
   */
  calendars: CalendarFeed[];
  /**
   * Events starting inside `[now, now + 48h]` plus anything already in progress,
   * sorted by `startsAt`, capped at 20. A cap rather than a page: this is a
   * glance surface, and the 21st event of the next two days changes nothing
   * about what happens next.
   */
  meetings: UpcomingMeeting[];
}
