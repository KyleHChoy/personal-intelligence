import {
  CARD_OPTIONS,
  type CardId,
  type IdentityBasis,
  type IdentityException,
  isCanaryCompartment,
  type PersonalRef,
  sortedLabel,
} from "@intelligence/contracts/personal";
import { sha256 } from "@intelligence/personal-core";
import { afterAnswers, intoBatches, questionRules, spanningPairs } from "@intelligence/personal-core/planner";
import { type Query, stamp } from "../core/db.ts";
import { allRulings, ownerFps } from "../core/identity-rulings.ts";
import { batchId, newId, questionId, requestIdOf } from "../core/ids.ts";
import { raiseCard } from "../core/queue.ts";
import { IDENTITY_AUTHOR, LATEST_CARD_EVENT, latestEvent } from "../core/statements.ts";
import { groupOf, groupsOf } from "./groups.ts";

// Same-person pairs code could not settle, past the sweep:
// each a question an agent answers in a batched task; a confirmed rule of the owner's, or an agent's
// answer that passed code's check, makes a ruling marked as theirs; what two agents could not settle
// reaches the owner on one card, which says what was tried; and a pair the owner left apart comes back only
// when something about its people changed. No model is called here.

type Side = { entity: string; fp: string; compartments: string[] };
// `labels`: the rows that made it a candidate, such as the alias two people share. A viewer of the pair's
// accounts alone may not be able to read that name, so the question carries their label too.
export type Routed = {
  caseKey: string;
  a: Side;
  b: Side;
  basis: IdentityBasis;
  exception: IdentityException | null;
  labels: readonly string[];
};
export type QuestionCounts = {
  asked: number;
  ruled: number;
  refused: number;
  toOwner: number;
  rested: number;
  notAPerson: number;
  // Pairs resting now because no agent could prove them: how many, not how many newly.
  nothingToRead: number;
  batches: number;
  cards: number;
};

export async function agentsOn(query: Query): Promise<boolean> {
  const [row] = await query<{ on: boolean }>("select ledger.identity_agents_on() as on");
  return row?.on === true;
}

const hex40 = (text: string): string => sha256(text).slice(0, 40);

type Question = {
  id: string;
  case_key: string;
  a_entity: string;
  b_entity: string;
  a_fp: string;
  b_fp: string;
  exception: string | null;
  pattern: string;
  evidence_fp: string;
  state: "agents" | "owner" | "settled" | "resting";
  batch: string | null;
  card_id: string | null;
  settled_by: string | null;
  offers: number;
  passed_code: string | null;
  compartments: string[];
};

// What the identity rows of the pair's two people are now, by fingerprints alone. A pair comes back
// unasked only when this changes: a new name or a new address is new evidence, and more mail is not.
type Prints = { bare: (a: string, b: string) => string };
async function printsOf(query: Query): Promise<Prints> {
  const rows = await query<{ entity_id: string; value_fp: string }>(
    "select entity_id, value_fp from knowledge.aliases union select entity_id, value_fp from knowledge.accounts",
  );
  const held = new Map<string, string[]>();
  for (const row of rows) held.set(row.entity_id, [...(held.get(row.entity_id) ?? []), row.value_fp]);
  return {
    bare: (a, b) => hex40([...new Set([...(held.get(a) ?? []), ...(held.get(b) ?? [])])].sort().join(" ")),
  };
}

// A pair with nothing beyond a name, on any record of either person, rests. A question's print takes what an
// agent is shown into account: an answer given when a brief held less says nothing of what can be read now, so
// this print, and the one a pair wakes under, ask afresh. A print is read from the print a question holds and the
// people's rows alone, so nothing else written to a question moves it.
const NOTHING_TO_READ = "nothing_to_read";
const wokePrint = (prints: Prints, a: string, b: string): string => hex40(`${prints.bare(a, b)} woke`);
const printFor = (prints: Prints, a: string, b: string, stored: string | undefined): string => {
  const woke = wokePrint(prints, a, b);
  return stored === woke ? woke : hex40(`${prints.bare(a, b)} records`);
};

