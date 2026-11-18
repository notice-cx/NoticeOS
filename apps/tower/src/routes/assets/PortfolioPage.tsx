import type { ReactNode } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Tabs, TabPanel, type TabSpec } from "@/components/Tabs";
import { ASSETS_ROUTE, PORTFOLIO_MONEY_ROUTE } from "@/components/nav-items";

const TAB_IDS = "portfolio-tab";
const PANEL_ID = "portfolio-panel";
const tabs: TabSpec[] = [
  { key: "assets", to: ASSETS_ROUTE, label: "Assets", end: true },
  { key: "money", to: PORTFOLIO_MONEY_ROUTE, label: "Money", end: true },
];

export function PortfolioPage({ tab, actions, meta, children }: {
  tab: "assets" | "money";
  actions?: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-5 p-4 md:p-6">
      <PageHeader title="Portfolio" documentTitle={tab === "money" ? "Money" : "Portfolio"} actions={actions} meta={meta}>
        <Tabs label="Portfolio" tabs={tabs} idBase={TAB_IDS} panelId={PANEL_ID} retainKeyboardFocus />
      </PageHeader>
      <TabPanel id={PANEL_ID} idBase={TAB_IDS} activeKey={tab} className="gap-5">
        {children}
      </TabPanel>
    </div>
  );
}
