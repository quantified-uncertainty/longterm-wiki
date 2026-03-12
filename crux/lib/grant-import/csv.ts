export function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (line[i] === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += line[i];
    }
  }
  fields.push(current);
  return fields;
}

/** Reassemble multi-line CSV rows (Details field may contain newlines) */
export function reassembleCSVRows(text: string): string[] {
  const lines = text.split("\n");
  const rows: string[] = [];
  let currentRow = "";
  let inQuotes = false;
  for (const line of lines.slice(1)) {
    // skip header
    for (const ch of line) {
      if (ch === '"') inQuotes = !inQuotes;
    }
    currentRow += (currentRow ? "\n" : "") + line;
    if (!inQuotes) {
      if (currentRow.trim()) rows.push(currentRow);
      currentRow = "";
    }
  }
  if (currentRow.trim()) rows.push(currentRow);
  return rows;
}
