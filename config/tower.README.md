# Tower display configuration

> **Seed and export, not source of truth** (2026-09-05, D22 — epic `ro-syok`):
> `pnpm config:seed` loads this installation's copy (else this generic default)
> into the store's `config_documents` table, the running OS reads and saves it
> there, and `pnpm config:export` writes it to `installation/` so a diff stays
> the record. Until an install seeds, every read falls
> back to the copy compiled into the Workers and nothing here changes.

`config/tower.json` owns the small set of operator-chosen facts displayed on
both the Control Tower Home and the read-only `/wall`.

## Countdown — optional

The whole `countdown` block is **optional**. A countdown is one operator's trip,
move or launch; a fresh clone has none, and it should not have to invent one to
get a build. With the key absent, Home and `/wall` render nothing for it — no
empty card, no placeholder — and the widget row is simply the clock.

**It is created and removed from the product** *(2026-09-05, bead `ro-fqag`)*.
`/settings` → **TV dashboard** offers **Set a countdown** when there is none,
opening the same three-field form the configured card shows, and a configured
one carries **Remove countdown** beside its Save. Both are one changeset op at
the `/countdown` pointer — a `file-json-insert` of the whole block, or a
`file-json-delete` of it — because a set never creates a key ("we never create
structure"), so three per-field sets could not have made the first countdown.
`/countdown` is declared in `ADDABLE_DOCUMENTS` (`scripts/config-documents.mjs`)
exactly as narrowly as `/wall` is: this file, this pointer, nothing under it. The
Undo in the toast is the inverse op with the same three values, and none of this
changes what a fresh clone SHOWS: still no countdown anywhere until one exists.

Present, it must be complete and well formed, because a half-written countdown
is a mistake somebody wants to hear about at build time rather than on the wall
TV. A minimal valid file is `{ "readme": "config/tower.README.md" }`.

- `countdown.emoji` is the single emoji rendered as the card's large visual
  landmark. It is deliberately separate from the label so the Wall can give it
  hero scale without enlarging or repeating the event name.
- `countdown.label` is the plain-language event name shown in the card header
  (1–80 characters).
- `countdown.targetAt` is an ISO-8601 instant, including `Z` or a numeric UTC
  offset. The UI edits it with the browser's local date/time picker and stores
  the resulting absolute instant, so every Wall counts down to the same moment
  while formatting that moment in its own local timezone.

Edit all three fields from `/settings` → **TV dashboard**, as one form with one
Save (D18): they are three values of one thing, so saving them separately would
mean three commits and three chances to leave the label describing an event the
date no longer points at. The Save writes the file, archives the
changeset and commits it; the Tower never writes config outside that lane. Vite
tracks the imported file, so once a save lands the running local Worker
restarts, `/api/wall` begins returning the new configuration, and both Home and
any open Wall pick it up through their ordinary payload polls.

## Wall layout — `null` until the operator arranges one

`wall` holds the television's composition: the current `WallLayout` plus the
versions it replaced, newest first, capped at 20. The contract, the validator
and the default are
[`scripts/wall-layout.mjs`](../scripts/wall-layout.mjs) — plain ESM so the
changeset pipeline can run the validator at every write door, with
[`apps/tower/shared/wall-layout.ts`](../apps/tower/shared/wall-layout.ts) as the
typed re-export the Tower imports *(bead `ro-lzmq.3`)*. The editor is
`/wall/edit`, reached from `/settings` → **TV dashboard** or the command
palette.

**`null` or no key at all: both mean no layout has been saved** — the Wall
draws its default, byte-for-byte the composition it had before layouts existed,
so an install that never opens the editor sees no change. A fresh clone ships
`null`; a store seeded without the key holds none. `/wall` is a declared
document (`ADDABLE_DOCUMENTS` in `scripts/config-documents.mjs`), and at a
declared document the write lane reads a stored `null` as absent and a guard of
`null` as "not saved yet" (`readsAsUnsaved`, bead `ro-nuz9`), so the editor's
first Save lands on either spelling and creates the key when there is none.
Everywhere else the lane still **never creates structure**.

A row's `widgets` may also hold a **column** — `{ "id", "type": "column",
"width", "rows": [ { "id", "height", "widgets" } ] }` — which stacks rows of
widgets inside one track of the row, so a widget beside it can run the full
height ([doc 25](../docs/25-the-wall.md) § Regions, bead `ro-trai.2`). One level
deep: a column holds widgets, never another column; it needs at least one row,
and at most one of its rows takes its remaining height. A layout saved before
columns existed loads unchanged.

A saved value is `{ "layout": …, "history": [ { "savedAt", "reason", "layout" } ] }`.
Every Save asks for a one-line reason and keeps the layout it replaced; Revert
is itself a save, so the entry reverted to stays in the list and a revert can be
reverted. A layout the Wall cannot draw is refused by every door that could write one —
`pnpm config:apply`, the Worker's `PUT /api/config`, the ingest's
`applyConfigOps` and the dev write lane — with the validator's own sentence, the
same words the editor prints under a dark Save button, and fails the build if it
lands by any other route.

## What is NOT here

The operator's timezone is **not** a display setting — it is
`config/constants.json` `os_time_zone`
([`config/constants.README.md`](constants.README.md)), because the ingest reads
it too when it re-buckets intraday hours, and a Worker collecting data should
not import the Tower's display config to do it.
