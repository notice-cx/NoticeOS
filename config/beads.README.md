# config/beads.json — the task hub's asset ↔ prefix ↔ database map

Beads supplies NoticeOS's common model for internal and external work; Dolt
is its central task authority ([D32](decisions.md)). Future external task
integrations map into this model. New installations provision their own hub
and NoticeOS task project through `pnpm start`; additional projects join the
same hub using the setup below.

Operators manage work on NoticeOS's Tasks page; a supported NoticeOS task API
is planned (`ro-ujb9.260`). Beads and Dolt are internal infrastructure. The
packaged application runtime must bundle `bd`, while Dolt keeps the durable task state.
The CLI and spoke instructions below serve contributors and agent harnesses;
hosted operators will manage work through NoticeOS. The current source-run
prerequisites are listed in the [README](../README.md#run-from-source).

> **Database authority** (2026-09-09, D22): `config/beads.json` is the product
> default (the local hub, no projects) and `installation/beads.json` this
> installation's export. Settings, local task actions, polling and task filers read the saved
> document. The runner does not fall back to an export when the store is absent
> or unavailable. Local checkout links live separately in
> [`task-host.json`](task-host.README.md); deployed responses omit host fields.

Where every portfolio repo's **beads** (tasks) live. One Dolt SQL server — the
**hub** — is a persistent Compose service for new installations
([profile](../db/dolt/host/README.md)). Existing installations can retain their
host-managed service ([legacy profile](dolt-server.README.md)); every repo is a
**spoke**: a `bd` client in server mode holding no database of its own, only
connection settings. This file is the map between the three names the same
project answers to: its **asset id**, its **bead prefix**, and its **database**
on the hub.

The local runner does **not** host the hub — it only health-checks and backs it
up. Tasks stay available while `os:up` is stopped or restarting, which matters
for a store whose job is coordinating work across repos including the runner's
own. See [`config/dolt-server.README.md`](dolt-server.README.md).

Tasks are **operator/agent coordination state, not signals.** Nothing here
enters the pulse envelope or the signal contract
([doc 02](../docs/02-signal-contract.md)); the hub is a second store that sits
beside the ledger, never inside it. A bead is what someone intends to do. A
pulse is what an asset observed. Conflating them would let intent masquerade as
evidence.

## Why it exists

Beads' default is an **embedded** Dolt engine per repo: one writer at a time,
six unrelated databases, no way to ask "what is in flight across the portfolio?"
Server mode swaps the embedded engine for a shared server, which is what makes
concurrent writers — several agents, several repos, at once — safe. Once the
databases are pooled, something has to record which database belongs to which
asset, because the hub itself only knows database names and `bd` only knows
prefixes. The runner's snapshot poller reads saved logical membership and
resolves each project against its explicit host link. The Tower's `/work`
board can then show a bead under the property it belongs to
([doc 10](../docs/10-control-tower.md)).

## Field contract

- **`hub.host` / `hub.port`** — where the server listens. New installations
  bind `127.0.0.1` at the Tower port plus three; the declared Compose profile
  and generated project map agree. The legacy managed host uses port 3308,
  aligned with its `dolt-server.yaml` and runner configuration.
- **`hub.user`** — the MySQL user `bd` connects as. New installations use
  `noticeos` with an installation-local credentials file; the legacy host
  retains its existing account.
- **`hub.dataDir`** — legacy host data-directory metadata. Compose storage
  belongs to the profile's named `dolt-data` volume. Hub contents are runtime
  state, never committed.
- **`spokes[].asset`** — the asset id, verbatim from the `assets` table
  (`noticeos.assets`). This is the join key; a value that
  does not match a seeded asset is a bug, not a new asset.
- **`spokes[].prefix`** — the bead prefix. Bead ids are `<prefix>-<hash>`
  (`sh-1w2`, `sh-33j`), so the prefix is visible in every id an agent ever
  quotes and must stay stable — renaming it rewrites every id in that database.
  **Unique**: two projects sharing a prefix make every id ambiguous.
- **`spokes[].database`** — the database name on the hub. Equal to the prefix
  for all six; `bd` derives it from the prefix unless `--database` overrides it.
  They are separate fields because that equality is a default, not a rule.
  **Unique**: two projects sharing a database merge two backlogs into one board.
  **Reconciled hourly against the hub** (bead `ro-237o`). Local execution also
  requires asset, prefix and database to match the host link exactly. A missing
  or mismatched link leaves that project unavailable while other projects run.
  The task-map lane asks `SHOW DATABASES` and files a `human` bead for a missing
  database, closing it when the declared database exists again. The physical
  backup inventory is independent of workspace membership.
- **`spokes[].repo`** — optional legacy metadata retained for existing document
  history and guarded Undo. Hidden and read-only in Settings; never used for
  execution. Actual checkout paths belong to `task-host.json`.

## Where the map is edited

`spokes[]` is a declared config **register** (`scripts/config-registers.mjs`,
`task-hub-spokes`), so the Tower edits it directly. Fresh setup creates the
NoticeOS project before any user site exists. **Settings → Task projects**
(`/settings#task-hub`) adds, edits and removes a project with the same guarded
write, Undo toast and refusals every other register on that page has. A duplicate
prefix or database is refused there before the request is made, and the asset
column offers the assets no project has claimed yet.

The local service shows the **hub connection** read-only and offers logical
project changes. Hosted builds show the project map read-only and reject task
mapping writes before the store call; other Settings remain editable. Host
paths and connection details are omitted from hosted payloads, including
compiled fallbacks. Adding a row does not provision a database or checkout:
the local page supplies three setup steps for Compose, four for a legacy hub.
Editing an export has no runtime
effect until an explicit guarded configuration apply.

## How a new project joins

Add its logical entry in **Settings → Task projects** on the local service.
Then follow the setup checklist, starting with its command in the project
checkout while the hub is running. For a Compose installation, it calls the
host's `scripts/dolt-project.mjs` helper with the explicit installation and
project paths. The helper supplies the installation's password only to the
initialization process, because the pinned Beads CLI does not read its
credentials file during `init`. No password appears in the copied command.
For example, the legacy managed host uses:

```
bd init --server --external --server-host 127.0.0.1 --server-port 3308 \
  --server-user root --prefix <PREFIX> --non-interactive --skip-agents --skip-hooks
```

For subsequent manual `bd` commands on a Compose installation, set
`BEADS_CREDENTIALS_FILE` to `<start-folder>/dolt/credentials`. NoticeOS supplies
its own task-process environment automatically.

`--external` is what keeps the hub-and-spoke shape honest: without it `bd`
silently **starts its own** Dolt server on a derived port when the configured
one is unreachable, and that project quietly stops sharing the hub while
appearing to work. `--skip-agents` keeps `bd` from writing `AGENTS.md`,
`CLAUDE.md`, `.claude/` and `.codex/` scaffolding into the repo — in this repo
`AGENTS.md` is the context pack and is not `bd`'s to edit. `--skip-hooks` keeps
it from repointing `core.hooksPath` at `.beads/hooks`, which silently disables
whatever hooks the repo already had.

**After legacy `bd init`, fix `.beads/config.yaml`.** The Compose helper already
applies this spoke standard (ro-wkb, proven in nom-z7a), live in every spoke
since 2026-08-02:

1. **No `sync.remote`, ever.** `bd init` writes one pointing at the repo's git
   remote; delete it. With it present, `bd dolt push/pull` has a live target
   and would fork a private, diverging issue store beside the hub.
2. **`no-git-ops: true`** — silences the hook's "no Dolt remote configured …
   repair: `bd dolt push`" advice (that repair is the fork above) and keeps
   `bd` from running its own git operations.
3. **`import.auto: false`** — `import.auto` **defaults to true**: on every git
   pull/merge/checkout `bd` could upsert-import a stale JSONL export into the
   shared hub. The hub is authoritative; automatic imports are always wrong
   here.

The three land **together**: removing `sync.remote` without the key pair
silently arms the reimport hazard. Copy the rationale comments from any
existing spoke's `config.yaml`.

**A spoke is not onboarded until it has `docs/freeze-register.md`.** The file
is property-local because a brief must be able to resolve measurement state
without guessing across repositories. Seed it with explicit Active freezes and
Closed windows sections; "none registered" is valid, omission is unknown. Every
ship that opens a measurement window creates its readback bead first and adds
the exact surfaces, measured change, calendar start/end, and bead id in the same
change. The canonical method is
[`docs/playbooks/freeze-register.md`](../docs/playbooks/freeze-register.md), and
the script suite audits every checked-out entry in `spokes[]`.

**Link the checkout on this host.** Add a matching asset, prefix, database and
repository path to `installation/task-host.json` as described in its
[field contract](task-host.README.md). All three logical fields must agree with
the saved project. The local setup checklist shows the entry to fill in. This
explicit host step grants access to the checkout; a database setting cannot
select an arbitrary directory.

### The spoke stanza

Every spoke's `CLAUDE.md` (and its `AGENTS.md`, where it has one) carries the SAME safety
stanza, byte-identical, under its own repo-specific intro — the invariants that
must survive an agent who never opens this file. The canonical copy lives here
between the markers; `scripts/spoke-stanza.test.mjs` fails the runner suite
when any spoke's copy drifts. Change it HERE first, then re-stamp the spokes
(operator decision 2026-08-03: pointers over symlinks — a symlink dangles
off-machine, a stanza plus this pointer degrades gracefully).

<!-- spoke-stanza:begin -->
- `bd ready` / `bd list` — open work. `bd create` the moment you find new work — never a TODO/follow-up list in docs, notes, or code. `bd update <id> --claim` before building; `bd close <id> -r '<what shipped>'` when done, referencing the bead id in the commit message.
- `bd` is the ONLY task CLI. Never run `br` (it cannot reach the hub and would fork a private store) or `bv` (retired: stale per-repo cache, unsafe `br` commands, no portfolio view). Use `bd ready` / `bd show` for live spoke truth and the Tower `/work` board for portfolio triage.
- If the task hub is unavailable, follow its declared service profile in the full task-hub contract linked below. When `NOTICEOS_DOLT_HOME` selects Compose, never start the retired native hub. Never start a private dolt server, never set `sync.remote`, never run `bd dolt push/pull` — each would fork a private store.
- Beads close the session their work lands: no time-gated acceptance criteria — close on same-day proof, name the recurrence signal in the close reason, and let recurrence file a fresh bead. Too big for one session = a `-t epic` parent with session-sized children.
- Structure: group 3+ related beads under a `-t epic` parent; `bd dep` only for REAL blocking edges (triage ranking trusts them); `bd update --defer` time-blocked work with a reason.
- Needs the operator (a decision, credential, admin step)? Label it `human` — `bd human list` is the operator inbox. A step that must block until approval: `bd gate create --type human`; approval is a gate, never an assumption.
- Work handed off from the ReindexOS Tower arrives as a ready-made `bd create` command carrying `reindex_*` metadata and labels — run it as given and keep the labels; they are join keys.
- Full contract (quality bar, spoke config standard, conventions): `~/dev/reindex-os/config/beads.README.md` — read it before nontrivial filing or closing.
<!-- spoke-stanza:end -->

## Semantics worth knowing

- **The spoke's `.beads/` holds no issues.** It is connection settings plus a
  `README` and a `.gitignore`; the data is entirely on the hub. Deleting a
  spoke's `.beads/` loses nothing but the pointer. Deleting the hub's data
  directory loses every task in the portfolio.
- **The hub must be up before `bd` is useful.** With the service stopped, `bd`
  commands in server mode fail to connect rather than falling back —
  deliberately, per `--external` above. Recover the declared service using the
  [Compose profile procedure](../db/dolt/host/README.md#backup-and-recovery).
  With `NOTICEOS_DOLT_HOME` selected, a missing or invalid profile is an explicit
  recovery condition, never permission to start the old native hub or substitute
  a server. Homebrew recovery applies only to an installation still declared
  against the [legacy native profile](dolt-server.README.md).
  Service changes require approval for the exact target. Stopping `os:up` does
  **not** take the hub down.
- **Prefix ≠ asset id, and both are load-bearing.** `sh` is not
  `shop.example.com` and never will be; this file is the only place the
  two are tied together.

## Task views — and the `br` trap

`bd ready`, `bd list`, and `bd show` read the live hub inside a spoke. The
Tower `/work` board is the cross-project view. D12 retires `bv`: its local
per-repo cache could lag the hub, it had no portfolio coverage, it promoted
human gates, epics, and deferred work, and it emitted unsafe `br` writer
commands. No spoke auto-exports JSONL for a viewer now.

**`interactions.jsonl` is never committed either** (portfolio-wide stance,
decided 2026-08-01, reconfirmed by the operator 2026-08-02; live in all six
spokes plus this repo). It is `bd`'s per-machine append-only interaction audit:
it churns on every `bd` write and would conflict across machines, so it stays
on disk and out of git — every spoke's `.beads/.gitignore` covers it. If a
spoke's tree shows it as modified or untracked, that spoke has drifted from the
stance: re-apply `git rm --cached .beads/interactions.jsonl` + the gitignore
line, never commit the file with your work.

> ⚠️ **`br` (beads_rust) is installed on this machine and must never be run in a
> spoke.** It is a separate SQLite + JSONL implementation with no Dolt backend
> and no server mode, so it cannot reach the hub at all — `br create` here would
> scaffold a private, divergent store inside `.beads/`. **`bd` is the only task
> CLI.**

### The Tower's task lane — the operator's hands, not an agent's

**`bd` is the only write path an AGENT uses.** That has not changed and is not
going to: an agent claims and closes work in the repo where the work happens,
because that is the only place it has the context to be honest about what it
did. A button in a browser does not confer that context.

**The OPERATOR also has a UI** (D19, 2026-09-04, epic `ro-l1ed`). The Tower's
`os:up` dev server carries a local lane — `apps/tower/vite/task-lane.ts`,
serving `/api/tasks/*` and `/api/gates/*` — that runs `bd` for the operator
inside the spoke this file names for the project. It is deliberately narrow:

- **Twelve verbs, checked before anything is spawned.** Reads: `list`, `ready`,
  `show`, `comments`, `epic status`. Writes: `create`, `update` (claim, status,
  priority, assignee, labels, parent, defer, title, description, acceptance),
  `close -r`, `comments add`, `human respond`, `human dismiss`, `gate resolve`.
  Everything else `bd` can do — `delete`, `sql`, `dolt`, `import`, `export`,
  `federation`, `backup` — is refused by name, never attempted.
- **`--actor` is the operator** on every write: the checkout's own
  `git user.name`. So the hub's interaction log and each bead's audit trail keep
  telling the truth about who touched what, which is the entire reason
  [§Claim before you build](#claim-before-you-build) asks an agent to claim as
  itself.
- **Same origin, local only.** `apply: "serve"` means the lane exists only while
  `os:up` is serving; a deployed Tower answers `{live: false}` and `501` and
  keeps the read-only snapshot board.

**Observations are still not commitments.** The lane gives the operator a File
button where there used to be a copied `bd create` command — it replaces the
paste, not the judgment ([§Observations are not commitments](#observations-are-not-commitments)).
That button shipped 2026-09-04 (bead `ro-l1ed.4`) on the findings, query
decisions, page decisions and alert rows, and as **New task** on `/tasks` for
work no finding raised; what it files is spelled out under
[§Handoff metadata](#handoff-metadata).

## Conventions

The hub is the portfolio's **only** register of open work
([AGENTS.md](../AGENTS.md#open-work-lives-in-beads)), so what goes into it has to
survive the session that filed it.

### Claim before you build

Work being actively executed is claimed the moment execution starts:
`bd update <id> --claim` (atomic — sets assignee and `in_progress`,
idempotent), with `--actor` naming who is actually doing it (an agent claims
as itself, e.g. `claude/<agent-name>`, so the audit trail and the board tell
the truth about who holds what). An open bead someone is silently building is
invisible work — the board says "available" while two agents collide on it.
Closing follows completion-is-evidence: the closer cites the commit hash in
the close reason.

### Observations are not commitments

**The analyzer never writes to the register** (decided 2026-08-01). Insight
cards and query decisions are *observations* — regenerated from archives on
every run, appearing and retiring as data shifts and rules retune. A bead is a
*commitment* — someone read the evidence and decided work should happen. The
judgment step between them (running the handoff's ready-made `bd create`) is
the filter that keeps `bd ready` meaning "work somebody chose", not a mirror of
the rule engine; auto-beading every finding would rebuild the stale-backlog
defect inside the hub at analyzer scale, with false-positive cards becoming
false open work. The two sanctioned bridges: findings render their bead once
one exists (`ro-248`, joined by `noticeos_key`), and a warning persisting
across N runs may auto-file one hard-deduped bead (`ro-0fz`, deferred — the
narrow exception, warnings only, never auto-closed).

### Debt findings are a filing duty, not a judgment call

Owner ruling 2026-08-09: when work reveals engineering debt, filing the bead
is a **duty** — the discovering agent does not get to weigh whether it is
"worth" a bead. The classes that trigger it:

- **overengineering that creates double work** — two registries for one
  concept, parallel implementations that must be edited in lockstep, an
  abstraction whose ceremony costs more than the duplication it replaced;
- **logic drift** — copies of one rule that have already diverged, or will
  (a helper and its "build-time mirror", a comment contradicting behavior);
- **hardcoded values that have a canonical source** — a literal where a
  helper/registry exists, a locale/URL/constant baked where a map should be;
- **half-done work** — a helper covering 3 of 5 locales, a feature wired on
  some surfaces and not others, stale "X doesn't exist yet" comments after
  X shipped;
- **clearly missing pieces** a design implies but nobody built.

Filing quality (owner ruling 2026-08-10): every bead must read COLD.
Title = a plain-language claim a stranger could evaluate; description =
what / where / why it matters / what to do in a few self-contained
sentences. Cross-references to other beads are pointers, never
load-bearing — inline the one sentence of context instead. The owner
triages in short bursts; a bead that needs session context to parse
("mp-X's twin in the nav renderer") defeats the register.

This does not conflict with "Observations are not commitments": that rule
keeps the *analyzer* from auto-writing; here a person or agent has already
read the code and recognized debt — the judgment step happened at the moment
of noticing. Low priority is fine (P3/P4); silent non-filing is not. The
anti-patterns remain the usual ones: fixing it silently with no trail,
mentioning it only in a report, or leaving a TODO comment — a noticed defect
that isn't a bead is invisible work waiting to be re-discovered at full cost.

### Docs are not registers — every project doc has a lifecycle ending in deletion

**A repo doc may carry analysis, method, or reference material; it may never carry open-work state** (operator rule, 2026-08-03). And no project doc lives forever: every doc is born with a named reader, a named write trigger, and a named end condition — and its terminal phase is deletion, with git history as the archive. "Useful around the implementation" includes a cleanup phase: when the implementation lands, the doc's scope is audited and the doc is deleted. Status markers inside docs ("awaiting go", tier rankings, sequencing checklists, done/not-done ticks) rot the moment work moves; every future reader either wastes effort keeping them fresh or inherits the drift.

- **File from reality, never from doc markers.** Converting a doc to beads means verifying each candidate against the repo and production (git log, live behavior) before filing; a doc's claim of open work is a lead, not evidence. Skipping it once filed five beads as open work for things already live in production.
- **The terminal phase is audit-then-delete, not tombstone-forever.** A tombstone header ("task state migrated to beads") is an interim marker at filing time, not an end state — tombstoned docs keep getting read and even edited (two agent mistakes on 2026-08-03 alone). The end state: audit every scope item in the doc as shipped (git/prod evidence), captured (bead id), or killed (rule named); parked items become deferred beads; kill decisions move to a durable register (dead-ends pattern); open-bead pointers into the doc get a resolution note (`git show <sha>:<path>`, cheapest as one comment on the epic); then delete the doc in a commit whose message carries the accounting.
- **A doc that stays maintained must name its reader, its write trigger, and its retirement condition.** Registers, buildspecs, and ops logs for live external relationships earn upkeep because a defined consumer reads them at a defined moment and a defined event writes them (freeze-register: "every window-starting ship adds its entry in the same commit") — and even these carry an end condition (the relationship closes, the windows all read out, the pipeline is decommissioned) at which they too are audited and deleted. If you cannot name all three, the doc is a snapshot: put the durable WHY in the epic description and skip the file, or write it knowing it dies at filing time.

### The quality bar

**Title:** outcome-stated, plain language, legible to an operator who never saw
the work. **Description:** self-contained — WHAT, WHY with the numbers, WHERE as
pointers that resolve in a repo (file paths, commit hashes, doc sections, table
and rule names), and **acceptance criteria** naming the proof a completing agent
produces (`--acceptance` is a first-class field: `bd show` renders it and
`bd lint` checks for it). **Never cite a session, a transcript, or an agent's
report** — a future agent cannot open it, so the pointer is dead on arrival;
cite the repo evidence underneath it instead. `bd lint` checks the shape; this
bar is the content. Use `bd lint <id>` without `--json` for a checked count.
Pinned Beads 1.3.1 supports server-mode lint, but its JSON `total` counts
warnings and `issues` counts tasks with warnings, not tasks checked. The
[bundled host adapter](../scripts/host-beads.mjs) refuses JSON lint and treats
failed task lookups as failures, retaining the native diagnostics. A zero
warning count alone does not prove that every requested task was checked.

**Sized to close in one working session** (operator rule, 2026-08-03): a bead's
acceptance criteria must be provable the day the work lands — never "watch for N
days" or any other time-gated verification. If a claim needs absence-over-time
as evidence, close on what was proven today and name the recurrence signal in
the close reason (where to look, what a new occurrence looks like); recurrence
gets a fresh bead. Work too large for a session becomes an epic with
session-sized children, not one long-running bead.

Sections are plain labelled lines — `WHAT:` / `WHY:` / `WHERE:`, plus `ORDER:`
or `CONSTRAINT:` where one applies — not markdown headings, because `bd show`
re-wraps the description and headings read as literal `##`. **One exception:**
`bd lint`'s *bug* template requires a literal `## Steps to Reproduce`, so bug
beads spell that one section its way and keep the rest as labelled lines. Cheaper
than carrying a permanent warning that trains everyone to ignore the linter.
Write paragraphs **unwrapped** — `bd show` wraps to its own width, so hard-wrapped
source double-wraps into ragged output.

### Epics

Related work groups under a `-t epic` bead carrying an operator-readable theme
title and a paragraph on why those members belong together. **Create one when
three or more beads share a theme**, or when the goal is milestone-shaped.
Membership is the hierarchical parent link — `bd create --parent <epic>`, or
`bd update <id> --parent <epic>` for beads that already exist — which is what
`bd epic status` and `bd epic close-eligible` read. An epic is a container; it
holds no work of its own.

### Dependencies

Mark **real** blocking edges when you file: `bd dep <blocker> --blocks <blocked>`,
or equivalently `bd dep add <blocked> <blocker>`. Direction matters and the two
forms take their arguments in opposite orders — read them once before wiring.
**Never invent an edge for tidiness.** The Tower and agents treat dependencies
as load-bearing triage signal, so a decorative edge silently corrupts
prioritization for everyone downstream.
Absence of edges should be deliberate: a leaf is a leaf someone checked, not one
nobody considered. For "these are related, but neither blocks", use
`bd dep relate`.

### Defer

Work blocked on **time** rather than on effort — data accumulating, an external
date, someone else's release — is deferred with a reason, not left cluttering
`bd ready`: `bd update <id> --defer <+4w | YYYY-MM-DD>` (also accepts `+6h`,
`tomorrow`, `next monday`; an empty string clears it). A deferred bead is hidden
from `bd ready` until its date and stays visible in `bd list`. Say *why* in the
description — "deferred" without a trigger is just hiding.

### Human-needed work and gates

Work only the operator can do — a decision, a credential, an admin-console
step, a push — carries the **`human` label** (added 2026-08-01; six chores
labeled that day). `bd human list` is the operator's inbox, priority-ordered;
`bd human respond <id>` answers-and-closes; `bd human dismiss <id>` declines
permanently; `bd human stats` summarizes the queue. An agent that hits an
operator-only step labels the bead instead of burying the ask in a report,
where it dies with the transcript.

Beads 1.1.2 can refuse `human respond` in server mode with
`cannot resolve issue ID: storage is nil` before writing the answer
([pinned command source](https://github.com/gastownhall/beads/blob/v1.1.2/cmd/bd/human.go)).
For that exact failure naming the requested task, the Tower checks that the
task remains active and carries the `human` label, then uses
`bd comments add <id> "Response: <answer>" --actor <operator>` followed by
`bd close <id> --reason Responded --actor <operator>`. These same commands
are the terminal workaround after confirming the task remains active and
human-labelled. Other errors are returned without replaying a write; if closing fails after the
comment is saved, close the task separately instead of resubmitting its answer.

A `human` bead is **written for the operator, not for agents**: plain language
over system vocabulary, no file:line thickets, and wherever possible a
ready-to-paste action (the exact text to apply, the exact command to run) so
acting on it takes a minute, not an investigation. The general quality bar
still applies — but its audience changes, and jargon that would be a pointer
for an agent is noise for the person the bead is asking.

The operator has ADHD; a wall of context loses the reader before the ask
arrives. So a `human` bead follows the **ask-first template** (adopted
2026-08-04, when the whole inbox was rewritten to it):

- **Line 1 is the ASK** — the decision or action, one sentence. The title
  carries it too ("Decide A/B/C: …", "Say 'prep it': …", "2-min edit: …"),
  because `bd human list` shows only titles.
- **TIME / WHEN next** — honest minutes (also `-e <minutes>`), and whether it
  can happen any time or needs a window (a restart, a deadline).
- **A decision is a menu**: lettered options, one marked RECOMMENDED, each with
  its consequence on the same line. Never an essay that ends in "so what do
  you think?".
- **An action is numbered steps** with exact paste-ready text — commands,
  config lines, click paths ("GA4 → Admin → Custom definitions").
- **WHY is one or two sentences of stakes** in plain words. Deep background is
  a single pointer line, never inlined.
- **NEXT: what happens after they answer**, one line — who picks it up and
  what it unblocks.
- **Technical pointers live in a final "(Agent notes: …)" block** — file
  paths, bead cross-references, recipe details. The operator never needs to
  read past its opening parenthesis; the implementing agent starts there.

The test before filing: could the operator act on this from the phone, in one
read, without opening a file? If not, it is not ready for the inbox.

That test failed in practice on 2026-08-19: two decision beads written to this
template still lost the operator, because their WHY and their option menus were
phrased in implementation vocabulary — "saved_calculator_results structurally
cannot hold simple-calc results (calorie_level NOT NULL CHECK 1000-3200)" is a
pointer for the agent who wrote it and a head-scratcher for the person it asks,
who has never reviewed the implementation and will not decode mental shortcuts
taken straight from it. The sharper rule: **describe the situation as the
product thing a user experiences, never as the internals.** "The save system
only knows how to store a full meal plan, so a waist-to-height result has
nowhere to go" — tables, types, constraints, codenames, and internal feature
names stay inside the closing "(Agent notes: …)" block. If a menu option
cannot be stated without naming a table or a type, it is not stated yet.
Alternatives the agent already rejected get one plain line each with their
tradeoff, so the menu shows the real decision space, not just the preferred
door.

**The operator's answer arrives as a comment on the bead** (`bd comments <id>`),
not as a message to whoever filed it. Sweep for unlocks: `bd list --json`
carries `comment_count` (`bd human list` does not), so a `human` bead whose
count moved is likely an answered decision waiting for hands. Reading an answer
obliges acting on it — the session that finds an operator comment executes the
unlocked work (or hands it to an agent) and closes the bead. An answered bead
left open is worse than an unanswered one: the operator reasonably believes it
is moving.

When a step must **block** until approval rather than merely wait its turn,
`bd gate create --type human` mints a gate issue that holds the blocked bead
out of `bd ready` until `bd gate resolve` — approval is a gate, never an
assumption. Other gate types exist (`timer` auto-resolves after `--timeout`;
`gh:run` / `gh:pr` wait on GitHub; `bead` awaits a cross-project bead as
`<project>:<id>`) — the last one is how an `ro-` task honestly waits on an
`mp-` ship. Verify the type against `bd gate --help` before relying on it;
timer/GitHub/bead types were unexercised here as of 2026-08-01.

### Handoff metadata

Beads filed from the Tower's handoff surfaces carry a fixed metadata grammar, so
a finding can be traced back to the rule that produced it: `noticeos_source`
(always `noticeos-handoff`), `noticeos_asset`, `noticeos_kind`, `noticeos_rule`,
`noticeos_key` — plus labels `asset:<id>`, `rule:<slug>`, `key:<slug>`. The
emitter is
[`apps/tower/src/lib/task-handoff.ts`](../apps/tower/src/lib/task-handoff.ts),
and `bd list --metadata-field 'noticeos_key=<exact>'` finds a bead by its origin.
Filing the same class of work by hand? Use the same keys.

**Beads filed before the NoticeOS rename** (2026-09-23) carry the same grammar
under the old names — `reindex_source`, `reindex_asset`, `reindex_kind`,
`reindex_rule`, `reindex_key` and the `reindex-handoff` label — and stay valid
forever: every reader takes either name
([`packages/contract/src/task-metadata.mts`](../packages/contract/src/task-metadata.mts)),
the poller lists both labels (`bd list --label-any`), and an old and a new bead
for one finding are one marker. So to find an old bead by its origin, ask with
`reindex_key`; never rewrite an old bead's metadata to the new names. The
panel-review, unpushed-work and task-map filers' keys changed the same way
(`reindex_panel_*` → `noticeos_panel_*` and so on).

**Four kinds, and what each one's key is.** `noticeos_kind` names the surface
that raised the work, and `noticeos_key` is the join back to the exact row:

| `noticeos_kind` | Surface | `noticeos_key` | `noticeos_rule` |
|---|---|---|---|
| `finding` | the asset page's executive findings | the finding's card key (`ExecutiveInsight.key`) | the same card key |
| `query` | the asset page's query decisions | the normalized query, byte-exact | the decision kind (`recover`, `near-win`, …) |
| `page` | the asset page's page decisions | the absolute page **URL**, never its path — two assets can share `/recipes` | the page decision kind |
| `alert` | `/alerts` and the desk's attention table *(added 2026-09-04, bead `ro-l1ed.4`)* | `flags.id` as a string | the flag's `rule_id` |

`alert` is the one key that is a database id rather than a string the operator
would recognize, and deliberately: one rule fires many times on one asset, and
only the flag id names the *firing* the operator was looking at. The rule still
gathers the family through `rule:<rule_id>`.

**The Tower's File task button is the operator's entry point** *(D19,
2026-09-04, bead `ro-l1ed.4`)*. Every one of those surfaces carries one beside
its Copy Markdown: it opens a composer on exactly the bead the copied `bd create`
describes — same title, same labels, same metadata, computed once in
`taskHandoffPrefill` — and files it through the task lane in the asset's own
spoke. It replaces the paste, not the judgment
([§Observations are not commitments](#observations-are-not-commitments)): a
person still reads the evidence and decides. Copy Markdown stays for **agents**,
which is who it was always for, and is the only path in a deployed build.

Only `query` and `finding` are also `decisions.kind` values (db/0013, narrowed by
db/0021): a page decision and an alert file work but keep no marked/dismissed
display state, so they are handoff kinds without a store-backed disposition.

The list is **stated in six places that ship separately** — the emitter's
`TaskHandoffKind` (`apps/tower/src/lib/task-handoff.ts`), the poller's
`HANDOFF_KINDS` (`scripts/runner/task-snapshot.mjs`), the ingest validator's
`BEADS_HANDOFF_KINDS` (`workers/ingest/src/beads-snapshots.ts`), the Tower
reader's `kind !==` chain in `readHandoff`
(`apps/tower/worker/beads-snapshot.ts`), the shared display type `HandoffKind`
(`apps/tower/shared/asset-detail.ts`), and **the table above** — so widen all
six together. That instruction is only enforceable because
`scripts/handoff-kinds.test.mjs` reads all six and fails `pnpm test:scripts`
naming the odd one out (`ro-4l0q`).

Drift used to be fatal: the validator rejected the whole PROJECT on one
unrecognized row, and a single `page` bead blanked the portfolio's board until
someone noticed. Since `ro-05hb` an unknown kind costs its own row, the rest of
the project stores, and the Worker logs one `beads_handoff_kind_unknown` line
per snapshot naming the kind and the bead — a missing marker instead of an
outage. That made drift survivable at runtime; the guard is what makes it
visible at build time, rather than a marker nobody notices is absent.

The grammar now has a READER as well as an emitter *(2026-08-03, `ro-248`)*: the
`os:up` poller runs `bd list -l noticeos-handoff` against every spoke each minute
and carries `noticeos_key` / `noticeos_kind` / `noticeos_asset` into the beads
snapshot, so the Tower renders a finding's bead — id and open/closed — on the
card that raised it. Three consequences worth knowing before you edit anything
here: the label and those three fields are a **contract with a rendered
surface**, so renaming one silently empties a marker on every finding in the
portfolio; the key must stay **byte-exact in metadata**, because the `key:`
label is a lossy slug that matches nothing; and a bead filed in the **wrong
repo** is dropped rather than shown, since finding keys are rule ids that every
property shares. Filing by hand still works — carry the same keys and the marker
appears within a poll cycle.

## Seeds

A fresh clone declares no projects: `config/beads.json` carries the hub
connection and an empty `spokes` list. An installation's own projects are its
saved task projects and its host links ([`task-host.json`](task-host.README.md));
when and how each was first initialized is that installation's history, kept
in its own folder.
