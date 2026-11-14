# Run the public demo with Docker Compose

This stack runs the compiled, read-only NoticeOS demo on a Linux server or VM,
including a Proxmox VM. PostgreSQL and the demo's own Ntasks store its
persistent synthetic data; a separate simulator supplies activity. This is a
public preview, not customer account hosting. It uses no Vite development
server.

The demo's tasks live in its own [Ntasks](https://github.com/notice-cx/Ntasks):
the Ntasks Worker the image builds from the commit
[ntasks.json](ntasks.json) pins, which the `ntasks` service runs in Miniflare
on the namespace's loopback. Its one workspace is the demo's, and visitors
read it with no credential; every change they send is refused. The demo
reaches no other Ntasks.

## Before starting

Use Docker with Compose, an exact source commit, and at least 8 GiB free **after**
the planned image/build allocation. Reserve approximately 4 GiB for the first
build plus persistent database growth. The image uses the repository's pinned
Node, pnpm and PostgreSQL versions and the pinned Ntasks commit; no host Node
installation is needed. Building it fetches that Ntasks commit from GitHub
(`scripts/demo-ntasks-build.mjs`).

Build from the history-free public source export bound to that exact commit.
The supplied commit argument labels provenance; it does not independently prove
the build context matches that commit. Verify the export manifest before building.
The Dockerfile-specific ignore file excludes private state
before the build context is sent.

Choose a public HTTPS origin and a TLS reverse proxy. The proxy must preserve
its exact Host header and browser Origin; forwarding headers cannot select the
application's authority. Only application HTTP is published, on host loopback.
PostgreSQL has no host port; app and setup share the ntasks service's network
namespace so its Ntasks listener stays on `127.0.0.1`.
Only the ntasks service's shared namespace joins the normal ingress bridge, which
permits the published loopback HTTP port. PostgreSQL joins only the internal
private network. This is not a network-wide outbound firewall; the demo Worker
transport and the demo's Ntasks both reject external HTTP.
Use a proxy on the same VM, or a proxy container sharing the ntasks service's
network namespace.
A tunnel can connect to the loopback application port with the same exact Host.
A Proxmox host or separate LXC cannot reach a VM's loopback directly; it needs an
explicit tunnel or a separately reviewed network route.
There is no automatic DNS, TLS,
Cloudflare, Fly, or server provisioning in these commands.

Copy [example.json](example.json) and [example.env](example.env) to a private
operator directory outside the checkout. Set the source's full 40-character
commit, an exact UTC cutoff (`YYYY-MM-DDTHH:mm:ss.sssZ`), and an explicit future
`serviceExpiresAt` within 366 days. The cutoff must not be in the future. The
expiry is the simulator's permission deadline; restarting does not renew it.
Review the expiry before launch and arrange explicit operator maintenance before
it expires. This fresh-only setup does not provide a renewal command or authorize
changing an existing service grant. Once the grant has expired or been revoked,
the simulator's activity is rejected.

Set the env file's exact image tag, absolute config path and unused loopback HTTP
port. Use a new Compose project name. The examples below use `demo-preview`,
`/operator/demo.env` and port `16448`; replace those operator paths consistently.
Never use an existing installation's project or volumes.

## Build and start

Build one immutable image from the same source that is seeded:

```sh
docker build --build-arg NOTICEOS_SOURCE_COMMIT=FULL_SOURCE_COMMIT -f deploy/demo/Dockerfile -t noticeos-demo:FULL_SOURCE_COMMIT .
```

Check the configuration, then generate private bootstrap files offline:

```sh
docker compose --env-file /operator/demo.env -p demo-preview -f deploy/demo/compose.yaml config --quiet
docker compose --env-file /operator/demo.env -p demo-preview -f deploy/demo/compose.yaml run --rm --no-deps prepare
```

Preparation also provisions the demo's Ntasks: its secret, and the statements
and credentials Ntasks's own `provision` command writes for its empty
database (one credential to load the seed, one the simulator changes tasks
through), all in the bootstrap volume. The ntasks service runs them on its
first start.

Start only the databases, run the fresh setup once, then start the application:

```sh
docker compose --env-file /operator/demo.env -p demo-preview -f deploy/demo/compose.yaml up -d --wait postgres ntasks
docker compose --env-file /operator/demo.env -p demo-preview -f deploy/demo/compose.yaml run --rm setup
docker compose --env-file /operator/demo.env -p demo-preview -f deploy/demo/compose.yaml up -d --wait app
```

