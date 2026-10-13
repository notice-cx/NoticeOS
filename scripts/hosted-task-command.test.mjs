import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostedTaskPlanner, decisionGuardTargets, HOSTED_TASK_LIMITS, hostedTaskAction, isHumanDecision } from './hosted-task-command.mjs';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const DEMO = '33333333-3333-3333-3333-333333333333';
const ca = Symbol(), cb = Symbol(), cd = Symbol();
const entries = [
  { workspaceId: A, projectId: 'shared', capability: ca },
  { workspaceId: B, projectId: 'shared', capability: cb },
  { workspaceId: B, projectId: 'only-b', capability: Symbol() },
  { workspaceId: DEMO, projectId: 'shared', capability: cd },
];
const request = operation => ({ projectId: 'shared', operation });
const denied = action => assert.throws(action, { message: 'Invalid hosted task plan input.' });

test('colliding project/task IDs resolve through the separately selected workspace', () => {
  const plan = createHostedTaskPlanner(entries);
  const command = request({ kind: 'show', taskId: 'tt-collision' });
  const pa = plan(A, command), pb = plan(B, command), pd = plan(DEMO, command);
  assert.equal(pa.capability, ca); assert.equal(pb.capability, cb); assert.equal(pd.capability, cd);
  assert.deepEqual(pa.argv, pb.argv);
  assert.notEqual(pa.capability, pb.capability);
  denied(() => plan(A, { projectId: 'only-b', operation: command.operation }));
  denied(() => plan(A, { projectId: 'missing', operation: command.operation }));
  denied(() => plan('44444444-4444-4444-4444-444444444444', command));
  // This is not authorization: the server must establish A/B/DEMO admission.
  assert.equal(plan(DEMO, request({ kind: 'create', title: 'Scenario task' })).readOnly, false);
});

const cases = [
  [{ kind: 'list', limit: 20, status: 'open' }, true, ['list', '--limit=20', '--status=open']],
  [{ kind: 'show', taskId: 'tt-a.1' }, true, ['show', '--', 'tt-a.1']],
  [{ kind: 'history', taskId: 'tt-a', limit: 5 }, true, ['history', '--limit=5', '--', 'tt-a']],
  [{ kind: 'comments', taskId: 'tt-a' }, true, ['comments', '--', 'tt-a']],
  [{ kind: 'ready' }, true, ['ready', '--limit=0']],
  [{ kind: 'epics' }, true, ['epic', 'status']],
  [{ kind: 'active-board', statuses: ['open', 'blocked'] }, true, ['list', '--status=open,blocked', '--limit=0', '--include-gates']],
  [{ kind: 'closed-board', since: '2026-09-24', until: '2026-10-01T12:00:00.000Z' }, true,
    ['list', '--status=closed', '--closed-after=2026-09-24', '--closed-before=2026-10-01T12:00:00.000Z', '--limit=0', '--include-gates']],
  [{ kind: 'create', title: 'Repair task', description: 'Concrete details', type: 'bug', priority: 0 }, false,
    ['create', '--description=Concrete details', '--type=bug', '--priority=0', '--title=Repair task', '--']],
  [{ kind: 'update', taskId: 'tt-a', status: 'in_progress', priority: 4, title: 'New title', description: '' }, false,
    ['update', '--status=in_progress', '--priority=4', '--title=New title', '--description=', '--', 'tt-a']],
  [{ kind: 'comment', taskId: 'tt-a', text: 'Checked the handoff' }, false, ['comments', 'add', '--', 'tt-a', 'Checked the handoff']],
  [{ kind: 'close', taskId: 'tt-a', reason: 'Evidence checked' }, false, ['close', '--reason=Evidence checked', '--', 'tt-a']],
  [{ kind: 'respond', taskId: 'tt-a', response: '--file=literal answer' }, false, ['human', 'respond', '--response=--file=literal answer', '--', 'tt-a']],
  [{ kind: 'dismiss', taskId: 'tt-a', reason: '--database=literal reason' }, false, ['human', 'dismiss', '--reason=--database=literal reason', '--', 'tt-a']],
  [{ kind: 'resolve-gate', taskId: 'tt-a' }, false, ['gate', 'resolve', '--', 'tt-a']],
  [{ kind: 'lint', taskIds: ['tt-a', 'tt-b.1'] }, true, ['lint', '--', 'tt-a', 'tt-b.1']],
  [{ kind: 'create', title: 'Pick the store', type: 'decision', parent: 'tt-e', links: [{ type: 'blocked-by', taskId: 'tt-a' },
    { type: 'blocks', taskId: 'tt-b' }, { type: 'related', taskId: 'tt-c' }, { type: 'discovered-from', taskId: 'tt-d' }] }, false,
  ['create', '--type=decision', '--parent=tt-e', '--no-inherit-labels', '--deps=blocked-by:tt-a,blocks:tt-b,related:tt-c,discovered-from:tt-d',
    '--title=Pick the store', '--']],
  [{ kind: 'depend', taskId: 'tt-a', dependsOn: 'tt-b', type: 'blocks' }, false, ['dep', 'add', '--type=blocks', '--', 'tt-a', 'tt-b']],
  [{ kind: 'undepend', taskId: 'tt-a', dependsOn: 'tt-b' }, false, ['dep', 'remove', '--', 'tt-a', 'tt-b']],
  [{ kind: 'gate', taskId: 'tt-a', reason: '--file=literal ask' }, false,
    ['gate', 'create', '--type=human', '--blocks=tt-a', '--reason=--file=literal ask', '--']],
];
for (const [operation, readOnly, tokens] of cases) test(`${operation.kind} has a fixed bounded command shape`, () => {
  const plan = createHostedTaskPlanner(entries)(A, request(operation));
  assert.equal(plan.kind, operation.kind); assert.equal(plan.readOnly, readOnly);
  assert.deepEqual(plan.argv, ['--sandbox', '--json', ...(readOnly ? ['--readonly'] : []), ...tokens]);
});

