// runner/push-state.mjs — the hourly push-state lane: for every saved project
// it fetches origin/main, files one `push-state` bead when local commits sit
// unpushed past the threshold, closes it once the push lands, and evaluates the
// project's gates (`bd gate check`) on the same tick. Unknown state files and
// closes nothing.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { TASK_METADATA } from '../../packages/contract/src/task-metadata.mjs';
import { runCommand } from '../run-command.mjs';
import { readTaskProjectConfig } from '../task-project-config.mjs';
import { CONFIG, HOME_ROOT, REPO_ROOT } from './config.mjs';
import { gitBin } from './host-tools.mjs';
import { isShuttingDown } from './lifecycle.mjs';
import { log } from './log.mjs';
import {
  BEADS_ERROR_MAX,
  beadsCreatedId,
  beadsFailure,
  beadsSkipDecision,
  beadsText,
  checkBeadsHub,
  parseBeadsProjects,
  runBd,
} from './task-hub.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// Push-state filer — the second lane here that WRITES a bead, and the only one
// that also CLOSES one.
//
// Origin: myplate's mp-jxs, "Push the 5 unpushed local commits", stayed open for
// two days after those five commits were pushed. Nothing closed it, and by then
// the branch was five ahead AGAIN — different commits — so its title was true of
// nothing. A push bead's referent moves under it while the bead sits still.
// That is the whole failure mode, and it is why this lane maintains those beads
// from the live push state instead of from what somebody saw once:
//
//   - the TITLE never pins a count (`pushStateTitle`), because a count is
//     exactly the part that goes stale;
//   - the commit list lives in the DESCRIPTION and says it is as of filing;
//   - the bead closes when the runner sees the push, not when a human
//     remembers the bead.
//
// Beads' own gates cannot express this: the gate vocabulary is
// human/timer/gh:run/gh:pr/bead — there is no shell-condition gate — and the
// portfolio deploys through Cloudflare Workers Builds, with no Actions run and
// no pull request for a `gh` gate to watch. The runner is the only thing on this
// machine that can ask git and write the hub, so it is the right home.
//
// UNKNOWN IS NOT A STATE. Every decision comes from a fetch this pass just made.
// When that fetch fails — launchd's environment has no SSH agent, the network is
// down, the remote is gone — the spoke is skipped entirely: nothing filed,
// nothing closed. A bead filed against a remote we could not read, or closed
// because we could not see the commits, would be the same lie in the other
// direction. Skipped is not silent, though (bead ro-ujb9.188): each unread
// spoke is a failed item of the pass's run record, with a reason code, so
// System health names it every run while the log names it once.
// ─────────────────────────────────────────────────────────────────────────────

/** The label every push bead carries. The lane finds its own work by it, so a
 * bead a human filed by hand is adopted (and auto-closed) the moment it wears
 * this label — which is the migration path for the ones already in the hub. */
export const PUSH_STATE_LABEL = 'push-state';
/** Filed FOR the operator: only he can push. `bd human list` is his inbox, so
 * the bead has to be readable as an ask rather than as a chore for an agent. */
export const PUSH_STATE_HUMAN_LABEL = 'human';
/** Who the audit trail names. Deliberately not a person: nobody chose to file
 * this, a divergence that outlasted the threshold did. */
export const PUSH_STATE_ACTOR = 'os-up-push-filer';
/** Which property a push bead is about. Prefixed with the product's name
 * because these beads live in PROPERTY repos, whose trackers carry other
 * people's conventions too (`reindex_push_asset` before the rename). */
export const PUSH_STATE_ASSET_KEY = TASK_METADATA.pushAsset.name;
/** The branch pair every spoke is measured on. The portfolio is single-branch
 * by construction (the owner commits to main and a push IS the release), so
 * these are named once here rather than spelled into four argv builders. */
