import type { InteractionRecord } from "@intelligence/contracts";
import { sha256Hex } from "../core/ids.ts";

type InteractionPair = { id: string; member: string; entity: string; bodyHash: string | null };

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

// A message: one row for each pair of a member and an entity. For a message a member sent,
// that is the sender with each recipient, and the row holds the hash of the body. For one a
// member received, it is each team recipient with each participant, and no hash.
export function interactionOf(record: InteractionRecord): InteractionPair[] {
  const sent = record.direction === "outbound";
  const members = sent ? (record.sender === undefined ? [] : [record.sender]) : record.teamRecipients;
  const entities = sent ? (record.sent?.recipients ?? record.participants) : record.participants;
  const bodyHash = sent ? (record.sent?.bodyHash ?? null) : null;
  return unique(members).flatMap((member) =>
    unique(entities).map((entity) => ({
      id: `il-${sha256Hex(`${record.evidenceId}\n${member}\n${entity}`).slice(0, 40)}`,
      member,
      entity,
      bodyHash,
    })),
  );
}