test('decision classification validates payloads and never treats generic closure as a decision', () => {
  assert.equal(hostedTaskAction({ kind: 'respond', taskId: 'tt-a', response: 'Approved' }), 'tasks.decide');
  assert.equal(hostedTaskAction({ kind: 'dismiss', taskId: 'tt-a' }), 'tasks.decide');
  assert.equal(hostedTaskAction({ kind: 'resolve-gate', taskId: 'tt-a', reason: 'Reviewed' }), 'tasks.decide');
  assert.equal(hostedTaskAction({ kind: 'close', taskId: 'tt-a', reason: 'Evidence' }), 'tasks.write');
  assert.equal(hostedTaskAction({ kind: 'show', taskId: 'tt-a' }), 'tasks.read');
  for (const operation of [{ kind: 'respond', taskId: 'tt-a', response: '' },
    { kind: 'respond', taskId: 'tt-a', response: 'x'.repeat(HOSTED_TASK_LIMITS.comment + 1) },
    { kind: 'dismiss', taskId: 'tt-a', file: '/owned/caller' },
    { kind: 'resolve-gate', taskId: '--global' },
    { kind: 'resolve-gate', taskId: 'tt-a', actor: 'operator' }]) denied(() => hostedTaskAction(operation));
});

test('an agent opens a gate with write access; dependency edges are bounded and never onto the task itself', () => {
  assert.equal(hostedTaskAction({ kind: 'gate', taskId: 'tt-a', reason: 'Approve' }), 'tasks.write');
  assert.equal(hostedTaskAction({ kind: 'depend', taskId: 'tt-a', dependsOn: 'tt-b', type: 'discovered-from' }), 'tasks.write');
  assert.equal(hostedTaskAction({ kind: 'lint', taskIds: ['tt-a'] }), 'tasks.read');
  for (const operation of [{ kind: 'depend', taskId: 'tt-a', dependsOn: 'tt-a', type: 'blocks' },
    { kind: 'depend', taskId: 'tt-a', dependsOn: 'tt-b' }, { kind: 'depend', taskId: 'tt-a', dependsOn: 'tt-b', type: 'parent-child' },
    { kind: 'undepend', taskId: 'tt-a', dependsOn: '--all' }, { kind: 'undepend', taskId: 'tt-a', dependsOn: 'tt-b', type: 'blocks' },
    { kind: 'gate', taskId: 'tt-a', reason: '' }, { kind: 'gate', taskId: 'tt-a', reason: 'Approve', type: 'timer' },
    { kind: 'lint', taskIds: ['tt-a'], fix: true }, { kind: 'lint', taskIds: [] }, { kind: 'lint', taskIds: ['tt-a', 'tt-a'] },
    { kind: 'lint', taskIds: ['--all'] }, { kind: 'lint', taskId: 'tt-a' }]) denied(() => hostedTaskAction(operation));
});

