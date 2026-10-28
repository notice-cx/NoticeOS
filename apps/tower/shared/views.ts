/**
 * The global view: a typed re-export only. The runtime lives in
 * `packages/contract/src/views.mts` so the config pipeline validates the
 * workspace default with the same list the Tower draws from.
 */

export {
  DEFAULT_VIEW,
  DEFAULT_VIEW_CHOICE,
  FOCUS_IDS,
  FOCUS_LIBRARY,
  HOME_MODULES,
  SITE_TABS,
  VIEW_IDS,
  VIEW_LIBRARY,
  VIEW_NAV_PATHS,
  VIEW_PREFERENCE_PATH,
  WORKSPACE_VIEW_POINTER,
  homeModulesFor,
  isFocusId,
  isViewId,
  isStoredViewId,
  normalizeViewId,
  parseViewChoice,
  parseWorkspaceView,
  serializeViewChoice,
  viewSpec,
  workspaceViewRefusal,
} from "@noticeos/contract/views";

export type {
  FocusId,
  FocusSpec,
  HomeModuleId,
  SiteTabId,
  ViewChoice,
  ViewId,
  StoredViewId,
  LegacyViewId,
  ViewNavPath,
  ViewSpec,
  WordLevel,
  WorkspaceViewConfig,
} from "@noticeos/contract/views";
