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
"width", "rows": [ { "id", "height", "size"?, "widgets" } ] }` — which stacks
rows of widgets inside one track, so a widget beside it can run the full height
([doc 14 § The Wall](../docs/14-design.md#the-wall)). One level deep: a column
holds widgets, never another column; it needs at least one row, and at most one
of its rows takes its remaining height. A column's row may carry a `size`, a
weight on the width's scale (0.25–12 in steps of 0.05): the rows with one, and
the `fill` row at a weight of 1, share the height the others leave. A layout
with no sizes draws exactly as it always has; a top-level row takes none.

A saved value is `{ "layout": …, "history": [ { "savedAt", "reason", "layout" } ] }`.
Every Save asks for a one-line reason and keeps the layout it replaced; Revert
is itself a save, so a revert can be reverted. A layout the Wall cannot draw is
refused by every door that could write one — `pnpm config:apply`, the Worker's
`PUT /api/config`, the ingest's `applyConfigOps` and the dev write lane — with
the validator's own sentence, and fails the build if it lands by any other
route.

## Default view — `null` until somebody picks one

`view` holds the view a new person and the TV start from:
`{ "default": "business" | "product" | "everything" }`. The list of views and
the reader are [`packages/contract/src/views.mts`](../packages/contract/src/views.mts),
with [`apps/tower/shared/views.ts`](../apps/tower/shared/views.ts) as the
typed re-export.

**`null` or no key at all both mean no default has been saved**, and the
Tower shows the Everything view, which is every page and every figure. The
shipped file holds `"view": null`, and a stored `null` reads as absent the
same way it does for `wall` (`readsAsUnsaved`).

It is written from **Settings** → **General** → **Your view** and by the
first-run step that asks which view to start from. Both save the whole value
at the `/view` pointer, which is declared in `ADDABLE_DOCUMENTS`
(`scripts/config-documents.mts`) exactly as narrowly as `/wall` is: this
file, this pointer, nothing under it. Every write door checks the value with
`parseWorkspaceView` and refuses a value that is not an object, a key other
than `default`, or an id not in the list, with the parser's sentence.

A view changes which pages and figures are drawn first. It does not change
what is collected, how outcomes are measured or what another person's own
choice shows.

## Where each asset shows — `sites`

`sites` holds, by asset id, the switches the operator set for where that asset
shows: `list` (a row on Home and on the Portfolio page), `tv` (asset rows and counts on
the TV) and `work` (a row in the TV's Work this week). A key is present only
for a switch somebody set; an absent key, an absent asset and an absent or
`null` map use the default: every switch on for an active asset. An archived
asset stays hidden regardless of its saved switches. A lifecycle move preserves
those keys; Restore uses the saved preferences again.
The one reading of the three is `siteShownOn` in
[`apps/tower/shared/site-display.ts`](../apps/tower/shared/site-display.ts).

The switches are edited on the Portfolio page (**Arrange**), on Settings
(**Assets**) and on an asset's Settings tab (**Where it shows**). A store seeded
before the map existed has no `sites` key, so the first switch inserts the
whole map at `/sites`; after that a switch inserts the asset's row, writes its
key for the first time or sets it, and Undo is the exact reverse of each. A
asset hidden by a visibility switch still collects data, raises alerts and files tasks. Archive also excludes its alerts and tasks from portfolio views.

An asset's row may also hold `lightIcon` and `darkIcon`: an http or https
address of an image drawn in place of the icon the asset's home page declares,
`lightIcon` on light screens and `darkIcon` on dark screens and the TV. The
Tower builds every asset card's icons from them in one place
([`apps/tower/worker/site-icons.ts`](../apps/tower/worker/site-icons.ts)), so
an address set here is drawn on every screen. Both are edited on the asset's
Settings tab (**Identity**, **Light icon** and **Dark icon**) with the same
writes as a switch; saving an empty field deletes the key, and the icon read
from the page is drawn again.

<!-- config-registers:start -->

### What the Tower may edit here

Generated by `pnpm generate` from `scripts/config-registers.mts`, the one declaration of every list and single value the Tower may edit; `scripts/config-docs.test.mjs` fails when this block is stale.

**Where each asset shows** (`site-display`) — where one asset shows and the icons it uses. Rows live at `/sites` of `config/tower.json` (object, keyed by asset-id); edited from Portfolio → Arrange, Settings → Assets, and the asset's Settings tab (Identity, Where it shows).

| Field | Label | Type | Required | Hint | Rule |
|---|---|---|---|---|---|
| `assetType` | Asset type | `enum` | no | website (marketing/landing), web app (SaaS), or mobile app; defaults to website | one of `website`, `web-app`, `mobile-app` |
| `list` | Home and Portfolio | `boolean` | no | a row on Home and on the Portfolio page | — |
| `tv` | TV | `boolean` | no | asset rows and counts on the TV | — |
| `work` | Work this week | `boolean` | no | a row in the TV's Work this week | — |
| `lightIcon` | Light icon | `url` | no | drawn on light screens in place of the one read | up to 2048 characters |
| `darkIcon` | Dark icon | `url` | no | drawn on dark screens and the TV in place of the one read | up to 2048 characters |

<!-- config-registers:end -->

## What is NOT here

The operator's timezone is **not** a display setting — it is
`config/constants.json` `os_time_zone`
([`config/constants.README.md`](constants.README.md)), because the ingest reads
it too when it re-buckets intraday hours, and a Worker collecting data should
not import the Tower's display config to do it.


### Asset types

Each entry in the existing `sites` metadata map may hold `assetType`: `website`, `web-app`, or `mobile-app`. An absent value means `website`, so existing installations need no rewrite. Add asset and the asset's Settings → Identity edit this field through guarded configuration writes. The type currently changes no integrations, widgets, screens, tabs, or features; future availability rules can read the shared type contract.
