import {
  type CommitmentEnding,
  dayIn,
  type FactId,
  OPEN_BELIEF_STATUS,
  type OwnerCommitment,
  type OwnerCommitments,
  type OwnerCommitmentsArgs,
  owedWords,
  ownLabel,
  parseCloseBody,
  type RulingId,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import { COURTESY_DAYS } from "@intelligence/personal-core/views";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { ownerAudience } from "../../core/audience.ts";
import { dueOf } from "../../core/commitment-rules.ts";
import { type Query, stamp } from "../../core/db.ts";
import { fingerprint } from "../../core/fingerprint.ts";
import { reopenId } from "../../core/ids.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { lockRows } from "../../core/queue.ts";
import type { Sealed } from "../../core/seal.ts";
import { open } from "../../core/seal.ts";
import { OWNER_ENTITY_ORDERED } from "../../core/statements.ts";
import { openedUnder } from "../../core/tx.ts";
import { ownerTimeZone } from "../../core/zone.ts";
import { CLOSED_COMMITMENT } from "../../pipeline/pipeline-open.ts";
import {
  type CommitmentBeliefs,
  type CommitmentRow,
  type CommitmentScope,
  commitmentItems,
  dueAt,
  lapsedCommitments,
  type OpenCommitment,
  openCommitments,
} from "../../read/read-beliefs.ts";
import { type OwnerPlace, ownerBeliefs, ownerPage, ownerWho, ownerWithheld, pageOf } from "../admin-owner.ts";
import { ownerCtx } from "../owner-ctx.ts";
import { groupMembers } from "../people/admin-people.ts";
import { liftIn, ruleIn } from "../rulings/admin-rulings.ts";

// The owner's own commands on commitments, as pi_admin. `ownerCommitments` serves the commitments of
// the owner's own audience to `pi commitments list` and the page; `closeCommitment` is the owner's
// close at the terminal, a retire of the commitment's fact key with their ending and time beside it,
// their word; `reopenCommitment` ends every close of a commitment in force, by any agent or by the
// owner, and binds agents until they cite something newer; `listCloses` lists the closes; `pia
// commitments agent-closes` gives or takes back the owner's standing release. Nothing here is served
// to a client.

const FINGERPRINT = /^[0-9a-f]{64}$/;
// The pipeline wakes and runs its after-commit diff; an empty payload, as every agent write sends.
const WAKE = "select pg_notify('pi_agent_write', '')";

// Beliefs come through ownerBeliefs alone, the owner reads' one belief source, and only commitment
// beliefs are opened (by the claims' clear type). R-X1: batched claim statements, never one per
// commitment, whose statements are the same whatever the page holds.
//
// The reader's filters the scope states: claims, capture items, bindings, agent writes and a work
// view's rows within the owner's audience (pi_reader's clearance term); a message within it and
// neither held nor restricting (pi_reader's message policy), so a held message gives no `what`; an
// agent's answer unflagged (its policy's last term); a commitment with a withheld person or
// organization left out (ownerWithheld); a released claim only while its release is in force. The
// closes come from the definers get_commitments calls, which answer the owner every close.
// ---------------------------------------------------------------------------------------------

// A dated commitment is stale this many days past its due day; an undated one COURTESY_DAYS after
// it was made, when its courtesy lapses.
export const STALE_LATE_DAYS = 7;

// The fact keys of the owner's commitments, by the claims' clear type, so only their beliefs are
// opened.
const COMMITMENT_KEYS = `
  select distinct c.fact_key_fp from knowledge.claims c
  where c.type = 'commitment' and c.compartments <@ $1::text[]
  order by 1`;

const dueDay = (due: string, zone: string | null): string => (due.length === 10 ? due : dayIn(new Date(due), zone));
const daysFrom = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS);

const fits = (place: OwnerPlace): boolean =>
  place.length === 2 && typeof place[0] === "number" && typeof place[1] === "string" && FINGERPRINT.test(place[1]);

