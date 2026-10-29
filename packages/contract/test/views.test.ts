import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIEW, FOCUS_LIBRARY, HOME_MODULES, SITE_TABS, VIEW_IDS, VIEW_LIBRARY, VIEW_NAV_PATHS,
  homeModulesFor, normalizeViewId, parseViewChoice, parseWorkspaceView, serializeViewChoice, viewSpec, workspaceViewRefusal,
} from '../src/views.mjs';

describe('purpose views', () => {
  it('declares the five purposes and preserves every navigation and evidence destination', () => {
    expect(VIEW_IDS).toEqual(['overview', 'growth', 'revenue', 'delivery', 'reliability']);
    expect(VIEW_LIBRARY.map(view => view.id)).toEqual(VIEW_IDS);
    expect(DEFAULT_VIEW).toBe('overview');
    for (const view of VIEW_LIBRARY) {
      expect(view.nav).toEqual(VIEW_NAV_PATHS);
      expect(view.siteTabs).toEqual(SITE_TABS);
      expect(view.wordLevel).toBe('technical');
      expect(view.home).toContain('problems');
      expect(view.home).toContain('decide');
      expect(view.home.every(module => HOME_MODULES.includes(module))).toBe(true);
      expect(new Set(view.home).size).toBe(view.home.length);
    }
    for (const focus of FOCUS_LIBRARY) expect(HOME_MODULES).toContain(focus.module);
  });

  it('uses a distinct module emphasis for each purpose', () => {
    expect(viewSpec('overview').home).toEqual(['money', 'yesterday', 'agents', 'decide', 'problems', 'sites', 'timeline']);
    expect(viewSpec('growth').home).toEqual(['channels', 'yesterday', 'gaps', 'problems', 'decide', 'sites']);
    expect(viewSpec('revenue').home).toEqual(['money', 'problems', 'decide', 'sites', 'timeline']);
    expect(viewSpec('delivery').home).toEqual(['factory', 'decide', 'agents', 'problems', 'timeline']);
    expect(viewSpec('reliability').home).toEqual(['health', 'problems', 'decide', 'timeline']);
  });
});

describe('stored choices', () => {
  it('round trips new preferences and drops duplicate or unknown focus picks', () => {
    expect(serializeViewChoice({ view: 'growth', focus: ['money', 'visitors'] })).toBe('{"view":"growth","focus":["money","visitors"]}');
    expect(parseViewChoice({ view: 'growth', focus: ['money', 'nope', 'money'] })).toEqual({ view: 'growth', focus: ['money'] });
  });

  it('maps legacy identities to Overview and preserves focus with a purpose selection notice', () => {
    for (const view of ['business', 'product']) {
      const parsed = parseViewChoice({ view, focus: ['visitors'] });
      expect(parsed).toEqual({ view: 'overview', focus: ['visitors'], needsPurposeChoice: true });
      expect(parseViewChoice(parsed)).toEqual(parsed);
      expect(serializeViewChoice(parsed!)).toBe('{"view":"overview","focus":["visitors"]}');
    }
    expect(parseViewChoice({ view: 'everything' })).toEqual({ view: 'overview', focus: [] });
    expect(normalizeViewId('business')).toBe('overview');
    expect(normalizeViewId('reliability')).toBe('reliability');
  });

  it('rejects malformed preferences and unknown views', () => {
    for (const value of [null, 'growth', { view: 'operator' }, { view: 'growth', focus: 'money' }]) expect(parseViewChoice(value)).toBeNull();
  });
});

describe('focus ordering', () => {
  it('promotes existing modules without adding modules the purpose does not show', () => {
    expect(homeModulesFor({ view: 'delivery', focus: ['agents'] })).toEqual(['factory', 'decide', 'agents', 'problems', 'timeline']);
    expect(homeModulesFor({ view: 'growth', focus: ['site-health', 'visitors'] })).toEqual(['sites', 'channels', 'yesterday', 'gaps', 'problems', 'decide']);
    expect(homeModulesFor({ view: 'overview', focus: ['visitors', 'costs'] })).toEqual(['sites', 'money', 'yesterday', 'agents', 'decide', 'problems', 'timeline']);
  });
});

describe('workspace defaults', () => {
  it('accepts new ids and retains legacy raw values for compare-and-set writes', () => {
    for (const value of [...VIEW_IDS, 'business', 'product', 'everything']) {
      expect(parseWorkspaceView({ default: value })).toEqual({ default: value });
      expect(workspaceViewRefusal({ default: value })).toBeNull();
    }
    expect(workspaceViewRefusal({ default: 'viewer' })).toMatch(/view\.default must be one of/);
    expect(workspaceViewRefusal({ default: 'growth', focus: [] })).toMatch(/view\.focus is not a setting/);
    expect(workspaceViewRefusal(['growth'])).toMatch(/must be an object/);
  });
});
