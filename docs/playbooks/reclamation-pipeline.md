---
id: reclamation-pipeline
version: 1
origin: "one site's docs/reclamation-targets.md + docs/reclamation-roi-biglist.md (2026)"
status: active
---

# Reclamation pipeline

Turn a dead resource's inbound links into earned authority. When a widely-cited
resource retires, thousands of maintained institutional pages are left pointing
at something that no longer works — and a genuine 1:1 replacement gives their
curators a reason to link to us. This is the highest-conversion outreach that
exists, and it is entirely a service to the person receiving it.

## Use when

- A resource with a large inbound-link footprint is retired, moved, or
  shut down — and we host or can host a genuine replacement.
- An authority analysis says the ranking constraint is links rather than content
  ([serp-authority-gate](serp-authority-gate.md)).

## Preconditions

- **A live replacement page for each dead asset.** No replacement, no pitch.
  The replacement map is built first; outreach without one is spam.
- A backlink index covering the dead target, or (failing that) a search-built
  proxy list of institutional pages that reference the dead assets.
- A human who will write the emails. Use tooling to *find* targets, never to
  *write* pitches.

## Method

1. **Build the replacement map** — every dead asset to the exact page that
   replaces it. Gaps in the map are content candidates, and they are the
   highest-value ones, because demand for them is already proven by the links.
2. **Size the universe**: total broken inbound links, referring domains with at
   least one, and the dead-URL histogram. The histogram doubles as a demand
   ranking of the replacement pages.
3. **Score and rank** (formula below). Pull the top slice by score, drop junk
   hosts, spam, irrelevant top-level domains, and anything already pitched.
4. **Verify each target live before pitching.** Confirm the exact dead link is
   still on the page. Index data ages fast.
5. **Classify pitch strength** — genuinely dead (strongest), retired
   interactive tool, or content-gone-but-URL-resolves. The framing must match
   what the curator will actually see when they click.
6. **Pitch in waves**, human-written, one exact dead link and one exact live
   replacement per email, with a drop-in replacement paragraph in the
   recipient's own phrasing so the fix costs them one paste.
7. **Log every touch** — contact, page, date, status — and reconcile before the
   next wave. The log is what makes the no-double-pitch rule enforceable.
8. **Escalate warm relationships differently.** A domain that already links to
   us is a relationship to deepen, not a cold pitch.

## The scoring formula

```
score = domain_rank × sqrt(broken_count) × fit_weight × maintained_weight
```

- **`domain_rank`** — the referring site's authority.
- **`broken_count`** — that domain's *true institution-wide* total of broken
  links to the dead target, not a sample count. **Square-rooted** so one
  sitewide-link domain does not swamp authority.
- **`fit_weight`** — 1.0 when an example dead URL maps 1:1 to one of our pages,
  0.5 when only the home page fits, 0.6 when unknown.
- **`maintained_weight`** — higher for domains that are actively maintained
  (institutional, publisher); lower otherwise. Coarse, and worth verifying.

## Decision rules

- If no live replacement exists for the dead asset, do not pitch. Build the page
  or drop the target.
- If the dead link is no longer on the page, the target is dead — record it as
  such so nobody re-verifies it next wave.
- If a domain's broken count is large because it aggregates many sub-sites, it
  is a **campaign across many contacts**, not one email. Score it high, plan it
  as a program.
- If a domain already links to us, it is a partnership lever — open with the
  existing relationship, never a cold template.
- If an organization has already been contacted, do not send a fresh cold pitch
  for a different page. Follow up on the existing thread, or write to a
  genuinely different local contact while acknowledging the earlier note.
- If a contact address is not published, do not guess it. Use the published
  office address or the form.
- If an institution replies that it is *deciding* what to adopt, that is the
  highest-value moment in the whole pipeline — prioritize that cluster
  immediately, because the decision window closes.
- If the dead URL now resolves to a placeholder rather than returning an error,
  frame it accurately ("the link lands on a placeholder, the content is gone"),
  not as a 404. An inaccurate premise loses the reply.

## Rules of engagement (the honesty rails)

Each of these was bought with an owner correction; they read as pedantic and are
not:

- Never a mass blast. You are reporting a real broken link, one page at a time.
- Lead with the one credential that answers "who are you to replace this link" —
  as its own sentence, not a parenthetical.
- No em-dashes; they read as machine-written. Plain hyphens or a restructured
  sentence.
