import type { ClaimRefusal, PersonProposalBody, PersonProposalFields } from "@intelligence/contracts/personal";
import { addressOf } from "../addresses.ts";
import { phoneWritten } from "../phones.ts";
import { profileKey } from "../profile-key.ts";
import { listsThree, standsAlone, wordGrounded } from "./claim-intake.ts";

// The claim intake for a propose_person body, pure, run by the store when it takes the call (the
// one authority, as for propose_about_you). A person's name is a proper name, held to its bounds
// alone; how the owner knows them must stand alone, as a key phrase about the owner does (no
// pronoun or pointer, no relative time word, one fact); with a quote, both use its words in its
// order. An address must read strictly, a LinkedIn URL must give a profile key, and a phone number
// must hold 7 to 15 digits and nothing but digits, spaces and + ( ) - . A relationship and a link
// hold closed lists and ids alone, which the schema and the store check.

export function personProposalRefusal(
  body: Pick<PersonProposalBody, "kind" | "fields" | "quote">,
): ClaimRefusal | null {
  if (body.kind !== "person") return null;
  const { name, known_how: how, email, phone, linkedin } = body.fields as PersonProposalFields["person"];
  if (body.quote !== undefined && (!wordGrounded(name, body.quote) || !wordGrounded(how, body.quote)))
    return "not_in_quote";
  if (listsThree(how) || listsThree(name)) return "multi_fact";
  if (!standsAlone(how, false, true)) return "not_standalone";
  if (email !== undefined && !("address" in addressOf(email))) return "bad_fields";
  if (linkedin !== undefined && profileKey(linkedin) === null) return "bad_fields";
  if (phone !== undefined && !phoneWritten(phone)) return "bad_fields";
  return null;
}
