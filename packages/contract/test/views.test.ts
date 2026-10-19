import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIEW,
  FOCUS_LIBRARY,
  HOME_MODULES,
  SITE_TABS,
  VIEW_IDS,
  VIEW_LIBRARY,
  VIEW_NAV_PATHS,
  homeModulesFor,
  parseViewChoice,
  parseWorkspaceView,
  serializeViewChoice,
  viewSpec,
  workspaceViewRefusal,
} from '../src/views.mjs';

describe('the view registry', () => {
  it('declares one spec per view id, and Everything keeps every entry in today\'s order', () => {
    expect(VIEW_LIBRARY.map((view) => view.id)).toEqual([...VIEW_IDS]);
    const everything = viewSpec('everything');
    expect(everything.nav).toEqual([...VIEW_NAV_PATHS]);
    // Today's eight, in today's order; the modules after them are drawn only
    // by the views that name them.
    expect(everything.home).toEqual(['money', 'yesterday', 'sources', 'problems', 'decide', 'agents', 'sites', 'timeline']);
    expect(HOME_MODULES.slice(0, 8)).toEqual(everything.home);
    expect(everything.siteTabs).toEqual([...SITE_TABS]);
    expect(DEFAULT_VIEW).toBe('everything');
  });

  it('every view names only known entries, in the shared order, with Home and Settings always present', () => {
    for (const view of VIEW_LIBRARY) {
      expect(view.nav.every((path) => VIEW_NAV_PATHS.includes(path))).toBe(true);
      expect(view.home.every((module) => HOME_MODULES.includes(module))).toBe(true);
      expect(view.siteTabs.every((tab) => SITE_TABS.includes(tab))).toBe(true);
      expect(view.nav[0]).toBe('/');
      expect(view.nav.at(-1)).toBe('/settings');
      expect(view.siteTabs[0]).toBe('overview');
      expect(view.siteTabs.at(-1)).toBe('settings');
      const tabOrder = view.siteTabs.map((tab) => SITE_TABS.indexOf(tab));
      expect([...tabOrder].sort((a, b) => a - b)).toEqual(tabOrder);
      expect(new Set(view.home).size).toBe(view.home.length);
    }
    for (const focus of FOCUS_LIBRARY) expect(HOME_MODULES.includes(focus.module)).toBe(true);
  });
});

describe('a stored choice', () => {
  it('reads back what was serialized, dropping unknown picks', () => {
    const stored = serializeViewChoice({ view: 'business', focus: ['agents', 'money'] });
    expect(stored).toBe('{"view":"business","focus":["agents","money"]}');
    expect(parseViewChoice(JSON.parse(stored))).toEqual({ view: 'business', focus: ['agents', 'money'] });
    expect(parseViewChoice({ view: 'product', focus: ['money', 'nope', 'money'] })).toEqual({ view: 'product', focus: ['money'] });
  });

  it('refuses anything that is not a choice rather than guessing', () => {
    expect(parseViewChoice(null)).toBeNull();
    expect(parseViewChoice('business')).toBeNull();
    expect(parseViewChoice({ view: 'operator' })).toBeNull();
    expect(parseViewChoice({ view: 'business', focus: 'money' })).toBeNull();
    expect(parseViewChoice({ view: 'business' })).toEqual({ view: 'business', focus: [] });
  });
});

describe('homeModulesFor', () => {
  it('keeps the view\'s list and moves the picked modules to the front in the order picked', () => {
    expect(homeModulesFor({ view: 'business', focus: [] })).toEqual(['health', 'money', 'factory', 'decide']);
    expect(homeModulesFor({ view: 'business', focus: ['agents'] })).toEqual(['factory', 'health', 'money', 'decide']);
    expect(homeModulesFor({ view: 'business', focus: ['agents', 'costs'] })).toEqual(['factory', 'money', 'health', 'decide']);
    expect(homeModulesFor({ view: 'product', focus: [] })).toEqual(['money', 'channels', 'gaps', 'problems', 'decide', 'sites']);
    expect(homeModulesFor({ view: 'product', focus: ['site-health', 'visitors'] })).toEqual(['sites', 'money', 'channels', 'gaps', 'problems', 'decide']);
  });

  it('never adds a module the view does not draw', () => {
    expect(homeModulesFor({ view: 'business', focus: ['visitors', 'site-health'] })).toEqual(['health', 'money', 'factory', 'decide']);
    expect(homeModulesFor({ view: 'everything', focus: ['visitors'] })).toEqual([
      'sites', 'money', 'yesterday', 'sources', 'problems', 'decide', 'agents', 'timeline',
    ]);
  });
});

describe('the workspace default document', () => {
  it('accepts one known id and nothing else', () => {
    expect(parseWorkspaceView({ default: 'product' })).toEqual({ default: 'product' });
    expect(workspaceViewRefusal({ default: 'product' })).toBeNull();
    expect(workspaceViewRefusal({ default: 'viewer' })).toMatch(/view\.default must be one of/);
    expect(workspaceViewRefusal({ default: 'product', focus: [] })).toMatch(/view\.focus is not a setting/);
    expect(workspaceViewRefusal('product')).toMatch(/must be an object/);
    expect(workspaceViewRefusal(['product'])).toMatch(/must be an object/);
  });
});
