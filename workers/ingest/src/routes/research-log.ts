// /api/research-log: GET answers "has this exact question been bought
// recently, and where is the answer"; POST records a purchase. A route because
// the callers that need it most are scripts and agent sessions that cannot
// reach the store. The GET decides nothing: it reports a prior purchase and
// its age, and the caller reuses or re-buys and says which.

import { assetKnown } from '../asset-registry.js';
import { authenticateOperator } from '../auth.js';
import { json } from '../responses.js';
import {
  RESEARCH_PROVIDERS,
  RESEARCH_REUSE_WINDOW_DAYS,
  findPriorResearch,
  recordResearch,
  type ResearchProvider,
} from '../research-log.js';

const QUESTION_MAX_CHARS = 500;
const ENDPOINT_MAX_CHARS = 200;
const ACTOR_MAX_CHARS = 80;

function isProvider(value: unknown): value is ResearchProvider {
  return (
    typeof value === 'string' &&
    (RESEARCH_PROVIDERS as readonly string[]).includes(value)
  );
}

/** Shared by both verbs: the three fields that identify a question. */
function readQuestionKey(
  source: { provider?: unknown; endpoint?: unknown; params?: unknown },
): { provider: ResearchProvider; endpoint: string; params: unknown } | string {
  if (!isProvider(source.provider)) {
    return `provider must be one of: ${RESEARCH_PROVIDERS.join(', ')}`;
  }
  if (
    typeof source.endpoint !== 'string' ||
    source.endpoint.length === 0 ||
    source.endpoint.length > ENDPOINT_MAX_CHARS
  ) {
    return `endpoint must be a provider path of 1-${ENDPOINT_MAX_CHARS} characters`;
  }
  if (source.params === undefined) {
    // Not defaulted to {}: two callers asking different questions would both
    // hash the empty object and collide, and the second would "reuse" an answer
    // to a question it never asked.
    return 'params is required — it is what makes this question distinct';
  }
  return {
    provider: source.provider,
    endpoint: source.endpoint,
    params: source.params,
  };
}

export async function handleResearchLogLookup(
  request: Request,
  env: IngestEnv,
  nowMs: number = Date.now(),
): Promise<Response> {
  if (!(await authenticateOperator(request, env.OPERATOR_TOKEN))) {
    return json({ error: 'unauthorized' }, 401);
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const key = readQuestionKey(body);
  if (typeof key === 'string') {
    return json({ error: 'invalid_request', detail: key }, 422);
  }
  const windowDays =
    typeof body.windowDays === 'number' &&
    Number.isFinite(body.windowDays) &&
    body.windowDays > 0
      ? body.windowDays
      : RESEARCH_REUSE_WINDOW_DAYS;

  const prior = await findPriorResearch(env.STORE, {
    ...key,
    nowMs,
    windowDays,
  });
  return json(
    {
      // `found` rather than `reuse`: the caller decides, this only reports.
      found: prior !== null,
      windowDays,
      prior,
    },
    200,
  );
}

export async function handleResearchLogRecord(
  request: Request,
  env: IngestEnv,
  nowMs: number = Date.now(),
): Promise<Response> {
  if (!(await authenticateOperator(request, env.OPERATOR_TOKEN))) {
    return json({ error: 'unauthorized' }, 401);
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const key = readQuestionKey(body);
  if (typeof key === 'string') {
    return json({ error: 'invalid_request', detail: key }, 422);
  }
  if (
    typeof body.question !== 'string' ||
    body.question.trim().length === 0 ||
    body.question.length > QUESTION_MAX_CHARS
  ) {
    return json(
      {
        error: 'invalid_request',
        detail: `question must be 1-${QUESTION_MAX_CHARS} characters of plain description`,
      },
      422,
    );
  }
  if (
    typeof body.actor !== 'string' ||
    body.actor.trim().length === 0 ||
    body.actor.length > ACTOR_MAX_CHARS
  ) {
    return json(
      {
        error: 'invalid_request',
        detail: 'actor must name who spent the money',
      },
      422,
    );
  }
  // The asset is optional and must be REAL when given: portfolio-level research
  // is a genuine case, but a typo'd property id would be a ghost in every
  // per-property read of this table.
  const asset = typeof body.asset === 'string' ? body.asset : null;
  if (asset !== null) {
    // An unknown asset is a clean error, not a raw FK failure.
    if (!(await assetKnown(env.STORE, asset))) {
      return json(
        { error: 'unknown_asset', detail: `no asset with id ${asset}` },
        422,
      );
    }
  }

  await recordResearch(
    env.STORE,
    {
      ...key,
      asset,
      question: body.question.trim(),
      costUsd: typeof body.costUsd === 'number' ? body.costUsd : 0,
      objectKey: typeof body.objectKey === 'string' ? body.objectKey : null,
      actor: body.actor.trim(),
    },
    nowMs,
  );
  return json({ recorded: true }, 201);
}
