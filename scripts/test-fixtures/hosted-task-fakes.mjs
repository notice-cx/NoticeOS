import { answerSteps, choiceSteps, closerMetadata, readRelatedTasks } from '../hosted-task-command.mjs';

// Shared fakes for the hosted task operation, HTTP and MCP tests.
// The receipt store keeps packages/postgres/src/task-receipts.mts's
// compare-and-set rules (scripts/postgres-task-receipts.test.mjs proves the
// real one); the executor answers in the pinned task client's JSON shapes and
// can fail before or after its effect lands.

export function memoryReceipts(clock) {
  const rows = new Map();
  const id = (workspace, identity) => [workspace, identity.principalId, identity.operation, identity.idempotencyKey].join('|');
  const view = row => Object.freeze({ operationId: row.operationId, state: row.state, attempt: row.attempt,
    result: row.result === null ? null : structuredClone(row.result), createdAt: row.createdAt, startedAt: row.startedAt, finishedAt: row.finishedAt });
  const current = (workspace, identity, attempt, states) => {
    const row = rows.get(id(workspace, identity));
    return row && row.operationId === attempt.operationId && row.attempt === attempt.attempt && states.includes(row.state) ? row : null;
  };
  // Seven days after its last attempt a receipt is swept (migration 0013).
  const expired = row => Date.parse(row.finishedAt ?? row.startedAt) < clock() - 7 * 86_400_000;
  return { rows, async start(workspace, request, operationId) {
    for (const [key, row] of rows) if (key.startsWith(`${workspace}|`) && expired(row)) rows.delete(key);
    const found = rows.get(id(workspace, request));
    if (found) return found.projectId === request.projectId && found.requestHash === request.requestHash
      ? { kind: 'existing', receipt: view(found) } : { kind: 'conflict' };
    const at = new Date(clock()).toISOString();
    const row = { projectId: request.projectId, requestHash: request.requestHash, operationId, state: 'pending', attempt: 1,
      result: null, createdAt: at, startedAt: at, finishedAt: null };
    rows.set(id(workspace, request), row); return { kind: 'started', receipt: view(row) };
  }, async finish(workspace, identity, attempt, result) {
    const row = current(workspace, identity, attempt, ['pending', 'interrupted']); if (!row) return false;
    Object.assign(row, { state: 'succeeded', result: structuredClone(result), finishedAt: new Date(clock()).toISOString() }); return true;
  }, async interrupt(workspace, identity, attempt) {
    const row = current(workspace, identity, attempt, ['pending']); if (!row) return false;
    Object.assign(row, { state: 'interrupted', finishedAt: new Date(clock()).toISOString() }); return true;
  }, async retry(workspace, identity, attempt) {
    const row = current(workspace, identity, attempt, [attempt.state]); if (!row || row.attempt >= 5) return null;
    Object.assign(row, { state: 'pending', attempt: row.attempt + 1, startedAt: new Date(clock()).toISOString(), finishedAt: null });
    return view(row);
  } };
}

/** An executor over one in-memory project. `principal()` is the admitted actor,
 * as the real executor passes it to every command. */
