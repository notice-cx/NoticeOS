import { Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { toast } from 'sonner';
import { BrandLockup } from '@/components/BrandLockup';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/EmptyState';
import { AppToaster } from '@/lib/toaster';
import { BrowserRuntimeProvider } from '@/lib/browser-context';
import { captureBrowserLanding, createBrowserEntry, type BrowserEntry as Entry } from '@/lib/browser-entry';
import { demoVisitBase } from '@/lib/demo-visit';
import { demoViewer } from '@shared/demo-viewer';
import { createTowerRouter } from '@/App';
import { StatusBanner } from '@/components/surface/StatusBanner';
import { lazyPart } from '@/lib/lazy-route';
import { RouteLoadFailure, RouteLoading } from '@/components/RouteLoading';

const SignInRoute = lazyPart(
  () => import('@/routes/SignInRoute').then(module => module.SignInRoute),
  { failure: () => <RouteLoadFailure /> },
).Component;

export function BrowserEntry({ createEntry }: { createEntry: () => Entry }) {
  const [entry, setEntry] = useState<Entry | null>(null);
  useEffect(() => {
    const owned = createEntry();
    setEntry(owned);
    void owned.refresh();
    return () => owned.dispose();
  }, [createEntry]);
  return entry ? <EntryContent entry={entry} /> : <main className="p-6"><EmptyState title="Checking your session…" /></main>;
}
function EntryContent({ entry }: { entry: Entry }) {
  return <><AppUpdateNotice release={entry.appRelease} /><EntryView entry={entry} /></>;
}
const reloadPage = () => window.location.reload();

export function AppUpdateNotice({ release, reload = reloadPage }: {
  release: Entry['appRelease']; reload?: () => void;
}) {
  const state = useSyncExternalStore(release.subscribe, release.snapshot, release.snapshot);
  const reloading = useRef(false);
  useEffect(() => {
    // Only the display route is disposable; /wall/edit and desk drafts stay open.
    if (state === 'changed' && window.location.pathname === '/wall' && !reloading.current) {
      reloading.current = true;
      reload();
    }
  }, [state, reload]);
  useEffect(() => {
    if (state !== 'unavailable' || window.location.pathname !== '/wall') return;
    let controller: AbortController | null = null;
    let closed = false;
    let checking = false;
    const interval = window.setInterval(() => {
      if (checking) return;
      checking = true;
      const attempt = new AbortController();
      controller = attempt;
      const timeout = window.setTimeout(() => attempt.abort(), 10_000);
      void release.displayReadyToReload(attempt.signal).then(ready => {
        if (ready && !closed && !attempt.signal.aborted && !reloading.current) { reloading.current = true; reload(); }
      }).catch(() => {}).finally(() => { window.clearTimeout(timeout); checking = false; });
    }, 30_000);
    return () => { closed = true; window.clearInterval(interval); controller?.abort(); };
  }, [state, release, reload]);
  if (state === 'current') return null;
  return <div className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-xl shadow-lg" data-app-update>
    <StatusBanner subject="app:release" lead={state === 'changed' ? 'NoticeOS updated' : 'App version unavailable'}>
      <a className="font-medium text-foreground underline underline-offset-4" href={window.location.href}
        target="_blank" rel="noopener noreferrer">Open app in new tab</a>
    </StatusBanner>
  </div>;
}

function EntryView({ entry }: { entry: Entry }) {
  const state = useSyncExternalStore(entry.subscribe, entry.snapshot, entry.snapshot);
  if (state.phase === 'ready' && state.runtime) {
    return <OwnedDesk key={state.runtime.ownerKey} runtime={state.runtime} label={state.label} entry={entry}
      role={state.session?.mode === 'hosted' ? state.session.selectedWorkspace?.role : undefined} />;
  }
  return <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-6">
    <BrandLockup />
    {state.phase === 'checking' ? <EmptyState title="Checking your session…" /> : null}
    {state.phase === 'unavailable' ? <><EmptyState title="Workspace unavailable" /><Button onClick={() => void entry.refresh()}>Retry</Button></> : null}
    {state.phase === 'signed-out' ? <Suspense fallback={<RouteLoading />}><SignInRoute entry={entry} /></Suspense> : null}
    {state.phase === 'invitation' ? <>
      <h1 className="text-lg font-semibold">Join workspace</h1>
      {state.label ? <span role="status" data-status-for="invitation" className="text-sm text-error">{state.label}</span> : null}
      <Button onClick={() => void entry.joinInvitation()}>Accept invitation</Button>
      <Button variant="ghost" onClick={() => void entry.logout()}>Use another account</Button>
    </> : null}
    {state.phase === 'invalid-link' ? <EmptyState title="Sign-in link is invalid" /> : null}
    {state.phase === 'choose' ? <>
      <h1 className="text-lg font-semibold">Choose a workspace</h1>
      {state.choices.length === 0 ? <EmptyState title="No workspaces yet" /> : <ul className="space-y-2">
        {state.choices.map(workspace => <li key={workspace.workspaceId}>
          <Button className="h-auto min-h-11 w-full justify-between whitespace-normal text-left" variant="outline"
            disabled={workspace.status !== 'active'} onClick={() => void entry.choose(workspace.workspaceId)}>
            <span>{workspace.displayName}</span>
            <span className="ml-3 text-xs text-muted-foreground">{workspace.status === 'active' ? workspace.role : workspace.status}</span>
          </Button>
        </li>)}
      </ul>}
      {state.session?.mode === 'hosted' && state.session.nextCursor ? <Button variant="outline" disabled={state.loadingMore} onClick={() => void entry.loadMore()}>
        {state.loadingMore ? 'Loading…' : 'More workspaces'}
      </Button> : null}
      <Button variant="ghost" onClick={() => void entry.logout()}>Sign out</Button>
    </> : null}
  </main>;
}

function OwnedDesk({ runtime, label, entry, role }: {
  runtime: NonNullable<ReturnType<Entry['snapshot']>['runtime']>; label: string | null; entry: Entry;
  role?: 'owner' | 'operator' | 'viewer';
}) {
  const [router, setRouter] = useState<ReturnType<typeof createTowerRouter> | null>(null);
  useEffect(() => {
    const owned = createTowerRouter();
    setRouter(owned);
    return () => owned.dispose();
  }, []);
  if (!router) return <main className="p-6"><EmptyState title="Opening workspace…" /></main>;
  return <BrowserRuntimeProvider value={{ runtime, workspaceLabel: label,
    workspaceRole: role, refreshSession: entry.refresh,
    switchWorkspace: runtime.owner.mode === 'hosted' ? entry.switchWorkspace : undefined,
    logout: runtime.owner.mode === 'hosted' ? entry.logout : undefined }}>
    <QueryClientProvider client={runtime.queries}><RouterProvider router={router} /><AppToaster /></QueryClientProvider>
  </BrowserRuntimeProvider>;
}

export function createPageEntryFactory() {
  const landing = captureBrowserLanding(window);
  const base = demoVisitBase();
  return () => createBrowserEntry({ origin: window.location.origin, fetch: window.fetch.bind(window), page: window, landing,
    base: base === '/' ? undefined : base,
    compiledDemoWorkspace: demoViewer()?.workspaceId,
    onRetire: () => toast.dismiss(),
  });
}
