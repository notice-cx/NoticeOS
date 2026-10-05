# 16 — Replacing the chat workflow (Ask, Investigations, Commissions)

*The benchmark for these features is empirical: the operator's actual working
week (2026-07-01→05 on one site) — SERP triage, Clarity analysis, an
affiliate integration built from docs to deployed cards, four commissioned
fixes, dozens of portfolio questions — all of it ran through an interactive
chat session. The recurring loop (docs 00–07) doesn't absorb that work; these
seven features do. Same contract as [doc 15](15-operator-flows.md): flows are
specified here before they're built, and the [doc 15 polish principles](15-operator-flows.md#polish-principles-the-visual-intuitive-polished-bar-made-enforceable)
bind every surface below.*

**What deliberately stays in chat:** design partnership, taste arguments,
genuinely novel strategy. The Tower absorbs the recurring 80% — questions,
triage, commissioning, review — so chat is reserved for conversations that
need a peer, not a cockpit. That boundary is a feature; a Tower that tries to
be a general chatbot is neither.

## L. Ask — the operator console (cmd-K)

The single biggest chat replacement: most operator questions aren't
pre-designed dashboard questions.

- **Entry:** cmd-K anywhere in the Tower; also the digest's reply channel.
- **Grounding contract:** answers are computed from the central store +
  doc-11 integrations and **must cite their rows/pulls** (ledger entries,
  signal windows, registry ids — each a deep link). An answer that can't
  cite says *"not in the store"* and names the missing lane — an
  unanswerable question is a data-gap ticket, never a guess. (This is the
  agent-confabulation guard from doc 11 applied to the operator surface.)
