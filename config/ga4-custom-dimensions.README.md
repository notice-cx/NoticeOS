# config/ga4-custom-dimensions.json — where the operator registered GA4 event parameters

> **Seed and export, not source of truth** (2026-09-05, D22 — epic `ro-syok`):
> `pnpm config:seed` loads this installation's copy (else this generic default)
> into the store's `config_documents` table, the running OS reads and saves it
> there, and `pnpm config:export` writes it to `installation/` so a diff stays
> the record. Until an install seeds, every read falls
> back to the copy compiled into the Workers and nothing here changes.

**This file declares a fact about GA4 admin, not a preference.** GA4 answers a
Data API query for an event parameter only after an operator has registered that
parameter as a **custom dimension** in the GA4 property (Admin → Custom
definitions). This file is the OS's record of where that has been done, so
families that read event parameters ask only the assets that can answer.

It changes nothing in GA4. Registering is operator work — the analytics pipeline
is `forbidden`-class ([AGENTS.md](../AGENTS.md)), so this repo reads the
measurement channel and never configures it. Adding an asset here does not
make its dimensions exist; it asserts that the operator already made them exist.

## Field contract

- **`assets.<id>.eventParams[]`** — the event parameters registered as
  event-scoped custom dimensions on that asset's GA4 property, written as GA4
  names them in the emitter (`message`), not as the Data API addresses them
  (`customEvent:message`). The collector adds the prefix.
- **An asset with no entry is skipped silently** — no request, no manifest
  row, no error. This is the same rule
  [`serp-panel.json`](serp-panel.README.md) follows: absence of config is not a
  failed collection, and a daily error row for an asset the operator has
  deliberately not set up is an alarm about a settled decision.

## Which families read this

| Family | Parameters it needs |
|---|---|
| `js-errors` (GA4 daily archive) | `message`, `source` |

A family is offered to an asset only when **every** parameter it needs is
listed there. A partially registered asset is skipped rather than asked for a
field that would fail.

## Why the unregistered state still exists

Skipping the unlisted assets does **not** retire
`ga4_custom_dimension_unregistered`. Two cases keep it live and load-bearing:

- **Registration is forward-only.** GA4 backfills nothing — data begins accruing
  the moment the dimension is created, so an asset listed here can still be
  asked for a date *before* its registration and be rejected or answered with
  `(not set)`. That is per-date unknown, never an error-free day.
- **This file can be wrong.** It is a hand-maintained claim about a system it
  cannot inspect. If someone lists an asset whose dimensions were never
  actually created, the collector must say so distinctly rather than record an
  empty success.

## Seeds

A fresh clone registers no site: an asset is listed here only after its
dimensions exist in its GA4 property. Which sites an installation registered,
and when, is that installation's own record.

## Where it is edited

**The asset's Sources tab** (`/assets/<id>/sources`), inside the GA4 lane's own
card, beside the value-event declaration. Add, rename and remove are one
changeset each with Undo in the toast, and a name is refused against this
register's own rule (`ga4-event-params` in
[`scripts/config-registers.mjs`](../scripts/config-registers.mjs): the parameter
as the emitter names it, `^[A-Za-z][A-Za-z0-9_]*$` — never the Data API's
`customEvent:` spelling) before anything is sent. An asset with no entry shows an
empty list with **Add**, and that first row files the asset's entry.
`pnpm config:apply` makes the same validated store write (D22); the file in the
installation folder is its export, not the place to change it.

**The asset page's Delete removes the whole entry** *(2026-09-05, bead
`ro-vyer`)*, listed by name in the confirmation beside every other file the asset
is in. An asset's own GA4 declarations are part of what the asset is, so they
leave with it — before this they stayed behind, silently, naming an id the store
no longer had.

**Editing here still changes nothing in GA4.** The surface records the operator's
claim that the dimensions already exist; it cannot create one, and it must not —
the analytics pipeline is `forbidden`-class ([AGENTS.md](../AGENTS.md)). Adding a
row for a dimension nobody registered makes the collector ask for it and fail
loudly, which is the designed outcome (see *This file can be wrong* above), not a
bug in the editor.

**The add-asset wizard deliberately does not ask.** Registration happens in GA4
admin on a property that already exists, and this file records it afterwards —
"add them here after registering, not before". A field at creation time would
collect an intention rather than the fact this file is for.
