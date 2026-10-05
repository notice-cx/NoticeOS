# Config registers, the Wall library and the TV reconnect page without explanatory text

*Bead `ro-ujb9.96.6.17` (epic `ro-ujb9.96.6`), 2026-09-23. When the UX text
gate learned to read every text the Tower renders (`ro-ujb9.96.6.13`), screens
whose own files had reached zero still showed 53 texts from outside
`apps/tower`: the hints and lock reasons of the config registers
(`scripts/config-registers.mts`), per-asset notes in `config/signal-panels.json`,
the Wall widget library and its warnings (`scripts/wall-layout.mts`), the TV
reconnect page and the scheduler's error strings. Doc 21 principle 3a: a field
that needs a paragraph is a field to redesign.*

## Prior art

| Product | Source | Pattern adopted here |
|---|---|---|
| GOV.UK Design System — text input | <https://design-system.service.gov.uk/components/text-input/> | Hint text is "a single short sentence, without any full stops", and never a placeholder. The Add form keeps one hint under each input, and it is now a format or an example (`lowercase-with-dashes: bing-webmaster`, `as charged on the receipt`), not a rationale. |
| Stripe — edit a price | <https://docs.stripe.com/products-prices/manage-prices#edit-price> | "You can't change a price's amount … create a new price for the new amount … then update the old price to be inactive." A recurring cost's monthly amount is now fixed once added; a price change is the row's **To** plus **Add**, two controls already on the table, instead of a sentence under the To column forbidding the edit. |
| Carbon Design System — read-only states | <https://carbondesignsystem.com/patterns/read-only-states-pattern/> | A read-only control keeps its structure and value and drops its interactive parts. A fixed key is its value under a lock, with the state **Fixed once added** as its hover, its screen-reader text and (below `sm`) a one-line key for the table. The Add form marks the same field with the same lock before it is typed. The rationale for each lock stays in the declaration's comment. |
| Grafana — visualizations | <https://grafana.com/docs/grafana/latest/panels-visualizations/visualizations/> | "When you select a visualization, Grafana will show a preview with that visualization applied": the preview explains the choice. Each Wall widget in the library is now its name plus two to five facets (*Errors · Warnings · Waiting on you*); the live preview beside the library shows it the moment it is added. The editor flow itself is `2026-09-23-ux-prior-art.md#arrange-wall`. |

## What replaced each explanation

- **Register hints** (Settings: source catalog, entities, task projects;
  Financials: recurring costs, domain orders; asset Settings: tracked queries,
  panel refresh): a format or example. Clauses that restated what the screen
  shows are gone. The *optional* marker says a field may be blank. The *Per
  month* column shows how a domain order amortizes. The Bet picker and its
  spelling refusal keep one bet spelled one way.
- **Lock reasons** (catalog id, recurring-cost id and amount, domain, entity
  id): the lock and **Fixed once added**. The write lane still refuses the edit.
- **Knob consequences** (`CONFIG_KNOBS`): deleted from the declaration. Nothing
  rendered them since `/settings` started drawing the cost beside each field. The
  facts are comments above each knob.
- **Panel-refresh notes**: the free-text `note` became `task`, the one fact
  nothing else held (the task tracking an off row). Which search sources are
  live, and since when, is on the asset's Sources tab. What turns an off row on
  is its `reason`, and the Tower refuses turning it on before then.
- **Wall warnings**: caution chips naming the state (*Bottom of the TV left
  empty*, *Assets squeezed into a fixed-height row*, *No asset cards on the
  TV*, *No alerts on the TV*). The fix, each row's **Remaining height** or the
  library's **Add**, is already beside them. An empty asset filter now means
  "every asset", as it does when the last box is unticked, rather than being
  refused with a sentence.
- **TV reconnect page**: a pulsing dot, **Tower reconnecting**, **Retrying
  every 5s** and the failing path. "The wall comes back on its own" restated the
  retry. The markup is an escaping `html` template, and the two visible lines are
  constants the gate measures.
- **Scheduler failures**: the runner's status carries a code (`held` /
  `waiting`) instead of a sentence nothing rendered. `/workflows` now tells the
  two apart. The lane's 503 is its `schedules_unavailable` code; `/workflows`
  already shows its own line and a Retry. An unlinked task project's state reads
  "*asset* has no checkout linked on this host"; "complete its local setup"
  named no control.
