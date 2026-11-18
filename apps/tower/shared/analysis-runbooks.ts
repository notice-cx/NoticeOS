export type AnalysisTemplateId = "weekly-search-review" | "seo-ai-visibility";

export interface AnalysisRunbook {
  id: AnalysisTemplateId;
  version: number;
  title: string;
  question: string;
  inputs: string[];
  steps: { id: string; title: string; instruction: string }[];
  output: string;
}

export const ANALYSIS_RUNBOOKS: readonly AnalysisRunbook[] = [
  {
    id: "weekly-search-review",
    version: 1,
    title: "Weekly search review",
    question: "What changed in search this week, and does it warrant action?",
    inputs: ["Google Search Console and Bing Webmaster Tools", "Tracked search results and AI citations", "Open measurement periods"],
    steps: [
      { id: "coverage", title: "Check the reports", instruction: "Read the dates and coverage for each source. Compare two complete weeks from the same search engine. Check which tracked queries and devices returned a result." },
      { id: "movement", title: "Find meaningful changes", instruction: "Identify the pages or queries behind a change. Look at clicks and impressions together. Read AI citations separately by device. Leave rank conclusions open when the organic results are unreliable." },
      { id: "experiments", title: "Check work already in progress", instruction: "Review recent changes, open tasks and experiments for the affected page. Add evidence to an existing follow-up when the measurement period is still open." },
      { id: "decision", title: "Record the decision", instruction: "Choose up to three actions by page or search intent. Cite each result, describe the smallest test and say how to judge it. Record why when the evidence supports leaving a page alone." },
    ],
    output: "Findings with dated evidence, no action warranted, or insufficient data.",
  },
  {
    id: "seo-ai-visibility",
    version: 1,
    title: "SEO & AI search visibility",
    question: "Where can this asset earn more useful search traffic or appear as a source in AI answers?",
    inputs: ["Search Console and Bing page or query reports", "Sampled Google and ChatGPT mentions", "GA4 usage and product events", "Open measurement periods"],
    steps: [
      { id: "scope", title: "Choose pages and topics to assess", instruction: "Read the reports available for the selected assets. Identify the pages and search intents with enough evidence, and record the dates and coverage." },
      { id: "search", title: "Evaluate search performance", instruction: "Compare observed clicks and impressions by page. Check relevant user outcomes where measured. Keep modeled demand separate from traffic the asset received." },
      { id: "ai", title: "Evaluate AI visibility", instruction: "Compare mentions and citations within each sampled platform. Check the query and device where available. An unmeasured platform stays unknown. A mention alone establishes neither a click nor a sale." },
      { id: "test", title: "Prioritize a change or leave the page alone", instruction: "Group the evidence by page or intent. Review existing experiments. For each proposed change, name a success measure, the comparison period and when to stop. Record material gaps." },
    ],
    output: "A short page-by-page evaluation with evidence and a measurable next step, or a reason to take no action.",
  },
];

export function analysisRunbook(id: AnalysisTemplateId): AnalysisRunbook {
  const runbook = ANALYSIS_RUNBOOKS.find(template => template.id === id);
  if (!runbook) throw new Error("Unknown analysis template.");
  return runbook;
}

export interface AnalysisCitation {
  id: string;
  assetId: string;
  source: string;
  label: string;
  observedAt: string;
  href: string;
  readings: { label: string; value: number | string | boolean | null }[];
  note: string;
  /** Identifies the underlying retained asset report; readings survive its rotation. */
  snapshotId?: string;
}

export interface AnalysisEvidence {
  asOf: string;
  citations: AnalysisCitation[];
  coverage: {
    assetId: string;
    source: string;
    status: "available" | "limited" | "unavailable";
    detail: string;
  }[];
}
