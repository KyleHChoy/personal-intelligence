import { createHash } from "node:crypto";
import type { IdentityResolver, LocalEntityId } from "@intelligence/contracts";
import { evidenceIdFor } from "@intelligence/contracts/evidence-id";
import type { OpenedItem, SourceAccountId, SubjectKind } from "@intelligence/contracts/personal";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
// A ULID-shaped id made from a text: the same text, the same id.
export const ulidOf = (text: string): string => {
  const digest = createHash("sha256").update(text, "utf8").digest();
  return Array.from({ length: 26 }, (_, n) => CROCKFORD[(digest[n] ?? 0) % 32]).join("");
};

type Mention = Parameters<IdentityResolver["resolve"]>[0];

// One evaluation item as the pipeline opens a stored one, under `own`, with nothing stored. Its
// identity port links a mention to the person `who` finds, as the owner for the owner's address,
// and finds no person for any other mention.
export function openedEval(
  raw: OpenedItem["raw"],
  account: SourceAccountId,
  owner: { address: string; entity: LocalEntityId },
  who: (mention: Mention) => { address: string; entity: LocalEntityId } | null,
): OpenedItem {
  const answered = new Map<string, SubjectKind>();
  const identity: IdentityResolver = {
    async resolve(mention) {
      const found = who(mention);
      if (found === null) return { outcome: "not_a_person" };
      answered.set(found.entity, found.address === owner.address ? "owner" : "person");
      return { outcome: "linked", entity: found.entity, epoch: 0 };
    },
  };
  const evidenceId = evidenceIdFor({
    vault: "personal",
    sourceAccount: account,
    sourceItemId: raw.sourceItemId,
    revision: 0,
  });
  return {
    raw,
    context: {
      evidenceId,
      revision: 0,
      compartment: "own",
      ownerAddresses: [owner.address],
      ownerEntity: owner.entity,
      identity,
    },
    changeKind: raw.changeKind,
    systemOriginated: false,
    answersSystem: false,
    kindOf: (entity) => answered.get(entity),
  };
}
