// Only a just-created, development-marked installation takes demo facts.
// No URL/default-home input; failed preparation is retained for explicit recovery.
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { openStore } from '../packages/postgres/src/store.mjs';
import { invokedDirectly } from './invoked-directly.mjs';
import { startPlan, planRefusal } from './start.mjs';
import { prepareFreshPostgres, startPostgresPlan } from './start-postgres.mjs';
import { ADDRESS_FILE, DATABASE } from './postgres-secrets.mjs';
import { DEVELOPMENT, PROFILE_SETTING } from './postgres-profile.mjs';
import { runCommand } from './run-command.mjs';
import { generateDemoScenario, demoScenarioHash, shiftDemoDay } from './demo-scenario.mjs';
import { fillDemo as fillStore } from './demo-store.mjs';
import { buildDemoWorkerHelpers, demoStoreCapability } from './demo-evaluator.mjs';
import { createDemoTasks, configureDemoTasks } from './demo-tasks.mjs';
import { seedDemoDisplay } from './demo-display.mjs';
import { generateDemoWorkflows, writeDemoWorkflowHistory } from './demo-workflows.mjs';
import { createDemoActivity, DEMO_NIGHTLY_HOUR } from './demo-activity.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { verifyDemoRelease } from './demo-release.mjs';
export { REQUIRED_DEMO_ENTRIES, verifyDemoRelease } from './demo-release.mjs';
export async function releaseEvaluator({ root, release }) {
    const source = await verifyDemoRelease(root, release);
    const output = mkdtempSync(path.join(tmpdir(), 'noticeos-demo-contract-'));
    try {
        // Build from the verified source. Never import an old installed dist.
        const compiler = path.join(root, 'packages/contract/node_modules/typescript/bin/tsc');
        const built = await runCommand(process.execPath, [compiler, '-p', path.join(root, 'packages/contract/tsconfig.build.json'), '--outDir', output], { cwd: root, timeoutMs: 30_000 });
        if (built.code !== 0 || built.timedOut)
            throw new Error('The verified demo contract could not be built.');
        const workers = await buildDemoWorkerHelpers(root);
        const after = await verifyDemoRelease(root, release);
        if (after.tree !== source.tree)
            throw new Error('The demo source changed during its build.');
        const files = ['rules.js', 'poisson.js', 'codebase-measures.js'];
        const artifacts = Object.fromEntries(files.map(name => [name, createHash('sha256').update(readFileSync(path.join(output, 'packages/contract/src', name))).digest('hex')]));
        const loaded = await import(pathToFileURL(path.join(output, 'packages/contract/src/rules.js')).href);
        const codebase = await import(pathToFileURL(path.join(output, 'packages/contract/src/codebase-measures.js')).href);
        if (typeof loaded.evaluatePulse !== 'function' || typeof codebase.evaluateCodebaseRules !== 'function')
            throw new Error('The verified demo evaluator is absent.');
        const codebaseRules = { evaluateCodebaseRules: codebase.evaluateCodebaseRules, pickComparisonReport: codebase.pickComparisonReport, DEFAULT_CODEBASE_RULE_THRESHOLDS: codebase.DEFAULT_CODEBASE_RULE_THRESHOLDS };
        return { evaluatePulse: loaded.evaluatePulse, codebaseRules, ...workers, provenance: { ...source, artifacts, workers: workers.provenance } };
    } finally { rmSync(output, { recursive: true, force: true }); }
}
const TARGET_VARIABLES = ['DATABASE_URL', 'NOTICEOS_POSTGRES_SECRETS', 'NOTICEOS_POSTGRES_PORT', 'NOTICEOS_HOME', 'NOTICEOS_INSTALLATION_DIR', 'NOTICEOS_DOLT_HOME'];
export function demoTargetRefusal(plan, env = {}) {
    if (TARGET_VARIABLES.some(name => env[name] !== undefined))
        return 'Demo setup refuses inherited installation selectors.';
    const ordinary = planRefusal(plan);
    if (ordinary)
        return ordinary;
    // Do not let a symlinked parent disguise an existing installation path.
    let parent = plan.home;
    while (!existsSync(parent))
        parent = path.dirname(parent);
    if (realpathSync(parent) !== parent)
        return 'Demo setup needs a canonical installation folder.';
    if (lstatSync(plan.home, { throwIfNoEntry: false })?.isSymbolicLink())
        return 'Demo setup refuses a symbolic-link folder.';
    if (existsSync(plan.home) && readdirSync(plan.home).length)
        return 'Demo setup needs a new empty folder.';
    for (const privateRoot of ['installation', '.beads', '.local/runtime', '.local/runtime-a', '.local/runtime-b', '.local/task-compose']) {
        const relative = path.relative(path.join(plan.root, privateRoot), plan.home);
        if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)))
            return 'Demo setup refuses an installation-owned folder.';
    }
    return null;
}
export function fillDemo(tx, scenario, { evaluatePulse, codebaseRules }) {
    return fillStore(tx, scenario, { evaluatePulse, codebaseRules, developmentProfile: { setting: PROFILE_SETTING, value: DEVELOPMENT } });
}

