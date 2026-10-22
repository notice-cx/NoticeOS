---
title: "Connect an agent"
description: "Give a coding agent on this machine your tasks, asset reports and each asset's data panel through MCP, with no task tool or credential of its own."
---

# Connect an agent

This page shows how to connect an AI coding agent, such as Claude Code, to your installation through MCP (the Model Context Protocol). The agent reads and updates the tasks you see on **Tasks**, reads asset reports, and queries each asset's search, traffic and product data. It needs no task tool and no credential of its own.

MCP is an open standard that lets an AI agent use another program's tools. The Tower serves NoticeOS's tools at `/api/mcp`, beside its own pages; you register that address with the agent once, and from then on it can list, file, claim and close tasks and read how your assets are doing, the way you would in the Tower. Only you can approve work.

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

You do not need to look up the port: at a terminal, `pnpm os:mcp` (or `~/noticeos/noticeos mcp` without a checkout) prints this line with your installation's port. When it prints a different command, it also prints the reason. `--scope user` registers it once for every repository on this machine, so an agent in an asset's own checkout sees its tasks too.

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

The server's instructions ask the agent to pass `model`, the name of the model it runs as, on every `create_task`, `create_tasks`, `claim_task` and `close_task`. To make sure it does, put the same request in the agent's own instructions, for example a line in the repository's `CLAUDE.md` or `AGENTS.md`:

```md
When you file, claim or close a NoticeOS task, pass `model` with the name of the model you run as.
```

The task records the model beside the agent's name, the Wall's **Live feed** shows it on the agent's lines, and the [Agents](/tower/agents) page groups work by its normalized model name. Missing or unrecognized models share **Other** on that page. The TV's **Agents** widget and Home require a named model. Use `get_agent_stats` for model statistics without loading individual tasks. `list_tasks` reads task summaries and readiness, without epic progress or actor rosters.

## What the agent can do

