import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import {
  DEFAULT_RANGE_DAYS,
  SURFACE_RANGES,
  type RangeDays,
} from "@shared/surface";

/**
 * THE PAGE-WIDE RANGE (doc 14, bead `ro-78qo.3`).
 *
 * One selector in the asset header drives every delta, sparkline and chart on
 * whichever tab is open, so the range has to be one value that outlives a tab
 * switch. It lives in the URL rather than in React state for three reasons: the
 * tabs are separate components mounted one at a time, a link an operator pastes
 * should open at the range they were looking at, and the browser's Back button
 * then has an opinion about it that we do not have to implement.
 *
 * 28 days is the operator's default (doc 14) and is written as an ABSENT
 * parameter rather than `?range=28`, so the ordinary URL stays clean and there
 * is only one URL for the page's default state. Every reader must come through
 * this hook: a component reading `searchParams` itself would render `?range=28`
 * and the bare path as two different things on that case alone.
 *
 * The set of ranges and the default are `shared/surface`'s — the same values
 * `RangeSelector` offers and `periodDelta` measures against. This module owns
 * only where the choice is KEPT.
 */
export const RANGES = SURFACE_RANGES;

export const DEFAULT_RANGE = DEFAULT_RANGE_DAYS;

export type { RangeDays };

export const RANGE_PARAM = "range";

/** A query-string value → a range. Anything unparseable, out of the set, or
 * absent reads as the default: a mistyped range is still the page the operator
 * asked for (the same rule `tabFromParam` applies to a mistyped tab). */
export function rangeFromParam(value: string | null): RangeDays {
  const days = Number(value);
  return (RANGES as readonly number[]).includes(days)
    ? (days as RangeDays)
    : DEFAULT_RANGE;
}

export function useRange(): {
  days: RangeDays;
  setDays: (days: RangeDays) => void;
} {
  const [params, setParams] = useSearchParams();
  const days = rangeFromParam(params.get(RANGE_PARAM));
  const setDays = useCallback(
    (next: RangeDays) => {
      setParams(
        (current) => {
          const updated = new URLSearchParams(current);
          if (next === DEFAULT_RANGE) updated.delete(RANGE_PARAM);
          else updated.set(RANGE_PARAM, String(next));
          return updated;
        },
        // A range is a setting on the page, not a step in the operator's
        // history: Back should leave the asset, not walk them through the four
        // ranges they tried on the way to this one.
        { replace: true },
      );
    },
    [setParams],
  );
  return { days, setDays };
}