test('a new task\'s links are named once each, never its parent, and only in the task client\'s link words', () => {
  const create = links => ({ kind: 'create', title: 'Linked', parent: 'tt-p', links });
  assert.equal(hostedTaskAction(create([{ type: 'related', taskId: 'tt-a' }])), 'tasks.write');
  for (const links of [[], [{ type: 'related', taskId: 'tt-a' }, { type: 'blocks', taskId: 'tt-a' }], [{ type: 'related', taskId: 'tt-p' }],
    [{ type: 'parent-child', taskId: 'tt-a' }], [{ type: 'related', taskId: '--all' }], [{ type: 'related', taskId: 'tt-a', note: 'x' }],
    Array.from({ length: HOSTED_TASK_LIMITS.links + 1 }, (_, n) => ({ type: 'related', taskId: `tt-${n}` }))]) denied(() => hostedTaskAction(create(links)));
  denied(() => hostedTaskAction({ kind: 'create', title: 'A gate', type: 'gate' }));
});

test('closing, unmarking or unhooking a human decision names the tasks an executor must check first', () => {
  assert.deepEqual(decisionGuardTargets({ kind: 'close', taskId: 'tt-a', reason: 'Done' }), ['tt-a']);
  assert.deepEqual(decisionGuardTargets({ kind: 'update', taskId: 'tt-a', status: 'closed' }), ['tt-a']);
  assert.deepEqual(decisionGuardTargets({ kind: 'update', taskId: 'tt-a', removeLabels: ['human'] }), ['tt-a']);
  assert.deepEqual(decisionGuardTargets({ kind: 'undepend', taskId: 'tt-a', dependsOn: 'tt-g' }), ['tt-a', 'tt-g']);
  for (const operation of [{ kind: 'update', taskId: 'tt-a', title: 'New' }, { kind: 'depend', taskId: 'tt-a', dependsOn: 'tt-g', type: 'blocks' },
    { kind: 'gate', taskId: 'tt-a', reason: 'Approve' }, { kind: 'show', taskId: 'tt-a' }]) assert.deepEqual(decisionGuardTargets(operation), []);
  assert.equal(isHumanDecision({ issue_type: 'gate' }), true);
  assert.equal(isHumanDecision({ issue_type: 'task', labels: ['human'] }), true);
  assert.equal(isHumanDecision({ issue_type: 'task', labels: ['humane'] }), false);
});

test('option-shaped titles are attached values and comments remain literal data', () => {
  const plan = createHostedTaskPlanner(entries);
  const attack = '--mem-profile=/owned/other --database=foreign';
  assert.deepEqual(plan(A, request({ kind: 'create', title: attack, description: '--file=/owned/input' })).argv,
    ['--sandbox', '--json', 'create', '--description=--file=/owned/input', '--title=' + attack, '--']);
  assert.deepEqual(plan(A, request({ kind: 'comment', taskId: 'tt-a', text: attack })).argv,
    ['--sandbox', '--json', 'comments', 'add', '--', 'tt-a', attack]);
  const reason = '$(touch /owned/output);\n--global';
  assert.deepEqual(plan(A, request({ kind: 'close', taskId: 'tt-a', reason })).argv,
    ['--sandbox', '--json', 'close', '--reason=' + reason, '--', 'tt-a']);
  assert.ok(plan(A, request({ kind: 'update', taskId: 'tt-a', title: attack })).argv.includes('--title=' + attack));
});

