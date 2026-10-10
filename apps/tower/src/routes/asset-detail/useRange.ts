import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import {
  DEFAULT_RANGE_DAYS,
  SURFACE_RANGES,
  type RangeDays,
} from "@shared/surface";

/**
 * The page-wide range: one selector in the asset header drives every delta,
 * sparkline and chart on whichever tab is open, so it lives in the URL, where
 * it outlives a tab switch and a pasted link opens at the range the operator
 * was looking at. The default is written as an absent parameter rather than
 * `?range=28`, so there is only one URL for the page's default state; every
 * reader must come through this hook. The set of ranges and the default are
 * `shared/surface`'s; this module owns only where the choice is kept.
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
