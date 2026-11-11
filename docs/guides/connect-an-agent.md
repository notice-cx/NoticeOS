---
title: "Connect an agent"
description: "Give a coding agent on this machine your asset reports and each asset's data panel through MCP, and your tasks through Ntasks."
---

# Connect an agent

This page shows how to connect an AI coding agent, such as Claude Code, to your installation through MCP (the Model Context Protocol). Through NoticeOS's server the agent reads asset reports and queries each asset's search, traffic and product data. It reads and updates the tasks you see on **Tasks** through Ntasks's own MCP endpoint, where it signs in to Ntasks.

MCP is an open standard that lets an AI agent use another program's tools. The Tower serves NoticeOS's tools at `/api/mcp`, beside its own pages; you register that address with the agent once, and from then on it can read how your assets are doing, the way you would in the Tower.

This server lists no task tools: tasks live in Ntasks, so connect the agent to Ntasks's own MCP endpoint for tasks, as [Keep tasks in Ntasks](/guides/keep-tasks-in-ntasks#agents) shows, and to this server for asset reports and panels. Only you can approve work.

## Before you begin

You need:

- A running installation. `pnpm os:status`, or `~/noticeos/noticeos status` without a checkout, shows the app healthy.
- The agent on the same machine.
- For tasks, Ntasks connected in **Settings** > **Task projects**. See [Keep tasks in Ntasks](/guides/keep-tasks-in-ntasks).

## Add the server to the agent

The Tower serves MCP at `/api/mcp` on its own address, the one you open the Tower at. Register that address with the agent. `X-NoticeOS-Actor` names the agent: the board records its changes and claims under that name, and without it they are recorded as `agent`.

```sh
claude mcp add --scope user --transport http noticeos http://127.0.0.1:5173/api/mcp --header 'X-NoticeOS-Actor: claude'
```

You do not need to look up the port: at a terminal, `pnpm os:mcp` (or `~/noticeos/noticeos mcp` without a checkout) prints this line with your installation's port. When it prints a different command, it also prints the reason. `--scope user` registers it once for every repository on this machine, so an agent in an asset's own checkout reaches it too.

Any other MCP client that supports HTTP uses the same address and header, for example in a project's `.mcp.json`:

```json
{ "mcpServers": { "noticeos": { "type": "http", "url": "http://127.0.0.1:5173/api/mcp", "headers": { "X-NoticeOS-Actor": "claude" } } } }
```

### Without the Tower's address

An agent that cannot reach the Tower's address can run the same server itself, over its standard input and output:

```sh
claude mcp add --scope user noticeos -- node /absolute/noticeos-checkout/scripts/stack-control.mjs mcp --actor claude
claude mcp add --scope user noticeos -- ~/noticeos/noticeos mcp --actor claude    # installed with Docker alone
```

### Name the model

Ntasks's instructions ask the agent to pass `model`, the name of the model it runs as, when it files, claims or closes a task. To make sure it does, put the same request in the agent's own instructions, for example a line in the repository's `CLAUDE.md` or `AGENTS.md`:

```md
When you file, claim or close a task, pass `model` with the name of the model you run as.
```

The task records the model beside the agent's name, the Wall's **Live feed** shows it on the agent's lines, and the [Agents](/tower/agents) page groups work by its normalized model name. Missing or unrecognized models share **Other** on that page. The TV's **Agents** widget and Home require a named model.

## What the agent can do

| Tools | What they do |
| --- | --- |
| `list_workspaces` | List the installation's one workspace. It also returns `guideVersion`, the version `get_task_guide` returns now |
| `get_task_guide` | Return where the installation's tasks live: the Ntasks MCP endpoint to connect to, or that no task service is connected. It takes no arguments |
| `list_properties`, `property_report`, `property_history`, `research_lookup` | Read asset reports and stored research. `list_properties` gives each asset's last 28 days in totals: daily revenue per source, each source named with its provider and family, and traffic per provider and metric. `property_history` gives the days behind them for one asset or every asset (`days`, up to 365), and revenue per accounting month by source and booking state (`months`, up to 120) |
| `list_panels`, `get_panel`, `get_search_review`, `query_panel`, `read_panel_document` | Read each asset's published data panel. `get_panel` lists the reports and their freshness. `get_search_review` compares complete weeks and shows tracked-search coverage. `query_panel` runs one read-only SQL `SELECT` against a pinned version. Each version stays readable for 14 days. See [Signal panels](../20-signal-panels.md#how-an-agent-reads-a-panel). |
| `get_journeys`, `save_journey` | On a standalone installation, read and save an asset's Journey definitions. Saving preserves the other journeys and settings. Active funnels join the existing daily GA4 collection; planned journeys are saved without collection. These tools do not fetch provider data |

### Set up journeys by asking the agent

