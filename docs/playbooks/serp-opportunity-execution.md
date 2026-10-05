---
id: serp-opportunity-execution
version: 3
origin: "one site's signal audit + DRI/home execution session (2026-07-31); panel-review protocol from a second site's 2026-08-02 panel triage; freeze-aware filing from the first site's 2026-08-05 panel triage"
status: active
---

# SERP opportunity execution — from insight card to shipped fix

The operating loop for turning a `dataforseo-ranking-opportunity` / `search-striking-distance` card (or a ranked-keywords cluster review) into the **smallest correct action** — which is sometimes a copy edit, sometimes an FAQ, sometimes a scheduled content project, and sometimes a documented "no action, this is an authority game." This playbook composes [triangulate-before-acting](triangulate-before-acting.md), [serp-authority-gate](serp-authority-gate.md), and [serp-snippet-standard](serp-snippet-standard.md); it exists so a card is never executed by vibes and never re-derives those methods.

## Use when

- An executive card recommends improving a ranked page, or a ranked-keywords CSV review surfaces a cluster worth chasing.
- Someone is about to edit a title, description, or FAQ "for SEO."
- **A `panel-review` bead appears in a property's tracker.** The NoticeOS runner files one every time that property's **weekly DataForSEO collection** lands ([doc 08 §S1b](../08-seo-geo-signals.md)), due seven days later. **That bead is the trigger**, and closing it is a run of the protocol below, not a tick. A collection nobody triages is money spent on a report nobody reads — one site's went three weeks unread, which is why the bead is filed by a machine instead of remembered by a person.
  - A property **with** a tracked-query panel ([`config/serp-panel.json`](../../config/serp-panel.json)) gets *"Triage the `<YYYY-MM-DD>` serp panel for `<asset>`"*: the collection day is the anchor, and closing it is the [Panel review](#panel-review) walk *and* the [Inventory pass](#inventory-pass) after it.
  - A property **without** one gets *"Triage the `<YYYY-MM-DD>` signal collection for `<asset>`"* — same label, same due date, same metadata — and closing it is the [Inventory pass](#inventory-pass) alone. It still buys five report families every Monday; anchoring the trigger on the panel meant three properties bought collections nobody was ever asked to read (`ro-478`).

## Preconditions

- **The card's numbers re-derived from the archive CSVs**, with quoted-literal / LLM-grounding queries excluded (they are zero-click programmatic traffic and poison CTR/position reads — see the 2026-07-31 audit brief, F2). A card whose evidence dissolves under re-derivation is closed, not executed.
- **DataForSEO credentials** in the property's `.dev.vars`, and the two verified callers in the operator's dataforseo skill (`~/.claude/skills/dataforseo/`): `serp.mjs` (live SERP + AI Overview + PAA) and `keyword-overview.mjs` (batch volume/KD/intent).
- **The property's own `docs/freeze-register.md` has been read before a verdict
  is formed**, and every active entry names the bead that will read the
  measurement back. Missing from the register is unknown, not "clear".
- **The target surface's last content ship has been resolved from its actual
  source paths**, using `git log -1 --format='%cs %h' -- <content sources>` in
  the property repo. Repo-wide recency is not surface recency.
- The target surface is not inside a measurement freeze
  ([freeze-register](freeze-register.md)). If it is, the evidence routes to the
  freeze entry's readback bead; it does not become new copy work.

## Method

1. **Cluster, don't keyword.** Group the property's ranked-keywords rows by `relative_url` and sum modelled demand per page. A card names one query; the page competes on the cluster. (Origin: "dri calculator" was the card at 2.9k/mo; the /dri-calculator cluster is ~17k/mo.)
2. **Pull the live SERP** for the 1–3 head terms: `DEV_VARS=<property>/.dev.vars node serp.mjs "<query>"`. One query per call (the live endpoint rejects batches). Record three things per query: AI Overview present / cites us; the top-10 holders; the People-Also-Ask questions verbatim. **Cost:** ~$0.0035–0.0105 per query — always cheaper than one wrong edit.
3. **Run the [authority gate](serp-authority-gate.md)** over the top ten: classify holders (state/institutional, entrenched brand, commercial thin, tool) and note which results sit between the incumbent and us.
4. **Read measurement state before judging the snippet.** Read the property's
   `docs/freeze-register.md`, resolve the source paths that produce the target
   surface, and record their last content ship from `git log`. Then read the
   current snippet from the built artifact (the prerendered HTML, not the
   source tables — what Google actually sees). A snippet younger than its
   measurement window is not judged; it is measured, and the new evidence is
   annotated on the freeze entry's readback bead.
5. **Branch on the decision rules below.** Ship the smallest edit the branch prescribes.
6. **Verify every claim in new copy against the implementation.** A number the page's own code does not compute is attributed to its published standard, or cut. New FAQ entries must flow through the page's single source of truth so visible copy and FAQPage JSON-LD cannot diverge.
7. **Log the outcome:** ship in a registered cohort ([release-cohort-attribution](release-cohort-attribution.md)), add the head term to the property's `config/serp-panel.json` panel so `aio_present` / rank are tracked — **carrying the cluster label if that property's panel labels anything** (`{ "query": "…", "label": "…" }`; one site's are *Calculator seam · Item head · Guide anomaly · Category head · GLP-1 · Restaurant hubs · Stats hub*, another labels nothing and stays that way) — and freeze the touched snippet for the measurement window.

## Decision rules

- If the AI Overview owns the query **and cites us** → no copy spend; protect and strengthen the cited passage. If it cites competitors only → treat as citation play ([serp-authority-gate](serp-authority-gate.md)), not a CTR play.
- If the query is a **tool/calculator query with no AI Overview** → both rank and CTR are winnable; proceed.
- If everything above us is **state/institutional/reference** (gov, edu, Wikipedia, the incumbent the query names) → close the card as "authority game, no copy action," and route the demand number to the link/reclamation program. Copy cannot outrank a living .gov on its own navigational query.
- If our snippet is **below the standard** → rewrite it per [serp-snippet-standard](serp-snippet-standard.md).
- If our snippet is **already at the standard** → do not churn it (churn resets measurement and risks a working CTR). Spend the effort on on-page depth instead: FAQ entries answering the live PAA questions, and — where honest — an entry that mirrors the #1 result's own name or promise.
- If the target's last content ship falls inside its measurement window →
  **too-recently-changed-to-verdict**. Do not judge the new state against a
  pre-change baseline or file another edit. Route the evidence to the active
  freeze entry's readback bead.
- If the page sits at **position ~21–60 with cluster demand ≥ ~10k/mo and low difficulty** → this is a content/authority project, not a snippet tweak. Schedule it; do not ship a title edit and expect movement.
- If a "matching page" join or landing-page attribution looks locale- or intent-inconsistent → distrust the join; identify the real page from GSC page-query rows before editing anything.

## Panel review

The whole-panel entry point. A card triages one query; this triages the **week's
tracked panel**, row by row. It is the first half of what the auto-filed
`panel-review` bead asks for; the [Inventory pass](#inventory-pass) is the
second. **Only for a property that has a panel** — a *"signal collection"* bead
skips straight to the Inventory pass, and adding this property's head terms to
[`config/serp-panel.json`](../../config/serp-panel.json) is how it earns one —
each entry carrying its **cluster label** where that property's panel labels
anything, since the readout groups by it ([field contract](../../config/serp-panel.README.md#field-contract)).

**Who and by when.** The bead is filed into the **property's own tracker**, so
whoever holds that property owns it, and its **due date is the deadline** —
seven days after the panel day. Past that the panel is being read against a
result page the next collection has already replaced. Nobody else's queue is
involved; if the property has no owner free inside the week, defer the bead with
a reason rather than letting it age silently.

**No bead is not a pass.** If a collection landed and no review bead exists, the
filer failed (`scripts/os-up.mjs`, hourly) — the collection still needs reading,
and the missing bead is its own defect worth reporting. "This property has no
panel" stopped being an explanation on 2026-08-03 (`ro-478`): every property that
buys a collection gets a bead, and only a property that buys nothing gets none.

**Read measurement state before the walk.** Open the property's own
`docs/freeze-register.md` beside the panel. Before any row receives a verdict,
identify the source paths that produce its target surface and run
`git log -1 --format='%cs %h' -- <content sources>` in the property repo. The
verdict must therefore know two facts before it can create work: the surface's
freeze state and its last content ship date/commit. An absent register, an
active entry with no readback bead, or source paths that cannot be resolved is
an unknown to fix, never permission to call the surface unchanged.

**The walk.** Open the flattened panel
(`.local/signal-dumps/reports/<asset>/dataforseo-serp-panel.csv` in NoticeOS,
via `pnpm signals:refresh`) and take **every row**
through the [decision rules](#decision-rules) above. Read `aio_present` as three
states, never two: an unreadable overview is *unknown*, and unknown is treated
exactly like an untracked query — never as "no AI Overview".

**Every row ends in one of five things, and the fifth is not "later":**

1. **A bead in the property's tracker** — a demand-vs-position gap the rules say
   is winnable. State the gap in numbers (query, our position, who holds the top
   three, whether an AIO fires), name the rule that made it winnable, give it a
   first diagnostic step rather than a fix nobody has evidence for, and record
   the target surface's **freeze state plus last content ship date/commit**.
2. **An annotation on a bead that already exists.** When a finding maps to open
   work, it is *evidence for that work*, and filing a second bead beside it
   splits the record. Annotate; do not duplicate.
3. **An explicit no-action note naming the rule that closed it.** Three do most
   of the closing:
   - **institution-locked** — everything above us is state/institutional/
     reference, so copy cannot move it ([serp-authority-gate](serp-authority-gate.md)).
     Route the demand to the link/reclamation program.
   - **AIO-cites-us-protect** — the AI Overview owns the query *and cites us*.
     No copy spend; protect and strengthen the cited passage.
   - **too-young-to-read** — the page has not been live long enough for its
     position to mean anything. Record the age and the date it becomes readable.
4. **Evidence-to-readback (`too-recently-changed-to-verdict`)** — the target
   surface is inside an active measurement window, so annotate the row's new
   evidence on the freeze entry's named readback bead. Do not file new copy work
   against the measured surface. Name the window end and the annotation target
   in the review close.
5. **Nothing** — only for a row already covered by one of the four above in an
   earlier review, and say which.

## Inventory pass

The panel is twenty terms somebody chose. The rest of the week's collection is
everything else the property bought — and until 2026-08-03 nothing ever asked
anyone to read it, so the broad inventory went the way one site's panel had:
collected weekly, read never. The panel review's second half fixes that. It runs
**after** the panel walk, over the same panel dir, in the same review bead.

**For a property with no panel this pass IS the review** (`ro-478`): same bead,
same label, same seven-day deadline, minus a walk it has no file for. Read it
knowing the panel's question — *who else is on the page for the terms we chose,
and does an AI Overview cite us* — is unanswered here, so a term the inventory
says matters is a **candidate panel row**, not just a candidate edit; proposing
it into [`config/serp-panel.json`](../../config/serp-panel.json) is a legitimate
close for this bead.

**Read `freshness.json` and measurement state first.** `freshness.json` is in
every property's panel dir and it
names each lane's newest report date and whether it is stale
([doc 20](../20-signal-panels.md) is the read contract, including the honesty
rules: absent is never zero, provisional days are still filling in, Bing
snapshots are revisions and must not be summed). A lane that is stale is
reviewed as stale — its silence is a collector fact, not a property fact, and
it is worth a bead of its own against NoticeOS rather than a shrug — **unless
the lane has no API and is manual-by-design.** The `bing-webmaster-ai-*`
families are the standing case (owner ruling 2026-08-20, closing `ro-721y`:
Bing offers no programmatic export for AI Performance): when this review finds
them older than ~2 weeks, **requesting the operator export is part of this
review's asks, inside this bead** — the operator pulls the three CSVs from
Bing WMT → AI Performance, the reviewer snapshots them into the property's
`_analytics/` (dated, committed) and runs the property's Bing-window freeze
readbacks from them in the same sitting (reference run: one site,
2026-08-20, readings on mp-f0g.32). No separate bead, no collector defect —
the weekly review bead IS the cadence owner for hand-dropped families. Beside it,
read the property's `docs/freeze-register.md`; before a surface receives a
verdict, resolve its content sources and record the surface-scoped `git log`
date/commit. The panel walk and Inventory pass share this input; the second half
does not earn permission to ignore measurement state.

**Four reads, each with one question and a rule that routes it.** None of them
re-derives the [decision rules](#decision-rules); they feed them.

1. **`dataforseo-ranked-keywords.csv` — what do we rank for at all?** The panel
   cannot answer this: it sees twenty chosen terms to depth 20, and this sees
   the top 200 by modelled demand wherever they sit. Cluster by
   `relative_url` and sum demand per page ([Method](#method) step 1), then look
   only at what the panel structurally cannot show: **pages ranking 11–60 with
   real cluster demand** (the distant-cluster rule), and **demand on terms no
   panel row covers** — those are candidate panel additions, not just candidate
   edits. Anything at 1–10 on a tracked term is the panel's business, not this
   pass's.
2. **`dataforseo-backlinks-summary.csv` + `-new-lost.csv` — is authority
   moving?** New referring domains are the reclamation program's evidence; a
   week of net-lost domains against a page the panel shows slipping is one
   finding, not two. Authority-game verdicts from the panel walk route their
   demand numbers here.
3. **`dataforseo-llm-mentions-google.csv` / `-chatgpt.csv` — do the models
   mention us?** Read as a level against previous weeks, never as a single
   week's score. A property the AI Overview cites (panel) but the mention
   families do not see is a real asymmetry worth a bead; movement inside noise
   is not.
4. **`gsc-*`, `ga4-*`, `bing-webmaster-*` — what did the property actually
   get?** The panel and the inventory are both modelled or provider-observed;
   these are the property's own reported clicks, impressions and behaviour, and
   they are the veto. Exclude quoted-literal / LLM-grounding queries before
   reading CTR or position (Preconditions). A panel finding that this
   contradicts is closed against the contradiction, with the numbers.

**Same five endings** as the panel walk — bead carrying freeze state and
last-ship recency, annotation, named no-action rule, evidence-to-readback for an
active window, or nothing-because-an-earlier-review-covered-it. The one addition: a
finding here can also end in **a panel edit** — a term with proven demand the
panel does not track is added to `config/serp-panel.json` (in NoticeOS, with
the reason recorded where the decision lives), **labelled with the cluster it
measures if that property's panel labels anything**, which is how the panel
stays the twenty terms worth paying for rather than the twenty somebody picked
once.

**On the label.** An entry may be a bare string or
`{ "query": "…", "label": "…" }`, in any mix — the rules are the field contract
and its validation in
[`config/serp-panel.README.md`](../../config/serp-panel.README.md#field-contract)
(non-blank, ≤ 60 characters, and it is never transmitted, so it costs nothing).
It is the **bet the term measures**, and the panel readout groups its rows by
it, so a term added to a labelled panel without one is valid but lands in no bet
— which reads on the Tower as a gap in the scoreboard rather than as the config
omission it is. Reuse an existing cluster wherever one fits rather than minting
a near-synonym: one site's are *Calculator seam · Item head · Guide anomaly ·
Category head · GLP-1 · Stats hub*, and a new cluster is a claim that this term
measures something none of those do. **A property whose panel labels nothing
stays that way**; adding a lone label there would create a
one-term bet beside twenty-seven unlabelled rows. And a rename applies from the
next collection forward only: the archived label is what the observation
recorded, so history keeps the bet it was placed on.

**Closing the review bead** requires a close reason that lists **the beads
filed, the beads annotated, the evidence routed to readback beads, and the rows
deliberately left alone with their rule**, across both halves. Every filed bead
must name its target surface's freeze state and last content ship date/commit.
A review closed with "done" has produced no method capital and cannot be audited
against the next collection; a negative result — a whole week that correctly
produced no beads — is a completed review, not a skipped one.

## Proof and abandonment

Position and CTR on the tracked head terms over 2–4 weeks (GSC + the SERP panel), read against the shipped cohort. **Abandonment:** two shipped, unmoved copy passes on the same query → stop editing; the constraint is authority, and further copy spend is waste. A closed "no copy action" verdict counts as a completed execution, not a skipped one.

## Calibration

- Costs above are DataForSEO list prices observed 2026-07-31; ~$0.02 covered a full three-query cluster triage plus one PAA re-pull.
- Cluster-demand and position thresholds (~10k/mo, pos 21–60) are the origin session's; recalibrate per property economics.
- The panel review's **seven-day deadline** is the collection cadence minus nothing: the panel is weekly, so a review that slips past a week is triaging a superseded result page. A property collected on a different cadence moves the deadline with it.

## Origin evidence (2026-07-31, one site)

- **/dri-calculator** (card: "dri calculator" #11, 2.9k/mo): live pull showed the USDA NAL "DRI Calculator for Healthcare Professionals" **alive at #1** on all cluster queries — killing the orphaned-demand hypothesis — with no AI Overview anywhere and beatable commercial results between NAL and us. Snippet was already at standard → no churn; shipped two PAA-driven FAQ entries instead, including one mirroring the #1 result's own name and one whose figure (130 g carbohydrate RDA) the page does not compute and therefore attributes to the National Academies while describing what the calculator actually shows.
- **Home, navigational cluster** (a two-word brand-like term at 110k/mo and its ".gov" variant at 9.9k): snippet already the standard's reference implementation; the live top 10 for the ".gov" variant was the government site itself, a university, a children's-health publisher, other .gov/.edu pages, Wikipedia ×2 and a name-squatter at #2. Verdict: authority game — zero copy edits shipped, demand routed to the reclamation program. Negative result recorded deliberately.
- **/water-intake-calculator** (~56k/mo cluster, KD 6–22, pos 37–49): matched the distant-cluster rule → scheduled as a content project, not touched in the session.

## Origin evidence — the panel review (2026-08-02, a second site)

The **reference close**, and the shape a `panel-review` bead is expected to
produce. That site's panel (commit `910bf9cd`) had gone three-plus weeks unread; one
pass through the rules turned it into:

- **One bead filed** — `nom-oma.7`, the calculator seam: 4 of 6 calculator
  queries outside the top 20 while thin exact-match microsites hold the top
  three, with **no AI Overview on any of them**. That is the playbook's own
  "tool/calculator query with no AI Overview → both rank and CTR are winnable"
  rule, so it became work rather than a note. Its own diagnosis then ruled out
  indexing, content weight and titles and named off-site authority as the
  blocker (7 referring domains against the incumbents' 12–34), which filed
  `nom-oma.8` and routed the demand number to the link program — the
  institution-locked rule's disposal path, reached from a different direction.
- **Two beads annotated, not duplicated** — `nom-oma.1` and `nom-lrv.3` gained
  the proven citation formula as evidence (both AIO citations we hold are guides
  sitting at position 2), and the `/stats` SERP was recorded as
  institution-locked per the authority-gate taxonomy.
- **Deliberate no-beads** — the three-week-old `/vs` pages, closed
  **too-young-to-read**: their positions do not mean anything yet, and filing
  against them would have manufactured work out of noise.

Cost: ~$0.09 of DataForSEO backlink checks on top of the panel itself.

## Origin evidence — freeze-aware filing (2026-08-05, the first site)

A review that followed the prior protocol still filed three misleading work
items because measurement state was checked only before execution, not before
the verdict that created the work. One proposed snippet surgery already belonged
to a scheduled post-window cohort readback; one said nothing had shipped on a
surface changed five days earlier; one targeted a page under a standing
winning-citation hold. The operator's "when did we last touch these?" question
caught all three. Reading the property's freeze register plus a surface-scoped
`git log` before each verdict turns those corrections into required inputs, and
the evidence-to-readback ending keeps new evidence attached to the experiment it
measures instead of manufacturing competing copy work.

## Related

[triangulate-before-acting](triangulate-before-acting.md) · [serp-authority-gate](serp-authority-gate.md) · [serp-snippet-standard](serp-snippet-standard.md) · [impression-harvest](impression-harvest.md) · [freeze-register](freeze-register.md) · [release-cohort-attribution](release-cohort-attribution.md) · [reclamation-pipeline](reclamation-pipeline.md)
