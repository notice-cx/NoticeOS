# `entities.json` — which legal entity owns which assets

> **Seed and export, not source of truth** (2026-09-05, D22 — epic `ro-syok`):
> `pnpm config:seed` loads this installation's copy (else this generic default)
> into the store's `config_documents` table, the running OS reads and saves it
> there, and `pnpm config:export` writes it to `installation/` so a diff stays
> the record. Until an install seeds, every read falls
> back to the copy compiled into the Workers and nothing here changes.

Which legal entity owns which assets — the portfolio-level fact decision
[D5](decisions.md) turns on. Absence is *nobody has said yet*, never *nobody
owns it*.

An asset's owning entity is a **portfolio** fact: it decides which accounts the
money is reported under ([D5](decisions.md)), whose paperwork covers it, and —
the moment there is more than one — how the ledger has to be split. It is not a
fact about any one data source.

## Why it is its own file (bead `ro-aodz`)

Until 2026-09-05 the add-asset wizard wrote it as the first sentence of the
ad-network source's note in [`integrations.json`](integrations.json), because
that is where D5 makes it *matter*. That was useful and undiscoverable: an
operator asking "who owns this asset" had no reason to open a revenue source,
and the fact is portfolio-level rather than per-source. The alternative was a
column on the `assets` table, which is a migration — operator-only, and a
schema change for a fact that changes on a lawyer's schedule rather than the
store's. **The operator chose this register on 2026-09-05.**

So there is exactly one representation of *which entity owns this asset*: the
`assets` list on that entity's row here. Nothing else stores it, and the
ad-network note went back to carrying only what that source needs to be set up.

## Shape

```json
{
  "version": 1,
  "entities": [
    {
      "slug": "example-holdings",
      "name": "Example Holdings LLC",
      "form": "LLC",
      "jurisdiction": "US-DE",
      "assets": ["shop.example.com", "blog.example.com"]
    }
  ]
}
```

| field | meaning |
|---|---|
| `slug` | the stable id this entity is filed under. **Set when the row is created and never renamed** — every record already written down names it by this, so a rename re-labels history rather than correcting it. A change of *name* is the `name` field; a genuinely different legal person is a new row the assets move to. |
| `name` | what the entity is called on its own paperwork — the name every surface shows. |
| `form` | the legal form as the paperwork spells it (`LLC`, `Ltd`, `sole proprietor`). Optional: an entity that has none yet is a real state, and inventing one would be a claim about a filing nobody made. |
| `jurisdiction` | where it is registered (`US-DE`, `Poland`). Optional, for the same reason. |
| `assets` | the asset ids it owns. Optional: a newly declared entity that owns nothing yet is a real state, and so is an entity whose last asset moved away (`[]`). |

**An asset belongs to at most one entity.** Nothing in the file shape enforces
it, because no field of one row can see another; the surfaces that write it do
— `/settings` refuses an asset another entity already claims, and moving one
from the asset's own page is a single change that takes it off the old list and
puts it on the new one.

**The file carries no description of itself** *(2026-09-24, bead
`ro-ujb9.96.6.16`)*: the paragraph above was once a top-level `purpose` string
no screen drew. An installation seeded before then drops it from its store copy
with one guarded `file-json-delete` of `/purpose` (licensed by `RETIRED_KEYS`
in `scripts/config-documents.mjs`), applied with `pnpm config:apply`.

**An empty file is the honest starting state.** The product declares no
entity: a seeded row would be a claim about paperwork nobody has filed. An asset with no entity is *nobody has said
yet*, and every surface says exactly that.

## Where it is edited

**`/settings` → *Entities*** owns the list: add an entity, correct its name,
form or jurisdiction, and remove one. It is a declared register
([`scripts/config-registers.mjs`](../scripts/config-registers.mjs)), so the
table, the Add form and every refusal come from the declaration and the write
lane validates the same rules again.

**An asset's own Settings tab → *Identity*** owns the other direction: a picker
over the entities declared here, which moves that one asset between their
`assets` lists in a single change. The way back is the Undo in the toast.

**Deleting an asset takes its id off whichever list holds it** (bead `ro-xzxg`),
in the same changeset as the register entries that go with it, and the delete
confirmation names this file among the ones it clears. It is a *set* on that
entity's `assets` — the row, the entity and every other asset it owns are
untouched — because an entity is a legal person and outlives the assets it owns.

Outside the Tower, `pnpm config:apply` makes the same store write (D22); the
file in the installation folder is its export, not the place to change it.

## After adding this file to a checkout

The store never gains a document it was not given: `pnpm config:seed` skips
every file it already holds and loads the ones it does not, so an install that
has already seeded needs one more run for this file and nothing else changes.

```sh
pnpm config:seed --file config/entities.json
```
