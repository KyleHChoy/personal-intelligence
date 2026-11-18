// CSV as RFC 4180 writes it, read leniently: cells split by commas, rows by CRLF, LF or CR; a cell
// that starts with a double quote may hold commas, line breaks and "" for a quote. A leading byte
// order mark is dropped. Null for a quote that never closes, which makes every later row wrong.
export function parseCsv(text: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  // Whether the cell being read has been opened by a quote, so a quote later in it is text.
  let started = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else quoted = false;
    } else if (char === '"' && !started) {
      quoted = true;
      started = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
      started = false;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      started = false;
    } else {
      cell += char;
      started = true;
    }
  }
  if (quoted) return null;
  if (started || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
