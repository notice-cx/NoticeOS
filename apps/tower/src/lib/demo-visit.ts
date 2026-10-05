import { demoViewer } from '@shared/demo-viewer';

/** Ordinary installs and the standalone viewer keep their existing URLs.
 * A replay document keeps its visit in both navigation and every stored read. */
export function demoVisitBase(pathname = typeof window === 'undefined' ? '/' : window.location.pathname): string {
  if (demoViewer() === null) return '/';
  const match = pathname.match(/^\/visit\/([a-f0-9]{32})(?:\/|$)/u);
  return match ? `/visit/${match[1]}` : '/';
}

export function demoDocumentUrl(input: string, base = demoVisitBase()): string {
  if (base === '/' || !input.startsWith('/') || input.startsWith('//')) return input;
  return `${base}${input}`;
}

export function demoVisitUrl(input: string, base = demoVisitBase()): string {
  if (base === '/' || !input.startsWith('/api/')) return input;
  return `${base}${input}`;
}

/** A local transport at the two actual reader seams, never a global fetch
 * replacement. Request options and the existing backend policy stay intact. */
export const demoFetch: typeof fetch = (input, init) => {
  if (typeof input === 'string') return globalThis.fetch(demoVisitUrl(input), init);
  return globalThis.fetch(input, init);
};
