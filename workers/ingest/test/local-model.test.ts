import { PORTFOLIO_BRIEF_ABSTENTION, PORTFOLIO_BRIEF_MAX_BYTES, portfolioBriefEvidenceSchema, portfolioBriefResponseSchema, type PortfolioBriefEvidence } from '@noticeos/contract/portfolio-brief';
import { portfolioBriefPrompt } from '../src/portfolio-brief-prompt.js';
import { env } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { connectCredential } from '../src/credential-connect.js';
import { putCredential, resolveCredential, credentialSummary, validateCredentialFields } from '../src/credentials.js';
import { integrationProvider } from '@noticeos/contract';
import { probeCredential } from '../src/credential-probes.js';
import { checkLocalModel, generateLocalModel, localModelBaseUrl } from '../src/local-model.js';

const fields = { LOCAL_MODEL_BASE_URL: 'http://127.0.0.1:1234/v1', LOCAL_MODEL_ID: 'synthetic-model' };
const options = { messages: [{ role: 'user' as const, content: 'Summarize synthetic evidence.' }], responseSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } };
const standalone = { NOTICEOS_WORKSPACE_PROFILE: 'standalone' };
const completion = (content = '{"summary":"Synthetic result"}', finish_reason = 'stop') => Response.json({ choices: [{ message: { content }, finish_reason }] });

it('uses fixed paths, omits absent auth, requests constrained JSON and parses only final content', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    expect(String(input)).toBe('http://127.0.0.1:1234/v1/chat/completions');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: fields.LOCAL_MODEL_ID, stream: false, max_tokens: 4096,
      response_format: { type: 'json_schema', json_schema: { strict: true, schema: options.responseSchema } } });
    return completion();
  });
  expect(await generateLocalModel(standalone, fields, { ...options, fetchImpl })).toEqual({ summary: 'Synthetic result' });
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

it.each([[undefined], [null], [[]]])('accepts final content when the server reports no tool calls (%j)', async tool_calls => {
  const fetchImpl = async () => Response.json({ choices: [{ finish_reason: 'stop', message: {
    content: '{"summary":"Synthetic result"}', reasoning_content: 'Separate reasoning is not the final answer.', tool_calls,
  } }] });
  expect(await generateLocalModel(standalone, fields, { ...options, fetchImpl })).toEqual({ summary: 'Synthetic result' });
});

it.each([[[{ type: 'function', function: { name: 'act', arguments: '{}' } }]], [{}], [false], ['']])('rejects nonempty or malformed tool calls (%j)', async tool_calls => {
  const fetchImpl = async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"summary":"Synthetic result"}', tool_calls } }] });
  await expect(generateLocalModel(standalone, fields, { ...options, fetchImpl })).rejects.toMatchObject({ code: 'invalid-output' });
});

