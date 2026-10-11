---
title: "Connect an agent"
description: "Give a coding agent on this machine your tasks and site reports through MCP, with no task tool or credential of its own."
---

# Connect an agent

This page connects an AI coding agent, such as Claude Code, to your installation through MCP (the Model Context Protocol). The agent reads and updates the tasks you see on **Tasks**, and reads site reports. It needs no task tool and no credential of its own.

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

You need not look up the port: run at a terminal, `pnpm os:mcp`, or `~/noticeos/noticeos mcp` without a checkout, prints this line with your installation's, and says why when it prints another. `--scope user` registers it once for every repository on this machine, so an agent in a site's own checkout sees its tasks too.

Any other MCP client that speaks HTTP takes the same address and header, for example in a project's `.mcp.json`:

```json
{ "mcpServers": { "noticeos": { "type": "http", "url": "http://127.0.0.1:5173/api/mcp", "headers": { "X-NoticeOS-Actor": "claude" } } } }
```

### When the Tower listens on your network

The Tower answers every tool only while it listens on this machine alone, the default. An installation that opens it to its network (`NOTICEOS_TOWER_BIND` in `installation.env`) keeps changes on this machine: there, `/api/mcp` answers only the site reports, and an agent here runs the server itself, over its standard input and output:

```sh
claude mcp add --scope user noticeos -- node /absolute/noticeos-checkout/scripts/stack-control.mjs mcp --actor claude
claude mcp add --scope user noticeos -- ~/noticeos/noticeos mcp --actor claude    # installed with Docker alone
```

## What the agent can do

| Tools | What they do |
| --- | --- |
| `list_workspaces`, `list_projects` | Name the installation's one workspace and its linked task projects |
| `list_tasks`, `get_task`, `get_task_history` | Read tasks; `ready: true` lists only work nothing blocks |
| `create_task`, `update_task` | File and change tasks. Each answer lists what the task still lacks, such as acceptance criteria; nothing is refused for it |
| `claim_task`, `comment_on_task`, `close_task` | Take a task, note progress, close it with its evidence |
| `add_dependency`, `remove_dependency` | Record what blocks what. A `blocks` dependency keeps a task out of the ready list until the other closes |
| `request_human_approval` | Ask you to approve a task before it goes on. The task waits under **Waiting on you** until you do; asking again with the same reason returns the same request |
| `list_properties`, `property_report`, `research_lookup` | Read site reports and stored research |

Creating, changing, claiming, commenting on and closing take an `idempotency_key`. An agent that retries an interrupted call with the same key gets the first answer, and the change happens once.

## What stays with you

- **Approvals.** No tool approves a request or answers a task labelled **human**; you do both on **Tasks**. An agent cannot close a pending approval or remove a task's dependency on one.
- **Everything else in [What agents are not allowed to touch](/concepts/tasks-and-agents#what-agents-are-not-allowed-to-touch).**
- **Who may connect.** Any program on this machine that reaches the Tower, or can run Docker, has full task access in the installation, as the Tower's own pages do.

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

- In the agent, `list_workspaces` answers with one workspace, **This installation**.
- `list_projects` names your linked task projects.
- `list_tasks` with `ready: true` matches **Next up** on **Tasks**.

## If it didn't work

- **The app is not running**: start it with `pnpm os:start` or `~/noticeos/noticeos start`.
- **No projects**: link a checkout; see [Connect a task project](/guides/connect-a-task-project#where-the-checkout-link-goes).
- **The agent lists only the site report tools**: the Tower listens on your network, or the app was started before the Tower could tell. `pnpm os:status` names a pending `pnpm os:apply`; otherwise see [When the Tower listens on your network](#when-the-tower-listens-on-your-network).
- **The agent lists no tools**: send one message yourself. `curl -s http://127.0.0.1:5173/api/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'` answers `{"jsonrpc":"2.0","id":1,"result":{}}`; anything else names what is wrong.

## Next steps

- [Tasks and agents](/concepts/tasks-and-agents)
- [Tasks](/tower/tasks)
