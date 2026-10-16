---
title: "Connect an agent"
description: "Give a coding agent on this machine your tasks, site reports and each site's data panel through MCP, with no task tool or credential of its own."
---

# Connect an agent

This page shows how to connect an AI coding agent, such as Claude Code, to your installation through MCP (the Model Context Protocol). The agent reads and updates the tasks you see on **Tasks**, reads site reports, and queries each site's search, traffic and product data. It needs no task tool and no credential of its own.

MCP is an open standard that lets an AI agent use another program's tools. The Tower serves NoticeOS's tools at `/api/mcp`, beside its own pages; you register that address with the agent once, and from then on it can list, file, claim and close tasks and read how your sites are doing, the way you would in the Tower. Only you can approve work.

## Before you begin

You need:

- A running installation. `pnpm os:status`, or `~/noticeos/noticeos status` without a checkout, shows the app healthy.
- The agent on the same machine.
- At least one linked task project. See [Connect a task project](/guides/connect-a-task-project).

## Add the server to the agent

The Tower serves MCP at `/api/mcp` on its own address, the one you open the Tower at. Register that address with the agent. `X-NoticeOS-Actor` names the agent: the board records its changes and claims under that name, and without it they are recorded as `agent`.

```sh
claude mcp add --scope user --transport http noticeos http://127.0.0.1:5173/api/mcp --header 'X-NoticeOS-Actor: claude'
```

You do not need to look up the port: at a terminal, `pnpm os:mcp` (or `~/noticeos/noticeos mcp` without a checkout) prints this line with your installation's port. When it prints a different command, it also prints the reason. `--scope user` registers it once for every repository on this machine, so an agent in a site's own checkout sees its tasks too.

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

The server's instructions ask the agent to pass `model`, the name of the model it runs as, on every `claim_task` and `close_task`. To make sure it does, put the same request in the agent's own instructions, for example a line in the repository's `CLAUDE.md` or `AGENTS.md`:

```md
When you claim or close a NoticeOS task, pass `model` with the name of the model you run as.
```

The task records the model beside the agent's name, and the [Agents](/tower/agents) page ranks agents and models by it. Work closed without a model still counts on **Tasks** and **Agents**, but it is not ranked and does not appear in the TV's **Agents** widget or on Home.

## What the agent can do

