import { describe, expect, it } from 'vitest';
import { PRODUCT_NAME, assetDisplayName } from '../src/asset-name.js';

describe("the OS's own row is always called NoticeOS", () => {
  it('names the OS row by the product, whatever its stored name says', () => {
    expect(PRODUCT_NAME).toBe('NoticeOS');
    // Whatever the store holds for the OS row is ignored.
    expect(assetDisplayName(1, 'ReindexOS')).toBe('NoticeOS');
    expect(assetDisplayName(true, 'ReindexOS')).toBe('NoticeOS');
    expect(assetDisplayName(1, 'Anything an operator typed')).toBe('NoticeOS');
  });

  it("names every other row by its operator's name", () => {
    expect(assetDisplayName(0, 'Recipes')).toBe('Recipes');
    expect(assetDisplayName(false, 'Recipes')).toBe('Recipes');
    expect(assetDisplayName(null, 'Recipes')).toBe('Recipes');
    expect(assetDisplayName(undefined, 'Recipes')).toBe('Recipes');
    // The OS is known by is_os, never by what a row is called.
    expect(assetDisplayName(0, 'ReindexOS')).toBe('ReindexOS');
    expect(assetDisplayName(0, 'NoticeOS')).toBe('NoticeOS');
  });
});