// Whether either person of a pair has anything to read under its label: a message or a contact card a brief
// would serve, which is an `own` one, on any record of the whole person. A label that hides it counts it as nothing, so what a viewer of the pair can't
// see changes nothing. One read a sweep: the log's indexes lead with a label, so asking pair by pair would
// scan it each time.
export async function recordsRead(query: Query): Promise<(a: string, b: string, label: readonly string[]) => boolean> {
  const members = await wholePeople(query);
  const labels = new Map<string, string[][]>();
  for (const row of await query<{ entity_id: string; compartments: string[] }>(
    `select distinct i.entity_id, m.compartments from knowledge.interaction_log i
     join knowledge.messages m on m.evidence_id = i.evidence_id where not m.held
     union select distinct a.entity_id, c.compartments from knowledge.contact_addresses a join knowledge.contacts c on c.id = a.contact_id
     where c.compartments = array['own']::text[]`,
  ))
    labels.set(row.entity_id, [...(labels.get(row.entity_id) ?? []), row.compartments]);
  const has = (entity: string, label: readonly string[]): boolean =>
    [...members(entity)].some((one) =>
      (labels.get(one) ?? []).some((held) => held.every((part) => label.includes(part))),
    );
  return (a, b, label) => has(a, label) || has(b, label);
}

// A record's whole person, by the rulings in force.
export async function wholePeople(query: Query): Promise<(entity: string) => Set<string>> {
  const groups = groupsOf(await allRulings(query), await ownerFps(query));
  const accounts = await query<{ entity_id: string; value_fp: string }>(
    "select entity_id, value_fp from knowledge.accounts",
  );
  const fpsOf = new Map<string, string[]>();
  const peopleOf = new Map<string, string[]>();
  for (const row of accounts) {
    fpsOf.set(row.entity_id, [...(fpsOf.get(row.entity_id) ?? []), row.value_fp]);
    peopleOf.set(row.value_fp, [...(peopleOf.get(row.value_fp) ?? []), row.entity_id]);
  }
  return (entity) =>
    new Set([
      entity,
      ...(fpsOf.get(entity) ?? []).flatMap((fp) => [...groupOf(groups, fp)].flatMap((one) => peopleOf.get(one) ?? [])),
    ]);
}

// Questions answered under an older print: what those agents were shown was less, so their answers stay on
// record and stop counting. A pair they sent to the owner comes back, while no card holds it.
const OPEN_PRINT_CARD = `(${latestEvent("card", "$1")})`;
async function reprint(query: Query, held: Map<string, Question>, prints: Prints, at: string): Promise<number> {
  let moved = 0;
  for (const row of held.values()) {
    const bare = prints.bare(row.a_entity, row.b_entity);
    if (row.evidence_fp !== bare) continue;
    const fp = hex40(`${bare} records`);
    let state = row.state;
    let card = row.card_id;
    if (row.state === "owner") {
      const [open] =
        card === null ? [] : await query<{ event: string | null }>(`select ${OPEN_PRINT_CARD} as event`, [card]);
      const carded = open?.event === "pending" || open?.event === "deferred";
      if (!carded) {
        const [said] = await query<{ yes: boolean }>(
          "select exists (select 1 from ledger.identity_answers a where a.question_id = $1 and a.verdict = 'cant_tell' and a.evidence_fp = $2) as yes",
          [row.id, row.evidence_fp],
        );
        if (said?.yes === true) {
          state = "agents";
          card = null;
          moved += 1;
        }
      }
    }
    await query(
      "update ledger.identity_questions set evidence_fp = $2, state = $3, card_id = $4, offers = case when $3 = 'agents' then 0 else offers end, updated_at = $5 where id = $1",
      [row.id, fp, state, card, at],
    );
    row.evidence_fp = fp;
    row.state = state;
    row.card_id = card;
  }
  return moved;
}

