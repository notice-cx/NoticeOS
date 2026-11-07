import { PORTFOLIO_BRIEF_MAX_BYTES, portfolioBriefEvidenceSchema, type PortfolioBriefEvidence } from '@noticeos/contract/portfolio-brief';
import { portfolioBriefPrompt } from '../src/portfolio-brief-prompt.js';
import { MODEL_GENERATION_TIMEOUT_MS } from '../../../scripts/portfolio-brief-failure.mjs';
import { captureWorkflowDiagnostic } from '../../../scripts/workflow-diagnostics.mjs';
import { DEFAULT_LOCAL_MODEL_OUTPUT_TOKENS, LOCAL_MODEL_OUTPUT_TOKENS } from '@noticeos/contract/local-model-settings';
import { env } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { connectCredential } from '../src/credential-connect.js';
import { putCredential, resolveCredential, credentialSummary, validateCredentialFields } from '../src/credentials.js';
import { integrationProvider } from '@noticeos/contract';
import { probeCredential } from '../src/credential-probes.js';
import { checkLocalModel, discoverLocalModels, generateLocalModel, localModelBaseUrl, localModelFailure, LocalModelError } from '../src/local-model.js';

const fields = { LOCAL_MODEL_BASE_URL: 'http://127.0.0.1:1234/v1', LOCAL_MODEL_ID: 'synthetic-model' };
const options = { messages: [{ role: 'user' as const, content: 'Summarize synthetic evidence.' }] };
const standalone = { NOTICEOS_WORKSPACE_PROFILE: 'standalone' };
const completion = (content = 'Synthetic result', finish_reason = 'stop') => Response.json({ choices: [{ message: { content }, finish_reason }] });

it('captures the exact generation body and raw response without transport credentials or addresses', async () => {
  const onDiagnostics = vi.fn();
  let sent = '';
  const raw = JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Final answer', reasoning_content: 'Separate reasoning' } }] });
  const fetchImpl: typeof fetch = async (_input, init) => { sent = String(init?.body); return new Response(raw); };
  expect(await generateLocalModel(standalone, { ...fields, LOCAL_MODEL_API_TOKEN: 'private-token' }, { ...options, fetchImpl, onDiagnostics })).toBe('Final answer');
  expect(onDiagnostics.mock.calls).toEqual([['input', sent], ['output', { status: 200, body: raw, truncated: false }]]);
  expect(JSON.stringify(onDiagnostics.mock.calls)).not.toContain('private-token');
  expect(JSON.stringify(onDiagnostics.mock.calls)).not.toContain(fields.LOCAL_MODEL_BASE_URL);
});

it.each([
  ['malformed', 'not JSON', 200, 'invalid-output'],
  ['empty', JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }), 200, 'empty-output'],
  ['truncated', JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: 'Partial answer' } }] }), 200, 'truncated-output'],
  ['HTTP error', 'Actual provider error body', 400, 'network'],
] as const)('captures %s output before rejecting it', async (_name, raw, status, code) => {
  const onDiagnostics = vi.fn();
  await expect(generateLocalModel(standalone, fields, { ...options, onDiagnostics, fetchImpl: async () => new Response(raw, { status }) }))
    .rejects.toMatchObject({ code });
  expect(onDiagnostics.mock.calls).toContainEqual(['output', { status, body: raw, truncated: false }]);
});

it('clips diagnostic bodies by bytes and keeps an oversized HTTP error classified by its status', async () => {
  const onDiagnostics = vi.fn();
  await expect(generateLocalModel(standalone, fields, { ...options, onDiagnostics,
    fetchImpl: async () => new Response('é'.repeat(40_000), { status: 401 }) })).rejects.toMatchObject({ code: 'access', status: 401 });
  expect(onDiagnostics.mock.calls).toContainEqual(['output', { status: 401, body: 'é'.repeat(32_768), truncated: true }]);
});

