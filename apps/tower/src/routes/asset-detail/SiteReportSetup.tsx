import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
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
      void grant.refetch();
    },
  });

  return <Panel id="data-collection" title="Daily site reports">
    {grant.isPending ? <p>Reading report setup…</p>
    : grant.isError ? <p role="alert">Could not read report setup.</p>
    : grant.data === null ? <p>Report intake is unavailable for this workspace.</p>
    : <div className="space-y-3">
        <p>Send daily counts such as sign-ups or saved items to <code>POST /api/pulse</code>.</p>
        <p>{grant.data.issued ? 'A report token is active.' : 'This site needs a report token.'}</p>
        {confirmation ? <div className="space-y-2">
          <p>{confirmation === 'issue'
            ? 'The old token stops working as soon as you replace it.'
            : 'Reports stop until the site has a new token.'}</p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={change.isPending} onClick={() => change.mutate(confirmation)}>
              {confirmation === 'issue' ? 'Replace token' : 'Revoke token'}
            </Button>
            <Button variant="outline" disabled={change.isPending} onClick={() => setConfirmation(null)}>Cancel</Button>
          </div>
        </div> : (grant.data.mayIssue || grant.data.mayRevoke && grant.data.issued) ? <div className="flex flex-wrap gap-2">
          {grant.data.mayIssue ? <Button disabled={change.isPending} onClick={() => {
            if (grant.data?.issued) setConfirmation('issue');
            else change.mutate('issue');
          }}>{grant.data.issued ? 'Replace token' : 'Create token'}</Button> : null}
          {grant.data.issued && grant.data.mayRevoke ? <Button variant="outline" disabled={change.isPending}
            onClick={() => setConfirmation('revoke')}>Revoke token</Button> : null}
        </div> : null}
        {token ? <div className="space-y-1">
          <p>Copy this token to your site’s server. It is shown once.</p>
          <code className="block break-all">{token}</code>
          <Button variant="ghost" onClick={() => setToken(null)}>Hide token</Button>
        </div> : null}
        {change.isError ? <p role="alert">Could not update the report token.</p> : null}
      </div>}
  </Panel>;
}