// The owner's commitment beliefs, as the commitments read takes them, and the scope it states.
// `within`: only those whose label lies in these compartments.
async function ownerRead(
  admin: AdminContext,
  query: Query,
  audience: string[],
  owner: string,
  within: readonly string[] | undefined,
): Promise<{ read: CommitmentBeliefs; scope: CommitmentScope }> {
  const tx = { query, keys: admin.keys };
  const scope: CommitmentScope = {
    audience,
    withheld: await ownerWithheld(query),
    who: (ids) => ownerWho(tx, ids),
    // Work time's rows, every one within their audience.
    work: {
      run: (text, values) => query(text, values),
      open: (table, column, row) =>
        openedUnder(admin.keys, row.compartments, { table, id: row.id, column }, row.value_enc),
      within: audience,
      clearance: async () => audience,
      anchorFp: (key) => fingerprint(admin.keys, "anchor", key),
      supportOf: async (facts) => (await ownerBeliefs(tx, facts)).map((one) => one.support),
    },
  };
  const keys = (await query<{ fact_key_fp: string }>(COMMITMENT_KEYS, [audience])).map((row) => row.fact_key_fp);
  const rows = (await ownerBeliefs(tx, keys)).filter(
    (row) => within === undefined || row.compartments.every((one) => within.includes(one)),
  );
  const read = {
    rows: rows.map((row) => ({
      id: row.id,
      fact_key_fp: row.factKey,
      state_fp: row.state,
      support: row.support,
      compartments: row.compartments,
      provenance: row.provenance as CommitmentRow["provenance"],
      tier: row.tier as CommitmentRow["tier"],
      group_fp: row.group,
    })),
    beliefs: rows.map((row) => row.belief),
    ceiling: false,
    partial: false,
    owner,
  };
  return { read, scope };
}

// Open by default, as get_commitments; ordered by due date, undated last, then fact; paged, as
// every owner list read is. `whole`: every one in one answer and one snapshot, for the owner's terminal
// (`pi commitments list`).
export async function ownerCommitments(
  admin: AdminContext,
  args: OwnerCommitmentsArgs = {},
  // `within`: only those whose label lies in these compartments, for a count that leaves some out.
  options: { whole?: boolean; within?: readonly string[] } = {},
): Promise<OwnerCommitments> {
  const page = options.whole === true ? { limit: Number.MAX_SAFE_INTEGER, after: null } : ownerPage(args, fits);
  const now = admin.now();
  const state = args.state ?? "open";
  return admin.transaction(async (query) => {
    const [owner] = await query<{ id: string }>(OWNER_ENTITY_ORDERED);
    const audience = await ownerAudience(query);
    // No built audience is not an empty list: the page says rebuilding.
    if (audience.length === 0) throw new AdminError("rebuilding");
    if (owner === undefined) return { commitments: [], next: null };
    const ctx = ownerCtx(query, admin.keys, admin.log);
    const zone = await ownerTimeZone(ctx);
    // `party`: the person's whole group, as their panel counts them.
    const party = args.party === undefined ? undefined : await groupMembers(query, args.party);
    const { read, scope } = await ownerRead(admin, query, audience, owner.id, options.within);
    const { matched } = await openCommitments(
      ctx,
      {
        state,
        lapseAt: now,
        ...(args.direction === undefined ? {} : { direction: args.direction }),
        ...(party === undefined ? {} : { with: party }),
      },
      read,
      scope,
    );
    const placeOf = (one: OpenCommitment<CommitmentRow>): OwnerPlace => [dueAt(one.due, zone), one.row.fact_key_fp];
    const { rows: shown, next } = pageOf(matched, placeOf, page);
    const { commitments: items, made } = await commitmentItems(ctx, shown, read, now, scope);

    const today = dayIn(now, zone);
    const commitments = items.map((item, index): OwnerCommitment => {
      const ageDays = Math.max(0, daysFrom(dayIn(made[index] ?? new Date(item.belief.confirmedAt), zone), today));
      // Late and stale only while open, whole days in the owner's zone.
      const late = state === "open" && item.due !== null ? daysFrom(dueDay(item.due, zone), today) : 0;
      const stale = state === "open" && (item.due === null ? ageDays >= COURTESY_DAYS : late >= STALE_LATE_DAYS);
      return {
        item,
        lateDays: late > 0 ? late : null,
        ageDays,
        stale,
        ...(item.direction === "owed_by_owner" ? owedWords(item.what) : {}),
      };
    });
    return { commitments, next };
  });
}

