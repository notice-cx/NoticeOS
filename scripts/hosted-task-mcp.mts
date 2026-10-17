/** The task tools of NoticeOS's MCP endpoint (served by hosted-mcp.mts).
 * Every tool is a shared hosted task operation
 * (hosted-task-operations), the same ones the Tasks HTTP API calls, under the
 * same current admission. Results speak in tasks and comments; storage names
 * and command output never reach a client.
 *
 * Human decisions (respond, dismiss, resolve, choose) are not tools: write access
 * must not give an agent a route to answer its own question. An agent may
 * open a human gate; only a person resolves it. Writes that would repeat
 * their effect require an idempotency key so an agent can retry an
 * interrupted call safely; dependency and gate requests repeat harmlessly.
 * A created or changed task comes back with what lint finds missing, as
 * advice: nothing is refused for it.
 */
import { createHash } from 'node:crypto';
import { HostedTaskReceiptsUnavailable, TaskProjectRefused, type HostedTaskOperations, type HostedTaskWriteOutcome } from './hosted-task-operations.mjs';
import { HOSTED_TASK_LIMITS, HumanDecisionRefused, sameActor, TaskStateRefused, TaskStoreFailed, type HostedTaskDependencyType, type HostedTaskLink,
  type HostedTaskOperation, type HostedTaskStatus, type HostedTaskType, type TaskProjectName } from './hosted-task-command.mjs';
import { AdmissionRefused } from './workspace-admission.mjs';
import { GATE_REASON_MAX, gateReason, waitsOnPerson } from '../packages/contract/src/task-gate.mjs';
import { TASK_CHOICE_KEYS, TASK_CHOICE_LIMITS, taskChoicesOf, taskChoicesProblem, type TaskChoices } from '../packages/contract/src/task-choices.mjs';
import { TASK_RESOLUTIONS } from '../packages/contract/src/task-resolution.mjs';
import { McpToolError } from './mcp-protocol.mjs';
import { toComment, toLiveTask } from './task-row.mjs';
import { IDEMPOTENCY_KEY } from '../packages/postgres/src/task-receipts.mjs';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const TASK_ID = /^[a-z0-9]+-{1,2}[a-z0-9]+(?:\.[0-9]+)*$/iu;
const STATUSES: readonly HostedTaskStatus[] = ['open', 'in_progress', 'blocked', 'deferred', 'closed'];
const TYPES: readonly HostedTaskType[] = ['task', 'bug', 'feature', 'epic', 'chore', 'decision'];
const DEPENDENCY_TYPES: readonly HostedTaskDependencyType[] = ['blocks', 'related', 'discovered-from'];
/** The link arguments a new task takes, each with the task client's word for it. */
const LINKS = Object.freeze([['depends_on', 'blocked-by'], ['blocks', 'blocks'], ['related', 'related'],
  ['discovered_from', 'discovered-from']] as const);
/** How many tasks one create_tasks call files: few enough to finish well inside a client's patience. */
const BATCH = 25;

/** How to write a task that reads cold, said to every agent the task tools
 * reach (hosted-mcp.mts puts it in the server's instructions). The one copy:
 * AGENTS.md and config/beads.README.md point here. Lint checks the shape;
 * this is the content. */
export const TASK_QUALITY: readonly string[] = Object.freeze([
  'Writing a task: a stranger must be able to act on it without this conversation.',
  '- title: the outcome, in plain language.',
  '- description: plain labelled lines, unwrapped: WHAT, WHY with the numbers, WHERE as pointers that resolve in a repo (file paths, commits, doc sections), FIX. A bug also has a "## Steps to Reproduce" section.',
  '- acceptance: the proof that completes it, provable the day the work lands. Never "watch for N days": close on today\'s proof and name where a recurrence would show.',
  '- Never cite a session, a transcript, an agent\'s report or a temporary file; cite the repo evidence under it.',
  '- Work only a person can do (a decision, a credential, an admin step) carries the human label and is written for that person: the ask as the description\'s first line, technical notes last. When the person picks between options, pass them as choices: a question and two to six options keyed a, b, c… in order, each a one-line label with an optional detail, exactly one marked recommended. The Tower shows one button per option. A step that must wait for approval uses request_human_approval.',
  '- Too big for one working session: an epic with session-sized children. Three or more related tasks share an epic. depends_on only for a real blocking edge; related for the rest. Work waiting on a date is deferred with the reason.',
  '- Found work, including debt (two copies of one rule, a hardcoded value with a canonical source, half-done work), is a task, never a TODO comment, a list in a doc or a memory note. Claim before you build; close with the commit hash.',
  '- Before filing, search with list_tasks query for the title\'s key words, with no project to search every project. Work already filed gets a comment, never a second task; of two tasks already filed for one piece of work, close the later as duplicate with duplicate_of.',
  '- When nothing shipped, close_task takes a resolution: wont-do when the work will not be done, duplicate with duplicate_of when another task holds it, cant-reproduce when a bug does not happen again, already-handled when other work did it; the reason still cites the evidence: what decided it, the other task\'s id, what was tried, or what handled it.',
]);

/** What the task tools gained lately, first in the guide so an agent that
 * read an earlier version learns the new tools and arguments without a
 * refusal: oldest first, each one line opening with its date, at most three
 * (a new entry drops the first). */
export const WHATS_CHANGED: readonly string[] = Object.freeze([
  '2026-10-17: create_task and update_task take choices; a person\'s pick or answer hands the task back to ready work, with choice on it; close_task takes resolution and duplicate_of.',
  '2026-10-17: list_tasks takes assignee ("me" for what you hold) and, with no project, lists every project; list_workspaces returns guideVersion; an object argument your client sends as text is read as JSON, and the reply\'s staleClient line names the fix: reconnect the noticeos server.',
]);

/** How a session starts, said in every session's instructions. */
export const TASK_START = 'NoticeOS tasks and property reports across your workspaces. Start with list_workspaces; every other tool takes a workspace from it. A tool that takes an idempotency_key: reuse the key when retrying it. On every create_task, create_tasks, claim_task and close_task, pass model: the name of the model you run as. The task records it beside your name, and the Agents page ranks agents and models by it; work closed without a model is not ranked.';
/** Said only where the panel tools are offered. */
export const PANEL_RULE = 'For a site\'s search, traffic and product data, use get_panel then query_panel, never a provider\'s API, and cite the panel version you read.';
/** The order of task work, in the tools' own names. */
export const TASK_WORKFLOW: readonly string[] = Object.freeze([
  '1. list_workspaces, then list_projects: a project is one repository or site, and its prefix starts each of its task ids.',
  '2. list_tasks with ready: true and no project for work nothing blocks anywhere; assignee: "me" for what you hold. get_task reads one with its comments before you choose.',
  '3. claim_task the moment you start, naming your model.',
  '4. comment_on_task with progress and evidence as the work moves.',
  '5. close_task with what shipped and its evidence (the commit hash or URL), naming your model.',
  '6. Found work goes to create_task, or create_tasks for several, in the project that owns it.',
  '7. A decision, credential or admin step only a person can do: label the task human, with choices when the person picks one option. A step that must wait for approval: request_human_approval. Only a person answers either, on Tasks in the Tower.',
  '8. A person\'s answer or pick on a task of yours takes off its human label and returns it to ready work, with the answer as a comment and the pick as choice; claim it again to carry on. A decision closes on the answer or pick instead.',
  'These tools are the task interface: never run bd, bv or br in a project folder.',
]);
/** What get_task_guide names in its description and the instructions point at. */
export const TASK_GUIDE_TOOL = 'get_task_guide';

