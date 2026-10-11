// The Tower half of the local runner's private lane into the ingest Worker; the
// guards are in ../shared/runner-lane.ts. A build defines `__RUNNER_LANE__` as
// `false`, so the production bundle does not contain this path.

import {
  RUNNER_DOOR_HEADER,
  RUNNER_DOOR_HEADER_VALUE,
  runnerTarget,
} from "../shared/runner-lane";
import { JSON_HEADERS, jsonError } from "./http";
import type { ScheduledRunResult, WorkflowStepRun } from '@noticeos/contract';

/**
 * One run of the job: the ingest's steps, then the Tower's. A failed Tower step
 * fails the run in the words the ingest uses for its own; a tick with no Tower
 * step is the ingest's answer untouched.
 */
export function withTowerSteps(
  result: void | ScheduledRunResult,
  towerSteps: WorkflowStepRun[],
): void | ScheduledRunResult {
  if (towerSteps.length === 0) return result;
  const ran = result ?? { outcome: "ran" as const, detail: "Execution completed" };
  const failed = towerSteps.some((step) => step.state === "failed");
  return {
    ...ran,
    ...(failed ? { outcome: "failed" as const, detail: "A workflow step failed. Check service logs for details." } : {}),
    steps: [...(ran.steps ?? []), ...towerSteps],
  };
}

/** Structural so a test can hand in a stub for the Worker RPC binding. */
export interface RunnerIngest {
  runScheduled(cron: string): Promise<void | ScheduledRunResult>;
  fetch(request: Request): Promise<Response>;
}

/** The door header is checked first and answers 403, not 404: only an operator
 * debugging a broken door reads this branch, and the LAN can already see the
 * whole Tower. */
export async function handleRunnerRequest(
  request: Request,
  url: URL,
  ingest: RunnerIngest,
  /** The Tower's own steps of a tick (tower-cron.ts), run after the ingest's. */
  towerCron: (cron: string) => Promise<WorkflowStepRun[]> = async () => [],
): Promise<Response> {
  if (request.headers.get(RUNNER_DOOR_HEADER) !== RUNNER_DOOR_HEADER_VALUE) {
    return jsonError("runner_lane_loopback_only", 403);
  }

  const target = runnerTarget(url.pathname);
  if (target === null) {
    return jsonError("not_found", 404);
  }

  if (target.kind === "scheduled") {
    // `?cron=` is the whole payload — the runner names an expression and the
    // ingest's dispatch table decides which lanes that means.
    const cron = url.searchParams.get("cron");
    if (cron === null || cron.trim() === "") {
      return jsonError("cron_required", 400);
    }
    try {
      const answer = await ingest.runScheduled(cron);
      // No scheduled job runs on this expression: nothing ran, and the runner
      // and `pnpm os:run-job` report the refusal by its name.
      if (answer?.refused) return jsonError(answer.refused, 400, { cron, message: answer.detail });
      const result = withTowerSteps(answer, await towerCron(cron));
      return new Response(JSON.stringify({ ok: true, cron, ...result }), {
        headers: JSON_HEADERS,
      });
    } catch (err) {
      // The runner logs this line verbatim, so it has to name the lane that
      // failed rather than a bare 500.
      const message = err instanceof Error ? err.message : String(err);
      return jsonError("scheduled_failed", 500, { cron, message });
    }
  }

  // Everything else is the ingest's own HTTP surface, proxied verbatim so its
  // bearer checks still run; the Tower adds no authority. Rebuilt field by
  // field: `new Request(newUrl, request)` drops method and body under the test
  // runtime's fetch. Bodies here are small JSON, so buffering costs nothing.
  const forwarded = new URL(url);
  forwarded.pathname = target.path;
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  try {
    return await ingest.fetch(
      new Request(forwarded.toString(), {
        method: request.method,
        headers: request.headers,
        body: hasBody ? await request.arrayBuffer() : undefined,
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonError("ingest_unreachable", 502, { message });
  }
}
