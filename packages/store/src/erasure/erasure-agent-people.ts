import { namedEntities, parsePersonProposalBody } from "@intelligence/contracts/personal";
import { agentPersonId, contactItemId } from "@intelligence/personal-core/items";
import { fingerprint } from "../core/fingerprint.ts";
import type { Keys } from "../core/keys.ts";
import { open, type Sealed } from "../core/seal.ts";
import { removeRecords } from "../write/writer-records.ts";
import { type ErasureHook, peopleOf } from "./erasure-hook.ts";
import { taintCiting } from "./taint.ts";

// Invariant 10: erasing a person removes every propose_person record about them,
// with its claims and its released claim, so nothing of the person (a name, an address, an agent's
// basis or quote) stays in the vault: the record whose confirmed proposal made the erased contact
// (its resource name is the record's evidence id, core's agent-people.ts), found by the erased item's
// source fingerprint; and every record whose body names an erased
// person as a tie's person or a link's end, opened under the admin's keys. A record the key file
// cannot open is left (it names nobody the admin can read). A dry run counts.

type Row = { id: string; evidence_id: string | null; compartments: string[]; body_enc: Sealed };

function names(keys: Keys, row: Row, erased: ReadonlySet<string>): boolean {
  if (erased.size === 0 || row.compartments.some((one) => !keys.compartments.has(one))) return false;
  const body = parsePersonProposalBody(open(keys, row, "ledger.agent_writes.body_enc", "throw"));
  return body !== null && namedEntities(body).some((id) => erased.has(id));
}

export const agentPeopleErasure: ErasureHook = {
  name: "agent_people",
  taints: true,
  async run(query, erased, { dryRun, keys }) {
    const accounts = new Set(
      (
        await query<{ id: string }>("select id from vault.source_accounts where connector = 'agent_people' order by id")
      ).map((row) => row.id),
    );
    const fps = new Set(erased.sources.filter((one) => accounts.has(one.accountId)).map((one) => one.sourceItemFp));
    const people = new Set(peopleOf(erased));
    if (fps.size === 0 && people.size === 0) return 0;
    const records = await query<Row>(
      "select id, evidence_id, compartments, body_enc from ledger.agent_writes where tool = 'propose_person' and body_enc is not null order by id",
    );
    const ids = records
      .filter(
        (row) =>
          (row.evidence_id !== null &&
            fps.has(fingerprint(keys, "source_id", contactItemId(agentPersonId(row.evidence_id))))) ||
          names(keys, row, people),
      )
      .map((row) => row.id);
    if (dryRun) return ids.length;
    const { removed, evidenceIds } = await removeRecords({ query }, ids);
    if (evidenceIds.length > 0) await taintCiting(query, { evidenceIds, refs: [] });
    return removed;
  },
};