test('unknown request keys cannot override the workspace or select physical capabilities', () => {
  const plan = createHostedTaskPlanner(entries);
  for (const key of ['workspaceId', 'host', 'port', 'database', 'credentials', 'capability', 'cwd', 'path', 'executable', 'env', 'argv', 'args', 'actor', 'role', 'demo']) {
    denied(() => plan(A, { ...request({ kind: 'show', taskId: 'tt-a' }), [key]: B }));
  }
  for (const projectId of ['', ' ', '../shared', '/owned/shared', '--directory=shared', 'x'.repeat(129)]) {
    denied(() => plan(A, { projectId, operation: { kind: 'show', taskId: 'tt-a' } }));
  }
});

test('raw SQL/file/config/branch/maintenance operations and flags have no plan', () => {
  const plan = createHostedTaskPlanner(entries);
  for (const kind of ['sql', 'LOAD_FILE', 'config', 'checkout', 'branch', 'dolt', 'init', 'migrate', 'backup', 'restore', 'remote', 'push', 'export', 'import', 'delete']) {
    denied(() => plan(A, request({ kind })));
  }
  for (const key of ['file', 'stdin', 'profile', 'memProfile', 'cpuProfile', 'config', 'database', 'branch', 'revision', 'sql', 'force', 'args', 'flags']) {
    denied(() => plan(A, request({ kind: 'show', taskId: 'tt-a', [key]: '/owned/other' })));
  }
  for (const taskId of ['--global', '--file=/owned/input', '/owned/task', '../tt-a', 'tt-a;--global', 'tt-a\n--global', 'tt-a\0', 'a'.repeat(129)]) {
    for (const kind of ['show', 'history', 'update', 'comment', 'close']) {
      denied(() => plan(A, request({ kind, taskId, ...(kind === 'history' ? { limit: 1 } : {}),
        ...(kind === 'update' ? { status: 'open' } : {}), ...(kind === 'comment' ? { text: 'Note' } : {}),
        ...(kind === 'close' ? { reason: 'Checked' } : {}) })));
    }
  }
});

test('request/operation objects reject non-data shapes without invoking getters', () => {
  const plan = createHostedTaskPlanner(entries);
  for (const value of [null, undefined, [], 'body', true, new Date(), Object.create({ projectId: 'shared' })]) denied(() => plan(A, value));
  for (const operation of [null, undefined, [], 'show', { kind: 'show' }, { kind: 'show', taskId: 'tt-a', [Symbol()]: 'hidden' }]) denied(() => plan(A, request(operation)));
  let reads = 0;
  denied(() => plan(A, { projectId: 'shared', get operation() { reads++; return { kind: 'show', taskId: 'tt-a' }; } }));
  denied(() => plan(A, request({ get kind() { reads++; return 'show'; }, taskId: 'tt-a' })));
  assert.equal(reads, 0);
});

