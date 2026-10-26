import assert from 'node:assert/strict';
import test from 'node:test';
import { answerComment, answerSteps, choiceCloseReason, choiceComment, choiceSteps, closerMetadata, createHostedTaskPlanner, decisionGuardTargets, decisionRefusal,
  guardedWrite, guardReadArgs, HOSTED_TASK_LIMITS, hostedTaskAction, isHumanDecision, recordedTaskCard, refusalFromState, shippedTaskCard, TaskStateRefused,
  writeGuardReads } from './hosted-task-command.mjs';

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
  [{ kind: 'find', taskIds: ['tt-a', 'tt-b.1'] }, true, ['list', '--all', '--include-gates', '--limit=0', '--id=tt-a,tt-b.1']],
  [{ kind: 'history', taskId: 'tt-a', limit: 5 }, true, ['history', '--limit=5', '--', 'tt-a']],
  [{ kind: 'history', taskId: 'tt-a', limit: 5, events: true }, true, ['history', '--events', '--limit=5', '--', 'tt-a']],
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
    { kind: 'lint', taskIds: ['--all'] }, { kind: 'lint', taskId: 'tt-a' }, { kind: 'find', taskIds: [] }, { kind: 'find', taskIds: ['tt-a', 'tt-a'] },
    { kind: 'find', taskIds: ['tt-a,tt-b'] }, { kind: 'find', taskIds: ['--all'] }]) denied(() => hostedTaskAction(operation));
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

test('a create names its filer and the filer\'s model in the same write', () => {
  const plan = createHostedTaskPlanner(entries);
  const metadataOf = operation => JSON.parse(plan(A, request(operation)).argv.find(arg => arg.startsWith('--metadata=')).slice(11));
  assert.deepEqual(metadataOf({ kind: 'create', title: 'Task', filedBy: 'claude', model: 'Opus 5.5' }),
    { noticeos_filed_by: 'claude', noticeos_filed_model: 'Opus 5.5' });
  assert.deepEqual(metadataOf({ kind: 'create', title: 'Task', filedBy: 'claude' }), { noticeos_filed_by: 'claude' });
  assert.equal(plan(A, request({ kind: 'create', title: 'Task' })).argv.some(arg => arg.startsWith('--metadata=')), false);
  for (const operation of [
    { kind: 'create', title: 'Task', filedBy: 'claude', model: 'two\nlines' },
    { kind: 'create', title: 'Task', filedBy: 'claude', model: ' padded' },
    { kind: 'create', title: 'Task', filedBy: '' },
  ]) denied(() => plan(A, request(operation)));
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
  // A close that names no resolution is recorded as done, so a reopened task's next close never reads an earlier one's.
  assert.deepEqual(attributed.argv.slice(2), ['update', `--metadata=${JSON.stringify({ noticeos_closed_by: 'claude',
    noticeos_closed_at: '2026-10-15T16:00:00Z', noticeos_closed_model: 'Opus 5.5', noticeos_resolution: 'done' })}`, '--', 'tt-a']);
  for (const operation of [
    { kind: 'update', taskId: 'tt-a', title: 'x', model: 'Opus 5.5' },
    { kind: 'update', taskId: 'tt-a', claim: true, model: 'two\nlines' },
    { kind: 'update', taskId: 'tt-a', claim: true, model: ' padded' },
    { kind: 'update', taskId: 'tt-a', claim: true, model: 'x'.repeat(HOSTED_TASK_LIMITS.identifier + 1) },
    { kind: 'close', taskId: 'tt-a', reason: 'Done', model: '' },
    { kind: 'attribute', taskId: 'tt-a', closedBy: 'claude', closedAt: 'yesterday' },
    { kind: 'attribute', taskId: 'tt-a', closedAt: '2026-10-15T16:00:00Z' },
    ...['noticeos_closed_by', 'noticeos_closed_model', 'noticeos_closed_at', 'noticeos_claimed_model', 'noticeos_filed_by', 'noticeos_filed_model',
      'noticeos_resolution', 'noticeos_duplicate_of']
      .map(name => ({ kind: 'create', title: 'Task', metadata: { [name]: 'forged' } })),
  ]) denied(() => plan(A, request(operation)));
});

