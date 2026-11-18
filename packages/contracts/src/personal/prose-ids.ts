import { type IdPrefix, ULID_PATTERN } from "./ids.ts";

// An id token in prose a person reads is refused at intake with a code that says to write names;
// ids belong in refs and cites. The prose fields, by name, wherever they sit in a call's
// arguments: each a string a person reads (a basis of refs is no string, so not prose).
export const PROSE_FIELDS: readonly string[] = Object.freeze([
  "summary",
  "deliverable",
  "next",
  "uncertain",
  "statement",
  "note",
  "body",
  "whyNow",
  "plan",
  "decisionNeeded",
  "risks",
  "reason",
  "draft",
  "basis",
  "quote",
]);
// The ids agents are handed, the common ones and the rest (a hypothesis, a card, a test, an intent,
// a ruling, a work or research request), and a fact id, 64 hexadecimal characters.
const PROSE_ID_PREFIXES = [
  "ent",
  "rec",
  "opp",
  "msg",
  "mov",
  "hdl",
  "doc",
  "evt",
  "gol",
  "hyp",
  "crd",
  "tst",
  "int",
  "itn",
  "cap",
  "amg",
  "rul",
  "wrq",
  "rsq",
] as const satisfies readonly IdPrefix[];
const ID_TOKEN = new RegExp(String.raw`\b(?:(?:${PROSE_ID_PREFIXES.join("|")})_${ULID_PATTERN}|[0-9a-f]{64})\b`);
export const hasIdToken = (text: string): boolean => ID_TOKEN.test(text);

// The prose fields of a call's arguments that hold an id token, each by its path. Pure; walks
// objects and arrays. A path is only ever the schema's own keys: a call's arguments parsed strictly.
export function proseFieldsWithIds(args: unknown, path = ""): string[] {
  if (typeof args !== "object" || args === null) return [];
  return Object.entries(args).flatMap(([name, value]) => {
    const at = path === "" ? name : `${path}.${name}`;
    if (typeof value === "string") return PROSE_FIELDS.includes(name) && hasIdToken(value) ? [at] : [];
    return proseFieldsWithIds(value, at);
  });
}
// Whether any prose field of a call's arguments holds an id token.
export const idsInProse = (args: unknown): boolean => proseFieldsWithIds(args).length > 0;
