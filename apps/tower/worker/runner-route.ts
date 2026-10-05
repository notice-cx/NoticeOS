// The Tower half of the local runner's private lane into the ingest Worker.
// See ../shared/runner-lane.ts for why the lane exists at all and what the three
// independent guards are; this file is only the "what does it do once it is
// allowed" half.
//
// Nothing here is reachable from a deployed Tower: worker/index.ts gates the
// whole branch on `__RUNNER_LANE__`, which vite.config.ts defines as `false` for
// a build, so the production bundle does not contain this code path.

import {
  RUNNER_DOOR_HEADER,
  RUNNER_DOOR_HEADER_VALUE,
  runnerTarget,
} from "../shared/runner-lane";
import { JSON_HEADERS, jsonError } from "./http";
import type { ScheduledRunResult, WorkflowStepRun } from '@noticeos/contract';

/**
 * One run of the job: the ingest's steps, then the Tower's (bead
 * `ro-ujb9.96.7.29`). A failed Tower step fails the run, in the words the
 * ingest uses for its own failed step; a tick with no Tower step is the
 * ingest's answer untouched.
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

/**
 * The slice of the INGEST Service Binding this lane uses. Structural on purpose
 * so the tests can hand in a stub — the binding itself is a Worker RPC stub, not
 * something a unit test can construct.
 */
export interface RunnerIngest {
  runScheduled(cron: string): Promise<void | ScheduledRunResult>;
  fetch(request: Request): Promise<Response>;
}

/**
 * Serve one runner request.
 *
 * The door header is checked FIRST and answers 403 rather than 404: a LAN client
 * that somehow reaches here has already been refused by the guard middleware, so
 * the only reader of this branch is an operator debugging a broken door, and
 * "this path is loopback-only" is the sentence that ends that debugging session.
 * Nothing is leaked by saying so — the LAN can already see the whole Tower.
 */
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
      // No scheduled job runs on this expression (bead ro-ujb9.217): nothing
      // ran, and the runner and `pnpm os:cron` report the refusal by its name.
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

  // Everything else is the ingest's own HTTP surface, proxied verbatim —
  // method, headers and body included, so the ingest's operator/asset bearer
  // checks still run exactly as they do today. The Tower adds no authority here.
  //
  // Rebuilt field by field rather than with `new Request(newUrl, request)`: that
  // idiom carries method and body in workerd but silently drops them under the
  // fetch implementation the unit tests run on, and a proxy whose correctness
  // can only be observed by starting the whole OS is a proxy nobody can check.
  // Bodies on this lane are small JSON payloads, so buffering costs nothing.
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