test('directory ownership is exact, unambiguous, copied and opaque', () => {
  const source = [{ workspaceId: A, projectId: 'shared', capability: ca }];
  const plan = createHostedTaskPlanner(source);
  source[0].workspaceId = B; source[0].capability = cb; source.length = 0;
  assert.equal(plan(A, request({ kind: 'show', taskId: 'tt-a' })).capability, ca);
  denied(() => plan(B, request({ kind: 'show', taskId: 'tt-a' })));
  for (const value of [null, {}, [null], new Array(1), new Array(HOSTED_TASK_LIMITS.projects + 1)]) denied(() => createHostedTaskPlanner(value));
  for (const entry of [
    { ...entries[0], workspaceId: A.toUpperCase().replace('1111', 'ABCD') },
    { ...entries[0], capability: 'credentials-or-path' },
    { ...entries[0], path: '/owned/project' },
    { ...entries[0], database: 'physical_db' },
  ]) denied(() => createHostedTaskPlanner([entry]));
  denied(() => createHostedTaskPlanner([entries[0], { ...entries[0], capability: Symbol() }]));
  denied(() => createHostedTaskPlanner([entries[0], { ...entries[1], capability: ca }]));
  const result = plan(A, request({ kind: 'show', taskId: 'tt-a' }));
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.argv));
  assert.throws(() => result.argv.push('--file=/owned/other'), TypeError);
  assert.throws(() => { result.capability = cb; }, TypeError);
  assert.ok(!JSON.stringify(result).includes('capability'));
});

test('text and query bounds accept edges and reject invalid enums/counts/empty updates', () => {
  const plan = createHostedTaskPlanner(entries);
  for (const limit of [1, HOSTED_TASK_LIMITS.rows]) assert.ok(plan(A, request({ kind: 'list', limit })).argv.includes('--limit=' + limit));
  for (const limit of [0, -1, HOSTED_TASK_LIMITS.rows + 1, 1.5, NaN, Infinity, '5', null]) {
    denied(() => plan(A, request({ kind: 'list', limit })));
    denied(() => plan(A, request({ kind: 'history', taskId: 'tt-a', limit })));
  }
  for (const status of ['unknown', 'OPEN', '', 1, null, undefined]) denied(() => plan(A, request({ kind: 'list', limit: 1, status })));
  for (const type of ['gate', 'unknown', '', null, undefined]) denied(() => plan(A, request({ kind: 'create', title: 'Task', type })));
  for (const priority of [-1, 5, 1.5, '2', null]) denied(() => plan(A, request({ kind: 'create', title: 'Task', priority })));
  denied(() => plan(A, request({ kind: 'update', taskId: 'tt-a' })));
  const fields = [
    ['create', 'title', HOSTED_TASK_LIMITS.title, {}],
    ['create', 'description', HOSTED_TASK_LIMITS.body, { title: 'Task' }],
    ['comment', 'text', HOSTED_TASK_LIMITS.comment, { taskId: 'tt-a' }],
    ['close', 'reason', HOSTED_TASK_LIMITS.reason, { taskId: 'tt-a' }],
  ];
  for (const [kind, field, max, rest] of fields) {
    assert.ok(plan(A, request({ kind, ...rest, [field]: 'x'.repeat(max) })).argv.some(arg => arg.includes('x'.repeat(max))));
    for (const value of ['x'.repeat(max + 1), '\0unsafe', {}, null, undefined]) denied(() => plan(A, request({ kind, ...rest, [field]: value })));
    if (field !== 'description') for (const value of ['', ' \n\t']) denied(() => plan(A, request({ kind, ...rest, [field]: value })));
  }
  assert.ok(plan(A, request({ kind: 'create', title: 'Task', description: '' })).argv.includes('--description='));
});

