import type { ViewId } from '@shared/views';

export type TaskSection = 'body' | 'dependencies' | 'related' | 'progress' | 'activity';
export type TaskBodySection = 'value' | 'description' | 'acceptance';

const TASK_ORDER: Readonly<Record<ViewId, readonly TaskSection[]>> = {
  overview: ['body', 'dependencies', 'related', 'progress', 'activity'],
  growth: ['body', 'progress', 'dependencies', 'related', 'activity'],
  revenue: ['body', 'dependencies', 'progress', 'related', 'activity'],
  delivery: ['dependencies', 'progress', 'body', 'related', 'activity'],
  reliability: ['dependencies', 'body', 'activity', 'progress', 'related'],
};
const BODY_ORDER: Readonly<Record<ViewId, readonly TaskBodySection[]>> = {
  overview: ['value', 'description', 'acceptance'],
  growth: ['description', 'value', 'acceptance'],
  revenue: ['value', 'description', 'acceptance'],
  delivery: ['acceptance', 'description', 'value'],
  reliability: ['acceptance', 'description', 'value'],
};

/** Stable keys keep field drafts mounted when their reading order changes. */
export function taskSectionOrder(view: ViewId): readonly TaskSection[] { return TASK_ORDER[view]; }
export function taskBodyOrder(view: ViewId): readonly TaskBodySection[] { return BODY_ORDER[view]; }
