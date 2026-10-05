# config/value-events.json — the events an asset calls value, per asset

> **Seed and export, not source of truth** (2026-09-09, D22):
> `pnpm config:seed` loads this installation's copy (else this generic default)
> into the store's `config_documents` table, the running OS reads and saves it
> there, and `pnpm config:export` writes it to `installation/` for review. Report analysis requires a valid saved document; an
> unseeded, unavailable or malformed configuration stops analysis before output
> files are replaced. It never substitutes this export for the saved document.

Which GA4 events each asset considers a **value event**: the things that, if
they happen, mean the product did part of its job. The `value-event-not-key-event`
rule in [`scripts/signal-insights.mjs`](../scripts/signal-insights.mjs) compares
this declaration against what GA4 actually counts as a **key event** and warns
when the two disagree.

This document is config, not data. It records an intent (*this is what matters here*)
that no provider can infer; the observations stay in the immutable archive.

The analyzer records the acknowledged document version as
`summary.json` → `configuration.valueEventsVersion`. Panel refresh passes its
selected service address and token to the analyzer, so declarations and report
data come from the same installation. Current declarations select comparison
warnings; they do not rename archived events or alter their recorded counts.

## Why it exists

One site's `calculation_complete` — the asset's core value event, 1,989
events in five days — carried `keyEvents = 0` for months while `auth_complete`
carried 142, and nothing in the OS noticed. A value event that is not a key event
does not read as a small conversion number: it reads as **zero**, in every
conversion-flavored card, forever. The `ai-referral-floor` card's "Key events: 0"
evidence row was that misconfiguration, presented as user behavior
(the 2026-07-31 signal audit; private historical evidence,
F4).

## Field contract

- **`assets.<id>.valueEvents[]`** — GA4 event names, verbatim as the asset
  emits them (`calculation_complete`, not "Calculation complete"). Order is not
  meaningful; duplicates are collapsed.
- An asset with **no entry here is silent** — the rule emits nothing. Absence
  is *not declared*, never *nothing to declare*, and an undeclared asset is
  exactly as unchecked as it was before this file existed.
- A declared event **GA4 reported no row for** is unknown, not zero: it could be
  a renamed tag or a quiet week, and there is nothing to compare a key-event
  count against. Only events GA4 reported, above a volume floor, can fire.

## Product use presentation

`assets.<id>.productUseStages[]` selects already saved event-user counts for
Product use on the Growth tab. It does not collect an event, register a
conversion, change a value event or alter a rule. Fresh defaults declare no
stages.

Each row has `eventName`, `label` and `group` (`primary`, `sharing` or
`supporting`). Rows retain their order within each group; the display reads
primary, sharing, then supporting. There are at most 32 stages, with unique
GA4 event names. The portable [stage contract](../packages/contract/src/product-use.mts)
validates stored settings and readers.

```json
{
  "eventName": "document_share",
  "label": "Shared a document",
  "group": "sharing",
  "compareTo": "document_open",
  "comparisonLabel": "Shared of opened"
}
```

`compareTo` names another declared event. Its independent user count is the
denominator; a missing count or zero denominator withholds the comparison.
`comparisonLabel` supplies its heading. These are independent event-user
volumes, not a same-person conversion or funnel. A label without a comparison
has no effect. A missing report row remains unknown; a recorded zero stays zero.
Daily unique users are never added together: this section uses one retained
28-day GA4 aggregate and shows its exact dates.

The GA4 card on Sources edits this list through the existing collection editor.
A first stage creates only its list, or a stages-only asset holder when none
exists. Actual absence and saved-version guards prevent replacing a concurrent
value-event declaration. Undo removes only the stages list. An existing holder
can also receive its first `valueEvents` list without losing presentation.

The hosted action catalog treats only exact stage operations and a validated
stages-only absent-holder insert as ordinary settings. Root/whole-asset
replacement or deletion and neighboring measurement declarations retain their
protected boundary. Applying a prepared mapping to an existing installation is
an explicitly approved operator action; the product never migrates it silently.

## What the rule can and cannot do

- **It only reads.** Both sides of the comparison are operator-owned: this file
  is the declaration, and the GA4 key-event setting is inside the measurement
  channel — `forbidden` class per [AGENTS.md](../AGENTS.md), operator-only
  forever, never promotable on the autonomy ladder. The OS can say the two
  disagree. It cannot say which one is wrong, and it must never edit either.
- **A key-event change applies going forward only.** GA4 does not backfill, so a
  window spanning a change shows both states and the series **steps**. Annotate
  the change date on the asset's timeline; a step is not an anomaly, and the
  zeros before it are not evidence about conversion.

## Semantics worth knowing

- **Declared ≠ instrumented.** Listing an event here does not make it fire. If
  the event is absent from GA4 entirely, that is a collection question for the
  `measurement-integrity` rule, not this one.
- **Key events are a GA4 property setting**, not a per-report flag: the same
  event either counts everywhere or nowhere. That is why one correctly
  configured declared event in the same window is the evidence that separates a
  settings gap from a broken export, and why the card names it.
## Where it is edited

**The asset's Sources tab** (`/assets/<id>/sources`), inside the GA4 lane's own
card — the place that already answers "is this lane working" now also answers
"and what have we told it". Add, rename and remove are one changeset each with
Undo in the toast, and a name is refused against this register's own rule
(`value-events` in [`scripts/config-registers.mjs`](../scripts/config-registers.mjs):
a GA4 event name, verbatim, `^[A-Za-z][A-Za-z0-9_]*$`) before anything is sent.
An asset with no entry shows an empty list with **Add**, and that first row files
the asset's entry — a pointer never creates structure. Guarded changes through
`pnpm config:apply` use the same saved document. Editing an exported JSON file
alone does not change runtime settings.

**The asset page's Delete removes the whole entry** *(2026-09-05, bead
`ro-vyer`)*, listed by name in the confirmation beside every other file the asset
is in. An asset's own GA4 declarations are part of what the asset is, so they
leave with it — before this they stayed behind, silently, naming an id the store
no longer had.

**The add-asset wizard deliberately does not ask.** A value-event declaration is
tuned against what GA4 actually counts, which is a comparison nobody can make on
the day an asset is created: one site's five were named on 2026-07-31, after
an audit of months of collected events. Asking at creation would collect guesses
into a file whose entire purpose is to disagree with GA4 usefully.

## Seeds

A fresh clone declares no value events: an asset with no entry is silent
until its operator names them on its Sources tab.