/** The whole guide as Markdown, with a version that changes whenever its
 * text does (list_workspaces returns it too). The server's instructions are a
 * part of it (taskInstructions). */
export function taskGuide(panels: boolean): { readonly version: string; readonly guide: string } {
  const body = ['## What changed', '', ...WHATS_CHANGED.map(entry => `- ${entry}`), '', '## Start', '', TASK_START, '',
    '## Workflow', '', ...TASK_WORKFLOW, '', '## Writing a task', '', ...TASK_QUALITY,
    ...(panels ? ['', '## Site data', '', PANEL_RULE] : [])].join('\n');
  const version = createHash('sha256').update(body).digest('hex').slice(0, 12);
  return Object.freeze({ version, guide: `# Working with NoticeOS tasks\n\nGuide version ${version}; `
    + `list_workspaces returns the current one as guideVersion.\n\n${body}\n` });
}

/** Every session's instructions: the guide's start, its panel rule where the
 * panel tools are offered, and its rules for writing a task. */
export function taskInstructions(panels: boolean): string {
  return [panels ? `${TASK_START} ${PANEL_RULE}` : TASK_START,
    `${TASK_GUIDE_TOOL} returns these rules with the full workflow and what changed lately, at any time; list_workspaces returns `
      + 'its version as guideVersion, so read it again when that changes.', '', ...TASK_QUALITY].join('\n');
}

function refuse(message: string): never { throw new McpToolError(message); }
const REFUSED = 'refused: this workspace, project or task is not available to you, or the change was not accepted';
/** Task ids as a sentence lists them: "a", "a and b", "a, b and c". */
function listed(ids: readonly string[]): string {
  return ids.length < 2 ? ids.join('') : `${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}`;
}
/** A project as a refusal names it, with the id a call takes. */
const projectNamed = (project: TaskProjectName) => `projectId ${project.projectId} (${project.name})`;
/** What the task's own state says about a refused call, and what to do next. */
function stateRefusal({ taskId: id, attempted, reason }: TaskStateRefused): string {
  switch (reason.kind) {
    case 'missing': return `refused: ${id} is not a task in ${projectNamed(reason.project)}; list_tasks lists its tasks.`;
    case 'closed': return attempted === 'claim'
      ? `refused: ${id} is closed, so it cannot be claimed. File work that remains with create_task.`
      : `refused: ${id} is already closed; get_task shows its close reason.`;
    case 'held': return attempted === 'claim'
      ? `refused: ${id} is held by ${reason.holder}. Choose another task, or reach ${reason.holder} with comment_on_task.`
      : attempted === 'reassign'
        ? `refused: ${id} is held by ${reason.holder}, and only its holder or a person on Tasks in the Tower gives it to someone else.`
        : `refused: ${id} is held by ${reason.holder}, and only its holder closes it. `
          + `Reach ${reason.holder} with comment_on_task, or ask a person to close it on Tasks in the Tower.`;
    case 'not-open': return `refused: ${id} has status ${reason.status}, and claim_task takes an open task.`
      + (reason.blockers.length ? ` It depends on ${listed(reason.blockers)}, still open.` : '')
      + ` To work on it now, set its status to open with update_task, then claim it.`;
    case 'gate': return reason.human
      ? `refused: ${id} waits on approval ${listed(reason.gates)}, which is still open. Close ${id} after a person approves it on Tasks in the Tower.`
      : `refused: ${id} waits on gate ${listed(reason.gates)}, which is still open. Close ${id} after it resolves.`;
    case 'children': return `refused: ${id} has open children: ${listed(reason.children)}. Close them first, or give them another parent with update_task.`;
    case 'linked': return `refused: ${id} already depends on ${reason.dependsOn} as ${reason.type}, and a dependency keeps the type it was `
      + `added with. To record it as ${reason.wanted}, remove_dependency first, then add it again.`;
    case 'chosen': return `refused: ${id} already carries a person's choice${reason.chosen === null ? '' : `, ${reason.chosen}`}, and its choices `
      + 'stay as they were when it was made. get_task shows the choice; file work that remains with create_task.';
    // A pick is a person's, on Tasks in the Tower; no tool makes one.
    case 'no-choices': return `refused: ${id} offers no choices.`;
    case 'no-option': return `refused: ${id} offers no option (${reason.option}).`;
  }
}
/** A call naming a project the catalog does not hold, or another project's
 * task, with the project that holds it: by the task's prefix, or the project
 * a former id belonged to. */
function projectRefusal({ projectId, taskId, project, owner }: TaskProjectRefused): string {
  if (project === null) {
    return `refused: projectId ${projectId} names no project in this workspace; `
      + (owner ? `tasks with prefix ${owner.prefix} are in ${projectNamed(owner)}.` : 'list_projects lists the current projectIds.');
  }
  return `refused: ${taskId} is not in ${projectNamed(project)}, whose tasks start ${project.prefix}-; `
    + `tasks with prefix ${owner!.prefix} are in ${projectNamed(owner!)}.`;
}
/** A task tool's failure as the caller may read it. A failed admission or
 * verification keeps one answer: which check refused is not the caller's to
 * learn. A cause found after them is named: the project or task the call
 * names, the task's own state as its read showed it, or the task store
 * failing. */
export function taskRefusal(error: unknown): McpToolError {
  if (error instanceof McpToolError) return error;
  if (error instanceof HumanDecisionRefused) {
    return new McpToolError(`refused: ${error.taskId} is a person's decision, a gate or a task labelled human. Only a person `
      + 'closes it, takes off its human label or removes a dependency on it, on Tasks in the Tower; ask with request_human_approval or a comment.');
  }
  if (error instanceof TaskStateRefused) return new McpToolError(stateRefusal(error));
  if (error instanceof TaskProjectRefused) return new McpToolError(projectRefusal(error));
  if (error instanceof TaskStoreFailed) {
    return new McpToolError((error.timedOut ? 'unavailable: the task store did not answer in time. '
      : 'unavailable: the task store did not complete this call, and nothing in the task\'s state explains it. ')
      + 'Retry the same call; with the same idempotency_key a change lands at most once.');
  }
  return new McpToolError(REFUSED);
}

