import type { MessageTriageRow } from "@intelligence/contracts/personal";
import type { Parsed } from "@intelligence/personal-core";

// The `message` slot of DECIDE_SCREEN, cut to fit the decide model's context. The bound is on UTF-8
// bytes of the state as it is sent, `JSON.stringify({ message: slot })`, after JSON escaping. Every
// cut falls between code points. A pure function with a fixed key order: the same item gives the
// same text and hash.

export const STATE_BYTES = 24_000;
export const MARKER = "[…]";
const SUBJECT_POINTS = 500;
const FIELD_POINTS = 200;
const ADDRESSEES = 25;
const HEAD_SHARE = 0.8;

type Party = { name: string; address: string };
type ScreenSlot = {
  from: Party | null;
  to: Party[];
  cc: Party[];
  more_addressees: number;
  subject: string;
  date: string | null;
  category: MessageTriageRow["category"];
  bulk: boolean;
  direction: MessageTriageRow["direction"];
  attachments: { read: number; unread: number };
  text: string;
  cut: boolean;
  omitted?: number;
};

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
const stateBytes = (slot: ScreenSlot): number => bytes({ message: slot });

// A text cut to `max` code points, and how many were left out.
const capped = (text: string, max: number): { text: string; omitted: number } => {
  const points = Array.from(text);
  return points.length <= max
    ? { text, omitted: 0 }
    : { text: points.slice(0, max).join(""), omitted: points.length - max };
};

// The longest run of code points, from the start, whose escaped bytes fit in `room`.
const fitting = (points: readonly string[], room: number): number => {
  let used = 0;
  let n = 0;
  while (n < points.length) {
    const size = bytes(points[n]) - 2;
    if (used + size > room) break;
    used += size;
    n += 1;
  }
  return n;
};

export function fitScreenSlot(parsed: Parsed, row: MessageTriageRow): ScreenSlot {
  let omitted = 0;
  const cap = (text: string, max: number): string => {
    const one = capped(text, max);
    omitted += one.omitted;
    return one.text;
  };
  const names = new Map<string, string>();
  for (const party of parsed.parties ?? []) if (!names.has(party.address)) names.set(party.address, party.name);
  const party = (address: string): Party => ({
    name: cap(names.get(address) ?? "", FIELD_POINTS),
    address: cap(address, FIELD_POINTS),
  });

  const from = parsed.headers.from?.[0];
  const addressees = [
    ...(parsed.headers.to ?? []).map((address) => ["to", address] as const),
    ...(parsed.headers.cc ?? []).map((address) => ["cc", address] as const),
  ];
  let kept = Math.min(addressees.length, ADDRESSEES);
  const attachments = {
    read: Object.keys(parsed.texts).filter((key) => key.startsWith("attachment:")).length,
    unread: parsed.unreadAttachments,
  };
  const subject = cap(parsed.texts["subject:"] ?? "", SUBJECT_POINTS);
  const fromParty = from === undefined ? null : party(from);
  const parties = addressees.map(([field, address]) => [field, party(address)] as const);
  const text = parsed.body ?? parsed.texts[""] ?? "";
  const points = Array.from(text);

  const slotOf = (body: string, cut: boolean, left: number | undefined): ScreenSlot => ({
    from: fromParty,
    to: parties
      .slice(0, kept)
      .filter(([field]) => field === "to")
      .map(([, one]) => one),
    cc: parties
      .slice(0, kept)
      .filter(([field]) => field === "cc")
      .map(([, one]) => one),
    more_addressees: addressees.length - kept,
    subject,
    date: parsed.headers.date?.[0] ?? null,
    category: row.category,
    bulk: row.bulk,
    direction: row.direction,
    attachments,
    text: body,
    cut,
    ...(left === undefined ? {} : { omitted: left }),
  });

  const whole = slotOf(text, omitted > 0, omitted > 0 ? omitted : undefined);
  if (stateBytes(whole) <= STATE_BYTES) return whole;

  // The text is cut. What the rest of the slot takes is measured with the marker and the
  // largest count the slot could carry; addressees are dropped from the end until it fits.
  const most = omitted + points.length;
  const base = (): number => stateBytes(slotOf(MARKER, true, most));
  while (base() > STATE_BYTES && kept > 0) kept -= 1;
  const cut = cutAround(points, Math.max(0, STATE_BYTES - base()));
  return slotOf(cut.text, true, omitted + cut.omitted);
}

// The head and the tail of a text around the marker, within `room` bytes of escaped JSON: the
// head takes HEAD_SHARE of the room, the tail the rest; every cut falls between code points.
function cutAround(points: readonly string[], room: number): { text: string; omitted: number } {
  const head = fitting(points, Math.floor(room * HEAD_SHARE));
  const tailRoom = room - (bytes(points.slice(0, head).join("")) - 2);
  const rest = points.slice(head);
  const tail = fitting([...rest].reverse(), tailRoom);
  return {
    text: `${points.slice(0, head).join("")}${MARKER}${rest.slice(rest.length - tail).join("")}`,
    omitted: points.length - head - tail,
  };
}

// The `record` slot of DECIDE_RECORD, an agent's finding, cut by the same rule applied to its one
// field `text`: the state as it is sent, `JSON.stringify({ record: slot })`, within STATE_BYTES of
// UTF-8, the head and the tail of the text kept around the marker, every cut between code points.
type RecordSlot = { kind: "finding"; text: string; cut: boolean; omitted?: number };

const recordBytes = (slot: RecordSlot): number => bytes({ record: slot });

export function fitRecordSlot(body: string): RecordSlot {
  const whole: RecordSlot = { kind: "finding", text: body, cut: false };
  if (recordBytes(whole) <= STATE_BYTES) return whole;
  const points = Array.from(body);
  const cut = cutAround(
    points,
    Math.max(0, STATE_BYTES - recordBytes({ kind: "finding", text: MARKER, cut: true, omitted: points.length })),
  );
  return { kind: "finding", text: cut.text, cut: true, omitted: cut.omitted };
}
