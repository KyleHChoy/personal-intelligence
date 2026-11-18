import {
  AboutYouKind,
  CARD_OPTIONS,
  type CardId,
  type ClientId,
  type ClientName,
  type ConfirmRatesView,
  type FactId,
  type GrantCounts,
  grantDue,
  LearningSwitchBody,
  liftDue,
  ownLabel,
  type RulingId,
  rateState,
  SUGGESTION_QUIET_DAYS,
} from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, stamp } from "../../core/db.ts";
import { newId, requestIdOf } from "../../core/ids.ts";
import { authorWord } from "../../core/locks.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { lockRows, raiseCard } from "../../core/queue.ts";
import { LATEST_CARD_EVENT, notCanaryClient } from "../../core/statements.ts";
import { CARD_WITHDRAWN, recordEvent } from "../record-event.ts";

// Learning from the owner's answers on what each agent proposes about them. The rates are the
// database's (policy.confirm_rates), computed at read; this module reads them for Settings, keeps
// the owner's switch for each agent, and raises the two cards a rate proposes and withdraws them
// once their reason is gone. A card never grants or lifts a standing release: its lines give the
// terminal command, which the owner runs (fact releases stay out of the browser). As pi_admin. Ids
// and counts only.

const AUTHOR = "system:learning";
const GRANT_SUGGESTION = "grant_suggestion";
const LIFT_SUGGESTION = "grant_lift_suggestion";

export type RateRow = GrantCounts & { client_id: string; compartments: string[] | null };
export const RATES = `select client_id, kind, granted, answers, confirmed, kept, not_true as "notTrue", compartments
  from policy.confirm_rates($1)`;
const SINCE =
  "select min(decided_at) as at from knowledge.owner_decisions where kind = 'facts_clean' and tainted_at is null";
// Every agent with the owner's latest switch for it; on until they turn it off.
const AGENTS = `
  select k.id, k.name, k.status,
    coalesce((select (o.details ->> 'on')::boolean from knowledge.owner_decisions o
              where o.kind = 'learning_switch' and o.tainted_at is null and o.details ->> 'client' = k.id
              order by o.decided_at desc, o.id desc limit 1), true) as on
  from policy.clients k where k.kind = 'agent' and ${notCanaryClient("k.name")} order by k.name`;
// When the owner last answered a card of this case, in the quiet window.
const ANSWERED = `
  select 1 from knowledge.owner_decisions d join ledger.cards c on c.id = d.card_id
  where c.case_key = $1 and c.created_by = '${AUTHOR}' and d.kind = 'answer' and d.tainted_at is null
    and d.decided_at > $2::timestamptz - make_interval(days => $3)
  limit 1`;
// This author's cards still waiting.
const OPEN = `
  select c.id, c.case_key, c.compartments from ledger.cards c
  where c.created_by = '${AUTHOR}' and c.tainted_at is null
    and (${LATEST_CARD_EVENT}) in ('pending', 'deferred')
  order by c.created_at, c.id`;

type Agent = { id: string; name: ClientName; status: string; on: boolean };

async function readAll(query: Query, now: Date): Promise<{ rates: RateRow[]; agents: Map<string, Agent> }> {
  const rates = await query<RateRow>(RATES, [stamp(now)]);
  const agents = new Map((await query<Agent>(AGENTS)).map((row) => [row.id, row]));
  return { rates, agents };
}

// Settings: each active agent, and each revoked one with answers counted, with its switch and its
// rates by kind.
export function confirmRates(admin: AdminContext): Promise<ConfirmRatesView> {
  return admin.transaction(async (query) => {
    const [since] = await query<{ at: Date | null }>(SINCE);
    const { rates, agents } = await readAll(query, admin.now());
    const shown = [...agents.values()].filter(
      (agent) => agent.status === "active" || rates.some((row) => row.client_id === agent.id),
    );
    return {
      since: since?.at == null ? null : stamp(since.at),
      agents: shown.map((agent) => ({
        client: agent.name,
        on: agent.on,
        rates: rates
          .filter((row) => row.client_id === agent.id)
          .map((row) => ({
            kind: row.kind,
            answers: row.answers,
            confirmed: row.confirmed,
            kept: row.kept,
            notTrue: row.notTrue,
            state: rateState(row, row.granted, agent.on),
          })),
      })),
    };
  });
}

// The owner's switch for one agent: its ruling, or the latest one when it is already in that state.
// Then the pass, which raises a card it now allows or withdraws one it no longer does.
export async function setLearning(admin: AdminContext, body: LearningSwitchBody): Promise<RulingId> {
  if (!LearningSwitchBody.safeParse(body).success) throw new AdminError("invalid_argument");
  const ruling = await admin.transaction(async (query) => {
    await lockRows(query, []);
    const [client] = await query<{ id: ClientId }>(
      "select id from policy.clients where name = $1 and kind = 'agent' and status = 'active'",
      [body.client],
    );
    if (client === undefined) throw new AdminError("not_found");
    const [latest] = await query<{ id: RulingId; on: boolean }>(
      `select id, (details ->> 'on')::boolean as on from knowledge.owner_decisions
       where kind = 'learning_switch' and tainted_at is null and details ->> 'client' = $1
       order by decided_at desc, id desc limit 1`,
      [client.id],
    );
    if (latest !== undefined && latest.on === body.on) return latest.id;
    return ownerDecision(
      query,
      {
        requestId: body.requestId,
        kind: "learning_switch",
        details: { client: client.id, on: body.on },
        compartments: ownLabel(),
      },
      admin.now(),
    );
  });
  await proposeAfterAnswer(admin);
  return ruling;
}

