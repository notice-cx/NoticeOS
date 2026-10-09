# 24 — Integration monitoring

Reviewed: 2026-09-10. Persistence and read model for `ro-klom`.

An operator should learn about missing data from System Health before noticing
an empty card. A connected account proves access was configured. It does not
prove that every report, live feed, calendar, or notification is working.

## One health record per capability

`packages/contract/src/integration-health.ts` is the coverage inventory and
shared state projection. Its tests require every connected provider and every
lane in `config/integrations.json` to have a monitor or an explicit coverage
gap. New providers cannot silently inherit green health. Family-based adapters
expand the collector's actual report plan by property and date; they do not
copy a list of report names into monitoring.

Archive adapters encode `family` as a canonical JSON tuple of report name,
report date, query, and device. Current producers record aggregate reports,
with the query/device slots empty: DataForSEO combines its tracked queries and
devices into one report outcome and fails that report when a required member
call is incomplete. Independent query/device incidents are not exposed.
Yesterday’s successful report cannot clear today’s failed report. `target` identifies
the property. Delivery targets identify the destination; real notifications
and test sends have separate capability IDs. A later successful notification
can demonstrate destination recovery, but never changes the failed receipt
or automatically resends that earlier notification. Saved query-history reads
use stored R2/Postgres evidence and are not new Google operations.

Each record is scoped to workspace, connection revision, capability, asset,
target, and report family. Realtime active users, hourly traffic, daily
Analytics, Search Console, and each archive family have independent outcomes.
Connection tests and site discovery are separate capabilities. They cannot
clear failed production reads. A credential replacement starts a new revision;
old evidence remains in history and cannot confirm the replacement's access.

The workspace comes from the trusted server context. A standalone
installation has one workspace; a column in this design does not implement tenant access
control. Connection revisions and target identifiers are opaque IDs. Tokens,
private calendar URLs, webhook addresses, account emails, raw error messages,
and report payloads never enter health rows or grouping keys.

| State | Meaning |
|---|---|
| Working | The same capability returned a usable result for its current obligation. A valid zero or empty response is usable. |
| Failing | An observed failure has no later same-capability recovery. Aging does not clear it. |
| Stale | The last usable result no longer meets the collector's due obligation. |
| Never run | Configured and monitored, but no attempt has been recorded. |
| Idle | An event-driven action has no pending obligation, or an on-demand feed is not currently requested. Previous outcomes remain visible. |
| Paused / Disconnected | The operator disabled the capability or removed its connection. Neither is green. |
| Unmonitored | Enabled, but no reliable observation adapter is installed. |
| Unknown | The observer or inventory cannot be read, or its evidence is invalid. |

The reducer orders observations by attempt start, not arrival. A slow success
from an older request cannot clear a newer failure. Ties prefer failure until
a later success proves recovery. Invalid/future timestamps make availability
unknown. Last attempt, last successful attempt, and the date covered by a
report remain separate facts.

## Evidence and failure detection

Scheduled collectors already keep `signal_runs`, `signal_dump_runs`, and
`mediavine_runs`. Their adapters read those records, including the failed
family/date and incomplete reports. Source lag is distinct from transport
failure: a successful response containing no new finalized date must not be
labelled a provider outage or filled with zeroes.

Live/on-demand operations record their outcome after response parsing and
semantic validation, inside the provider adapter. Catching only HTTP errors
misses HTTP-200 error envelopes, malformed data, and partial reports. Failure
categories are access, rate limit, exhausted budget, network, provider error,
invalid report, incomplete report, configuration, and monitoring failure.
Each category maps to reviewed product copy and an action; raw provider prose
is never displayed as a diagnosis.

The recorder is awaited. If it fails, successful business data can remain
visible, but the response explicitly reports monitoring unavailable. A
recorder exception must not turn an irreversible successful action into a
retryable action failure: outbound sends retain their delivery ID and success
receipt, with a separate monitoring error. Monitoring never resends messages.

NoticeOS's scheduled runner continues to own `job_runs`. Those rows describe
workflow execution, not arbitrary integration incidents. Configuration stays
in `config_documents`; credentials stay in `credentials`; neither becomes an
incident log. Account-wide credential status is setup evidence, not the
capability-health source of truth.

## Durable state and recovery

The approved schema is implemented in the
[Postgres baseline](../db/postgres/migrations/0001_baseline.sql).
What is monitored — provider, connection
revision, capability, site, target and family — is one `capability_targets`
row that state and events refer to
([`0001_baseline.sql`](../db/postgres/migrations/0001_baseline.sql)).

`integration_capability_state` keeps the latest attempt and latest successful
attempt. `integration_health_events` keeps first failures, changes of failure
category, and recovery transitions. Success polls update current state without
creating an append-only event every 30 seconds. Existing report histories keep
their own detailed attempts; event pointers identify those source records.

