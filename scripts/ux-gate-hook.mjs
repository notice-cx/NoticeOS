#!/usr/bin/env node
// THE UX GATE AT EDIT TIME (bead `ro-ujb9.94`).
//
// A Claude Code hook command. It reads the hook event JSON on stdin and exits 2
// with the reason on stderr when an agent must stop — Claude Code feeds that
// stderr straight back to the agent, so the agent meets the rule at the moment
// it writes the paragraph, not in a doc it may never open.
//
//   node scripts/ux-gate-hook.mjs post   PostToolUse  on Edit|Write|MultiEdit
//     The edited file is one the Tower renders (its own UI, or a module or
//     config document it imports) and now holds more explanatory prose than
//     apps/tower/ux-budget.json allows → exit 2 naming each string, its word
//     count and the redesign rule. Less prose than allowed → exit 0 with a
//     note (additionalContext) to lock the improvement in.
//
//   node scripts/ux-gate-hook.mjs pre    PreToolUse   on Edit|Write|MultiEdit|NotebookEdit|Bash
//     The target is a ratchet file itself — apps/tower/ux-budget.json, or the
//     flow gate's apps/tower/ux-flows.json (bead ro-ujb9.95) — or the text
//     gate's own rules, scripts/ux-gate.settings.json (bead ro-ujb9.96.3)
//     → exit 2: agents never edit them. `pnpm ux:baseline` and
//     `pnpm ux:flows:baseline` (which only lower) stay available through Bash.
//
// The hook finds the checkout from the EDITED FILE, not from its own location,
// so one registration in the main checkout also judges agents working in
// `.claude/worktrees/*` against their own branch's baseline. It fails open
// (exit 1, a warning the operator sees) if it cannot run at all: the
// pre-commit hook and CI still hold the line, and a crashing hook must not
// stop every edit in the repo.
//
// Wiring (the operator/orchestrator adds this to .claude/settings.json; see
// scripts/README.md "UX gate"):
//   PreToolUse  matcher "Edit|Write|MultiEdit|NotebookEdit|Bash"
//               command node "$CLAUDE_PROJECT_DIR"/scripts/ux-gate-hook.mjs pre
//   PostToolUse matcher "Edit|Write|MultiEdit"
//               command node "$CLAUDE_PROJECT_DIR"/scripts/ux-gate-hook.mjs post

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASELINE_FILE,
  GATE_BEAD,
  REPO_ROOT,
  compareToBaseline,
  composeFailure,
  emptyBaseline,
  formatDecreases,
  formatIncreases,
  headReader,
  introducedSince,
  invokedDirectly,
  isGateFile,
  isGateSource,
  isTowerUiFile,
  loadTypeScript,
  measure,
  readBaseline,
  readSettings,
  SETTINGS_FILE,
  workingTree,
} from './ux-gate.mjs';

/** The flow gate's record (bead ro-ujb9.95), guarded the same way. Named here
 * rather than imported so the hook stays independent of the flow gate. */
export const FLOW_BUDGET_FILE = 'apps/tower/ux-flows.json';

/** Files an agent may not write, repo-relative: the two ratchets, and the
 * text gate's own rules (budgets, scan directories, skipped files; bead
 * ro-ujb9.96.3). */
export const PROTECTED_FILES = [BASELINE_FILE, FLOW_BUDGET_FILE, SETTINGS_FILE];

/** Shell commands that can write a file they name: a redirect into it, `tee`,
 * in-place editors, file moves/copies/removal, and interpreters handed the
 * path. Reading it (`cat`, `git diff`, `git show`, `jq .`) and restoring it
 * from git stay allowed; `pnpm ux:baseline` never names it. */
export function shellWrites(command, file) {
  const name = path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const segment = `[^|;&]*${name}`;
  return [
    new RegExp(`(?:^|[^<>&0-9])>>?\\s*['"]?[^\\s'"|;&]*${name}`),
    new RegExp(`\\btee\\b${segment}`),
    new RegExp(`\\b(?:sed|perl|ruby)\\b[^|;&]*\\s-[a-zA-Z]*i${segment}`),
    new RegExp(`\\b(?:mv|cp|install|ln|rm|truncate|dd|rsync)\\b${segment}`),
    // An interpreter handed the path anywhere after it: `node -e "…; fs.writeFileSync('…')"`.
    new RegExp(`\\b(?:node|python3?|deno|bun|ruby|perl|php)\\b[\\s\\S]*${name}`),
  ].some((pattern) => pattern.test(command));
}

const toPosix = (value) => value.split(path.sep).join('/');