test('a close names how it ended for its attribution, and the close itself keeps the caller\'s reason unchanged', () => {
  const plan = createHostedTaskPlanner(entries);
  const plain = plan(A, request({ kind: 'close', taskId: 'tt-a', reason: 'Nothing to do here' })).argv;
  for (const resolution of ['done', 'wont-do', 'cant-reproduce', 'already-handled']) {
    assert.deepEqual(plan(A, request({ kind: 'close', taskId: 'tt-a', reason: 'Nothing to do here', resolution })).argv, plain, resolution);
    const attributed = plan(A, request({ kind: 'attribute', taskId: 'tt-a', closedBy: 'dana', closedAt: '2026-10-17T12:00:00Z', resolution }));
    assert.deepEqual(attributed.argv.slice(2), ['update', `--metadata=${JSON.stringify({ noticeos_closed_by: 'dana',
      noticeos_closed_at: '2026-10-17T12:00:00Z', noticeos_resolution: resolution })}`, '--', 'tt-a'], resolution);
  }
  assert.deepEqual(plan(A, request({ kind: 'close', taskId: 'tt-a', reason: 'Nothing to do here', resolution: 'duplicate', duplicateOf: 'tt-b' })).argv, plain);
  assert.deepEqual(plan(A, request({ kind: 'attribute', taskId: 'tt-a', closedBy: 'dana', closedAt: '2026-10-17T12:00:00Z',
    resolution: 'duplicate', duplicateOf: 'tt-b' })).argv.slice(2), ['update', `--metadata=${JSON.stringify({ noticeos_closed_by: 'dana',
    noticeos_closed_at: '2026-10-17T12:00:00Z', noticeos_resolution: 'duplicate', noticeos_duplicate_of: 'tt-b' })}`, '--', 'tt-a']);
  assert.deepEqual(closerMetadata({ kind: 'attribute', taskId: 'tt-a', closedBy: 'dana', closedAt: '2026-10-17T12:00:00Z', resolution: 'wont-do' }),
    { noticeos_closed_by: 'dana', noticeos_closed_at: '2026-10-17T12:00:00Z', noticeos_resolution: 'wont-do' });
  // A dismissal takes the resolution its record will carry, never done; its own command is unchanged.
  const dismissed = plan(A, request({ kind: 'dismiss', taskId: 'tt-a' })).argv;
  assert.deepEqual(plan(A, request({ kind: 'dismiss', taskId: 'tt-a', resolution: 'already-handled' })).argv, dismissed);
  assert.deepEqual(plan(A, request({ kind: 'dismiss', taskId: 'tt-a', resolution: 'duplicate', duplicateOf: 'tt-b' })).argv, dismissed);
  for (const operation of [
    { kind: 'dismiss', taskId: 'tt-a', resolution: 'done' },
    { kind: 'dismiss', taskId: 'tt-a', resolution: 'duplicate' },
    { kind: 'dismiss', taskId: 'tt-a', duplicateOf: 'tt-b' },
    { kind: 'resolve-gate', taskId: 'tt-a', resolution: 'wont-do' },
    { kind: 'close', taskId: 'tt-a', reason: 'Done', resolution: 'fixed' },
    { kind: 'close', taskId: 'tt-a', reason: 'Done', resolution: 'duplicate' },
    { kind: 'close', taskId: 'tt-a', reason: 'Done', resolution: 'wont-do', duplicateOf: 'tt-b' },
    { kind: 'close', taskId: 'tt-a', reason: 'Done', duplicateOf: 'tt-b' },
    { kind: 'close', taskId: 'tt-a', reason: 'Done', resolution: 'duplicate', duplicateOf: 'tt-a' },
    { kind: 'close', taskId: 'tt-a', reason: 'Done', resolution: 'duplicate', duplicateOf: '--force' },
    { kind: 'attribute', taskId: 'tt-a', closedBy: 'dana', closedAt: '2026-10-17T12:00:00Z', resolution: 'Done' },
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

// A dependency holds a task out of ready work; closing it checks only the
// task's own state. The executor reads the task (with its children) first.
const closing = { kind: 'close', taskId: 'tt-a', reason: 'Done in abc123' };
const edge = (id, extra = {}) => ({ id, status: 'open', issue_type: 'task', dependency_type: 'blocks', ...extra });
const shown = (extra = {}) => ({ id: 'tt-a', status: 'in_progress', assignee: 'agent-1', dependencies: [], ...extra });
const refusedBy = (row, reason) => assert.throws(() => guardedWrite(closing, row, 'agent-1'),
  error => error instanceof TaskStateRefused && error.taskId === 'tt-a' && error.attempted === 'close'
    && assert.deepEqual(error.reason, reason) === undefined);

test('a close reads its own task with its children, and only an unforced close is guarded by that read', () => {
  assert.deepEqual(writeGuardReads(closing), ['tt-a']);
  assert.deepEqual(guardReadArgs(closing, 'tt-a'), ['--sandbox', '--readonly', '--json', 'show', '--include-dependents', '--', 'tt-a']);
  const undepend = { kind: 'undepend', taskId: 'tt-a', dependsOn: 'tt-g' };
  assert.deepEqual(writeGuardReads(undepend), ['tt-a', 'tt-g']);
  assert.deepEqual(guardReadArgs(undepend, 'tt-a'), ['--sandbox', '--readonly', '--json', 'show', '--', 'tt-a']);
  assert.deepEqual(writeGuardReads({ kind: 'comment', taskId: 'tt-a', text: 'Note' }), []);
  const serviceClose = { ...closing, force: true };
  assert.equal(guardedWrite(serviceClose, undefined, 'service'), serviceClose, 'a service\'s forced close decides for itself');
  const titled = { kind: 'update', taskId: 'tt-a', title: 'New' };
  assert.equal(guardedWrite(titled, undefined, 'agent-1'), titled);
});

test('a close whose only obstacle is an open blocker runs forced past it, even when the blocker is a person\'s task', () => {
  assert.equal(guardedWrite(closing, shown(), 'agent-1'), closing, 'nothing open: the plain close');
  assert.equal(guardedWrite(closing, shown({ assignee: '' }), 'agent-1'), closing, 'an unclaimed task closes too');
  assert.equal(guardedWrite(closing, shown({ dependencies: [edge('tt-b', { status: 'closed' }), edge('tt-c', { dependency_type: 'related' }),
    edge('tt-p', { dependency_type: 'parent-child' })] }), 'agent-1'), closing, 'closed blockers, links and the parent are no obstacle');
  for (const blocker of [edge('tt-b'), edge('tt-b', { labels: ['human'], issue_type: 'decision' }), edge('tt-b', { dependency_type: 'waits-for' })]) {
    assert.deepEqual(guardedWrite(closing, shown({ dependencies: [blocker] }), 'agent-1'), { ...closing, force: true }, JSON.stringify(blocker));
  }
  assert.deepEqual(guardedWrite(closing, shown({ assignee: 'agent.1', dependencies: [edge('tt-b')] }), 'agent_1'), { ...closing, force: true },
    'the holder is matched as the task client matches actors');
  for (const kept of [{ pinned: true }, { status: 'pinned' }, { is_template: true }]) {
    assert.equal(guardedWrite(closing, shown({ ...kept, dependencies: [edge('tt-b')] }), 'agent-1'), closing, 'force would skip the client\'s own refusal');
  }
  assert.throws(() => guardedWrite(closing, { ...shown(), id: 'tt-z' }, 'agent-1'), { message: 'Invalid hosted task plan input.' });
});

test('a close is refused by its own state: closed, held by another, waiting on a gate, or holding open children', () => {
  refusedBy(shown({ status: 'closed' }), { kind: 'closed' });
  refusedBy(shown({ assignee: 'alice' }), { kind: 'held', holder: 'alice' });
  refusedBy(shown({ dependencies: [edge('tt-b'), edge('tt-g', { issue_type: 'gate', await_type: 'human' })] }),
    { kind: 'gate', gates: ['tt-g'], human: true });
  refusedBy(shown({ dependencies: [edge('tt-t', { issue_type: 'gate', await_type: 'timer' })] }), { kind: 'gate', gates: ['tt-t'], human: false });
  refusedBy(shown({ dependents: [edge('tt-a.1', { dependency_type: 'parent-child' }), edge('tt-a.2', { dependency_type: 'parent-child', status: 'closed' }),
    edge('tt-x')] }), { kind: 'children', children: ['tt-a.1'] });
});

test('a claim or a change of assignee is refused for the causes the task client refuses it for, and never forced', () => {
  const claiming = { kind: 'update', taskId: 'tt-a', claim: true };
  const giving = { kind: 'update', taskId: 'tt-a', assignee: 'bob' };
  const refused = (operation, row, attempted, reason) => assert.throws(() => guardedWrite(operation, row, 'agent-1'),
    error => error instanceof TaskStateRefused && error.attempted === attempted && assert.deepEqual(error.reason, reason) === undefined);
  assert.deepEqual([writeGuardReads(claiming), writeGuardReads(giving)], [['tt-a'], ['tt-a']]);
  assert.deepEqual(guardReadArgs(claiming, 'tt-a'), ['--sandbox', '--readonly', '--json', 'show', '--', 'tt-a']);
  for (const row of [shown({ status: 'open', assignee: '' }), shown({ status: 'open', assignee: '', dependencies: [edge('tt-b')] }),
    shown({ status: 'in_progress', assignee: 'agent-1' })]) assert.equal(guardedWrite(claiming, row, 'agent-1'), claiming, JSON.stringify(row));
  refused(claiming, shown({ status: 'closed' }), 'claim', { kind: 'closed' });
  refused(claiming, shown({ assignee: 'alice' }), 'claim', { kind: 'held', holder: 'alice' });
  refused(claiming, shown({ status: 'blocked', assignee: '', dependencies: [edge('tt-b'), edge('tt-c', { status: 'closed' })] }), 'claim',
    { kind: 'not-open', status: 'blocked', blockers: ['tt-b'] });
  refused(claiming, shown({ status: 'deferred', assignee: '' }), 'claim', { kind: 'not-open', status: 'deferred', blockers: [] });
  refused(claiming, shown({ status: 'in_progress', assignee: '' }), 'claim', { kind: 'not-open', status: 'in_progress', blockers: [] });
  refused(giving, shown({ assignee: 'alice' }), 'reassign', { kind: 'held', holder: 'alice' });
  for (const row of [shown({ assignee: 'agent-1' }), shown({ status: 'open', assignee: 'alice' }), shown({ assignee: 'bob' })]) {
    assert.equal(guardedWrite(giving, row, 'agent-1'), giving, 'its holder, an unstarted task, or the same assignee again');
  }
});

test('after the store refuses a write, the task as it stands names the cause, or nothing when it explains nothing', () => {
  const depend = type => ({ kind: 'depend', taskId: 'tt-a', dependsOn: 'tt-b', type });
  const linked = shown({ dependencies: [edge('tt-b')] });
  assert.deepEqual(refusalFromState(depend('related'), linked, 'agent-1')?.reason,
    { kind: 'linked', dependsOn: 'tt-b', type: 'blocks', wanted: 'related' }, 'an edge the write would retype');
  assert.equal(refusalFromState(depend('blocks'), linked, 'agent-1'), null, 'the same edge again explains nothing');
  assert.equal(refusalFromState(depend('blocks'), shown(), 'agent-1'), null);
  const claim = { kind: 'update', taskId: 'tt-a', claim: true };
  assert.deepEqual(refusalFromState(claim, shown({ assignee: 'rival' }), 'agent-1')?.reason, { kind: 'held', holder: 'rival' }, 'a claim lost to another caller');
  assert.equal(refusalFromState(claim, shown(), 'agent-1'), null, 'its own claim landed: nothing to name');
  assert.equal(refusalFromState(closing, shown({ status: 'closed', close_reason: closing.reason }), 'agent-1'), null,
    'closed with this reason: the refused close may itself have landed');
  assert.deepEqual(refusalFromState(closing, shown({ status: 'closed', close_reason: 'Earlier' }), 'agent-1')?.reason, { kind: 'closed' });
  assert.equal(refusalFromState({ kind: 'comment', taskId: 'tt-a', text: 'Note' }, shown(), 'agent-1'), null);
});

const CHOICES = { question: 'Which page keeps the traffic?', options: [{ key: 'a', label: 'Keep the old page' },
  { key: 'b', label: 'Redirect to the new page', detail: 'The old page answers 301.', recommended: true }, { key: 'c', label: 'Keep both' }] };

test('a task\'s choices travel as metadata in the create itself, and an update replaces or takes them off whole', () => {
  const plan = createHostedTaskPlanner(entries);
  const metadataOf = operation => JSON.parse(plan(A, request(operation)).argv.find(arg => arg.startsWith('--metadata=')).slice(11));
  assert.deepEqual(metadataOf({ kind: 'create', title: 'Pick the page', labels: ['human'], choices: CHOICES, filedBy: 'claude' }),
    { noticeos_filed_by: 'claude', noticeos_choices: CHOICES });
  assert.deepEqual(plan(A, request({ kind: 'update', taskId: 'tt-a', choices: CHOICES })).argv.slice(2),
    ['update', `--metadata=${JSON.stringify({ noticeos_choices: CHOICES })}`, '--', 'tt-a']);
  assert.deepEqual(plan(A, request({ kind: 'update', taskId: 'tt-a', title: 'Pick', choices: null })).argv.slice(2),
    ['update', '--title=Pick', '--unset-metadata=noticeos_choices', '--', 'tt-a']);
  // A recommended: false is the same as leaving it out.
  assert.deepEqual(metadataOf({ kind: 'update', taskId: 'tt-a', choices: { ...CHOICES,
    options: CHOICES.options.map(option => option.recommended ? option : { ...option, recommended: false }) } }), { noticeos_choices: CHOICES });
  const getter = { question: 'Q?', options: [] };
  Object.defineProperty(getter.options, 0, { get: () => ({ key: 'a', label: 'A', recommended: true }), enumerable: true });
  for (const operation of [
    { kind: 'create', title: 'Pick', choices: null },
    { kind: 'create', title: 'Pick', choices: { ...CHOICES, options: CHOICES.options.slice(0, 1) } },
    { kind: 'create', title: 'Pick', choices: { ...CHOICES, options: [CHOICES.options[1], CHOICES.options[0], CHOICES.options[2]] } },
    { kind: 'create', title: 'Pick', choices: { ...CHOICES, options: CHOICES.options.map(option => ({ ...option, recommended: true })) } },
    { kind: 'create', title: 'Pick', choices: getter },
    { kind: 'create', title: 'Pick', metadata: { noticeos_choices: 'a,b' } },
    { kind: 'create', title: 'Pick', metadata: { noticeos_choice: 'b' } },
    { kind: 'update', taskId: 'tt-a', claim: true, choices: CHOICES },
    { kind: 'update', taskId: 'tt-a', choices: 'a,b' },
  ]) denied(() => plan(A, request(operation)));
});

const CARD = { valuePerMonth: 400, likelihood: 0.4, reviewMinutes: 20, buildMinutes: 90, daysToSignal: 28, measurability: 'cohort',
  revenueFamily: 'ads', kill: { state: 'RPM below 12 on the changed pages', date: '2026-12-31' }, note: 'Faster pages earn more ad views.' };

test('a task\'s card and change class travel as metadata in the create itself, and its kill date as the due date', () => {
  const plan = createHostedTaskPlanner(entries);
  const argv = plan(A, request({ kind: 'create', title: 'Speed up the recipe pages', card: CARD, changeClass: 'template', filedBy: 'claude' })).argv;
  assert.deepEqual(JSON.parse(argv.find(arg => arg.startsWith('--metadata=')).slice(11)),
    { noticeos_filed_by: 'claude', noticeos_card: CARD, noticeos_change_class: 'template' });
  assert.equal(argv.filter(arg => arg.startsWith('--due=')).join(), '--due=2026-12-31');
  // A card without a kill criterion sets no due date; a class alone is metadata too.
  const { kill: _kill, ...open } = CARD;
  assert.equal(plan(A, request({ kind: 'create', title: 'Open-ended', card: open })).argv.some(arg => arg.startsWith('--due')), false);
  assert.deepEqual(plan(A, request({ kind: 'create', title: 'Copy', changeClass: 'copy' })).argv.slice(2),
    ['create', '--metadata={"noticeos_change_class":"copy"}', '--title=Copy', '--']);
  // Absent fields are left out of what is stored.
  const { buildMinutes: _build, revenueFamily: _family, note: _note, ...least } = open;
  assert.deepEqual(JSON.parse(plan(A, request({ kind: 'create', title: 'Least', card: { ...least, durability: undefined } })).argv
    .find(arg => arg.startsWith('--metadata=')).slice(11)), { noticeos_card: least });
});

test('an update sets a card and class in one merged write or takes them off by key, and never both at once', () => {
  const plan = createHostedTaskPlanner(entries);
  const argv = operation => plan(A, request({ kind: 'update', taskId: 'tt-a', ...operation })).argv.slice(2);
  const set = argv({ card: CARD, changeClass: 'feature' });
  assert.deepEqual([set[0], JSON.parse(set[1].slice('--metadata='.length)), ...set.slice(2)],
    ['update', { noticeos_card: CARD, noticeos_change_class: 'feature' }, '--due=2026-12-31', '--', 'tt-a']);
  assert.deepEqual(argv({ title: 'Faster', card: null }), ['update', '--title=Faster', '--unset-metadata=noticeos_card', '--', 'tt-a'],
    'taking a card off leaves the due date');
  assert.deepEqual(argv({ choices: null, card: null, changeClass: null }),
    ['update', '--unset-metadata=noticeos_choices', '--unset-metadata=noticeos_card', '--unset-metadata=noticeos_change_class', '--', 'tt-a']);
  assert.deepEqual(argv({ choices: CHOICES, changeClass: 'copy' }),
    ['update', `--metadata=${JSON.stringify({ noticeos_choices: CHOICES, noticeos_change_class: 'copy' })}`, '--', 'tt-a']);
  const getter = { ...CARD };
  Object.defineProperty(getter, 'likelihood', { get: () => 0.5, enumerable: true });
  for (const operation of [
    { kind: 'update', taskId: 'tt-a', card: CARD, changeClass: null },
    { kind: 'update', taskId: 'tt-a', choices: null, card: CARD },
    { kind: 'update', taskId: 'tt-a', claim: true, card: CARD },
    { kind: 'update', taskId: 'tt-a', claim: true, changeClass: null },
    { kind: 'update', taskId: 'tt-a', card: { ...CARD, likelihood: 1.5 } },
    { kind: 'update', taskId: 'tt-a', card: { ...CARD, kill: { state: 'Gone', date: '2026-02-30' } } },
    { kind: 'update', taskId: 'tt-a', card: { ...CARD, score: 9 } },
    { kind: 'update', taskId: 'tt-a', card: getter },
    { kind: 'update', taskId: 'tt-a', card: 'high' },
    { kind: 'update', taskId: 'tt-a', changeClass: 'refactor' },
    { kind: 'create', title: 'Worth it', card: null },
    { kind: 'create', title: 'Worth it', changeClass: null },
    // A card or class arrives in its own field, checked, never as caller metadata.
    { kind: 'create', title: 'Worth it', metadata: { noticeos_change_class: 'copy' } },
    { kind: 'create', title: 'Worth it', metadata: { noticeos_card: '{}' } },
  ]) denied(() => plan(A, request(operation)));
});

test('a stored card names who wrote it and when, whatever the caller sent for those two', () => {
  const stored = recordedTaskCard({ ...CARD, by: 'someone else', at: '2020-01-01T00:00:00.000Z' }, 'agent-1', '2026-10-21T09:00:00.000Z');
  assert.deepEqual(stored, { ...CARD, by: 'agent-1', at: '2026-10-21T09:00:00.000Z' });
  assert.ok(Object.isFrozen(stored) && Object.isFrozen(stored.kill));
  assert.equal(recordedTaskCard(CARD, 'n'.repeat(200), '2026-10-21T09:00:00.000Z').by.length, 120, 'a long name is cut to the card\'s limit');
});

test('a close as done keeps the card as the close left it, with the first commit its reason names, and nothing else does', () => {
  const card = recordedTaskCard(CARD, 'agent-1', '2026-10-15T09:00:00.000Z');
  const closed = (reason, extra = {}) => ({ id: 'tt-a', status: 'closed', closed_at: '2026-10-21T09:30:00Z', close_reason: reason,
    metadata: { noticeos_card: card, noticeos_change_class: 'template' }, ...extra });
  assert.deepEqual(shippedTaskCard(closed('Shipped in a1b2c3d: shorter titles'), undefined),
    { card, closedAt: '2026-10-21T09:30:00Z', commit: 'a1b2c3d' });
  assert.deepEqual(shippedTaskCard(closed('Shipped'), 'done'), { card, closedAt: '2026-10-21T09:30:00Z' }, 'a reason without a commit keeps none');
  for (const [reason, commit] of [
    ['abc1234: done', 'abc1234'],
    ['Merged https://example.com/o/r/commit/0123abcd4567ef89, then 89abcdef0123', '0123abcd4567ef89'],
    ['a1b2c3d4e5f60718293a4b5c6d7e8f9012345678.', 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'],
    ['Cut 1234567 bytes', undefined],
    ['Replaced the defaced banner', undefined],
    ['Same work as tt-a1b2c3d', undefined],
    ['ABC1234 upper case', undefined],
    ['abc12345x is no hash', undefined],
  ]) assert.equal(shippedTaskCard(closed(reason), 'done')?.commit, commit, reason);
  // Nothing ships from another resolution, a task without a card, or one not closed.
  for (const resolution of ['wont-do', 'duplicate', 'cant-reproduce', 'already-handled']) {
    assert.equal(shippedTaskCard(closed('abc1234: done'), resolution), undefined, resolution);
  }
  assert.equal(shippedTaskCard(closed('abc1234: done', { metadata: { noticeos_card: { ...card, likelihood: 2 } } }), 'done'), undefined);
  assert.equal(shippedTaskCard(closed('abc1234: done', { closed_at: undefined }), 'done'), undefined);
  // The first ship stands: a task that carries a shipped card keeps it.
  const first = { card: { ...card, valuePerMonth: 90 }, closedAt: '2026-10-01T09:00:00Z', commit: 'fedcba9' };
  assert.equal(shippedTaskCard(closed('e5f6a7b: again', { metadata: { noticeos_card: card, noticeos_card_shipped: first } }), 'done'), undefined);

  // The attribution writes it beside the closer, only for a close as done and only from this close.
  const plan = createHostedTaskPlanner(entries);
  const shipped = shippedTaskCard(closed('Shipped in a1b2c3d'), undefined);
  const attribution = { kind: 'attribute', taskId: 'tt-a', closedBy: 'agent-1', closedAt: '2026-10-21T09:30:00Z', shipped };
  assert.deepEqual(plan(A, request(attribution)).argv.slice(2), ['update', `--metadata=${JSON.stringify({ noticeos_closed_by: 'agent-1',
    noticeos_closed_at: '2026-10-21T09:30:00Z', noticeos_resolution: 'done', noticeos_card_shipped: shipped })}`, '--', 'tt-a']);
  assert.deepEqual(closerMetadata({ ...attribution, resolution: 'done' }).noticeos_card_shipped, shipped);
  for (const operation of [
    { ...attribution, resolution: 'wont-do' },
    { ...attribution, closedAt: '2026-10-21T09:31:00Z' },
    { ...attribution, shipped: { ...shipped, card: { ...card, likelihood: 2 } } },
    { ...attribution, shipped: { ...shipped, commit: 'not a hash' } },
    { ...attribution, shipped: card },
    // Only the server writes it: no caller's metadata carries it.
    { kind: 'create', title: 'Task', metadata: { noticeos_card_shipped: '{}' } },
  ]) denied(() => plan(A, request(operation)));
});

test('a card edit reads the task first and is refused once the task shipped its card', () => {
  const editing = { kind: 'update', taskId: 'tt-a', card: CARD };
  assert.deepEqual(writeGuardReads(editing), ['tt-a']);
  assert.deepEqual(writeGuardReads({ ...editing, card: null }), ['tt-a']);
  assert.deepEqual(writeGuardReads({ kind: 'update', taskId: 'tt-a', changeClass: 'copy' }), [], 'a change class alone reads nothing');
  const open = shown({ status: 'open', assignee: '', metadata: { noticeos_card: CARD } });
  assert.equal(guardedWrite(editing, open, 'agent-1'), editing);
  const shipped = { ...open, status: 'closed', metadata: { ...open.metadata,
    noticeos_card_shipped: { card: CARD, closedAt: '2026-10-21T09:30:00Z', commit: 'a1b2c3d' } } };
  for (const operation of [editing, { ...editing, card: null }, { ...editing, title: 'Faster' }, { ...editing, assignee: 'agent-1' }]) {
    assert.throws(() => guardedWrite(operation, shipped, 'agent-1'), error => error instanceof TaskStateRefused
      && assert.deepEqual(error.reason, { kind: 'shipped', closedAt: '2026-10-21T09:30:00Z' }) === undefined);
  }
  assert.equal(guardedWrite({ kind: 'update', taskId: 'tt-a', status: 'open' }, undefined, 'agent-1').status, 'open', 'reopening it reads nothing');
  const refused = refusalFromState(editing, { ...shipped, status: 'open' }, 'agent-1');
  assert.deepEqual(refused?.reason, { kind: 'shipped', closedAt: '2026-10-21T09:30:00Z' }, 'reopening keeps the shipped card');
  assert.equal(decisionRefusal(refused), 'tt-a shipped on 2026-10-21, and its card stays as it shipped.');
  // A value that is not a shipped card freezes nothing.
  assert.equal(guardedWrite(editing, { ...open, metadata: { noticeos_card: CARD, noticeos_card_shipped: 'garbled' } }, 'agent-1'), editing);
});

test('a change to a task\'s choices reads the task first and is refused once a person has chosen', () => {
  const changing = { kind: 'update', taskId: 'tt-a', choices: CHOICES };
  assert.deepEqual(writeGuardReads(changing), ['tt-a']);
  assert.deepEqual(writeGuardReads({ ...changing, choices: null }), ['tt-a']);
  const open = shown({ status: 'open', assignee: '', metadata: { noticeos_choices: CHOICES } });
  assert.equal(guardedWrite(changing, open, 'agent-1'), changing);
  assert.equal(guardedWrite(changing, shown({ assignee: 'alice' }), 'agent-1'), changing, 'choices are not the holder\'s alone');
  const chosen = { ...open, metadata: { ...open.metadata,
    noticeos_choice: { option: 'b', label: 'Redirect to the new page', by: 'person', at: '2026-10-16T12:00:00Z' } } };
  for (const operation of [changing, { ...changing, choices: null }, { ...changing, assignee: 'bob' }]) {
    assert.throws(() => guardedWrite(operation, chosen, 'agent-1'), error => error instanceof TaskStateRefused
      && assert.deepEqual(error.reason, { kind: 'chosen', chosen: '(b) Redirect to the new page' }) === undefined);
  }
  assert.deepEqual(refusalFromState(changing, { ...open, metadata: { noticeos_choice: 'unreadable' } }, 'agent-1')?.reason,
    { kind: 'chosen', chosen: null }, 'a pick that cannot be read still stands');
  assert.equal(guardedWrite({ kind: 'update', taskId: 'tt-a', title: 'New' }, undefined, 'agent-1').title, 'New', 'other changes read nothing');
});

test('a pick and its steps are a person\'s decision, planned as fixed commands', () => {
  const plan = createHostedTaskPlanner(entries);
  const pick = { option: 'b', label: 'Redirect to the new page', by: 'person', at: '2026-10-16T12:00:00Z', note: 'Ship it Friday' };
  for (const operation of [{ kind: 'choose', taskId: 'tt-a', option: 'b' }, { kind: 'choose', taskId: 'tt-a', option: 'f', note: 'Why' },
    { kind: 'record-choice', taskId: 'tt-a', choice: pick }, { kind: 'hand-back', taskId: 'tt-a', holder: '', removeHuman: true }]) {
    assert.equal(hostedTaskAction(operation), 'tasks.decide', operation.kind);
  }
  assert.deepEqual(plan(A, request({ kind: 'choose', taskId: 'tt-a', option: 'b' })).argv, ['--sandbox', '--json'], 'the executor composes a pick from its steps');
  assert.deepEqual(guardReadArgs({ kind: 'choose', taskId: 'tt-a', option: 'b' }, 'tt-a'),
    ['--sandbox', '--readonly', '--json', 'show', '--include-dependents', '--', 'tt-a'], 'a decision\'s open children are read before its close');
  assert.deepEqual(plan(A, request({ kind: 'record-choice', taskId: 'tt-a', choice: pick })).argv.slice(2),
    ['update', `--metadata=${JSON.stringify({ noticeos_choice: pick })}`, '--', 'tt-a']);
  assert.deepEqual(plan(A, request({ kind: 'hand-back', taskId: 'tt-a', holder: 'agent-1', removeHuman: true })).argv.slice(2),
    ['update', '--status=open', '--assignee=', '--if-assignee=agent-1', '--remove-label=human', '--', 'tt-a']);
  assert.deepEqual(plan(A, request({ kind: 'hand-back', taskId: 'tt-a', holder: '', removeHuman: false })).argv.slice(2),
    ['update', '--status=open', '--assignee=', '--if-assignee=', '--', 'tt-a']);
  for (const operation of [{ kind: 'choose', taskId: 'tt-a', option: 'g' }, { kind: 'choose', taskId: 'tt-a', option: 'b', note: '' },
    { kind: 'choose', taskId: 'tt-a', option: 'b', note: 'x'.repeat(2001) }, { kind: 'choose', taskId: 'tt-a' },
    { kind: 'choose', taskId: 'tt-a', option: 'b', by: 'someone' }, { kind: 'record-choice', taskId: 'tt-a', choice: { ...pick, option: 'z' } },
    { kind: 'record-choice', taskId: 'tt-a', choice: { ...pick, by: '' } }, { kind: 'hand-back', taskId: 'tt-a', holder: '' },
    { kind: 'hand-back', taskId: 'tt-a', holder: 'a\nb', removeHuman: true },
    { kind: 'respond', taskId: 'tt-a', response: 'x'.repeat(HOSTED_TASK_LIMITS.comment - 'Answered: '.length + 1) }]) {
    denied(() => hostedTaskAction(operation));
  }
  assert.equal(hostedTaskAction({ kind: 'respond', taskId: 'tt-a', response: 'x'.repeat(HOSTED_TASK_LIMITS.comment - 'Answered: '.length) }), 'tasks.decide');
});

const asking = (extra = {}) => ({ id: 'tt-a', status: 'open', issue_type: 'task', labels: ['human', 'ui'], assignee: '', dependencies: [], dependents: [],
  metadata: { noticeos_choices: CHOICES }, ...extra });
const choosing = (option = 'b', note) => ({ kind: 'choose', taskId: 'tt-a', option, ...(note === undefined ? {} : { note }) });
const AT = '2026-10-16T12:00:00.000Z';

test('a pick is recorded first, then commented, then hands any task but a decision back to ready work', () => {
  const pick = { option: 'b', label: 'Redirect to the new page', by: 'person', at: AT, note: 'Ship it Friday' };
  assert.deepEqual(choiceSteps(choosing('b', 'Ship it Friday'), asking({ assignee: 'agent-1', status: 'in_progress' }), [], 'person', AT), [
    { kind: 'record-choice', taskId: 'tt-a', choice: pick },
    { kind: 'comment', taskId: 'tt-a', text: 'Chose (b) Redirect to the new page. Ship it Friday' },
    { kind: 'hand-back', taskId: 'tt-a', holder: 'agent-1', removeHuman: true },
  ]);
  assert.deepEqual(choiceSteps(choosing('a'), asking({ issue_type: 'decision', dependencies: [{ id: 'tt-b', status: 'open', dependency_type: 'blocks' }] }), [], 'person', AT).at(-1),
    { kind: 'close', taskId: 'tt-a', reason: 'Chose (a) Keep the old page', force: true }, 'a decision closes, past an open blocker');
  assert.deepEqual(choiceSteps(choosing('a'), asking({ issue_type: 'decision' }), [], 'person', AT).at(-1),
    { kind: 'close', taskId: 'tt-a', reason: 'Chose (a) Keep the old page' });
  assert.deepEqual(choiceSteps(choosing('c'), asking({ issue_type: 'decision', assignee: 'agent-1' }), [], 'person', AT).at(-1).force, true,
    'a person closes a decision someone else holds');
  assert.equal(choiceComment(pick), 'Chose (b) Redirect to the new page. Ship it Friday');
  assert.equal(choiceCloseReason(pick), 'Chose (b) Redirect to the new page');
});

test('a pick names why it is refused, and an interrupted one is finished by the same person and option', () => {
  const refusedWith = (row, operation, reason, actor = 'person', comments = []) => assert.throws(() => choiceSteps(operation, row, comments, actor, AT),
    error => error instanceof TaskStateRefused && assert.deepEqual(error.reason, reason) === undefined);
  refusedWith(asking({ metadata: {} }), choosing(), { kind: 'no-choices' });
  refusedWith(asking(), choosing('e'), { kind: 'no-option', option: 'e', offered: ['a', 'b', 'c'] });
  refusedWith(asking({ status: 'closed' }), choosing(), { kind: 'closed' });
  refusedWith(asking({ issue_type: 'decision', dependents: [{ id: 'tt-a.1', status: 'open', dependency_type: 'parent-child' }] }), choosing(),
    { kind: 'children', children: ['tt-a.1'] });
  const earlier = { option: 'b', label: 'Redirect to the new page', by: 'person', at: AT };
  const chosen = asking({ metadata: { noticeos_choices: CHOICES, noticeos_choice: earlier } });
  refusedWith(chosen, choosing('a'), { kind: 'chosen', chosen: '(b) Redirect to the new page' }, 'person');
  refusedWith(chosen, choosing('b'), { kind: 'chosen', chosen: '(b) Redirect to the new page' }, 'someone-else');
  // Recorded but not commented: the same pick again finishes it without a second record.
  assert.deepEqual(choiceSteps(choosing('b'), chosen, [], 'person', '2026-10-17T00:00:00Z').map(step => step.kind), ['comment', 'hand-back']);
  const commented = [{ author: 'person', text: 'Chose (b) Redirect to the new page.' }];
  assert.deepEqual(choiceSteps(choosing('b'), chosen, commented, 'person', AT).map(step => step.kind), ['hand-back'], 'commented, still labelled human');
  refusedWith({ ...chosen, labels: ['ui'] }, choosing('b'), { kind: 'chosen', chosen: '(b) Redirect to the new page' }, 'person', commented);
  refusedWith({ ...chosen, status: 'closed' }, choosing('b'), { kind: 'chosen', chosen: '(b) Redirect to the new page' });
  const sentence = (reason) => decisionRefusal(new TaskStateRefused('tt-a', 'other', reason));
  assert.deepEqual([sentence({ kind: 'chosen', chosen: '(b) Redirect' }), sentence({ kind: 'chosen', chosen: null }), sentence({ kind: 'no-choices' }),
    sentence({ kind: 'no-option', option: 'e', offered: ['a', 'b', 'c'] }), sentence({ kind: 'closed' }), sentence({ kind: 'held', holder: 'x' }),
    sentence({ kind: 'missing', project: { projectId: 'p', name: 'Example', prefix: 'tt' } }),
    sentence({ kind: 'not-open', status: 'blocked', blockers: [] })], [
    'tt-a already has a choice: (b) Redirect.', 'tt-a already has a choice.', 'tt-a offers no options to choose from.',
    'tt-a offers (a), (b) and (c), not (e).', 'tt-a is already closed.', 'tt-a is held by x, and only its holder closes it.',
    'tt-a is not a task in Example.', null]);
});

test('an answer on a task that is not a decision is a comment and a hand-back; a decision keeps the task client\'s own response', () => {
  assert.deepEqual(answerSteps({ kind: 'respond', taskId: 'tt-a', response: 'Use OAuth2' }, asking({ assignee: 'agent-1' })), [
    { kind: 'comment', taskId: 'tt-a', text: 'Answered: Use OAuth2' }, { kind: 'hand-back', taskId: 'tt-a', holder: 'agent-1', removeHuman: true }]);
  assert.equal(answerSteps({ kind: 'respond', taskId: 'tt-a', response: 'Use OAuth2' }, asking({ issue_type: 'decision' })), null);
  assert.equal(answerComment('Yes'), 'Answered: Yes');
});