it('retains the response byte limit while capturing only a bounded preview', async () => {
  const onDiagnostics = vi.fn();
  await expect(generateLocalModel(standalone, fields, { ...options, onDiagnostics,
    fetchImpl: async () => new Response('x'.repeat(1_048_577)) })).rejects.toMatchObject({ code: 'too-large' });
  expect(onDiagnostics.mock.calls).toContainEqual(['output', { status: 200, body: 'x'.repeat(65_536), truncated: true }]);
});

it('does not let diagnostic callback exceptions change successful or failed verdicts', async () => {
  const onDiagnostics = () => { throw new Error('Private diagnostic failure'); };
  await expect(generateLocalModel(standalone, fields, { ...options, onDiagnostics, fetchImpl: async () => completion() })).resolves.toBe('Synthetic result');
  await expect(generateLocalModel(standalone, fields, { ...options, onDiagnostics, fetchImpl: async () => new Response('bad', { status: 429 }) }))
    .rejects.toMatchObject({ code: 'rate-limit', status: 429 });
});

it('captures the original transport exception before replacing its public error message', async () => {
  const onDiagnostics = vi.fn();
  const error = new TypeError('Actual transport failure', { cause: new Error('Actual connection detail') });
  await expect(generateLocalModel(standalone, fields, { ...options, onDiagnostics, fetchImpl: async () => { throw error; } }))
    .rejects.toMatchObject({ code: 'network', message: expect.not.stringContaining(error.message) });
  expect(onDiagnostics).toHaveBeenLastCalledWith('error', { name: 'TypeError', message: 'Actual transport failure',
    cause: { name: 'Error', message: 'Actual connection detail' } });
});

it('does not clip transport exception text before the credential-aware diagnostic capture can redact it', async () => {
  const secret = 'synthetic-boundary-private-token';
  const message = `${'x'.repeat(7988)}${secret} actual failure`;
  const captured: { raw?: unknown; text?: string } = {};
  await expect(generateLocalModel(standalone, fields, { ...options,
    fetchImpl: async () => { throw new Error(message); },
    onDiagnostics: (phase, value) => {
      if (phase !== 'error') return;
      captured.raw = value;
      captured.text = captureWorkflowDiagnostic(value, { secrets: [secret], maxBytes: 16_384 }).text;
    },
  })).rejects.toMatchObject({ code: 'network' });
  expect(captured.raw).toMatchObject({ message });
  expect(captured.text).not.toContain('synthetic-boundary');
  expect(captured.text).toContain('[REDACTED] actual failure');
});

it('uses fixed paths, omits absent auth, requests plain text and returns only final content', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    expect(String(input)).toBe('http://127.0.0.1:1234/v1/chat/completions');
    expect(init?.redirect).toBe('manual');
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: fields.LOCAL_MODEL_ID, stream: false, max_tokens: DEFAULT_LOCAL_MODEL_OUTPUT_TOKENS });
    expect(JSON.parse(String(init?.body))).not.toHaveProperty('temperature');
    expect(JSON.parse(String(init?.body))).not.toHaveProperty('response_format');
    return completion();
  });
  expect(await generateLocalModel(standalone, fields, { ...options, fetchImpl })).toBe('Synthetic result');
});

it.each([['', 8192], ['   ', 8192], ['1024', 1024], ['16384', 16384], ['32768', 32768]] as const)('sends the configured whole-number output budget %j', async (value, expected) => {
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    expect(JSON.parse(String(init?.body)).max_tokens).toBe(expected);
    expect(JSON.parse(String(init?.body))).not.toHaveProperty('temperature');
    return completion();
  });
  expect(validateCredentialFields(integrationProvider('local-model')!, { ...fields, [LOCAL_MODEL_OUTPUT_TOKENS]: value })).toEqual([]);
  await expect(generateLocalModel(standalone, { ...fields, [LOCAL_MODEL_OUTPUT_TOKENS]: value }, { ...options, fetchImpl })).resolves.toBe('Synthetic result');
});