| Tools | What they do |
| --- | --- |
| `list_workspaces`, `list_projects` | List the installation's one workspace and its linked task projects. Each project's `name` is its asset's name, and its `projectId` stays the same when the project moves to another asset. `list_workspaces` also returns `guideVersion`, the version `get_task_guide` returns now |
| `get_task_guide` | Return the rules for task work as Markdown with a version: what changed lately, the workflow from `list_workspaces` to `close_task`, how to write and close a task, when a person decides, and how to read asset data. It takes no arguments |
| `list_tasks`, `get_task`, `get_task_history` | Read tasks. `list_tasks` returns summaries, most urgent first, 50 at a time (`limit`, and `offset` from the response's `nextOffset`). With a `project` it lists that project; without one it lists every project in the workspace in one order, each task with its `project`, `projectId` and `projectName`, and `unavailable` lists any project whose tasks could not be read. It searches the current tasks: `query` for words, `assignee` for the tasks one name holds (`me` for the agent's own), `parent`, `labels`, `type`, `status`, `ready: true` for tasks with no open blockers, and `created_after`, `created_before`, `updated_after`, `updated_before`. `get_task` reads one in full |
| `create_task`, `create_tasks`, `update_task` | File and change tasks. A new task can name its links (`depends_on`, `blocks`, `related`, `discovered_from`) and an `approval` it needs. `create_tasks` files up to 25 in one call, and one may name an earlier one in the same call as `#0`, `#1`. Types include `decision`. A task that needs you to pick one option carries `choices`: a question and two to six options keyed `a` to `f`, each with a label and an optional detail, one marked recommended. `update_task` replaces them whole or removes them with `null`, until you have chosen. `get_task` and `list_tasks` return `choices` and, once you have picked, `choice`. A task meant to change money carries a `card`, what the work is worth: `valuePerMonth` (USD a month), `likelihood` (0.01 to 0.99), `reviewMinutes`, `daysToSignal` and `measurability` (`cohort`, `holdout` or `unmeasured`), with optional `buildMinutes`, `revenueFamily`, `durability`, `kill` (`state` and `date`; the date is also the task's due date) and `note`. The server records who wrote the card and when. The Tower ranks tasks by their cards; a task without one is listed, not ranked. `change_class` records the kind of change: `content-data`, `copy`, `template`, `feature` or `infra`. `update_task` replaces a card whole, and `null` removes either, until the task closes as done. `get_task` and `list_tasks` return them as `card` and `changeClass`. `create_task` and `create_tasks` take `model`, and the task records the agent and the model that filed it. Each response lists what a task still lacks, such as acceptance criteria, and advises `choices` for a task labelled `human` whose description lists lettered options; a task is not rejected for either |
| `claim_task`, `comment_on_task`, `close_task` | Take a task, note progress, close it with its evidence. Claim and close take `model`, the name of the model doing the work, which the agent passes every time: the task page shows it beside the agent's name, and the **Agents** page ranks models by it. When nothing shipped, `close_task` takes a `resolution`: `wont-do`, `duplicate` with `duplicate_of` (the other task's id in the same project, which the close links as related), `cant-reproduce` or `already-handled`; without one the close is `done`. The reason still cites the evidence, and the **Agents** page counts every close reason. `get_task` and `list_tasks` return `resolution`, and `duplicateOf` for a duplicate, on a closed task. A `done` close of a task with a card keeps the card as it stood, with the close time and the commit hash the reason names; `get_task` returns it as `cardShipped`, and from then on `update_task` stops any change to that task's card, also after the task is reopened |
| `add_dependency`, `remove_dependency` | Record what blocks what. A `blocks` dependency keeps a task out of the ready list until the other closes; it does not stop the task from being closed. An open approval does: `close_task` refuses a task while an approval it waits on is open |
| `request_human_approval` | Request your approval before work on a task continues. The request is listed under **Your decisions**, and the task stays out of the ready list until you approve it; the response reports this. Calling it again with the same reason returns the same request |
| `list_properties`, `property_report`, `property_history`, `research_lookup` | Read asset reports and stored research. `list_properties` gives each asset's last 28 days in totals: daily revenue per source, each source named with its provider and family, and traffic per provider and metric. `property_history` gives the days behind them for one asset or every asset (`days`, up to 365), and revenue per accounting month by source and booking state (`months`, up to 120) |
| `list_panels`, `get_panel`, `query_panel`, `read_panel_document` | Read each asset's data panel: its Search Console, Analytics, Bing, DataForSEO, PostHog and Clarity reports as tables, rebuilt daily. `get_panel` shows how current each report is and what needs attention; `query_panel` runs one read-only SQL `SELECT` over a panel's tables. Each panel version stays readable for 14 days. See [Signal panels](../20-signal-panels.md#how-an-agent-reads-a-panel) |

Creating, changing, claiming, commenting on and closing take an `idempotency_key`. An agent that retries an interrupted call with the same key gets the first response, and the change happens once.

An agent's client keeps the tool list it fetched when it connected. When the server has since gained an argument that takes an object, such as `choices`, that client sends the argument as text. The server reads text that holds a JSON object as the object, and the response starts with `staleClient`: the arguments that arrived as text, the server's guide version, and the fix, which is to reconnect the `noticeos` server in the agent (`/mcp` in Claude Code). Text that is not a JSON object is refused with the same line, followed by the argument's rule.

For example, a bug that no longer happens closes with:

```json
{ "task": "ex-4f2", "resolution": "cant-reproduce", "reason": "Ran the import three times on 2026-10-17 with the reported file; each run finished without the error.", "model": "Claude Opus 5.5", "idempotency_key": "close-ex-4f2-01" }
```

A refused call names its cause and the next step: a project or task the workspace does not hold (with the project that holds tasks of that prefix, which also covers a `duplicate_of` in another project), an unknown `resolution` or a `duplicate_of` without `duplicate`, the task's own state (closed, held by someone else, waiting on an approval, with open children, or already carrying your choice when the call changes its choices), an argument over its limit, or the task store not completing the call. A call the connection is not allowed to make gets one general refusal.

The server's instructions also give every connected agent the rules for writing a task that someone else can act on: the title, the description's sections, the acceptance proof, a card and a change class, the `human` label, `choices` for a task where you pick one option, when to use an epic, and a search with `list_tasks` before filing, so work already filed gets a comment rather than a second task. `get_task_guide` returns the same rules with the full workflow, at any point in a session. The two rules on the card and the change class read:

> - Work meant to change money carries a card: the predicted change in USD a month, how likely it pays off, the operator's review minutes and your build minutes, the days until the ledger shows it, how it is measured, and the state and date to give up on it; the Tower ranks tasks by their cards, and a task without one is listed, not ranked.
> - change_class names the kind of change a task makes, one of content-data, copy, template, feature and infra, which the autonomy ladder and the likelihood priors are kept by.

The guide starts with **What changed**: at most three lines, each a date and the tools or arguments the task tools gained that day. Its version changes whenever its text does, and `list_workspaces` returns the current version as `guideVersion`. An agent that read the guide earlier compares the two at the start of a session and reads the guide again only when they differ.

A repository's own instructions do not repeat the rules; they point at the tool:

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

- In the agent, `list_workspaces` returns one workspace, **This installation**, and a `guideVersion` equal to the `version` from `get_task_guide`.
- `list_projects` lists your linked task projects.
- `list_tasks` with `ready: true` lists the tasks with no open blockers; on **Tasks**, **Agents, next up** shows the ones an agent can take next as **Ready**.
- `list_tasks` with `assignee: "me"` and no `project` lists the tasks the agent has claimed, in every project.
- `list_panels` lists each asset on the panel refresh roster with a version built in the last day.

## If it didn't work

- **The app is not running**: start it with `pnpm os:start` or `~/noticeos/noticeos start`.
- **No projects**: link a checkout; see [Connect a task project](/guides/connect-a-task-project#where-the-checkout-link-goes).
- **The agent lists only the asset report tools**: the Tower is running a version older than the one that serves every tool. Update it, or restart a development stack with `pnpm os:restart`.
- **The agent lists no tools**: send one message yourself. `curl -s http://127.0.0.1:5173/api/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'` returns `{"jsonrpc":"2.0","id":1,"result":{}}`; any other response contains the error.

## Next steps

- [Tasks and agents](/concepts/tasks-and-agents)
- [Tasks](/tower/tasks)
