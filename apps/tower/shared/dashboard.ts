import { DEFAULT_WALL_LAYOUT, type WallConfig, parseWallConfig } from "./wall-layout";

/** The countdown card's three settings, read as one landmark. */
export interface CountdownConfig {
  /** One grapheme rendered as the countdown's visual landmark. */
  emoji: string;
  label: string;
  /** ISO-8601 instant, including `Z` or a numeric UTC offset. */
  targetAt: string;
}

/** Store-backed Wall display configuration surfaced through /api/wall. */
export interface DashboardConfig {
  /**
   * OPTIONAL (bead ro-py40). A countdown is one operator's trip, move or
   * launch — a fresh install has none, and used to be unable to build until
   * somebody invented one. Absent, the Wall draws no countdown card; Settings
   * offers Set a countdown. Home never renders this landmark.
   */
  countdown?: CountdownConfig;
  /**
   * OPTIONAL (epic `ro-lzmq`). The Wall's composition as a saved document plus
   * the versions it replaced — `config/tower.json` at `/wall`, read by
   * `parseWallConfig`. Absent exactly as the countdown is absent: an install
   * that never opens the editor has no `/wall` block at all, and the Wall draws
   * `DEFAULT_WALL_LAYOUT`. The default is named ONCE, in `EMPTY_WALL_CONFIG`,
   * so nothing here restates it.
   */
  wall?: WallConfig;
  /**
   * READ-SIDE ONLY (bead `ro-trai.45`): the parts of the stored
   * `config/tower.json` the Tower could not read. Each part is read on its own
   * (`readDashboardConfig`), so a broken countdown leaves a good layout
   * standing and the other way round; the part refused is drawn as though
   * nothing were saved — the default layout, no countdown — and named here, so
   * the editor can say so and guard its Save on what the store really holds.
   * Absent when every part read.
   */
  refused?: DashboardRefusals;
}

/** One part of `config/tower.json` the Tower refused to read. */
export interface DashboardRefusal {
  /** The value exactly as stored. A Save from this state guards on it: the
   * store holds this, not the default drawn in its place. */
  saved: unknown;
  /** Why it was refused, in the validator's own words. */
  reason: string;
}

export interface DashboardRefusals {
  wall?: DashboardRefusal;
  countdown?: DashboardRefusal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const EMOJI_CODE_POINT =
  /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3)/u;

export function isCountdownEmoji(value: string): boolean {
  const graphemes = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value),
  ];
  return graphemes.length === 1 && EMOJI_CODE_POINT.test(value);
}

/**
 * Validate config/tower.json while Vite is assembling the Worker. A malformed
 * display config should fail the build instead of shipping an unusable Wall.
 *
 * ABSENT IS FINE; WRONG IS NOT. A file with no `countdown` at all is a valid
 * configuration — the display simply has no countdown — so a fresh clone builds
 * without inventing an event (bead ro-py40). A `countdown` that IS present must
 * still be complete and well formed, because a half-written one is a mistake
 * somebody wants to hear about at build time rather than on the wall TV.
 *
 * `/wall` (epic `ro-lzmq`) is read on the same terms, through the layout
 * contract's own `parseWallConfig`: a file with no saved layout builds and the
 * Wall draws its default, and a saved layout the Wall could not draw fails the
 * build with the validator's own sentence rather than reaching the TV as a hole.
 *
 * THE BUILD'S RULE ONLY. A SAVED document is read part by part by
 * `readDashboardConfig` below, which names a refused part instead of throwing:
 * a Worker that is already running has no build to fail.
 */
export function parseDashboardConfig(value: unknown): DashboardConfig {
  const config = readDashboardConfig(value);
  // The layout first, then the countdown: the order the file was always
  // checked in, so a file broken in both places names the same part it did.
  const refusal = config.refused?.wall ?? config.refused?.countdown;
  if (refusal) throw new Error(refusal.reason);
  return config;
}

/**
 * Read a SAVED `config/tower.json` one part at a time (bead `ro-trai.45`).
 *
 * The layout and the countdown are two settings that happen to share a file,
 * saved by two different forms. Read as one, a countdown with an empty emoji
 * threw the whole document away and the TV drew the default layout over a
 * valid saved one; and the editor, handed that default, guarded its next Save
 * on it while the store held something else, so the Save was refused as
 * "Changed elsewhere".
 *
 * So each part is read on its own. A part that reads is used; a part that
 * does not is left out — the Wall draws its default, Home and the strip no
 * countdown — and named in `refused` with the value as stored and the reason.
 * A refused layout keeps the versions saved with it that still read, so the
 * editor can list them for Revert.
 *
 * Throws only when the document is not an object at all: then there is no
 * part to read, and the caller falls back as it always has.
 */
export function readDashboardConfig(value: unknown): DashboardConfig {
  if (!isRecord(value)) {
    throw new Error("config/tower.json must contain a JSON object");
  }
  const config: DashboardConfig = {};
  const refused: DashboardRefusals = {};
  if (value.wall !== undefined && value.wall !== null) {
    try {
      config.wall = parseWallConfig(value.wall);
    } catch (err) {
      refused.wall = { saved: value.wall, reason: messageOf(err) };
      const readable = readableVersions(value.wall);
      if (readable) config.wall = readable;
    }
  }
  if (value.countdown !== undefined && value.countdown !== null) {
    try {
      config.countdown = parseCountdown(value.countdown);
    } catch (err) {
      refused.countdown = { saved: value.countdown, reason: messageOf(err) };
    }
  }
  if (refused.wall || refused.countdown) config.refused = refused;
  return config;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The versions saved with a refused layout that still read, each by the
 * contract's own rule (`parseWallConfig`, one version at a time), under the
 * default the Wall draws in its place — or nothing, when none does.
 */
function readableVersions(wall: unknown): WallConfig | undefined {
  if (!isRecord(wall) || !Array.isArray(wall.history)) return undefined;
  const history = wall.history.flatMap((entry) => {
    try {
      return parseWallConfig({ layout: DEFAULT_WALL_LAYOUT, history: [entry] }).history;
    } catch {
      return [];
    }
  });
  return history.length > 0 ? { layout: DEFAULT_WALL_LAYOUT, history } : undefined;
}

/** A present `/countdown`, read whole: complete and well formed, or refused. */
function parseCountdown(value: unknown): CountdownConfig {
  if (!isRecord(value)) {
    throw new Error("config/tower.json countdown, when present, must be an object");
  }

  const emoji = value.emoji;
  if (
    typeof emoji !== "string" ||
    emoji.trim().length === 0 ||
    !isCountdownEmoji(emoji.trim())
  ) {
    throw new Error("config/tower.json countdown.emoji must contain one emoji");
  }

  const label = value.label;
  if (typeof label !== "string" || label.trim().length === 0 || label.length > 80) {
    throw new Error("config/tower.json countdown.label must contain 1–80 characters");
  }

  const targetAt = value.targetAt;
  const hasZone =
    typeof targetAt === "string" &&
    /(?:Z|[+-]\d{2}:\d{2})$/u.test(targetAt);
  if (!hasZone || Number.isNaN(Date.parse(targetAt))) {
    throw new Error(
      "config/tower.json countdown.targetAt must be an ISO-8601 instant with a timezone",
    );
  }

  return {
    emoji: emoji.trim(),
    label: label.trim(),
    targetAt,
  };
}