export async function markDemoDevelopment(own, plan, scenario, store, env, run = runCommand) {
    const rows = await store.inWorkspace(scenario.manifest.workspaceId, tx => tx.query(`
SELECT noticeos.only_workspace()::text AS workspace,
  (SELECT count(*)::text FROM noticeos.assets) AS assets,
  (SELECT count(*)::text FROM noticeos.pulses) AS pulses,
  (SELECT count(*)::text FROM noticeos.ledger_entries) AS ledger,
  (SELECT count(*)::text FROM noticeos.signal_runs) AS signals,
  (SELECT count(*)::text FROM noticeos.task_snapshots) AS tasks,
  (SELECT count(*)::text FROM noticeos.integration_connections) AS connections;`), { readOnly: true });
    const row = rows[0];
    if (rows.length !== 1 || row.workspace !== scenario.manifest.workspaceId || ['assets', 'pulses', 'ledger', 'signals', 'tasks', 'connections'].some(key => row[key] !== '0'))
        throw new Error('The new demo bootstrap or empty history could not be verified.');
    const execute = async args => {
        const result = await run('docker', args, { cwd: plan.root, env: { ...env, NOTICEOS_POSTGRES_SECRETS: own.secrets, NOTICEOS_POSTGRES_PORT: String(own.port) }, timeoutMs: 10_000 });
        if (result.code !== 0 || result.timedOut)
            throw new Error('The new demo container could not be verified or marked.');
        return result.stdout;
    };
    const definition = JSON.parse(await execute(['compose', '-p', own.project, '-f', own.compose, '--env-file', '/dev/null', 'config', '--format', 'json']));
    const service = definition.services.postgres;
    const volume = definition.volumes['postgres-data'].name;
    if (definition.name !== own.project || volume !== `${own.project}_postgres-data`)
        throw new Error('The new demo volume differs from its declared project.');
    const ids = (await execute(['container', 'ls', '--all', '--no-trunc', '--filter', `label=com.docker.compose.project=${own.project}`, '--format', '{{.ID}}'])).trim().split(/\s+/u);
    if (ids.length !== 1 || !/^[a-f0-9]{64}$/u.test(ids[0]))
        throw new Error('The new demo container identity is ambiguous.');
    const format = '{"id":{{json .Id}},"image":{{json .Config.Image}},"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}}}';
    const container = JSON.parse(await execute(['container', 'inspect', ids[0], '--format', format]));
    const data = container.mounts.filter(mount => mount.Type === 'volume');
    if (container.id !== ids[0] || container.image !== service.image || container.labels['com.docker.compose.project'] !== own.project || container.labels['com.docker.compose.service'] !== 'postgres' || container.labels['com.docker.compose.oneoff'] !== 'False' || data.length !== 1 || data[0].Name !== volume || data[0].Destination !== '/var/lib/postgresql')
        throw new Error('The new demo container or volume ownership changed.');
    const bindings = (service.volumes ?? []).filter(mount => mount.type === 'bind').map(mount => ({ source: mount.source, target: mount.target }));
    for (const secret of service.secrets ?? []) {
        const source = definition.secrets[secret.source].file;
        if (path.dirname(source) !== own.secrets)
            throw new Error('The new demo secrets differ from its declared folder.');
        const target = secret.target ?? secret.source;
        bindings.push({ source, target: target.startsWith('/') ? target : `/run/secrets/${target}` });
    }
    const actualBindings = container.mounts.filter(mount => mount.Type === 'bind');
    if (actualBindings.length !== bindings.length || actualBindings.some(mount => mount.RW !== false || !bindings.some(expected => expected.source === mount.Source && expected.target === mount.Destination)))
        throw new Error('The new demo container bindings differ from its declared profile.');
    const metadata = JSON.parse(await execute(['volume', 'inspect', volume, '--format', '{{json .}}']));
    if (metadata.Name !== volume || metadata.Labels['com.docker.compose.project'] !== own.project)
        throw new Error('The new demo volume ownership changed.');
    // Only the positively identified new container's existing local socket
    // authority marks this database. No role, grant or HBA change is needed.
    await execute(['exec', ids[0], 'psql', '-X', '--no-password', '--username', 'postgres', '--dbname', DATABASE, '--set', 'ON_ERROR_STOP=1', '--command', `ALTER DATABASE ${DATABASE} SET ${PROFILE_SETTING} = '${DEVELOPMENT}';`]);
}
/** The released evaluator reads each declared comparison at its final check,
 * oldest first: the repair it confirms and the redesign it rejects. */
