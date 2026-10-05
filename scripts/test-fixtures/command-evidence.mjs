// Qualification receipts keep complete process results before assertions fail.
// They are diagnostic evidence, never migration consent or a retry policy.
import * as fs from 'node:fs';
import path from 'node:path';
import { redactLogText } from '../os-log.mjs';

export function commandEvidence(directory, { secrets = [] } = {}) {
  if (!path.isAbsolute(directory) || !Array.isArray(secrets) || secrets.some(value => typeof value !== 'string' || !value)) {
    throw new Error('Declare a new absolute receipt directory and explicit redaction values.');
  }
  fs.mkdirSync(directory, { mode: 0o700 });
  const scrub = value => {
    if (typeof value === 'string') {
      for (const secret of secrets) value = value.replaceAll(secret, '[redacted]');
      return redactLogText(value);
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]));
    return value;
  };
  let sequence = 0;
  return async (label, argv, execute) => {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(label) || !Array.isArray(argv) || argv.some(arg => typeof arg !== 'string') || typeof execute !== 'function') {
      throw new Error('Declare the qualification command and its execution callback.');
    }
    const file = path.join(directory, `${String(++sequence).padStart(4, '0')}-${label}.json`);
    let result, thrown;
    try { result = await execute(); }
    catch (error) { thrown = error; result = { code: null, stdout: '', stderr: '', error: String(error?.message ?? error) }; }
    const receipt = scrub({ format: 'noticeos-qualification-command-v1', argv, result });
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(receipt, null, 2) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    const parent = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    if (thrown) throw new Error(`Qualification command could not start; redacted evidence retained at ${file}.`);
    return result;
  };
}
