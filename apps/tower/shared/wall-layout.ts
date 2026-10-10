/**
 * The Wall's composition as a document, shared by the renderer (`/wall`), the
 * editor (`/wall/edit`) and every write path, which all refuse what
 * `validateWallLayout` refuses.
 *
 * A typed re-export only: the runtime lives in `scripts/wall-layout.mts`, so
 * the config pipeline runs the same rule without a build step.
 * `scripts/declaration-lockstep.test.mjs` keeps the lists below equal to what
 * that module exports.
 */

export {
  DEFAULT_WALL_LAYOUT,
  EMPTY_WALL_CONFIG,
  RETIRED_WALL_WIDGET_TYPES,
  WALL_LAYOUT_HISTORY_MAX,
  WALL_LAYOUT_POINTER,
  WALL_LAYOUT_VERSION,
  WALL_MAX_ROWS,
  WALL_MAX_WIDGETS_PER_ROW,
  WALL_RETIRED_WARNING,
  WALL_TV_HEIGHT,
  WALL_TV_WIDTH,
  WALL_WIDGET_LIBRARY,
  WALL_WIDGET_TYPES,
  WALL_WIDTH_MAX,
  WALL_WIDTH_MIN,
  WALL_WIDTH_STEP,
  isWallColumn,
  isWallWidth,
  nextWallRowId,
  nextWallWidgetId,
  parseWallConfig,
  sameWallLayout,
  validateWallLayout,
  wallLayoutNamesRetired,
  wallLayoutWarnings,
  wallLayoutWidgets,
  wallOpRefusal,
  wallRowPlaces,
  wallWidgetSpec,
  withRevertedWallLayout,
  withSavedWallLayout,
} from "../../../scripts/wall-layout.mjs";

export type {
  WallColumn,
  WallColumnRow,
  WallConfig,
  WallLayout,
  WallLayoutCheck,
  WallLayoutVersion,
  WallRetired,
  WallRow,
  WallRowPlace,
  WallSettingKey,
  WallSlot,
  WallWidget,
  WallWidgetSettings,
  WallWidgetSpec,
  WallWidgetType,
} from "../../../scripts/wall-layout.mjs";
