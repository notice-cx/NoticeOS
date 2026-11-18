import { CONFIG_REGISTERS, rowRefusal } from './config-registers.mjs';
import { parseWallConfig, WALL_LAYOUT_HISTORY_MAX } from './wall-layout.mjs';

export const SHADOW_DISPLAY_DOCUMENTS = Object.freeze(['tower', 'recurring-costs', 'domain-costs']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Export selected display fields using the same validation as the product. */
export function shadowDisplayDocument(key, body) {
  if (!record(body)) throw new Error('The backup contains an invalid display document.');
  if (key === 'tower') {
    if (body.wall == null) return { wall: null };
    try {
      const { layout, history } = parseWallConfig(body.wall);
      return { wall: { layout, history: history.slice(0, WALL_LAYOUT_HISTORY_MAX) } };
    } catch {
      throw new Error('The backup contains an invalid saved Wall layout.');
    }
  }
  if (!SHADOW_DISPLAY_DOCUMENTS.includes(key)) throw new Error('The backup contains an unsupported display document.');
  const register = CONFIG_REGISTERS[key];
  const field = register.container.slice(1);
  const rows = body[field];
  if (!Array.isArray(rows)) throw new Error('The backup contains invalid cost declarations.');
  return { [field]: rows.map(row => {
    if (!record(row)) throw new Error('The backup contains an invalid cost declaration.');
    const value = Object.fromEntries(register.fields.flatMap(({ name }) => Object.hasOwn(row, name) ? [[name, row[name]]] : []));
    if (rowRefusal(register, value)) throw new Error('The backup contains an invalid cost declaration.');
    return value;
  }) };
}

export function shadowDisplayAssets(documents) {
  return [...new Set([...(documents['recurring-costs']?.body.costs ?? []), ...(documents['domain-costs']?.body.domains ?? [])]
    .map(row => row.asset))];
}
