import { CARD_OPTIONS, type CardLine } from "@intelligence/contracts/personal";
import type { CardKindRow } from "../../cards/card-kind-row.ts";
import { codeLine, headLines, part } from "../../cards/card-line.ts";
import { AdminError } from "../../core/admin-error.ts";
import { requestIdOf } from "../../core/ids.ts";
import { TIER_LOCK } from "../../core/locks.ts";
import { cardRulingRequest } from "../../core/queue.ts";
import type { Tx } from "../../core/tx.ts";
import { ownerWho, ownerWithheld } from "../admin-owner.ts";
import { caseOf, peopleOf, ruledIn, traitOfCard } from "../people/tier-proposer.ts";
import { writeTier } from "../rulings/admin-tier-rows.ts";

const source = (line: string): CardLine => ({ text: line, from: "source" });

// The request id of the tier ruling an answer makes for one person: the answer's own ruling id,
// then 20 characters of the person's hash, within a request id's 64.
export const tierRulingRequest = (ruling: string, person: string): string =>
  `${cardRulingRequest(ruling)}_${requestIdOf(person).slice(0, 20)}`;
export const tierProposal: CardKindRow = {
  options: CARD_OPTIONS.tier_proposal,
  // The tier lock, as `setTier` and the pass take it, in decide's one lock call.
  lockIds: async () => [TIER_LOCK],
  async render(card, _open, { query, keys }) {
    const head = headLines(card);
    const pair = caseOf(card);
    if (pair === null) return [...head, codeLine("proposal_none")];
    const tx: Tx = { query, keys };
    const people = peopleOf(card);
    const trait = await traitOfCard(tx, card, pair);
    // One ruled on when the card was raised is one the owner moved; one ruled on since keeps their ruling.
    const before = await ruledIn(query, people, card.createdAt);
    const now = await ruledIn(query, people, null);
    const who = await ownerWho(tx, [...people, ...(trait?.kind === "organization" ? [trait.value] : [])]);
    // A name or address is what a source said; one with neither is named by its id.
    const named = (id: string, fallback: string): CardLine => {
      const one = who.get(id);
      const name = one?.name?.untrusted ?? one?.address?.untrusted;
      return name === undefined
        ? codeLine("unnamed", [part.code(fallback), part.id("entity", id)], [{ kind: "entity", id }])
        : source(name);
    };
    const traitLines =
      trait === undefined
        ? [codeLine("trait_gone")]
        : [
            codeLine("trait", [part.code(trait.kind)]),
            ...(trait.kind === "organization"
              ? [
                  named(trait.value, "organization"),
                  ...(trait.relation === null ? [] : [codeLine("trait_as"), source(trait.relation)]),
                ]
              : [source(trait.value)]),
          ];
    const since = people.filter((id) => !before.has(id) && now.has(id));
    return [
      ...head,
      ...traitLines,
      codeLine("tier", [part.code(pair.tier)]),
      codeLine("tier_already", [part.code(pair.tier)]),
      ...people.filter((id) => before.has(id)).map((id) => named(id, "person")),
      codeLine("tier_proposed", [part.code(pair.tier)]),
      ...people.filter((id) => !now.has(id)).map((id) => named(id, "person")),
      ...(since.length === 0 ? [] : [codeLine("tier_since"), ...since.map((id) => named(id, "person"))]),
      codeLine("tier_note"),
    ];
  },
  effect: async ({ query, card, answer, ruling, now, keys }) => {
    if (answer !== "confirm") return;
    const pair = caseOf(card);
    if (pair === null) throw new AdminError("not_found");
    // Only people who still hold the trait in the owner's audience and are not withheld, and never one
    // the owner has ruled on (invariant 11): the moved, and any they ruled on since the card was raised.
    const trait = await traitOfCard({ query, keys }, card, pair);
    if (trait === undefined) return;
    const withheld = await ownerWithheld(query);
    const people = peopleOf(card).filter((id) => trait.people.has(id) && !withheld.has(id));
    const ruled = await ruledIn(query, people, null);
    for (const person of people.filter((id) => !ruled.has(id))) {
      // Named by the card's answer, so a tier ruling an answer made, a relayed one among them, is
      // found from that answer (`card_<ruling>_`, as a fact ruling's `card_<ruling>`).
      const requestId = tierRulingRequest(ruling, person);
      try {
        await writeTier(query, keys, person, pair.tier, requestId, now);
      } catch (error) {
        // A person no longer a person since the card was raised is passed over: the write refuses
        // before it writes anything.
        if (error instanceof AdminError && (error.code === "not_found" || error.code === "not_a_person")) continue;
        throw error;
      }
    }
  },
};
