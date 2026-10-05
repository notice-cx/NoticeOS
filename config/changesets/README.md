# Config changesets (the contract of record)

A **changeset** is migration mechanics for config: a set of pointer-addressed
edits, each carrying the value it expects to find, applied all-or-nothing and
archived as an audit artifact. Every config change is version-controlled,
exactly as doc 06 wants.

**Two entry points apply one.**

1. **The Tower** (D18, 2026-09-04). A settings field has a Save. Pressing it
   PUTs the ops to `/api/config`, where a local write lane inside the `os:up`
   dev server applies them, archives the changeset here, and commits it — then
   the toast offers Undo. Most changesets in this directory now arrive this way.
   See [`apps/tower/vite/config-write-lane.ts`](../../apps/tower/vite/config-write-lane.ts).
2. **`pnpm config:apply`** — a changeset written by hand or by a script, applied
   in a terminal with a printed diff and a `y/N`. Still the only way to reach a
   `store-asset-set` op, or explicit offline seed edits with `--seed-files`.
   See [`scripts/config-apply.mjs`](../../scripts/config-apply.mjs).

They are not two implementations. Validation, the safety allowlist, the `expect`
guard, the file read-modify-write and the archive all live in
[`scripts/config-apply-core.mjs`](../../scripts/config-apply-core.mjs), which both
run — so "what may be edited" has one answer, and
`apps/tower/test/config-write-lane.test.ts` runs both entry points over identical
temp repos and compares what each left behind.

**There is no cart.** Until 2026-09-04 the Tower could not write config at all:
an edit was staged into a browser-local cart, exported as a changeset, and
pasted into a terminal. D18 retired that — a setting saves where it stands, and
the way back is an Undo afterwards rather than a review step before.

This file is the format's single source of truth.
[`apps/tower/shared/changeset.ts`](../../apps/tower/shared/changeset.ts) builds the
document.

## Shape

```json
{
  "version": 1,
  "createdAt": "2026-07-06T13:00:00.000Z",
  "slug": "raise-alpha-and-pause-shop",
  "ops": [
    {
      "kind": "file-json-set",
      "file": "config/constants.json",
      "pointer": "/flag_defaults/alpha",
      "expect": 0.01,
      "value": 0.02
    },
    {
      "kind": "store-asset-set",
      "asset": "shop.example.com",
      "column": "sense_only",
      "expect": 1,
      "value": 0
    }
  ]
}
```

- `version` — always `1`. A reader that doesn't recognise the version refuses
  the whole changeset rather than guessing.