const OPEN_FOR_RECORDS = `
  select q.id, q.case_key, q.state, q.a_entity, q.b_entity, q.compartments from ledger.identity_questions q
  where q.state = 'agents'
    or (q.state = 'resting' and q.passed_code = $1)
    or (q.state = 'owner' and (q.card_id is null or (${latestEvent("card", "q.card_id")}) not in ('pending', 'deferred')))`;

const OPEN_CARD = `(${LATEST_CARD_EVENT})`;

// Records each routed pair as a question, moves its state on, turns answers and rules into rulings,
// batches what waits on agents, and raises the owner's one card. Each write is a transaction of its
// own; the ruling's holds its one lock call.
export async function settleQuestions(
  admin: { transaction<T>(work: (query: Query) => Promise<T>): Promise<T> },
  all: readonly Routed[],
  now: Date,
): Promise<QuestionCounts> {
  // A pair under the standing check's compartments is no one's to ask.
  const routed = all.filter((one) => !one.labels.some(isCanaryCompartment));
  const counts: QuestionCounts = {
    asked: 0,
    ruled: 0,
    refused: 0,
    toOwner: 0,
    rested: 0,
    notAPerson: 0,
    nothingToRead: 0,
    batches: 0,
    cards: 0,
  };
  const at = stamp(now);

  const present = new Set(routed.map((one) => one.caseKey));

  const rulesInForce = await admin.transaction((query) =>
    query<{ id: string; pattern: string; answer: string; compartments: string[] }>(
      "select id, pattern, answer, compartments from ledger.question_rules where kind = 'same_person' and status = 'confirmed'",
    ),
  );

  await admin.transaction(async (query) => {
    const held = new Map(
      (await query<Question>("select * from ledger.identity_questions")).map((row) => [row.case_key, row]),
    );
    const prints = await printsOf(query);
    counts.asked += await reprint(query, held, prints, at);
    // A pair left to rest was never a same, so it joins nothing: it neither is asked nor stands in for
    // another. Then one question per join a cluster needs, narrow labels first: A and C is settled by
    // A and B, and B and C, only for those who could see them.
    const live: Routed[] = [];
    for (const pair of routed) {
      const was = held.get(pair.caseKey);
      if (
        was?.state === "resting" &&
        was.evidence_fp === printFor(prints, pair.a.entity, pair.b.entity, was.evidence_fp)
      )
        continue;
      live.push(pair);
    }
    const labelOf = (one: Routed): string[] =>
      [...new Set([...one.a.compartments, ...one.b.compartments, ...one.labels])].sort();
    const { kept } = spanningPairs(
      [...live].sort((x, y) => labelOf(x).length - labelOf(y).length),
      (one) => [one.a.fp, one.b.fp] as const,
      labelOf,
    );
    for (const pair of kept) {
      const was = held.get(pair.caseKey);
      const evidence = printFor(prints, pair.a.entity, pair.b.entity, was?.evidence_fp);
      // Someone split one of these two from a third: that says nothing new of this pair, so it rests, and
      // only a change in its people brings it to the owner.
      const split = pair.exception === "lifted_before";
      const fresh = split ? "owner" : "agents";
      if (was === undefined) {
        const [shape] = await query<{ shape: string }>("select ledger.pair_shape($1, $2) as shape", [
          pair.a.entity,
          pair.b.entity,
        ]);
        const compartments = labelOf(pair);
        await query(
          `insert into ledger.identity_questions (id, case_key, a_entity, b_entity, a_fp, b_fp, basis, exception, pattern, evidence_fp, state, created_at, updated_at, compartments)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, ledger.label($13))`,
          [
            questionId(),
            pair.caseKey,
            pair.a.entity,
            pair.b.entity,
            pair.a.fp,
            pair.b.fp,
            pair.basis,
            pair.exception,
            shape?.shape ?? "same_person:other:0",
            evidence,
            split ? "resting" : "agents",
            at,
            compartments,
          ],
        );
        counts.asked += 1;
        continue;
      }
      // The name that made them a candidate may have reached a wider label since: no agent cleared for less
      // may go on being told of it.
      if (labelOf(pair).join(",") !== [...was.compartments].sort().join(","))
        await query(
          "update ledger.identity_questions set compartments = ledger.label($2), batch = null where id = $1",
          [was.id, labelOf(pair)],
        );
      if (was.evidence_fp === evidence) {
        if (split && was.state === "agents") {
          await query(
            "update ledger.identity_questions set state = 'resting', batch = null, updated_at = $2 where id = $1",
            [was.id, at],
          );
          counts.rested += 1;
          continue;
        }
        // A ruling since lifted: nothing has changed, so nobody is asked. A pair that only stopped
        // being a candidate for a while was never answered, and goes back to being asked.
        if (was.state === "settled" && was.settled_by === "ruling") {
          await query("update ledger.identity_questions set state = 'resting', updated_at = $2 where id = $1", [
            was.id,
            at,
          ]);
          counts.rested += 1;
        } else if (was.state === "settled" && !split) {
          await query("update ledger.identity_questions set state = $2, offers = 0, updated_at = $3 where id = $1", [
            was.id,
            fresh,
            at,
          ]);
          counts.asked += 1;
        }
        continue;
      }
      const [shape] = await query<{ shape: string }>("select ledger.pair_shape($1, $2) as shape", [
        pair.a.entity,
        pair.b.entity,
      ]);
      await query(
        "update ledger.identity_questions set state = $2, evidence_fp = $3, exception = $4, pattern = $5, offers = 0, settled_by = null, batch = null, card_id = null, passed_code = null, updated_at = $6 where id = $1",
        [was.id, fresh, evidence, pair.exception, shape?.shape ?? was.pattern, at],
      );
      counts.asked += 1;
    }
    // A pair that stopped being a candidate is settled, by whoever settled it.
    for (const row of held.values()) {
      if ((row.state === "agents" || row.state === "owner") && !present.has(row.case_key))
        await query(
          "update ledger.identity_questions set state = 'settled', batch = null, updated_at = $2 where id = $1",
          [row.id, at],
        );
    }
  });

  // A rule the owner confirmed answers its shape; an agent's answer, once code's check passed at its report.
  const open = await admin.transaction((query) =>
    query<Question>("select * from ledger.identity_questions where state in ('agents', 'owner') order by id"),
  );
  for (const question of open) {
    // A rule holds only within the label the owner's answers were given under.
    const rule = rulesInForce.find(
      (one) =>
        one.pattern === question.pattern && question.compartments.every((part) => one.compartments.includes(part)),
    );
    if (rule === undefined) continue;
    const code = await ruling(
      admin,
      question.id,
      null,
      rule.id,
      `rule:${rule.id}:${question.id}:${question.evidence_fp}`,
    );
    if (code === "ruled") counts.ruled += 1;
  }

  type Answer = {
    id: string;
    question_id: string;
    client_name: string;
    verdict: "same" | "different" | "cant_tell";
    evidence_fp: string;
    refused_code: string | null;
  };
  // A pair with nothing beyond a name rests, reaching neither agents nor the owner, and wakes when a record or
  // message arrives, while it is still a candidate. A card already in the owner's queue stays as it is.
  await admin.transaction(async (query) => {
    const prints = await printsOf(query);
    const open = await query<{
      id: string;
      case_key: string;
      state: string;
      a_entity: string;
      b_entity: string;
      compartments: string[];
    }>(OPEN_FOR_RECORDS, [NOTHING_TO_READ]);
    const holds = await recordsRead(query);
    for (const question of open) {
      const something = holds(question.a_entity, question.b_entity, question.compartments);
      if (!something && question.state !== "resting")
        await query(
          "update ledger.identity_questions set state = 'resting', passed_code = $2, batch = null, card_id = null, updated_at = $3 where id = $1",
          [question.id, NOTHING_TO_READ, at],
        );
      if (something && question.state === "resting" && present.has(question.case_key)) {
        await query(
          "update ledger.identity_questions set state = 'agents', passed_code = null, evidence_fp = $2, offers = 0, batch = null, updated_at = $3 where id = $1",
          [question.id, wokePrint(prints, question.a_entity, question.b_entity), at],
        );
        counts.asked += 1;
      }
    }
    const [resting] = await query<{ n: number }>(
      "select count(*)::int as n from ledger.identity_questions where state = 'resting' and passed_code = $1",
      [NOTHING_TO_READ],
    );
    counts.nothingToRead = resting?.n ?? 0;
  });

  // What the answers on each question leave it: a ruling, a second agent, or the owner.
  const decided = await admin.transaction(async (query) => {
    await query(
      "update ledger.identity_answers set applied_at = $1 where applied_at is null and verdict = 'cant_tell'",
      [at],
    );
    const clients = await query<{ name: string; compartments: string[] }>(
      "select name, compartments from ledger.same_person_clients()",
    );
    const waiting = await query<Question>("select * from ledger.identity_questions where state = 'agents' order by id");
    const said = await query<Answer>(
      "select * from ledger.identity_answers where refused_code is null order by created_at, id",
    );
    return waiting.map((question) => {
      const answers = said.filter((one) => one.question_id === question.id && one.evidence_fp === question.evidence_fp);
      // Only an agent cleared for the pair's whole label could give an answer.
      const cleared = clients
        .filter((one) => question.compartments.every((part) => one.compartments.includes(part)))
        .map((one) => one.name);
      // No agent on the route at all is a setting, perhaps for a moment: nothing goes to the owner for it.
      // A route whose agents can't read this pair is lasting, and afterAnswers sends it on.
      const next =
        clients.length === 0 && answers.length === 0
          ? ("wait" as const)
          : afterAnswers(
              answers.map((one) => ({ client: one.client_name, verdict: one.verdict })),
              cleared,
            );
      return { question, next, answer: answers.findLast((one) => one.verdict === next) };
    });
  });
  for (const { question, next, answer } of decided) {
    if (next === "owner") {
      await admin.transaction((query) =>
        query("update ledger.identity_questions set state = 'owner', batch = null, updated_at = $2 where id = $1", [
          question.id,
          at,
        ]),
      );
      counts.toOwner += 1;
    }
    if ((next !== "same" && next !== "different") || answer === undefined) continue;
    const code = await ruling(admin, question.id, answer.id, null, `answer:${answer.id}`, at);
    if (code === "ruled") {
      counts.ruled += 1;
      continue;
    }
    counts.refused += 1;
    if (code === "not_a_person") counts.notAPerson += 1;
    // What a person ruled outranks it, or it is no person: it rests until something changes.
    if (code !== "agents_off")
      await admin.transaction((query) =>
        query(
          "update ledger.identity_questions set state = case when $2 = 'already_settled' then 'settled' else 'resting' end, batch = null, updated_at = $3 where id = $1",
          [question.id, code, at],
        ),
      );
  }

  await admin.transaction(async (query) => {
    await query("select ledger.same_person_rebatch()");
    const { batchPairs, maxOffers } = questionRules();
    // Offered and offered, and nobody settled it: it reaches the owner, saying so.
    const unanswered = await query(
      "update ledger.identity_questions set state = 'owner', batch = null, updated_at = $1 where state = 'agents' and offers >= $2 returning id",
      [at, maxOffers],
    );
    counts.toOwner += unanswered.length;
    const free = await query<Question>(
      "select * from ledger.identity_questions where state = 'agents' and batch is null and not ledger.same_person_blocked(a_entity, b_entity) order by a_entity, b_entity",
    );
    const byLabel = new Map<string, Question[]>();
    for (const row of free) {
      const key = row.compartments.join(",");
      byLabel.set(key, [...(byLabel.get(key) ?? []), row]);
    }
    for (const rows of byLabel.values()) {
      for (const batch of intoBatches(rows, (one) => [one.a_entity, one.b_entity] as const, batchPairs)) {
        await query("update ledger.identity_questions set batch = $1 where id = any($2::text[])", [
          batchId(),
          batch.map((one) => one.id),
        ]);
        counts.batches += 1;
      }
    }
  });

  if (await raiseOwnerCard(admin, now)) counts.cards += 1;
  return counts;
}

