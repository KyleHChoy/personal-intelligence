import { CURRENCY_CODES } from "@intelligence/contracts/personal";

// The numbers a passage states, in every reading of their separators and currency, which a typed
// number grounds on (groundNumber).
const LETTER = /^\p{L}$/u;
const DIGIT = /^[0-9]$/;

const POINT_SEPARATORS = new Set([".", ","]);
// A space or an apostrophe separates only when exactly three digits follow it.
const GROUP_SEPARATORS = new Set(["'", "’", " ", " ", " ", " "]);
const CODES = new Set<string>(CURRENCY_CODES);

const digitAt = (points: string[], at: number): boolean => DIGIT.test(points[at] ?? "");

// A capital currency code that stands against a numeral: three code points that are one,
// with no letter on their far side.
function currencyAt(points: string[], from: number, side: "before" | "after"): boolean {
  const start = side === "before" ? from - 3 : from;
  if (start < 0) return false;
  const code = points.slice(start, start + 3).join("");
  const beyond = side === "before" ? points[start - 1] : points[start + 3];
  return CODES.has(code) && !LETTER.test(beyond ?? "");
}

const letterAt = (points: string[], at: number): boolean => LETTER.test(points[at] ?? "");

// The segment's numeral tokens: maximal runs of digits and single separators, each between two
// digits, with no letter against them but a capital currency code.
export function numerals(text: string): string[] {
  const points = [...text];
  const tokens: string[] = [];
  let index = 0;
  while (index < points.length) {
    if (!digitAt(points, index)) {
      index += 1;
      continue;
    }
    const start = index;
    let end = index;
    for (;;) {
      while (digitAt(points, end)) end += 1;
      const separator = points[end] ?? "";
      if (!digitAt(points, end + 1)) break;
      if (POINT_SEPARATORS.has(separator)) end += 1;
      else if (
        GROUP_SEPARATORS.has(separator) &&
        digitAt(points, end + 2) &&
        digitAt(points, end + 3) &&
        !digitAt(points, end + 4)
      )
        end += 1;
      else break;
    }
    const before = !letterAt(points, start - 1) || currencyAt(points, start, "before");
    const after = !letterAt(points, end) || currencyAt(points, end, "after");
    if (before && after) tokens.push(points.slice(start, end).join(""));
    index = end;
  }
  return tokens;
}

// A decimal with the leading zeros of its whole part and the trailing zeros of its fraction dropped.
function decimal(whole: string, fraction = ""): string {
  const head = whole.replace(/^0+/, "") || "0";
  const tail = fraction.replace(/0+$/, "");
  return tail === "" ? head : `${head}.${tail}`;
}

// The decimal and the grouping readings of a token, every non-digit a separator.
function readingsOf(token: string): string[] {
  const groups = token.split(/[^0-9]/);
  const separators = [...token].filter((char) => !DIGIT.test(char));
  if (!separators.some((char) => POINT_SEPARATORS.has(char))) return [decimal(groups.join(""))];
  const found: string[] = [];
  const mark = separators.at(-1) as string;
  const inner = groups.slice(1, -1);
  if (
    POINT_SEPARATORS.has(mark) &&
    !separators.slice(0, -1).includes(mark) &&
    inner.every((group) => group.length === 3)
  ) {
    found.push(decimal(groups.slice(0, -1).join(""), groups.at(-1)));
  }
  if (groups.slice(1).every((group) => group.length === 3)) found.push(decimal(groups.join("")));
  return found;
}

const SPACES = /[    ]/;

// The values a token can stand for: its decimal and grouping readings, and, when it holds a
// space, the readings of each piece between its spaces. Each once.
export function readings(token: string): string[] {
  const pieces = token.split(SPACES);
  const all = [...readingsOf(token), ...(pieces.length > 1 ? pieces.flatMap(readingsOf) : [])];
  return [...new Set(all)];
}

// Whether the value's magnitude, in plain decimal form, is a reading of a numeral of the
// segment. No tolerance, and a value written with an exponent is not grounded.
export function groundNumber(value: number, segment: string): boolean {
  if (!Number.isFinite(value)) return false;
  const written = String(Math.abs(value));
  if (written.includes("e")) return false;
  return numerals(segment).some((token) => readings(token).includes(written));
}
