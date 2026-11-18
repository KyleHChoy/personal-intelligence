import { ConnectorCursor, Timestamp } from "@intelligence/contracts";
import type { PersonalLogger } from "@intelligence/contracts/personal";
import { PERSONAL_LIMITS, proposalKey } from "@intelligence/personal-core";
import { agentPersonId, agentPersonItem, contactKept, deriveItem } from "@intelligence/personal-core/items";
import {
  AGENT_PEOPLE_PREFIX,
  type ConfirmedProposal,
  fingerprint,
  type Keys,
  type Writer,
} from "@intelligence/personal-store";

// At each sync, under its lock and before the identity sweep, the people the owner
// confirmed from agents' proposals become saved contacts, one source account for each agent
// (`agent-people:<client>`, under `own`), each a complete listing: a person whose confirm was
// lifted, or whose record was removed or erased, is removed as a contact dropped from an import is.
// The contacts path does the rest: an identifier already held names that person (no duplicate),
// a name joins no one (the sweep raises a same_person card for a shared full name), and erasure
// and suppression stick (an erased item is answered `removed`, a suppressed identifier
// `suppressed`). A proposal with no identifier is keyed by the proposal itself (profile-key.ts).

export type AgentPeopleCounts = {
  stored: number;
  unchanged: number;
  suppressed: number;
  erased: number;
  unread: number;
  owners: number;
  removed: number;
};

export async function takeAgentPeople(
  writer: Writer,
  keys: Keys,
  now: Date,
  log: PersonalLogger,
): Promise<AgentPeopleCounts> {
  const at = Timestamp.parse(now.toISOString());
  const confirmed = await writer.confirmedPeople();
  const byClient = new Map<string, ConfirmedProposal[]>();
  for (const one of confirmed) byClient.set(one.client, [...(byClient.get(one.client) ?? []), one]);
  const held = (await writer.listSourceAccounts())
    .filter((one) => one.connector === "agent_people")
    .map((one) => one.label.slice(AGENT_PEOPLE_PREFIX.length));
  const owner = await writer.ownerAddresses();
  const counts: AgentPeopleCounts = {
    stored: 0,
    unchanged: 0,
    suppressed: 0,
    erased: 0,
    unread: 0,
    owners: 0,
    removed: 0,
  };
  for (const client of [...new Set([...byClient.keys(), ...held])].sort()) {
    const account = await writer.ensureAgentPeopleAccount(client);
    const items = (byClient.get(client) ?? []).map(({ record, person }) =>
      agentPersonItem(person, {
        sourceAccount: account.id,
        now: at,
        id: agentPersonId(record),
        proposalKey: proposalKey(fingerprint(keys, "source_id", `agent-person:${record}`)) ?? "",
      }),
    );
    const listed: string[] = [];
    for (const raw of items) {
      // The owner's own address names the owner, never a contact of theirs.
      if (contactKept(raw, owner) !== "keep") {
        counts.owners += 1;
        continue;
      }
      listed.push(raw.sourceItemId);
      const answer = await writer.ingestItem(account, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS));
      if (answer === "stored") counts.stored += 1;
      else if (answer === "repeat") counts.unchanged += 1;
      else if (answer === "suppressed") counts.suppressed += 1;
      else if (answer === "removed") counts.erased += 1;
      else counts.unread += 1;
    }
    const finished = await writer.finishPage(account, {
      listing: { first: true, ended: "complete" },
      listedIds: listed,
      skippedIds: [],
      next: ConnectorCursor.parse("agent-people"),
    });
    counts.removed += finished.removed;
    await writer.recordOutcome(account, "ok", at);
  }
  if (Object.values(counts).some((count) => count > 0)) log.info({ event: "agent_people_taken", counts });
  return counts;
}