| Tools | What they do |
| --- | --- |
| `list_workspaces`, `list_projects` | List the installation's one workspace and its linked task projects. Each project's `name` is its site's name, and its `projectId` stays the same when the project moves to another site |
| `get_task_guide` | Return the rules for task work as Markdown with a version: the workflow from `list_workspaces` to `close_task`, how to write and close a task, when a person decides, and how to read site data. It takes no arguments |
| `list_tasks`, `get_task`, `get_task_history` | Read tasks. `list_tasks` returns summaries, most urgent first, 50 at a time (`limit`, and `offset` from the response's `nextOffset`). It searches the current tasks: `query` for words, `parent`, `labels`, `type`, `status`, `ready: true` for tasks with no open blockers, and `created_after`, `created_before`, `updated_after`, `updated_before`. `get_task` reads one in full |
| `create_task`, `create_tasks`, `update_task` | File and change tasks. A new task can name its links (`depends_on`, `blocks`, `related`, `discovered_from`) and an `approval` it needs. `create_tasks` files up to 25 in one call, and one may name an earlier one in the same call as `#0`, `#1`. Types include `decision`. Each response lists what a task still lacks, such as acceptance criteria; a task is not rejected for missing them |
| `claim_task`, `comment_on_task`, `close_task` | Take a task, note progress, close it with its evidence. Claim and close take `model`, the name of the model doing the work, which the agent passes every time: the task page shows it beside the agent's name, and the **Agents** page ranks models by it |
| `add_dependency`, `remove_dependency` | Record what blocks what. A `blocks` dependency keeps a task out of the ready list until the other closes; it does not stop the task from being closed. An open approval does: `close_task` refuses a task while an approval it waits on is open |
| `request_human_approval` | Request your approval before work on a task continues. The request is listed under **Your decisions**, and the task stays out of the ready list until you approve it; the response reports this. Calling it again with the same reason returns the same request |
| `list_properties`, `property_report`, `property_history`, `research_lookup` | Read site reports and stored research. `list_properties` gives each site's last 28 days in totals: daily revenue per source, each source named with its provider and family, and traffic per provider and metric. `property_history` gives the days behind them for one site or every site (`days`, up to 365), and revenue per accounting month by source and booking state (`months`, up to 120) |
| `list_panels`, `get_panel`, `query_panel`, `read_panel_document` | Read each site's data panel: its Search Console, Analytics, Bing, DataForSEO, PostHog and Clarity reports as tables, rebuilt daily. `get_panel` shows how current each report is and what needs attention; `query_panel` runs one read-only SQL `SELECT` over a panel's tables. Each panel version stays readable for 14 days. See [Signal panels](../20-signal-panels.md#how-an-agent-reads-a-panel) |

Creating, changing, claiming, commenting on and closing take an `idempotency_key`. An agent that retries an interrupted call with the same key gets the first response, and the change happens once.

The server's instructions also give every connected agent the rules for writing a task that someone else can act on: the title, the description's sections, the acceptance proof, the `human` label and when to use an epic. `get_task_guide` returns the same rules with the full workflow, at any point in a session. A repository's own instructions do not repeat them; they point at the tool:

```md
- Tasks and site data come from the `noticeos` MCP server. Call `get_task_guide` before task work: it returns the workflow and the rules for filing, claiming and closing a task.
- Never run `bd`, `bv` or `br` in this repository: the MCP tools are the task interface.
```

`pnpm project:prepare -- --repo <checkout> --write` adds that pointer to a repository's `AGENTS.md`.

## What only you control

- **Approvals.** No tool can approve a request or close a task labelled **human**; you do both on **Tasks**. An agent cannot close a pending approval or remove a task's dependency on one.
- **Everything else in [What agents are not allowed to touch](/concepts/tasks-and-agents#what-agents-are-not-allowed-to-touch).**
- **Who may connect.** Anything that reaches the Tower has full task access in the installation, as the Tower's own pages do: this machine by default, and every device on your network once you open the Tower to it. Open it only on a network you trust.

## Use the task tool without installing it

For a person at the terminal, `pnpm os:bd -- <command>`, or `~/noticeos/noticeos bd <command>`, runs the task tool inside the app, in the installation's task project:

```sh
pnpm os:bd -- ready
pnpm os:bd -- --project ex show ex-14
```

`--project` names the prefix when the installation links more than one project. Changes are recorded as `operator` unless `--actor` names someone else.

## A hosted workspace

A hosted workspace serves the same tools at its own `/api/mcp` address. The agent signs in there, and you approve the access it asks for; see [Tasks and agents](/concepts/tasks-and-agents#what-ai-agents-do-in-noticeos-today).

## Verify

- In the agent, `list_workspaces` returns one workspace, **This installation**.
- `list_projects` lists your linked task projects.
- `list_tasks` with `ready: true` matches **Next up** on **Tasks**.
- `list_panels` lists each site on the panel refresh roster with a version built in the last day.

## If it didn't work

- **The app is not running**: start it with `pnpm os:start` or `~/noticeos/noticeos start`.
- **No projects**: link a checkout; see [Connect a task project](/guides/connect-a-task-project#where-the-checkout-link-goes).
- **The agent lists only the site report tools**: the Tower is running a version older than the one that serves every tool. Update it, or restart a development stack with `pnpm os:restart`.
- **The agent lists no tools**: send one message yourself. `curl -s http://127.0.0.1:5173/api/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'` returns `{"jsonrpc":"2.0","id":1,"result":{}}`; any other response contains the error.

## Next steps

- [Tasks and agents](/concepts/tasks-and-agents)
- [Tasks](/tower/tasks)
