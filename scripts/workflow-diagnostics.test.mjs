import assert from 'node:assert/strict';
import test from 'node:test';
import { boundWorkflowRunDiagnostics, captureWorkflowDiagnostic, isWorkflowStepDiagnostics, WORKFLOW_RUN_DIAGNOSTIC_BYTES } from './workflow-diagnostics.mjs';

const bytes = value => new TextEncoder().encode(value).byteLength;
test('diagnostics retain useful nested settings and actual values while redacting credential keys and patterns', () => {
  const captured = captureWorkflowDiagnostic({ operation: 'collect', config: { assets: ['example.com'], days: 7,
    API_TOKEN: 'synthetic-secret', clientSecret: 'synthetic-secret-2', nested: { private_key: 'synthetic-private' } },
    env: { binding: 'raw-environment-secret' }, response: 'Authorization: Bearer synthetic-bearer', url: 'https://u:synthetic-pass@example.com/path?token=synthetic-query' });
  for (const secret of ['synthetic-secret', 'synthetic-private', 'raw-environment-secret', 'synthetic-bearer', 'synthetic-pass', 'synthetic-query']) assert.ok(!captured.text.includes(secret));
  assert.ok(captured.text.includes('example.com')); assert.ok(captured.text.includes('collect'));
  assert.equal(captured.redacted, true); assert.equal(captured.truncated, false);
  assert.ok(isWorkflowStepDiagnostics({ input: captured }));
});

test('known secret values are replaced before truncation, including errors and escaped JSON values', () => {
  const secret = 'synthetic-private\"value';
  const captured = captureWorkflowDiagnostic(new Error(`Server refused ${secret} ${'x'.repeat(1000)}`), { secrets: [secret], maxBytes: 128 });
  assert.ok(!captured.text.includes(secret)); assert.ok(!captured.text.includes('synthetic-private'));
  assert.equal(captured.redacted, true); assert.equal(captured.truncated, true); assert.ok(bytes(captured.text) <= 128);
});

test('known credentials in raw JSON request, response and nested error text are redacted without changing the body format', () => {
  const secret = 'synthetic-private"value\\path\nline';
  const body = JSON.stringify({ message: `Provider returned ${secret}`, safe: 'Useful detail' });
  for (const phase of ['input', 'output', 'error']) {
    const value = phase === 'input' ? body : phase === 'output' ? { status: 400, body, truncated: false } : { message: JSON.stringify({ error: body }) };
    const captured = captureWorkflowDiagnostic(value, { secrets: [secret], maxBytes: 65_536 });
    assert.ok(!captured.text.includes('synthetic-private'));
    assert.ok(captured.text.includes('Useful detail'));
    assert.equal(captured.redacted, true);
    assert.equal(captured.truncated, false);
    assert.ok(isWorkflowStepDiagnostics({ [phase]: captured }));
  }
  const captured = captureWorkflowDiagnostic(body, { secrets: [secret], maxBytes: 65_536 });
  assert.equal(captured.text, JSON.stringify({ message: 'Provider returned [REDACTED]', safe: 'Useful detail' }));
});

test('finite nested JSON secret variants are replaced before byte clipping and remain history safe', () => {
  const secret = 'synthetic-private"credential\\value';
  let nested = secret;
  for (let depth = 0; depth <= 6; depth++) {
    const captured = captureWorkflowDiagnostic(`${nested} ${'x'.repeat(1000)}`, { secrets: [secret], maxBytes: 64 });
    assert.ok(!captured.text.includes('synthetic-private'));
    assert.ok(captured.text.startsWith('[REDACTED]'));
    assert.equal(captured.redacted, true);
    assert.equal(captured.truncated, true);
    assert.ok(isWorkflowStepDiagnostics({ output: captured }));
    nested = JSON.stringify(nested).slice(1, -1);
  }
});

test('transport-truncated raw bodies redact trailing known-secret fragments before storage clipping', () => {
  const secret = `synthetic-boundary-${'private'.repeat(30)}`;
  const preview = `${'x'.repeat(65_536 - 128)}${secret}`.slice(0, 65_536);
  const captured = captureWorkflowDiagnostic({ status: 400, body: preview, truncated: true }, {
    secrets: [secret], maxBytes: 65_536, inputTruncated: true,
  });
  assert.ok(!captured.text.includes('synthetic-boundary'));
  assert.equal(captured.redacted, true);
  assert.equal(captured.truncated, true);
  assert.ok(bytes(captured.text) <= 65_536);
  assert.ok(isWorkflowStepDiagnostics({ output: captured }));
});