export async function evaluateDemoWatch(store, scenario, runWatchWindows) {
    const capability = demoStoreCapability(store, scenario.manifest.workspaceId);
    const ledger = () => capability.STORE.read(tx => tx.query('SELECT to_jsonb(l)::text AS row FROM noticeos.ledger_entries l ORDER BY entry_id'));
    const before = await ledger();
    const read = async (story, outcome) => {
        const result = await runWatchWindows(capability, Date.parse(story.checkAt));
        if (result.failed.length || result.overdue.length || result.closed.length !== 1 || result.closed[0].id !== story.watchId || result.closed[0].outcome !== outcome) throw new Error('The released watch evaluator did not record the declared synthetic outcome.');
        const rows = await capability.STORE.read(tx => tx.query('SELECT w.status, w.outcome, w.closed_at, r.checked_at, r.baseline::text AS baseline, r.post::text AS post FROM noticeos.watch_windows w JOIN noticeos.watch_window_readings r USING (workspace_id, window_id) WHERE w.window_id = $1 AND r.final', [story.watchId]));
        const reading = rows[0];
        const readback = scenario.tasks.find(task => task.id === story.readbackTaskId);
        const closes = readback.events.find(event => event.status === 'closed').at;
        if (rows.length !== 1 || reading.status !== 'closed' || reading.outcome !== outcome || Date.parse(reading.checked_at) !== Date.parse(story.checkAt) || Date.parse(reading.closed_at) !== Date.parse(story.checkAt) || Date.parse(story.checkAt) >= Date.parse(closes) || JSON.parse(reading.baseline).days !== 28 || JSON.parse(reading.post).days !== 28) throw new Error('The persisted demo watch reading does not precede its task readback with complete coverage.');
        return { result, reading, evaluatedAt: story.checkAt };
    };
    const repair = await read(scenario.manifest.stories.repair, 'ship_confirmed');
    const slide = await read(scenario.manifest.slide, 'kill_confirmed');
    const after = await ledger();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('The demo watch evaluation changed the ledger.');
    return { capability, ...repair, slide, ledgerSha256: createHash('sha256').update(JSON.stringify(before)).digest('hex') };
}
export async function demoFlagJoins(capability, scenario) {
    const joins = [];
    for (const [name, story] of Object.entries(scenario.manifest.stories)) {
        const date = name === 'repair' ? story.findingDate : story.date;
        const pulse = scenario.pulses.find(item => item.asset === story.asset && item.date === date);
        if (!pulse) throw new Error('The demo finding has no declared pulse.');
        const rows = await capability.STORE.read(tx => tx.query('SELECT flag_number::text AS key, rule_id AS rule FROM noticeos.flags WHERE asset_id = $1 AND fired_at = $2::timestamptz AND metric = $3', [story.asset, pulse.generatedAt, Object.keys(pulse.metrics)[0]]));
        if (rows.length !== 1) throw new Error('The demo finding does not resolve to exactly one public alert key.');
        joins.push({ task: story.ref, asset: story.asset, key: rows[0].key, rule: rows[0].rule });
    }
    return joins;
}
/** The release's hourly freshness check as it ran at the reference day's
 * midnight, the first hour the stopped reports were past their threshold:
 * the site whose nightly reports stopped is the one late site. */
