import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticateAsset, authenticateOperator } from '../src/auth.js';
import { ASSET_TOKENS } from './fixtures.js';

const TOKENS = JSON.stringify(ASSET_TOKENS);

function withBearer(token: string): Request {
  return new Request('https://ingest.local/api/pulse', { headers: { authorization: `Bearer ${token}` } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bearer comparison when there is no secret to compare against', () => {
  it('still runs the constant-time comparison for an asset id with no token', async () => {
    const compare = vi.spyOn(crypto.subtle, 'timingSafeEqual');

    expect(await authenticateAsset(withBearer('guess'), TOKENS, 'unregistered.example')).toBe(false);
    expect(compare).toHaveBeenCalledTimes(1);
  });

  it('compares a registered asset the same way', async () => {
    const compare = vi.spyOn(crypto.subtle, 'timingSafeEqual');

    expect(await authenticateAsset(withBearer(ASSET_TOKENS['meadow.example']!), TOKENS, 'meadow.example')).toBe(true);
    expect(await authenticateAsset(withBearer('guess'), TOKENS, 'meadow.example')).toBe(false);
    expect(compare).toHaveBeenCalledTimes(2);
  });

  it('admits no bearer when no operator token is set', async () => {
    const compare = vi.spyOn(crypto.subtle, 'timingSafeEqual');

    expect(await authenticateOperator(withBearer('anything'), '')).toBe(false);
    expect(compare).toHaveBeenCalledTimes(1);
  });
});