- **Tiering (doc 05):** a cheap model operates crystallized query tools
  (store SQL views, quota-aware integration pullers); it escalates to a
  frontier model only when the question needs synthesis/judgment, and the
  escalation is visible ("thinking harder — this one needs the expensive
  model"). Cost logs to `os-overhead`.
- **Every answer carries actions:** *Investigate* (→ flow M), *Make it a
  card* (→ flow O), *Pin to Wall* (ephemeral tile, expires in 7d unless
  promoted to a layout version).
- **Quota honesty:** questions that would burn metered calls (Clarity's
  10/day, DataForSEO) show the cost before running and prefer the last
  snapshot when fresh enough.

## M. Investigations — from anomaly to explained cause

Between "flag fired" and "hypothesis card" lives the diagnostic work chat
does today (the /es/calculadora%3A hunt; the 34%-dead-clicks diagnosis).

- **Entry:** the *Investigate* button on any flag, Ask answer, or registry
  row; or a free-text operator hunch.
- **The run:** a bounded diagnostic dispatch (budget-capped, read-only on
  repos + data lanes, task contract like any other). Its deliverable is a
  **cause report**: what happened, the evidence chain (every claim linked),
  confidence, what was ruled out, and — mandatory — **a proposed regression
  guard** ("this can't silently happen again because…"). The
  root-cause-plus-gate pattern the operator asks for by hand today becomes
  structural.
- **Verdicts:** `explained` (cause + evidence), `partially explained`
  (named unknowns), `not reproducible` — never a shrug. Reports are stored,
  linked from the originating flag, and searchable from Ask.
- **Promotion:** one click turns a cause report into a hypothesis card
  (fix) and/or an invariant/guard proposal (prevention), each carrying the
  evidence with it.

## N. Commissions — one-off work orders (the non-runbook Act lane)

Runbooks cover recurring change-classes; most real improvement weeks are
novel one-offs ("build the CJ integration," "fix these four pain points").
Without this lane, novel work falls back to chat and escapes the ledger.

1. **Brief:** free text + target asset(s) + optional evidence links (an
   investigation, an Ask answer, a scout find).
2. **Plan-back:** the builder returns scope (files/surfaces), approach,
   cost estimate, model tier, risk class, and what it will NOT do —
   the operator approves, edits, or narrows. No build before plan approval
   (novel work is T1-by-definition; doc 05 ladder applies per change-class).
3. **Build under contract:** normal accountability machinery — claims as
   artifacts, verifier re-executes gates, silence ≠ failure and polish ≠
   success (doc 05's independence-of-axes datum).
4. **Review screen:** verified gate results, diff summary in plain words,
   cost actual-vs-estimate, and visual evidence (flow P) — then merge per
   the asset's D2 grant, or stage for the operator's own push.
5. **Ledger + crystallization:** cost logs against the commission's
   change-id; the third commission of the same shape triggers the doc-05
   crystallization rule — propose a runbook, graduate it out of this lane.

> **2026-08-01 — the escape hatch is partly closed.** The concern above
> ("without this lane, novel work falls back to chat and escapes the ledger")
> is now partly answered without Commissions existing. A copied Tower handoff
> — a query decision or a finding — carries a **File this task** section: a
> `bd create` the receiving agent runs in the property's own repo, filing a
> bead on the portfolio task hub with the rule id, the decision key, and the
> asset as labels ([`config/beads.json`](../config/beads.json),
> [task-key-chain](playbooks/task-key-chain.md)). Work handed off this way is
> visible to the portfolio while it is in flight and closes with a note,
> instead of living and dying inside one chat session.
> **Partly**, precisely: a bead is intent and status, not a work order. There
> is no plan-back, no cost estimate against a change-id, no review screen, and
> no crystallization counter — steps 2–5 above are untouched, and a closed
> bead states that something shipped, never that it worked.
>
> **2026-09-04 — filing is a button.** The paragraph above still describes
> where the work goes; what changed is the friction of putting it there. Every
> handoff surface (findings, query decisions, page decisions, and now alert
> rows) carries a **File task** beside its Copy Markdown, which opens a composer
> already holding the title, labels and `reindex_*` metadata that copied
> `bd create` carries and files it through the Tower's local task lane in the
> asset's own spoke (D19, bead `ro-l1ed.4`). Step 1 of a commission — a brief
> against a target asset — is therefore now one click from the evidence that
> provoked it, and no longer needs a terminal or the right working directory.
> Steps 2–5 remain exactly as untouched as they were.

## O. Idea capture — the operator intake

- A global **+** accepts one sentence ("disable Amazon affiliates," "kJ
  toggle for AU") from any surface, including the phone. Nothing else is
  required at capture time — friction at intake kills the habit.
- An enrichment agent turns it into a scored hypothesis card (sizing,
  evidence pulls, cost estimate, suggested class), deduping against the
  queue and registry ("similar to change #214, shipped May — differs
  how?"). It lands in the queue ranked by the same doc-04 policy as
  everything else.
- **Provenance is tracked** (`operator-idea` vs `flag` vs `scout` vs
  `propagation`): Learn reports calibration per source — whether the
  operator's hunches outperform the scout lanes is a number, not a feeling.

## P. Visual evidence — a review standard, not a courtesy

Amends doc 05 §2 (claims are artifacts): **any change touching a user-facing
surface must attach before/after screenshots (desktop + mobile viewports) as
claim artifacts.** Queue cards and registry rows render them inline;
side-by-side with a slider where the diff is subtle. An approve control on a
UI-class change without rendered visual evidence does not exist (doc 15
principle 1: show, then ask). Screenshot capture is itself a crystallized
tool (Playwright shots against the preview build), so builders attach
evidence by calling it, not by improvising.

## Q. Directed research — operator-initiated briefs

Doc 13 covers *ambient* scouting; this is "go research X and come back
cited" ("check the CJ docs and evaluate," "what changed in SEO in 2026").

- Question → bounded deep-research run (the doc-13 expensive lane, per-run
  cap) → a **brief**: findings with sources, confidence, expiry date (all
  research facts are dated facts), and the "so what" for the portfolio.
- Briefs are first-class stored objects: searchable from Ask, linkable as
  evidence from cards/commissions, and staleness-flagged past their expiry.
  (The 2026 SEO/GEO research that reshaped one site's plan is the
  prototype: research → dated doc → decisions cite it.)

## R. Propagation — wins travel across the portfolio

The portfolio's structural edge, currently captured by nobody: a win on one
asset is a ready-made hypothesis for the siblings.

- Registry rows gain a **portable** tag (set by the reviewer at ship time or
  retroactively): what generalizes, what was asset-specific.
- When a portable change's watch window closes with a positive read, Decide
  **auto-drafts sibling cards** — with a transfer discount (the sibling's
  predicted effect shrinks toward the class prior; example.com's recipe-page
  win does not transfer 1:1 to example.org's item pages), each citing the origin
  row.
- Propagated cards compete in the queue like everything else; their
  provenance lets Learn measure the transfer rate — how well wins actually
  travel — which prices future propagation predictions.

## What this sharpens in D1

Ask and Commissions split [doc 12](12-implementation-readiness.md) D1 into
two cleaner sub-decisions: **(a) the cron substrate** (Sense/Decide sweeps,
scheduled runs — cloud, boring, decided by default proposal) and **(b) the
interactive substrate** (Ask answers in seconds; commission plan-backs in
minutes; session-ful, latency-sensitive — this is where "your machine +
subscription vs cloud + API billing" actually bites). The features can ship
Ask-first against substrate (a) with minute-latency answers via the digest
channel if (b) stays undecided — but the cockpit only replaces chat when
answers feel instant.
