# The ingest's failures, as a state and its values (2026-09-24, epic `ro-ujb9.96.6`)

When the UX gate started following the Tower's `INGEST` service binding (bead
`ro-ujb9.96.6.24`) it found 41 sentences the ingest writes and the Tower draws
word for word: sign-in refusals, key and notification blockers, site-check and
quota alerts, collection failures, watch-window refusals and notes, a settings
refusal, a capped health list and a time-zone annotation. Beads
`ro-ujb9.96.6.25`–`.29` took them to zero. Captures, before and after:
`docs/artifacts/ingest-copy-2026-09-24/` (private historical evidence).

## The pattern

1. **A refusal the Tower already words is a code, and nothing else.** Google's
   sign-in failures cross as `GoogleOAuthFailure` codes; the page owns the
   notice and its one press (`googleOAuthNotice`), so the ingest's sentence was
   dead weight that could only drift. A new code where the press differs
   (`unreachable`: try again, not the OAuth console).
2. **A stored verdict is the result as one short line.** The line the card
   already uses for a connection test (`probeLine`: `Refused · HTTP 404`), or
   the site row's own words for a failure kind (`integrationFailureMessage`:
   `Access was refused · 6 of 6 reports`) — never a sentence explaining where
   the fix lives; the fix is the card's own press (Replace).
3. **An alert is a headline with its numbers; the rest are label · value
   rows.** The store keeps the headline and the rule's inputs; the Tower's
   translator draws the headline and the evidence rows (`alert-language.ts`).
4. **A refused form names the field and the valid value.** `baseline_end must
   be on or before 2026-08-04`, `final check must be at least 28 days out`.
5. **A capped list is a value.** `256 of 1200 report dates · 3 unresolved
   failures`.
6. **A caveat is drawn where it applies, not repeated in a note.** A time-zone
   change is `GA4 day moved from X to Y on DATE`; the comparison that spans it
   already says "reporting timezone changed" beside its delta.

## Prior art

Researched 2026-09-24.

- **Stripe Connect OAuth — codes, and the platform's own words.** The
  authorize and token endpoints answer a closed set of error codes
  (`access_denied`, `invalid_redirect_uri`, `invalid_grant`, …) and the
  platform renders its own message per code.
  https://docs.stripe.com/connect/oauth-reference · Adopted: Google's
  sign-in answers a code; the Tower words it and puts its press beside it.
- **GitHub webhooks — a delivery is its response.** Each delivery lists the
  request, when it was sent and the response the server gave; a failed one is
  its status, with Redeliver beside it.
  https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/viewing-webhook-deliveries ·
  Adopted: a failed Discord delivery is `Refused · HTTP 404` beside Replace
  webhook URL, the same line the card's test gives.
- **Datadog monitors — the value against its threshold.** A notification
  title carries `{{value}}` and `{{threshold}}` ("95 exceeded 90"), not the
  rule's explanation.
  https://docs.datadoghq.com/monitors/notify/variables/ · Adopted: "Home page
  HTML fell to 120 words — was 860", "GA4 daily quota low — 5% left", with
  Fires at / Fires below as evidence rows.
- **Google Search Console, Page indexing — a count, then the pages.** "URL
  marked 'noindex'" is a reason with a count; its details list the affected
  URLs.
  https://support.google.com/webmasters/answer/7440203 · Adopted: "Crawler
  directives closed 1 of 3 sampled pages", then one row per page with the
  directive it carries (or "not re-checked").
- **GOV.UK Design System, date input — the field and the valid date.** "The
  date of … must be the same as or before 31 August 2017"; "… must be after
  [date]".
  https://design-system.service.gov.uk/components/date-input/ · Adopted: the
  watch refusals name the field and its valid value.