// One ruling, in its own transaction, whose one lock call is the function's. The answer's outcome is
// written beside it.
async function ruling(
  admin: { transaction<T>(work: (query: Query) => Promise<T>): Promise<T> },
  question: string,
  answer: string | null,
  rule: string | null,
  request: string,
  at?: string,
): Promise<string> {
  const requestId = requestIdOf(request);
  return admin.transaction(async (query) => {
    const [row] = await query<{ code: string; ruling: string | null }>(
      "select code, ruling from ledger.policy_ruling($1, $2, $3, $4)",
      [question, answer, rule, requestId],
    );
    const code = row?.code ?? "not_found";
    // Each agreeing answer names the ruling, so a deletion of what either cited lifts it.
    if (answer !== null)
      await query(
        `update ledger.identity_answers o set applied_at = $2, ruling_id = $3, refused_code = $4
         from ledger.identity_answers a where a.id = $1 and o.question_id = a.question_id and o.verdict = a.verdict and o.evidence_fp = a.evidence_fp`,
        [answer, at, row?.ruling ?? null, code === "ruled" ? null : code],
      );
    return code;
  });
}

// The owner's one card: every question that waits on the owner, up to a batch. While one is open nothing
// else is raised: what comes meanwhile waits for it. Its case key is what it asks, so the same
// pairs under the same evidence never hold a second card at once.
async function raiseOwnerCard(
  admin: { transaction<T>(work: (query: Query) => Promise<T>): Promise<T> },
  now: Date,
): Promise<boolean> {
  return admin.transaction(async (query) => {
    await query("select ledger.withdraw_empty_batch()");
    const [open] = await query<{ id: string }>(
      `select c.id from ledger.cards c where c.kind = 'same_person_batch' and c.created_by = $1 and ${OPEN_CARD} in ('pending', 'deferred') limit 1`,
      [IDENTITY_AUTHOR],
    );
    if (open !== undefined) return false;
    const waiting = await query<Question>(
      "select * from ledger.identity_questions where state = 'owner' order by updated_at, id",
    );
    const chosen = waiting.slice(0, questionRules().ownerCardPairs);
    if (chosen.length === 0) return false;
    const compartments = sortedLabel(chosen.flatMap((one) => one.compartments));
    const key = hex40(chosen.map((one) => `${one.case_key}:${one.evidence_fp}`).join(" "));
    const card = {
      id: newId("crd") as CardId,
      requestId: requestIdOf(`batch:${key}:${stamp(now)}`),
      kind: "same_person_batch",
      author: IDENTITY_AUTHOR,
      options: [...CARD_OPTIONS.same_person_batch],
      target: null,
      refs: [...new Set(chosen.flatMap((one) => [one.a_entity, one.b_entity]))].map(
        (id) => ({ kind: "entity", id }) as PersonalRef,
      ),
      compartments,
      expiresAt: null,
      expiresAfterDays: null,
      caseKey: `same_batch:${key}`,
      run: null,
      body: null,
      bodyFrom: null,
    };
    const raised = await raiseCard(query, card, { now });
    if (raised.id !== card.id) return false;
    await query("update ledger.identity_questions set card_id = $1 where id = any($2::text[])", [
      card.id,
      chosen.map((one) => one.id),
    ]);
    return true;
  });
}

// How many pairs on each of these cards its answer could not land on.
export const passedOverOn = (query: Query, cards: readonly string[]): Promise<{ card_id: string; n: number }[]> =>
  query<{ card_id: string; n: number }>(
    "select card_id, count(*)::int as n from ledger.identity_questions where card_id = any($1::text[]) and passed_code <> 'nothing_to_read' group by 1",
    [cards],
  );
