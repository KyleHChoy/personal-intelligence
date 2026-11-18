import type { ClaimTier, CommitmentItem, FactSource, Provenance } from "@intelligence/contracts/personal";
import { sourceWords } from "./enum-words.ts";

// Provenance in words, from one fixed map, so a tier always reads the same. A source's claim
// says where it came from by its `source`; one that names none reads as another source.
const TIER_WORDS: Record<Exclude<ClaimTier, "source">, string> = {
  owner: "You said",
  owner_confirmed: "You said",
  // The answer from the owner, relayed by the agent that asked them.
  owner_relayed: "Your answer to an agent",
  observed: "Observed",
  agent_inferred: "An agent (inferred)",
  agent_closed: "An agent closed it",
  system_notice: "A notice",
  researched: "From research",
  // Never "You said": a second agent confirmed an agent's claim, and the owner said nothing.
  agent_confirmed: "Confirmed by an agent",
};

// A belief made before tiers were recorded carries no tier: its provenance stands in for it.
export const provenanceOf = (item: CommitmentItem): string =>
  factFrom({
    tier: item.belief.tier,
    provenance: item.belief.provenance,
    source: item.source,
  });

// A claim's provenance in words, by the same map, for a claim rather than a commitment.
export function factFrom(fact: {
  tier?: ClaimTier | undefined;
  provenance: Provenance;
  source?: FactSource | undefined;
}): string {
  const known: ClaimTier =
    fact.tier ??
    (fact.provenance === "owner" ? "owner" : fact.provenance === "agent_reported" ? "agent_inferred" : "source");
  if (known === "source") return sourceWords(fact.source);
  return TIER_WORDS[known];
}

// A code as words: `not_now` reads "Not now".
export const wordsOf = (code: string): string => {
  const text = code.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
};

// The first letter in capitals, for a time that starts a line: "Today 10:59 AM".
export const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
// Two texts that say the same, but for case, spaces and a closing stop: a line that would repeat its
// title is left out.
export const sameWords = (a: string, b: string): boolean => {
  const plain = (text: string): string => text.trim().replace(/\s+/g, " ").replace(/[.!]$/, "").toLowerCase();
  return plain(a) === plain(b);
};
// A veto, in the owner's words: the menu's choice and what it does.
export const NEVER_USE = {
  words: "Never use it",
  note: "It counts toward nothing, ever",
  done: "Never to be used",
} as const;
// A person the reads hold no name for, where a sentence needs a subject: a hop in the middle of a
// path, a commitment's other side. Never a list row.
export const UNNAMED = "someone you have no name for";
// An organization with neither a name nor a domain on record for this viewer.
export const UNNAMED_ORGANIZATION = "An organization with no name";

// The words as written, with no full stop or question mark at their end.
export const unstop = (text: string): string => text.trim().replace(/[.?!]+$/, "");
// Words set after a question's colon: quoted when they hold a colon of their own, so the question
// still reads as one ("Was this useful: "Two people run it: ..."?").
export const told = (text: string): string => (unstop(text).includes(":") ? `"${unstop(text)}"` : unstop(text));
