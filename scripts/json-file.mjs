// Read a JSON file; given a fallback, a missing or unparseable file answers it instead of throwing.

import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';

/** The JSON document at `file`. With a fallback argument, a file that is
 * missing or not JSON answers it instead of throwing. */
export async function readJsonFile(file, ...fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (fallback.length === 0) throw error;
    return fallback[0];
  }
}

/** `readJsonFile`, for a caller that cannot wait. */
export function readJsonFileSync(file, ...fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (fallback.length === 0) throw error;
    return fallback[0];
  }
}