The writer uses one transaction. It first locks the monitored target, so
observations of one target apply one at a time. It then inserts an incident event from the
current row only when the incoming attempt is newer and changes the failure
state/category, then conditionally upserts current state under the same ordering
predicate. A deterministic event ID includes scope, connection revision and
attempt ID, so retries are idempotent. A late success may advance
`last_success_started_at` only if that success itself is newer than the stored
success; it never overwrites the newer current failure. Updates and event
insertion must share one transaction. The adapter tests must execute reordered,
duplicate, and concurrent observations against this rule.

The configured inventory selects active connection revisions. Disconnecting or
remapping removes old rows from current health without deleting their history.
Reading health never substitutes the last good inventory if the current one
is unavailable: completeness is then unknown. The observer's own unavailable
state is explicit even when no incident could be persisted.

## One presentation across the product

System Health, Integrations, the Wall, and asset details consume one health
payload and state projection. The read endpoint reads stored evidence only;
viewing System Health must not trigger API calls, quota consumption, paid
research, or notification delivery. The payload includes monitoring coverage,
affected assets, capability labels, last attempt, last success, next permitted
retry, and the safe corrective action. All visible times use the viewer's local
clock or relative age, with exact UTC references in tooltips.

Group failures only when evidence identifies the same cause and scope, such as
the same account access failure or the same property quota bucket. Merely
sharing an HTTP status or provider is insufficient to claim a shared cause.
A group expands to its individual capabilities and assets. Green means a
recorded operational success, not a successful business outcome.

Notification delivery failures appear in System Health itself, so the broken
notification channel is not the only way to learn of its failure. Adding new
outbound outage notifications is separate from observing existing deliveries.

## Retry and freshness ownership

The provider adapter owns one bounded retry policy and honors `Retry-After`.
Pages share reads; hidden pages do not continue polling. Health reads and
connection badges never start provider probes. Existing paid-request budgets,
report cadence, measurement thresholds, and operator permissions remain owned
by their existing policies. Monitoring does not invent new obligations for
event-driven integrations or bypass provider quotas.

GA4's display read now shares successful live counts for 30 seconds and hourly
Core reports for 15 minutes. Cache misses share a database lease; HTTP 429
responses pause frequent requests for five minutes by default, honoring
Google’s explicit Retry-After when supplied. The durable lease preserves cooldown even if the
platform response cache is lost. Cache entries are local to a data center;
another region may temporarily show “Checking traffic” until it can obtain a
new reading. Actual observation time is retained on cached values and failures.
Hourly failure does not blank successful realtime counts.

Google documents separate Core and Realtime budgets and daily replenishment;
request allowance cannot be restored by retrying. The diagnostic category and
next attempt are not a promised reset time. References:
[Data API quotas](https://developers.google.com/analytics/devguides/reporting/data/v1/quotas)
and [quota management guidance](https://developers.google.com/analytics/blog/2023/data-api-quota-management).

## Implementation state

Migration 0035, the atomic recorder, operation adapters and read-only
`GET /api/integrations/health` are implemented. Live GA4, calendar feeds,
connection tests, discovery, account-credit reads and Discord delivery record
validated outcomes. Scheduled and explicit report producers attach the exact credential snapshot
to their own target and record the attempt ID as it is written. Overlapping
runs are never associated by a time-window query.
Recording failure is reported separately from a successful delivery or report.

The read model requires saved configuration. Missing or malformed inventory
is unknown; bundled configuration is not a substitute for the active inventory.
Stored credentials carry the edit revision from the same row as their fields.
If a connection changes during an internally resolved operation, its result
cannot verify the new connection. Unversioned report history remains available but does not establish the current
connection’s health. A newly observed collection supplies that proof. Google’s
revision includes its referenced service-account key and OAuth app dependency
without exposing those values.
An unmatched newer source attempt invalidates an older green result. A known
failure remains open until recovery is recorded for the same connection.

Archive histories remain scoped by report and date. Incomplete or truncated
responses cannot clear a failure. Each property archive read returns at most
256 latest report/date outcomes, prioritizing unresolved failures, and shows
an explicit count and unknown coverage item when additional dates exist.
Last success is selected by attempt start, independently of the current failure.
Current-state reads select only the active provider revision. Non-archive
operations are capped at 2,048 per provider; archive reads select current
obligations plus unresolved failures before applying a 256-row limit. Excess
rows make coverage unknown; resolved historical dates do not consume current
coverage. Event history filters the latest 100 stored transitions to active scopes.

System Health, the Wall and Integrations consume the same saved-health
projection. System Health never starts a live provider read. The Wall still
requests the counts and calendar data it displays, and reports a failed
monitoring write separately from those results.

The interface groups by provider and operation; grouping does not infer a
shared cause. Expanding an operation shows its asset/report evidence, last
attempt, last success, next eligible check and safe guidance. Unknown coverage
has its own filter and stays gray. An operation with both a failure and a
coverage gap appears in both filters. A recorded recovery is shown in the
recent changes list. Times are relative or local, with UTC references.

Provider setup, explicit tests and production operation outcomes remain
separate. A saved credential never promotes an unverified operation to green.
An unavailable provider inventory does not erase another provider’s known
results, while an empty inventory cannot produce an all-clear.
