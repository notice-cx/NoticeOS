import { expect, it } from 'vitest';
import { DEFAULT_LOCAL_MODEL_OUTPUT_TOKENS, parseLocalModelOutputTokens } from '../src/local-model-settings.mjs';

it.each([undefined, '', ' ', '\n\t'])('defaults blank output budget %j', value => {
  expect(parseLocalModelOutputTokens(value)).toBe(DEFAULT_LOCAL_MODEL_OUTPUT_TOKENS);
});
it.each([['1024', 1024], ['8192', 8192], [' 16384 ', 16384], ['32768', 32768]] as const)('accepts whole token budget %j', (value, expected) => {
  expect(parseLocalModelOutputTokens(value)).toBe(expected);
});
it.each([null, 8192, true, {}, '1023', '32769', '8e3', '8192.0', '-8192', '+8192', 'Infinity', '8192 tokens', '9'.repeat(100)])('rejects invalid token budget %j', value => {
  expect(parseLocalModelOutputTokens(value)).toBeNull();
});
