// A small RFC-4180-ish CSV reader for the /api/revenue lane: quoted fields,
// embedded commas/newlines, and "" escapes. Enough for the humble Phase-0
// "monthly reporting export" path; not a general CSV library.

/** Parse CSV text into a grid of string cells. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let sawAny = false;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    sawAny = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      sawAny = true;
    } else if (c === ',') {
      endField();
      sawAny = true;
    } else if (c === '\n') {
      endRow();
    } else if (c === '\r') {
      // swallow; the following \n (if any) ends the row
    } else {
      field += c;
      sawAny = true;
    }
  }
  // trailing field/row without a final newline
  if (sawAny || field.length > 0 || row.length > 0) endRow();
  return rows;
}

/**
 * Parse CSV into header-keyed row objects. The first row is the header; empty
 * cells are omitted (so optional columns validate as absent, not empty string);
 * fully blank lines are skipped.
 */
export function csvToRows(text: string): Record<string, string>[] {
  const grid = parseCsv(text);
  if (grid.length === 0) return [];
  const header = grid[0]!.map((h) => h.trim());
  const out: Record<string, string>[] = [];
  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r]!;
    if (cells.length === 1 && cells[0]!.trim() === '') continue; // blank line
    const obj: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      const key = header[c]!;
      if (!key) continue;
      const value = (cells[c] ?? '').trim();
      if (value !== '') obj[key] = value;
    }
    out.push(obj);
  }
  return out;
}
