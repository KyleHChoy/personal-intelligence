import { z } from "zod";

// The verb an owed item's row leads with: the
// first word of the item's own wording when it is one of these action verbs, else "Do". Code reads it
// from the words; no model chooses it. A leading "to" is passed over, so "to send the deck" is Send.
export const OWED_VERBS = [
  "Send",
  "Submit",
  "Write",
  "Reply",
  "Respond",
  "Call",
  "Email",
  "Text",
  "Pay",
  "Book",
  "Schedule",
  "Sign",
  "Review",
  "Read",
  "Finish",
  "Return",
  "Share",
  "Draft",
  "Prepare",
  "Introduce",
  "Confirm",
  "Update",
  "Check",
  "File",
  "Fill",
  "Order",
  "Buy",
  "Register",
  "Apply",
  "Ask",
  "Meet",
  "Follow",
  "Do",
] as const;
export const OwedVerb = z.enum(OWED_VERBS);
export type OwedVerb = z.infer<typeof OwedVerb>;

const BY_WORD: ReadonlyMap<string, OwedVerb> = new Map(OWED_VERBS.map((verb) => [verb.toLowerCase(), verb]));

// The verb and the rest of the words without it. With no verb the rest is the whole wording, trimmed.
export function owedVerb(words: string): { verb: OwedVerb; rest: string } {
  const trimmed = words.trim();
  const [first, ...after] = trimmed.split(/\s+/);
  const skipped = first?.toLowerCase() === "to" && after.length > 0;
  const [word = "", ...rest] = skipped ? after : [first ?? "", ...after];
  const verb = BY_WORD.get(word.toLowerCase().replace(/[.,;:!?]+$/, ""));
  if (verb === undefined) return { verb: "Do", rest: trimmed };
  return { verb, rest: rest.join(" ") };
}

// The same, on wording served inside { untrusted }: the rest stays inside it, and held wording (null)
// is Do with no rest.
export const owedWords = (
  what: { untrusted: string } | null,
): { verb: OwedVerb; rest: { untrusted: string } | null } => {
  if (what === null) return { verb: "Do", rest: null };
  const { verb, rest } = owedVerb(what.untrusted);
  return { verb, rest: { untrusted: rest } };
};
