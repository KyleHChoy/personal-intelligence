import type { EvidenceId } from "@intelligence/contracts";
import { faultOf } from "@intelligence/contracts/personal";
import { parse } from "@intelligence/personal-core";
import { ownerSent, pipelineItemOf } from "@intelligence/personal-core/items";
import { EXTRACT_CONFIG, type ExtractDeps } from "./config.ts";

// Whether an agent's quote of the owner is the owner's own words in what they wrote. A standing release keeps
// a quoted proposal in place of a card, so the quote must be found, not only asserted: each of its
// parts is a run of words of an item the proposal cites that the owner wrote: mail they sent (Gmail's
// SENT and not SPAM), never an event they organize, whose text a booking tool or another person may
// have written, in its own text, never a part quoted from another message. Words are compared
// whole, case folded, punctuation and spacing aside, and a quote has three words at least. Anything
// that cannot be opened or read is not the owner's: a refusal with its own code (a store's, the
// parser's `parse_failed`) or a driver's error. Anything else is a bug, and is thrown. Known limit:
// a run of the owner's words can still be cut to change their sense ("want to join" out of "do
// not want to join"); the intake's claims_said check, which asks whether the fact is what the
// owner said, is the guard for meaning.

// Letters and digits alone, one space between words, so a quote matches whole words only.
const words = (text: string): string =>
  ` ${text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;
// A quote of fewer words than this is too short to show it is the owner's (a "yes" is in any mail).
const FEWEST_WORDS = 3;

export async function ownerQuoted(
  quotes: readonly string[],
  cites: readonly string[],
  store: Pick<ExtractDeps["store"], "open">,
): Promise<boolean> {
  const wanted = quotes.map(words);
  if (wanted.length === 0 || wanted.some((one) => one.trim().split(" ").length < FEWEST_WORDS) || cites.length === 0)
    return false;
  const his: string[] = [];
  for (const id of cites) {
    try {
      const opened = await store.open(id as EvidenceId);
      if (opened === null || opened.raw.sourceKind !== "email" || !ownerSent(opened.raw)) continue;
      const parsed = await parse(
        pipelineItemOf(opened.raw, opened.context),
        new Uint8Array(Buffer.from(opened.raw.payload, "base64")),
        EXTRACT_CONFIG.limits,
      );
      for (const segment of parsed.segments) if (!segment.quoted) his.push(words(segment.text));
    } catch (error) {
      if (!faultOf(error).expected) throw error;
    }
  }
  return wanted.every((one) => his.some((text) => text.includes(one)));
}