it.each(['hosted', 'demo'])('blocks %s credential mutation, discovery, probe and inference before fetch', async profile => {
  const selected = { ...env, NOTICEOS_WORKSPACE_PROFILE: profile };
  const fetchImpl = vi.fn<typeof fetch>();
  expect(await putCredential(selected, { provider: 'local-model', fields })).toMatchObject({ ok: false, error: 'validation' });
  expect(await connectCredential(selected, { provider: 'local-model', fields }, { fetchImpl })).toMatchObject({ ok: false, error: 'not_supported' });
  expect(await probeCredential(selected, 'local-model', { fetchImpl })).toMatchObject({ ok: false, result: { outcome: 'not-checked' } });
  await expect(checkLocalModel(selected, fields, fetchImpl)).rejects.toMatchObject({ code: 'unavailable' });
  await expect(generateLocalModel(selected, fields, { ...options, fetchImpl })).rejects.toMatchObject({ code: 'unavailable' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it.each(['http://user:password@example.test/v1', 'http://example.test/v1?token=secret', 'http://example.test/v1#secret', 'file:///v1', 'http://example.test/'])('rejects unsafe or ambiguous base URL %s', value => {
  expect(() => localModelBaseUrl(value)).toThrow();
  expect(validateCredentialFields(integrationProvider('local-model')!, { ...fields, LOCAL_MODEL_BASE_URL: value })).not.toEqual([]);
});

it.each(['<think>reasoning</think>{"summary":"answer"}', '```json\n{"summary":"answer"}\n```', '[]', 'null'])('rejects output outside the final JSON object', async content => {
  await expect(generateLocalModel(standalone, fields, { ...options, fetchImpl: async () => completion(content) })).rejects.toMatchObject({ code: 'invalid-output' });
});

it('rejects truncated responses, excessive bodies and already cancelled work', async () => {
  await expect(generateLocalModel(standalone, fields, { ...options, fetchImpl: async () => completion('{"summary":"partial"}', 'length') })).rejects.toMatchObject({ code: 'invalid-output' });
  await expect(generateLocalModel(standalone, fields, { ...options, fetchImpl: async () => new Response('x'.repeat(1_048_577)) })).rejects.toMatchObject({ code: 'too-large' });
  const controller = new AbortController(); controller.abort();
  const fetchImpl = vi.fn<typeof fetch>();
  await expect(generateLocalModel(standalone, fields, { ...options, fetchImpl, signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('sanitizes transport and provider failures', async () => {
  await expect(checkLocalModel(standalone, fields, async () => { throw new Error('private endpoint and token'); })).rejects.toThrow('Local model: network.');
  await expect(checkLocalModel(standalone, fields, async () => new Response('private provider message', { status: 401 }))).rejects.toMatchObject({ code: 'access', message: 'Local model: access.' });
});


it('stores a standalone connection only after discovery and keeps the token out of summaries', async () => {
  const selected = { ...env, NOTICEOS_WORKSPACE_PROFILE: 'standalone' };
  const candidate = { ...fields, LOCAL_MODEL_API_TOKEN: 'synthetic-private-model-token' };
  const refused = await connectCredential(selected, { provider: 'local-model', fields: candidate }, {
    fetchImpl: async () => Response.json({ data: [] }),
  });
  expect(refused).toMatchObject({ ok: true, verdict: 'refused' });
  expect((await resolveCredential(selected, 'local-model')).source).toBe('none');
  const accepted = await connectCredential(selected, { provider: 'local-model', fields: candidate }, {
    fetchImpl: async () => Response.json({ data: [{ id: fields.LOCAL_MODEL_ID }] }),
  });
  expect(accepted).toMatchObject({ ok: true, verdict: 'accepted' });
  expect((await resolveCredential(selected, 'local-model')).fields).toEqual(candidate);
  expect(JSON.stringify(await credentialSummary(selected, 'local-model'))).not.toContain(candidate.LOCAL_MODEL_API_TOKEN);
});

it('times out generation and aborts the underlying request', async () => {
  vi.useFakeTimers();
  try {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('private transport context')), { once: true });
    }));
    const pending = generateLocalModel(standalone, fields, { ...options, fetchImpl });
    const verdict = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(120_000);
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

it.each(['http://8.8.8.8/v1', 'https://api.example.com/v1', 'http://model/v1', 'http://model.local/v1',
  'http://169.254.169.254/v1', 'http://172.15.255.255/v1', 'http://172.32.0.0/v1', 'http://192.169.0.1/v1',
  'http://localhost.example.com/v1', 'http://host.docker.internal.example.com/v1', 'http://0.0.0.0/v1',
  'http://[2001:4860:4860::8888]/v1', 'http://[::ffff:8.8.8.8]/v1', 'http://[fc::1]/v1', 'http://[fec0::1]/v1'])('blocks nonlocal endpoint %s before fetch', async value => {
  const fetchImpl = vi.fn<typeof fetch>();
  await expect(checkLocalModel(standalone, { ...fields, LOCAL_MODEL_BASE_URL: value }, fetchImpl)).rejects.toMatchObject({ code: 'configuration' });
  expect(fetchImpl).not.toHaveBeenCalled();
});


it.each([1, 260])('accepts maximal escaped evidence with %s distinct period openings in the real briefing request', async factCount => {
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
  const prompt = portfolioBriefPrompt(packet);
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    const body = String(init?.body);
    expect(bytes(body)).toBeGreaterThan(131_072);
    const sent = JSON.parse(body) as { messages: { content: string }[]; response_format: { json_schema: { schema: unknown } } };
    expect(sent.messages.map(message => message.content)).toEqual([prompt, evidenceJson]);
    expect(sent.response_format.json_schema.schema).toEqual(portfolioBriefResponseSchema);
    return completion(JSON.stringify(PORTFOLIO_BRIEF_ABSTENTION));
  });
  expect(await generateLocalModel(standalone, fields, {
    messages: [{ role: 'system', content: prompt }, { role: 'user', content: evidenceJson }],
    responseSchema: portfolioBriefResponseSchema, fetchImpl,
  })).toEqual(PORTFOLIO_BRIEF_ABSTENTION);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('still rejects an oversized serialized request before contacting the model', async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  await expect(generateLocalModel(standalone, fields, { ...options,
    messages: [{ role: 'user', content: 'x'.repeat(2 * PORTFOLIO_BRIEF_MAX_BYTES + 64 * 1024 + 1) }], fetchImpl,
  })).rejects.toMatchObject({ code: 'too-large' });
  expect(fetchImpl).not.toHaveBeenCalled();
});
