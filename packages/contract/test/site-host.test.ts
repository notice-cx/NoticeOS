import { describe, expect, it } from 'vitest';
import { siteHost } from '../src/site-discovery.js';

describe('siteHost: a provider site matches a stored site by host, www. dropped', () => {
  it.each([
    'www.example.com',
    'example.com',
    'https://www.example.com/x',
    'sc-domain:example.com',
    'WWW.Example.com:443',
    'http://example.com',
    'https://www.example.com/',
    'SC-DOMAIN:www.example.com',
    '  https://user@www.example.com:8443/path?q=1#top  ',
  ])('%s answers example.com', (value) => {
    expect(siteHost(value)).toBe('example.com');
  });

  it('keeps every label but a leading www.', () => {
    expect(siteHost('shop.example.com')).toBe('shop.example.com');
    expect(siteHost('https://www.shop.example.com/')).toBe('shop.example.com');
    expect(siteHost('wwwexample.com')).toBe('wwwexample.com');
    expect(siteHost('www2.example.com')).toBe('www2.example.com');
  });

  it.each(['www', 'WWW', 'https://www/', 'www.', '', '   ', 'https://', 'exa mple.com', null, undefined])(
    '%s answers null',
    (value) => {
      expect(siteHost(value)).toBeNull();
    },
  );
});