// ─── Arguments ────────────────────────────────────────────────────────────────
type Args = Record<string, unknown>;
function only(args: Args, allowed: readonly string[]): void {
  const unknown = Object.keys(args).filter(key => !allowed.includes(key));
  if (unknown.length) refuse(`invalid arguments: unknown ${unknown.join(', ')}`);
}
function textArg(args: Args, name: string, max: number, required = true, empty = false): string | undefined {
  const value = args[name];
  if (value === undefined && !required) return undefined;
  if (value === undefined) refuse(`invalid arguments: ${name} (required)`);
  if (typeof value !== 'string') refuse(`invalid arguments: ${name} (text)`);
  if (value.length > max) refuse(`invalid arguments: ${name} (at most ${max} characters; this one has ${value.length})`);
  if (!empty && !value.trim()) refuse(`invalid arguments: ${name} (empty)`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) refuse(`invalid arguments: ${name} (a control character; tab and line breaks are the only ones allowed)`);
  return value;
}
function modelArg(args: Args): string | undefined {
  const value = textArg(args, 'model', HOSTED_TASK_LIMITS.identifier, false);
  if (value !== undefined && (/[\r\n\t]/u.test(value) || value.trim() !== value)) refuse('invalid arguments: model (one line, no surrounding spaces)');
  return value;
}
function project(args: Args): string {
  const value = args.project;
  if (typeof value !== 'string' || !UUID.test(value)) refuse('invalid arguments: project (a projectId from list_projects)');
  return value;
}
function task(args: Args, name = 'task'): string {
  const value = args[name];
  if (typeof value !== 'string' || !TASK_ID.test(value)) refuse(`invalid arguments: ${name} (a task id such as abc-1x2)`);
  return value;
}
function key(args: Args): string {
  const value = args.idempotency_key;
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    refuse('invalid arguments: idempotency_key (8–128 of A–Z a–z 0–9 . _ : -; reuse it when retrying this call)');
  }
  return value;
}
function priority(args: Args): number | undefined {
  const value = args.priority;
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 4) refuse('invalid arguments: priority (0–4)');
  return value;
}
/** Labels as the task client keeps them: each one line without commas or surrounding spaces, none twice. */
function labels(args: Args, name: string, least = 0): string[] | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < least || value.length > HOSTED_TASK_LIMITS.labels || new Set(value).size !== value.length
    || value.some(label => typeof label !== 'string' || !label || label.length > HOSTED_TASK_LIMITS.label
      || /[\r\n\t,]/u.test(label) || label.trim() !== label)) {
    refuse(`invalid arguments: ${name} (${least ? `${least} to ` : 'at most '}${HOSTED_TASK_LIMITS.labels} labels, each at most ${HOSTED_TASK_LIMITS.label} `
      + 'characters on one line, without commas or surrounding spaces, none twice)');
  }
  return value as string[];
}
/** A defer date, or "" to clear one. */
function deferArg(args: Args): string | undefined {
  const value = args.defer;
  if (value === undefined || value === '') return value;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString().slice(0, 10) !== value) refuse('invalid arguments: defer (YYYY-MM-DD, or "" to clear it)');
  return value;
}
function choice<T extends string>(args: Args, name: string, values: readonly T[]): T | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !values.includes(value as T)) refuse(`invalid arguments: ${name} (one of ${values.join(', ')})`);
  return value as T;
}
function defined<T extends object>(row: T): T {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)) as T;
}
function taskType(args: Args): HostedTaskType | undefined {
  if (args.type === 'gate') {
    refuse('invalid arguments: type (a gate holds another task until a person approves it: pass approval with that task, or call request_human_approval)');
  }
  return choice(args, 'type', TYPES);
}
function strings(args: Args, name: string): readonly string[] | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > HOSTED_TASK_LIMITS.rows || value.some(entry => typeof entry !== 'string' || !entry || entry.length > 512)) {
    refuse(`invalid arguments: ${name}`);
  }
  return value as string[];
}
/** A task's choices, refused with the field at fault named (task-choices.mts holds the rules). */
function choicesArg(args: Args): TaskChoices | undefined {
  const value = args.choices;
  if (value === undefined) return undefined;
  const problem = taskChoicesProblem(value);
  if (problem !== null) refuse(`invalid arguments: ${problem.field} (${problem.rule})`);
  return taskChoicesOf(value)!;
}
/** A property of a tool's input schema, as far as reading text needs it. */
interface PropertySchema { readonly type?: unknown; readonly properties?: Readonly<Record<string, PropertySchema>>; readonly items?: PropertySchema }
const typed = (schema: PropertySchema, type: string) => schema.type === type || Array.isArray(schema.type) && schema.type.includes(type);
/** A tool's arguments with each object-typed one that arrived as a string
 * read as JSON: a client whose copy of the tool list predates an argument has
 * no schema for it and sends it as text. `text` names those read; `unread`
 * those whose text is not an object (or null, where the schema takes null),
 * which stay strings for their own reader to refuse. Each entry of an array of
 * objects is read the same way, named by its place. */
function objectsFromText(schema: PropertySchema, args: Args, at = ''):
  { readonly args: Args; readonly text: readonly string[]; readonly unread: readonly string[] } {
  const read: Args = { ...args }, text: string[] = [], unread: string[] = [];
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const value = args[name];
    if (typed(property, 'object') && typeof value === 'string') {
      let parsed: unknown;
      try { parsed = JSON.parse(value); } catch { parsed = undefined; }
      if (parsed === null ? typed(property, 'null') : typeof parsed === 'object' && !Array.isArray(parsed)) {
        read[name] = parsed; text.push(at + name);
      } else unread.push(at + name);
    } else if (typed(property, 'array') && property.items && typed(property.items, 'object') && Array.isArray(value)) {
      read[name] = value.map((entry: unknown, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
        const inner = objectsFromText(property.items!, entry as Args, `${at}${name}[${index}].`);
        text.push(...inner.text); unread.push(...inner.unread);
        return inner.args;
      });
    }
  }
  return { args: read, text, unread };
}
/** What a reply or refusal says when object arguments arrived as text. */
function staleClientLine(names: readonly string[], guideVersion: string): string {
  return `${listed(names)} arrived as text: your client's copy of the task tools predates this server (guide version ${guideVersion}); `
    + 'reconnect the noticeos server to get the current tools';
}
/** YYYY-MM-DD or an ISO time, as epoch milliseconds. */
function instantArg(args: Args, name: string): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  const at = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/u.test(value)
    ? Date.parse(value) : NaN;
  if (!Number.isFinite(at)) refuse(`invalid arguments: ${name} (YYYY-MM-DD or an ISO time)`);
  return at;
}

/** A new task's fields, from create_task or one entry of create_tasks. `target`
 * reads each task id it names: a parent or a linked task. */
const CREATE_FIELDS = Object.freeze(['title', 'description', 'type', 'priority', 'labels', 'parent', 'acceptance',
  ...LINKS.map(([name]) => name), 'approval', 'choices']);
