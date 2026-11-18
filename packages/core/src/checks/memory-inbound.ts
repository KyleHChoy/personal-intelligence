// Memory coming back: how the adapter splits a memory file into entries, and how intake finds the
// addresses an entry names. Pure: no clock, no file, no network. entryLine, the line a fingerprint is
// taken of, is in memory.ts beside the stamp grammar it removes.

const HEADING = /^#{1,6}(\s|$)/;
const ITEM = /^([-*+]|\d{1,9}[.)])(\s|$)/;
const FENCE = /^\s{0,3}(```|~~~)/;
const INDENTED = /^(\t| {2,})\S/;

// A continuation is any line of the item before a blank line, a heading or the next top-level item, and an
// indented line after a blank line. A fenced block stays whole in the entry it is in. Each line loses its
// carriage return and trailing white space.
export function splitEntries(text: string): string[] {
  const entries: string[] = [];
  let current: string[] = [];
  let item = false;
  let fenced = false;
  let blank = false;
  const close = (): void => {
    while (current.length > 0 && current[current.length - 1] === "") current.pop();
    if (current.length > 0) entries.push(current.join("\n"));
    current = [];
    item = false;
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (fenced) {
      current.push(line);
      if (FENCE.test(line)) fenced = false;
      continue;
    }
    if (line === "") {
      blank = true;
      if (item) current.push(line);
      else close();
      continue;
    }
    const continues = item && (blank ? INDENTED.test(line) : !ITEM.test(line) && !HEADING.test(line));
    blank = false;
    if (continues || (current.length > 0 && !item && !ITEM.test(line) && !HEADING.test(line))) {
      current.push(line);
    } else {
      close();
      if (HEADING.test(line)) continue;
      current.push(line);
      item = ITEM.test(line);
    }
    if (FENCE.test(line)) fenced = true;
  }
  close();
  return entries;
}
