// Shared generation budget and fixed operator messages; never provider response text.
export const MODEL_GENERATION_TIMEOUT_MS = 10 * 60_000;

export const PORTFOLIO_BRIEF_FAILURES: Readonly<Record<string, { summary: string; action: string }>> = {
  timeout: {
    summary: `The model did not finish within ${MODEL_GENERATION_TIMEOUT_MS / 60_000} minutes.`,
    action: 'Check whether the model is still loading or serving other requests. Retry when it is ready.',
  },
  network: {
    summary: 'NoticeOS could not complete the request to the model server.',
    action: 'Check that the model server is running and reachable from NoticeOS, then retry.',
  },
  access: {
    summary: 'The model server refused access.',
    action: 'Review the API token and model permissions in Integrations, then retry.',
  },
  'rate-limited': {
    summary: 'The model server rejected the request because of a usage limit.',
    action: 'Check the provider’s request limit or quota before retrying.',
  },
  'not-found': {
    summary: 'The model server returned “not found” for the generation request.',
    action: 'Check the API base URL and selected model in Integrations.',
  },
  'model-missing': {
    summary: 'The selected model is no longer available.',
    action: 'Refresh the model list in Integrations and select an available model.',
  },
  configuration: {
    summary: 'The model connection settings are invalid.',
    action: 'Review the API base URL and selected model in Integrations.',
  },
  redirect: {
    summary: 'The model server redirected the generation request.',
    action: 'Use the final API base URL in Integrations, then retry.',
  },
  'invalid-response': {
    summary: 'The model response did not pass the briefing checks.',
    action: 'Retry the briefing. If this repeats, review the selected model’s support for structured JSON responses.',
  },
  'too-large': {
    summary: 'The model request or response exceeded the size limit.',
    action: 'Check the model server’s response settings before retrying.',
  },
  'not-supported': {
    summary: 'Model generation is unavailable in this installation.',
    action: 'Use a standalone installation to generate portfolio briefings.',
  },
  unknown: {
    summary: 'The briefing could not be generated.',
    action: 'Check the model connection in Integrations, then retry.',
  },
};

export function portfolioBriefFailure(failure?: { kind?: unknown } | null): { summary: string; action: string } {
  const kind = typeof failure?.kind === 'string' && Object.hasOwn(PORTFOLIO_BRIEF_FAILURES, failure.kind) ? failure.kind : 'unknown';
  return PORTFOLIO_BRIEF_FAILURES[kind]!;
}
