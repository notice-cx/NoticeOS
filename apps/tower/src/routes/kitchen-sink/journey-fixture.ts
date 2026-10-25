import { journeyDefinitionId, type JourneyDefinition, type JourneyFunnelResult, type JourneyPeriod, type JourneySnapshot } from "@noticeos/contract/journeys";

export const JOURNEY_DEMO_DEFINITIONS: JourneyDefinition[] = [
  { id: "account", label: "Calculator → account", goal: "Account growth", kind: "funnel", status: "active", version: 1, steps: [
    { id: "visit", label: "Visit calculator", alternatives: [{ eventName: "page_view", pagePath: "/calculator" }] },
    { id: "complete", label: "Complete calculation", alternatives: [{ eventName: "calculation_complete" }], withinSeconds: 86400 },
    { id: "save", label: "Choose save", alternatives: [{ eventName: "plan_save_click" }], withinSeconds: 86400 },
    { id: "signup", label: "Start signup", alternatives: [{ eventName: "auth_initiate", parameters: [{ name: "intent", value: "signup" }] }], withinSeconds: 86400 },
    { id: "created", label: "Account created", alternatives: [{ eventName: "sign_up" }], withinSeconds: 86400 },
  ] },
  { id: "activation", label: "The first useful action", goal: "Activation", kind: "funnel", status: "active", version: 1, steps: [
    { id: "created", label: "Account created", alternatives: [{ eventName: "sign_up" }] },
    { id: "use", label: "First useful action", alternatives: [{ eventName: "plan_save" }, { eventName: "tracker_log" }], withinSeconds: 604800 },
  ] },
  { id: "paid", label: "From an offer to first payment", goal: "Paid subscriptions", kind: "funnel", status: "planned", version: 1, steps: [
    { id: "offer", label: "View subscription offer", alternatives: [{ eventName: "subscription_offer_view" }] },
    { id: "checkout", label: "Begin checkout", alternatives: [{ eventName: "begin_checkout" }], withinSeconds: 2592000 },
    { id: "paid", label: "First payment confirmed", alternatives: [{ eventName: "purchase", parameters: [{ name: "payment_kind", value: "initial_paid" }] }], withinSeconds: 2592000 },
  ] },
  { id: "explore", label: "Where visitors go next", goal: "Exploration", kind: "exploration", status: "planned", version: 1, steps: [
    { id: "entry", label: "Useful page", alternatives: [{ eventName: "page_view" }] },
    { id: "destination", label: "Next useful destination", alternatives: [{ eventName: "page_view", pagePath: "/recipes" }, { eventName: "page_view", pagePath: "/guides" }] },
  ] },
];

export const JOURNEY_DEMO_WEEKS = [
  [2600, 1900, 650, 550, 500], [2700, 2000, 670, 560, 510],
  [2800, 2100, 710, 600, 550], [2900, 2200, 820, 690, 640],
  [2800, 2250, 860, 720, 610], [3000, 2440, 980, 840, 720],
  [3000, 2230, 780, 650, 600], [3200, 2480, 980, 790, 710],
];
const ACTIVATION_WEEKS = [[500, 265], [510, 280], [550, 300], [640, 365], [610, 366], [720, 448], [600, 330], [710, 440]];
const day = (offset: number) => new Date(Date.UTC(2026, 7, 24 + offset)).toISOString().slice(0, 10);
function demoResult(definition: JourneyDefinition, counts: number[][]): JourneyFunnelResult {
  const period = (kind: JourneyPeriod["kind"], first: number, last: number): JourneyPeriod => ({
    kind, startDate: day(first * 7), endDate: day(last * 7 + 6), complete: true, quality: "complete",
    steps: definition.steps.map((step, i) => ({ id: step.id, users: counts.slice(first, last + 1).reduce((sum, row) => sum + row[i]!, 0) })),
    visitors: { users: counts.slice(first, last + 1).reduce((sum, row) => sum + row[0]! * 2, 0), quality: "complete" },
  });
  return { journeyId: definition.id, definitionId: journeyDefinitionId(definition), propertyId: "123456789", timeZone: "UTC", identity: "ga4-active-users", collectedAt: "2026-10-25T08:00:00Z", current7: period("current7", 7, 7), prior7: period("prior7", 6, 6), current28: period("current28", 4, 7), prior28: period("prior28", 0, 3), weekly: counts.map((_, i) => period("week", i, i)) };
}

export const JOURNEY_DEMO_SNAPSHOT: JourneySnapshot = {
  source: "ga4", countingUnit: "activeUsers", generatedAt: "2026-10-25T08:00:00Z", definitions: JOURNEY_DEMO_DEFINITIONS,
  funnels: [demoResult(JOURNEY_DEMO_DEFINITIONS[0]!, JOURNEY_DEMO_WEEKS), demoResult(JOURNEY_DEMO_DEFINITIONS[1]!, ACTIVATION_WEEKS)],
  exploration: { state: "unsupported", reason: "Session paths require separate collection. An ordered user report does not measure session destinations." },
};
