import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { fieldClass } from '@/components/ui/field';
import { ReadFailed } from '@/components/ReadFailed';
import { useBrowserContext, useCanManageMembers } from '@/lib/browser-context';
import { SettingsPanel } from '@/routes/settings/SettingsPanel';
import { ApiError } from '@/lib/api';
import { MembershipRefused, type MemberCommand, type MemberRole, type MembershipPage, type WorkspaceMember, type WorkspaceInvitation } from '@/lib/membership-client';

const ROLES: MemberRole[] = ['owner', 'operator', 'viewer'];
const QUERY = ['workspace-members'];
type Roster = { members: MembershipPage<WorkspaceMember>; invitations: MembershipPage<WorkspaceInvitation> };
const accessDenied = (error: unknown) => error instanceof MembershipRefused && error.status === 403;
const rosterRefused = new ApiError('Could not verify access to members.', 403);
export function MembersSection() {
  return useCanManageMembers() ? <OwnerMembers /> : null;
}

/** Administration uses the captured runtime; bootstrap role only hides controls.
 * Saved invitations survive mail failure and are retried by their existing ID. */
function OwnerMembers() {
  const { runtime, refreshSession, revalidateSession } = useBrowserContext();
  // Another member's change leaves this page as it is; a change to the
  // operator's own access rebuilds it with the access the server now grants.
  const recheckAccess = revalidateSession ?? refreshSession;
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MemberRole>('viewer');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const issuing = useRef(false);
  const rosterVersion = useRef(0);
  const pagination = useRef<AbortController | null>(null);
  useEffect(() => () => pagination.current?.abort(), []);
  // An offline refresh must settle while it holds the roster lock.
  const read = useQuery({ queryKey: QUERY, networkMode: 'always', refetchOnReconnect: true, queryFn: async ({ signal }): Promise<Roster | null> => {
    const pending = new AbortController();
    const deadline = AbortSignal.any([signal, pending.signal, AbortSignal.timeout(10_000)]);
    // Keep waiting after a temporary error so a refusal in the other read can take precedence.
    const readOne = <Value,>(request: Promise<Value>) => request.then(value => ({ value }), (error: unknown) => {
      if (accessDenied(error)) throw error;
      return { error };
    });
    try {
      const [members, invitations] = await Promise.all([readOne(runtime.api.fetchMembers(undefined, deadline)), readOne(runtime.api.fetchInvitations(undefined, deadline))]);
      if ('error' in members) throw members.error;
      if ('error' in invitations) throw invitations.error;
      rosterVersion.current++;
      return { members: members.value, invitations: invitations.value };
    } catch (error) {
      if (!accessDenied(error)) throw error;
      pending.abort();
      pagination.current?.abort();
      return null;
    }
  } });
  const roster = read.data;
  const refused = roster === null;
  const readError = read.error instanceof MembershipRefused ? new ApiError(read.error.message, read.error.status) : read.error;
  useEffect(() => {
    if (refused && runtime.guard(() => true)() === true) void recheckAccess?.();
  }, [refused, read.dataUpdatedAt, recheckAccess, runtime]);
  const update = runtime.guard((callback: () => void) => callback());
  async function refreshAccess() {
    if (issuing.current || runtime.guard(() => true)() !== true) return;
    issuing.current = true; setBusy(true); setNotice(null);
    try {
      await read.refetch({ throwOnError: true });
    } catch {
      if (runtime.queries.getQueryData(QUERY) != null) update(() => setNotice({ error: true, text: 'People and invitations could not be refreshed. Try again.' }));
    } finally {
      issuing.current = false; update(() => setBusy(false));
    }
  }
  async function execute(command: MemberCommand) {
    if (issuing.current || runtime.guard(() => true)() !== true) return;
    issuing.current = true; setBusy(true); setNotice(null);
    let saved = false;
    try {
      await runtime.api.manageMembership(command); saved = true;
      update(() => setNotice({ error: false, text: command.kind === 'invite' ? 'Invitation sent.' : command.kind === 'resend' ? 'Invitation resent.' : 'Access updated.' }));
    } catch (error) {
      saved = error instanceof MembershipRefused && !!error.invitationId;
      update(() => setNotice({ error: true, text: error instanceof MembershipRefused ? error.message : 'Access change failed. Try again.' }));
    } finally {
      if (saved) {
        update(() => { if (command.kind === 'invite') setEmail(''); });
        if (runtime.guard(() => true)() === true) await runtime.queries.invalidateQueries({ queryKey: QUERY });
        if ((command.kind === 'change-role' || command.kind === 'remove') && runtime.guard(() => true)() === true) await recheckAccess?.();
      }
      issuing.current = false; update(() => setBusy(false));
    }
  }
  async function more(collection: 'members' | 'invitations') {
    const cursor = roster?.[collection].nextCursor;
    if (!cursor || issuing.current || runtime.guard(() => true)() !== true) return;
    const version = rosterVersion.current;
    const page = new AbortController();
    const signal = AbortSignal.any([page.signal, AbortSignal.timeout(10_000)]);
    pagination.current = page;
    issuing.current = true; setBusy(true); setNotice(null);
    try {
      const next = collection === 'members' ? await runtime.api.fetchMembers(cursor, signal) : await runtime.api.fetchInvitations(cursor, signal);
      update(() => {
        const previous = runtime.queries.getQueryData<Roster | null>(QUERY);
        if (!previous || page.signal.aborted || version !== rosterVersion.current) return;
        const old = previous[collection];
        // De-duplicate a concurrent roster change across cursor pages.
        const items = [...old.items, ...next.items.filter(item => !old.items.some(existing => existing.id === item.id))];
        runtime.queries.setQueryData(QUERY, { ...previous, [collection]: { items, nextCursor: next.nextCursor } });
      });
    } catch (error) {
      if (page.signal.aborted) return;
      if (accessDenied(error)) {
        await runtime.queries.cancelQueries({ queryKey: QUERY, exact: true });
        if (!page.signal.aborted) update(() => runtime.queries.setQueryData(QUERY, null));
      } else {
        update(() => setNotice({ error: true, text: collection === 'members' ? 'More people could not be loaded. Try again.' : 'More invitations could not be loaded. Try again.' }));
      }
    } finally {
      pagination.current = null;
      issuing.current = false;
      update(() => setBusy(false));
    }
  }
  const oneOwner = roster?.members.nextCursor === null && roster.members.items.filter(member => member.role === 'owner').length === 1;
  return <>
    <SettingsPanel title="Invite" aside={<Button variant="ghost" size="sm" disabled={busy} onClick={() => void refreshAccess()}>Refresh access</Button>}>
      <form className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); void execute({ kind: 'invite', email, role }); }}>
        <div className="min-w-0 flex-[2] basis-52 space-y-1.5">
          <label htmlFor="invite-email" className="block text-sm font-medium">Email *</label>
          <input className={`${fieldClass} w-full`} id="invite-email" type="email" autoComplete="email" maxLength={320} required value={email}
            disabled={busy} onChange={event => setEmail(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="invite-role" className="block text-sm font-medium">Role</label>
          <RoleSelect id="invite-role" value={role} disabled={busy} onChange={setRole} />
        </div>
        <Button type="submit" disabled={busy || !roster}>Invite</Button>
      </form>
      {notice ? <div role="status" data-status-for="members" className={`mt-3 text-sm ${notice.error ? 'text-error' : 'text-muted-foreground'}`}>{notice.text}</div> : null}
    </SettingsPanel>
    {!roster ? read.isError || refused ? <ReadFailed title={refused ? "Couldn't verify access to members" : "Couldn't load members"}
        subject="read:members" error={refused ? readError ?? rosterRefused : readError} retrying={busy || read.isFetching} onRetry={() => void refreshAccess()} />
      : <div role="status" data-status-for="members" className="text-sm text-muted-foreground">Loading members…</div> : <>
      <SettingsPanel title="People">
        <ul className="divide-y divide-border">{roster.members.items.map(member => <MemberRow key={`${member.id}:${member.role}`} member={member}
          busy={busy} lastOwner={oneOwner && member.role === 'owner'} execute={execute} />)}</ul>
        {roster.members.nextCursor ? <Button variant="outline" className="mt-3 self-start" disabled={busy} onClick={() => void more('members')}>More people</Button> : null}
      </SettingsPanel>
      <SettingsPanel title="Pending invitations">
        {!roster.invitations.items.length ? <div className="text-sm text-muted-foreground">No pending invitations</div> : <ul className="divide-y divide-border">
          {roster.invitations.items.map(invitation => <li key={invitation.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-1 last:pb-0">
              <div className="min-w-0 flex-1 basis-40"><div className="break-all text-sm font-medium">{invitation.email}</div>
                <div className="text-xs text-muted-foreground">{invitation.role} · Expires {new Date(invitation.expiresAt).toLocaleDateString()}</div></div>
              <Button variant="outline" disabled={busy} onClick={() => void execute({ kind: 'resend', invitationId: invitation.id })}>Resend</Button>
              <Button variant="ghost" disabled={busy} onClick={() => void execute({ kind: 'cancel', invitationId: invitation.id })}>Revoke</Button>
          </li>)}
        </ul>}
        {roster.invitations.nextCursor ? <Button variant="outline" className="mt-3 self-start" disabled={busy} onClick={() => void more('invitations')}>More invitations</Button> : null}
      </SettingsPanel>
    </>}
  </>;
}
function RoleSelect({ value, onChange, id, label, disabled, lastOwner }: { value: MemberRole; onChange: (role: MemberRole) => void; id?: string; label?: string; disabled: boolean; lastOwner?: boolean }) {
  return <select id={id} aria-label={label} value={value} disabled={disabled} className={`${fieldClass} max-sm:min-h-11 capitalize`}
    onChange={event => onChange(event.target.value as MemberRole)}>
    {ROLES.map(role => <option key={role} value={role} disabled={lastOwner && role !== 'owner'}>{role}</option>)}
  </select>;
}
function MemberRow({ member, busy, lastOwner, execute }: { member: WorkspaceMember; busy: boolean; lastOwner: boolean; execute: (command: MemberCommand) => Promise<void> }) {
  const [role, setRole] = useState(member.role);
  const [removing, setRemoving] = useState(false);
  return <li className="flex flex-wrap items-center gap-3 py-3 first:pt-1 last:pb-0">
    <div className="min-w-0 flex-1 basis-40"><div className="break-words text-sm font-medium">{member.name || member.email}</div>
      {member.name ? <div className="break-all text-xs text-muted-foreground">{member.email}</div> : null}
      {lastOwner ? <div className="text-xs text-muted-foreground">Last owner</div> : null}</div>
    <RoleSelect label={`Role for ${member.email}`} value={role} onChange={setRole} disabled={busy} lastOwner={lastOwner} />
    <Button variant="outline" disabled={busy || role === member.role} onClick={() => void execute({ kind: 'change-role', memberId: member.id, role })}>Save role</Button>
    {removing ? <><Button variant="outline" disabled={busy} onClick={() => void execute({ kind: 'remove', memberId: member.id })}>Confirm removal</Button>
      <Button variant="ghost" disabled={busy} onClick={() => setRemoving(false)}>Cancel</Button></>
      : <Button variant="ghost" disabled={busy || lastOwner} onClick={() => setRemoving(true)}>Remove</Button>}
  </li>;
}
