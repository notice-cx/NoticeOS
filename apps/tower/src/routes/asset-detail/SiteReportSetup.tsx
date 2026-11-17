import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { useBrowserRuntime, useOwnerMutation } from '@/lib/browser-context';
import { Panel } from '@/routes/asset-detail/shared';

export function SiteReportSetup({ asset }: { asset: string }) {
  const runtime = useBrowserRuntime();
  const api = runtime.api;
  const [token, setToken] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<'issue' | 'revoke' | null>(null);
  const grant = useQuery({
    queryKey: ['site-report-grant', asset],
    queryFn: ({ signal }) => api.fetchSiteReportGrant(asset, signal),
  });
  const change = useOwnerMutation({
    mutationFn: async (action: 'issue' | 'revoke') => {
      const value = action === 'issue' ? await api.issueSiteReportToken(asset) : await api.revokeSiteReportToken(asset);
      runtime.guard(() => setToken(value ?? null))();
    },
    onSuccess: () => {
      setConfirmation(null);
      return grant.refetch();
    },
  });
  const accessDenied = grant.error instanceof ApiError && (grant.error.status === 401 || grant.error.status === 403);
  const refreshError = grant.isError ? <div className="space-y-2">
    <p role="alert">Could not read report setup.</p>
    {!accessDenied ? <Button variant="outline" disabled={grant.isFetching} onClick={() => void grant.refetch()}>
      Retry reading report setup
    </Button> : null}
  </div> : null;
  const controlsDisabled = change.isPending || grant.isError;

  return <Panel id="data-collection" title="Daily reports">
    {grant.isPending ? <p>Reading report setup…</p>
    : grant.data === undefined || accessDenied ? refreshError
    : grant.data === null ? <p>Report intake is unavailable for this workspace.</p>
    : <div className="space-y-3">
        <p>Send daily counts such as sign-ups or saved items to <code>POST /api/pulse</code>.</p>
        {refreshError ?? <p>{grant.data.issued ? 'A report token is active.' : 'This asset needs a report token.'}</p>}
        {confirmation ? <div className="space-y-2">
          <p>{confirmation === 'issue'
            ? 'The old token stops working as soon as you replace it.'
            : 'Set a new token before sending another report.'}</p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={controlsDisabled} onClick={() => change.mutate(confirmation)}>
              {confirmation === 'issue' ? 'Replace token' : 'Revoke token'}
            </Button>
            <Button variant="outline" disabled={change.isPending} onClick={() => setConfirmation(null)}>Cancel</Button>
          </div>
        </div> : (grant.data.mayIssue || grant.data.mayRevoke && grant.data.issued) ? <div className="flex flex-wrap gap-2">
          {grant.data.mayIssue ? <Button disabled={controlsDisabled} onClick={() => {
            if (grant.data?.issued) setConfirmation('issue');
            else change.mutate('issue');
          }}>{grant.data.issued ? 'Replace token' : 'Create token'}</Button> : null}
          {grant.data.issued && grant.data.mayRevoke ? <Button variant="outline" disabled={controlsDisabled}
            onClick={() => setConfirmation('revoke')}>Revoke token</Button> : null}
        </div> : null}
        {token ? <div className="space-y-1">
          <p>Copy this token to your server. It is shown once.</p>
          <code className="block break-all">{token}</code>
          <Button variant="ghost" onClick={() => setToken(null)}>Hide token</Button>
        </div> : null}
        {change.isError ? <p role="alert">Could not update the report token.</p> : null}
      </div>}
  </Panel>;
}