// Whether a commitment nobody closed has gone from what is open, so the owner's reopen has something
// to outrank: by the rule the reads apply (lapsedCommitments, counting an earlier reopen), or dormant
// with age. One that stands refuses, so no reopen row binds an agent's close for nothing.
export async function lapsedNow(admin: AdminContext, query: Query, fact: string): Promise<boolean> {
  const ctx = ownerCtx(query, admin.keys, admin.log);
  const [owner] = await query<{ id: string }>(OWNER_ENTITY_ORDERED);
  for (const row of await ownerBeliefs({ query, keys: admin.keys }, [fact])) {
    const { belief } = row;
    if (belief.kind !== "commitment") continue;
    if (belief.status === "dormant") return true;
    if (!OPEN_BELIEF_STATUS.has(belief.status)) continue;
    const one = {
      row: { id: row.id, support: row.support, fact_key_fp: fact },
      belief,
      due: dueOf(belief.values),
      direction: belief.subject === owner?.id ? ("owed_by_owner" as const) : ("owed_to_owner" as const),
    };
    const zone = await ownerTimeZone(ctx);
    if ((await lapsedCommitments(ctx, [one], admin.now(), zone, await ownerAudience(query))).size > 0) return true;
  }
  return false;
}

// The fact's latest commitment claim that is no close, and the latest time of any of them.
async function commitmentOf(query: Query, fact: string): Promise<{ id: FactId; latest: Date } | undefined> {
  // The pipeline's own lookup of the claim a close closes (pipeline-open.ts), so both paths name one claim.
  const [row] = await query<{ id: FactId; valid_from: Date }>(CLOSED_COMMITMENT, [fact]);
  return row === undefined ? undefined : { id: row.id, latest: row.valid_from };
}

// The owner's close, their word. A retire of the fact key (anything stated after it reopens the
// commitment) and their commitment_close decision beside it, in one transaction.
export async function closeCommitment(
  admin: AdminContext,
  fact: string,
  ending: CommitmentEnding,
  options: { at?: Date; requestId: string },
): Promise<{ decision: RulingId; retire: RulingId }> {
  if (!FINGERPRINT.test(fact)) throw new AdminError("not_found");
  return admin.transaction(async (query) => {
    const commitment = await commitmentOf(query, fact);
    if (commitment === undefined) throw new AdminError("not_found");
    const at = options.at ?? admin.now();
    // A later promise would outrank the owner's close unseen.
    if (at.getTime() <= commitment.latest.getTime()) throw new AdminError("at_predates");
    const retire = await ruleIn(admin, query, commitment.id, "retire", `${options.requestId}-retire`);
    const [ruling] = await query<{ compartments: string[] }>(
      "select compartments from knowledge.belief_rulings where ruling_id = $1",
      [retire],
    );
    const decision = await ownerDecision(
      query,
      {
        requestId: options.requestId,
        kind: "commitment_close",
        answer: ending,
        details: { factKey: fact, retire, at: stamp(at) },
        compartments: ruling?.compartments ?? [],
        subjectFps: [fact],
      },
      admin.now(),
    );
    return { decision, retire };
  });
}

