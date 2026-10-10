# Tower display configuration

`config/tower.json` owns the small set of operator-chosen facts displayed on
both the Control Tower Home and the read-only `/wall`.

**Seed and export, not source of truth**: `pnpm config:seed` loads this
installation's copy (else this generic default) into the store's
`config_documents` table, the running OS reads and saves it there, and
`pnpm config:export` writes it to `installation/`. Until an install seeds,
every read falls back to the copy compiled into the Workers. A minimal valid
file is `{ "readme": "config/tower.README.md" }`.

## Countdown — optional

A countdown is one operator's trip, move or launch; a fresh clone has none and
should not have to invent one to get a build. With the key absent, Home and
`/wall` render nothing for it — no empty card, no placeholder.

It is created and removed from the product: `/settings` → **TV dashboard**
offers **Set a countdown** when there is none and **Remove countdown** beside
a configured one's Save. Both are one changeset op at the `/countdown` pointer
— a `file-json-insert` of the whole block or a `file-json-delete` of it —
because a set never creates a key. `/countdown` is declared in
`ADDABLE_DOCUMENTS` (`scripts/config-documents.mts`) exactly as narrowly as
`/wall` is: this file, this pointer, nothing under it.

Present, it must be complete and well formed, because a half-written countdown
is a mistake somebody wants to hear about at build time rather than on the
wall TV:

- `countdown.emoji` — the single emoji rendered as the card's large visual
  landmark, separate from the label so the Wall can give it hero scale.
- `countdown.label` — the plain-language event name in the card header
  (1–80 characters).
- `countdown.targetAt` — an ISO-8601 instant with `Z` or a numeric UTC
  offset. The UI edits it with the browser's local picker and stores the
  absolute instant, so every Wall counts down to the same moment while
  formatting it in its own local timezone.

The three are edited as one form with one Save: they are three values of one
thing, so saving them separately would leave the label describing an event
the date no longer points at.

## Wall layout — `null` until the operator arranges one

`wall` holds the television's composition: the current `WallLayout` plus the
versions it replaced, newest first, capped at `WALL_LAYOUT_HISTORY_MAX` (20).
The contract, the validator and the default are
[`scripts/wall-layout.mjs`](../scripts/wall-layout.mjs) — plain ESM so the
changeset pipeline can run the validator at every write door — with
[`apps/tower/shared/wall-layout.ts`](../apps/tower/shared/wall-layout.ts) as
the typed re-export. The editor is `/wall/edit`, reached from `/settings` →
**TV dashboard** or the command palette.

**`null` or no key at all both mean no layout has been saved** — the Wall
draws its default. At a declared document the write lane reads a stored
`null` as absent and a guard of `null` as "not saved yet" (`readsAsUnsaved`),
so the editor's first Save lands on either spelling and creates the key when
there is none. Everywhere else the lane still never creates structure.

A row's `widgets` may hold a **column** — `{ "id", "type": "column",
"width", "rows": [ { "id", "height", "widgets" } ] }` — which stacks rows of
widgets inside one track, so a widget beside it can run the full height
([doc 14](../docs/14-design.md) § Regions). One level deep: a column holds
widgets, never another column; it needs at least one row, and at most one of
its rows takes its remaining height.

A saved value is `{ "layout": …, "history": [ { "savedAt", "reason", "layout" } ] }`.
Every Save asks for a one-line reason and keeps the layout it replaced; Revert
is itself a save, so a revert can be reverted. A layout the Wall cannot draw is
refused by every door that could write one — `pnpm config:apply`, the Worker's
`PUT /api/config`, the ingest's `applyConfigOps` and the dev write lane — with
the validator's own sentence, and fails the build if it lands by any other
route.

## What is NOT here

The operator's timezone is **not** a display setting — it is
`config/constants.json` `os_time_zone`
([`config/constants.README.md`](constants.README.md)), because the ingest reads
it too when it re-buckets intraday hours, and a Worker collecting data should
not import the Tower's display config to do it.
