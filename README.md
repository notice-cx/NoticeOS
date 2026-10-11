# NoticeOS

[![A sunlit desk beside a bay window overlooking the city and water.](docs/images/noticeos-bay-window.png)](https://www.notice.cx/bay-window.webp)

## Your startup. In clear view.

**A self-hosted operating desk for your websites and software products.**
See traffic, revenue, costs, alerts and work together—on your laptop, phone or TV.

[![CI](https://github.com/notice-cx/NoticeOS/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/notice-cx/NoticeOS/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPLv3-blue.svg)](LICENSE)

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React 19](https://img.shields.io/badge/React-19-20232A?logo=react&logoColor=61DAFB)](https://react.dev/)
[![PostgreSQL 18](https://img.shields.io/badge/PostgreSQL-18-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Dolt 2](https://img.shields.io/badge/Dolt-2-6B45CB)](https://www.dolthub.com/)
[![Docker Compose](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](deploy/compose/README.md)

![NoticeOS brings together traffic and signals, revenue and costs, tasks and workflows, and changes and outcomes.](docs/images/noticeos-overview.svg)

- **Know what needs attention.** See collection failures, unusual traffic and missing evidence.
- **See what earns.** Compare recorded revenue and costs, with dates and coverage kept visible.
- **Keep work moving.** Track owners, blockers, approvals and completion evidence across projects.
- **Check what changed.** Review the follow-up evidence for a change. Completing work is not proof of a better outcome.

The **Tower** is the web app. **Wall** is its at-a-glance TV view.
Missing data stays unknown; it is never silently turned into zero.

## Run from source

For a new installation, the machine needs:

| Requirement | Version or setup |
| --- | --- |
| Node.js | 24.21.0 LTS |
| pnpm | 12.8.1 |
| Docker | A running local engine with Docker Compose |

From a clone on `main`:

```sh
pnpm install --frozen-lockfile
pnpm os:setup
```

Open **[http://127.0.0.1:5173/](http://127.0.0.1:5173/)**. Setup fetches the app
image published for `main` (or builds it when none is published), makes the
installation folder `~/noticeos` with its own secrets, starts
Postgres, the Dolt task hub, the app and its backup worker as one Docker Compose
stack, and points the `pnpm os:*` commands at it. It starts with no user
websites or provider accounts, and existing databases are never touched.

[Install from source](docs/start/install-from-source.md) covers the options;
[Run with Docker](docs/start/run-with-docker.md) covers the folder, changing a
setting with `pnpm os:apply`, moving a legacy installation into it with
`pnpm os:convert-legacy`, and updates. For an
existing installation, read the [upgrade policy](docs/reference/release-policy.md)
before changing its code or database.

## Get your first useful view

1. On **Home**, choose **Add your first site**.
2. Open the site's **Data sources** page and connect a source.
3. Open **Overview** to see its first readings. Use **Tasks** for work and **Wall** for the TV view.

Add provider credentials in the product, where they are encrypted in the store.
Products that send their own metrics use the [report contract](docs/02-signal-contract.md)
and [bootstrap credential setup](docs/06-operations.md#bootstrap-secrets-vs-integration-credentials).

## One shared place for work

**Beads supplies the task model; Dolt stores it in one central hub.**
People and agents coordinate the same tasks across NoticeOS and the projects
it manages, with status, ownership, dependencies, approval gates and evidence.
New installations include a NoticeOS task project, so Tasks works before you
add a website. [Connect a task project](docs/guides/connect-a-task-project.md) walks through
a project's shared tasks, repository access and agent instructions.

Use the **Tasks** page today. A supported task API, installable Claude Code/Codex
skills and hooks, and connections to tools such as Jira or Linear are planned;
they are not available yet.

## Deployment status

| Installation | Use it for |
| --- | --- |
| [Standalone](#run-from-source) | Your own assets, on a trusted network |
| [Docker stack](deploy/compose/README.md) | A prepared installation that runs on its own, from an image or a checkout's live source, controlled with `pnpm os:*` |
| [Docker demo preview](deploy/demo/README.md) | A shared, read-only demo with synthetic assets and ongoing simulated activity |

Standalone has no user login: anyone who can reach it can operate it. Keep it
behind an access proxy, VPN or private network.

The demo package runs the built app, Postgres and Dolt on a Linux server or VM,
including Proxmox. Put its application port behind an HTTPS reverse proxy.
Visitors explore the same product and task model; they cannot change data or
connect real providers. Follow the demo guide for setup, updates and recovery.

Customer account hosting and invitation-based onboarding are not part of this
preview release. Local qualification does not establish a deployed public service.
See the [workspace ownership contract](docs/23-configuration-ownership.md),
[security policy](SECURITY.md) and [release policy](docs/reference/release-policy.md).

## Contribute

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the code map, isolated tests and
review process. Use the public repository's issues and pull requests when
available; access to the maintainers' private task hub is not required.
Report vulnerabilities privately through [SECURITY.md](SECURITY.md).

Useful references: [design docs](docs/README.md) · [operations](scripts/README.md) ·
[repository instructions](AGENTS.md).

## License

Copyright © 2026 Reindex Ventures LLC.

[GNU Affero General Public License, version 3](LICENSE) (`AGPL-3.0-only`).
See [third-party notices](THIRD_PARTY_NOTICES.md) for bundled software and assets.
