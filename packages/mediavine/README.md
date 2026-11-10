# Mediavine client

NoticeOS bundles this TypeScript client as a workspace dependency. It uses
standard Web APIs and has no Node or browser automation dependency. The
publisher portal's private GraphQL interface can change; keep its queries,
response validation and authentication behavior here.

`MediavineClient` accepts credentials, an optional saved session, and an awaited
session persistence callback. NoticeOS owns encryption, durable request locking,
scheduling and storage in `workers/ingest/src/mediavine*.ts`. The UI and
`pnpm mediavine` call that same collector. Neither maintains another session.

Revenue is integer USD cents, explicitly dated, and complete only when every
requested day is present. Zero is a reported value; missing and null are not
zero. The one exception: Mediavine reports $0 for a day it has not published
yet, so a $0 on its newest reporting day (yesterday on its clock) is listed in
`unpublishedDates` until that day ends, and `publishedPart` returns the days
before it. Portal summary totals and summed daily rows are kept separately.

See [setup and operation](../../docs/11-integrations.md#mediavine-revenue).
