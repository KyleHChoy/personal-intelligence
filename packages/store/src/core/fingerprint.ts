import { createHmac } from "node:crypto";

// The fingerprint kinds, each with the normal form its value is taken in. A new kind edits this file,
// not the key file's loader: a fingerprint needs the fingerprint key and nothing else of a key set.

// `payload` is the send proxy's: a draft's payload_fp, over the hex SHA-256 of its canonical form.
// `reveal` is the send proxy's reveal code, over a text, so it is a kind of its own.
export type FingerprintKind =
  | "address"
  | "goal_statement"
  // An improvement's title, as a name is, so a second report of the same words joins the first.
  | "improvement_title"
  // An agent's learning's statement, as a name is, so the same words of the same scope merge.
  | "learning_statement"
  | "domain"
  | "name"
  | "source_id"
  | "revision_tag"
  | "thread"
  | "content_hash"
  | "body_hash"
  | "payload"
  | "reveal"
  | "claim"
  | "fact"
  | "model_input"
  | "belief_state"
  | "cites"
  | "agent_claim"
  | "open_item"
  | "memory_projection"
  | "memory_line"
  | "memory_locator"
  | "gmail_label"
  | "sample"
  | "url"
  | "host"
  | "research_query"
  | "anchor"
  | "capture_scope"
  | "mirror_projection"
  | "phone"
  | "value"
  | "chat_lines"
  | "check_target"
  | "tier_trait"
  | "holdout"
  // A promotion's provenance: its id and the ids of the claims it carries, and, on the receiving side,
  // a promoted claim's id from the provenance and its ref.
  | "promotion";

const unchanged = (value: string): string => value;

function withoutTrailingDots(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === ".") end -= 1;
  return value.slice(0, end);
}

// The `capture_scope` normal form: case-folded, any trailing dot dropped. Scope rules are matched by it.
export const scopeNormal = (value: string): string => withoutTrailingDots(value.toLowerCase());

const NORMALIZE: Record<FingerprintKind, (value: string) => string> = {
  address: (value) => value.trim().toLowerCase(),
  domain: (value) => withoutTrailingDots(value.trim().toLowerCase()),
  name: (value) => value.normalize("NFKC").trim().split(/\s+/).join(" ").toLowerCase(),
  // A proposed goal's statement, as a name is, so the owner's no binds the same words.
  goal_statement: (value) => value.normalize("NFKC").trim().split(/\s+/).join(" ").toLowerCase(),
  improvement_title: (value) => value.normalize("NFKC").trim().split(/\s+/).join(" ").toLowerCase(),
  learning_statement: (value) => value.normalize("NFKC").trim().split(/\s+/).join(" ").toLowerCase(),
  source_id: unchanged,
  revision_tag: unchanged,
  thread: unchanged,
  // Each takes a hash's 64 hexadecimal characters: a hash of content is stored only keyed.
  content_hash: unchanged,
  body_hash: unchanged,
  payload: unchanged,
  // A text of ids and a fingerprint, taken as it is.
  reveal: unchanged,
  claim: unchanged,
  promotion: unchanged,
  fact: unchanged,
  model_input: unchanged,
  belief_state: unchanged,
  // The message and event ids an agent record cited as the client sent them, sorted and joined by
  // newlines, so a retry is judged by what was sent and not by what the ids resolve to.
  cites: unchanged,
  // The claim key, over an agent record's evidence id, a line feed and a claim's fact_key_fp. It
  // survives a generation raise, which changes every claim id.
  agent_claim: unchanged,
  open_item: unchanged,
  // A memory entry's projection id, over the client id, the fact key fingerprint, the entry's
  // visible values and the template's name, each on its own line.
  memory_projection: unchanged,
  memory_line: unchanged,
  memory_locator: unchanged,
  // A sealed Gmail label, over the account id, a space and the label id.
  gmail_label: unchanged,
  sample: unchanged,
  url: unchanged,
  host: unchanged,
  research_query: unchanged,
  // Lens: a device anchor's key and an item's match key, each
  // `<kind>:<normal form>` as core's deviceAnchorKey and captureMatchKeys made it, unchanged.
  anchor: unchanged,
  // Lens: a capture scope rule's bundle id, host or account, as an item's are,
  // case-folded, with any trailing dot dropped, so `Example.TEST.` and `example.test` match.
  capture_scope: scopeNormal,
  // Lens: a mirror entry's projection id, over the client id, its audience sorted
  // and comma-joined, the template, the section and the entry's key, each on its own line, as
  // memory_projection is taken, unchanged.
  mirror_projection: unchanged,
  phone: unchanged,
  // A claim's value fingerprint, over the canonical JSON of its type, fields and end
  // (claim-columns.ts, valueFpOf), unchanged.
  value: unchanged,
  // A source moment's lines fingerprint, over the derivation's version, the revision's evidence id,
  // `others`, the owner's word and each handle's resolved entity, one per line, as chat-lines.ts
  // writes them, unchanged: knowledge.captures.lines_fp.
  chat_lines: unchanged,
  // What a source check checked (a belief's audience, fact key and support, or a relation's row,
  // each line by line as the dream pass writes it), and an audit's selector and a check's replay
  // subject over the same, unchanged.
  check_target: unchanged,
  // A trait people share, `<kind>:<value>`, as a name is, so "Head of Finance" and
  // "head of  finance" are one trait (tier-proposer.ts).
  tier_trait: (value) =>
    value
      .normalize("NFKC")
      .trim()
      .split(/[ \t]+/)
      .join(" ")
      .toLowerCase(),
  // An agent record's id, which decides whether a standing release holds it out (pipeline-cards.ts).
  holdout: unchanged,
};

// HMAC-SHA-256, hex, under the fingerprint key, over the kind, a zero byte and the normalized
// value, so the same text under two kinds gives two fingerprints.
export function fingerprint(keys: { readonly fingerprintKey: Buffer }, kind: FingerprintKind, value: string): string {
  return createHmac("sha256", keys.fingerprintKey)
    .update(`${kind}\0${NORMALIZE[kind](value)}`, "utf8")
    .digest("hex");
}

// The claim key: the pair of the agent record's evidence id and the claim's fact_key_fp, which no
// generation raise changes. policy.confirmed_claims answers on it, so every key that meets another
// is made here.
export const claimKey = (keys: { readonly fingerprintKey: Buffer }, evidenceId: string, factKeyFp: string): string =>
  fingerprint(keys, "agent_claim", `${evidenceId}\n${factKeyFp}`);