// Every close of the commitment in force ends, the owner's own (its retire lifted) and every
// agent's; a row for the fact binds agents until they cite something newer.
export async function reopenCommitment(
  admin: AdminContext,
  fact: string,
  options: { requestId: string },
): Promise<{ decision: RulingId; closes: number }> {
  if (!FINGERPRINT.test(fact)) throw new AdminError("not_found");
  return admin.transaction(async (query) => {
    const [repeat] = await query<{ id: RulingId }>(
      "select id from knowledge.owner_decisions where request_id = $1 and kind = 'commitment_reopen'",
      [options.requestId],
    );
    if (repeat !== undefined) return { decision: repeat.id, closes: 0 };
    const owned = await query<{ retire: RulingId }>(
      `select d.details ->> 'retire' as retire from knowledge.owner_decisions d
       join knowledge.belief_rulings b on b.ruling_id = d.details ->> 'retire'
       where d.kind = 'commitment_close' and d.details ->> 'factKey' = $1 and b.lifted_at is null and d.tainted_at is null`,
      [fact],
    );
    let lifted = 0;
    for (const one of owned)
      if (await liftIn(admin, query, one.retire, { requestId: `${options.requestId}-${one.retire}` })) lifted += 1;
    // The agent's lock on the commitment, as close_commitment takes it, after the beliefs lock.
    await lockRows(query, [`commitment ${fact}`]);
    const closes = await query<{ id: string; compartments: string[] }>(
      `select w.id, w.compartments from ledger.agent_writes w
       where w.kind = 'close' and w.close_fact_fp = $1 and w.body_enc is not null
         and not exists (select 1 from ledger.commitment_reopens r where r.close_id = w.id)
       order by w.id`,
      [fact],
    );
    const [label] = await query<{ compartments: string[] }>(
      "select ledger.label(array(select x from knowledge.claims c cross join unnest(c.compartments) as x where c.fact_key_fp = $1 and not c.closes)) as compartments",
      [fact],
    );
    if (label === undefined || label.compartments === null || label.compartments.length === 0)
      throw new AdminError("not_found");
    if (closes.length === 0 && lifted === 0 && !(await lapsedNow(admin, query, fact)))
      throw new AdminError("not_closed");
    const decision = await ownerDecision(
      query,
      {
        requestId: options.requestId,
        kind: "commitment_reopen",
        details: { factKey: fact },
        compartments: label.compartments,
        subjectFps: [fact],
      },
      admin.now(),
    );
    await query(
      "insert into ledger.commitment_reopens (id, close_id, fact_fp, by, decision_id, compartments, at) values ($1, null, $2, 'owner', $3, $4, $5)",
      [reopenId(), fact, decision, label.compartments, stamp(admin.now())],
    );
    for (const close of closes) {
      await query(
        "insert into ledger.commitment_reopens (id, close_id, fact_fp, by, decision_id, compartments, at) values ($1, $2, $3, 'owner', $4, $5, $6)",
        [reopenId(), close.id, fact, decision, close.compartments, stamp(admin.now())],
      );
    }
    await query(WAKE);
    return { decision, closes: closes.length + lifted };
  });
}

type CloseState = "in_force" | "reopened" | "orphaned" | "removed";
export type ClosedRow = {
  close: string;
  fact: string;
  by: string;
  ending: string;
  at: string;
  evidence: string[];
  // The agent's note, its own words, for a terminal alone; null when it wrote none or its body is gone.
  note: string | null;
  state: CloseState;
};

