import { buildSessionExplorationSnapshot, explorationDateOffset, type SessionExplorationReport, type SessionReportReceipt } from "@noticeos/contract/session-exploration";

const cutoff = "2026-10-26";
const surfaces = [{ id: "articles", label: "Articles" }, { id: "search", label: "Search" }, { id: "tools", label: "Tools" }, { id: "account", label: "Account" }];
const progress = [-15, -5, 5, 10, 0, -20, 15, 25, 30, 35];

export const SESSION_EXPLORATION_DEMO_REPORTS: SessionExplorationReport[] = Array.from({ length: 64 }, (_, index) => {
  const date = explorationDateOffset(cutoff, index - 64);
  const lift = progress[Math.floor(index / 7)] ?? 0;
  const sessions = 1200 + index % 7 * 23;
  const paths = [
    { surfaces: ["articles"], sessions: 380 + index % 4 * 10, ending: "exit" as const },
    { surfaces: ["articles", "search", "tools"], sessions: 130 + lift, ending: "exit" as const },
    { surfaces: ["search", "articles"], sessions: 90 + index % 3 * 4, ending: "exit" as const },
    { surfaces: ["tools", "articles", "tools"], sessions: 60 + index % 4 * 5, ending: "exit" as const },
    { surfaces: ["articles", "tools"], sessions: 120 + lift, ending: "exit" as const },
    { surfaces: ["account"], sessions: 50, ending: "exit" as const },
    { surfaces: ["search", "tools", "account"], sessions: 40 + index % 5 * 3, ending: "exit" as const },
  ];
  paths.push({ surfaces: ["tools"], sessions: sessions - paths.reduce((sum, path) => sum + path.sessions, 0), ending: "exit" });
  return { schemaVersion: 1, source: "first-party", journeyId: "explore", journeyVersion: 1, definitionId: "journeyVersion1", date, timeZone: "UTC", sessionTimeoutMinutes: 30, sessions, surfaces, paths };
});

export const SESSION_EXPLORATION_DEMO_RECEIPTS: SessionReportReceipt[] = SESSION_EXPLORATION_DEMO_REPORTS.map((report) => ({
  generatedAt: `${explorationDateOffset(report.date, 1)}T01:00:00Z`, receivedAt: `${explorationDateOffset(report.date, 1)}T01:01:00Z`, reports: [report],
}));

export const SESSION_EXPLORATION_DEMO_SNAPSHOT = buildSessionExplorationSnapshot("explore", SESSION_EXPLORATION_DEMO_RECEIPTS, new Date(`${cutoff}T02:00:00Z`));