export const PUSH_STATE_REMOTE = 'origin';
export const PUSH_STATE_BRANCH = 'main';
/** How many commits the description lists before it stops. A spoke fifty ahead
 * has a different problem than a forgotten push, and fifty lines of subjects in
 * an inbox item is a wall nobody reads to the bottom of. */
export const PUSH_STATE_COMMIT_LIMIT = 20;
/** A hung `git fetch` must not stall the tick into the next one. Generous
 * because it is a network call over SSH; BatchMode below is what keeps it from
 * ever being an INTERACTIVE hang, which no timeout length would fix. */
const PUSH_STATE_GIT_TIMEOUT_MS = 30_000;
/** `bd gate check` is local work against the hub — a slow one means the hub is
 * in trouble, and waiting longer will not help. */
const PUSH_STATE_GATE_TIMEOUT_MS = 20_000;
/** Field separator inside `git log --format`. ASCII unit separator: a commit
 * subject can contain a tab, a pipe or a comma, and has never contained this. */
const PUSH_STATE_LOG_SEP = '\x1f';

/**
 * Spawn one `git` invocation and collect it. Same contract as `runBd`: a
 * non-zero exit is DATA — "this spoke's push state is unreadable" — and never an
 * exception.
 *
 * The environment is the interesting part. Under launchd there is no terminal
 * and no SSH agent, and a `git fetch` that decides to ASK for something (a
 * passphrase, an unknown host key, a username) does not fail — it blocks until
 * the timeout, every hour, forever. `GIT_TERMINAL_PROMPT=0` and ssh's
 * `BatchMode=yes` turn every one of those questions into an immediate non-zero
 * exit, which this lane already knows how to skip on. An operator who has set
 * GIT_SSH_COMMAND themselves keeps theirs.
 */
async function runGit(argv, timeoutMs = PUSH_STATE_GIT_TIMEOUT_MS) {
  const result = await runCommand(gitBin(), argv, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
    },
    timeoutMs,
  });
  if (result.error) throw result.error;
  return result;
}

/** The one command that has to reach the network. Fetching the BRANCH rather
 * than the remote wholesale keeps a spoke with fifty stale branches from paying
 * for all of them hourly; it still updates refs/remotes/origin/main, which is
 * the ref every read below is measured against. */
export function pushStateFetchArgs(repoDir) {
  return ['-C', repoDir, 'fetch', PUSH_STATE_REMOTE, PUSH_STATE_BRANCH];
}

/** behind/ahead in one line. The symmetric `...` is deliberate: `..` would
 * answer only half the question, and the behind count is what tells the
 * operator whether his push will be a fast-forward. */
export function pushStateCountArgs(repoDir) {
  return [
    '-C',
    repoDir,
    'rev-list',
    '--left-right',
    '--count',
    `${PUSH_STATE_REMOTE}/${PUSH_STATE_BRANCH}...${PUSH_STATE_BRANCH}`,
  ];
}

/** The unpushed commits, newest first, as `<hash><US><epoch-seconds><US><subject>`.
 *
 * ONE read for two answers — the age that decides whether to file, and the list
 * that goes in the bead — so the two can never disagree about which commits they
 * describe. A separate `--format=%ct` call would be one subprocess more and one
 * more chance for the branch to move between them. */
export function pushStateLogArgs(repoDir) {
  return [
    '-C',
    repoDir,
    'log',
    `${PUSH_STATE_REMOTE}/${PUSH_STATE_BRANCH}..${PUSH_STATE_BRANCH}`,
    `--format=%h${PUSH_STATE_LOG_SEP}%ct${PUSH_STATE_LOG_SEP}%s`,
  ];
}

/**
 * behind/ahead from `rev-list --left-right --count`, or null when that is not
 * what came back.
 *
 * Null is load-bearing: a spoke with no `origin/main` ref (never pushed, or a
 * differently-named default branch) exits non-zero or prints something else
 * entirely, and the caller must treat that as "we do not know" rather than as
 * zero. A zero would close every push bead the spoke has.
 */