export async function recordDemoFreshness(capability, scenario, runFreshnessCheck) {
    if (typeof runFreshnessCheck !== 'function') throw new Error('The released freshness check is absent.');
    const result = await runFreshnessCheck(capability, Date.parse(`${scenario.manifest.referenceDate}T00:00:00.000Z`));
    const rows = await capability.STORE.read(tx => tx.query("SELECT asset_id AS asset FROM noticeos.flags WHERE rule_id = 'ingest-freshness' AND resolved_at IS NULL"));
    if (result.fired !== 1 || rows.length !== 1 || rows[0].asset !== scenario.manifest.reportGap.asset) throw new Error('The freshness check did not find the declared late report.');
    return { fired: result.fired, stale: result.stale, asset: rows[0].asset };
}
/** Days before the reference day whose home-page outage the seed replays. */
const UPTIME_SEED_DAYS = 6;
/** The release's hourly home-page check as the hourly lane ran it over the
 * last week: each day's brief outage found down at its hour and back the hour
 * after, then every site read in the cutoff's hour. Runs go in time order,
 * because a reading younger than half an hour stands for the next run. */
export async function recordDemoUptime(capability, scenario, runUptimeChecks) {
    if (typeof runUptimeChecks !== 'function') throw new Error('The released uptime check is absent.');
    const activity = createDemoActivity(scenario);
    const { cutoff, referenceDate } = scenario.manifest;
    const hour = 3_600_000;
    const runs = [];
    for (let back = UPTIME_SEED_DAYS; back >= 0; back -= 1) {
        const outage = activity.homeOutage(shiftDemoDay(referenceDate, -back));
        for (const at of [outage.checkAt, new Date(Date.parse(outage.checkAt) + hour).toISOString()])
            if (at <= cutoff) runs.push(at);
    }
    const last = new Date(Math.floor(Date.parse(cutoff) / hour) * hour).toISOString();
    if (last > runs[runs.length - 1]) runs.push(last);
    let fired = 0;
    let resolved = 0;
    for (const at of runs) {
        const result = await runUptimeChecks(capability, { nowMs: Date.parse(at), fetchImpl: activity.homeFetch(at), confirmWaitMs: 0 });
        if (result.failed.length > 0) throw new Error('The uptime check could not read a synthetic home page.');
        fired += result.fired;
        resolved += result.resolved;
    }
    if (fired === 0) throw new Error('The uptime check found none of the declared outages.');
    return { runs: runs.length, fired, resolved };
}
/** Days before the reference day whose page speed the seed records. */
const PAGE_SPEED_SEED_DAYS = 6;
/** The release's nightly site checks as they ran at the cutoff, reading each
 * fictional site's home page, robots.txt, sitemap and a sample of its pages,
 * then the last week's daily page-speed readings as the page-speed job stores
 * them, one a site a night. The young site has no page speed yet. */
export async function recordDemoSiteChecks(capability, scenario, runHygieneChecks, writeReading) {
    if (typeof runHygieneChecks !== 'function' || typeof writeReading !== 'function') throw new Error('The released asset checks are absent.');
    const activity = createDemoActivity(scenario);
    const { cutoff, referenceDate } = scenario.manifest;
    const result = await runHygieneChecks(capability, { nowMs: Date.parse(cutoff), fetchImpl: activity.homeFetch(cutoff), confirmWaitMs: 0 });
    if (result.failed.length > 0 || result.checks === 0) throw new Error('The asset checks could not read a synthetic asset.');
    let pageSpeed = 0;
    for (let back = PAGE_SPEED_SEED_DAYS; back >= 0; back -= 1) {
        const date = shiftDemoDay(referenceDate, -back);
        const at = `${date}T${DEMO_NIGHTLY_HOUR}:00:00.000Z`;
        if (at > cutoff) continue;
        for (const reading of activity.pageSpeed(date)) {
            await writeReading(capability, reading.asset, 'crux-vitals', at, 'ok', reading.lcp, reading.detail);
            pageSpeed += 1;
        }
    }
    return { checks: result.checks, fired: result.fired, pageSpeed };
}
/** The latest seeded week's search reports through the ordinary snapshot
 * writer, so every site's search movers and findings read from the first
 * visit; the simulator writes each Monday after. */
