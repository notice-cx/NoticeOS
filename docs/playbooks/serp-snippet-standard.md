---
id: serp-snippet-standard
version: 1
origin: "one site's .claude/skills/editorial-copy/SKILL.md (2026)"
status: active
---

# SERP snippet standard

How a title and meta description are written. A snippet's job is to **remove
every hesitation that our result is the single best result on that page** —
advertiser-grade conviction, never a monotone topic description. The searcher
should finish reading it thinking "this is the one."

## Use when

- Writing or rewriting any title or description that will appear in a search
  result, in any locale.
- Executing an [impression-harvest](impression-harvest.md) fix.
- Launching a surface intended to acquire search traffic.

## Preconditions

- **The live result page for the target query, pulled before writing.** Copy is
  written against the actual competition, not in a vacuum. This is the
  precondition most often skipped and the one that most often makes the
  difference.
- Real inventory to be confident about. The guardrail is **manufactured
  conviction from real inventory** — the crime is mumbling a genuine advantage,
  not exaggerating a fake one.
- The surface is not frozen ([freeze-register](freeze-register.md)).

## Method

1. **Pull the live SERP** and read what the winners promise. Note the phrase
   every competitor repeats — that is the phrase your differentiator must beat.
2. **Name the one thing competitors cannot say.** Free, independent, complete,
   no login, the same method as the retired incumbent. If nothing qualifies, the
   problem is the product, not the copy.
3. **Write the title** ≤ ~60 characters with the payload front-loaded, mirroring
   the query's mental model in the first words.
4. **Write the description** ≤ ~160 characters with **zero title echo** — the
   pair should read as headline plus inventory, not as the same sentence twice.
5. **Check it against the five hesitations** (below); each must die in one
   glance.
6. **Verify at D28 that the engine renders your title** rather than truncating
   or rewriting it. A great title the engine drops is not a shipped change.

## The five hesitations

| # | The searcher's doubt | What kills it |
|---|---|---|
| 1 | "Is this the thing?" | Mirror the query's mental model in the first words. |
| 2 | "Is it still alive?" | An honest recency signal — never implying an edition that does not exist. Never lead with the obituary; retirement is subtext, not the pitch. |
| 3 | "Will it do it FOR me?" | Action verb plus outcome, never a topic description. |
| 4 | "What's the catch?" | Free, no signup, the honest time cost. Effort-urgency, never fake scarcity. |
| 5 | "Why this one?" | The word the competitors cannot say. |

## Decision rules

- If the title exceeds the truncation length, the query echo is what gets cut —
  shorten until the echo survives.
- If the description opens with a question, rewrite it. A question is a
  low-conviction opener; it asks the searcher to supply the confidence.
- If the title leads with an authority we are not, it reads as a secondary
  mirror of that authority while the real one outranks us. Lead with the query
  and the method; keep the source as attribution, not as the pitch.
- One credibility number per snippet. Two is noise.
- If the promise cannot be delivered above the fold on landing, either fix the
  landing view in the same change or weaken the promise. Search engines measure
  the return trip: an overpromising snippet buys one click and sells the
  ranking.
- Localized snippets are their own surgery against their own SERP — never a
  translation of the source-language snippet.
- Attribution and honesty rails outrank conviction. Where the property credits a
  source, it credits it; it never impersonates it.

## Proof and abandonment

- Proof is CTR on the **targeted query cluster** at D7/D14/D28 — not sitewide
  CTR ([impression-harvest](impression-harvest.md) sets the metric).
- Abandonment: if cluster CTR has not moved by D28 and the SERP shows an answer
  engine or a different result style winning, stop rewriting. The remaining gap
  is not a copy gap.

## Calibration

Length caps track what the engine currently truncates — verify rather than
assume; ~60 and ~160 characters were the origin's working numbers. The five
hesitations are stable; their answers are per-property, and depend entirely on
having real inventory behind them.

## Origin evidence (2026-07, one site)

The standard was set by the owner as an explicit principle and then applied
across a harvest batch. Its sharpest applications:

- A 72-character title was truncated so that the *tail* rendered and the query
  echo was dropped on the one query the page could win. Rewritten to 56
  characters, query first, differentiator second.
- A page whose old title led with the authority it cites was reading as that
  authority's secondary mirror while the real authority outranked it. The rewrite
  led with the exact query plus the method's signature rule, keeping the
  authority as honest source.
- A description opening "Looking for free diet plans?" was recorded as the one
  copy defect on a page at position ~6.7 with zero clicks — a weak, low-conviction
  opener that also failed to name the wedge that beat the competing apps.
- The guardrail's grounding is real consequence, not taste: an overpromising
  "free" door cost one large company $141M in an FTC action. Conviction is
  manufactured *from real inventory* or not at all.

## Related

- [impression-harvest](impression-harvest.md) — the workflow that calls this.
- [serp-authority-gate](serp-authority-gate.md) — decides whether a snippet is
  the right instrument at all.
- [freeze-register](freeze-register.md) — snippets under measurement are frozen.