type Creation = { readonly operation: Extract<HostedTaskOperation, { kind: 'create' }>; readonly approval: string | undefined };
function creation(args: Args, target: (name: string, value: unknown) => string): Creation {
  const parent = args.parent === undefined ? undefined : target('parent', args.parent);
  const links: HostedTaskLink[] = [];
  for (const [name, type] of LINKS) {
    const value = args[name];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length > HOSTED_TASK_LIMITS.links) refuse(`invalid arguments: ${name}`);
    for (const id of value) links.push({ type, taskId: target(name, id) });
  }
  const targets = links.map(link => link.taskId);
  if (targets.length > HOSTED_TASK_LIMITS.links) refuse(`invalid arguments: at most ${HOSTED_TASK_LIMITS.links} linked tasks`);
  if (new Set(targets).size !== targets.length) refuse('invalid arguments: a linked task is named twice; a task links to another once');
  if (parent !== undefined && targets.includes(parent)) refuse('invalid arguments: the parent is linked already; leave it out of the other links');
  return { operation: defined({ kind: 'create' as const, title: textArg(args, 'title', HOSTED_TASK_LIMITS.title)!,
    description: textArg(args, 'description', HOSTED_TASK_LIMITS.body, false, true), type: taskType(args),
    priority: priority(args), labels: labels(args, 'labels'), parent,
    acceptance: textArg(args, 'acceptance', HOSTED_TASK_LIMITS.body, false, true), links: links.length ? links : undefined,
    choices: choicesArg(args) }),
  approval: textArg(args, 'approval', GATE_REASON_MAX, false) };
}

/** Lines that open with an option letter: (a), a), a. or a list dash before (a). */
const LETTERED_LINE = /^\s*(?:[-*]\s*)?(?:\(([a-f])\)|([a-f])[.)])\s/u;
/** Whether a description offers a person lettered options in prose: lines
 * for (a) and (b), or "(a) … (b) …" inside one line. */
export function offersLetteredOptions(description: string): boolean {
  const letters = new Set<string>();
  for (const line of description.split(/\r?\n/u)) {
    if (/\(a\)\s.*\(b\)\s/u.test(line)) return true;
    const match = LETTERED_LINE.exec(line);
    if (match) letters.add(match[1] ?? match[2]!);
  }
  return letters.has('a') && letters.has('b');
}
const CHOICES_ADVICE = 'choices: the description offers lettered options. Pass them as choices, so the person picks one with a button '
  + 'and the pick is recorded on the task.';
/** Advice beside lint's missing sections: a person's task whose options are prose a button cannot press. */
function choiceAdvice(task: { readonly labels?: unknown; readonly description?: unknown; readonly choices?: unknown } | null): readonly string[] {
  if (task === null || !Array.isArray(task.labels) || !task.labels.includes('human') || task.choices) return [];
  return typeof task.description === 'string' && offersLetteredOptions(task.description) ? [CHOICES_ADVICE] : [];
}

// ─── Results in task language ─────────────────────────────────────────────────
type LiveTask = ReturnType<typeof toLiveTask>;
/** A task in full. `live` when it was read with the project's ready work, which
 * readiness and the person's inbox need; a past version from history is not. */
function presentTask(task: LiveTask, live: boolean): Record<string, unknown> {
  return {
    id: task.id, title: task.title, status: task.status, priority: task.priority, type: task.issueType,
    assignee: task.assignee, labels: task.labels, parent: task.parent,
    ...(live ? { ready: task.ready, awaitingHuman: waitsOnPerson(task) } : {}),
    description: task.description, acceptance: task.acceptance, choices: task.choices ?? null, choice: task.choice ?? null,
    deferUntil: task.deferUntil,
    dependencies: task.dependencies, commentCount: task.comments, metadata: task.metadata,
    createdAt: task.createdAt, updatedAt: task.updatedAt, startedAt: task.startedAt,
    closedAt: task.closedAt, closeReason: task.closeReason, resolution: task.resolution ?? null, duplicateOf: task.duplicateOf ?? null,
  };
}
/** A task as a list shows it: enough to choose one, which get_task then reads
 * in full. A field with no value is left out, so a long page stays readable. */
function summaryOf(task: LiveTask): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: task.id, title: task.title, status: task.status, priority: task.priority, type: task.issueType,
    assignee: task.assignee, labels: task.labels, parent: task.parent, ready: task.ready, awaitingHuman: waitsOnPerson(task),
    choices: task.choices ?? null, choice: task.choice ?? null,
    deferUntil: task.deferUntil, createdAt: task.createdAt, updatedAt: task.updatedAt, closedAt: task.closedAt,
    resolution: task.resolution ?? null, duplicateOf: task.duplicateOf ?? null,
  };
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null && !(Array.isArray(value) && !value.length)));
}
/** The list_tasks filters a task passes. Every word of a query must appear in
 * its id, title, description, acceptance or labels. */
interface ListFilter {
  readonly words: readonly string[];
  readonly parent?: string; readonly labels?: readonly string[]; readonly types?: readonly string[];
  readonly createdAfter?: number; readonly createdBefore?: number; readonly updatedAfter?: number; readonly updatedBefore?: number;
  /** An actor name, matched as the task client matches one. */
  readonly assignee?: string;
}
function within(at: string | null, after: number | undefined, before: number | undefined): boolean {
  if (after === undefined && before === undefined) return true;
  const time = at === null ? NaN : Date.parse(at);
  return Number.isFinite(time) && (after === undefined || time >= after) && (before === undefined || time < before);
}
function passes(task: LiveTask, filter: ListFilter): boolean {
  if (filter.parent !== undefined && task.parent !== filter.parent) return false;
  if (filter.labels?.some(label => !task.labels.includes(label))) return false;
  if (filter.types !== undefined && !filter.types.includes(task.issueType)) return false;
  if (filter.assignee !== undefined && (task.assignee === null || !sameActor(task.assignee, filter.assignee))) return false;
  if (!within(task.createdAt, filter.createdAfter, filter.createdBefore) || !within(task.updatedAt, filter.updatedAfter, filter.updatedBefore)) return false;
  if (!filter.words.length) return true;
  const text = [task.id, task.title, task.description, task.acceptance, ...task.labels].join('\n').toLowerCase();
  return filter.words.every(word => text.includes(word));
}
/** Most urgent first, then oldest, so pages read in a stable order. */
function byUrgency(a: LiveTask, b: LiveTask): number {
  return a.priority - b.priority || (a.createdAt ?? '\uffff').localeCompare(b.createdAt ?? '\uffff') || a.id.localeCompare(b.id);
}
const PAGE = 50;
function taskOf(value: unknown): Record<string, unknown> {
  return presentTask(toLiveTask(Array.isArray(value) ? value[0] : value, new Set()), false);
}

// ─── Tools ────────────────────────────────────────────────────────────────────
export interface ToolContext {
  readonly proof: Request; readonly workspaceId: string; readonly operations: HostedTaskOperations;
  /** The version of the guide this server serves (taskGuide), which a stale client is told. */
  readonly guideVersion: string;
}
export interface TaskTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: Record<string, unknown>;
  run(context: ToolContext, args: Args): Promise<unknown>;
}
const PROJECT = { type: 'string', description: 'The projectId from list_projects.' };
const TASK = { type: 'string', description: 'The task id, such as abc-1x2.' };
/** Optional on a new task, a claim and a close: the Tower credits the work to this model as well as to the agent. */
const MODEL = { type: 'string', maxLength: HOSTED_TASK_LIMITS.identifier,
  description: 'The name of the model you run as, as you would say it. Pass it on every new task, claim and close: the Tower shows it beside your name, and the Agents page ranks your work by it.' };
