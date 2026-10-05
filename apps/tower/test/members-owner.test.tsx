import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { MembersSection } from '@/routes/settings/MembersSection';
import { BrowserRuntimeProvider } from '@/lib/browser-context';
import { createBrowserRuntime, BrowserRetiredError } from '@/lib/browser-runtime';
import type { ApiTransport } from '@/lib/api';
import { MembershipRefused } from '@/lib/membership-client';
import { WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from '../../../scripts/browser-request-policy.mjs';
import { MEMBERSHIP_PATH } from '../../../scripts/identity-protocol.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const member = { id, name: 'Generated owner', email: 'owner@example.test', role: 'owner' };
const invitation = { id: other, email: 'guest@example.test', role: 'viewer', expiresAt: '2026-10-10T00:00:00Z' };
const owned: ReturnType<typeof createBrowserRuntime>[] = [];
function runtime(fetch: ApiTransport, workspaceId = id, mode: 'hosted' | 'demo' | 'standalone' = 'hosted') {
  const owner = mode === 'hosted' ? { mode, principalId: id, sessionId: id, workspaceId, clientGeneration: 1 }
    : mode === 'demo' ? { mode, workspaceId, clientGeneration: 1 } : { mode, clientGeneration: 1 };
  const value = createBrowserRuntime(owner, { origin: window.location.origin, fetch, sendAnswer: async () => {} });
  owned.push(value); return value;
}
function roster(input: unknown, init?: RequestInit) {
  expect(new URL(String(input)).pathname).toBe(MEMBERSHIP_PATH);
  const command = JSON.parse(String(init?.body));
  if (command.kind !== 'list') return Response.json({ ok: true });
  return Response.json({ ok: true, collection: command.collection,
    items: command.collection === 'members' ? [member] : [], nextCursor: null });
}
function mount(value: ReturnType<typeof runtime>, role: 'owner' | 'operator' | 'viewer' = 'owner', refreshSession = vi.fn(async () => {})) {
  return render(<BrowserRuntimeProvider value={{ runtime: value, workspaceLabel: 'Generated workspace', workspaceRole: role, refreshSession }}>
    <QueryClientProvider client={value.queries}><MembersSection /></QueryClientProvider>
  </BrowserRuntimeProvider>);
}
afterEach(() => { owned.splice(0).forEach(value => value.retire()); vi.restoreAllMocks(); });

it.each(['operator', 'viewer', 'demo', 'standalone'] as const)('%s exposes no management or roster requests', mode => {
  const fetch = vi.fn<ApiTransport>();
  const value = runtime(fetch, id, mode === 'demo' || mode === 'standalone' ? mode : 'hosted');
  mount(value, mode === 'operator' || mode === 'viewer' ? mode : 'owner');
  expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull(); expect(fetch).not.toHaveBeenCalled();
});
it('owner shows required email and safe last-owner controls, while Invite carries captured ownership', async () => {
  const fetch = vi.fn<ApiTransport>(async (input, init) => roster(input, init));
  const value = runtime(fetch); mount(value);
  await screen.findByText('Generated owner');
  expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
  expect(within(screen.getByLabelText('Role')).getByRole('option', { name: 'operator' })).toBeEnabled();
  const ownSelect = screen.getByLabelText('Role for owner@example.test');
  expect(within(ownSelect).getByRole('option', { name: 'operator' })).toBeDisabled();
  expect(screen.getByLabelText('Email *')).toBeRequired();
  fireEvent.change(screen.getByLabelText('Email *'), { target: { value: 'guest@example.test' } });
  fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
  await screen.findByText('Invitation sent.');
  const [input, init] = fetch.mock.calls.find(([, init]) => JSON.parse(String(init?.body)).kind === 'invite')!;
  expect(String(input)).toBe(`${window.location.origin}${MEMBERSHIP_PATH}`);
  expect(JSON.parse(String(init?.body))).toEqual({ kind: 'invite', email: 'guest@example.test', role: 'viewer' });
  expect(new Headers(init?.headers).get(WORKSPACE_SELECTION_HEADER)).toBe(id);
  expect(new Headers(init?.headers).get(WORKSPACE_SESSION_HEADER)).toBe(id);
});
it('saved delivery failure clears new-invite draft and Resend reuses the existing invitation ID', async () => {
  let saved = false;
  const fetch = vi.fn<ApiTransport>(async (input, init) => {
    const command = JSON.parse(String(init?.body));
    if (command.kind === 'invite') { saved = true; return Response.json({ ok: false, code: 'delivery_failed', invitationId: other }, { status: 503 }); }
    if (command.kind === 'list' && command.collection === 'invitations') return Response.json({ ok: true, collection: 'invitations', items: saved ? [invitation] : [], nextCursor: null });
    return roster(input, init);
  });
  mount(runtime(fetch)); await screen.findByText('Generated owner');
  fireEvent.change(screen.getByLabelText('Email *'), { target: { value: invitation.email } });
  fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
  await screen.findByText('Invitation saved; delivery failed. Use Resend.');
  await screen.findByRole('button', { name: 'Resend' });
  expect(screen.getByLabelText('Email *')).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: 'Resend' }));
  await screen.findByText('Invitation resent.');
  const writes = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body))).filter(command => command.kind !== 'list');
  expect(writes).toEqual([{ kind: 'invite', email: invitation.email, role: 'viewer' }, { kind: 'resend', invitationId: other }]);
});
it.each(['success', 'failure'])('retired %s cannot show old operation results or refill successor roster', async outcome => {
  let finish!: (value: Response) => void;
  const fetch = vi.fn<ApiTransport>((input, init) => JSON.parse(String(init?.body)).kind === 'invite'
    ? new Promise(yes => { finish = yes; }) : Promise.resolve(roster(input, init)));
  const a = runtime(fetch); const view = mount(a); await screen.findByText('Generated owner');
  fireEvent.change(screen.getByLabelText('Email *'), { target: { value: invitation.email } });
  fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
  a.retire(); view.unmount(); const b = runtime(async () => Response.json({ ok: true, collection: 'members', items: [], nextCursor: null }), other);
  await act(async () => { finish(Response.json({ ok: outcome === 'success' }, { status: outcome === 'success' ? 200 : 403 })); });
  expect(b.queries.getQueryCache().getAll()).toHaveLength(0);
  expect(a.queries.getQueryCache().getAll()).toHaveLength(0);
  expect(fetch.mock.calls.filter(([, init]) => JSON.parse(String(init?.body)).kind === 'list')).toHaveLength(2);
});
it('API preserves bounded pagination, refuses malformed roster, and retirement includes decoded results', async () => {
  const fetch = vi.fn<ApiTransport>(async () => Response.json({ ok: true, collection: 'members', items: [member], nextCursor: other }));
  const a = runtime(fetch); await a.api.fetchMembers(other);
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ kind: 'list', collection: 'members', after: other });
  await expect(a.api.fetchMembers('bad')).rejects.toThrow('Member page is invalid.');
  const bad = runtime(async () => Response.json({ ok: true, collection: 'members', items: [{ ...member, role: 'admin' }], nextCursor: null }));
  await expect(bad.api.fetchMembers()).rejects.toThrow('invalid response');
  const refused = runtime(async () => Response.json({ ok: false, code: 'delivery_failed', invitationId: 'bad' }, { status: 503 }));
  await expect(refused.api.manageMembership({ kind: 'invite', email: invitation.email, role: 'viewer' })).rejects.toEqual(new MembershipRefused(503));
  let decode!: (value: unknown) => void; const response = Response.json({});
  vi.spyOn(response, 'json').mockImplementation(() => new Promise(yes => { decode = yes; }));
  const old = runtime(async () => response); const pending = old.api.fetchMembers();
  await vi.waitFor(() => expect(decode).toBeTypeOf('function')); old.retire();
  decode({ ok: true, collection: 'members', items: [member], nextCursor: null });
  await expect(pending).rejects.toThrow(BrowserRetiredError);
});