/** The checkout a file belongs to: the nearest ancestor holding the gate. */
export function findCheckoutRoot(filePath) {
  let dir = path.dirname(path.resolve(filePath));
  for (;;) {
    if (existsSync(path.join(dir, BASELINE_FILE)) || existsSync(path.join(dir, 'scripts', 'ux-gate.mjs'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function relativeTo(root, filePath) {
  return toPosix(path.relative(root, path.resolve(filePath)));
}

export const PROTECTED_MESSAGE = composeFailure([
  [
    `UX gate: you tried to edit ${BASELINE_FILE}, the ratchet that holds the Tower's legacy explanatory`,
    `prose (bead ${GATE_BEAD}). Agents never edit it. Removed prose? Run \`pnpm ux:baseline\` — it only ever lowers it.`,
  ].join('\n'),
]);

export const FLOW_PROTECTED_MESSAGE = [
  `UX flow gate: you tried to edit ${FLOW_BUDGET_FILE}, the ratchet that holds what each Tower flow costs`,
  '(bead ro-ujb9.95). Agents never edit it. Made a flow cheaper? Run `pnpm ux:flows:baseline` — it only ever',
  'lowers it. A flow over its budget is redesigned, not re-budgeted: add the control to the current step instead of a',
  'new step or screen, check once, show one status per subject, group lists by subject; if unsure, research the best',
  'modern comparable and record it in docs/briefs/<flow>.md#prior-art. Exceptions are the operator\'s alone.',
].join('\n');

export const PROTECTED_SETTINGS_MESSAGE = composeFailure([
  [
    `UX gate: you tried to edit ${SETTINGS_FILE}, the gate's own rules — its word budgets, the directories it`,
    'reads and the files it skips (bead ro-ujb9.96.3). Agents never edit it: a raised budget or a skipped file is an',
    'operator exception with the same four keys as a baseline raise, and every change to the file is audited.',
  ].join('\n'),
]);

/** The refusal for one protected file. */
const protectedMessage = (file) =>
  file === FLOW_BUDGET_FILE ? FLOW_PROTECTED_MESSAGE : file === SETTINGS_FILE ? PROTECTED_SETTINGS_MESSAGE : PROTECTED_MESSAGE;

/**
 * Decide one hook event. Returns `{ code, stderr?, stdout? }` — the process
 * wrapper below only prints and exits, so tests can call this directly.
 */
export function decide(mode, event) {
  const tool = event?.tool_name ?? '';
  const input = event?.tool_input ?? {};

  if (mode === 'pre') {
    if (tool === 'Bash') {
      const command = String(input.command ?? '');
      const written = PROTECTED_FILES.find((file) => shellWrites(command, file));
      if (written) return { code: 2, stderr: protectedMessage(written) };
      return { code: 0 };
    }
    const target = input.file_path ?? input.notebook_path;
    if (!target) return { code: 0 };
    const root = findCheckoutRoot(target);
    if (!root) return { code: 0 };
    const rel = relativeTo(root, target);
    if (PROTECTED_FILES.includes(rel)) return { code: 2, stderr: protectedMessage(rel) };
    return { code: 0 };
  }

  if (mode === 'post') {
    if (!['Edit', 'Write', 'MultiEdit'].includes(tool)) return { code: 0 };
    const target = input.file_path;
    if (!target) return { code: 0 };
    const root = findCheckoutRoot(target);
    if (!root) return { code: 0 };
    const rel = relativeTo(root, target);
    // A Tower file, or any module or config document the Tower imports
    // (scripts/config-registers.mts, packages/contract, config/*.json…).
    // Judged by the edited checkout's own rules, not this script's.
    const settings = readSettings(root);
    if (!isTowerUiFile(rel, settings) && !isGateSource(rel, settings)) return { code: 0 };
    if (!existsSync(path.join(root, BASELINE_FILE))) return { code: 0 }; // a branch from before the gate
    if (!isGateFile(rel, workingTree(root), settings)) return { code: 0 };

    const ts = loadTypeScript([root, REPO_ROOT]);
    const measured = measure([rel], { root, ts, settings });
    const baseline = readBaseline(root) ?? emptyBaseline();
    const { increases, decreases } = compareToBaseline(measured, baseline, { scope: [rel] });

    if (increases.length) {
      // Point at the strings THIS edit wrote where the event says what it
      // wrote; a whole-file Write marks what the file holds that HEAD does not.
      const written = tool === 'Edit'
        ? [input.new_string]
        : tool === 'MultiEdit'
          ? (input.edits ?? []).map((edit) => edit?.new_string)
          : [];
      const readHead = headReader(root);
      let introduced = readHead ? introducedSince(readHead, { ts }) : null;
      if (written.some(Boolean)) {
        const content = readFileSync(path.join(root, rel), 'utf8');
        const ranges = [];
        for (const text of written) {
          if (!text) continue;
          for (let at = content.indexOf(text); at !== -1; at = content.indexOf(text, at + 1)) {
            ranges.push([at, at + text.length]);
          }
        }
        introduced = (_file, offenders) =>
          offenders.filter((entry) => ranges.some(([start, end]) => entry.start < end && start < entry.end));
      }
      const stderr = composeFailure([
        formatIncreases(increases, { introduced }),
        'Undo or redesign this edit now: the pre-commit hook and CI (pnpm test:scripts) refuse it too.',
      ]);
      return { code: 2, stderr };
    }

    if (decreases.length) {
      const context = formatDecreases(decreases);
      return {
        code: 0,
        stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }),
      };
    }
    return { code: 0 };
  }

  return { code: 1, stderr: `ux-gate-hook: unknown mode "${mode}" (expected pre or post)` };
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

if (invokedDirectly(import.meta.url)) {
  const mode = process.argv[2];
  try {
    const raw = await readStdin();
    const event = raw.trim() ? JSON.parse(raw) : {};
    const { code, stderr, stdout } = decide(mode, event);
    if (stdout) process.stdout.write(`${stdout}\n`);
    if (stderr) process.stderr.write(`${stderr}\n`);
    process.exitCode = code;
  } catch (error) {
    process.stderr.write(`ux-gate-hook could not run (the pre-commit hook and CI still apply): ${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
