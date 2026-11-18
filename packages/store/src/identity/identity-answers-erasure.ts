import type { Query } from "../core/db.ts";
import { eraseFromWrongMerges } from "./wrong-merges.ts";

// A deletion and same-person questions: a question goes with either of its people, and its answers with
// it. An agent's answer rests on what it cites, a message, a contact, a name or an address, so when one is
// removed the ruling made from it is lifted, the answer goes, and the pair is offered again. The lift is marked
// as a deletion's: nobody said no, so it holds no pair apart and counts as no overturn. A ruling of the owner's is never touched:
// no answer names one. Where the owner linked exactly the two addresses the lifted ruling sat on,
// that link wrote no ruling of the owner's (admin-identity.ts, `rule`) and its decision names the
// ruling (`inPlaceOf`): the owner's `same` is written in its place under the owner's own decision,
// and the question is left as it stood, since their word settles the pair and rests on no message.
// One definer holds the rule for the answers, ledger.forget_identity_answers, so an erasure and a
// deletion at the source, which the writer runs, do the same thing.

export async function eraseFromQuestions(
  query: Query,
  addressFps: string[],
  evidenceIds: string[],
  people: string[],
  dryRun = false,
): Promise<number> {
  // An agent's report of a wrong merge rests on what it cites as an answer does.
  const reports = await eraseFromWrongMerges(query, { addressFps, evidenceIds, people }, dryRun);
  const [removed] = await query<{ n: number }>(
    `select ((select count(*) from ledger.identity_questions where a_fp = any($1::text[]) or b_fp = any($1::text[]))
       + (select count(*) from ledger.identity_answers a where a.cite_evidence && $2::text[]
          or a.cite_address_fps && $1::text[]
          or exists (select 1 from ledger.identity_questions q where q.id = a.question_id and (q.a_fp = any($1::text[]) or q.b_fp = any($1::text[])))))::int as n`,
    [addressFps, evidenceIds],
  );
  // A dream merge that rested on what goes is lifted, and its candidate goes.
  const [dreamed] = await query<{ n: number }>(
    "select ledger.count_dream_merges($1::text[], $2::text[], '{}'::text[]) as n",
    [evidenceIds, addressFps],
  );
  const count = (removed?.n ?? 0) + reports + (dreamed?.n ?? 0);
  if (dryRun) return count;
  if (evidenceIds.length > 0 || addressFps.length > 0)
    await query("select ledger.forget_dream_merges($1::text[], $2::text[], '{}'::text[])", [evidenceIds, addressFps]);
  // A deletion at the source names no address, and the writer may delete no question.
  if (addressFps.length > 0)
    await query("delete from ledger.identity_questions where a_fp = any($1) or b_fp = any($1)", [addressFps]);
  if (evidenceIds.length === 0 && addressFps.length === 0) return count;
  await query("select ledger.forget_identity_answers($1::text[], $2::text[])", [evidenceIds, addressFps]);
  return count;
}
