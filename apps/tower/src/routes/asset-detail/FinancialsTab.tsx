import type { AssetDetailFor } from "@shared/asset-detail-views";
import { MEDIAVINE_REPORTING_CLOCK, siteRevenueWindow } from '@shared/daily-revenue';
import { DailyRevenuePanel } from '@/components/DailyRevenuePanel';
import { AssetLedger } from './AssetLedger';
import { PageAnswer } from '@/components/surface/PageAnswer';
import { formatPeriodMonthLong, formatSignedMoney } from '@/lib/format';
import { ledgerMonth } from './overview-metrics';
import { useRange } from './useRange';

/**
 * One asset's money: its daily ad revenue estimates over the header's range,
 * then its accounting months.
 *
 * NO ABOUT (bead `ro-ujb9.96.6.9`). Its three paragraphs restated what the two
 * panels already show — the daily panel names its source and its dates, the
 * monthly panel says its figure is booked net with the forecast named apart —
 * or pointed at the portfolio page, which the monthly panel now links to from
 * its own header.
 */
export function FinancialsTab({ data, nowMs }: { data: AssetDetailFor<"financials">; nowMs: number }) {
  const { days } = useRange();
  // Ending yesterday on the operator's saved clock, which the Worker names on
  // the payload (bead `ro-ujb9.88`).
  const history = siteRevenueWindow(data.dailyRevenue, nowMs, MEDIAVINE_REPORTING_CLOCK.timeZone, days);
  // ONE ANSWER FIRST (D45): the month's net in the Overview's own words (one
  // derivation, `ledgerMonth`), and what it is made of under it.
  const money = ledgerMonth(data.ledger);
  return <div className="flex min-w-0 flex-col gap-3.5">
    <PageAnswer
      answer={money ? `${formatPeriodMonthLong(money.period)} net ${formatSignedMoney(money.net, money.currency)}${money.booking === "forecast" ? " est." : ""}` : "No money recorded yet"}
      detail={money?.composition || undefined}
      marks={{ "data-surface-hero": "", "data-site-money-answer": money ? money.booking : "none" }}
    />
    <DailyRevenuePanel history={history} range={days}
      setupHref={`/assets/${encodeURIComponent(data.asset.id)}/sources`} />
    <div id="pnl"><div id="ledger">
      <AssetLedger ledger={data.ledger} ledgerRecordedAt={data.freshness.ledgerRecordedAt} nowMs={nowMs} />
    </div></div>
  </div>;
}
