/**
 * The reads a standalone Tower or shared demo pushes changes of. The server reads each one
 * itself every `CHANGE_CHECK_MS` while a page listens, with its validator
 * (`shared/read-validator.ts`), and tells every open page which changed; a
 * page that hears from the stream stops polling them. Hosted workspaces and visit-prefixed demos have no global stream and poll.
 */
export const CHANGE_STREAM_PATH = '/api/changes';
export const CHANGE_CHECK_MS = 15_000;

export const CHANGE_TOPICS = [
  { topic: 'work', path: '/api/work' },
  { topic: 'wall', path: '/api/wall' },
  { topic: 'wall-feed', path: '/api/wall/feed' },
  { topic: 'integration-health', path: '/api/integrations/health' },
] as const;

export type ChangeTopic = (typeof CHANGE_TOPICS)[number]['topic'];

/** What the stream sends: the topics whose content changed, or a topic whose
 * content is unchanged with the answer times of its latest read. */
export type ChangeEvent =
  | { kind: 'change'; topics: ChangeTopic[] }
  | { kind: 'fresh'; topic: ChangeTopic; times: Record<string, string> };

export function isChangeTopic(value: unknown): value is ChangeTopic {
  return CHANGE_TOPICS.some((entry) => entry.topic === value);
}