test('ordinary fields retain literal labels/handoff metadata and explicit clear/claim commands', () => {
  const plan = createHostedTaskPlanner(entries);
  const metadata = { noticeos_source: 'noticeos-handoff', noticeos_asset: 'example', noticeos_kind: 'finding',
    noticeos_rule: '--file=literal', noticeos_key: 'byte-exact join' };
  const created = plan(A, request({ kind: 'create', title: 'Linked task', parent: 'tt-abc',
    labels: ['noticeos-handoff', 'asset:example', '--sql=literal'], acceptance: '--file=literal', metadata }));
  assert.ok(created.argv.includes('--parent=tt-abc'));
  // A child carries only the labels it names, never its parent's human label.
  assert.equal(created.argv[created.argv.indexOf('--parent=tt-abc') + 1], '--no-inherit-labels');
  assert.equal(plan(A, request({ kind: 'create', title: 'Top level' })).argv.includes('--no-inherit-labels'), false);
  assert.ok(created.argv.includes('--labels=noticeos-handoff,asset:example,--sql=literal'));
  assert.deepEqual(JSON.parse(created.argv.find(arg => arg.startsWith('--metadata=')).slice(11)), metadata);
  const update = plan(A, request({ kind: 'update', taskId: 'tt-a', assignee: '--file=literal', parent: '',
    defer: '', acceptance: '', addLabels: ['--sql=literal'], removeLabels: ['old-label'] }));
  for (const arg of ['--assignee=--file=literal', '--parent=', '--defer=', '--acceptance=', '--add-label=--sql=literal', '--remove-label=old-label']) assert.ok(update.argv.includes(arg));
  assert.ok(plan(A, request({ kind: 'update', taskId: 'tt-a', claim: true })).argv.includes('--claim'));
  assert.ok(plan(A, request({ kind: 'update', taskId: 'tt-a', defer: '2028-02-29' })).argv.includes('--defer=2028-02-29'));
});
test('advanced field grammar rejects malformed dates, raw metadata and accessor/list ambiguities', () => {
  const plan = createHostedTaskPlanner(entries);
  for (const operation of [
    { kind: 'update', taskId: 'tt-a', claim: false }, { kind: 'update', taskId: 'tt-a', claim: true, status: 'open' },
    { kind: 'update', taskId: 'tt-a', claim: true, assignee: 'someone' },
    ...['2026-02-30', 'tomorrow', '--file=/owned', '2026-01-01T00:00:00Z'].map(defer => ({ kind: 'update', taskId: 'tt-a', defer })),
    ...[[], ['a,b'], [' leading'], ['same', 'same'], new Array(1), Array(33).fill('a')].map(addLabels => ({ kind: 'update', taskId: 'tt-a', addLabels })),
    { kind: 'create', title: 'Task', metadata: { database: 'foreign' } },
    { kind: 'create', title: 'Task', metadata: { noticeos_key: {} } },
    { kind: 'create', title: 'Task', metadata: { noticeos_key: 'x'.repeat(2049) } },
    { kind: 'update', taskId: 'tt-a', parent: '--file=/owned' },
  ]) denied(() => plan(A, request(operation)));
  let reads = 0; const labels = []; Object.defineProperty(labels, '0', { get() { reads++; return 'bad'; } });
  denied(() => plan(A, request({ kind: 'create', title: 'Task', labels })));
  denied(() => plan(A, request({ kind: 'create', title: 'Task', metadata: { get noticeos_key() { reads++; return 'bad'; } } })));
  assert.equal(reads, 0);
});


test('server snapshot batch is a read-only fixed shape without physical or CLI selectors', () => {
  const operation = { kind: 'snapshot', closedSince: '2026-09-24' };
  const plan = createHostedTaskPlanner(entries)(A, request(operation));
  assert.equal(plan.readOnly, true); assert.equal(hostedTaskAction(operation), 'tasks.read');
  assert.deepEqual(plan.argv, ['--sandbox', '--json', '--readonly']);
  for (const patch of [{ argv: ['list'] }, { closedSince: '2026-02-30' }, { closedSince: '--file=input' }, { cwd: '/foreign' }, { actor: 'owner' }]) {
    denied(() => createHostedTaskPlanner(entries)(A, request({ ...operation, ...patch })));
  }
});

