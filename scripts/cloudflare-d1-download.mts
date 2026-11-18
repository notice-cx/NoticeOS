export function cloudflareD1DownloadAddress(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
      && /^(?:[a-z0-9][a-z0-9-]*\.)?[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/u.test(url.hostname) ? url.href : null;
  } catch { return null; }
}