// Every close, newest first: the agents' (`byAgents`) and, without it, the owner's own too.
export async function listCloses(
  admin: AdminContext,
  options: { byAgents?: boolean; since?: Date } = {},
): Promise<ClosedRow[]> {
  return admin.transaction(async (query) => {
    const since = options.since ?? new Date(0);
    const agents = await query<{
      id: string;
      client_name: string;
      close_fact_fp: string;
      close_ending: string;
      created_at: Date;
      cites: string[];
      compartments: string[];
      body_enc: Sealed;
      evidence_id: string | null;
      reopened: boolean;
      built: boolean;
      processed: boolean;
    }>(
      `select w.id, w.client_name, w.close_fact_fp, w.close_ending, w.created_at, w.cites, w.compartments, w.body_enc, w.evidence_id,
         exists (select 1 from ledger.commitment_reopens r where r.close_id = w.id) as reopened,
         exists (select 1 from knowledge.claims c where c.evidence_id = w.evidence_id and c.closes) as built,
         exists (select 1 from vault.pipeline_items p where p.evidence_id = w.evidence_id and not p.waiting) as processed
       from ledger.agent_writes w where w.kind = 'close' and w.created_at >= $1 order by w.created_at desc, w.id desc`,
      [since],
    );
    const rows: ClosedRow[] = agents.map((one) => {
      let note: string | null = null;
      if (one.body_enc !== null) {
        try {
          note = parseCloseBody(open(admin.keys, one, "ledger.agent_writes.body_enc", "throw"))?.note ?? null;
        } catch {
          note = null;
        }
      }
      const state: CloseState =
        one.body_enc === null
          ? "removed"
          : one.reopened
            ? "reopened"
            : one.processed && !one.built
              ? "orphaned"
              : "in_force";
      return {
        close: one.id,
        fact: one.close_fact_fp,
        by: `agent:${one.client_name}`,
        ending: one.close_ending,
        at: stamp(one.created_at),
        evidence: one.cites,
        note,
        state,
      };
    });
    if (options.byAgents !== true) {
      const owners = await query<{
        id: string;
        answer: string;
        details: { factKey: string; retire: string; at: string };
        decided_at: Date;
        lifted: boolean;
        removed: boolean;
      }>(
        `select d.id, d.answer, d.details, d.decided_at, d.tainted_at is not null as removed, coalesce((select b.lifted_at is not null from knowledge.belief_rulings b where b.ruling_id = d.details ->> 'retire'), true) as lifted
         from knowledge.owner_decisions d where d.kind = 'commitment_close' and d.decided_at >= $1 order by d.decided_at desc, d.id desc`,
        [since],
      );
      // An erasure that reached the owner's close (its commitment's claims gone) leaves it removed.
      for (const one of owners)
        rows.push({
          close: one.id,
          fact: one.details.factKey,
          by: "owner",
          ending: one.answer,
          at: one.details.at,
          evidence: [],
          note: null,
          state: one.removed ? "removed" : one.lifted ? "reopened" : "in_force",
        });
    }
    return rows.sort((a, b) => b.at.localeCompare(a.at));
  });
}

// `pia work report`'s `closes` block, counts within the window.
export type ClosesReport = {
  byAgent: { agent: string; ending: string; n: number }[];
  reopened: { byOwner: number; byAgents: number };
  orphaned: number;
  owner: number;
};
export async function closesReport(query: Query, since: Date): Promise<ClosesReport> {
  const byAgent = await query<{ agent: string; ending: string; n: number }>(
    `select client_name as agent, close_ending as ending, count(*)::int as n from ledger.agent_writes
     where kind = 'close' and created_at >= $1 group by 1, 2 order by 1, 2`,
    [stamp(since)],
  );
  const [reopened] = await query<{ owner: number; agents: number }>(
    `select count(*) filter (where by = 'owner')::int as owner, count(*) filter (where by <> 'owner')::int as agents
     from ledger.commitment_reopens where close_id is not null and at >= $1`,
    [stamp(since)],
  );
  const [orphaned] = await query<{ n: number }>(
    `select count(*)::int as n from ledger.agent_writes w
     where w.kind = 'close' and w.created_at >= $1 and w.body_enc is not null and w.evidence_id is not null
       and not exists (select 1 from knowledge.claims c where c.evidence_id = w.evidence_id and c.closes)
       and exists (select 1 from vault.pipeline_items p where p.evidence_id = w.evidence_id and not p.waiting)`,
    [stamp(since)],
  );
  const [owner] = await query<{ n: number }>(
    "select count(*)::int as n from knowledge.owner_decisions where kind = 'commitment_close' and decided_at >= $1",
    [stamp(since)],
  );
  return {
    byAgent,
    reopened: { byOwner: reopened?.owner ?? 0, byAgents: reopened?.agents ?? 0 },
    orphaned: orphaned?.n ?? 0,
    owner: owner?.n ?? 0,
  };
}

// The owner's standing release, on or off, their decision each time.
export async function setAgentCloses(
  admin: AdminContext,
  on: boolean,
  options: { requestId: string },
): Promise<RulingId> {
  return admin.transaction(async (query) => {
    await lockRows(query, []);
    return ownerDecision(
      query,
      {
        requestId: options.requestId,
        kind: "close_release",
        answer: on ? "on" : "off",
        compartments: ownLabel(),
      },
      admin.now(),
    );
  });
}

export const commitmentsList = (
  admin: AdminContext,
  args: OwnerCommitmentsArgs = {},
  options: { whole?: boolean } = {},
): Promise<OwnerCommitments> => ownerCommitments(admin, args, options);