it.each(['1023', '32769', '-8192', '+8192', '8192.0', '8e3', 'NaN', 'Infinity', '8192 tokens'])('rejects invalid output budgets before any model request: %j', async value => {
  const fetchImpl = vi.fn<typeof fetch>();
  expect(validateCredentialFields(integrationProvider('local-model')!, { ...fields, [LOCAL_MODEL_OUTPUT_TOKENS]: value })).toEqual(expect.arrayContaining([expect.objectContaining({ path: LOCAL_MODEL_OUTPUT_TOKENS })]));
  await expect(generateLocalModel(standalone, { ...fields, [LOCAL_MODEL_OUTPUT_TOKENS]: value }, { ...options, fetchImpl })).rejects.toMatchObject({ code: 'configuration' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('distinguishes a token budget exhausted entirely by reasoning from a truncated final answer', async () => {
  const raw = { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '',
    reasoning_content: 'The reasoning continued until the completion budget was exhausted.' } }],
    usage: { prompt_tokens: 1740, completion_tokens: 4096, total_tokens: 5836, completion_tokens_details: { reasoning_tokens: 4096 } } };
  const onDiagnostics = vi.fn();
  await expect(generateLocalModel(standalone, fields, { ...options, onDiagnostics, fetchImpl: async () => Response.json(raw) })).rejects.toMatchObject({ code: 'reasoning-limit' });
  expect(onDiagnostics.mock.calls).toContainEqual(['output', { status: 200, body: JSON.stringify(raw), truncated: false }]);
  expect(localModelFailure(new LocalModelError('reasoning-limit'))).toEqual({ kind: 'invalid-response' });
  await expect(generateLocalModel(standalone, fields, { ...options, fetchImpl: async () => completion('Partial final answer', 'length') })).rejects.toMatchObject({ code: 'truncated-output' });
});

it('discovers the exact configured model with bearer auth without generating', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    expect(String(input)).toBe('http://127.0.0.1:1234/v1/models');
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-token');
    return Response.json({ data: [{ id: fields.LOCAL_MODEL_ID }] });
  });
  await checkLocalModel(standalone, { ...fields, LOCAL_MODEL_API_TOKEN: 'synthetic-token' }, fetchImpl);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  await expect(checkLocalModel(standalone, fields, async () => Response.json({ data: [{ id: 'other-model' }] }))).rejects.toMatchObject({ code: 'model-missing' });
});

it.each([' synthetic-model', 'synthetic-model '])('refuses a connection whose model ID differs from the server: %j', async modelId => {
  const selected = { ...env, NOTICEOS_WORKSPACE_PROFILE: 'standalone' };
  const previous = await resolveCredential(selected, 'local-model');
  expect(await connectCredential(selected, { provider: 'local-model', fields: { ...fields, LOCAL_MODEL_ID: modelId } }, {
    fetchImpl: async () => Response.json({ data: [{ id: fields.LOCAL_MODEL_ID }] }),
  })).toMatchObject({ ok: true, verdict: 'refused', failure: { kind: 'model-missing' } });
  expect(await resolveCredential(selected, 'local-model')).toMatchObject({ source: previous.source, fields: previous.fields });
});

it('preserves opaque model IDs through discovery, connection storage and generation', async () => {
  const modelId = ' synthetic-model ';
  const inventory = async () => Response.json({ data: [{ id: modelId }, { id: fields.LOCAL_MODEL_ID }] });
  expect(await discoverLocalModels(standalone, { fields: { LOCAL_MODEL_BASE_URL: fields.LOCAL_MODEL_BASE_URL } }, inventory))
    .toEqual({ ok: true, models: [modelId, fields.LOCAL_MODEL_ID] });
  const selected = { ...env, NOTICEOS_WORKSPACE_PROFILE: 'standalone' };
  expect(await connectCredential(selected, { provider: 'local-model', fields: { ...fields, LOCAL_MODEL_ID: modelId } }, {
    fetchImpl: inventory,
  })).toMatchObject({ ok: true, verdict: 'accepted' });
  const saved = await resolveCredential(selected, 'local-model');
  expect(saved.fields?.LOCAL_MODEL_ID).toBe(modelId);
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    expect(JSON.parse(String(init?.body)).model).toBe(modelId);
    return completion();
  });
  await generateLocalModel(standalone, saved.fields!, { ...options, fetchImpl });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it.each([[undefined], [null], [[]]])('accepts final content when the server reports no tool calls (%j)', async tool_calls => {
  const fetchImpl = async () => Response.json({ choices: [{ finish_reason: 'stop', message: {
    content: 'Synthetic result', reasoning_content: 'Separate reasoning is not the final answer.', tool_calls,
  } }] });
  expect(await generateLocalModel(standalone, fields, { ...options, fetchImpl })).toBe('Synthetic result');
});