- `createdAt` — ISO-8601 UTC, when the document was minted.
- `slug` — kebab-case; names the archived file and the commit subject.
- `ops` — an ordered, non-empty array. Four kinds, every one guarded (see
  [the `expect` guard](#the-expect-guard-optimistic-concurrency)):

| kind | what it does | guard |
|---|---|---|
| `file-json-set` | edits a value that is already there, or writes a declared optional field for the first time | `expect` = the current value, or `expectAbsent: true` when there is none |
| `file-json-insert` | adds ONE asset's entry to a per-asset register | fixed: the pointer must resolve to **nothing** |
| `file-json-delete` | removes ONE asset's entry, ONE declared optional field of a row, or one key the product retired (`RETIRED_KEYS`) | `expect` = the entry, or the value, being removed |
| `store-asset-set` | sets one editable column on an asset row | `expect` = the current value |

### `file-json-set`

Sets one JSON value inside a config **file**.

| field | meaning |
|---|---|
| `file` | the owning file — **only** `config/constants.json`, `config/pull.json`, `config/integrations.json`, `config/tower.json` (the four wholesale-editable ones; an explicit allowlist, never a `config/` glob), **or** a file holding a [declared register](#the-register-map), where a set may address that register's own fields, **or** one holding a [declared knob](#the-knobs), where it may address that exact pointer |
| `pointer` | an [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) JSON Pointer to the value (`/flag_defaults/alpha`, `/0/url`, `/assets/shop.example.com/affiliate-amazon/status`, `/domains/3/paidUsd`) |
| `expect` | the value the writer believes is at that pointer right now — for the Tower, the value the field was rendered from |
| `expectAbsent` | `true` instead of `expect`, when the writer believes there is **nothing** at that pointer — see [a first write](#a-first-write-into-a-declared-optional-field) |
| `value` | the proposed replacement |

A pointer only ever **edits a value that is already there**: this op never
creates structure, and it refuses an empty pointer outright. That is the
difference between a settings write and an arbitrary file write. Adding an
asset needs the opposite, and gets its own two ops below rather than a wider
version of this one.

#### A first write into a declared optional field

The **one** exception, and it is a single key wide *(2026-09-05, bead
`ro-j71v`)*. A register field the declaration marks optional is **absent** until
something writes it — every mapping field in `config/integrations.json` is, so
the GA4 property id, the Search Console or Bing site and the DataForSEO scope
are each written for the first time on some asset's Sources tab.

`expect` is a JSON value and JSON cannot spell absence: `""` is a value somebody
wrote down, an absent key is a different fact, and comparing the first against
the second is a mismatch. So a set says **which fact it read** — `expect` for a
value, `expectAbsent: true` for a key that is not there — and carries exactly
one of the two. Both is refused: they are two claims about the same pointer.

`expectAbsent` licenses one thing and refuses everything else by name: a value
into a **declared optional field** of a **row that already exists**. Not a
required field (a row missing one is broken, not new), not the row itself
(`file-json-insert`), not a parent, and never an array index. The guard is
otherwise ordinary — a field somebody else has already filled in comes back as a
mismatch beside every other stale op.

**Where a set is legal**, in this order — and the order *is* the permission
model:

1. A **declared field** of a declared register's row. The narrowest permission,
   and the only one that checks the value: `/domains/3/paidUsd` is a
   non-negative number because `config-registers.mjs` says so, and a string
   there is refused naming the field and the rule it broke. A pointer at the
   **row** rather than a field is a whole-row set, checked as a whole row —
   which is how a row that is one bare string is edited at all, and how an
   optional field is *cleared away* rather than written as a `null`.
   A field the register marks **`readOnly`** is refused outright *(bead
   `ro-xhy5`)*: it may be set when the row is created and not afterwards, and a
   whole-row set that *moves* one is the same rename by another pointer. The
   join keys whose rename breaks something no table shows carry it — the
   data-source catalog's `id`, a recurring cost's `id`, a domain order's
   `domain`, an entity's `slug` — and so does a recurring cost's
   `amountUsdPerMonth` *(bead `ro-ujb9.96.6.17`)*, because every month already
   booked was booked at it: a price change closes the row with `to` and adds a
   new one, as Stripe does for a price's amount. That refuses a hand-authored
   rename changeset too, deliberately: a rename needs matching edits in files
   (and collectors) this pipeline cannot make, so the way to change one is to
   remove the row and record the new one. The Tower shows each such field
   locked, with the state *Fixed once added*, and no sentence.
2. A **declared knob** — one exact scalar pointer (see [the knobs](#the-knobs)).
   Just as narrow as (1) and checked the same way, by the field rule the knob
   carries. Exact only: the pointer one level up is refused, and so is anything
   below it.
3. **Anywhere at all** in one of the four wholesale-editable files. The original
   rule, unchanged: those four are settings top to bottom, and a value the Tower
   renders in one of them needs nothing to license it.
   `config/integrations.json` is in both lists, which is why a lane status is
   still written unvalidated while a catalog row's fields are checked.
4. Otherwise refused, naming the file — and, when the pointer landed inside a
   register whose fields it is not one of, or in a file that declares knobs,
   naming what it could have been instead.

### `file-json-insert` / `file-json-delete`

Add or remove **one row** of a declared register. They arrived as the file half
of "an asset was created" (bead `ro-z349.1`, the add-asset wizard) — until
2026-09-04 an asset was born as a seed migration plus a handful of hand edits —
and since bead `ro-x5gu.1` every list-shaped register in `config/` is reachable
the same way, because [every one of them has a CRUD surface](#the-register-map).

They have their **own allowlist**, narrower than the one above: a declared
container, and a pointer that is exactly one reference token past it.

| shape | insert pointer | delete pointer |
|---|---|---|
| an **array** container | `<container>/-` (append — RFC 6902's "end of array"), or `<container>/<index>` where the register's rows have declared **fields** | `<container>/<index>` |
| an **object** container | `<container>/<asset-id>` | `<container>/<asset-id>` |

**A delete has one more legal pointer than an insert** *(2026-09-05, bead
`ro-pkpz`)*: `<container>/<row>/<field>`, where the field is one the register
declares **optional** — the exact mirror of [a first
write](#a-first-write-into-a-declared-optional-field), licensed by the same rule
and refusing the same shapes. It is how a mapping comes back **off**: a GA4
property id, a Search Console or Bing site and a DataForSEO scope are each
absent until an operator writes one, and clearing the box was refused (a field
rule reads `""` as a blank string, not as "take this away"), so a wrong mapping
could be replaced and never removed and the asset could not go back to reading
its fallback source. It is also what makes a **first save undoable at all** —
the way back from writing a key is taking it away, and until this op there was
none, so the Sources tab was the one Save surface in the Tower with no Undo
(against [doc 15](../../docs/15-operator-flows.md) principle 5).

An **insert** is deliberately not legal there. A field's first value is a set
that says `expectAbsent`, so an insert has nothing to do at a field, and
licensing one would widen the permission that keeps "a row may be added"
separate from "this file may be rewritten".

**An indexed insert SPLICES IN** — RFC 6902's `add` for an array — and it exists
so that undoing a removal puts the row back **where it was** *(2026-09-05, bead
`ro-asj9`)*: a delete splices, so an undo that could only append returned the row
at the end and left its neighbours in an order nothing had asked for, which is
visible wherever a table is drawn in file order (`/financials` is). The one array
register that keeps the append-only rule is `config/pull.json`, whose rows are
**opaque** — whole asset endpoints the wizard files and unfiles, whose order
nothing reads, so an index there would be a claim about nothing. An index past
the end of the list is refused rather than quietly appended, and an insert that
splices counts against the **one spliced entry per container per changeset**
limit below for the same reason a delete does: either renumbers the rest.

The **whole-asset** registers — the seven an asset is born into or deleted out
of — are the object ones at `/assets` in `config/integrations.json`,
`config/counters.json`, `config/signal-panels.json`, `config/serp-panel.json`,
`config/value-events.json` and `config/ga4-custom-dimensions.json`, plus the
array that *is* `config/pull.json`. [Every register](#the-register-map) is in the
table further down. Born into **or** deleted out of: the wizard writes the first
four on Create and the last three are only ever removed, because a panel is a
weekly bill and a GA4 declaration is a claim nobody can make on day one.

Everything else is refused by name, and the refusal lists every pointer that
*would* have worked in that file. `/assets/shop.example.com/gsc` is an *edit* to a
lane, not an asset being added, and it is refused too — the pointer must be
exactly one token past the container. `/refresh` in `config/signal-panels.json`
is reachable from nowhere at all: no register names it, the file is not
wholesale-editable, and the two [knobs](#the-knobs) inside it license their own
two pointers rather than the block holding them.

The two panel registers were added on 2026-09-04 (bead `ro-sk7q`) and the two GA4
declarations on 2026-09-05 (bead `ro-vyer`), because a **delete** has to reach
them. All four key entries by asset id and none of them was on this list, so the
Tower's delete confirmation neither listed nor removed them — deleting an asset
with a tracked SERP panel left `config/serp-panel.json` naming an id the store no
longer had, and said nothing. A file this list does not know about is worse than
one it fails on: the failure at least prints a changeset. The GA4 pair was the
slower leak of the two while an entry could only appear by hand-editing JSON, and
stopped being slow the moment the Sources tab could file one with a click.

Note the two allowlists are deliberately **not the same set**:
`config/counters.json`, `config/signal-panels.json`, `config/serp-panel.json`,
`config/value-events.json` and `config/ga4-custom-dimensions.json` may grow by a
whole asset here and are *not* wholesale-editable by `file-json-set`. "May add an asset's entry" and "may rewrite any value in this
file" are different permissions, and they are refusable separately.
`config/counters.json` has no field-level register at all, so a counter card
still cannot be set; the two panel files do — a roster row's `enabled` and a
tracked query, which the asset's Growth tab edits (`ro-x5gu.4`) — and each of
those is a *declared field*, checked by type, never a free write into the file.

| field | meaning |
|---|---|
| `file` | a file holding a declared register |
| `pointer` | as the table says |
| `value` | **insert only** — one row, checked against the register's fields (an undeclared key is refused by name). A register whose rows are OPAQUE takes any JSON object, and one appended to an opaque array must carry its own key field — `config/pull.json` needs an `asset` id, or nothing could ever address it for removal |
| `expect` | **delete only** — the row as the caller last read it, deep-compared. An insert takes NO `expect`: its guard is fixed at "nothing is there yet", so a wizard re-submitted or an id typed twice is refused rather than silently overwriting somebody's configuration |

Removing an array entry **splices** it rather than leaving a `null`, which
renumbers everything after it — and an indexed insert splices in for the same
reason — so a changeset may splice at most **one** entry in or out per array
container. A second one is its own changeset. (Two *different* containers are two
different arrays and may both change in one changeset. An **append** renumbers
nothing and does not count.)

So the Tower's Undo of a removal puts the row back **where it was** *(2026-09-05,
bead `ro-asj9`)*, and its `expect` guard is unchanged: an insert has never
carried one — its guard is absence for a key, and for a position it is that the
index still exists, which is checked against the file and refused loudly when it
does not.

## The register map

Editability is **declared**, in
[`scripts/config-registers.mjs`](../../scripts/config-registers.mjs), and
derived from there by everything that enforces it: the safety allowlists above,
the pointer rules, the per-field refusals, and the Tower's `CollectionEditor`,
which builds its columns, its controls and its Add form out of the same
declaration. There is no second list anywhere — the browser validates a row
before it sends one, the lane validates it again because an HTTP body is
untrusted, and both are reading these lines.

A **✦** marks a whole-asset register: one an asset is born into and deleted out
of, and therefore one `ADDABLE_CONTAINERS` is derived from and the Settings tab's
Delete must name.

| register | file · container | shape · key | rows are | edited on |
|---|---|---|---|---|
| `asset-integrations` ✦ | `integrations.json` · `/assets` | object · asset id | opaque | the add-asset wizard |
| `asset-lane` | `integrations.json` · `/assets/<asset>` | object · **lane id** | `status`, `note`, `ref`, `since`, and the mapping fields `propertyId`, `siteUrl`, `locationCode`, `languageCode` | the asset's Sources tab |
| `asset-counters` ✦ | `counters.json` · `/assets` | object · asset id | opaque | the add-asset wizard |
| `asset-pull` ✦ | `pull.json` · the document | array · `asset` | opaque | the add-asset wizard |
| `domain-costs` | `domain-costs.json` · `/domains` | array · `domain` | `domain`, `asset`, `kind`, `paidUsd`, `paidOn` | `/financials` |
| `recurring-costs` | `recurring-costs.json` · `/costs` | array · `id` | `id`, `label`, `asset`, `family`, `amountUsdPerMonth`, `from`, `to`, `note` | `/financials` |
| `value-events-assets` ✦ | `value-events.json` · `/assets` | object · asset id | opaque (holds the list) | the asset's Sources tab |
| `value-events` | `value-events.json` · `/assets/<asset>/valueEvents` | array · a bare string | `event` | the asset's Sources tab |
| `product-use-stages` | `value-events.json` · `/assets/<asset>/productUseStages` | array · event name | `eventName`, `label`, `group`, `compareTo`, `comparisonLabel` | the asset's Sources tab |
| `ga4-event-params-assets` ✦ | `ga4-custom-dimensions.json` · `/assets` | object · asset id | opaque (holds the list) | the asset's Sources tab |
| `ga4-event-params` | `ga4-custom-dimensions.json` · `/assets/<asset>/eventParams` | array · a bare string | `param` | the asset's Sources tab |
| `serp-panel-assets` ✦ | `serp-panel.json` · `/assets` | object · asset id | opaque (holds the panel) | the asset's Growth tab |
| `serp-panel-queries` | `serp-panel.json` · `/assets/<asset>/queries` | array · `query` | `query`, `label` (a bare string when unlabelled) | the asset's Growth tab |
| `signal-panels` ✦ | `signal-panels.json` · `/assets` | object · asset id | `enabled`, `reason`, `task`, `since` | the asset's Growth tab |
| `task-hub-spokes` | `beads.json` · `/spokes` | array · `asset` | `asset`, `prefix`, `database`, `repo` | `/settings` |
| `data-source-catalog` | `integrations.json` · `/catalog` | array · `id` | `id`, `label`, `scope`, `layer`, `credential`, `docRef` | `/settings` |
| `entities` | `entities.json` · `/entities` | array · `slug` | `slug`, `name`, `form`, `jurisdiction`, `assets` | `/settings`, and an asset's Identity card |

`asset-lane` is the one register keyed by something other than an asset id
(`keyRule: 'lane-id'`): its rows are the data-source lanes INSIDE one asset's
entry, which is why it sits under `/assets/<asset>` rather than beside the
holder above it. The two coexist by the two matching rules already in force —
an add/remove takes the first register whose container matches, so the wizard's
whole-entry insert still belongs to `asset-integrations`; a set takes the
longest, so a pointer inside an asset belongs here and is field-checked.

Three of the per-asset files carry **two registers**: a list inside each asset,
and an opaque HOLDER at `/assets` above it. The holder exists because a pointer
never creates structure — an asset with no entry at all (the common case in all
three, where absence means *not declared*) has no list to append to, so its
holder entry is filed first. All three holders are now whole-asset registers
*(2026-09-05, bead `ro-vyer`)*: an asset's GA4 declarations leave with it exactly
as its tracked panel does. Being ✦ is not the same as being written on **Create**
— the wizard files the first three and the roster row, and deliberately asks for
none of these four, because a panel is a weekly bill and a GA4 declaration is a
claim nobody can make on day one.

Which register owns a pointer is decided by the **longest matching container**,
never by declaration order, so a pointer inside an asset's list always belongs to
the list rather than to the holder above it.

`entities` is the one register whose rows are **not** about a single asset, and
it stores an EDGE *(2026-09-05, bead `ro-aodz`)*: an entity owns a list of asset
ids, and an asset's owner is read back out of those lists rather than stored a
second time beside the asset. So moving an asset between entities is two sets in
one changeset — off the old row's `assets`, onto the new one's — and the asset's
own Identity card builds both from the same rows it rendered, which is what
keeps the pair invertible. An entity that owns nothing has no `assets` key at
all, so its first asset is an `expectAbsent` set, exactly like a data source's
first mapping.

Each field declares a **type** (`string`, `number`, `integer`, `boolean`,
`enum`, `date`, `month`, `url`, `asset-id`, `store-asset-id`, `domain`,
`string-list`), whether it is required, its bounds or pattern, and one line
saying what it means — the same line the Tower shows under the input and the
refusal quotes back. A value that breaks a rule is refused naming the file, the
pointer, the field by its label and the rule. A site's row in the store is
declared the same way (`SITE_ROW_FIELDS`, bead `ro-ujb9.183`), so Add a site and
the other site lanes refuse in the same words ("Domain must be a hostname such
as example.com"); `store-asset-id` is the store's id spelling and `asset-id`
the configuration key's.

**One cluster, one spelling** *(2026-09-05, bead `ro-cnsj`)*. A register may name
a `clusterField` — the field naming a GROUP something downstream matches by exact
string. `serp-panel-queries` names `label`, so relabelling one row of a cluster
into a case variant made two bets out of one and failed that asset's whole panel
on the next Monday run. A near miss is now refused where it is typed and by the
pipeline, in the collector's own words (`clusterSpellingRefusal`); joining a
cluster with its exact spelling and moving a term to a different bet stay
ordinary edits.

An **`asset-id` field is a shape plus a candidate set** *(2026-09-05, bead
`ro-x5gu.10`)*. The type only pins the shape, so `shop.exmaple.com` used to be
accepted and book a recurring cost against an asset no row in `assets` has —
money quietly outside the by-asset split of a total that still counted it. The
candidates come from whoever knows, through one rule (`candidateRefusal`, beside
`fieldRefusal`): the Tower passes the integration matrix's asset list, which is
also the picker beside the input, and the pipeline passes the keys of
`integrations.json` `/assets`. The pipeline's set is deliberately the **weaker**
of the two — the store is out of reach here, since `pnpm config:apply` shares
this code and may not open a D1 — so it never refuses an id the browser accepts;
what it catches is the hand-written changeset naming an asset that is in neither.
An empty or absent candidate set means *nobody answered* and refuses nothing.

Two things a declaration deliberately does **not** do. It does not create what a
row points at: adding a `task-hub-spokes` row maps a project, it does not create
that project's Dolt database, which stays an operator step. And it does not
check uniqueness in the pipeline — the Tower refuses a duplicate key beside the
field, before sending, because a duplicate `recurring-costs` id would re-book a
month and the operator should hear that where they typed it.

**Adding a register** is a line in `config-registers.mjs` plus a row in the
table above. The refusals, the CLI, the write lane and the Tower's editor all
follow from the declaration; none of them needs a change.

### The knobs

*(added 2026-09-05, bead `ro-x5gu.8`.)*

A register describes a **list**. Beside those lists sit plain numbers that are
every bit as much settings, in files that are deliberately *not*
wholesale-editable — so until this they were reachable from nowhere at all, and
`/settings` rendered them as read-only rows pointing at their file because a
Save would have been refused.

`CONFIG_KNOBS`, in the same
[`scripts/config-registers.mjs`](../../scripts/config-registers.mjs), declares
them **one pointer at a time**:

| knob | file · pointer | rule | edited on |
|---|---|---|---|
| `panel-refresh-window` | `signal-panels.json` · `/refresh/windowDays` | integer, 1–365 | `/settings` |
| `panel-freshness-bar` | `signal-panels.json` · `/refresh/freshnessMaxAgeDays` | integer, 1–365 | `/settings` |

`counters.json` `/intervalMinutes` was a third, retired by bead `ro-ujb9.222`:
the counters job's schedule is the one place that cadence is written.

Each carries the **same field declaration a register column carries**, so
`fieldRefusal` writes the refusal and the operator reads one sentence rather than
two wordings of it. What changing a value costs is **drawn beside the field** on
`/settings` — the price per pass, the freshness bar's fit inside the window —
rather than written as a paragraph (beads `ro-ujb9.96.6.3`, `ro-ujb9.96.6.17`):
a cadence with no visible cost is an invitation to make the OS read more often
and find out afterwards what that bought.

The permission is **exactly the pointer**. `/refresh/windowDays` is settable;
`/refresh` is not, `/refresh/providerCallsPerPass` is not, and neither is
anything below a knob. That is the whole reason for declaring a pointer rather
than widening `SETTABLE_FILES` for the file: putting `config/counters.json` on
that list would license rewriting every counter card in it, and no surface asks
for that.

**Not declared, on purpose:** `config/beads.json` `/hub` — host, port and
`dataDir` are how `bd` reaches the Dolt server on this machine, wiring rather
than a portfolio setting, and nothing a browser should be able to move.

**Adding a knob** is a line in `config-registers.mjs` plus a row in the table
above; `scripts/config-knobs.test.mjs` then drives every declared knob through
the real pipeline — accepted at its pointer, refused with a value its rule
rejects, refused one level up and one level down — without anybody writing those
three assertions again.

### `store-asset-set`

Sets one editable column on an **asset** row. These are the *only* store-owned
knobs — `db/README.md` sanctions `assets.status`, `assets.sense_only` and
`assets.display_name` as mutable; everything else in the store is append-only.

| field | meaning |
|---|---|
| `asset` | the asset id (`shop.example.com`) |
| `column` | **only** `status`, `sense_only` or `display_name` |
| `expect` | the current value |
| `value` | `status` ∈ `pre-launch \| onboarding \| baselining \| live \| retired`; `sense_only` ∈ `0 \| 1`; `display_name` a 1–80-character label |

**A `status` op writes TWO rows.** The column, and an annotation recording the
move — `kind: "config"`, `ref: "lifecycle:<from>><to>"`, the same string the
Tower writes (bead `ro-3085`), stamped at the same instant on the same lane.
`<from>` is the value the `expect` guard already read, so nothing is re-read
mid-apply. Restore reads the most recent recorded move into `retired` to decide
which stage to bring an archived asset back to; a writer that moved the column
and recorded nothing sent it back to a labelled default instead (bead `ro-mz39`).
Only `status` does this — `sense_only` and `display_name` are settings, not
stages. If the record is refused the run says so on its own line and keeps going:
the column HAS moved by then, and failing the apply over the record of it would
archive nothing and report a change that happened as a change that did not.

Creating an asset ROW is not a changeset op at all. It is `POST /api/assets`
on the Tower, over the ingest binding — see
[the Tower's API](../../apps/tower/README.md#api). Nothing deletes one: the
store is history, and a site's one exit is `status = 'retired'` (bead
`ro-ujb9.76.4.5`).

**The write lane does not accept these** — it answers `422
store_op_not_accepted`, naming the route that does. They are not files, so they
need no filesystem: the Tower writes them with `PATCH /api/assets/:id`,
which reads the row for the same `expect` check and then writes it over the
private INGEST Service Binding, in **every** deployment rather than only the
local one. They stay part of the hand-written changeset vocabulary, which
`pnpm config:apply` still applies.

## The `expect` guard (optimistic concurrency)

`expect` is a migration checksum. Before touching **anything**, the pipeline
resolves every op against current reality and compares it to `expect`. If *any*
op's `expect` doesn't match — a file changed under you, someone else already
flipped that column, the asset is already in that register — the whole changeset
is rejected atomically and nothing is written.

An insert has no `expect` field because its guard is a constant: **absence**. It
resolves the same way as every other op and reports the same way — the mismatch
says `expectAbsent: true` beside the entry that is actually there. A
[first write](#a-first-write-into-a-declared-optional-field) says the same word
going out, which is what makes an absent field's guard checkable at all.

- `config:apply` reports every mismatch and exits non-zero.
- The lane answers `409 expect_mismatch` with the same list, and the field says
  *changed elsewhere — reload to see the current value*.

Undo is not exempt: the Tower's Undo is the same write with the values swapped
and `expect` set to what was *just saved*, so an Undo pressed after somebody
else moved that value is refused in turn rather than quietly reverting their
work too. A first write is the one save with **no** Undo, because putting the
field back means taking the key away and a set only ever writes a value.

## Applying

```bash
pnpm config:apply <file.json>            # apply a saved changeset
pnpm config:apply --stdin <<'CHANGESET'  # heredoc
{ …changeset json… }
CHANGESET

# flags
--dry-run    validate + show the diff, then stop (never prompts, never writes)
--yes        skip the y/N confirmation (for scripted/batch use)
--remote     refused: a deployed installation saves settings and sites in its own Tower
--seed-files edit offline seed files only; does not change saved settings
```

Pipeline, in order: **parse → schema-validate → safety allowlist → resolve +
`expect` check → human diff → y/N → apply → archive → commit hint**. Nothing is
written until the prompt is answered `y` (doc 15 principle 1: show, then ask).
The lane runs the identical steps minus the diff and the prompt, and makes the
commit itself instead of printing the command — a Save in a browser has already
been chosen, and the way back is the Undo in its toast (principle 5).

- Document operations preview the acknowledged database value and version, then
  save through the active ingest runtime. The database rechecks expectations
  and versions after the prompt. The returned documents are exported with stable
  2-space JSON and a trailing newline. Missing seeded documents, unavailable
  reads and ambiguous saves never silently select the exported file.
- `--seed-files` explicitly applies document operations to offline seed files.
  It cannot be combined with asset-column operations. A normal
  database apply also requires asset-column changes in a separate changeset:
  the two destinations cannot be updated atomically.
- A successful database save with a failed export still reports **saved** and
  directs the operator to `pnpm config:export`. Unknown save outcomes require
  checking current settings before retrying. Neither case blindly reapplies.
  A deployed installation's settings and sites are configured in its Tower:
  asset columns are saved on Postgres through the ingest, which keeps D1 in
  step while the store moves, so `--remote` (which wrote a deployed D1
  directly) is refused and changes nothing (bead `ro-ujb9.76.4.2`).
- **A write also refreshes the date a file states about itself** (bead
  `ro-auav`). `config/integrations.json` and `config/signal-panels.json` each
  carry a top-level `updated`; applying any op that touches one sets it to the
  write's day. The database audit records the save time; offline seed mode uses
  the changeset's timestamp.
  The pointer is declared once per file (`DOCUMENT_STAMPS` in
  `scripts/config-registers.mjs`) and stamped by the shared pipeline, so the
  terminal, the browser Save and the deployed Worker all do it. It **refreshes
  and never invents**: a file that states no date gains none.
- **A write also moves a row's decision date** where a register declares one
  (`stamps`, bead `ro-6kd6`). The panel-refresh roster is the case: `since`
  means *when the decision was taken* and `enabled` is the decision, so a set
  that changes `enabled` dates that row. Only a set that actually changes the
  watched field counts — an insert carries its author's own date, a delete has
  no row left to date, and re-saving the same value decided nothing. The
  archive records the op that was **requested**; these two rules are how the
  pipeline answers it, and they are documented here rather than duplicated into
  every changeset.
- Store ops go through the ingest's operator-authed `/api/asset-state` routes on
  the loopback door — the read the `expect` guard makes and the write the apply
  makes, both through the one runtime that owns the local sqlite file. Shelling
  out to `wrangler … --local --persist-to` would start a second one over it,
  which is the 2026-08-02 corruption topology (`ro-mad`, `ro-bko`), and this tool
  is run by hand *beside a live `os:up`*. So a local run needs `pnpm os:up`
  running; `--remote` still uses wrangler, because a production D1 has no local
  file to share. Values are checked against the enum/type here and again at the
  route, since an HTTP body is untrusted.

## Where a Save is refused

The lane is the operator's own dev server, and there is no authentication on the
Tower (doc 10: one operator, LAN-served) — so the boundary is **same origin**: a
request whose `Origin`/`Referer` host is not the server's own `Host` is refused
`403`, which is what stops a page on another site from steering the operator's
browser into a config write. Beyond that: `415` for a non-JSON body, `422` for
anything the allowlist or the schema refuses, `409` for a stale `expect`.

A **deployed** Tower saves through its private ingest service binding into
`config_documents` and `config_changes`. It does not need a filesystem to save.
An unavailable configuration store produces a refusal, not a fallback file edit.

## Archive

Every *applied* changeset is copied to `installation/changesets/NNNN_<slug>.json`
— one installation's history, never the product's (bead ro-ujb9.125) —
(zero-padded, next number after the highest already there) — migration-style, an
honest audit artifact, and **the record whichever entry point applied it**. The
archive is committed alongside the files it changed: `config:apply` prints the
exact one-liner for the operator to run, and the lane makes that commit itself,
subject `config: <slug> via Tower`, with a pathspec so it takes its own two
files and nothing else the operator happened to have staged. It never pushes.

Archived changesets accumulate as history. A revert is just another changeset
(the inverse ops), archived as the next number — the trail shows both the change
and its undo, including the ones an Undo toast made.
