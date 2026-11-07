import { describe, expect, it } from 'vitest';
import { SYSTEM_NAME, assetDisplayName } from '../src/asset-name.mjs';

describe("the OS's own row is always called System", () => {
  it('names the OS row the System, whatever its stored name says', () => {
    // Whatever the store holds for the OS row is ignored.
    expect(assetDisplayName(1, 'ReindexOS')).toBe(SYSTEM_NAME);
    expect(assetDisplayName(true, 'ReindexOS')).toBe(SYSTEM_NAME);
  });

  it("names every other row by its operator's name", () => {
    expect(assetDisplayName(0, 'Recipes')).toBe('Recipes');
    expect(assetDisplayName(false, 'Recipes')).toBe('Recipes');
    expect(assetDisplayName(null, 'Recipes')).toBe('Recipes');
    expect(assetDisplayName(undefined, 'Recipes')).toBe('Recipes');
    // The OS is known by is_os, never by what a row is called.
    expect(assetDisplayName(0, 'ReindexOS')).toBe('ReindexOS');
    expect(assetDisplayName(0, 'NoticeOS')).toBe('NoticeOS');
    expect(assetDisplayName(0, 'System')).toBe('System');
  });
});