it.each([[[{ type: 'function', function: { name: 'act', arguments: '{}' } }]], [{}], [false], ['']])('rejects nonempty or malformed tool calls (%j)', async tool_calls => {
  const fetchImpl = async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Synthetic result', tool_calls } }] });
  await expect(generateLocalModel(standalone, fields, { ...options, fetchImpl })).rejects.toMatchObject({ code: 'invalid-output' });
});

it.each(['hosted', 'demo'])('blocks %s credential mutation, discovery, probe and inference before fetch', async profile => {
  const selected = { ...env, NOTICEOS_WORKSPACE_PROFILE: profile };
  const fetchImpl = vi.fn<typeof fetch>();
  expect(await putCredential(selected, { provider: 'local-model', fields })).toMatchObject({ ok: false, error: 'validation' });
  expect(await connectCredential(selected, { provider: 'local-model', fields }, { fetchImpl })).toMatchObject({ ok: false, error: 'not_supported' });
  expect(await probeCredential(selected, 'local-model', { fetchImpl })).toMatchObject({ ok: false, result: { outcome: 'not-checked' } });
  expect(await discoverLocalModels(selected, { fields: { LOCAL_MODEL_BASE_URL: fields.LOCAL_MODEL_BASE_URL } }, fetchImpl)).toEqual({ ok: false, failure: { kind: 'not-supported' } });
  await expect(checkLocalModel(selected, fields, fetchImpl)).rejects.toMatchObject({ code: 'unavailable' });
  await expect(generateLocalModel(selected, fields, { ...options, fetchImpl })).rejects.toMatchObject({ code: 'unavailable' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it.each(['http://user:password@example.test/v1', 'http://example.test/v1?token=secret', 'http://example.test/v1#secret', 'file:///v1', 'http://example.test/'])('rejects unsafe or ambiguous base URL %s', value => {
  expect(() => localModelBaseUrl(value)).toThrow();
  expect(validateCredentialFields(integrationProvider('local-model')!, { ...fields, LOCAL_MODEL_BASE_URL: value })).not.toEqual([]);
});

it.each(['A useful plain-language briefing.', '## Revenue\n\nReview acquisition costs.', '```text\nA final answer.\n```'])('accepts final prose without requiring model-written JSON', async content => {
  await expect(generateLocalModel(standalone, fields, { ...options, fetchImpl: async () => completion(content) })).resolves.toBe(content);
});

it.each(['', '   ', '\n\t'])('categorizes blank final content as empty output', async content => {
  await expect(generateLocalModel(standalone, fields, { ...options, fetchImpl: async () => completion(content) })).rejects.toMatchObject({ code: 'empty-output' });
});

it('does not substitute reasoning for an absent final answer', async () => {
  await expect(generateLocalModel(standalone, fields, { ...options, fetchImpl: async () => Response.json({ choices: [
    { finish_reason: 'stop', message: { content: null, reasoning_content: 'Private reasoning is not a final answer.' } },
  ] }) })).rejects.toMatchObject({ code: 'empty-output' });
});

it.each([
  { choices: [] }, { choices: [{}, {}] }, { choices: [{ finish_reason: 'stop' }] },
  { choices: [{ finish_reason: 'stop', message: { content: ['text'] } }] },
  { choices: [{ finish_reason: 'tool_calls', message: { content: 'Not final.' } }] },
  { choices: [{ finish_reason: 'stop', message: { content: 'Not final.', function_call: { name: 'act', arguments: '{}' } } }] },
])('rejects malformed or nonfinal chat envelopes', async envelope => {
  await expect(generateLocalModel(standalone, fields, { ...options, fetchImpl: async () => Response.json(envelope) })).rejects.toMatchObject({ code: 'invalid-output' });
});

it.each([
  { finish_reason: 'content_filter', message: { content: '' } },
  { finish_reason: 'stop', message: { content: 'Answer', refusal: 'Private refusal context' } },
])('categorizes refusals without returning their content', async choice => {
  const pending = generateLocalModel(standalone, fields, { ...options, fetchImpl: async () => Response.json({ choices: [choice] }) });
  await expect(pending).rejects.toMatchObject({ code: 'refused-output', message: expect.not.stringContaining('Private refusal context') });
});

it.each(['empty-output', 'truncated-output', 'refused-output'] as const)('maps %s to the generic invalid response category', code => {
  expect(localModelFailure(new LocalModelError(code))).toEqual({ kind: 'invalid-response' });
});

it('rejects truncated responses, excessive bodies and already cancelled work', async () => {
  await expect(generateLocalModel(standalone, fields, { ...options, fetchImpl: async () => completion('Partial final answer', 'length') })).rejects.toMatchObject({ code: 'truncated-output' });
  await expect(generateLocalModel(standalone, fields, { ...options, fetchImpl: async () => new Response('x'.repeat(1_048_577)) })).rejects.toMatchObject({ code: 'too-large' });
  const controller = new AbortController(); controller.abort();
  const fetchImpl = vi.fn<typeof fetch>();
  await expect(generateLocalModel(standalone, fields, { ...options, fetchImpl, signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('sanitizes transport and provider failures', async () => {
  await expect(checkLocalModel(standalone, fields, async () => { throw new Error('private endpoint and token'); }))
    .rejects.toMatchObject({ code: 'network', message: expect.not.stringContaining('private endpoint and token') });
  await expect(checkLocalModel(standalone, fields, async () => new Response('private provider message', { status: 401 })))
    .rejects.toMatchObject({ code: 'access', message: expect.not.stringContaining('private provider message') });
});


it.each([fields.LOCAL_MODEL_BASE_URL, 'https://models.example.com/custom/api'])('stores a standalone connection at %s only after discovery and keeps the token out of summaries', async baseUrl => {
  const selected = { ...env, NOTICEOS_WORKSPACE_PROFILE: 'standalone' };
  const candidate = { ...fields, LOCAL_MODEL_BASE_URL: baseUrl, LOCAL_MODEL_API_TOKEN: 'synthetic-private-model-token' };
  const previous = await resolveCredential(selected, 'local-model');
  const refused = await connectCredential(selected, { provider: 'local-model', fields: candidate }, {
    fetchImpl: async () => Response.json({ data: [] }),
  });
  expect(refused).toMatchObject({ ok: true, verdict: 'refused' });
  expect(await resolveCredential(selected, 'local-model')).toMatchObject({ source: previous.source, fields: previous.fields });
  const accepted = await connectCredential(selected, { provider: 'local-model', fields: candidate }, {
    fetchImpl: async () => Response.json({ data: [{ id: fields.LOCAL_MODEL_ID }] }),
  });
  expect(accepted).toMatchObject({ ok: true, verdict: 'accepted' });
  expect((await resolveCredential(selected, 'local-model')).fields).toEqual(candidate);
  expect(JSON.stringify(await credentialSummary(selected, 'local-model'))).not.toContain(candidate.LOCAL_MODEL_API_TOKEN);
});

it('allows successful slow local generation beyond the former two-minute deadline', async () => {
  vi.useFakeTimers();
  try {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Promise(resolve => setTimeout(() => resolve(completion()), 180_000)));
    const pending = generateLocalModel(standalone, fields, { ...options, fetchImpl });
    await vi.advanceTimersByTimeAsync(180_000);
    await expect(pending).resolves.toBe('Synthetic result');
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  } finally { vi.useRealTimers(); }
});

it('times out generation and aborts the underlying request', async () => {
  vi.useFakeTimers();
  try {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('private transport context')), { once: true });
    }));
    const pending = generateLocalModel(standalone, fields, { ...options, fetchImpl });
    const verdict = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(MODEL_GENERATION_TIMEOUT_MS - 1);
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await verdict;
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  } finally { vi.useRealTimers(); }
});

it.each(['http://127.0.0.1:1234/v1', 'http://127.1/v1', 'http://10.1.2.3/v1', 'https://172.16.0.1/v1',
  'http://172.31.255.255/v1', 'http://192.168.2.1:1234/v1', 'http://localhost:1234/v1', 'http://model.localhost/v1',
  'http://host.docker.internal:1234/v1', 'http://[::1]:1234/v1', 'http://[fc00::1]/v1', 'http://[fdff::1]/v1',
  'http://[fe80::1]/v1', 'http://[febf::1]/v1'])('permits local endpoint %s', value => {
  expect(localModelBaseUrl(value).pathname).toBe('/v1/');
});

it.each(['http://8.8.8.8/v1', 'http://model/v1', 'http://model.local/v1',
  'http://169.254.169.254/v1', 'http://172.15.255.255/v1', 'http://172.32.0.0/v1', 'http://192.169.0.1/v1',
  'http://localhost.example.com/v1', 'http://host.docker.internal.example.com/v1', 'http://0.0.0.0/v1',
  'http://[2001:4860:4860::8888]/v1', 'http://[::ffff:8.8.8.8]/v1', 'http://[fc::1]/v1', 'http://[fec0::1]/v1'])('blocks nonlocal endpoint %s before fetch', async value => {
  const fetchImpl = vi.fn<typeof fetch>();
  await expect(checkLocalModel(standalone, { ...fields, LOCAL_MODEL_BASE_URL: value }, fetchImpl)).rejects.toMatchObject({ code: 'configuration' });
  expect(fetchImpl).not.toHaveBeenCalled();
});


it.each([1, 260])('accepts maximal escaped evidence with %s facts in the real briefing request', async factCount => {
  const packet: PortfolioBriefEvidence = {
    schemaVersion: 1, asOf: '2026-11-06T12:00:00.000Z', timeZone: 'UTC',
    facts: Array.from({ length: factCount }, (_, index) => {
      const current = new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10);
      const previous = new Date(Date.UTC(2023, 0, index + 1)).toISOString().slice(0, 10);
      return { id: `comparison:${index}`, label: 'Synthetic comparison', href: '/assets', observedAt: null, period: null,
        comparison: { current: { start: current, end: current }, previous: { start: previous, end: previous }, timeZone: 'UTC' },
        data: { text: '' } };
    }),
    insightEvidenceIds: Array.from({ length: factCount }, (_, index) => `comparison:${index}`), limitations: [],
    coverage: { assets: 1, includedAssets: 1, projects: 0, readableProjects: 0, omittedAlerts: 0, omittedTasks: 0 },
  };
  const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
  const available = PORTFOLIO_BRIEF_MAX_BYTES - bytes(JSON.stringify(packet));
  const data = packet.facts[0]!.data;
  data.text = String.fromCharCode(34, 92).repeat(Math.floor(available / 4));
  data.text += 'a'.repeat(PORTFOLIO_BRIEF_MAX_BYTES - bytes(JSON.stringify(packet)));
  const evidenceJson = JSON.stringify(packet);
  expect(bytes(evidenceJson)).toBe(PORTFOLIO_BRIEF_MAX_BYTES);
  expect(portfolioBriefEvidenceSchema.safeParse(packet).success).toBe(true);
  const prompt = portfolioBriefPrompt();
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    const body = String(init?.body);
    expect(bytes(body)).toBeGreaterThan(131_072);
    const sent = JSON.parse(body) as { messages: { content: string }[] };
    expect(sent.messages.map(message => message.content)).toEqual([prompt, evidenceJson]);
    expect(sent).not.toHaveProperty('response_format');
    return completion('No additional conclusion is supported.');
  });
  expect(await generateLocalModel(standalone, fields, {
    messages: [{ role: 'system', content: prompt }, { role: 'user', content: evidenceJson }],
    fetchImpl,
  })).toBe('No additional conclusion is supported.');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('still rejects an oversized serialized request before contacting the model', async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  await expect(generateLocalModel(standalone, fields, { ...options,
    messages: [{ role: 'user', content: 'x'.repeat(2 * PORTFOLIO_BRIEF_MAX_BYTES + 64 * 1024 + 1) }], fetchImpl,
  })).rejects.toMatchObject({ code: 'too-large' });
  expect(fetchImpl).not.toHaveBeenCalled();
});


it('discovers bounded unique models without a selected model at a remote custom base path', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    expect(String(input)).toBe('https://api.example.com/custom/api/models');
    expect(init?.redirect).toBe('manual');
    return Response.json({ data: [{ id: 'z-model' }, { id: 'a-model' }, { id: 'z-model' }] });
  });
  expect(await discoverLocalModels(standalone, { fields: { LOCAL_MODEL_BASE_URL: 'https://api.example.com/custom/api' } }, fetchImpl))
    .toEqual({ ok: true, models: ['a-model', 'z-model'] });
});