export async function recordDemoSearchReports(capability, scenario, writeInsightSnapshot) {
    if (typeof writeInsightSnapshot !== 'function') throw new Error('The released report writer is absent.');
    const reports = createDemoActivity(scenario).seededReports();
    for (const report of reports) {
        const written = await writeInsightSnapshot(capability, JSON.stringify(report), Date.parse(scenario.manifest.cutoff));
        if (!written.ok) throw new Error('The ordinary writer refused a seeded search report.');
    }
    return { reports: reports.length, generatedAt: reports[0]?.generatedAt ?? null };
}
/** Observe the populated synthetic store, never a scheduler or outside process. */
export async function recordDemoOsObservation(capability, scenario, runAssetZeroPulse) {
    const [held] = await capability.STORE.read(tx => tx.query('SELECT count(*)::int AS jobs FROM noticeos.job_runs'));
    if (held?.jobs !== 0 || typeof runAssetZeroPulse !== 'function') throw new Error('The synthetic OS observation must precede workflow history.');
    const result = await runAssetZeroPulse(capability, Date.parse(scenario.manifest.cutoff));
    if (result === null) throw new Error('The synthetic OS observation did not find its own OS.');
    const os = scenario.assets.find(asset => asset.isOs);
    const rows = await capability.STORE.read(tx => tx.query('SELECT envelope::text AS envelope FROM noticeos.current_pulses WHERE asset_id = $1 AND generated_at = $2::timestamptz', [os.id, scenario.manifest.cutoff]));
    const report = rows.length === 1 ? JSON.parse(rows[0].envelope) : null;
    const observed = ['pulsesReceived', 'ledgerRows', 'openFlagsError', 'openFlagsWarn', 'openFlagsInfo'];
    if (!report || report.asset !== os.id || report.generatedAt !== scenario.manifest.cutoff
        || JSON.stringify(report.capabilities) !== JSON.stringify(observed)
        || Object.keys(report.metrics ?? {}).sort().join() !== [...observed].sort().join()) throw new Error('The synthetic OS observation cannot claim scheduler activity.');
    return { synthetic: true, generatedAt: report.generatedAt, asset: report.asset, capabilities: report.capabilities, metrics: report.metrics };
}
export async function createDemoInstallation({ home, port, scenario, root = ROOT, env = process.env, binary = env.BEADS_BD_BIN }, { prepare = prepareFreshPostgres, open = openStore, mark = markDemoDevelopment, loadEvaluator = releaseEvaluator, tasks = createDemoTasks, configureTasks = configureDemoTasks } = {}) {
    if (typeof home !== 'string' || !path.isAbsolute(home))
        throw new Error('Name an absolute new demo folder.');
    const plan = startPlan({ root, dir: home, port });
    const refusal = demoTargetRefusal(plan, env);
    if (refusal)
        throw new Error(refusal);
    if (Date.parse(scenario.manifest.cutoff) > Date.now())
        throw new Error('Demo setup refuses observations after the current time.');
    if (demoScenarioHash(generateDemoScenario(scenario.manifest)) !== demoScenarioHash(scenario))
        throw new Error('Demo facts differ from their declared scenario.');
    // Resolve the release's built contract before creating any resources.
    const helpers = await loadEvaluator({ root, release: scenario.manifest.release });
    const { evaluatePulse, codebaseRules, provenance } = helpers;
    const setup = await prepare(plan, { env, workspace: { slug: 'demo', displayName: 'Synthetic demo', workspaceId: scenario.manifest.workspaceId } });
    if (!setup.ok || !('created' in setup) || !setup.created || !setup.schema)
        throw new Error('Demo setup did not prove a new database; preserve its folder for review.');
    const own = startPostgresPlan(plan);
    const url = readFileSync(path.join(own.secrets, ADDRESS_FILE), 'utf8').trim();
    const address = new URL(url);
    if (address.protocol !== 'postgresql:' || address.hostname !== '127.0.0.1' || Number(address.port) !== own.port || address.pathname !== '/noticeos' || address.username !== 'noticeos_app')
        throw new Error('Demo database address differs from its new installation.');
    const verification = open(url);
    try {
        const workspace = await verification.onlyWorkspace();
        if (workspace !== scenario.manifest.workspaceId)
            throw new Error('Demo workspace differs from its new installation.');
        await mark(own, plan, scenario, verification, env);
    } finally {
        await verification.close();
    }
    // ALTER DATABASE defaults apply only to new sessions. No unmarked pooled
    // verification connection can be reused for development-only inserts.
    const store = open(url);
    try {
        const workspace = await store.onlyWorkspace();
        if (workspace !== scenario.manifest.workspaceId)
            throw new Error('Demo workspace differs from its new installation.');
        const counts = await store.inWorkspace(workspace, tx => fillDemo(tx, scenario, { evaluatePulse, codebaseRules }));
        const watch = await evaluateDemoWatch(store, scenario, helpers.runWatchWindows);
        const joins = await demoFlagJoins(watch.capability, scenario);
        const freshness = await recordDemoFreshness(watch.capability, scenario, helpers.runFreshnessCheck);
        const uptime = await recordDemoUptime(watch.capability, scenario, helpers.runUptimeChecks);
        const siteChecks = await recordDemoSiteChecks(watch.capability, scenario, helpers.runHygieneChecks, helpers.writeReading);
        const searchReports = await recordDemoSearchReports(watch.capability, scenario, helpers.writeInsightSnapshot);
        const taskReceipt = await tasks({ plan, scenario, createdPostgres: setup, capability: watch.capability, writeSnapshot: helpers.writeBeadsSnapshot, joins, env, binary });
        const taskConfig = await configureTasks({ plan, scenario, receipt: taskReceipt, capability: watch.capability, helpers });
        const display = await seedDemoDisplay({ home, installation: plan.installation, scenario, capability: watch.capability, helpers });
        const osReport = await recordDemoOsObservation(watch.capability, scenario, helpers.runAssetZeroPulse);
        const history = generateDemoWorkflows({ scenario, watch, tasks: taskReceipt });
        const workflowHistory = await writeDemoWorkflowHistory({ home, history,
            writeRuns: (input, nowMs) => helpers.writeJobRuns(watch.capability, input, nowMs) });
        const schema = setup.schema;
        const receipt = { ...scenario.manifest, scenarioHash: demoScenarioHash(scenario), evaluator: provenance, schema, counts: { ...counts, pulses: counts.pulses + 1, tasks: taskReceipt.tasks, taskSnapshots: taskReceipt.snapshots, watchStatus: 'closed' }, home, postgresProject: own.project, taskGeneration: taskReceipt, taskConfig, display, osReport, freshness, uptime, siteChecks, searchReports, workflowHistory, watch: { result: watch.result, reading: watch.reading, evaluatedAt: watch.evaluatedAt, ledgerSha256: watch.ledgerSha256 }, handoffs: joins };
        writeFileSync(path.join(home, 'demo-manifest.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        // Wall clock completion is distinct from the scenario's historical
        // cutoff. A viewer may use this receipt only after every real seed
        // component and unchanged evaluator has completed successfully.
        const generation = { version: 1, synthetic: true, completedAt: new Date().toISOString(), release: receipt.release, tree: provenance.tree, scenarioHash: receipt.scenarioHash, workspaceId: workspace,
            manifestSha256: createHash('sha256').update(readFileSync(path.join(home, 'demo-manifest.json'))).digest('hex'),
            tasksSha256: createHash('sha256').update(readFileSync(path.join(home, 'demo-tasks.json'))).digest('hex'), evaluator: provenance };
        writeFileSync(path.join(home, 'demo-generation.json'), `${JSON.stringify(generation, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        return receipt;
    }
    finally {
        await store.close();
    }
}
export async function main(argv = process.argv.slice(2), out = process.stdout, err = process.stderr) {
    const values = {};
    try {
        if (!argv.includes('--confirm-synthetic'))
            throw new Error('Confirm a new synthetic installation with --confirm-synthetic.');
        for (let i = 0; i < argv.length; i++) {
            if (argv[i] === '--confirm-synthetic')
                continue;
            const name = argv[i].slice(2);
            if (!['dir', 'port', 'seed', 'cutoff', 'release'].includes(name) || name in values || !argv[i + 1] || argv[i + 1].startsWith('--'))
                throw new Error('Use --dir, --port, --seed, --cutoff and --release once each.');
            values[name] = argv[++i];
        }
        if (!/^\d+$/u.test(values.port ?? ''))
            throw new Error('Name a fresh local --port.');
        const scenario = generateDemoScenario({ seed: values.seed, cutoff: values.cutoff, release: values.release });
        const receipt = await createDemoInstallation({ home: values.dir, port: Number(values.port), scenario });
        out.write(`${JSON.stringify({ ok: true, synthetic: true, scenarioHash: receipt.scenarioHash, release: receipt.release, counts: receipt.counts })}\n`);
        return 0;
    }
    catch {
        err.write('Demo seed refused or stopped. Preserve any new folder for explicit recovery.\n');
        return 1;
    }
}
if (invokedDirectly(process.argv[1], import.meta.url))
    process.exitCode = await main();