export function parseRevListCounts(stdout) {
  const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(String(stdout ?? ''));
  if (!match) return null;
  return { behind: Number(match[1]), ahead: Number(match[2]) };
}

/**
 * The unpushed commits, as objects. Timestamps arrive from git in SECONDS and
 * leave here in MILLISECONDS, so every comparison downstream is against
 * `Date.now()` in its own unit — a mixed-unit age check reads as "9 hours old"
 * for something committed in 1971.
 *
 * A malformed line is dropped rather than repaired: an empty timestamp would
 * parse as epoch 0, which is 56 years past any staleness threshold, and would
 * file a bead about commits made this minute.
 */
export function parseUnpushedCommits(stdout) {
  const commits = [];
  for (const line of String(stdout ?? '').split('\n')) {
    if (line.trim() === '') continue;
    const [hash, seconds, ...rest] = line.split(PUSH_STATE_LOG_SEP);
    if (!/^[0-9a-f]+$/i.test(String(hash ?? '').trim())) continue;
    if (!/^\d+$/.test(String(seconds ?? '').trim())) continue;
    commits.push({
      hash: hash.trim(),
      committedAtMs: Number(seconds) * 1000,
      subject: rest.join(PUSH_STATE_LOG_SEP).trim(),
    });
  }
  return commits;
}

/** When the oldest unpushed commit was made, in ms, or null when the list says
 * nothing. `git log` returns newest first, but the minimum is taken rather than
 * the last row: rebases and cherry-picks make commit dates non-monotonic. */
export function oldestUnpushedAt(commits) {
  if (!Array.isArray(commits) || commits.length === 0) return null;
  let oldest = Infinity;
  for (const commit of commits) {
    if (Number.isFinite(commit?.committedAtMs)) oldest = Math.min(oldest, commit.committedAtMs);
  }
  return Number.isFinite(oldest) ? oldest : null;
}

/**
 * Every push bead a spoke currently holds open, or null when we could not ask.
 *
 * The null/empty distinction is the same one the poller draws everywhere else,
 * and here it decides a WRITE: an empty list licenses filing, and a null must
 * not. Closed beads are excluded by the query and again here, because a push
 * bead legitimately RECURS — the closed one is history, not a duplicate.
 */
export function pushStateOpenBeads(rows) {
  if (!Array.isArray(rows)) return null;
  const beads = [];
  for (const row of rows) {
    const beadId = beadsText(row?.id);
    if (beadId === '') continue;
    if (beadsText(row?.status) === 'closed') continue;
    beads.push({ beadId, title: beadsText(row?.title, beadId) });
  }
  return beads;
}

/** What is open against this spoke. Closed is deliberately NOT asked for — the
 * opposite of the panel filer's query, and for the opposite reason: a panel day
 * is reviewed once ever, while a spoke goes unpushed again every week. A closed
 * push bead is a finished episode, not a claim on the current one. */
export function pushStateListArgs(repoDir) {
  return [
    '-C',
    repoDir,
    'list',
    '--label',
    PUSH_STATE_LABEL,
    '--status',
    'open,in_progress,blocked,deferred',
    '--json',
    '--limit',
    '0',
  ];
}

/**
 * The title. No count, no commit hash, no date — deliberately.
 *
 * mp-jxs was titled "Push the 5 unpushed local commits" and was read on a board
 * two days later, when the number was true of a different five commits. A title
 * is the one field nothing re-derives, so the only durable thing to put in it is
 * the ask itself. The count lives in the description, which says when it was
 * taken.
 */
export function pushStateTitle(asset) {
  return `Push the unpushed local commits on ${asset}`;
}

/** What the operator reads in his inbox: what is unpushed, the command that
 * pushes it, and the promise that he will never have to close this by hand. */
