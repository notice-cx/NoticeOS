# The local runner, split into modules (2026-09-24, bead `ro-ujb9.22`)

**What changes:** `scripts/os-up.mjs` keeps its job as the one coordinator.
It starts the Tower's dev server, supervises it, wires the lanes into the
scheduler and shuts everything down. Every other responsibility moves into its
own module under `scripts/runner/`, with its own test file.

**What does not change:** `pnpm os:up`, `os:cron`, `os:backup` and every
`os:*` command behave the same. The launchd plist, the runtime-copy layout, the
log lines, the bead text the runner files and every lane's schedule stay as
they were. `scripts/os-up.test.mjs` is not edited and keeps passing, because
`os-up.mjs` re-exports every name it exported before.

## The map at the baseline (`d2914a89`, 5,072 lines)

Line ranges are in `scripts/os-up.mjs` at `d2914a89`. "Tests" are the existing
tests that cover the range. Every `os-up.test.mjs` range is the section of that
file that imports the names from `os-up.mjs`.

| Lines | Responsibility | Target | Tests at baseline |
|---|---|---|---|
| 1–47 | What the runner does, in prose | stays | — |
| 48–136 | Imports; re-exports of `job-runs.mjs` names | stays (shrinks) | every importer below |
| 138–191, 307–322 | Where the code and the state are (`REPO_ROOT`, `HOME_ROOT`, `runnerPaths`, `osCheckoutName`) | `runner/config.mjs` | `os-up.test.mjs` 3197–3211 (checkout name); `os-deploy.test.mjs` (`runnerPaths`) |
| 193–291 | `CONFIG`: the port map, the host lanes' crons, supervision limits | `runner/config.mjs` | `os-up.test.mjs` 304–325, 1117–1246; `scheduled-jobs.test.mjs`; `start.test.mjs` |
| 293–305 | Startup catch-up policies (`STARTUP_CATCHUP_POLICIES`) | `runner/scheduler.mjs` | `os-up.test.mjs` 326–467; `scheduled-jobs.test.mjs` |
| 324–336, 568–586, 1502–1515, 3477–3479, 1040–1044 | Finding `bd`, `git`, `lsof` on launchd's bare PATH; the TCP probe | `runner/host-tools.mjs` | `os-up.test.mjs` 1231–1245, 1247–1263 |
| 338–456 | The combined, redacted, rotated log | `runner/log.mjs` | `os-up.test.mjs` 159–173 |
| 458–485, 515–522 | The runner's heartbeat file and the commit it runs | stays (root) | `os-up.test.mjs` 5098–5107 (reads the source) |
| 487–513 | A runtime copy refuses to start unlinked or on an empty store | `runner/lifecycle.mjs` | `os-up.test.mjs` 5057–5096 |
| 524–535 | Reading the ingest's crons from `wrangler.jsonc` | `runner/scheduler.mjs` | `os-up.test.mjs` 326–467 |
| 537–548 | Shutdown flag; catch-up ownership; timer registry | `runner/lifecycle.mjs` (flag), `runner/scheduler.mjs` (the rest) | through every lane test's `stopped` |
| 550–566, 588–716 | Supervising the one child (spawn, ready banner, backoff, group kill) | stays (root) | `os-control.test.mjs` "the stop wait outlasts…" (reads the source) |
| 718–842, 986–1010 | The job-run record and shipping it to the store | `runner/job-record.mjs` | `os-up.test.mjs` 469–922; `host-backup.test.mjs` |
| 844–984 | Startup notes: which credentials and which config this install reads | `runner/startup-report.mjs` | `os-up.test.mjs` 4622–4778 |
| 1012–1264 | Door ownership: may this tick fire at the ingest door? | `runner/door-ownership.mjs` | `os-up.test.mjs` 923–1116 |
| 1266–1474 | The scheduler and the bounded startup catch-up | `runner/scheduler.mjs` | `os-up.test.mjs` 326–467 |
| 1476–1489 | The backup lane (the operation itself is `host-backup.mjs`) | stays (root wiring) | `host-backup.test.mjs` |
| 1517–1668, 2094–2155, 2236–2244, 2302–2306, 2648–2656, 2791–2803, 3234–3245 | The task hub: its health line, `runBd`, the project map, shared `bd` output readers | `runner/task-hub.mjs` | `os-up.test.mjs` 1117–1383; `task-project-config.test.mjs` |
| 1670–1882, 2978–3408 | Panel-review vocabulary and the filer that writes review beads | `runner/panel-review.mjs` | `os-up.test.mjs` 2506–2711, 3046–3586 |
| 1884–2093, 2157–2645, 2779–2912 | The task-board snapshot poller, with the handoff join | `runner/task-snapshot.mjs` | `os-up.test.mjs` 1384–2505, 2712–3045; `task-project-config.test.mjs`; `handoff-kinds.test.mjs`; `start-schedule.test.mjs` |
| 2658–2777 | Carrying closed bets' verdicts to their beads | `runner/watch-readbacks.mjs` | `os-up.test.mjs` 4498–4621; `task-project-config.test.mjs` |
| 2783–2789 | The operator bearer, re-read every tick | `runner/operator-token.mjs` | none (every lane test injects `readToken`) |
| 2914–2936 | The first task-board snapshot after a restart | `runner/scheduler.mjs` | — |
| 2938–2976 | Forwarding `os:deploy` records to the store | stays (root wiring of `os-deploy-forward.mjs`) | `os-deploy-forward.test.mjs` |
| 3410–4167 | The push-state filer and the spokes' gate checks | `runner/push-state.mjs` | `os-up.test.mjs` 3673–4449 |
| 4169–4551 | The task-map lane | `runner/task-map.mjs` | `os-up.test.mjs` 4779–5056 |
| 4553–4644 | The panel refresh child | `runner/panel-refresh.mjs` | `os-up.test.mjs` 3587–3672 |
| 4646–4808 | One runner at a time; managed-orphan recovery; the door address the child is told | `runner/lifecycle.mjs` | `os-up.test.mjs` 199–325; `no-second-runtime.test.mjs` |
| 4810–4849 | `os:cron` (one tick) | stays (root) | `os-up.test.mjs` 5108–5135 |
| 4851–5072 | `supervise`, `main`, the `--local`/`--host` choice | stays (root) | `os-up.test.mjs` 153–197, 5098–5107 |

