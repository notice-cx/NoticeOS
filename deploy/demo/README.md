# Run the public demo with Docker Compose

This stack runs the compiled, read-only NoticeOS demo on a Linux server or VM,
including a Proxmox VM. PostgreSQL and Dolt store its persistent synthetic data;
a separate simulator supplies activity. This is a public preview, not customer
account hosting. It uses no Vite development server.

## Before starting

Use Docker with Compose, an exact source commit, and at least 8 GiB free **after**
the planned image/build allocation. Reserve approximately 4 GiB for the first
build plus persistent database growth. The image uses the repository's pinned
Node, pnpm, Beads, Dolt and PostgreSQL versions; no host Node installation is
needed.

Build from the history-free public source export bound to that exact commit.
The supplied commit argument labels provenance; it does not independently prove
the build context matches that commit. Verify the export manifest before building.
The Dockerfile-specific ignore file excludes private state
before the build context is sent.

Choose a public HTTPS origin and a TLS reverse proxy. The proxy must preserve
its exact Host header and browser Origin; forwarding headers cannot select the
application's authority. Only application HTTP is published, on host loopback.
PostgreSQL has no host port; app and setup share Dolt's network namespace so
its plaintext listener stays on `127.0.0.1`.
Only Dolt's shared namespace joins the normal ingress bridge, which permits the
published loopback HTTP port. PostgreSQL joins only the internal private network.
This is not a network-wide outbound firewall; the demo Worker transport refuses
external HTTP, and the task clients disable telemetry and version checks.
Use a proxy on the same VM, or a proxy container sharing Dolt's network namespace.
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
changing an existing service grant. Expired or revoked grants refuse activity.

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

Start only the databases, run the fresh setup once, then start the application:

```sh
docker compose --env-file /operator/demo.env -p demo-preview -f deploy/demo/compose.yaml up -d --wait postgres dolt
docker compose --env-file /operator/demo.env -p demo-preview -f deploy/demo/compose.yaml run --rm setup
docker compose --env-file /operator/demo.env -p demo-preview -f deploy/demo/compose.yaml up -d --wait app
```

Setup applies the committed schema only to its new empty store, creates the
fixed demo workspace and scoped users, seeds its scenario, and writes private
runtime configuration. Partial or unmarked data refuses automatic adoption.
Preserve failed volumes for diagnosis; do not delete them to force a retry.
Repeated completed setup validates and reuses its scenario rather than reseeding.

The app mounts only its state volume. Bootstrap database administrator passwords
stay in the separate bootstrap volume, never in app configuration or environment.
All four volumes are private recovery material, including task client profiles
and application role credentials. Do not publish them or include them in Git.

Check the local gateway with the configured public authority:

```sh
curl --fail --header 'Host: demo.example.com' http://127.0.0.1:16448/__noticeos_health
```

A successful health response is `{ "ok": true }`. Connect through the HTTPS
proxy to explore Sites, Financials, Tasks, Workflows and Settings. The demo banner
identifies synthetic data and its latest successfully completed generation.
Visitor writes and provider actions are refused. Health does not establish that
any remote domain has been deployed or that an expired grant can be renewed.

## Stop, restart and update

Stop without deleting data:

```sh
docker compose --env-file /operator/demo.env -p demo-preview -f deploy/demo/compose.yaml stop app dolt postgres
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
Recreate the namespace owner and application together after stopping them:

```sh
docker compose --env-file /operator/demo.env -p demo-preview -f deploy/demo/compose.yaml up -d --wait --force-recreate dolt
docker compose --env-file /operator/demo.env -p demo-preview -f deploy/demo/compose.yaml up -d --wait --force-recreate app
```

A compatible update reuses runtime configuration and data. Health refusal means
stop and diagnose; never bypass schema, artifact or permission checks. Rollback
to the previous exact image only if the stored schema remains compatible.

## Stopped backup and fresh restore

This preview procedure is a stopped backup, not a nightly backup scheduler.
Back up all four named volumes together after stopping app, Dolt and PostgreSQL.
Create a new private backup directory with mode `0700`; the archive includes
credentials and must remain private. Use the exact application image and mount
only this project's volumes, read-only:

```sh
docker run --rm --network none --read-only --user 0 --entrypoint tar --mount type=volume,src=demo-preview_postgres,dst=/data/postgres,readonly --mount type=volume,src=demo-preview_dolt,dst=/data/dolt,readonly --mount type=volume,src=demo-preview_state,dst=/data/state,readonly --mount type=volume,src=demo-preview_bootstrap,dst=/data/bootstrap,readonly --mount type=bind,src=/operator/new-backup,dst=/backup noticeos-demo:FULL_SOURCE_COMMIT --numeric-owner -czf /backup/demo-data.tar.gz -C /data postgres dolt state bootstrap
sha256sum /operator/new-backup/demo-data.tar.gz
```

Record the archive SHA-256, source/image identity and private operator config
beside the backup. Keep the same PostgreSQL major, Dolt version and source image
for the first restore. Do not use an unverified downloaded archive.

Restore into a **new project and four new empty volumes**, never over an existing
store. Create those volumes explicitly:

```sh
docker volume create demo-restored_postgres
docker volume create demo-restored_dolt
docker volume create demo-restored_state
docker volume create demo-restored_bootstrap
```

Verify the saved archive checksum before extraction. The numeric ownership
preserves PostgreSQL files and the app's UID 1000 private files:

```sh
docker run --rm --network none --read-only --user 0 --entrypoint tar --mount type=volume,src=demo-restored_postgres,dst=/data/postgres --mount type=volume,src=demo-restored_dolt,dst=/data/dolt --mount type=volume,src=demo-restored_state,dst=/data/state --mount type=volume,src=demo-restored_bootstrap,dst=/data/bootstrap --mount type=bind,src=/operator/new-backup,dst=/backup,readonly noticeos-demo:FULL_SOURCE_COMMIT --same-owner -xzf /backup/demo-data.tar.gz -C /data
```

Use the original config and compatible image with `-p demo-restored`; start
postgres/Dolt and then app. Do not run fresh preparation or reseed. Verify health,
same demo/task history and simulator progress before routing visitors to it.
`docker compose down` retains named volumes. `down --volumes` irreversibly removes
them and is only appropriate for a positively owned disposable proof after its
backup/recovery evidence is retained.

For project-wide maintenance and authorization rules, see
[the operations guide](../../docs/06-operations.md) and
[release policy](../../docs/release-policy.md).