const caseOf = (which: "grant" | "lift", row: RateRow): string => `${which}:${row.client_id}:${row.kind}`;

// One pass, in one transaction under the author's lock. For each agent the owner has not switched
// off and each about-you kind: one card proposing a standing release when grantDue, or its lift when
// liftDue. None while one of that case is open (raiseCard's case key) or the owner answered one in
// the last SUGGESTION_QUIET_DAYS days. First, each open card whose reason is gone (the rate crossed
// back, the answers it counted were erased, the grant changed, the agent was switched off or
// revoked) is withdrawn. A card's label is that of what its counts read (invariant 4). Counts of the
// cards raised and withdrawn.
async function propose(admin: AdminContext): Promise<{ raised: number; withdrawn: number }> {
  const now = admin.now();
  return admin.transaction(async (query) => {
    await lockRows(query, [authorWord(AUTHOR)]);
    const { rates, agents } = await readAll(query, now);
    const due = new Map<string, RateRow>();
    for (const row of rates) {
      const agent = agents.get(row.client_id);
      if (agent === undefined || agent.status !== "active" || !agent.on) continue;
      if (!AboutYouKind.safeParse(row.kind).success) continue;
      if (grantDue(row)) due.set(caseOf("grant", row), row);
      if (liftDue(row)) due.set(caseOf("lift", row), row);
    }
    let withdrawn = 0;
    for (const open of await query<{ id: CardId; case_key: string | null; compartments: string[] }>(OPEN)) {
      if (open.case_key !== null && due.has(open.case_key)) continue;
      await recordEvent(query, CARD_WITHDRAWN, open.id, stamp(now), open.compartments, { by: AUTHOR });
      withdrawn += 1;
    }
    let raised = 0;
    for (const [caseKey, row] of due) {
      if ((await query(ANSWERED, [caseKey, stamp(now), SUGGESTION_QUIET_DAYS])).length > 0) continue;
      const card = {
        id: newId("crd") as CardId,
        requestId: requestIdOf(`${caseKey}\n${now.toISOString()}`),
        kind: caseKey.startsWith("lift:") ? LIFT_SUGGESTION : GRANT_SUGGESTION,
        author: AUTHOR,
        options: [...CARD_OPTIONS.grant_suggestion],
        target: null,
        refs: [],
        compartments: [...new Set(row.compartments ?? ["own"])].sort(),
        expiresAt: null,
        expiresAfterDays: null,
        caseKey,
        run: null,
        body: null,
        bodyFrom: null,
      };
      if (!(await raiseCard(query, card, { now, log: admin.log })).replayed) raised += 1;
    }
    return { raised, withdrawn };
  });
}

// The pass after one of the owner's answers or Not trues: a failure is logged and never fails it.
export async function proposeAfterAnswer(admin: AdminContext): Promise<void> {
  try {
    const counts = await propose(admin);
    if (counts.raised + counts.withdrawn > 0) admin.log.info({ event: "rate_suggestions", counts });
  } catch (error) {
    admin.log.error({ event: "rate_suggestion_failed", code: error instanceof AdminError ? error.code : "failed" });
  }
}

// Whether answering these cards can move a rate: one is an about-you card not answered yet, so a
// replay, or a batch of other kinds, runs no pass.
export const answersTeach = (admin: AdminContext, cards: readonly CardId[]): Promise<boolean> =>
  admin.transaction(
    async (query) =>
      (
        await query(
          `select 1 from ledger.cards c where c.id = any ($1::text[]) and c.kind = 'about_you'
             and not exists (select 1 from knowledge.owner_decisions o where o.kind = 'answer' and o.card_id = c.id)
           limit 1`,
          [cards],
        )
      ).length > 0,
  );

// Whether a Not true on these facts can move a rate: one is a fact of a record a standing release
// kept, and the request is not a replay.
export const notTrueTeaches = (admin: AdminContext, facts: readonly FactId[], requestId?: string): Promise<boolean> =>
  admin.transaction(
    async (query) =>
      (
        await query(
          `select 1 from knowledge.claims k join knowledge.claim_releases r on r.evidence_id = k.evidence_id and r.via = 'grant'
           where k.id = any ($1::text[])
             and ($2::text is null or not exists (select 1 from knowledge.owner_decisions o where o.request_id = $2))
           limit 1`,
          [facts, requestId ?? null],
        )
      ).length > 0,
  );

// The pass once after a batch of Not trues, when one of them was on a fact a grant kept.
export async function learnAfterNotTrue(admin: AdminContext, ids: readonly FactId[]): Promise<void> {
  if (await notTrueTeaches(admin, ids)) await proposeAfterAnswer(admin);
}