- Never fake a reader persona ("I was reading your…" when you were not). "I
  found" / "I came across" is both honest and stronger.
- Describe the destination, not the recipient: "retired", "no longer loads",
  "leads to an error page" — never "dead site", which reads as finger-pointing.
- No hard line-wraps inside paragraphs; mobile mail clients render them ragged.
  One flowing line per paragraph, blank line between, and the "if it's useful"
  offer always its own paragraph.
- Never claim affiliation with the retired resource's owner. Preserved,
  independent, rebuilt from public data — those are the honest words.
- Choose the deep link by audience: educators get the classroom surface,
  clinicians the professional one. Curators link what answers "what do I do with
  this?"

## Proof and abandonment

- Proof is live link updates, tracked per wave with a conversion rate. The
  origin's working expectation for 1:1 dead-resource replacements is **10–20%**;
  unlinked-mention reclamation runs higher.
- Bounces, dead targets, and already-cleaned pages are all data — record them,
  because they age the index and tell you when to re-pull.
- **Abandonment:** if a wave converts far below the band after a clean
  verification pass, the defect is the pitch or the replacement quality, not the
  volume. Fix one and rerun; do not scale a wave that is not converting.

## Cost

The origin's entire sized universe — referring-domain pull, four backlink
offsets, one-per-domain and filtered example pulls — cost **$0.68** total, with
the follow-up ranking run adding **$0.00** by reusing banked data. Bank the raw
pulls; re-ranking should never re-buy the data.

## Origin evidence (2026-06 → 07, one site)

A federal nutrition resource was retired, leaving **189,990 backlinks across
22,553 referring domains, of which 99% were broken**, pointing at 3,348 dead
pages. Filtered to broken and followed: ~156,000 links across 18,400 domains
with at least one.

The first list was built **without** a backlink index at all — by searching for
institutional pages referencing the retired assets, on the reasoning that a page
mentioning a dead tool almost always links it. When a backlink API later became
affordable, that search-built list proved to be a small but valid slice of the
real universe: a proxy list is a legitimate start and does not have to be
discarded when better data arrives.

Verification discipline was bought painfully. A spot check of the three
highest-value clusters found **all three already cleaned or migrated** — the
index sample was three months old. Several first-wave targets were dead
(articles scrubbed, pages removed) while others carried seven live dead links
each. The dead target's own status also changed mid-campaign from "gone" to
"resolves to a placeholder", changing the correct framing of every pitch.

The strongest single signal came from a reply, not a metric: an institution
answered that its campus team had an "ongoing discussion… as to what to use to
replace" the retired resource — the decision window was open *now*, before
curricula locked, and that re-ranked the whole pipeline's urgency. Separately,
the dataset itself became an asset beyond outreach: "thousands of school and
university pages still link to dead government resources, and we have the
receipts" is a verifiable press angle nobody else can source.

## Tooling

*(Added 2026-07-31. The method above is unchanged; this is where the OS keeps
its state.)*

- **The log (step 7)** is `reclamation_targets`
  (`db/migrations/0015_reclamation_targets.sql`): one row per
  `(asset, domain, referring page)`, status through
  `queued → sent → opened → clicked → replied → won`, plus the two exits this
  playbook's decision rules name — `skip` (never pitch) and `dead` (the broken
  link is gone from the page, recorded so nobody re-verifies it next wave).
  `last_verified_at` is step 4's stamp.
- **Loading a campaign:** `scripts/reclamation-import.mjs` loads a target CSV
  through the ingest (`--dry-run` shows it first). Re-running never
  regresses a status a human advanced.
- **Noticing a win:** `scripts/signal-insights.mjs`'s `reclamation-match` rule
  fires when an open target starts sending referral traffic. It asks for the
  check and never marks the win: `won` is human-only, because the conversion
  rate under *Proof and abandonment* is worthless if the pipeline scores itself.
- **Reading it:** the property page's Link outreach funnel
  ([doc 10](../10-control-tower.md)).

## Related

- [serp-authority-gate](serp-authority-gate.md) — what routes work here.
- [kill-thresholds](kill-thresholds.md) — wave conversion floors.
- [freeze-register](freeze-register.md) — replacement pages under measurement
  are frozen.
- [triangulate-before-acting](triangulate-before-acting.md) — index data is one
  source; the live page is the other, and it wins.
