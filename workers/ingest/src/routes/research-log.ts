// /api/research-log — the ask-before-you-buy door, and the record-after-you-did.
//
// GET  answers "has this exact question been bought recently, and where is the
//      answer" for a caller about to spend provider money.
// POST records a purchase that was made.
//
// WHY A ROUTE AND NOT A LIBRARY. The callers that need this most are not
// Workers: the `dataforseo` skill's `.mjs` callers, scratchpad copies of them,
// and whatever an agent runs in a session. None of them can reach D1 — the
// central store lives behind this Worker — which is exactly why their spend went
// unrecorded in the first place. Giving them a library would have left the same
// hole for anything written next week in another language.
//
// The GET decides nothing. It reports a prior purchase and its age; the caller
// reuses or re-buys and says which. A route that answered "don't buy this" would
// be making a spending decision from behind a cache, and a caller silently
// skipping a call is indistinguishable from one that forgot to make it.

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
    // The site list is on Postgres (bead ro-ujb9.76.4.2).
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
