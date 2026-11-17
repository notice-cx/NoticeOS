import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

export const CUSTOMER_ARCHIVE_CACHE_BYTES = 64 * 1024 * 1024;
const SOURCE_BYTES = 32 * 1024 * 1024 + 1;
const HEADER_BYTES = 4096;
const FORMAT = 'noticeos-customer-archive-cache/1';
const HASH = /^[a-f0-9]{64}$/u;
const REPORT_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** A bounded per-site cache. The report can also read the archive directly
 * when there is no room or a retained copy cannot be verified for eviction. */
export function customerArchiveCache({ root, workspaceId, asset, get, head, limitBytes = CUSTOMER_ARCHIVE_CACHE_BYTES }) {
  const prefix = `workspaces/${workspaceId}/raw/`;
  const owns = key => typeof key === 'string' && key.startsWith(prefix) && key.length <= 1024;
  let entries;

  async function metadata(file) {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.size > SOURCE_BYTES + HEADER_BYTES || info.size === 0) return null;
    const input = await fs.open(file, 'r');
    try {
      const header = Buffer.alloc(HEADER_BYTES);
      const { bytesRead } = await input.read(header);
      const delimiter = header.subarray(0, bytesRead).indexOf(10);
      if (delimiter < 0) return null;
      const record = JSON.parse(header.subarray(0, delimiter).toString());
      if (record.format !== FORMAT || record.workspaceId !== workspaceId || record.asset !== asset
        || !owns(record.key) || path.basename(file) !== `${digest(record.key)}.cache`
        || !REPORT_DATE.test(record.reportDate)
        || typeof record.etag !== 'string' || !record.etag || !HASH.test(record.hash)) return null;
      return { ...record, file, offset: delimiter + 1, size: info.size, usedAt: info.mtimeMs };
    } catch { return null; }
    finally { await input.close(); }
  }

  async function digestChecked(record) {
    try {
      const bytes = gunzipSync((await fs.readFile(record.file)).subarray(record.offset), { maxOutputLength: SOURCE_BYTES });
      return digest(bytes) === record.hash ? bytes : null;
    } catch { return null; }
  }

  async function index() {
    if (entries) return entries;
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await fs.lstat(root);
    if (!directory.isDirectory() || directory.mode & 0o077) throw new Error('The customer archive cache must be a private directory.');
    entries = new Map();
    for (const name of await fs.readdir(root)) {
      if (!/^[a-f0-9]{64}\.cache$/u.test(name)) continue;
      const record = await metadata(path.join(root, name));
      if (record) entries.set(record.key, record);
    }
    return entries;
  }

  async function makeRoom(size, reportDate, known) {
    if (size > limitBytes) return false;
    let total = [...known.values()].reduce((sum, record) => sum + record.size, 0);
    if (total + size <= limitBytes) return true;
    // Rebuilding a historical partition must not displace the newer sources
    // read for the freshness and stability evidence on every report.
    const candidates = [...known.values()].filter(record => record.reportDate <= reportDate)
      .sort((a, b) => a.reportDate.localeCompare(b.reportDate) || a.usedAt - b.usedAt || a.key.localeCompare(b.key));
    for (const candidate of candidates) {
      // Keep the local copy if its stored hash or the exact durable version
      // cannot be confirmed. A failed HEAD never authorizes eviction.
      const durable = await head(candidate.key).catch(() => null);
      if (durable?.etag !== candidate.etag || !await digestChecked(candidate)) continue;
      await fs.unlink(candidate.file);
      known.delete(candidate.key);
      total -= candidate.size;
      if (total + size <= limitBytes) return true;
    }
    return false;
  }

  return async (key, reportDate) => {
    if (!owns(key) || !REPORT_DATE.test(reportDate)) throw new Error('The archived report does not belong to this workspace.');
    const known = await index();
    const cached = known.get(key);
    const held = cached?.reportDate === reportDate ? await digestChecked(cached) : null;
    if (held) {
      const now = new Date();
      await fs.utimes(cached.file, now, now);
      cached.usedAt = now.getTime();
      return held;
    }
    const { bytes, etag } = await get(key);
    if (bytes.length > SOURCE_BYTES) throw new Error('The archived report exceeds its size limit.');
    if (cached || typeof etag !== 'string' || !etag) return bytes;
    const record = { format: FORMAT, workspaceId, asset, key, reportDate, etag, hash: digest(bytes) };
    const header = Buffer.from(`${JSON.stringify(record)}\n`);
    const compressed = gzipSync(bytes);
    const size = header.length + compressed.length;
    if (header.length > HEADER_BYTES || size > SOURCE_BYTES + HEADER_BYTES) return bytes;
    const temporary = path.join(root, '.pending-write');
    const file = path.join(root, `${digest(key)}.cache`);
    let staging;
    try {
      staging = await fs.open(temporary, 'wx', 0o600);
      if (!await makeRoom(size, reportDate, known)) return bytes;
      await staging.writeFile(Buffer.concat([header, compressed]));
      await staging.sync();
      await fs.link(temporary, file);
      known.set(key, { ...record, file, size, offset: header.length, usedAt: Date.now() });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    } finally {
      if (staging) {
        await staging.close();
        await fs.rm(temporary, { force: true });
      }
    }
    return bytes;
  };
}