For example: “Check the events we already capture and create a journey from calculator start to a completed result.” The agent reads the asset's panel, checks the event meanings, and uses `save_journey`. You can review the saved steps and results on the asset's **Journeys** tab.

`get_journeys` returns saved definitions, their `edit_token` values and event names from saved configuration. Those event names are suggestions; the panel contains the collected event evidence. `save_journey` takes the asset, a journey with exact event conditions, and `edit_token: null` for a new journey. An update takes the token from the current read. The server assigns measurement versions and rejects conflicting edits. `dry_run: true` validates a proposed change without saving it. Repeating an identical saved definition returns `unchanged: true` without another write.

Each journey has a stable `id`, a short `label`, a `goal`, `kind` (`funnel` or `exploration`), `status` (`active` or `planned`), and two to ten `steps`. Each step has an `id`, a `label`, and `alternatives`: exact `eventName` conditions with a possible `pagePath` and exact event `parameters`. A transition's `withinSeconds` limits elapsed time from the preceding step; it does not require the same session. An asset holds up to eight journeys. A funnel the asset counts itself uses `source: "first-party"` and steps with empty `alternatives`; the asset then sends its daily counts as described in [first-party funnel reports](../reference/first-party-funnels.md).

The same standalone operations have HTTP endpoints:

| Request | Behavior |
| --- | --- |
| `GET /api/assets/:asset/journeys` | Return saved definitions, edit tokens and collection behavior |
| `PUT /api/assets/:asset/journeys/:id` | Save `{journey, edit_token, dry_run?}`; the journey's `id` must match the path |
| `POST /api/integrations/ga4/collect` | Collect active funnels for `{assets: ["example.com"], families: ["journeys"]}` through the GA4 archive collector; the panel refresh publishes the results |

Saving does not establish that a funnel is measurable. Browser and server events must identify the same person, and a completion event must represent the stated outcome. Ordered GA4 users are separate from session exploration, which requires a supported session-path source.

Journey writes use the standalone operator's existing configuration access. Hosted and demo MCP connections do not offer these write tools; protected measurement permissions remain unchanged.

## Tasks

Ntasks serves the task tools and the rules for task work at its own MCP endpoint ([Keep tasks in Ntasks](/guides/keep-tasks-in-ntasks#agents)). Its `get_task_guide` returns the workflow and how to write and close a task.

A repository's own instructions do not repeat the rules; they point at the tools:

```md
- Asset data comes from the `noticeos` MCP server. Before task work, call its `get_task_guide`: it returns which MCP server serves the task tools. When it directs you to Ntasks's MCP endpoint, also call `get_task_guide` on the `ntasks` MCP server and use its task tools.
- Never run `bd`, `bv` or `br`: the MCP task tools are the task interface.
```

`pnpm project:prepare -- --repo <checkout> --write` adds that pointer to a repository's `AGENTS.md`.

## What only you control

- **Approvals.** You approve actions on **Tasks**, which is the Ntasks web app, or in conversation. An agent records an answer you gave in conversation with Ntasks's `reconcile_task`, and Ntasks shows who relayed it.
- **Everything else in [What agents are not allowed to touch](/concepts/tasks-and-agents#what-agents-are-not-allowed-to-touch).**
- **Who may connect.** Anything that reaches the Tower can use its MCP tools, as the Tower's own pages can: this machine by default, and every device on your network once you open the Tower to it. Open it only on a network you trust.

## A hosted workspace

A hosted workspace serves the same tools at its own `/api/mcp` address. The agent signs in there, and you approve the access it asks for; see [Tasks and agents](/concepts/tasks-and-agents#what-ai-agents-do-in-noticeos-today).

## Verify

- In the agent, `list_workspaces` returns one workspace, **This installation**, and a `guideVersion` equal to the `version` from `get_task_guide`.
- `get_task_guide` names Ntasks's MCP endpoint, or shows that no task service is connected.
- `list_panels` lists each asset on the panel refresh roster with a version built in the last day.

## If it didn't work

- **The app is not running**: start it with `pnpm os:start` or `~/noticeos/noticeos start`.
- **The guide shows that no task service is connected**: connect Ntasks; see [Keep tasks in Ntasks](/guides/keep-tasks-in-ntasks).
- **The agent lists no task tools**: tasks come from Ntasks's MCP endpoint; connect it as [Keep tasks in Ntasks](/guides/keep-tasks-in-ntasks#agents) shows.
- **The agent lists only the asset report tools, with no panel tools**: the Tower is running a version older than the one that serves every tool. Update it, or restart a development stack with `pnpm os:restart`.
- **The agent lists no tools**: send one message yourself. `curl -s http://127.0.0.1:5173/api/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'` returns `{"jsonrpc":"2.0","id":1,"result":{}}`; any other response contains the error.

## Next steps

- [Tasks and agents](/concepts/tasks-and-agents)
- [Tasks](/tower/tasks)