export function pushStateDescription({
  asset,
  repoDir,
  behind,
  ahead,
  commits,
  checkedAt,
  staleHours = CONFIG.pushStaleHours,
}) {
  const listed = commits.slice(0, PUSH_STATE_COMMIT_LIMIT);
  const rest = commits.length - listed.length;
  const lines = listed.map((commit) => `  ${commit.hash}  ${commit.subject}`);
  if (rest > 0) lines.push(`  …and ${rest} more`);
  return [
    `WHAT: ${asset} has local commits on ${PUSH_STATE_BRANCH} that ` +
      `${PUSH_STATE_REMOTE}/${PUSH_STATE_BRANCH} does not, and the oldest has been sitting ` +
      `for more than ${staleHours}h. Push them:`,
    `    git -C ${repoDir} push ${PUSH_STATE_REMOTE} ${PUSH_STATE_BRANCH}`,
    `AS OF ${checkedAt} — ${ahead} ahead, ${behind} behind. This list ages and the ` +
      `title deliberately carries no count: the branch moves, and the runner re-reads the ` +
      `real state every hour rather than trusting anything written here.`,
    lines.join('\n'),
    `WHY: for the deploy-wired spokes a push IS the release — Cloudflare Workers Builds ` +
      `deploys ${PUSH_STATE_REMOTE}/${PUSH_STATE_BRANCH} automatically — so an unpushed ` +
      `commit is finished work that no user, and no crawler, can see. For the rest it is ` +
      `still the only copy that survives this machine.`,
    `CLOSING: nobody has to. The OS runner (scripts/os-up.mjs, push-state lane) ` +
      `fetches ${PUSH_STATE_REMOTE}/${PUSH_STATE_BRANCH} for every spoke once an hour, and ` +
      `the first pass that sees nothing ahead closes this bead with the fetch and rev-list ` +
      `evidence in the reason. If the spoke diverges again later, that is a FRESH bead — ` +
      `this one is one episode, not a standing chore.`,
  ].join('\n\n');
}

/** What "done" means. Same-day provable, and provable by the runner itself —
 * which is the point: an acceptance criterion nothing can evaluate is how a
 * push bead outlives its own referent. */
export const PUSH_STATE_ACCEPTANCE =
  `\`git fetch ${PUSH_STATE_REMOTE} ${PUSH_STATE_BRANCH}\` followed by ` +
  `\`git rev-list --left-right --count ${PUSH_STATE_REMOTE}/${PUSH_STATE_BRANCH}...${PUSH_STATE_BRANCH}\` ` +
  `reports 0 ahead in this repo.`;

/**
 * The bead, as argv.
 *
 * P1 and both labels are stated rather than inherited: unpushed work is ahead of
 * everything an agent could pick up (nothing else in the queue can ship until it
 * does), and `human` is what puts it in `bd human list` — the only inbox the
 * person who can actually push reads.
 */
export function pushStateCreateArgs(repoDir, filing) {
  return [
    '-C',
    repoDir,
    '--actor',
    PUSH_STATE_ACTOR,
    'create',
    pushStateTitle(filing.asset),
    '--type',
    'task',
    '--priority',
    '1',
    '--labels',
    `${PUSH_STATE_LABEL},${PUSH_STATE_HUMAN_LABEL}`,
    '--metadata',
    JSON.stringify({ [PUSH_STATE_ASSET_KEY]: filing.asset }),
    '--description',
    pushStateDescription(filing),
    '--acceptance',
    PUSH_STATE_ACCEPTANCE,
    '--json',
  ];
}

/** The evidence, in the close reason itself. A push bead closed by a machine has
 * to say what the machine saw and when, or the next reader has no more reason to
 * believe the close than mp-jxs's reader had to believe the title. */
export function pushStateCloseReason({ asset, repoDir, behind, checkedAt }) {
  return (
    `${PUSH_STATE_REMOTE}/${PUSH_STATE_BRANCH} now contains every local commit on ${asset}: ` +
    `\`git -C ${repoDir} fetch ${PUSH_STATE_REMOTE} ${PUSH_STATE_BRANCH}\` then ` +
    `\`git rev-list --left-right --count ${PUSH_STATE_REMOTE}/${PUSH_STATE_BRANCH}...${PUSH_STATE_BRANCH}\` ` +
    `reports 0 ahead (${behind} behind) at ${checkedAt}. Closed automatically by the ` +
    `OS runner's push-state lane (scripts/os-up.mjs). Recurrence: a later divergence ` +
    `files a fresh bead rather than reopening this one.`
  );
}

