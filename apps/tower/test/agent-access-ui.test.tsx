import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserEntry } from '@/BrowserEntry';
import { captureBrowserLanding, createBrowserEntry } from '@/lib/browser-entry';
import type { ApiTransport } from '@/lib/api';
import { AGENT_ACCESS_PATHS, parseAgentAccessLanding } from '../../../scripts/agent-access.mjs';
import { WORKSPACE_SESSION_HEADER } from '../../../scripts/browser-request-policy.mjs';

// Agent sign-in's page: an agent landing becomes the agent phase instead of a
// workspace, and allowing it covers every workspace the person belongs to.

const [PERSON, SESSION, WA, WB] = ['11111111', '33333333', '55555555', '66666666'].map(prefix => `${prefix}-1111-4111-8111-111111111111`);
const query = 'response_type=code&client_id=agent-1&scope=tasks%3Aread+tasks%3Awrite&exp=1&sig=abc';
const session = (signedIn = true) => ({ mode: 'hosted', session: signedIn ? { principalId: PERSON, sessionId: SESSION,
  expiresAt: new Date(Date.now() + 60_000).toISOString() } : null, nextCursor: null, selectedWorkspace: null,
  workspaces: signedIn ? [{ workspaceId: WA, displayName: 'Operated', role: 'operator', status: 'active' },
    { workspaceId: WB, displayName: 'Viewed', role: 'viewer', status: 'active' }] : [] });
afterEach(() => { window.history.replaceState(null, '', '/'); vi.restoreAllMocks(); });

it('parses only the agent page with a signed query', () => {
  expect(parseAgentAccessLanding(`https://tower.example.test/agent-access?${query}`)).toEqual({ kind: 'agent', query });
  for (const href of ['https://tower.example.test/agent-access', 'https://tower.example.test/sign-in?x=1',
    `https://tower.example.test/agent-access?a=${'x'.repeat(9000)}`]) expect(parseAgentAccessLanding(href)).toEqual({ kind: 'none' });
});

it('asks a signed-in person to allow the agent once, and sends the browser on', async () => {
  window.history.replaceState(null, '', `/agent-access?${query}`);
  const calls: { url: string; headers: Headers; body: unknown }[] = [];
  const fetch: ApiTransport = async (input, init) => {
    const url = String(input), headers = new Headers(init?.headers);
    calls.push({ url, headers, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith(AGENT_ACCESS_PATHS.request)) return Response.json({ client: { name: 'Example agent', uri: null }, scopes: ['tasks:read', 'tasks:write'] });
    if (url.endsWith(AGENT_ACCESS_PATHS.approve)) return Response.json({ url: 'http://127.0.0.1:33418/callback?code=c&state=s' });
    return Response.json(session());
  };
  const assign = vi.fn();
  vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, href: window.location.href, assign } as Location);
  const landing = captureBrowserLanding(window), agent = parseAgentAccessLanding(window.location.href);
  render(<BrowserEntry createEntry={() => createBrowserEntry({ origin: window.location.origin, page: window, fetch, landing, agent })} />);
  expect(await screen.findByText('Connect Example agent')).toBeTruthy();
  expect(screen.getByText('Create, claim, update, comment on and close tasks')).toBeTruthy();
  expect(screen.getByText('Your role in a workspace still limits it.')).toBeTruthy();
  expect(screen.queryByText('Operated')).toBeNull();
  fireEvent.click(screen.getByText('Allow'));
  await waitFor(() => expect(assign).toHaveBeenCalledWith('http://127.0.0.1:33418/callback?code=c&state=s'));
  const approve = calls.find(call => call.url.endsWith(AGENT_ACCESS_PATHS.approve))!;
  expect(approve.body).toEqual({ oauth_query: query, accept: true });
  expect(approve.headers.get(WORKSPACE_SESSION_HEADER)).toBe(SESSION);
});

it('signs a person in first when the agent finds them signed out', async () => {
  window.history.replaceState(null, '', `/agent-access?${query}`);
  const fetch: ApiTransport = async () => Response.json(session(false));
  const landing = captureBrowserLanding(window), agent = parseAgentAccessLanding(window.location.href);
  render(<BrowserEntry createEntry={() => createBrowserEntry({ origin: window.location.origin, page: window, fetch, landing, agent })} />);
  expect(await screen.findByText('Send code')).toBeTruthy();
});
