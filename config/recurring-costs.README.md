# `recurring-costs.json` — the subscriptions the ledger cannot discover

> **Seed and export, not source of truth** (2026-09-05, D22 — epic `ro-syok`):
> `pnpm config:seed` loads this installation's copy (else this generic default)
> into the store's `config_documents` table, the running OS reads and saves it
> there, and `pnpm config:export` writes it to `installation/` so a diff stays
> the record. Until an install seeds, every read falls
> back to the copy compiled into the Workers and nothing here changes.

This register holds fixed monthly subscriptions that the operator declares
from invoices or statements. Each entry books every month from its start month
through its end month, alongside the ledger's other recorded costs.

## Assign each cost to the asset it supports

Assign a subscription used by one site to that site's asset. Assign tools and
hosting shared across the portfolio to **the OS's own asset**, asset #0.
[Doc 00](../docs/00-objective-and-roi.md) calls this "the system bills itself".
The ledger keeps direct site costs separate from shared operating costs:

```
asset net       = its revenue − its DIRECT cost
portfolio net   = Σ site asset nets − asset #0 overhead
```

This shows each site's performance alongside the cost of running the portfolio,
without distributing shared overhead using an unsupported allocation.

## Where it is edited

**Edit in the Tower: `/financials` → *Declared costs*** (bead `ro-x5gu.2`). The
section sits under *Where the cost comes from*, on the page whose *Stated*
figures these rows produce, and it adds, changes and removes them through the
same validated write lane a settings knob uses — one changeset per action, an
Undo in the toast, and the ledger's month totals recomputed after the save
without a reload. A row the schema refuses (a month that is not `YYYY-MM`, a
negative amount, an `asset` that is not an asset id, an `id` already in the
list) is refused **in the browser, beside the field**, so it never reaches this
file at all.

Outside the Tower, `pnpm config:apply` makes the same store write (D22); the
file in the installation folder is its export, not the place to change it.

## Fields

| field | meaning |
|---|---|
| `id` | stable key. Becomes part of the ledger's idempotency key — **renaming it re-books every month**, so it is fixed once added. |
| `label` | what the charge is called on the statement. |
| `asset` | who carries it. The OS's own asset (#0) for anything portfolio-wide. |
| `family` | a `cost` family from the `ledger` CHECK: `inference`, `api`, `infra`, `operator`, `os-overhead`. |
| `amountUsdPerMonth` | the recurring charge. Fixed once added: every booked month was booked at it (see *Changing an amount*). |
| `from` | first month to book, `YYYY-MM`. |
| `to` | last month, `YYYY-MM`. Omit while the subscription is live. |
| `note` | optional; rides onto the ledger row. |

## Booking

```sh
node scripts/cost-import.mjs --through 2026-08     # recurring + metered data spend
node scripts/cost-import.mjs --through 2026-08 --dry-run
```

Idempotent: replaying books nothing. Everything lands `estimated` — a subscription
is a standing charge, not a reconciled invoice, and calling it reconciled would
erase the figure a real statement is measured against.

## Changing an amount

Do **not** edit a past month's figure here and re-run: the route refuses it as
`conflicting_replay`, correctly, because a booked month is history. A price
change closes the old entry with `to` and adds a new one with a new `id`.

Since 2026-09-23 (bead `ro-ujb9.96.6.17`) that is the only way the Tower offers:
`amountUsdPerMonth` is **fixed once added** — locked on `/financials`, refused
by the write lane — the way Stripe keeps a price's amount and has you add a new
price. The two controls a change needs, the row's **To** and the table's
**Add**, are both on the table, so no sentence under a column forbids the edit.

## Include renewal orders

Recurring subscriptions do not supply domain renewal charges. Record those in
[domain costs](domain-costs.README.md) from the amounts actually paid. If an
order is missing, the corresponding site's direct cost and margin are incomplete.