test('truncated suffix redaction covers escaped variants and repeated prefixes without altering complete payloads', () => {
  const secret = 'synthetic"private\\token';
  const encoded = JSON.stringify(secret).slice(1, -1);
  const fragment = encoded.slice(0, -3);
  const complete = captureWorkflowDiagnostic(`Actual output ${fragment}`, { secrets: [secret] });
  assert.equal(complete.text, `Actual output ${fragment}`);
  assert.equal(complete.redacted, false);
  const clipped = captureWorkflowDiagnostic(`Actual output ${fragment}`, { secrets: [secret], inputTruncated: true });
  assert.equal(clipped.text, 'Actual output [REDACTED]');
  assert.equal(clipped.truncated, true);
  const repeated = captureWorkflowDiagnostic('a'.repeat(5000), { secrets: [`${'a'.repeat(10_000)}b`], inputTruncated: true });
  assert.equal(repeated.text, '[REDACTED]');
});

test('UTF8 bytes, depth, array items, cycles and accessors are bounded without executing getters', () => {
  let calls = 0; const value = { text: '🙂名'.repeat(1000), list: Array.from({ length: 200 }, (_, index) => index) };
  Object.defineProperty(value, 'unsafe', { get() { calls++; throw new Error('getter executed'); } }); value.circular = value;
  const captured = captureWorkflowDiagnostic(value, { maxBytes: 101 });
  assert.equal(calls, 0); assert.equal(captured.truncated, true); assert.ok(bytes(captured.text) <= 101);
  assert.ok(!captured.text.includes('�'));
  assert.ok(isWorkflowStepDiagnostics({ output: captured }));
});

test('retained diagnostics reject unbounded, malformed and unsanitized text', () => {
  const valid = { text: 'Actual result', truncated: false, redacted: false };
  assert.ok(isWorkflowStepDiagnostics({ output: valid }));
  for (const invalid of [{ output: { ...valid, text: 'x'.repeat(65_537) } }, { output: { ...valid, arbitrary: 'x' } },
    { output: { ...valid, text: 'Bearer synthetic-private' } }, { credential: valid }, { error: { ...valid, redacted: 'false' } }]) assert.equal(isWorkflowStepDiagnostics(invalid), false);
  for (const limit of [0, -1, NaN, 65_537, 1.5]) assert.throws(() => captureWorkflowDiagnostic('x', { maxBytes: limit }), RangeError);
});


test('every clipping point preserves stable redaction validation without leaking partial credentials', () => {
  for (const value of ['Authorization: Bearer synthetic-private-token', 'https://example.com/?token=synthetic-private-token', '{"password":"synthetic-private-token"}']) {
    for (let maxBytes = 1; maxBytes <= 100; maxBytes++) {
      const captured = captureWorkflowDiagnostic(value, { maxBytes });
      assert.ok(bytes(captured.text) <= maxBytes);
      assert.ok(isWorkflowStepDiagnostics({ output: captured }), `${maxBytes}: ${captured.text}`);
      assert.ok(!captured.text.includes('synthetic-private'));
    }
  }
});

test('an unfinished PEM block is redacted before storage clipping', () => {
  for (const kind of ['PRIVATE KEY', 'RSA PRIVATE KEY']) {
    const captured = captureWorkflowDiagnostic(`Actual error\n-----BEGIN ${kind}-----\nsensitive-key-material`, { inputTruncated: true });
    assert.ok(!captured.text.includes('sensitive-key-material'));
    assert.equal(captured.redacted, true);
    assert.ok(isWorkflowStepDiagnostics({ error: captured }));
  }
});

test('arbitrary provider metadata cannot claim diagnostic redaction or truncation', () => {
  const captured = captureWorkflowDiagnostic({ result: { response: { body: 'Observed bounded response', redacted: true, truncated: true } } });
  assert.equal(captured.redacted, false); assert.equal(captured.truncated, false);
  assert.ok(captured.text.includes('Observed bounded response'));
});

test('a run-level byte budget rebalances prior large fields instead of dropping new errors', () => {
  const steps = Array.from({ length: 20 }, () => ({ diagnostics: { input: captureWorkflowDiagnostic('\n名'.repeat(20_000), { maxBytes: 65_536 }),
    output: captureWorkflowDiagnostic('x'.repeat(60_000), { maxBytes: 65_536 }) } }));
  steps.push({ diagnostics: { error: captureWorkflowDiagnostic('A later actual error') } });
  boundWorkflowRunDiagnostics(steps);
  assert.ok(steps.reduce((sum, step) => sum + bytes(JSON.stringify(step.diagnostics)), 0) <= WORKFLOW_RUN_DIAGNOSTIC_BYTES);
  assert.equal(steps.at(-1).diagnostics.error.text, 'A later actual error');
  assert.ok(steps[0].diagnostics.input.truncated);
  for (const step of steps) assert.ok(isWorkflowStepDiagnostics(step.diagnostics));
});