export function fakeTaskExecutor({ principal, clock }) {
  const tasks = new Map(), comments = [], effects = [], calls = [], edges = [], attributions = [];
  let fail = null, hold = null;
  const row = task => ({ issue_type: 'task', ...task, schema_version: 1 });
  // As show embeds them: the whole other task, with the edge's type.
  const dependencies = id => edges.filter(edge => edge.from === id)
    .map(edge => ({ ...row(tasks.get(edge.to) ?? { id: edge.to, title: 'Task', status: 'open' }), dependency_type: edge.type }));
  const blocked = id => dependencies(id).some(edge => edge.dependency_type === 'blocks' && edge.status !== 'closed');
  const edge = operation => ({ issue_id: operation.taskId, depends_on_id: operation.dependsOn, schema_version: 1 });
  const executor = { async execute(_proof, workspace, request) {
    const operation = request.operation; calls.push({ workspace, operation });
    if (hold && !['active-board', 'closed-board', 'comments', 'show', 'ready', 'epics', 'history'].includes(operation.kind)) await hold;
    if (fail === 'before') { fail = null; throw new Error('refused before any effect'); }
    let value;
    switch (operation.kind) {
      case 'create': {
        // As the task client does: a missing parent or link target refuses the whole create.
        for (const target of [operation.parent, ...(operation.links ?? []).map(link => link.taskId)]) {
          if (target !== undefined && !tasks.has(target)) throw new Error(`no issue found matching ${target}`);
        }
        const id = `tt-${tasks.size + 1}`, at = new Date(clock()).toISOString();
        tasks.set(id, { id, title: operation.title, status: 'open', priority: operation.priority ?? 2,
          ...(operation.type ? { issue_type: operation.type } : {}), ...(operation.description ? { description: operation.description } : {}),
          ...(operation.labels?.length ? { labels: [...operation.labels] } : {}), ...(operation.parent ? { parent: operation.parent } : {}),
          ...(operation.acceptance ? { acceptance_criteria: operation.acceptance } : {}), created_at: at, updated_at: at,
          metadata: { ...structuredClone(operation.metadata ?? {}), ...(operation.operationId ? { noticeos_operation_id: operation.operationId } : {}),
            ...(operation.related ? { noticeos_related_tasks: structuredClone(operation.related) } : {}),
            ...(operation.filedBy ? { noticeos_filed_by: operation.filedBy } : {}),
            ...(operation.model ? { noticeos_filed_model: operation.model } : {}),
            ...(operation.choices ? { noticeos_choices: structuredClone(operation.choices) } : {}),
            ...(operation.card ? { noticeos_card: structuredClone(operation.card) } : {}),
            ...(operation.changeClass ? { noticeos_change_class: operation.changeClass } : {}) },
          ...(operation.card?.kill ? { due_at: `${operation.card.kill.date}T00:00:00Z` } : {}) });
        if (operation.parent) edges.push({ from: id, to: operation.parent, type: 'parent-child' });
        for (const link of operation.links ?? []) {
          if (link.type === 'blocks') edges.push({ from: link.taskId, to: id, type: 'blocks' });
          else edges.push({ from: id, to: link.taskId, type: link.type === 'blocked-by' ? 'blocks' : link.type });
        }
        effects.push(['create', id]); value = row(tasks.get(id)); break;
      }
      case 'comment': {
        const comment = { id: `c-${comments.length + 1}`, issue_id: operation.taskId, author: principal(), text: operation.text,
          created_at: new Date(clock()).toISOString().replace(/\.\d{3}Z$/u, 'Z'), schema_version: 1 };
        comments.push(comment); effects.push(['comment', comment.id]); value = comment; break;
      }
      case 'relate': {
        const task = tasks.get(operation.taskId);
        const refs = new Map([...readRelatedTasks(task.metadata), ...operation.related].map(ref => [`${ref.projectId}:${ref.taskId}`, ref]));
        task.metadata = { ...task.metadata, noticeos_related_tasks: [...refs.values()] };
        value = [row(task)]; break;
      }
      case 'update': case 'close': {
        const task = tasks.get(operation.taskId) ?? { id: operation.taskId, title: 'Task', status: 'open', priority: 2 };
        if (operation.kind === 'close') Object.assign(task, { status: 'closed', close_reason: operation.reason,
          closed_at: new Date(clock()).toISOString().replace(/\.\d{3}Z$/u, 'Z') });
        if (operation.claim) Object.assign(task, { status: 'in_progress', assignee: principal() });
        if (operation.model !== undefined) task.metadata = { ...task.metadata, noticeos_claimed_model: operation.model };
        // As --metadata merges the new set in and --unset-metadata takes it off.
        if (operation.choices === null) { const { noticeos_choices: _gone, ...kept } = task.metadata ?? {}; task.metadata = kept; }
        else if (operation.choices !== undefined) task.metadata = { ...task.metadata, noticeos_choices: structuredClone(operation.choices) };
        for (const [field, name] of [['card', 'noticeos_card'], ['changeClass', 'noticeos_change_class']]) {
          if (operation[field] === null) { const { [name]: _gone, ...kept } = task.metadata ?? {}; task.metadata = kept; }
          else if (operation[field] !== undefined) task.metadata = { ...task.metadata, [name]: structuredClone(operation[field]) };
        }
        if (operation.card?.kill) task.due_at = `${operation.card.kill.date}T00:00:00Z`;
        for (const field of ['status', 'priority', 'title']) if (operation[field] !== undefined) task[field] = operation[field];
        if (operation.description !== undefined) task.description = operation.description;
        if (operation.acceptance !== undefined) task.acceptance_criteria = operation.acceptance;
        if (operation.addLabels) task.labels = [...new Set([...(task.labels ?? []), ...operation.addLabels])];
        if (operation.removeLabels) task.labels = (task.labels ?? []).filter(label => !operation.removeLabels.includes(label));
        task.updated_at = new Date(clock()).toISOString();
        tasks.set(task.id, task); effects.push([operation.kind, operation.taskId]);
        // The task client's reply to a change carries neither parent nor links.
        const { parent: _parent, ...changed } = row(task); value = [changed]; break;
      }
      case 'choose': case 'respond': {
        // As the real executor composes them: the shared planners, each step applied as the task client would.
        const task = tasks.get(operation.taskId);
        const shown = { ...row(task), dependencies: dependencies(operation.taskId), dependents: [] };
        const steps = operation.kind === 'choose'
          ? choiceSteps(operation, shown, comments.filter(entry => entry.issue_id === operation.taskId), principal(), new Date(clock()).toISOString())
          : answerSteps(operation, shown) ?? [{ kind: 'comment', taskId: operation.taskId, text: `Response: ${operation.response}` },
            { kind: 'close', taskId: operation.taskId, reason: 'Responded' }];
        for (const step of steps) {
          if (step.kind === 'record-choice') task.metadata = { ...task.metadata, noticeos_choice: structuredClone(step.choice) };
          if (step.kind === 'comment') comments.push({ id: `c-${comments.length + 1}`, issue_id: step.taskId, author: principal(), text: step.text,
            created_at: new Date(clock()).toISOString().replace(/\.\d{3}Z$/u, 'Z'), schema_version: 1 });
          if (step.kind === 'close') Object.assign(task, { status: 'closed', close_reason: step.reason, closed_at: new Date(clock()).toISOString() });
          if (step.kind === 'hand-back') {
            Object.assign(task, { status: 'open' }); delete task.assignee;
            if (step.removeHuman) task.labels = (task.labels ?? []).filter(label => label !== 'human');
          }
        }
        effects.push([operation.kind, operation.taskId]); value = { id: task.id, status: task.status }; break;
      }
      case 'dismiss': {
        // As the real executor runs it: the task client's dismissal, then its record.
        const task = tasks.get(operation.taskId), at = new Date(clock()).toISOString().replace(/\.\d{3}Z$/u, 'Z');
        Object.assign(task, { status: 'closed', close_reason: operation.reason === undefined ? 'Dismissed' : `Dismissed: ${operation.reason}`, closed_at: at });
        task.metadata = { ...task.metadata, ...closerMetadata({ kind: 'attribute', taskId: task.id, closedBy: principal(), closedAt: at,
          resolution: operation.resolution ?? 'wont-do', ...(operation.duplicateOf === undefined ? {} : { duplicateOf: operation.duplicateOf }) }) };
        effects.push(['dismiss', task.id]); value = { id: task.id, status: task.status }; break;
      }
      case 'attribute': {
        // As the task client merges --metadata into what the task carries.
        if (fail === 'attribute') { fail = null; throw new Error('the closer was not recorded'); }
        const task = tasks.get(operation.taskId);
        task.metadata = { ...task.metadata, ...closerMetadata(operation) };
        attributions.push([operation.taskId, operation.closedBy]); value = [row(task)]; break;
      }
      case 'active-board': value = [...tasks.values()].filter(task => task.status !== 'closed').map(row); break;
      case 'closed-board': value = [...tasks.values()].filter(task => task.status === 'closed' && task.closed_at >= operation.since).map(row); break;
      case 'ready': value = [...tasks.values()].filter(task => task.status === 'open' && task.issue_type !== 'gate' && !blocked(task.id))
        .map(task => ({ id: task.id })); break;
      case 'show': value = [{ ...row(tasks.get(operation.taskId) ?? { id: operation.taskId, title: 'Task', status: 'open' }),
        dependencies: dependencies(operation.taskId) }]; break;
      case 'find': value = operation.taskIds.filter(id => tasks.has(id)).map(id => row(tasks.get(id))); break;
      case 'depend': {
        // Beads keeps one edge per pair and never retypes it.
        const found = edges.find(edge => edge.from === operation.taskId && edge.to === operation.dependsOn);
        if (found && found.type !== operation.type) throw new Error('the dependency exists with another type');
        if (!found) { edges.push({ from: operation.taskId, to: operation.dependsOn, type: operation.type }); effects.push(['depend', operation.taskId]); }
        value = { ...edge(operation), type: operation.type, status: 'added' }; break;
      }
      case 'undepend': {
        const at = edges.findIndex(edge => edge.from === operation.taskId && edge.to === operation.dependsOn);
        if (at >= 0) { edges.splice(at, 1); effects.push(['undepend', operation.taskId]); }
        value = { ...edge(operation), status: 'removed' }; break;
      }
      case 'gate': {
        const id = `tt-${tasks.size + 1}`;
        tasks.set(id, { id, title: 'Gate: human', status: 'open', priority: 2, issue_type: 'gate', await_type: 'human',
          description: `Ad-hoc gate blocking ${operation.taskId}\n\nReason: ${operation.reason}` });
        edges.push({ from: operation.taskId, to: id, type: 'blocks' }); effects.push(['gate', id]);
        value = row(tasks.get(id)); break;
      }
      case 'lint': {
        // The sections bd lint expects of a task and of a decision.
        const results = operation.taskIds.map(id => tasks.get(id)).filter(Boolean).map(task => {
          const type = task.issue_type ?? 'task';
          const missing = type === 'task' && !task.acceptance_criteria ? ['## Acceptance Criteria']
            : type === 'decision' && !task.description?.includes('## Decision') ? ['## Decision'] : [];
          return { id: task.id, title: task.title, type, missing, warnings: missing.length };
        }).filter(result => result.missing.length);
        value = { total: operation.taskIds.length, issues: results.length, results: results.length ? results : null }; break;
      }
      case 'comments': value = comments.filter(comment => comment.issue_id === operation.taskId); break;
      case 'history': value = [{ CommitHash: 'abc123', Committer: 'beads', CommitDate: '2026-10-07T12:00:00.000Z',
        Issue: row(tasks.get(operation.taskId) ?? { id: operation.taskId, title: 'Task', status: 'open' }) }]; break;
      default: value = [];
    }
    if (fail === 'after') { fail = null; throw new Error('reply lost after the effect'); }
    return value;
  } };
  return { executor, tasks, comments, edges, effects, calls, attributions, fail: when => { fail = when; }, hold: promise => { hold = promise; } };
}
