---
title: "Connect an agent"
description: "Give a coding agent on this machine your tasks and site reports through MCP, with no task tool or credential of its own."
---

# Connect an agent

This page connects an AI coding agent, such as Claude Code, to your installation through MCP (the Model Context Protocol). The agent reads and updates the tasks you see on **Tasks**, and reads site reports. It needs no task tool and no credential of its own.

MCP is an open standard that lets an AI agent use another program's tools. The Tower serves NoticeOS's tools at `/api/mcp`, beside its own pages; you register that address with the agent once, and from then on it can list, file, claim and close tasks and read how your sites are doing, the way you would on the desk. Approving work stays with you.

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

### Without the Tower's address

An agent that cannot reach the Tower's address can run the same server itself, over its standard input and output:

```sh
claude mcp add --scope user noticeos -- node /absolute/noticeos-checkout/scripts/stack-control.mjs mcp --actor claude
claude mcp add --scope user noticeos -- ~/noticeos/noticeos mcp --actor claude    # installed with Docker alone
```

## What the agent can do

| Tools | What they do |
| --- | --- |
| `list_workspaces`, `list_projects` | Name the installation's one workspace and its linked task projects |
| `list_tasks`, `get_task`, `get_task_history` | Read tasks. `list_tasks` answers summaries, most urgent first, 50 at a time (`limit`, and `offset` from the answer's `nextOffset`). It searches live: `query` for words, `parent`, `labels`, `type`, `status`, `ready: true` for work nothing blocks, and `created_after`, `created_before`, `updated_after`, `updated_before`. `get_task` reads one in full |
| `create_task`, `create_tasks`, `update_task` | File and change tasks. A new task can name its links (`depends_on`, `blocks`, `related`, `discovered_from`) and an `approval` it needs. `create_tasks` files up to 25 in one call, and one may name an earlier one in the same call as `#0`, `#1`. Types include `decision`. Each answer lists what a task still lacks, such as acceptance criteria; nothing is refused for it |
| `claim_task`, `comment_on_task`, `close_task` | Take a task, note progress, close it with its evidence |
| `add_dependency`, `remove_dependency` | Record what blocks what. A `blocks` dependency keeps a task out of the ready list until the other closes |
| `request_human_approval` | Ask you to approve a task before it goes on. The approval waits under **Waiting on you** and holds the task out of the ready list until you approve it; the answer says so. Asking again with the same reason returns the same request |
| `list_properties`, `property_report`, `research_lookup` | Read site reports and stored research |

Creating, changing, claiming, commenting on and closing take an `idempotency_key`. An agent that retries an interrupted call with the same key gets the first answer, and the change happens once.

## What stays with you

- **Approvals.** No tool approves a request or answers a task labelled **human**; you do both on **Tasks**. An agent cannot close a pending approval or remove a task's dependency on one.
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

- In the agent, `list_workspaces` answers with one workspace, **This installation**.
- `list_projects` names your linked task projects.
- `list_tasks` with `ready: true` matches **Next up** on **Tasks**.

## If it didn't work

- **The app is not running**: start it with `pnpm os:start` or `~/noticeos/noticeos start`.
- **No projects**: link a checkout; see [Connect a task project](/guides/connect-a-task-project#where-the-checkout-link-goes).
- **The agent lists only the site report tools**: the Tower runs a version from before it served every tool. Update it, or restart a development stack with `pnpm os:restart`.
- **The agent lists no tools**: send one message yourself. `curl -s http://127.0.0.1:5173/api/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'` answers `{"jsonrpc":"2.0","id":1,"result":{}}`; anything else names what is wrong.

## Next steps

- [Tasks and agents](/concepts/tasks-and-agents)
- [Tasks](/tower/tasks)
