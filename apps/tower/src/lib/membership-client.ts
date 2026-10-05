import { MEMBERSHIP_PATH } from '../../../../scripts/identity-protocol.mjs';
import type { ApiTransport } from './api';
import { responseInstant, responseJson } from './response-value';

export type MemberRole = 'owner' | 'operator' | 'viewer';
export interface WorkspaceMember { id: string; email: string; name: string; role: MemberRole }
export interface WorkspaceInvitation { id: string; email: string; role: MemberRole; expiresAt: string }
export interface MembershipPage<Item> { items: Item[]; nextCursor: string | null }
export type MemberCommand =
  | { kind: 'invite'; email: string; role: MemberRole }
  | { kind: 'resend' | 'cancel'; invitationId: string }
  | { kind: 'change-role'; memberId: string; role: MemberRole }
  | { kind: 'remove'; memberId: string };
export class MembershipRefused extends Error {
  constructor(readonly status: number, readonly invitationId?: string) {
    super(invitationId ? 'Invitation saved; delivery failed. Use Resend.' : 'Access change refused. Refresh and try again.');
  }
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const role = (value: unknown): value is MemberRole => value === 'owner' || value === 'operator' || value === 'viewer';
async function request(fetch: ApiTransport, body: object, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(MEMBERSHIP_PATH, { method: 'POST', signal,
    headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  const value = await responseJson(response, 'Members');
  if (!response.ok) throw new MembershipRefused(response.status,
    response.status === 503 && record(value) && value.code === 'delivery_failed' && uuid(value.invitationId) ? value.invitationId : undefined);
  if (!record(value) || value.ok !== true) throw new Error('Members returned an invalid response.');
  return value;
}
export async function fetchMembershipsRequest<Collection extends 'members' | 'invitations'>(fetch: ApiTransport,
  collection: Collection, after?: string, signal?: AbortSignal): Promise<MembershipPage<Collection extends 'members' ? WorkspaceMember : WorkspaceInvitation>> {
  if (after !== undefined && !uuid(after)) throw new Error('Member page is invalid.');
  const value = await request(fetch, { kind: 'list', collection, ...(after ? { after } : {}) }, signal);
  if (value.collection !== collection || !Array.isArray(value.items) || value.items.length > 100
    || (value.nextCursor !== null && !uuid(value.nextCursor))) throw new Error('Members returned an invalid response.');
  const items = value.items.map((item: unknown) => {
    if (!record(item) || !uuid(item.id) || typeof item.email !== 'string' || !role(item.role)
      || (collection === 'members' ? typeof item.name !== 'string'
        : !responseInstant(item.expiresAt))) throw new Error('Members returned an invalid response.');
    return { id: item.id, email: item.email, role: item.role,
      ...(collection === 'members' ? { name: item.name as string } : { expiresAt: item.expiresAt as string }) };
  });
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('Members returned an invalid response.');
  return { items, nextCursor: value.nextCursor } as MembershipPage<Collection extends 'members' ? WorkspaceMember : WorkspaceInvitation>;
}
export async function manageMembershipRequest(fetch: ApiTransport, command: MemberCommand): Promise<{ invitationId?: string }> {
  const value = await request(fetch, command);
  if (value.invitationId !== undefined && !uuid(value.invitationId)) throw new Error('Members returned an invalid response.');
  return value.invitationId === undefined ? {} : { invitationId: value.invitationId };
}