const IDEMPOTENCY = { type: 'string', pattern: IDEMPOTENCY_KEY.source,
  description: 'A key you choose for this call. Retrying with the same key and arguments never repeats the change.' };
function schema(properties: Record<string, unknown>, required: readonly string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}
const TASK_IDS = (description: string) => ({ type: 'array', items: { type: 'string' }, maxItems: HOSTED_TASK_LIMITS.links, description });
/** The options a person picks from (task-choices.mts holds the rules the call is checked against). */
const CHOICES = Object.freeze({ type: 'object', additionalProperties: false, required: ['question', 'options'],
  description: 'When the task needs a person to pick one option. The Tower shows one button per option; the pick comes back on the task as choice.',
  properties: {
    question: { type: 'string', maxLength: TASK_CHOICE_LIMITS.question, description: 'What the person decides, asked as a question.' },
    options: { type: 'array', minItems: TASK_CHOICE_LIMITS.fewest, maxItems: TASK_CHOICE_LIMITS.most,
      items: schema({ key: { type: 'string', enum: TASK_CHOICE_KEYS, description: 'a for the first option, b for the second, and so on in order.' },
        label: { type: 'string', maxLength: TASK_CHOICE_LIMITS.label, description: 'One line: the words on the option\'s button.' },
        detail: { type: 'string', maxLength: TASK_CHOICE_LIMITS.detail, description: 'What choosing it means, when the label leaves it out.' },
        recommended: { type: 'boolean', description: 'true on exactly one option: the one you recommend.' } }, ['key', 'label']) },
  } });
/** A new task's fields, for create_task and each entry of create_tasks. */
const NEW_TASK = Object.freeze({ title: { type: 'string', maxLength: HOSTED_TASK_LIMITS.title },
  description: { type: 'string', maxLength: HOSTED_TASK_LIMITS.body },
  type: { type: 'string', enum: TYPES, description: 'decision records a choice; label it human when a person must make it.' },
  priority: { type: 'integer', minimum: 0, maximum: 4, description: '0 is most urgent.' },
  labels: { type: 'array', items: { type: 'string' }, maxItems: HOSTED_TASK_LIMITS.labels },
  parent: { type: 'string', description: 'A parent task id.' },
  acceptance: { type: 'string', maxLength: HOSTED_TASK_LIMITS.body, description: 'What proves it done.' },
  depends_on: TASK_IDS('Tasks this one waits on: it is not ready until they close.'),
  blocks: TASK_IDS('Tasks that wait on this one.'),
  related: TASK_IDS('Tasks it relates to, without waiting on them.'),
  discovered_from: TASK_IDS('Tasks whose work turned this one up.'),
  approval: { type: 'string', maxLength: GATE_REASON_MAX,
    description: 'What a person must approve before it proceeds. Opens a gate that holds it out of ready work, as request_human_approval does.' },
  choices: CHOICES });
const READ = Object.freeze({ readOnlyHint: true, idempotentHint: true, openWorldHint: false });
const WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });

async function write(context: ToolContext, projectId: string, operation: HostedTaskOperation, idempotencyKey: string,
  present: (value: unknown) => unknown): Promise<Record<string, unknown>> {
  let outcome: HostedTaskWriteOutcome;
  try {
    outcome = await context.operations.write(context.proof, context.workspaceId, { projectId, operation }, idempotencyKey);
  } catch (error) {
    if (error instanceof HostedTaskReceiptsUnavailable) refuse('unavailable: retry-safe task changes are not configured on this server');
    throw error;
  }
  if (outcome.status === 'pending') {
    refuse('pending: an earlier call with this idempotency_key may still be running or its result is not yet known; retry later with the same key');
  }
  if (outcome.status === 'conflict') {
    refuse('conflict: this idempotency_key was first used for a different change. Resend that call unchanged to read its result, '
      + 'or choose a new key for this one.');
  }
  return { ...(present(outcome.value) as object), replayed: outcome.replayed };
}
/** A write that repeats without a second effect, so it takes no key. */
async function change(context: ToolContext, projectId: string, operation: HostedTaskOperation): Promise<void> {
  const outcome = await context.operations.write(context.proof, context.workspaceId, { projectId, operation });
  if (outcome.status !== 'done') refuse('unavailable: the change could not be confirmed; retry it');
}
/** What lint finds missing from each task just written, or null when it could
 * not be read. The write has already happened either way. */
async function linted(context: ToolContext, projectId: string, taskIds: readonly string[]): Promise<ReadonlyMap<string, readonly string[]> | null> {
  if (!taskIds.length) return new Map();
  try { return await context.operations.lint(context.proof, context.workspaceId, projectId, taskIds); } catch { return null; }
}
/** Lint's missing sections, with advice when there is some. Missing is left
 * out when lint could not be read. */
function lintOf(found: ReadonlyMap<string, readonly string[]> | null, taskId: string,
  advice: readonly string[] = []): Record<string, readonly string[]> | null {
  if (found === null) return advice.length ? { advice } : null;
  return { missing: found.get(taskId) ?? [], ...(advice.length ? { advice } : {}) };
}
/** A task as it is after a write, read back whole: the task client's own reply
 * to a change leaves out its parent and links. Null when it could not be read;
 * the write has already happened either way. */
async function current(context: ToolContext, projectId: string, taskId: string): Promise<Record<string, unknown> | null> {
  try {
    const detail = await context.operations.task(context.proof, context.workspaceId, projectId, taskId);
    return presentTask(detail.task as LiveTask, true);
  } catch { return null; }
}
/** An approval request as every reply shows it, saying plainly what it does to the task. */
function approvalOf(taskId: string, gate: Record<string, unknown>): Record<string, unknown> {
  return { approval: { id: gate.id, status: gate.status, reason: gateReason(gate.description) }, held: true,
    note: `${taskId} is out of ready work until a person approves ${String(gate.id)} on Tasks in the Tower.` };
}
/** One create_tasks entry's own idempotency key: the call's key and the entry's
 * place, so a retried call replays each entry it already made. */
function entryKey(key: string, index: number): string {
  return `batch.${createHash('sha256').update(`noticeos-task-batch-v1:${key}`).digest('hex').slice(0, 40)}.${index}`;
}
/** A tool that reads object arguments sent as JSON text (objectsFromText).
 * Its reply then opens with the stale-client line, and an argument refusal
 * starts with it; any other failure stands as it was. */
function readingText(tool: TaskTool): TaskTool {
  return Object.freeze({ ...tool, async run(context: ToolContext, args: Args) {
    const read = objectsFromText(tool.inputSchema as PropertySchema, args);
    const sent = [...read.text, ...read.unread];
    if (!sent.length) return tool.run(context, args);
    const line = staleClientLine(sent, context.guideVersion);
    let reply: unknown;
    try { reply = await tool.run(context, read.args); } catch (error) {
      throw error instanceof McpToolError ? new McpToolError(`${line}. ${error.message}`) : error;
    }
    return { staleClient: line, ...(reply as Record<string, unknown>) };
  } });
}

