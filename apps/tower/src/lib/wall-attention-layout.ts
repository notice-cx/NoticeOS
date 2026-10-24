import { isWallColumn, type WallColumn, type WallLayout } from "@shared/wall-layout";

/** Upgrade the standard composition without replacing tile settings or custom arrangements. */
export function wallWithAttentionStrip(layout: WallLayout): WallLayout {
  const matches = (column: WallColumn, types: readonly string[]) => column.rows.length === types.length
    && column.rows.every((row, index) => row.widgets.length === 1 && row.widgets[0]?.type === types[index]
      && row.height === (index === types.length - 1 ? "fill" : "auto"));
  const at = layout.rows.findIndex(row => row.widgets.length === 2
    && isWallColumn(row.widgets[0]!) && matches(row.widgets[0], ["work", "sites"])
    && isWallColumn(row.widgets[1]!) && matches(row.widgets[1], ["revenue", "needs", "feed"]));
  if (at === -1) return layout;
  const next = structuredClone(layout);
  const [business, side] = next.rows[at]!.widgets;
  if (!business || !side || !isWallColumn(business) || !isWallColumn(side)) return layout;
  const attention = side.rows.splice(1, 1)[0]!;
  business.rows.splice(1, 0, attention);
  return next;
}