it.each([[401, 'access'], [403, 'access'], [404, 'not-found'], [429, 'rate-limited'], [503, 'network']] as const)('returns a safe discovery failure for HTTP %s', async (status, kind) => {
  expect(await discoverLocalModels(standalone, { fields }, async () => new Response('private provider message', { status })))
    .toEqual({ ok: false, failure: { kind: 'configuration' } });
  expect(await discoverLocalModels(standalone, { fields: { LOCAL_MODEL_BASE_URL: fields.LOCAL_MODEL_BASE_URL } }, async () => new Response('private provider message', { status })))
    .toEqual({ ok: false, failure: { kind, status } });
});

it.each([{ data: [{ id: '' }] }, { data: [{ id: 'a\nsecret' }] }, { data: [{ id: 'x'.repeat(513) }] }, { data: [null] }, {}])('rejects invalid discovery inventory safely', async response => {
  expect(await discoverLocalModels(standalone, { fields: { LOCAL_MODEL_BASE_URL: fields.LOCAL_MODEL_BASE_URL } }, async () => Response.json(response)))
    .toEqual({ ok: false, failure: { kind: 'invalid-response' } });
});


it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'CERT_HAS_EXPIRED'])('does not infer a network cause from nonportable error code %s', async code => {
  const fetchImpl = async () => { throw new Error('private endpoint and token', { cause: { code } }); };
  expect(await discoverLocalModels(standalone, { fields: { LOCAL_MODEL_BASE_URL: fields.LOCAL_MODEL_BASE_URL } }, fetchImpl))
    .toEqual({ ok: false, failure: { kind: 'network' } });
});

it('requires a selected model for generation and checking before contacting the provider', async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const candidate = { LOCAL_MODEL_BASE_URL: fields.LOCAL_MODEL_BASE_URL };
  await expect(checkLocalModel(standalone, candidate, fetchImpl)).rejects.toMatchObject({ code: 'configuration' });
  await expect(generateLocalModel(standalone, candidate, { ...options, fetchImpl })).rejects.toMatchObject({ code: 'configuration' });
  expect(fetchImpl).not.toHaveBeenCalled();
});


it('rejects redirects without following or exposing the destination', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    expect(init?.redirect).toBe('manual');
    return new Response(null, { status: 302, headers: { location: 'https://private.example.com/token' } });
  });
  expect(await discoverLocalModels(standalone, { fields: { LOCAL_MODEL_BASE_URL: fields.LOCAL_MODEL_BASE_URL } }, fetchImpl))
    .toEqual({ ok: false, failure: { kind: 'redirect', status: 302 } });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
