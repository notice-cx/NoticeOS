# `domain-costs.json` — what each asset's names actually cost

> **Seed and export, not source of truth** (2026-09-05, D22 — epic `ro-syok`):
> `pnpm config:seed` loads this installation's copy (else this generic default)
> into the store's `config_documents` table, the running OS reads and saves it
> there, and `pnpm config:export` writes it to `installation/` so a diff stays
> the record. Until an install seeds, every read falls
> back to the copy compiled into the Workers and nothing here changes.

Record paid domain orders in the Tower when names are bought or renewed. Use
your registrar's receipts or export for the amounts and dates; the saved
orders give the ledger a durable record of those costs.

## Where it is edited

**Edit in the Tower: `/financials` → *Declared costs*** (bead `ro-x5gu.2`). The
same section that edits [`recurring-costs.json`](recurring-costs.README.md) is
where an order is added, corrected or removed — through the validated write
lane, one changeset per action, with an Undo in the toast and the month totals
recomputed after the save. It replaced the read-only *Domain schedule* table
that used to sit there: the rows are now stated once, editable, with the
amortization facts a row cannot carry (what has been paid in total, how many
orders are still spreading into the shown month, and what each asset's declared
run rate is) summarised above them.

The `asset` column is a judgement — see the attribution table below — and the
surface exists so that changing one is a save rather than a text edit.

## What was included, and what was not

A registrar's export covers **every** domain the operator holds, across every
venture. Only names that belong to a site in the portfolio are here; another
venture's registrations are not a site's cost, and booking them would
overstate every site's cost.

## Attribution, and which parts are inferred

**Unambiguous** — each site's own domain.

**Inferred** — defensive and variant registrations, grouped by the site they
protect. Each is a judgement, and the `asset` field is one edit away if wrong:

| asset | also carries | why |
|---|---|---|
| `shop.example.com` | `shop-example.com`, `shopexample.net` | a variant spelling plus a defensive TLD, bought the same day |
| the OS's own asset (#0) | the holding entity's own names | portfolio overhead, not a site's cost |

## How it books

A domain is a **prepaid annual term**, so each order amortizes evenly over 12
months from its purchase month and books as an `infra` cost on its asset.
Cash-basis (the whole charge in the month it was paid) was rejected: a premium
name's $109.69 would make one January look catastrophic and eleven months look free,
and monthly margin is the number this ledger exists to make legible.

All of an asset's domains sum into **one** `infra` row per month, under source
`domains` — so the row is one figure per asset per month and stays idempotent.

## The caveat that matters

**A registration price is not a renewal price.** A first-year promotion or
premium name can make the initial charge differ from later renewals. The ledger
records what was actually paid; those amounts alone do not establish the next
renewal's cost. Add renewal orders from their receipts rather than changing
previous orders; a booked month is history.
