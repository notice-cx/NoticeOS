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
  /** Optional: absent, the Wall draws no countdown card and Settings offers
   * Set a countdown. Home never renders this landmark. */
  countdown?: CountdownConfig;
  /**
   * Optional: the Wall's composition as a saved document plus the versions it
   * replaced (`config/tower.json` at `/wall`, read by `parseWallConfig`).
   * Absent, the Wall draws `DEFAULT_WALL_LAYOUT`.
   */
  wall?: WallConfig;
  /**
   * Read side only: the parts of the stored `config/tower.json` the Tower
   * could not read. A refused part is drawn as though nothing were saved and
   * named here, so the editor can say so and guard its Save on what the store
   * really holds. Absent when every part read.
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
 * Validate config/tower.json while Vite is assembling the Worker, so a
 * malformed display config fails the build instead of reaching the Wall.
 * Absent parts are fine; a present part must be complete and well formed.
 * A saved document at runtime goes through `readDashboardConfig` instead,
 * which names a refused part rather than throwing.
 */
export function parseDashboardConfig(value: unknown): DashboardConfig {
  const config = readDashboardConfig(value);
  // Layout before countdown, so a file broken in both names the layout.
  const refusal = config.refused?.wall ?? config.refused?.countdown;
  if (refusal) throw new Error(refusal.reason);
  return config;
}

/**
 * Read a saved `config/tower.json` one part at a time: the layout and the
 * countdown are saved by different forms, so one broken part must not discard
 * the other. A part that does not read is left out and named in `refused`; a
 * refused layout keeps the saved versions that still read, for Revert.
 * Throws only when the document is not an object at all.
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
