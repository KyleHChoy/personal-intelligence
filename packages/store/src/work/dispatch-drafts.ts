import type {
  CardAuthor,
  CardId,
  DraftId,
  LedgerRef,
  PersonalLogger,
  PersonalRef,
} from "@intelligence/contracts/personal";
import { CARD_OPTIONS } from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import { type Query, stamp } from "../core/db.ts";
import { newId } from "../core/ids.ts";
import { authorWord, caseWord } from "../core/locks.ts";
import { type FingerprintRef, latestOf, lockRows, raiseCard, vetoed } from "../core/queue.ts";
import { latestEvent } from "../core/statements.ts";

// The tick's two steps for drafts, as pi_work: a draft_waiting card for a draft that is made, and a
// draft's expiry after seven days. Ids, fingerprints and states only: pi_work cannot select a
// draft's body, and nothing here opens anything. Each write locks its rows before it reads their
// state, so each is safe to repeat. A tainted draft's card is withdrawn by the deleting transaction
// (taint_citing, forget_recipients), never here.

const BY = "system:work";
const DRAFT_DAYS = 7;

const LATEST = `(${latestEvent("draft", "d.id")})`;
// A send of the draft that may still have left: sending or unknown.
const IN_FLIGHT = `exists (select 1 from ledger.sent_messages s where s.draft_id = d.id
  and (${latestEvent("send", "s.id")}) in ('sending', 'unknown'))`;

// Made, not tainted, and no card about it yet.
export const draftsWithoutCard = async (query: Query): Promise<DraftId[]> =>
  (
    await query<{ id: DraftId }>(
      `select d.id from ledger.drafts d
       where d.tainted_at is null and ${LATEST} = 'made'
         and not exists (select 1 from ledger.cards c where c.target_kind = 'draft' and c.target_id = d.id)
       order by d.created_at, d.id`,
    )
  ).map((row) => row.id);

// Made or held for seven days, by the database's clock, with no send of it in flight.
export const draftsToExpire = async (query: Query): Promise<DraftId[]> =>
  (
    await query<{ id: DraftId }>(
      `select d.id from ledger.drafts d
       where ${LATEST} in ('made', 'held') and d.created_at <= now() - make_interval(days => ${DRAFT_DAYS}) and not ${IN_FLIGHT}
       order by d.created_at, d.id`,
    )
  ).map((row) => row.id);

type Draft = {
  id: DraftId;
  created_by: CardAuthor;
  created_at: Date;
  compartments: string[];
  opportunity_id: string | null;
  recipient_fps: string[];
  recipient_domain_fps: string[];
  case_key: string | null;
};

const draftOf = async (query: Query, id: string): Promise<Draft | null> =>
  (
    await query<Draft>(
      "select id, created_by, created_at, compartments, opportunity_id, recipient_fps, recipient_domain_fps, case_key from ledger.drafts where id = $1 and tainted_at is null",
      [id],
    )
  )[0] ?? null;

export async function expireDraft(query: Query, id: DraftId): Promise<boolean> {
  await lockRows(query, [id]);
  const [due] = await query<{ compartments: string[] }>(
    `select d.compartments from ledger.drafts d
     where d.id = $1 and ${LATEST} in ('made', 'held') and d.created_at <= now() - make_interval(days => ${DRAFT_DAYS}) and not ${IN_FLIGHT}`,
    [id],
  );
  if (due === undefined) return false;
  await query(
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('draft', $1, 'expired', now(), $2, $3)",
    [id, BY, due.compartments],
  );
  return true;
}

// Every veto question of the gate's `vetoes` check, as one policy.vetoed call: each recipient's
// address and domain fingerprint, the basis refs, what the opportunity is about, and the kind
// of work (the opportunity's, or `proposal`).
async function draftVetoed(query: Query, draft: Draft): Promise<boolean> {
  const basis = await query<{ kind: string; id: string }>(
    "select ref_kind as kind, ref_id as id from ledger.basis where row_kind = 'draft' and row_id = $1 order by id",
    [draft.id],
  );
  const [work] =
    draft.opportunity_id === null
      ? []
      : await query<{ kind: string; about_kind: string; about_id: string | null }>(
          "select kind, about_kind, about_id from ledger.opportunities where id = $1",
          [draft.opportunity_id],
        );
  const refs: (PersonalRef | FingerprintRef)[] = [
    ...draft.recipient_fps.map((id) => ({ kind: "address" as const, id })),
    ...draft.recipient_domain_fps.map((id) => ({ kind: "domain" as const, id })),
    ...(basis as PersonalRef[]),
    ...(work?.about_id == null ? [] : [{ kind: work.about_kind, id: work.about_id } as PersonalRef]),
  ];
  return vetoed(query, { refs, kind: work?.kind ?? "proposal" });
}

// The case key is the draft's, never the card's.
async function rejectedCase(query: Query, draft: Draft): Promise<boolean> {
  if (draft.case_key === null) return false;
  const [row] = await query<{ held: boolean }>(
    `select exists (
       select 1 from ledger.drafts d where d.case_key = $1 and d.id <> $2 and ${LATEST} = 'rejected'
     ) and not exists (
       select 1 from ledger.basis b
       where b.row_kind = 'draft' and b.row_id = $2 and b.source_class = 'source' and b.tainted_at is null
         and not exists (
           select 1 from ledger.drafts d join ledger.basis o on o.row_kind = 'draft' and o.row_id = d.id
           where d.case_key = $1 and d.id <> $2 and ${LATEST} = 'rejected' and o.ref_kind = b.ref_kind and o.ref_id = b.ref_id)
     ) as held`,
    [draft.case_key, draft.id],
  );
  return row?.held === true;
}

// Step 1: a made draft's card, by the client that made it, expiring with the draft. Null when the
// state has moved, a card is already about it, a veto covers it, or the owner rejected its case.
export async function raiseDraftCard(
  query: Query,
  id: DraftId,
  now: Date,
  log?: PersonalLogger,
): Promise<CardId | null> {
  const found = await draftOf(query, id);
  if (found === null) return null;
  const caseKey = `draft:${id}`;
  await lockRows(query, [id, authorWord(found.created_by), caseWord(caseKey)]);
  const draft = await draftOf(query, id);
  if (draft === null || (await latestOf(query, "draft", id)) !== "made") return null;
  if (
    (await query("select 1 from ledger.cards where target_kind = 'draft' and target_id = $1 limit 1", [id])).length > 0
  )
    return null;
  if ((await draftVetoed(query, draft)) || (await rejectedCase(query, draft))) return null;
  const card = await raiseCard(
    query,
    {
      id: newId("crd") as CardId,
      requestId: newId("crd"),
      kind: "draft_waiting",
      author: draft.created_by,
      options: [...CARD_OPTIONS.draft_waiting],
      target: { kind: "draft", id } as LedgerRef,
      refs: [],
      compartments: [...draft.compartments].sort(),
      expiresAt: stamp(new Date(draft.created_at.getTime() + DRAFT_DAYS * DAY_MS)),
      expiresAfterDays: null,
      caseKey,
      run: null,
      body: null,
      bodyFrom: null,
    },
    { now, ...(log === undefined ? {} : { log }) },
  );
  return card.id;
}
