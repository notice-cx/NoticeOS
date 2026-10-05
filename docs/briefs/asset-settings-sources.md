# An asset's Settings and Sources tabs — state, not explanation

*Bead `ro-ujb9.96.6.4` (epic `ro-ujb9.96.6`), 2026-09-23. The asset Settings
and Data sources tabs carried 139 strings over the Tower's text budget: a
five-paragraph About, a sentence under every fixed field, a paragraph under a
restore button, a footnote under every data source, a "reads/falls back"
paragraph above every mapping, 65 per-asset notes of provenance prose in
`config/integrations.json`, and the config store's save refusals. Doc 21
principle 3a: a step that needs a paragraph is a step to redesign.*

## Prior art

| Product | Source | Pattern adopted here |
|---|---|---|
| GitHub — archiving a repository | <https://docs.github.com/en/repositories/archiving-a-github-repository/archiving-repositories> | Archive is the reversible alternative to delete, and it says what becomes read-only. Archiving an asset lists what stops as three nouns and one kept-state chip (*Everything it recorded is kept*). A Delete the store refuses because the asset has history now offers that same Archive right there, instead of a sentence pointing back up the page. |
| Vercel — build settings *Override* | <https://vercel.com/docs/builds/configure-a-build> | A field shows whether the platform's default or your own value is in force, and "if you update the Override setting, it will be applied on your next deployment". Each data source's mapping now wears one chip: **Mapped here**, or the default it falls back to (*Using the Google account map*, *Matching the asset's domain*, *United States · English*, *Not collected until mapped*), plus when a save applies (*Applies on the next run* / *after a restart*). The two paragraphs per lane are gone. |
| GitHub — dismissing a code scanning alert | <https://docs.github.com/en/code-security/code-scanning/managing-code-scanning-alerts/resolving-code-scanning-alerts> | Dismissing asks for a reason, and the optional comment is short context for the audit trail. A skipped data source's note is its one-line reason, shown as the row's caption; the register caps it at a line, and a Skip without one is refused in five words at the field. |
| Plausible — Search Console integration | <https://plausible.io/docs/google-search-console-integration> | After connecting, "a select box where you can choose which property" — the account's list, not typed ids. The GA4 and Search Console fields keep the connected account's picker; their hints are now formats (`digits only, e.g. 313598867`). |
| Carbon — read-only states | <https://carbondesignsystem.com/patterns/read-only-states-pattern/> | A read-only value keeps its value and drops its controls. The domain and asset id are the value, a lock and **Fixed once added** — the same key a register's locked column wears — instead of a sentence each. |

## What replaced each explanation

- **About these settings** (five paragraphs): deleted. Scope is already each
  card's (Alert rules link to Settings); fixed fields are locked; the archive
  and delete confirmations list their own consequences.
- **Tracked panel bill**: the sentence became chips — *Weekly · Mondays*,
  *2 devices*, *Data cap $25 / month →* — beside the meter. A full panel is
  refused in eight words.
- **Restore**: with a recorded stage the button names it and a chip dates it;
  without one a stage picker set to Live and a *No recorded stage* chip replace
  the paragraph.
- **Data source rows**: the per-asset note is a one-line reason (the register
  caps it); provenance paragraphs are gone from `config/integrations.json` —
  the collector's own runs are the proof, and git keeps the history. A skipped
  source shows its reason as the row caption.
- **Setup and mapping**: step glyphs and labels only; the footnote about what
  the glyphs mean is gone. Field hints are formats or examples.
- **GA4 declarations**: each list's description is its effect in a few words;
  an empty list reads as the state it leaves (*Conversion counts unchecked*).
- **Mediavine revenue**: the schedule and "estimates" are chips; the summary
  vs daily-rows check is one labelled figure; the forecast's three-week need is
  a meter of saved days; the backfill's one-year limit is the date picker's own
  minimum.
- **Save refusals**: the config store's reasons are states (*Config store
  unreachable — saves paused*), shown once where the control is disabled.
