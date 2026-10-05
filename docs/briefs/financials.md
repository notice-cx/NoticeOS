# Financials — money state without explanatory text

*Bead `ro-ujb9.96.6.9` (epic `ro-ujb9.96.6`, doc 21 principle 3a), 2026-09-23.
Covers `/financials`, the asset Financials tab and the daily revenue panel.*

The screens carried 30 strings over the Tower's text budget: an About with
four paragraphs, a "What this page does not know" panel whose three
paragraphs came from the Worker, five explanation tooltips, a glossary
tooltip on every cost-type chip, and empty states that described where to go
instead of going there. Each told the reader how to interpret a figure the
screen could have drawn. The redesign draws it.

## Prior art

| Product | Source | Pattern | Adopted as |
|---|---|---|---|
| Stripe — Balance summary | <https://docs.stripe.com/reports/balance> | A period's balance is shown as separate figures for its **available** and **pending** parts, each labelled with the state's own word; the report contains only complete days. The difference between the two is not explained on the page, because each figure is named. | **Reconciled** KPI states the checked money as its value and the unchecked money as a second named figure (`$535.60 estimated`), with a two-part bar showing the split. The explanation tooltip, the About paragraph and Net's "includes estimates" suffix are gone. |
| ChartMogul — charts | <https://help.chartmogul.com/article/282-getting-started-with-charts-in-chartmogul> | "Incomplete and future report intervals appear as a dotted line (or striped bars)". The ongoing interval gets a mark, not a caveat, and each point shows its value when selected. | The open month is marked **once**: a `Month to date` chip beside the month picker, with the hollow dot the chart already uses for an unfinished point. Revenue and Cost show the last closed month's full figure (`Aug total $402.39`) where the withheld delta would go. A **partial day** is an outlined bar, and the chart's key counts them (`3 partial days`), replacing the sentence about outlined bars. |
| QuickBooks Online — register reconcile column | <https://quickbooks.intuit.com/learn-support/en-us/reports-and-accounting/c-and-r-in-checking-accounts-plus-the-green-boxes-and-double/00/570158> | Each row carries a one-character reconciliation state (`R` reconciled, `C` cleared, blank = neither) in its own column. A blank means "not yet". There is no legend paragraph. | A dash is the "not yet" state, with its reason on hover: `—` in a Reconciled cell means nothing reconciled yet, and `—` in a Revenue cell means no revenue was reported. Before, that cell showed `$0.00` and a paragraph warned that $0.00 might not mean zero. The payload now includes `revenueReported`, so the row can tell the two apart. |
| Mercury — transactions | <https://support.mercury.com/hc/en-us/articles/28778366589076-Understanding-pending-card-transactions> | A **Pending** badge sits next to the transaction it qualifies. The list filters by posted / pending / failed; the state belongs to the row, not to a help section. | Cost types are short badges in the operator's own words (**Subscription**, **Usage**, **Prepaid yearly**, **No source**). They replace the accountant's labels (Stated / Metered / Amortized / Unclassified), each of which needed a glossary tooltip. The Source column shows the name the operator gave the cost, not the key it is stored under. A domain order whose term ends this month or next shows a `Renews Oct 2026` badge. It replaces the paragraph warning that first-year domain prices understate renewal cost. |

## What replaced each explanation

| Was (words) | Now |
|---|---|
| About ¶1: what the figures are, reconciled vs forecast (47) | Reconciled KPI: value + `$X estimated` + bar |
| About ¶2: the two-tier read, overhead not allocated (68) and the "How asset costs are allocated" tooltip (27) | The by-asset table's own `Assets, direct` / `Portfolio overhead` / `Portfolio net` rows |
| About ¶3: the provisional month (36); "the month is still open" ×2; the month-table tooltip (14) | `Month to date` chip in the header; `○ to date` on the month's table row; the chart's hollow point |
| About ¶4: how deltas work and the 2% floor (31) | Removed: the delta chip shows direction, colour and the grey under-2% state itself |
| Gap "Nothing has reconciled" (40) | Reconciled KPI at `$0.00` with an all-estimated bar |
| Gap "Domain figures are what was paid" (28) | `Renews <month>` badge on a domain order whose term is ending |
| Gap "Not every asset has reported revenue" (35) | `—` Revenue cell (title "No revenue reported") and no share bar |
| Cost-type glossary tooltips (70) | Plain badge labels, human Source names |
| "About cost editing" tooltip (20) | Removed: each field has its own Save, and every save offers Undo |
| Empty ledger: "Connect a revenue source in Integrations and configure operating costs…" (16) | `No money recorded yet` + `Connect a revenue source →` link + the cost registers opened in place |
| Bookmarked month missing: two hints (23, 16) | `Nothing recorded for <month>` + the months as links; no months at all → the first-run state |
| Daily panel: coverage + "only Mediavine estimates…" (16), "N days have partial reports…" (16) | One favicon link per source with `18/21 days` (warn ink when short); the chart's counted partial-day key |
| Daily panel empty: "Daily estimates will appear when…" (13) | `Last report <date>` or an `Ad revenue setup →` link |
| Asset tab About, three paragraphs (66) | Removed; the monthly panel's header links `All assets →`, and the monthly `—` explains itself on hover |

Captures: `docs/artifacts/ux-zero-2026-09-23/i/`.
