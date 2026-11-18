import type { RawItem } from "@intelligence/contracts";
import type { AccountKind, AddressMark, MessageCategory } from "@intelligence/contracts/personal";

// They only add to the shared `automated` rule: nothing here makes an item that rule marks
// automated count as a person's.

const BULK_MARKERS = ["CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_SOCIAL", "CATEGORY_FORUMS", "SPAM"];
// The labels a message's derived rows depend on: SENT makes it outbound and a bulk marker makes it
// bulk. The one list of them. A message's revision tag covers them, and the connector reads a
// message again only when one of them changed.
const DERIVING_LABELS = ["SENT", ...BULK_MARKERS];
// They stay bulk markers and deriving labels, so a change of one is still read from history.
const JUNK_MARKERS = ["CATEGORY_PROMOTIONS", "SPAM"];
const CONDITIONAL_MARKERS = ["CATEGORY_SOCIAL", "CATEGORY_FORUMS"];
// A sender's whole local part, before any "+" tag.
const BULK_SENDERS = ["automated", "alert", "alerts"];
const CATEGORY_LABELS: [string, MessageCategory][] = [
  ["CATEGORY_PROMOTIONS", "promotions"],
  ["CATEGORY_SOCIAL", "social"],
  ["CATEGORY_FORUMS", "forums"],
  ["CATEGORY_UPDATES", "updates"],
];

export const isDraft = (raw: RawItem): boolean => raw.markers.includes("DRAFT");

// SPAM wins over SENT: a message Gmail also calls spam is not believed to be the owner's.
const sentLabels = (labelIds: string[]): boolean => labelIds.includes("SENT") && !labelIds.includes("SPAM");

// So anything under SPAM is junk, and Promotions is junk when the owner did not send it.
const junkLabels = (labelIds: string[]): boolean =>
  labelIds.some((label) => JUNK_MARKERS.includes(label)) && !sentLabels(labelIds);

// The one test of "the owner sent it".
export const ownerSent = (raw: RawItem): boolean => sentLabels(raw.markers);

// Mail the owner sent is never junk: the store learns the owner's own addresses from it.
export const isJunk = (raw: RawItem): boolean => junkLabels(raw.markers);

// The Google connector asks it of a thread's labels.
export const isConditionalLabels = (labelIds: string[]): boolean =>
  labelIds.some((label) => CONDITIONAL_MARKERS.includes(label)) && !sentLabels(labelIds) && !junkLabels(labelIds);

export const isConditional = (raw: RawItem): boolean => isConditionalLabels(raw.markers);

// The deriving labels among a message's labels, sorted, each once.
export const derivingLabels = (labelIds: string[]): string[] =>
  [...new Set(labelIds.filter((label) => DERIVING_LABELS.includes(label)))].sort();

// Where Gmail filed a message: the first category whose label is among the markers, else primary.
export const messageCategory = (markers: string[]): MessageCategory =>
  CATEGORY_LABELS.find(([label]) => markers.includes(label))?.[1] ?? "primary";

// Social and Forums are lifted for a sender the owner has written to, and nothing else is: every
// other signal still makes the message bulk.
export function personalBulk(raw: RawItem, senderWrittenTo = false): boolean {
  const local = (raw.sender ?? "").toLowerCase().split("@")[0]?.split("+")[0] ?? "";
  const markers = senderWrittenTo
    ? BULK_MARKERS.filter((marker) => !CONDITIONAL_MARKERS.includes(marker))
    : BULK_MARKERS;
  return raw.markers.some((marker) => markers.includes(marker)) || BULK_SENDERS.includes(local);
}

// A machine's address by its shape alone, which get_self ranks last even when the owner wrote to it: a no-reply
// mailbox, as the shared `automated` rule reads one but in any case, or one that says "unsubscribe" anywhere, the
// mailbox an unsubscribe link wrote to. Not the shared rule's role names (hello, info, team): people write from
// those.
const NO_REPLY = ["noreply", "donotreply"];

export function automatedAddress(address: string): boolean {
  const lower = address.toLowerCase();
  const joined = (lower.split("@")[0] ?? "").replaceAll(/[-_.]/g, "");
  return NO_REPLY.some((word) => joined.startsWith(word)) || lower.includes("unsubscribe");
}

// A mailbox for a function, not a person: its local part, before any +tag and with - _ . dropped,
// one of these words, which get_self leaves out of the closest contacts. Not hello, info, team,
// contact, admin, office, sales, management, service or jobs: at a small organization one named
// person often writes from those.
const ROLES = new Set([
  "privacy",
  "support",
  "help",
  "helpdesk",
  "membership",
  "members",
  "billing",
  "accounts",
  "accounting",
  "invoices",
  "payments",
  "legal",
  "compliance",
  "security",
  "abuse",
  "postmaster",
  "webmaster",
  "notifications",
  "notification",
  "alerts",
  "orders",
  "receipts",
  "leasing",
  "concierge",
  "frontdesk",
  "reception",
  "reservations",
  "bookings",
  "customerservice",
  "customercare",
  "care",
  "feedback",
  "press",
  "careers",
  "recruiting",
  "newsletter",
  "marketing",
]);

export function roleAddress(address: string): boolean {
  const local = (address.toLowerCase().split("@")[0] ?? "").split("+")[0] ?? "";
  return ROLES.has(local.replaceAll(/[-_.]/g, ""));
}

// `shared` and `role` make it no person's; `person`, and `single` (the answer from the owner that one person
// writes from it), make it a person's whatever its shape. Unmarked: a machine's (automatedAddress, or a bulk
// sender's whole local part) is `bulk`, a function's mailbox (roleAddress) is `role`, and the rest are
// `email`.
export function addressKind(address: string, mark?: AddressMark | null): AccountKind {
  if (mark === "shared" || mark === "role") return mark;
  if (mark === "person" || mark === "single") return "email";
  const local = (address.toLowerCase().split("@")[0] ?? "").split("+")[0] ?? "";
  if (automatedAddress(address) || BULK_SENDERS.includes(local)) return "bulk";
  return roleAddress(address) ? "role" : "email";
}
