// Text compares by code unit, as the database sorts an id or a name under the "C" collation. The one
// text comparison every personal package sorts with.
export const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
