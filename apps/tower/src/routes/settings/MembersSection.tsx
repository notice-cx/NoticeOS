import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { fieldClass } from '@/components/ui/field';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ReadFailed } from '@/components/ReadFailed';
import { useBrowserContext } from '@/lib/browser-context';
import { MembershipRefused, type MemberCommand, type MemberRole, type MembershipPage, type WorkspaceMember, type WorkspaceInvitation } from '@/lib/membership-client';

const ROLES: MemberRole[] = ['owner', 'operator', 'viewer'];
const QUERY = ['workspace-members'];
type Roster = { members: MembershipPage<WorkspaceMember>; invitations: MembershipPage<WorkspaceInvitation> };
export function MembersSection() {
  const context = useBrowserContext();
  if (context.runtime.owner.mode !== 'hosted' || context.workspaceRole !== 'owner') return null;
  return <OwnerMembers />;
}

/** Administration uses the captured runtime; bootstrap role only hides controls.
 * Saved invitations survive mail failure and are retried by their existing ID. */
function OwnerMembers() {
  const { runtime, refreshSession } = useBrowserContext();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MemberRole>('viewer');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const issuing = useRef(false);
  const read = useQuery({ queryKey: QUERY, queryFn: async ({ signal }): Promise<Roster> => {
    const [members, invitations] = await Promise.all([runtime.api.fetchMembers(undefined, signal), runtime.api.fetchInvitations(undefined, signal)]);
    return { members, invitations };
  } });
  const update = runtime.guard((callback: () => void) => callback());
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
        if ((command.kind === 'change-role' || command.kind === 'remove') && runtime.guard(() => true)() === true) await refreshSession?.();
      }
      issuing.current = false; update(() => setBusy(false));
    }
  }
  async function more(collection: 'members' | 'invitations') {
    const cursor = read.data?.[collection].nextCursor;
    if (!cursor || issuing.current) return;
    issuing.current = true; setBusy(true); setNotice(null);
    try {
      const next = collection === 'members' ? await runtime.api.fetchMembers(cursor) : await runtime.api.fetchInvitations(cursor);
      update(() => runtime.queries.setQueryData<Roster>(QUERY, previous => {
        if (!previous) return previous;
        const old = previous[collection];
        // De-duplicate a concurrent roster change across cursor pages.
        const items = [...old.items, ...next.items.filter(item => !old.items.some(existing => existing.id === item.id))];
        return { ...previous, [collection]: { items, nextCursor: next.nextCursor } };
      }));
    } catch { update(() => setNotice({ error: true, text: 'More people could not be loaded. Try again.' })); }
    finally { issuing.current = false; update(() => setBusy(false)); }
  }
  const oneOwner = read.data?.members.nextCursor === null && read.data.members.items.filter(member => member.role === 'owner').length === 1;
  return <Card id="members">
    <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
      <CardTitle className="text-base normal-case tracking-normal">Members</CardTitle>
      <Button variant="ghost" disabled={busy} onClick={() => void refreshSession?.()}>Refresh access</Button>
    </CardHeader>
    <CardContent className="space-y-6">
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
        <Button type="submit" disabled={busy || !read.data}>Invite</Button>
      </form>
      {notice ? <div role="status" data-status-for="members" className={`text-sm ${notice.error ? 'text-error' : 'text-muted-foreground'}`}>{notice.text}</div> : null}
      {!read.data ? read.isError ? <ReadFailed title="Couldn't load members" subject="read:members" error={read.error} retrying={read.isFetching} onRetry={() => void read.refetch()} />
        : <div role="status" data-status-for="members" className="text-sm text-muted-foreground">Loading members…</div> : <>
        <section aria-label="Workspace members" className="space-y-2">
          <h3 className="text-sm font-medium">People</h3>
          <ul className="divide-y divide-border">{read.data.members.items.map(member => <MemberRow key={`${member.id}:${member.role}`} member={member}
            busy={busy} lastOwner={oneOwner && member.role === 'owner'} execute={execute} />)}</ul>
          {read.data.members.nextCursor ? <Button variant="outline" disabled={busy} onClick={() => void more('members')}>More people</Button> : null}
        </section>
        <section aria-label="Pending invitations" className="space-y-2">
          <h3 className="text-sm font-medium">Pending invitations</h3>
          {!read.data.invitations.items.length ? <div className="text-sm text-muted-foreground">No pending invitations</div> : <ul className="divide-y divide-border">
            {read.data.invitations.items.map(invitation => <li key={invitation.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1 basis-40"><div className="break-all text-sm font-medium">{invitation.email}</div>
                <div className="text-xs text-muted-foreground">{invitation.role} · Expires {new Date(invitation.expiresAt).toLocaleDateString()}</div></div>
              <Button variant="outline" disabled={busy} onClick={() => void execute({ kind: 'resend', invitationId: invitation.id })}>Resend</Button>
              <Button variant="ghost" disabled={busy} onClick={() => void execute({ kind: 'cancel', invitationId: invitation.id })}>Revoke</Button>
            </li>)}
          </ul>}
          {read.data.invitations.nextCursor ? <Button variant="outline" disabled={busy} onClick={() => void more('invitations')}>More invitations</Button> : null}
        </section>
      </>}
    </CardContent>
  </Card>;
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
  return <li className="flex flex-wrap items-center gap-3 py-3">
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