export function pushStateCloseArgs(repoDir, beadId, reason) {
  return ['-C', repoDir, '--actor', PUSH_STATE_ACTOR, 'close', beadId, '-r', reason];
}

/**
 * Evaluate this spoke's gates.
 *
 * Nothing schedules this today, which quietly breaks the one gate type that
 * promises to resolve itself: a `timer` gate expires "automatically" only in the
 * sense that some later `bd gate check` notices, and until now that meant the
 * next time a human happened to type one. It rides this lane because this is the
 * lane that already walks every spoke on an hourly tick; it shares nothing else
 * with the push logic, and its failures are reported separately.
 */
export function beadsGateCheckArgs(repoDir) {
  return ['-C', repoDir, 'gate', 'check'];
}

/**
 * What to do about one spoke, from facts alone.
 *
 * Pure, and the ONLY place the file/close/skip choice is made — the caller just
 * gathers and executes. Every branch that cannot prove its case returns `skip`,
 * because both mistakes this lane can make are worse than doing nothing: a bead
 * filed against a remote we could not read tells the operator to push work that
 * is already live, and a bead closed on an unread state tells him work shipped
 * when it is still sitting on this Mac.
 *
 * `openPushBeads` is null when the spoke could not be asked and an array when it
 * could — the same measurement/silence distinction the poller draws everywhere.
 */
export function pushStateDecision(
  { fetchOk, ahead, oldestUnpushedEpochMs, openPushBeads, nowEpochMs },
  staleHours = CONFIG.pushStaleHours,
) {
  if (fetchOk !== true) {
    return { action: 'skip', reason: 'the remote could not be fetched' };
  }
  if (!Number.isInteger(ahead) || ahead < 0) {
    return { action: 'skip', reason: 'the ahead/behind counts could not be read' };
  }
  if (!Array.isArray(openPushBeads)) {
    return { action: 'skip', reason: 'the spoke’s open push beads could not be read' };
  }
  if (ahead === 0) {
    if (openPushBeads.length === 0) return { action: 'none', reason: 'nothing is unpushed' };
    return {
      action: 'close',
      beads: openPushBeads,
      reason: 'everything local is on the remote',
    };
  }
  // Ahead, and already asked about. Re-filing over an open bead is what turns a
  // label into noise, and unlike the panel filer's date-keyed dedupe there is no
  // second identity to file under: one spoke, one open push bead, ever.
  if (openPushBeads.length > 0) {
    return { action: 'none', reason: 'a push bead is already open on this spoke' };
  }
  if (!Number.isFinite(oldestUnpushedEpochMs) || !Number.isFinite(nowEpochMs)) {
    return { action: 'skip', reason: 'the age of the unpushed commits could not be read' };
  }
  const ageHours = (nowEpochMs - oldestUnpushedEpochMs) / 3_600_000;
  if (!(ageHours >= staleHours)) {
    return {
      action: 'none',
      ageHours,
      reason: `the oldest unpushed commit is under the ${staleHours}h threshold`,
    };
  }
  return { action: 'file', ageHours, reason: `unpushed for more than ${staleHours}h` };
}

/**
 * Whether a spoke's degraded state is NEWS.
 *
 * The per-spoke twin of `beadsSkipDecision`, and it exists because this lane
 * walks SEVEN repos every hour: without it, one sibling repo the operator has
 * archived would write 168 identical WARN lines a week and bury everything else
 * in the log. Same rule as the lane-level one — a new reason logs, a repeated
 * reason is silent — with `null` meaning recovered, which is itself worth a line.
 */
