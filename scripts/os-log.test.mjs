import assert from 'node:assert/strict';
import test from 'node:test';
import { redactLogText } from './os-log.mjs';

test('OAuth diagnostics redact credentials while retaining useful context', () => {
  for (const field of ['access_token', 'refresh_token', 'id_token', 'client_secret', 'refreshToken', 'CLIENT_SECRET']) {
    for (const [input, expected] of [
      [`https://provider.test/token?${field}=fixture-value&scope=read`, `https://provider.test/token?${field}=[REDACTED]&scope=read`],
      [`grant_type=refresh_token&${field}=fixture-value&client_id=public-id`, `grant_type=refresh_token&${field}=[REDACTED]&client_id=public-id`],
      [`${field}=fixture-value&scope=read`, `${field}=[REDACTED]&scope=read`],
      [`{"${field}":"fixture value","status":"failed"}`, `{"${field}":[REDACTED],"status":"failed"}`],
      [`diagnostic ${field}='fixture value' status=failed`, `diagnostic ${field}=[REDACTED] status=failed`],
    ]) {
      assert.equal(redactLogText(input), expected, field);
      assert.equal(redactLogText(expected), expected, 'redaction stays safe when applied twice');
    }
  }
  const context = 'grant_type=refresh_token client_id=public-id refresh_token_expires_in=3600 token_count=2';
  assert.equal(redactLogText(context), context);
});