Setup applies the committed schema only to its new empty store, creates the
fixed demo workspace and scoped users, seeds its scenario, loads the
scenario's tasks into the demo's empty Ntasks through Ntasks's `seed` and
`load` commands, and writes private runtime configuration. Setup stops with an error, and does not adopt the data,
when the store holds partial or unmarked data.
Preserve failed volumes for diagnosis; do not delete them to force a retry.
Running setup again after it has completed validates and reuses its scenario
instead of reseeding.

The app mounts only its state volume. Bootstrap database administrator passwords
and the demo Ntasks's seed credential stay in the separate bootstrap volume,
never in app configuration or environment. All four volumes are private
recovery material, including the simulator's Ntasks credential and application
role credentials. Do not publish them or include them in Git.

Check the local gateway with the configured public authority:

```sh
curl --fail --header 'Host: demo.example.com' http://127.0.0.1:16448/__noticeos_health
```

A successful health response is `{ "ok": true }`. Connect through the HTTPS
proxy to explore Portfolio, Money, Tasks, Workflows and Settings. The demo banner
marks the data as synthetic and shows its latest successfully completed generation.
Under Tasks, **Waiting for you** includes three decisions, one budget approval,
and two checklists. One checklist confirms Pinwell’s collection labels and
the other selects the Weeknight Pantry recipes ready to schedule. Visitors
can read every step. Only a signed-in workspace owner can mark steps in Ntasks.
Its three view choices (**I run the business**, **I build the product**,
**Everything**) redraw every page and the Wall in that view and are kept only
in the visitor's browser.
The Wall's live user counts, with their per-minute bars, and its today-by-hour
chart show synthetic values the demo
derives from each asset's own synthetic daily users; no analytics provider is
called. Its meetings come from a fixed synthetic weekly schedule; no calendar
feed is fetched. The ordinary hosted scheduler runs the demo's scheduled jobs
under the release's job identities: a quarter-hour refresh writes today's provisional
synthetic traffic and search counts, the ad-supported assets' daily estimates
arrive each morning, an hourly freshness check raises and clears the alert for
an asset whose nightly report has stopped arriving, and the task board refreshes every
five minutes. Each asset's weekly task is claimed and closed as `codex` for a
review and as `claude` for a change, with the model and the closer recorded, so
the Agents page and the Wall keep crediting the named agents after the cutoff.
The simulator makes these changes through the demo's one Ntasks credential,
which reaches only the sites' projects, so Ntasks records them as
`service:demo/codex` and `service:demo/claude`. The Tower shows them and the
seeded history's `codex` and `claude` before the cutoff as one agent each,
Codex and Claude Code. The same hourly job runs the release's home-page check against
each fictional asset's synthetic page, so no asset is fetched. Each day one asset
in turn returns HTTP 503 for 25 minutes: the check marks it down and raises its
alert, and the next hour's check marks it up and closes the alert. System health
lists these runs as background operations. The Workflows page
shows three of the release's workflows, each run once as the demo starts and
then every hour: the outcome check reads the demo's own measurement windows;
outcome task updates post each closed comparison's verdict on the task that
holds its reading; and the notifier collects the notifications it would send
and its run is marked skipped, because the demo connects no notification channel. The banner's generation time is the
demo service's latest write.

The demo's pages allow search engines to index them. A shared link to them
shows a preview image of the TV dashboard, at absolute URLs the server fills
from the configured public origin. An installation's own pages are marked not
to be indexed.

Counting the demo's visitors is optional and the operator's choice. To use
Statcounter, set `NOTICEOS_DEMO_STATCOUNTER=project:security` in the private
env file. Both values come from the project's tracking code: `sc_project` and
`sc_security`. Then recreate the app, or run `update.sh`, which keeps the line.
The server adds Statcounter's tag to each page, and the tag counts every in-app
view. When the line is unset, the pages carry no analytics. No account is named in the source.

Each asset has a saved ordered journey on its Journeys tab, with synthetic
visitor totals, step counts and conversion comparisons. Mature assets have
7-day and 28-day periods and twelve complete weeks of history; the weeks-old
product shows only periods since launch. The weekly simulator refreshes these
reports, including improving and declining conversion rates. Session paths
remain uncollected. The Everything Wall keeps Work this week, Attention ticker,
Portfolio, Revenue this month and one Live feed in the release's default layout.

