import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate } from 'react-router-dom';
import { PageHeader } from '@/components/PageHeader';
import { ReadFailed } from '@/components/ReadFailed';
import { Button } from '@/components/ui/button';
import { fieldClass } from '@/components/ui/field';
import { Panel } from '@/components/surface/Panel';
import { useBrowserContext, useOwnerMutation } from '@/lib/browser-context';
import { DISPLAY_NAME_LIMIT, normalizedDisplayName } from '../../../../scripts/identity-protocol.mjs';

const PROFILE = ['personal-profile'];

export default function ProfileRoute() {
  const { runtime } = useBrowserContext();
  return runtime.owner.mode === 'hosted' ? <PersonalProfile /> : <Navigate to="/" replace />;
}

function PersonalProfile() {
  const { runtime, workspaceLabel, workspaceRole, backupPreview } = useBrowserContext();
  const [draft, setDraft] = useState<string | null>(null);
  const read = useQuery({ queryKey: PROFILE, queryFn: ({ signal }) => runtime.api.fetchPersonalProfile(signal) });
  const profile = read.data;
  const name = normalizedDisplayName(draft);
  const save = useOwnerMutation({
    mutationFn: runtime.api.savePersonalDisplayName,
    onSuccess: updated => {
      runtime.queries.setQueryData(PROFILE, updated);
      setDraft(null);
    },
  });
  const editable = profile?.editable === true && !backupPreview;
  const canSave = editable && name !== null && name !== profile.displayName && !save.isPending;
  return <div className="flex w-full max-w-2xl flex-col gap-5 p-4 md:p-6">
    <PageHeader title="Profile" actions={<Button asChild variant="outline" className="max-sm:min-h-11">
      <Link to="/">Back to workspace</Link>
    </Button>} />
    {read.isError ? <ReadFailed title="Couldn't load profile" subject="read:profile" error={read.error}
      retrying={read.isFetching} onRetry={() => void read.refetch()} /> : profile ? <>
      <Panel title="Personal details" bodyLayout="stack">
        <dl className="grid gap-4 sm:grid-cols-2">
          {!editable ? <div><dt className="text-sm text-muted-foreground">Display name</dt>
            <dd className="break-words">{profile.displayName || 'No display name'}</dd></div> : null}
          <div><dt className="text-sm text-muted-foreground">Verified email</dt>
            <dd className="break-words">{profile.email}</dd></div>
        </dl>
        {editable ? <form className="grid gap-3" onSubmit={event => {
          event.preventDefault();
          if (canSave && name !== null) save.mutate(name);
        }}>
          <div className="space-y-1.5">
            <label htmlFor="profile-name" className="block text-sm font-medium">Display name *</label>
            <input id="profile-name" className={`${fieldClass} w-full max-w-sm`} autoComplete="name"
              required maxLength={DISPLAY_NAME_LIMIT} disabled={save.isPending} value={draft ?? profile.displayName}
              onChange={event => { save.reset(); setDraft(event.target.value); }} />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={!canSave}>{save.isPending ? 'Saving…' : 'Save name'}</Button>
            {save.isSuccess ? <span role="status" data-status-for="profile:display-name" className="text-sm text-muted-foreground">Name saved.</span> : null}
            {save.isError ? <span role="alert" className="text-sm text-error">Couldn't save your name. Try again.</span> : null}
          </div>
        </form> : null}
      </Panel>
      <Panel title="Current workspace" bodyLayout="stack">
        <div className="break-words font-medium">{workspaceLabel}</div>
        <div className="text-sm capitalize text-muted-foreground">{workspaceRole}</div>
      </Panel>
    </> : <div role="status" data-status-for="read:profile" className="text-sm text-muted-foreground">Loading profile…</div>}
  </div>;
}
