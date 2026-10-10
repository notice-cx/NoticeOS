import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/EmptyState';
import { describeAgent, decideAgent, type AgentRequest } from '@/lib/agent-access';
import type { BrowserEntry, BrowserEntryState } from '@/lib/browser-entry';

/** What each scope lets the agent do, in the person's words. */
const ACCESS: Readonly<Record<string, string>> = {
  'tasks:read': 'Read tasks and their history',
  'tasks:write': 'Create, claim, update, comment on and close tasks',
  'evidence:read': 'Read site reports and research',
};

/** Agent sign-in: the one decision a person makes for an
 * agent. Allowing it covers every workspace the person belongs to; in each,
 * the person's own role still bounds what the agent may do. */
export function AgentAccessRoute({ entry, state }: { entry: BrowserEntry; state: BrowserEntryState }) {
  const query = entry.agentQuery;
  const sessionId = state.session?.mode === 'hosted' ? state.session.session?.sessionId : undefined;
  const [request, setRequest] = useState<AgentRequest | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!query) { setInvalid(true); return; }
    const abort = new AbortController();
    describeAgent(entry.fetch, query, abort.signal).then(setRequest, () => { if (!abort.signal.aborted) setInvalid(true); });
    return () => { abort.abort(); pending.current?.abort(); };
  }, [entry, query]);
  async function decide(accept: boolean) {
    if (busy || !query || !sessionId) return;
    const abort = new AbortController();
    pending.current = abort;
    setBusy(true); setFailed(false);
    try {
      window.location.assign(await decideAgent(entry.fetch, { query, sessionId, accept }, abort.signal));
    } catch {
      if (!abort.signal.aborted) { setFailed(true); setBusy(false); }
    }
  }
  if (invalid) return <EmptyState title="This agent request expired. Start again from your agent." />;
  if (!request) return <EmptyState title="Checking the agent…" />;
  return <section className="flex flex-col gap-4" aria-labelledby="agent-access-title">
    <div className="space-y-1">
      <h1 id="agent-access-title" className="text-lg font-semibold">Connect {request.client.name}</h1>
      <p className="text-sm text-muted-foreground">Name given by the agent; not verified</p>
    </div>
    <div className="space-y-1">
      <h2 className="text-sm font-medium">In each of your workspaces, it may</h2>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {request.scopes.filter(scope => ACCESS[scope]).map(scope => <li key={scope}>{ACCESS[scope]}</li>)}
      </ul>
      <p className="text-sm text-muted-foreground">Your role in a workspace still limits it.</p>
    </div>
    {failed ? <span role="status" data-status-for="agent-access" className="text-sm text-error">Could not connect the agent. Try again.</span> : null}
    <Button disabled={busy} onClick={() => void decide(true)}>{busy ? 'Working…' : 'Allow'}</Button>
    <Button variant="ghost" disabled={busy} onClick={() => void decide(false)}>Don't allow</Button>
  </section>;
}
