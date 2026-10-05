/**
 * The Wall's composition as a DOCUMENT (epic `ro-lzmq`, docs/15 flow D) — the
 * contract between the three parties that share the layout:
 *
 *   · the RENDERER (`/wall`, and the editor's preview) draws a `WallLayout`;
 *   · the EDITOR (`/wall/edit`) produces one and saves it as a version;
 *   · every WRITE DOOR refuses one it cannot draw — `validateWallLayout` is the
 *     one rule, read by the editor before Save and by the pipeline before write.
 *
 * THIS FILE IS THE TYPED RE-EXPORT, and nothing else *(2026-09-05, bead
 * `ro-lzmq.3`)*. The runtime is authored in [`scripts/wall-layout.mts`](../../../scripts/wall-layout.mts)
 * and generated into the plain-ESM `wall-layout.mjs` (bead `ro-ujb9.61`),
 * because the config pipeline (`scripts/config-documents.mjs`) runs without a
 * build step so it can bundle into a Worker AND run in a terminal. TypeScript
 * resolves the import below to that authored source, so every type here is the
 * implementation's own. While the rule lived here, `pnpm config:apply` accepted
 * a `/wall` the television could not draw and the first thing to notice was the
 * next build. Moving the runtime, rather than restating it, is what keeps
 * "two implementations of what the Tower may edit would be two answers" true.
 *
 * Every `@shared/wall-layout` import site is unchanged by design, and the two
 * lists below are no longer kept in step by hand *(bead `ro-yibc`)*:
 * `scripts/declaration-lockstep.test.mjs` holds the values to what the `.mjs`
 * exports and the types to what the generated `.d.mts` declares, both
 * directions. A name added there and forgotten here is a red gate rather than a
 * name no component can import.
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
