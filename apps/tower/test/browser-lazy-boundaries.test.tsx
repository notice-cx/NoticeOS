import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserEntry } from '@/BrowserEntry';
import { captureBrowserLanding, createBrowserEntry } from '@/lib/browser-entry';
import { createApi } from '@/lib/api';

vi.mock('@/routes/SignInRoute', () => ({
  get SignInRoute() { throw new TypeError('Failed to fetch dynamically imported module: sign-in'); },
}));
vi.mock('@/lib/critical-response', () => ({
  get decodeConfigSave() { throw new TypeError('Failed to fetch dynamically imported module: validation'); },
  get decodeAssetOrder() { throw new TypeError('Failed to fetch dynamically imported module: validation'); },
}));
afterEach(() => vi.restoreAllMocks());

it('a missing sign-in chunk offers explicit recovery without replacing the current document', async () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  const original = window.location.href;
  const entry = createBrowserEntry({ origin: window.location.origin, page: window, landing: captureBrowserLanding(window),
    fetch: async () => Response.json({ mode: 'hosted', session: null, workspaces: [], selectedWorkspace: null, nextCursor: null }),
  });
  const view = render(<BrowserEntry createEntry={() => entry} />);
  try {
    await screen.findByRole('heading', { name: "This page didn't load" });
    expect(open).not.toHaveBeenCalled();
    expect(window.location.href).toBe(original);
    fireEvent.click(screen.getByRole('button', { name: 'Open app in new tab' }));
    expect(open).toHaveBeenCalledExactlyOnceWith(original, '_blank', 'noopener,noreferrer');
  } finally { view.unmount(); entry.dispose(); }
});

it('a missing validation chunk refuses both writes before any mutation is sent', async () => {
  const fetch = vi.fn(async () => Response.json({}));
  const api = createApi(fetch);
  await expect(api.saveConfig([{ kind: 'file-json-set', file: 'config/constants.json',
    pointer: '/operator_rate_usd_per_min', expect: 2, value: 0 }])).rejects.toThrow('validation');
  await expect(api.moveAsset('meals.example', 'nosh.example')).rejects.toThrow('validation');
  expect(fetch).not.toHaveBeenCalled();
});