The scenario is versioned. A release whose scenario version differs from a
running demo's rejects that demo's stored scenario at startup. Such a release
needs a fresh setup with a new project name and volumes, which
[update.sh](update.sh) performs by itself as a fresh generation (see
[Stop, restart and update](#stop-restart-and-update)). The scenario holds
five fictional assets, so every Home and Wall view shows data: a subscription
product whose nightly report has stopped, a licensed tool whose saves broke, a
recipe asset whose traffic is rising with its season, an outdoor guide losing
traffic after a redesign the outcome check rejected, and a product weeks old;
two of them have ad income. Last night's synthetic backup failed, open
decisions range from hours to weeks old, and each project's board has work
done this week, in progress and blocked. The work is credited to two named
agents: `claude` builds, records the model it used (Opus 5.5 for urgent work,
Haiku 5.5 for quick fixes, Sonnet 5.5 for the rest), and closes each task with
its commit and the page where the change appears, after `codex` checks it;
`codex` also checks each day's changes. The Agents page shows eight weeks of
their earlier work, and the last 7 days rank the four agent models within a
few points of each other. Each asset except the weeks-old product sends a
weekly codebase report, and the simulator sends the next one on the same
weekday: the recipe asset's code grew 45% in its last 60 days, much of it
copied recipe-card and nutrition components; the outdoor guide's redesign
added 30% to its code in one week and left its old templates unused; the
licensed tool carried a month of unused packages after a library swap, until a
cleanup deploy removed them; the subscription product is written in Ruby, so
its unused code is not measured. The weeks-old product's Codebase tab shows how
to send a first report. The release's own
evaluators produce every alert and verdict from
the synthetic history; none is seeded as a finished result.
Visitor writes and provider actions are rejected: the demo refuses every task
change on its own pages and task tools, and its Ntasks refuses every change
from a visitor. A passing health check does
not show that any remote domain has been deployed or that an expired grant can
be renewed.

Integrations shows Google (Analytics and Search Console), Bing and the ad
network connected through demo connections. A demo connection stores no login,
needs no credential key and fetches nothing. A demo connection counts as
connected only under the server's demo profile and only for the one demo
workspace its configuration names; any other profile or workspace shows the
same providers as not connected. Its syncs are
the collection runs the simulator records: the quarter-hour Google refresh,
Bing's daily report and the ad network's morning report. A run that fails
shows that source failing until the next one succeeds; one asset's Analytics
report is missing for a day every 29 days. The demo keeps no report archive,
so none is monitored.

## Stop, restart and update

Stop without deleting data:

```sh
docker compose --env-file /operator/demo.env -p demo-preview -f deploy/demo/compose.yaml stop app ntasks postgres
```

Allow up to 90 seconds for owned runtime work and database shutdown. Confirm the
project's containers are stopped before backup. Restart the databases, then app,
using the start commands above; do not rerun preparation or create new volumes.

For an update, first take a stopped backup. Build a new exact-commit image and
change only the image tag in the private env file. Confirm its frozen schema and
tool contracts are compatible with the existing store. This path performs **no
existing-store migration**; schema changes require separate operator maintenance.
Keep seed/cutoff/original release unchanged: they identify existing synthetic
history, while the artifact manifest supplies the new application's release.

[update.sh](update.sh) deploys any target commit in one command. It resolves
`main` or an exact commit on the public repository, downloads that source
archive and builds the exact-commit image, then compares the scenario version
and frozen migrations of the release this generation was seeded from (its
configuration's `release`) with the target's. When the demo already runs the
target and is healthy, the script changes nothing; when it runs the target but
is unhealthy, the script deploys it again. A compatible release
takes exactly the steps above: only the image tag changes in the env file, the
namespace owner and then the application are recreated, and health is checked
through the configured public Host. An incompatible release gets a **fresh
generation**: a new Compose project (`demo-g2`, `demo-g3`, …) with new volumes
and its own configuration under `generations/` beside the env file (release =
target, cutoff = now, the rest copied), prepared and seeded by the fresh-setup
steps above and switched in on the same loopback port; the env file then names
the new generation. If the new generation fails its health check, the previous
one is brought back and the command fails with an error that names both commits;
the failed generation's volumes stay for diagnosis until the next update. The
generation a healthy deploy replaced stays stopped with its volumes until the
next update, and the script prints the command that removes it sooner.

Every build adds an image of about 2 GB, and every stopped generation holds its
image (its stopped containers use it) and its four volumes, so the script
removes what no deploy needs. After a healthy deploy it removes every stopped
generation except the one that deploy replaced (`down --volumes`, then its
folder under `generations/`), then the `noticeos-demo` images no container
uses, keeping the new release and the one it replaced, and all unused build
cache. Before building it checks that Docker has 12 GiB free (the artifact
build stops below 10). When it has not, it removes those unused images and the
build cache, then every stopped generation; if that is still not enough it
stops before building, leaves the running demo unchanged and prints
`docker system df`. It never removes the running generation. The
script takes no backup, and after fetching the target source it continues with
that commit's own copy of itself and installs it over the copy it was started
from. Keep a copy outside the checkout and run it from the demo host:

```sh
/operator/update.sh --env /operator/demo.env --source /operator/src
/operator/update.sh --env /operator/demo.env --source /operator/src --commit FULL_SOURCE_COMMIT
```

By hand, recreate the namespace owner and application together after stopping them:

```sh
docker compose --env-file /operator/demo.env -p demo-preview -f deploy/demo/compose.yaml up -d --wait --force-recreate ntasks
docker compose --env-file /operator/demo.env -p demo-preview -f deploy/demo/compose.yaml up -d --wait --force-recreate app
```

A compatible update reuses runtime configuration and data. If the health check
fails, stop and diagnose; never bypass schema, artifact or permission checks. Rollback
to the previous exact image only if the stored schema remains compatible.

## Stopped backup and fresh restore

This preview procedure is a stopped backup, not a nightly backup scheduler.
Back up all four named volumes together after stopping app, ntasks and PostgreSQL.
Create a new private backup directory with mode `0700`; the archive includes
credentials and must remain private. Use the exact application image and mount
only this project's volumes, read-only:

```sh
docker run --rm --network none --read-only --user 0 --entrypoint tar --mount type=volume,src=demo-preview_postgres,dst=/data/postgres,readonly --mount type=volume,src=demo-preview_ntasks,dst=/data/ntasks,readonly --mount type=volume,src=demo-preview_state,dst=/data/state,readonly --mount type=volume,src=demo-preview_bootstrap,dst=/data/bootstrap,readonly --mount type=bind,src=/operator/new-backup,dst=/backup noticeos-demo:FULL_SOURCE_COMMIT --numeric-owner -czf /backup/demo-data.tar.gz -C /data postgres ntasks state bootstrap
sha256sum /operator/new-backup/demo-data.tar.gz
```

Record the archive SHA-256, source/image identity and private operator config
beside the backup. Keep the same PostgreSQL major and source image, which pins its Ntasks,
for the first restore. Do not use an unverified downloaded archive.

Restore into a **new project and four new empty volumes**, never over an existing
store. Create those volumes explicitly:

```sh
docker volume create demo-restored_postgres
docker volume create demo-restored_ntasks
docker volume create demo-restored_state
docker volume create demo-restored_bootstrap
```

Verify the saved archive checksum before extraction. The numeric ownership
preserves PostgreSQL files and the app's UID 1000 private files:

```sh
docker run --rm --network none --read-only --user 0 --entrypoint tar --mount type=volume,src=demo-restored_postgres,dst=/data/postgres --mount type=volume,src=demo-restored_ntasks,dst=/data/ntasks --mount type=volume,src=demo-restored_state,dst=/data/state --mount type=volume,src=demo-restored_bootstrap,dst=/data/bootstrap --mount type=bind,src=/operator/new-backup,dst=/backup,readonly noticeos-demo:FULL_SOURCE_COMMIT --same-owner -xzf /backup/demo-data.tar.gz -C /data
```

Use the original config and compatible image with `-p demo-restored`; start
postgres and ntasks, and then app. Do not run fresh preparation or reseed. Verify health,
same demo/task history and simulator progress before routing visitors to it.
`docker compose down` retains named volumes. `down --volumes` irreversibly removes
them and is only appropriate for a positively owned disposable proof after its
backup/recovery evidence is retained, and for the stopped generations
[update.sh](update.sh) made, which it removes itself as described in
[Stop, restart and update](#stop-restart-and-update).

For project-wide maintenance and authorization rules, see
[the operations guide](../../docs/06-operations.md) and
[release policy](../../docs/reference/release-policy.md).