test('a create carries the server operation identity as metadata; a caller cannot name it', () => {
  const plan = createHostedTaskPlanner(entries);
  const operationId = '77777777-1111-4111-8111-111111111111';
  const created = plan(A, { projectId: 'shared', operation: { kind: 'create', title: 'Task', operationId,
    metadata: { noticeos_source: 'noticeos-handoff' } } });
  assert.ok(created.argv.includes(`--metadata=${JSON.stringify({ noticeos_source: 'noticeos-handoff', noticeos_operation_id: operationId })}`));
  assert.throws(() => plan(A, { projectId: 'shared', operation: { kind: 'create', title: 'Task', metadata: { noticeos_operation_id: operationId } } }));
  assert.throws(() => plan(A, { projectId: 'shared', operation: { kind: 'create', title: 'Task', operationId: 'not-a-uuid' } }));
  assert.throws(() => plan(A, { projectId: 'shared', operation: { kind: 'update', taskId: 'tt-a', title: 'x', operationId } }));
});

test('a claim keeps its model in the same write; only the server records who closed a task', () => {
  const plan = createHostedTaskPlanner(entries);
  const claim = plan(A, request({ kind: 'update', taskId: 'tt-a', claim: true, model: 'Opus 5.5' }));
  assert.deepEqual(claim.argv.slice(2), ['update', '--claim', `--metadata=${JSON.stringify({ noticeos_claimed_model: 'Opus 5.5' })}`, '--', 'tt-a']);
  // The close names its model for the attribution that follows it; the close itself is unchanged.
  assert.deepEqual(plan(A, request({ kind: 'close', taskId: 'tt-a', reason: 'Done', model: 'Opus 5.5' })).argv,
    plan(A, request({ kind: 'close', taskId: 'tt-a', reason: 'Done' })).argv);
  const attributed = plan(A, request({ kind: 'attribute', taskId: 'tt-a', closedBy: 'claude', closedAt: '2026-10-15T16:00:00Z', model: 'Opus 5.5' }));
  assert.equal(attributed.readOnly, false);
  assert.deepEqual(attributed.argv.slice(2), ['update', `--metadata=${JSON.stringify({ noticeos_closed_by: 'claude',
    noticeos_closed_at: '2026-10-15T16:00:00Z', noticeos_closed_model: 'Opus 5.5' })}`, '--', 'tt-a']);
  for (const operation of [
    { kind: 'update', taskId: 'tt-a', title: 'x', model: 'Opus 5.5' },
    { kind: 'update', taskId: 'tt-a', claim: true, model: 'two\nlines' },
    { kind: 'update', taskId: 'tt-a', claim: true, model: ' padded' },
    { kind: 'update', taskId: 'tt-a', claim: true, model: 'x'.repeat(HOSTED_TASK_LIMITS.identifier + 1) },
    { kind: 'close', taskId: 'tt-a', reason: 'Done', model: '' },
    { kind: 'attribute', taskId: 'tt-a', closedBy: 'claude', closedAt: 'yesterday' },
    { kind: 'attribute', taskId: 'tt-a', closedAt: '2026-10-15T16:00:00Z' },
    ...['noticeos_closed_by', 'noticeos_closed_model', 'noticeos_closed_at', 'noticeos_claimed_model']
      .map(name => ({ kind: 'create', title: 'Task', metadata: { [name]: 'forged' } })),
  ]) denied(() => plan(A, request(operation)));
});

test('a forced close passes --force before the task, and only for force: true', () => {
  const plan = createHostedTaskPlanner(entries);
  assert.deepEqual(plan(A, request({ kind: 'close', taskId: 'tt-a', reason: 'Done', force: true })).argv.slice(2),
    ['close', '--reason=Done', '--force', '--', 'tt-a']);
  for (const force of [false, 'true', 1, null]) denied(() => plan(A, request({ kind: 'close', taskId: 'tt-a', reason: 'Done', force })));
});

test('a closed read may span the Agents page history, and no further', () => {
  const plan = createHostedTaskPlanner(entries);
  const until = '2026-10-16T12:00:00.000Z';
  assert.ok(plan(A, request({ kind: 'closed-board', since: '2026-08-21', until })).argv.includes('--closed-after=2026-08-21'));
  denied(() => plan(A, request({ kind: 'closed-board', since: '2026-08-19', until })));
});
