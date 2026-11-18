// The pure parts of the sweep's bases. The address basis's names, and the order the sweep raises
// candidates in. identity-sweep.ts reads the rows; nothing here touches the database.

// A part of a local part that can be a name: two letters or more, letters only.
const PART = /^\p{L}{2,}$/u;
// A `firstlast` local part longer than this is not read as a name: it bounds the splits tried.
const MAX_JOINED = 40;

// The full names, as `first last`, an address's local part spells: `first.last` and `first_last`
// spell one; `firstlast` spells each split with two letters or more on each side, and the sweep
// keeps a split only when another person's alias is that exact name. A `+tag` is left out. Each
// name is normalized as a `name` fingerprint is (keys.ts), so equal names fingerprint equal. A
// local part with digits, a third part or one letter on a side spells none.
export function localPartNames(address: string): string[] {
  const at = address.lastIndexOf("@");
  if (at <= 0) return [];
  const local = (address.slice(0, at).split("+")[0] ?? "").normalize("NFKC").toLowerCase();
  const parts = local.split(/[._]/u);
  if (parts.length === 2) return parts.every((part) => PART.test(part)) ? [parts.join(" ")] : [];
  const letters = [...local];
  if (parts.length !== 1 || !PART.test(local) || letters.length < 4 || letters.length > MAX_JOINED) return [];
  const names: string[] = [];
  for (let split = 2; split <= letters.length - 2; split += 1)
    names.push(`${letters.slice(0, split).join("")} ${letters.slice(split).join("")}`);
  return names;
}

// One candidate as the order sees it: its tier, the time in ms of the newest evidence about either
// person, or null with none, and its fingerprints' key.
export type OrderKey = { rank: number; latest: number | null; key: string };

export function compareCandidates(one: OrderKey, other: OrderKey): number {
  if (one.rank !== other.rank) return one.rank - other.rank;
  if (one.latest !== other.latest) {
    if (one.latest === null) return 1;
    if (other.latest === null) return -1;
    return other.latest - one.latest;
  }
  return one.key < other.key ? -1 : one.key > other.key ? 1 : 0;
}