export function pushStateSpokeDecision(seen, asset, reason) {
  const held = seen.get(asset) ?? null;
  if (held === reason) return false;
  if (reason === null) seen.delete(asset);
  else seen.set(asset, reason);
  return true;
}

/**
 * WHY A SPOKE'S PUSH STATE IS UNREAD, as a code the run record carries (bead
 * ro-ujb9.188). The run's output projection (scripts/workflow-output.mts
 * REASONS) names each code in words and System health shows it, so a spoke the
 * lane cannot read is on the screen every run, not in one log line that falls
 * silent after it. git's own text never leaves the log: it can name a host,
 * a path or an account.
 */
export function pushStateUnreadReason(stderr) {
  const text = String(stderr ?? '');
  if (/Permission denied \(publickey|Authentication failed|could not read Username|Host key verification failed|terminal prompts disabled/iu.test(text)) {
    return 'remote-sign-in-refused';
  }
  if (/Could not resolve host|Connection (?:timed out|refused|reset)|Network is unreachable|Operation timed out|timed out/iu.test(text)) {
    return 'remote-unreachable';
  }
  return 'git-read-failed';
}

/** A `git` or `bd` failure in one bounded line, for a per-spoke WARN. */
function pushStateDetail(result) {
  const detail = beadsText(result?.stderr) || beadsText(result?.stdout) || 'no output';
  return detail.split('\n')[0].slice(0, BEADS_ERROR_MAX);
}

// Lane-level skip (hub down, no spokes) plus two per-spoke maps: what is
// currently wrong with each spoke's push state, and with each spoke's gate
// evaluation. Separate maps because a spoke whose gates cannot be evaluated
// still has a perfectly readable push state, and conflating them would silence
// whichever line arrived second.
const pushStateFilerState = { skipping: null, degraded: new Map(), gates: new Map() };

/**
 * One pass over every spoke: reconcile its push bead, then evaluate its gates.
 *
 * Takes no `runtime`; saved project membership is read through the ingest door
 * before querying git and the hub. An unavailable configuration read skips the
 * pass instead of acting on projects removed from the saved map.
 *
 * Every dependency that touches the world is injectable, for the same reason as
 * the other lanes': what this does when something is missing IS the behavior,
 * and none of it is reachable from a test that has to fetch a real remote and
 * write a real tracker.
 */
export async function runPushStateFiler(deps = {}) {
  const {
    probe = () => checkBeadsHub(),
    readConfig = () => readTaskProjectConfig({ repoRoot: HOME_ROOT }),
    run = runBd,
    git = runGit,
    exists = existsSync,
    now = Date.now,
    staleHours = CONFIG.pushStaleHours,
    state = pushStateFilerState,
    emit = log,
    stopped = () => isShuttingDown(),
    repoRoot = HOME_ROOT,
  } = deps;

  const skip = (reason) => {
    if (beadsSkipDecision(state, reason)) {
      emit('WARN', `push state filer skipped — ${reason} (silent until it changes)`);
    }
  };
  /** A spoke we cannot act on: one line when it starts, silence while it lasts. */
  const degrade = (asset, reason, text) => {
    if (pushStateSpokeDecision(state.degraded, asset, reason)) emit('WARN', text);
  };

  if (stopped()) return null;
  // The hub, not the tower: every write below is a `bd` call, and filing against
  // a down hub would only produce seven identical failures.
  if (!(await probe())) {
    skip('the beads task hub is unreachable');
    return null;
  }

  let raw;
  try {
    raw = await readConfig();
  } catch (err) {
    skip(`the task map is unreadable (${err.message})`);
    return null;
  }
  const projects = parseBeadsProjects(raw);
  if (projects.length === 0) {
    skip('no beads spokes are configured');
    return null;
  }

  if (state.skipping !== null) {
    emit('INFO', `push state filer resumed (was skipped: ${state.skipping})`);
    state.skipping = null;
  }

  const filed = [];
  const closed = [];
  /** Spokes whose push state this pass could not read, and why — every pass,
   * so the run record (and System health) says so for as long as it lasts,
   * while the log says it once. */
  const failed = [];
  let checked = 0;

  for (const project of projects) {
    if (stopped()) break;
    const { asset } = project;
    if (project.unavailableReason) {
      degrade(asset, 'unlinked', project.unavailableReason);
      continue;
    }
    const repoDir = path.resolve(repoRoot, project.repo);

    // A spoke whose repo is not on THIS machine. The task map is portfolio-wide
    // and a clone is per-machine, so this is a normal state, not a fault.
    if (!exists(repoDir)) {
      degrade(
        asset,
        'missing',
        `push state: ${asset} — no repo at ${repoDir}; skipped (silent until that changes)`,
      );
      continue;
    }

    // Runs for every spoke that exists, INCLUDING the ones whose push state
    // turns out to be unreadable below: `bd gate check` does not depend on git
    // having worked, and a spoke with no SSH agent still has timer gates.
    await runSpokeGateCheck({ project, repoDir, run, state, emit });

    const fetched = await git(pushStateFetchArgs(repoDir)).catch((err) => ({
      code: 1,
      stdout: '',
      stderr: `git could not run: ${err.message}`,
    }));
    if (fetched.code !== 0) {
      failed.push({ asset, reason: pushStateUnreadReason(fetched.stderr) });
      degrade(
        asset,
        'fetch',
        `push state: ${asset} — \`git fetch ${PUSH_STATE_REMOTE} ${PUSH_STATE_BRANCH}\` failed ` +
          `(${pushStateDetail(fetched)}); the push state is UNKNOWN, so nothing was filed or ` +
          `closed for this spoke. launchd's environment may have no SSH agent. ` +
          `(silent until it changes)`,
      );
      continue;
    }

    const counted = await git(pushStateCountArgs(repoDir)).catch((err) => ({
      code: 1,
      stdout: '',
      stderr: `git could not run: ${err.message}`,
    }));
    const counts = counted.code === 0 ? parseRevListCounts(counted.stdout) : null;
    if (counts === null) {
      failed.push({ asset, reason: 'git-read-failed' });
      degrade(
        asset,
        'counts',
        `push state: ${asset} — could not count ${PUSH_STATE_REMOTE}/${PUSH_STATE_BRANCH}...` +
          `${PUSH_STATE_BRANCH} (${pushStateDetail(counted)}); nothing filed or closed ` +
          `(silent until it changes)`,
      );
      continue;
    }

    // Only when there is something to describe. A spoke in sync pays one fetch
    // and one rev-list an hour, which is the steady state for most of them.
    let commits = [];
    if (counts.ahead > 0) {
      const logged = await git(pushStateLogArgs(repoDir)).catch((err) => ({
        code: 1,
        stdout: '',
        stderr: `git could not run: ${err.message}`,
      }));
      if (logged.code !== 0) {
        failed.push({ asset, reason: 'git-read-failed' });
        degrade(
          asset,
          'log',
          `push state: ${asset} — could not read the unpushed commits ` +
            `(${pushStateDetail(logged)}); nothing filed (silent until it changes)`,
        );
        continue;
      }
      commits = parseUnpushedCommits(logged.stdout);
    }

    let listed;
    try {
      listed = await run(pushStateListArgs(repoDir));
    } catch (err) {
      degrade(
        asset,
        'bd-list-spawn',
        `push state: ${asset} — bd list could not run: ${err.message} (silent until it changes)`,
      );
      continue;
    }
    let rows = null;
    if (listed.code === 0) {
      try {
        rows = JSON.parse(listed.stdout);
      } catch {
        rows = null;
      }
    }
    const openPushBeads = pushStateOpenBeads(rows);
    if (openPushBeads === null) {
      degrade(
        asset,
        'bd-list',
        `push state: ${asset} — ${beadsFailure('push state list', listed)}; nothing filed or ` +
          `closed (silent until it changes)`,
      );
      continue;
    }

    const nowEpochMs = now();
    const checkedAt = new Date(nowEpochMs).toISOString();
    const decision = pushStateDecision(
      {
        fetchOk: true,
        ahead: counts.ahead,
        oldestUnpushedEpochMs: oldestUnpushedAt(commits),
        openPushBeads,
        nowEpochMs,
      },
      staleHours,
    );

    if (decision.action === 'skip') {
      degrade(
        asset,
        'decision',
        `push state: ${asset} — ${decision.reason}; nothing filed or closed ` +
          `(silent until it changes)`,
      );
      continue;
    }

    // Everything the spoke needed to answer, answered. Whatever was wrong with
    // it before is over, and that is worth exactly one line.
    checked += 1;
    if (pushStateSpokeDecision(state.degraded, asset, null)) {
      emit('INFO', `push state: ${asset} — readable again`);
    }

    if (decision.action === 'close') {
      const reason = pushStateCloseReason({ asset, repoDir, behind: counts.behind, checkedAt });
      for (const bead of decision.beads) {
        let done;
        try {
          done = await run(pushStateCloseArgs(repoDir, bead.beadId, reason));
        } catch (err) {
          emit('ERROR', `push state: ${asset} — bd close could not run: ${err.message}`);
          continue;
        }
        if (done.code !== 0) {
          emit('ERROR', `push state: ${asset} — ${beadsFailure('push state close', done)}`);
          continue;
        }
        closed.push({ asset, beadId: bead.beadId });
        emit(
          'INFO',
          `push state closed — ${bead.beadId} in ${project.repo}: ` +
            `${PUSH_STATE_REMOTE}/${PUSH_STATE_BRANCH} now contains every local commit`,
        );
      }
      continue;
    }

    if (decision.action !== 'file') continue;

    let created;
    try {
      created = await run(
        pushStateCreateArgs(repoDir, {
          asset,
          repoDir,
          behind: counts.behind,
          ahead: counts.ahead,
          commits,
          checkedAt,
          staleHours,
        }),
      );
    } catch (err) {
      emit('ERROR', `push state: ${asset} — bd create could not run: ${err.message}`);
      continue;
    }
    if (created.code !== 0) {
      emit('ERROR', `push state: ${asset} — ${beadsFailure('push state create', created)}`);
      continue;
    }
    const beadId = beadsCreatedId(created.stdout);
    filed.push({ asset, beadId, ahead: counts.ahead });
    emit(
      'INFO',
      `push state filed — ${beadId ?? '(id unread)'} in ${project.repo}: ` +
        `"${pushStateTitle(asset)}" (${counts.ahead} commit(s), oldest ` +
        `${Math.floor(decision.ageHours)}h old)`,
    );
  }

  return { checked, filed, closed, failed };
}

/** One spoke's gate evaluation. Its own state key, so a spoke whose gates cannot
 * be evaluated still reports its push state normally — and the reverse. A
 * failure is one WARN when it starts, then silence until it changes or ends. */
async function runSpokeGateCheck({ project, repoDir, run, state, emit }) {
  let result;
  try {
    result = await run(beadsGateCheckArgs(repoDir), PUSH_STATE_GATE_TIMEOUT_MS);
  } catch (err) {
    if (pushStateSpokeDecision(state.gates, project.asset, 'spawn')) {
      emit(
        'WARN',
        `push state: ${project.asset} — bd gate check could not run: ${err.message} ` +
          `(silent until it changes)`,
      );
    }
    return { ok: false };
  }
  if (result.code !== 0) {
    if (pushStateSpokeDecision(state.gates, project.asset, 'exit')) {
      emit(
        'WARN',
        `push state: ${project.asset} — ${beadsFailure('gate check', result)}; timer gates in ` +
          `this spoke will not resolve themselves (silent until it changes)`,
      );
    }
    return { ok: false };
  }
  if (pushStateSpokeDecision(state.gates, project.asset, null)) {
    emit('INFO', `push state: ${project.asset} — bd gate check works again`);
  }
  return { ok: true };
}
