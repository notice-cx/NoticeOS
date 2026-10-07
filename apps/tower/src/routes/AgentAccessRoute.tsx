import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/EmptyState';
import { describeAgent, decideAgent, type AgentRequest } from '@/lib/agent-access';
import type { BrowserEntry, BrowserEntryState } from '@/lib/browser-entry';

/** What each scope lets the agent do, in the person's words. */
const ACCESS: Readonly<Record<string, string>> = {
  'tasks:read': 'Read tasks and their history',
  'tasks:write': 'Create, claim, update, comment on and close tasks',
  'evidence:read': 'Read property reports and research',
};

/** Agent sign-in (epic ro-cvl9): the one decision a person makes for an
 * agent. Choosing a workspace allows the agent there; nothing else is asked.
 * A viewer's agent only reads, whatever it requested. */
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
  async function decide(workspaceId?: string) {
    if (busy || !query || !sessionId) return;
    const abort = new AbortController();
    pending.current = abort;
    setBusy(true); setFailed(false);
    try {
      window.location.assign(await decideAgent(entry.fetch, { query, sessionId, ...(workspaceId ? { workspaceId } : {}) }, abort.signal));
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
    <ul className="list-disc space-y-1 pl-5 text-sm">
      {request.scopes.filter(scope => ACCESS[scope]).map(scope => <li key={scope}>{ACCESS[scope]}</li>)}
    </ul>
    <h2 className="text-sm font-medium">Allow it in</h2>
    {state.choices.length === 0 ? <EmptyState title="No workspaces yet" /> : <ul className="space-y-2">
      {state.choices.map(workspace => <li key={workspace.workspaceId}>
        <Button className="h-auto min-h-11 w-full justify-between whitespace-normal text-left" variant="outline"
          disabled={busy || workspace.status !== 'active'} onClick={() => void decide(workspace.workspaceId)}>
          <span>{workspace.displayName}</span>
          <span className="ml-3 text-xs text-muted-foreground">{workspace.status !== 'active' ? workspace.status
            : workspace.role === 'viewer' ? 'read only' : workspace.role}</span>
        </Button>
      </li>)}
    </ul>}
    {state.session?.mode === 'hosted' && state.session.nextCursor ? <Button variant="outline" disabled={state.loadingMore || busy}
      onClick={() => void entry.loadMore()}>{state.loadingMore ? 'Loading…' : 'More workspaces'}</Button> : null}
    {failed ? <span role="status" data-status-for="agent-access" className="text-sm text-error">Could not connect the agent. Try again.</span> : null}
    <Button variant="ghost" disabled={busy} onClick={() => void decide()}>Don't allow</Button>
  </section>;
}