export const TASK_MCP_TOOLS: readonly TaskTool[] = Object.freeze(([
  { name: 'list_projects', description: 'List the task projects in this workspace.',
    inputSchema: schema({}), annotations: READ,
    async run({ proof, workspaceId, operations }, args) {
      only(args, []);
      return { projects: (await operations.projects(proof, workspaceId)).map(entry => ({
        projectId: entry.projectId, key: entry.logicalKey, name: entry.displayName, prefix: entry.prefix })) };
    } },
  { name: 'list_tasks', description: 'List tasks, most urgent first: every open one and those closed in the last 7 days, in one project or, '
      + 'with no project, in every project of the workspace, each then naming its project. '
      + 'Each is a summary, leaving out fields with no value; get_task reads one in full. Filters narrow it live, so search here '
      + 'rather than keeping a copy. Answers a page at a time: pass nextOffset as offset for the next.',
    inputSchema: schema({ project: { ...PROJECT, description: 'The projectId from list_projects; leave it out to list every project.' },
      query: { type: 'string', maxLength: 512, description: 'Only tasks whose id, title, description, acceptance or labels hold every word of this, ignoring case.' },
      status: { type: 'array', items: { type: 'string', enum: STATUSES }, description: 'Only these statuses.' },
      ready: { type: 'boolean', description: 'Only tasks with nothing blocking them.' },
      assignee: { type: 'string', maxLength: HOSTED_TASK_LIMITS.identifier, description: 'Only tasks assigned to this name; "me" for the tasks you hold.' },
      parent: { type: 'string', description: 'Only the direct children of this task.' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Only tasks carrying every one of these labels.' },
      type: { type: 'array', items: { type: 'string' }, description: 'Only these types, such as decision or gate.' },
      created_after: { type: 'string', description: 'Only tasks created at or after this: YYYY-MM-DD or an ISO time.' },
      created_before: { type: 'string', description: 'Only tasks created before this.' },
      updated_after: { type: 'string', description: 'Only tasks changed at or after this.' },
      updated_before: { type: 'string', description: 'Only tasks last changed before this.' },
      limit: { type: 'integer', minimum: 1, maximum: HOSTED_TASK_LIMITS.rows, description: `At most this many (default ${PAGE}).` },
      offset: { type: 'integer', minimum: 0, description: 'Skip this many, from the previous answer\'s nextOffset.' } }),
    annotations: READ,
    async run({ proof, workspaceId, operations }, args) {
      only(args, ['project', 'query', 'status', 'ready', 'assignee', 'parent', 'labels', 'type', 'created_after', 'created_before',
        'updated_after', 'updated_before', 'limit', 'offset']);
      const projectId = args.project === undefined ? undefined : project(args);
      const assignee = textArg(args, 'assignee', HOSTED_TASK_LIMITS.identifier, false);
      if (assignee !== undefined && (/[\r\n\t]/u.test(assignee) || assignee.trim() !== assignee)) {
        refuse('invalid arguments: assignee (a name on one line, or "me")');
      }
      const statuses = args.status === undefined ? STATUSES : args.status;
      if (!Array.isArray(statuses) || statuses.length < 1 || new Set(statuses).size !== statuses.length
        || statuses.some(status => !STATUSES.includes(status as HostedTaskStatus))) refuse('invalid arguments: status');
      if (args.ready !== undefined && typeof args.ready !== 'boolean') refuse('invalid arguments: ready');
      const limit = args.limit ?? PAGE, offset = args.offset ?? 0;
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > HOSTED_TASK_LIMITS.rows) {
        refuse(`invalid arguments: limit (1–${HOSTED_TASK_LIMITS.rows})`);
      }
      if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) refuse('invalid arguments: offset (0 or more)');
      const query = textArg(args, 'query', 512, false, true);
      const filter: ListFilter = defined({ words: query?.toLowerCase().split(/\s+/u).filter(Boolean) ?? [],
        parent: args.parent === undefined ? undefined : task(args, 'parent'), labels: strings(args, 'labels'), types: strings(args, 'type'),
        createdAfter: instantArg(args, 'created_after'), createdBefore: instantArg(args, 'created_before'),
        updatedAfter: instantArg(args, 'updated_after'), updatedBefore: instantArg(args, 'updated_before'),
        assignee: assignee === 'me' ? await operations.actor(proof, workspaceId) : assignee });
      const kept = (row: LiveTask) => (args.ready !== true || row.ready) && passes(row, filter);
      const nextOf = (shown: number, total: number) => offset + shown < total ? offset + shown : null;
      if (projectId !== undefined) {
        const board = await operations.board(proof, workspaceId, projectId, statuses as HostedTaskStatus[]);
        const tasks = (board.tasks as LiveTask[]).filter(kept).sort(byUrgency);
        const page = tasks.slice(offset, offset + limit);
        return { project: board.project, readAt: board.readAt, closedSince: board.closedSince, total: tasks.length,
          tasks: page.map(summaryOf), nextOffset: nextOf(page.length, tasks.length) };
      }
      // Every project, one after another: one that cannot be read is named in
      // the reply rather than failing the call. Admission is the caller's own
      // standing, so its refusal still refuses.
      const found: { readonly task: LiveTask; readonly where: Record<string, string> }[] = [];
      const unavailable: Record<string, string>[] = [];
      let readAt: unknown = null, closedSince: unknown = null;
      for (const entry of await operations.projects(proof, workspaceId)) {
        const where = { project: entry.logicalKey, projectId: entry.projectId, projectName: entry.displayName };
        let board: Record<string, unknown>;
        try { board = await operations.board(proof, workspaceId, entry.projectId, statuses as HostedTaskStatus[]); } catch (error) {
          if (error instanceof AdmissionRefused) throw error;
          unavailable.push(where); continue;
        }
        readAt ??= board.readAt; closedSince ??= board.closedSince;
        for (const row of board.tasks as LiveTask[]) if (kept(row)) found.push({ task: row, where });
      }
      found.sort((a, b) => byUrgency(a.task, b.task));
      const page = found.slice(offset, offset + limit);
      return { readAt, closedSince, total: found.length,
        tasks: page.map(({ task: row, where }) => ({ id: row.id, ...where, ...summaryOf(row) })),
        nextOffset: nextOf(page.length, found.length), ...(unavailable.length ? { unavailable } : {}) };
    } },
  { name: 'get_task', description: 'Read one task with its comments.',
    inputSchema: schema({ project: PROJECT, task: TASK }, ['project', 'task']), annotations: READ,
    async run({ proof, workspaceId, operations }, args) {
      only(args, ['project', 'task']);
      const detail = await operations.task(proof, workspaceId, project(args), task(args));
      return { project: detail.project, readAt: detail.readAt, task: presentTask(detail.task as LiveTask, true),
        comments: detail.comments };
    } },
  { name: 'get_task_history', description: 'Read how one task changed, newest first.',
    inputSchema: schema({ project: PROJECT, task: TASK,
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'At most this many changes (default 50).' } }, ['project', 'task']),
    annotations: READ,
    async run({ proof, workspaceId, operations }, args) {
      only(args, ['project', 'task', 'limit']);
      const limit = args.limit ?? 50;
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 200) refuse('invalid arguments: limit (1–200)');
      const history = await operations.history(proof, workspaceId, project(args), task(args), limit);
      if (!Array.isArray(history)) refuse('unavailable: history could not be read');
      return { changes: history.map(entry => {
        const row = (entry ?? {}) as Record<string, unknown>;
        return { revision: typeof row.CommitHash === 'string' ? row.CommitHash : null,
          at: typeof row.CommitDate === 'string' ? row.CommitDate : null, task: taskOf(row.Issue) };
      }) };
    } },
  { name: 'create_task', description: 'Create a task in a project, with its links, naming your model. The result\'s lint names sections it still lacks; '
      + 'add them with update_task. create_tasks files many in one call.',
    inputSchema: schema({ project: PROJECT, ...NEW_TASK, model: MODEL, idempotency_key: IDEMPOTENCY }, ['project', 'title', 'idempotency_key']),
    annotations: WRITE,
    async run(context, args) {
      only(args, ['project', ...CREATE_FIELDS, 'model', 'idempotency_key']);
      const { operation, approval } = creation(args, (name, value) => task({ [name]: value }, name));
      const projectId = project(args), model = modelArg(args);
      const result = await write(context, projectId, model ? { ...operation, model } : operation, key(args), value => value);
      const id = result.id as string;
      const asked = approval === undefined ? {}
        : approvalOf(id, (await context.operations.approval(context.proof, context.workspaceId, projectId, id, approval)).gate);
      return { ...result, ...asked, lint: lintOf(await linted(context, projectId, [id]), id, choiceAdvice(operation)) };
    } },
  { name: 'create_tasks', description: `Create up to ${BATCH} tasks in one call, in order, naming your model. A parent or link may name an earlier `
      + 'task of the same call as #0 for the first, #1 for the second. Stops at the first task refused and says which; '
      + 'retrying with the same idempotency_key and tasks never files one twice.',
    inputSchema: schema({ project: PROJECT,
      tasks: { type: 'array', minItems: 1, maxItems: BATCH, items: schema(NEW_TASK, ['title']) },
      model: MODEL, idempotency_key: IDEMPOTENCY }, ['project', 'tasks', 'idempotency_key']),
    annotations: WRITE,
    async run(context, args) {
      only(args, ['project', 'tasks', 'model', 'idempotency_key']);
      const projectId = project(args), batchKey = key(args), entries = args.tasks, model = modelArg(args);
      if (!Array.isArray(entries) || entries.length < 1 || entries.length > BATCH) refuse(`invalid arguments: tasks (1–${BATCH})`);
      // Every entry is read before any is filed, so a malformed one files nothing.
      const planned = entries.map((entry, index) => {
        try {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) refuse('invalid arguments: a task');
          const row = entry as Args;
          only(row, CREATE_FIELDS);
          return creation(row, (name, value) => {
            const earlier = typeof value === 'string' ? /^#(\d{1,2})$/u.exec(value) : null;
            if (!earlier) return task({ [name]: value }, name);
            if (Number(earlier[1]) >= index) refuse(`invalid arguments: ${name} (#n names an earlier task of this call)`);
            return value as string;
          });
        } catch (error) {
          throw error instanceof McpToolError ? new McpToolError(error.message.replace(/^invalid arguments: /u, `invalid arguments: tasks[${index}]: `)) : error;
        }
      });
      const made: { index: number; id: string; replayed: boolean; approval?: Record<string, unknown> }[] = [];
      let projectKey: unknown = null;
      const earlier = (id: string) => id.startsWith('#') ? made[Number(id.slice(1))]!.id : id;
      let failed: Record<string, unknown> | null = null;
      for (const [index, { operation, approval }] of planned.entries()) {
        const resolved = defined({ ...operation, parent: operation.parent === undefined ? undefined : earlier(operation.parent),
          links: operation.links?.map(link => ({ type: link.type, taskId: earlier(link.taskId) })), model });
        let id: string | undefined;
        try {
          const result = await write(context, projectId, resolved, entryKey(batchKey, index), value => value);
          id = result.id as string; projectKey = result.project;
          const asked = approval === undefined ? undefined
            : (await context.operations.approval(context.proof, context.workspaceId, projectId, id, approval)).gate;
          made.push({ index, id, replayed: result.replayed as boolean, ...(asked ? { approval: asked } : {}) });
        } catch (error) {
          failed = { index, ...(id === undefined ? {} : { id }), error: taskRefusal(error).message };
          break;
        }
      }
      const found = await linted(context, projectId, made.map(entry => entry.id));
      return { project: projectKey,
      created: made.map(({ index, id, replayed, approval }) => ({ index, id, replayed,
        ...(approval ? { approval: { id: approval.id, status: approval.status, reason: gateReason(approval.description) }, held: true } : {}),
        lint: lintOf(found, id, choiceAdvice(planned[index]!.operation)) })),
      ...(made.some(entry => entry.approval) ? { note: 'A task with an approval is out of ready work until a person approves it on Tasks in the Tower.' } : {}),
      ...(failed ? { failed, notAttempted: planned.length - made.length - 1,
        retry: 'Retry with the same idempotency_key and tasks to finish after a passing failure; tasks already filed are not repeated. '
          + 'To change a refused task, send it and the rest with a new key, naming filed tasks by id.' } : {}) };
    } },
  { name: 'claim_task', description: 'Assign an open task to yourself and start it, naming your model. Fails if someone else holds it.',
    inputSchema: schema({ project: PROJECT, task: TASK, model: MODEL, idempotency_key: IDEMPOTENCY }, ['project', 'task', 'idempotency_key']),
    annotations: WRITE,
    async run(context, args) {
      only(args, ['project', 'task', 'model', 'idempotency_key']);
      const projectId = project(args), taskId = task(args), model = modelArg(args);
      const { replayed } = await write(context, projectId, { kind: 'update', taskId, claim: true, ...(model ? { model } : {}) }, key(args), () => ({}));
      return { task: await current(context, projectId, taskId), replayed };
    } },
  { name: 'update_task', description: 'Change a task\'s fields. Use close_task to close one and claim_task to take one. The result\'s lint names sections it still lacks.',
    inputSchema: schema({ project: PROJECT, task: TASK, status: { type: 'string', enum: STATUSES.filter(status => status !== 'closed') },
      priority: { type: 'integer', minimum: 0, maximum: 4 }, title: { type: 'string', maxLength: HOSTED_TASK_LIMITS.title },
      description: { type: 'string', maxLength: HOSTED_TASK_LIMITS.body }, assignee: { type: 'string' },
      parent: { type: 'string', description: 'A parent task id, or "" for none.' },
      defer: { type: 'string', description: 'YYYY-MM-DD to hide it until then, or "" to clear.' },
      acceptance: { type: 'string', maxLength: HOSTED_TASK_LIMITS.body },
      add_labels: { type: 'array', items: { type: 'string' } }, remove_labels: { type: 'array', items: { type: 'string' } },
      choices: { ...CHOICES, type: ['object', 'null'],
        description: 'A whole new set of choices, or null to take them off. Refused once a person has chosen.' },
      idempotency_key: IDEMPOTENCY }, ['project', 'task', 'idempotency_key']),
    annotations: WRITE,
    async run(context, args) {
      only(args, ['project', 'task', 'status', 'priority', 'title', 'description', 'assignee', 'parent', 'defer',
        'acceptance', 'add_labels', 'remove_labels', 'choices', 'idempotency_key']);
      const operation = defined({ kind: 'update' as const, taskId: task(args),
        status: choice(args, 'status', STATUSES.filter(status => status !== 'closed')), priority: priority(args),
        title: textArg(args, 'title', HOSTED_TASK_LIMITS.title, false),
        description: textArg(args, 'description', HOSTED_TASK_LIMITS.body, false, true),
        assignee: textArg(args, 'assignee', HOSTED_TASK_LIMITS.identifier, false, true),
        parent: args.parent === undefined || args.parent === '' ? args.parent as string | undefined : task(args, 'parent'),
        defer: deferArg(args), acceptance: textArg(args, 'acceptance', HOSTED_TASK_LIMITS.body, false, true),
        addLabels: labels(args, 'add_labels', 1), removeLabels: labels(args, 'remove_labels', 1),
        choices: args.choices === null ? null : choicesArg(args) });
      if (Object.keys(operation).length === 2) refuse('invalid arguments: name at least one field to change');
      const projectId = project(args);
      const { replayed } = await write(context, projectId, operation, key(args), () => ({}));
      const changed = await current(context, projectId, operation.taskId);
      return { task: changed, replayed, lint: lintOf(await linted(context, projectId, [operation.taskId]), operation.taskId, choiceAdvice(changed)) };
    } },
  { name: 'comment_on_task', description: 'Add a comment to a task.',
    inputSchema: schema({ project: PROJECT, task: TASK, text: { type: 'string', maxLength: HOSTED_TASK_LIMITS.comment },
      idempotency_key: IDEMPOTENCY }, ['project', 'task', 'text', 'idempotency_key']),
    annotations: WRITE,
    async run(context, args) {
      only(args, ['project', 'task', 'text', 'idempotency_key']);
      return write(context, project(args), { kind: 'comment', taskId: task(args), text: textArg(args, 'text', HOSTED_TASK_LIMITS.comment)! },
        key(args), value => ({ comment: toComment(value) }));
    } },
  { name: 'add_dependency', description: 'Record that a task depends on another. A blocks dependency, the default, keeps the task out of ready work until the other is closed.',
    inputSchema: schema({ project: PROJECT, task: TASK, depends_on: { type: 'string', description: 'The task id it depends on.' },
      type: { type: 'string', enum: DEPENDENCY_TYPES, description: 'blocks (default), related or discovered-from.' } }, ['project', 'task', 'depends_on']),
    annotations: WRITE,
    async run(context, args) {
      only(args, ['project', 'task', 'depends_on', 'type']);
      const operation = { kind: 'depend' as const, taskId: task(args), dependsOn: task(args, 'depends_on'),
        type: choice(args, 'type', DEPENDENCY_TYPES) ?? 'blocks' };
      if (operation.taskId === operation.dependsOn) refuse('invalid arguments: a task cannot depend on itself');
      await change(context, project(args), operation);
      return { task: operation.taskId, dependsOn: operation.dependsOn, type: operation.type };
    } },
  { name: 'remove_dependency', description: 'Remove a dependency between two tasks. One on a human gate or decision stays until a person decides it.',
    inputSchema: schema({ project: PROJECT, task: TASK, depends_on: { type: 'string', description: 'The task id it depends on.' } },
      ['project', 'task', 'depends_on']),
    annotations: Object.freeze({ ...WRITE, destructiveHint: true }),
    async run(context, args) {
      only(args, ['project', 'task', 'depends_on']);
      const operation = { kind: 'undepend' as const, taskId: task(args), dependsOn: task(args, 'depends_on') };
      if (operation.taskId === operation.dependsOn) refuse('invalid arguments: a task cannot depend on itself');
      await change(context, project(args), operation);
      return { task: operation.taskId, dependsOn: operation.dependsOn, removed: true };
    } },
  { name: 'request_human_approval', description: 'Ask a person to approve before a task proceeds. This opens a gate, a separate item '
      + 'that holds the task out of ready work until someone approves it on Tasks in the Tower. To ask without holding the task, comment '
      + 'on it instead. Asking again with the same reason returns the open request.',
    inputSchema: schema({ project: PROJECT, task: TASK,
      reason: { type: 'string', maxLength: GATE_REASON_MAX, description: 'What the person is asked to approve.' } }, ['project', 'task', 'reason']),
    annotations: WRITE,
    async run({ proof, workspaceId, operations }, args) {
      only(args, ['project', 'task', 'reason']);
      const taskId = task(args);
      const { gate, created } = await operations.approval(proof, workspaceId, project(args), taskId,
        textArg(args, 'reason', GATE_REASON_MAX)!);
      return { task: taskId, ...approvalOf(taskId, gate), created };
    } },
  { name: 'close_task', description: 'Close a task with the reason it is done, citing evidence such as a commit or URL, and naming your model. '
      + 'When nothing shipped, pass the resolution that says why; the reason still cites the evidence. '
      + 'A task it depends on may still be open; an approval it waits on must be given first.',
    inputSchema: schema({ project: PROJECT, task: TASK, reason: { type: 'string', maxLength: HOSTED_TASK_LIMITS.reason },
      resolution: { type: 'string', enum: TASK_RESOLUTIONS, description: 'How it ended: done (the default) when the work shipped; wont-do, '
        + 'duplicate, cant-reproduce or already-handled when nothing did.' },
      duplicate_of: { type: 'string', description: 'With resolution duplicate: the id of the task in this project it duplicates. The two are linked as related.' },
      model: MODEL, idempotency_key: IDEMPOTENCY }, ['project', 'task', 'reason', 'idempotency_key']),
    annotations: WRITE,
    async run(context, args) {
      only(args, ['project', 'task', 'reason', 'resolution', 'duplicate_of', 'model', 'idempotency_key']);
      const projectId = project(args), taskId = task(args), model = modelArg(args);
      const resolution = choice(args, 'resolution', TASK_RESOLUTIONS);
      const duplicateOf = args.duplicate_of === undefined ? undefined : task(args, 'duplicate_of');
      if (resolution === 'duplicate' && duplicateOf === undefined) refuse('invalid arguments: duplicate_of (required with resolution duplicate: the task this one duplicates)');
      if (duplicateOf !== undefined && resolution !== 'duplicate') refuse('invalid arguments: duplicate_of (only with resolution duplicate)');
      if (duplicateOf === taskId) refuse('invalid arguments: duplicate_of (another task than the one closing)');
      const { replayed } = await write(context, projectId, { kind: 'close', taskId, reason: textArg(args, 'reason', HOSTED_TASK_LIMITS.reason)!,
        ...(model ? { model } : {}), ...(resolution === undefined ? {} : { resolution }), ...(duplicateOf === undefined ? {} : { duplicateOf }) },
      key(args), () => ({}));
      return { task: await current(context, projectId, taskId), replayed };
    } },
] satisfies TaskTool[]).map(readingText));
