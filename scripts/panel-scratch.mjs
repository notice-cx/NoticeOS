// Estimate the temporary files left by interrupted report jobs for one asset.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function reportScratch(entry) {
  return entry.isDirectory() && /^\.staging-[1-9]\d*-[0-9a-f]{8}(?:-spill)?$/u.test(entry.name)
    || entry.isSymbolicLink() && /^\.link-[1-9]\d*-[0-9a-f]{8}$/u.test(entry.name);
}

/** No paths are followed outside the selected report directory. A writer can
 * start during this read, so the result is an estimate and never a delete list. */
export async function previewPanelScratch(reports) {
  const root = path.resolve(reports);
  if (!path.basename(root).endsWith('.reports') || !(await fs.lstat(root)).isDirectory()) {
    throw new Error('Choose one asset’s .reports directory.');
  }
  const entries = await fs.readdir(root, { withFileTypes: true });
  const busy = () => ({ busy: true, files: 0, logicalBytes: 0, allocatedBytes: 0, entries: [] });
  if (entries.some(entry => entry.name === '.lock')) return busy();
  const candidates = entries.filter(reportScratch).map(entry => entry.name).sort();
  const pending = candidates.map(name => path.join(root, name));
  let files = 0, logicalBytes = 0;
  const inodes = new Map();
  while (pending.length) {
    const file = pending.pop();
    let stat;
    try {
      stat = await fs.lstat(file);
      if (stat.isDirectory()) {
        for (const name of await fs.readdir(file)) pending.push(path.join(file, name));
        continue;
      }
    } catch (error) {
      if (error.code === 'ENOENT') return busy();
      throw error;
    }
    if (stat.isFile() || stat.isSymbolicLink()) {
      files++;
      logicalBytes += stat.size;
      const key = stat.dev + '/' + stat.ino;
      const inode = inodes.get(key) ?? { names: 0, links: stat.nlink, bytes: stat.blocks * 512 };
      inode.names++;
      inodes.set(key, inode);
    }
  }
  if ((await fs.readdir(root)).includes('.lock')) return busy();
  const allocatedBytes = [...inodes.values()].reduce((sum, inode) => sum + (inode.names === inode.links ? inode.bytes : 0), 0);
  return { busy: false, files, logicalBytes, allocatedBytes, entries: candidates };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2).filter(arg => arg !== '--');
    if (args.length !== 2 || args[0] !== '--reports') throw new Error('Usage: pnpm signals:scratch -- --reports <asset>.reports');
    console.log(JSON.stringify(await previewPanelScratch(args[1]), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