## The seams

- **Configuration and state flow one way.** `runner/config.mjs` knows where
  the code and state are and holds `CONFIG`. `runner/log.mjs` writes the log.
  Every other module imports those two. No module imports `os-up.mjs`.
- **Every world-touching dependency stays a parameter.** Each lane already takes
  its `bd`, `git`, `fetch`, clock, state and log as `deps`, with the runner's
  own as defaults. The defaults now come from the foundation modules instead of
  the file's top level, so a lane module runs alone, with no runner around it.
- **The scheduler does not know the lanes.** `os-up.mjs` hands it a table of
  lane bodies and outcome readers. The scheduler owns timing, holding a lane
  during startup catch-up, and the first snapshot after a restart.
- **One child-process helper.** Moved code keeps calling
  `scripts/run-command.mjs`. The supervised Tower child and the one
  `git rev-parse` at startup stay in `os-up.mjs`, so no runner module imports
  `node:child_process`. `scripts/runner-modules.test.mjs` checks this.

## What stays in `os-up.mjs`, and why

- **The heartbeat (`runnerState`)**, because `os:status` and `os:deploy` read
  what it writes, and `os-up.test.mjs` pins its fields in this file's source.
- **Supervising the Tower child**, because the coordinator is the supervisor.
  `os-control.test.mjs` also reads this file for the two shutdown waits that
  `os:stop`'s budget is measured against.
- **The lane table, the backup lane and deploy forwarding**: the wiring of
  lane modules and host adapters into the scheduler.
- **`os:cron`, `supervise` and `main`**: the modes.

## Where each module's tests are

Module tests are `scripts/runner-<module>.test.mjs`, beside the other root
tests. `pnpm test:scripts` runs `scripts/*.test.mjs` only, and two tests pin
that command, so a test inside `scripts/runner/` would never run in CI.

## The result

`scripts/os-up.mjs` is 815 lines: 231 of imports and the re-exports its
importers use, then the heartbeat, the Tower child's supervision, the lane
table, the backup lane, deploy forwarding and the modes. It exports the same
169 names as before, plus `hostLanes`.

| Module | Lines | Test |
|---|---:|---|
| `runner/config.mjs` | 184 | `runner-config.test.mjs` |
| `runner/log.mjs` | 122 | `runner-log.test.mjs` |
| `runner/host-tools.mjs` | 67 | `runner-host-tools.test.mjs` |
| `runner/operator-token.mjs` | 14 | `runner-operator-token.test.mjs` |
| `runner/door-ownership.mjs` | 257 | `runner-door-ownership.test.mjs` |
| `runner/lifecycle.mjs` | 218 | `runner-lifecycle.test.mjs` |
| `runner/job-record.mjs` | 169 | `runner-job-record.test.mjs` |
| `runner/startup-report.mjs` | 150 | `runner-startup-report.test.mjs` |
| `runner/task-hub.mjs` | 286 | `runner-task-hub.test.mjs` |
| `runner/panel-review.mjs` | 655 | `runner-panel-review.test.mjs` |
| `runner/task-snapshot.mjs` | 817 | `runner-task-snapshot.test.mjs` |
| `runner/watch-readbacks.mjs` | 131 | `runner-watch-readbacks.test.mjs` |
| `runner/push-state.mjs` | 780 | `runner-push-state.test.mjs` |
| `runner/task-map.mjs` | 406 | `runner-task-map.test.mjs` |
| `runner/panel-refresh.mjs` | 102 | `runner-panel-refresh.test.mjs` |
| `runner/scheduler.mjs` | 307 | `runner-scheduler.test.mjs` |

`scripts/runner-modules.test.mjs` holds every module to the seams above, and
`scripts/no-second-runtime.test.mjs` now sweeps `scripts/runner/` too.

Two code changes are not moves. The shutdown flag became `isShuttingDown()` and
`beginShutdown()` in `runner/lifecycle.mjs`, read everywhere the flag was read.
The scheduler takes the lane table instead of naming each lane, and pays the
four host catch-ups through it. Apart from imports, `REPO_ROOT`'s path from
its new folder and three comments that named a section's place in the old
file, every moved line is the same text.
