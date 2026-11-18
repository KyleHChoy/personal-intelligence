import { createHash } from "node:crypto";
import {
  type ClaimRecord,
  EntityId,
  FACT_KIND_LANES,
  type FactId,
  type FactKeyFp,
  type FactKindLane,
  KEY_FIELDS,
  type OwnerSideKind,
  type PersonalCompartment,
} from "@intelligence/contracts/personal";
import { keyVersionOf, matchKey } from "@intelligence/personal-beliefs";
import { checkKeyFields, namesPerson } from "@intelligence/personal-core/checks";
import type { StoredCard } from "../../cards/card-kind-row.ts";
import { claimOf } from "../../cards/card-kinds-claims.ts";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, stamp } from "../../core/db.ts";
import { fingerprint } from "../../core/fingerprint.ts";
import { requestIdOf } from "../../core/ids.ts";
import { BELIEFS_LOCK } from "../../core/locks.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { lockRows } from "../../core/queue.ts";
import type { Sealed } from "../../core/seal.ts";
import { CARD_STATE, KILL_SWITCH_ALIASED, OWNER_ENTITY } from "../../core/statements.ts";
import { openStatus } from "../../core/status-facts.ts";
import { IN_FORCE } from "../../pipeline/fact-settlements.ts";
import { claimRecordUnder, ownerBeliefs, ownerWho } from "../admin-owner.ts";
import { retryItems, tryExtractLock } from "../extraction/admin-extraction.ts";
import { wordsOf } from "../history/admin-self.ts";
import { addOwnerTask } from "../work/owner-tasks.ts";
import { namedPair, writeFactRuling } from "./admin-fact-rulings.ts";
import { ruleIn } from "./admin-rulings.ts";

// `pia facts clean`: one pass over the facts the
// store holds about the owner (the beliefs of the owner-side kinds, but closed ones) and the open
// about-you cards, by the pinned kind rules (personal-core's checkKeyFields `kinds`), decided by code
// alone: no model. Its dry run writes nothing and answers counts by action, a sample of each, every
// confirmed fact a rule would act on, and a plan: the SHA-256 of what the apply would write. The
// apply, the owner's alone, computes the plan again in its transaction, refuses `plan_changed` when
// it differs, and writes one `facts_clean` decision and exactly that plan:
//   misfiled: a fact that fails `dated_task`, `agent_instruction` or `not_standalone`: a retire, and
//     its item set waiting with its saved calls deleted, so the next run asks its lane's version
//     anew; only for a lane the owner names as switched on to its fact-kind version, else
//     `waits_for_extraction_switch` and left alone. The new claim comes from the model, never here.
//   third_person: a fact that names a person the store resolved (`not_about_owner`): a veto, and a
//     read-only task about that person for the default task role, when tasks are on.
//   duplicate: two facts of one match key (the fewer-cards settlement's): a join.
//   lapsed: a fact past its `validTo`: a retire dated then.
//   withdraw_card: an open about-you card on a fact removed, retired, vetoed or joined into another.
//   confirmed: a fact the owner confirmed that a rule would act on, listed for their eyes: a join
//     is made all the same (`applies`), since a confirm is no endorsement of how a fact was filed;
//     a retire or a veto never, so nothing they confirmed is removed without their word.
//   undecided: what code cannot place: counted and sampled, left alone.
// Every ruling's details carry `via: cleanup`; each is lifted by `pi correct lift`. A card is
// withdrawn by `system:cleanup`, never as an answer of theirs. Ids and counts only are logged.

const CLEAN_ACTIONS = [
  "misfiled",
  "waits_for_extraction_switch",
  "third_person",
  "duplicate",
  "lapsed",
  "withdraw_card",
  "confirmed",
  "undecided",
] as const;
type CleanAction = (typeof CLEAN_ACTIONS)[number];

// One item, as the owner's terminal shows it: `words` is the fact's text, as its source wrote it.
// `code` the rule or reason; `would`, for a confirmed fact, the action a rule would take.
type CleanItem = {
  action: CleanAction;
  fact: FactId | null;
  kind: string | null;
  words: string;
  code?: string;
  would?: CleanAction;
  applies?: true;
  card?: string;
  into?: FactId;
  at?: string;
  task?: string;
};

export type CleanReport = {
  dryRun: boolean;
  plan: string;
  counts: Record<CleanAction | "kept", number>;
  samples: Record<CleanAction, CleanItem[]>;
  applied?: { rulings: number; withdrawn: number; requeued: number; tasks: number };
};

const SAMPLE = 5;
const FULL: ReadonlySet<CleanAction> = new Set(["confirmed", "third_person"]);
const CLEANUP_AUTHOR = "system:cleanup";
const MISFILED: ReadonlySet<string> = new Set(["dated_task", "agent_instruction", "not_standalone"]);
const LANES = FACT_KIND_LANES;

// The about_you confirms in force, as admin-release.ts reads them; and the confirmed settlements in
// force, the claims an owner's confirm settled without a card.
const CONFIRMS = `
  select c.target_kind, c.target_id, c.request_id, c.compartments
  from ledger.cards c join knowledge.owner_decisions o on o.card_id = c.id
  where c.kind = 'about_you' and c.created_by = 'system:extract'
    and o.kind = 'answer' and o.answer = 'confirm' and o.tainted_at is null
    and not exists (select 1 from knowledge.owner_decisions s where s.supersedes = o.id)
  order by c.id`;
const SETTLED = `
  select k.fact_key_fp from ledger.fact_settlements s join knowledge.claims k on k.id = s.claim_id
  where s.answer = 'confirmed' and ${IN_FORCE}`;
const OPEN_CARDS = `
  select c.id, c.target_kind, c.target_id, c.request_id, c.compartments from ledger.cards c
  where c.kind = 'about_you' and c.created_by = 'system:extract' and ${CARD_STATE} in ('pending', 'deferred')
  order by c.id`;
const CLAIMS =
  "select id, type, fact_key_fp, evidence_id, valid_from, compartments, content_enc from knowledge.claims where id = any ($1::text[])";
// A retire in force is one no claim of its key is dated after (admin-rulings.ts `standing`).
const RULED = `
  select r.fact_key_fp from knowledge.belief_rulings r
  where r.lifted_at is null and (r.verdict = 'veto' or (r.verdict = 'retire' and r.created_at >= (
    select max(k.valid_from) from knowledge.claims k where k.fact_key_fp = r.fact_key_fp)))`;
const FACT_RULINGS = "select verdict, a_fp, b_fp from knowledge.fact_rulings where lifted_at is null";
// Whether the owner's tasks may be opened now, and the role a task with none goes to.
const TASKS = `
  select exists (select 1 from policy.intents where for_tasks and confirmed_at is not null and revoked_at is null)
    and coalesce((${KILL_SWITCH_ALIASED}), 'off') = 'off' as open,
    (select w.default_task_role from policy.work_settings w where exists (
      select 1 from policy.clients c where c.status = 'active' and c.kind = 'agent' and w.default_task_role = any (c.roles))) as role`;
// A person a task may be about: one whose account or domain has a label that is not restricted.
const REACHABLE = `
  select 1 from (select a.compartments from knowledge.accounts a where a.entity_id = $1
    union all select d.compartments from knowledge.domains d where d.entity_id = $1) x
  where not policy.is_restricted(x.compartments) limit 1`;

type ClaimRow = {
  id: FactId;
  type: string;
  fact_key_fp: FactKeyFp;
  evidence_id: string;
  valid_from: Date;
  compartments: PersonalCompartment[];
  content_enc: Sealed;
};
type Fact = { row: ClaimRow; record: ClaimRecord; cards: string[]; confirmed: boolean; words: string };
type Planned = {
  report: CleanReport;
  lines: string[];
  retire: { fact: Fact; at?: Date }[];
  veto: { fact: Fact; person: EntityId | null }[];
  join: { into: Fact; fact: Fact }[];
  requeue: string[];
  withdraw: string[];
  role: string | null;
};

const lineHash = (lines: readonly string[]): string =>
  createHash("sha256")
    .update([...lines].sort().join("\n"), "utf8")
    .digest("hex");
// A request id of each write, from the apply's own and the write's plan line.
const requestOf = (requestId: string, line: string): string => requestIdOf(`${requestId}:${line}`);

async function plan(admin: AdminContext, query: Query, lanes: readonly FactKindLane[], now: Date): Promise<Planned> {
  const counts = Object.fromEntries([...CLEAN_ACTIONS, "kept"].map((one) => [one, 0])) as CleanReport["counts"];
  const samples = Object.fromEntries(CLEAN_ACTIONS.map((one) => [one, [] as CleanItem[]])) as CleanReport["samples"];
  const planned: Planned = {
    report: { dryRun: true, plan: "", counts, samples },
    lines: [],
    retire: [],
    veto: [],
    join: [],
    requeue: [],
    withdraw: [],
    role: null,
  };
  const note = (item: CleanItem): void => {
    counts[item.action] += 1;
    // Every item the owner decides on is listed whole: a confirmed fact, and a fact about someone else.
    if (FULL.has(item.action) || samples[item.action].length < SAMPLE) samples[item.action].push(item);
  };
  const item = (action: CleanAction, fact: Fact, more: Partial<CleanItem> = {}): CleanItem => ({
    action,
    fact: fact.row.id,
    kind: fact.row.type,
    words: fact.words,
    ...more,
  });
  const [owner] = await query<{ id: string }>(OWNER_ENTITY);
  if (owner === undefined) return planned;
  const read = { query, keys: admin.keys };
  const open = (row: ClaimRow): ClaimRecord => claimRecordUnder(admin.keys, row);
  const card = (row: {
    target_kind: string | null;
    target_id: string | null;
    request_id: string;
    compartments: string[];
  }) => ({
    target: row.target_kind === null ? null : ({ kind: row.target_kind, id: row.target_id } as StoredCard["target"]),
    compartments: row.compartments,
    requestId: row.request_id,
  });

  // The facts: each fact key of an owner-side belief about the owner that is not closed, by its
  // latest supporting claim; and each open about-you card's claim, its card beside it.
  const facts = new Map<string, Fact>();
  const add = (row: ClaimRow): Fact | undefined => {
    const record = open(row);
    if (record.claim.content.subject !== owner.id || !Object.hasOwn(KEY_FIELDS, row.type)) return undefined;
    const known = facts.get(row.fact_key_fp);
    if (known !== undefined && known.row.valid_from >= row.valid_from) return known;
    const fact = { row, record, cards: known?.cards ?? [], confirmed: false, words: wordsOf(record) };
    facts.set(row.fact_key_fp, fact);
    return fact;
  };
  const beliefs = (await ownerBeliefs(read, { types: Object.keys(KEY_FIELDS) })).filter(
    ({ belief }) => belief.subject === owner.id && Object.hasOwn(KEY_FIELDS, belief.kind) && belief.status !== "closed",
  );
  for (const row of await query<ClaimRow>(CLAIMS, [[...new Set(beliefs.flatMap((one) => one.support))]])) add(row);
  for (const row of await query<{
    id: string;
    target_kind: string | null;
    target_id: string | null;
    request_id: string;
    compartments: string[];
  }>(OPEN_CARDS)) {
    const found = await claimOf(card(row), read);
    if (found === "claim_removed") {
      planned.withdraw.push(row.id);
      note({ action: "withdraw_card", fact: null, kind: null, words: "", card: row.id, code: "claim_removed" });
      continue;
    }
    if (found === "claim_unreadable") {
      note({ action: "undecided", fact: null, kind: null, words: "", card: row.id, code: found });
      continue;
    }
    const [claim] = await query<ClaimRow>(CLAIMS, [[found.id]]);
    const fact = claim === undefined ? undefined : add(claim);
    // A card on the owner's own fact of another claim of its key asks of it all the same.
    if (fact !== undefined) fact.cards.push(row.id);
  }

  const confirmed = new Set<string>();
  for (const row of await query<{
    target_kind: string | null;
    target_id: string | null;
    request_id: string;
    compartments: string[];
  }>(CONFIRMS)) {
    const found = await claimOf(card(row), read);
    if (typeof found === "string") continue;
    for (const one of await query<{ fact_key_fp: string }>(CLAIMS, [[found.id]])) confirmed.add(one.fact_key_fp);
  }
  for (const row of await query<{ fact_key_fp: string }>(SETTLED)) confirmed.add(row.fact_key_fp);
  // A claim the owner's confirm (or their release of what they confirmed) released is confirmed too, and
  // one they stated themselves (a note, a correction's value); one their standing release kept is not.
  for (const fact of facts.values())
    fact.confirmed =
      confirmed.has(fact.row.fact_key_fp) ||
      (fact.record.released !== undefined && fact.record.released.grant !== true) ||
      fact.record.origin === "owner_command";

  const clients = (await query<{ name: string }>("select name from policy.clients order by name")).map((r) => r.name);
  const people = [
    ...(
      await ownerWho(
        { query, keys: admin.keys },
        (
          await query<{ id: string }>("select id from knowledge.entities where kind = 'person' order by id")
        ).map((r) => r.id),
      )
    ).entries(),
    // A full name of two words or more alone: a single word ("Elmhaven") is a place or a word as often as a person.
  ].flatMap(([id, who]) =>
    who.name == null || who.name.untrusted.trim().split(/\s+/u).length < 2
      ? []
      : [{ id: EntityId.parse(id), name: who.name.untrusted }],
  );
  const names = people.map((one) => one.name);
  const [tasks] = await query<{ open: boolean; role: string | null }>(TASKS);
  planned.role = tasks?.open === true ? tasks.role : null;
  const lanesOf = new Map(
    (
      await query<{ evidence_id: string; compartments: string[]; facts_enc: Sealed }>(
        "select evidence_id, compartments, facts_enc from vault.pipeline_items where evidence_id = any ($1::text[])",
        [[...new Set([...facts.values()].map((fact) => fact.row.evidence_id))]],
      )
    ).map((row) => [
      row.evidence_id,
      openStatus(read, row.compartments, row.evidence_id, row.facts_enc).lane as string,
    ]),
  );
  const ruled = new Set((await query<{ fact_key_fp: string }>(RULED)).map((row) => row.fact_key_fp));
  const factRulings = await query<{ verdict: string; a_fp: string; b_fp: string }>(FACT_RULINGS);

  // Each fact by its rules, in its key's order, so the plan is the same for the same store.
  const passed: Fact[] = [];
  const withdrawAll = (fact: Fact, code: string): void => {
    for (const one of fact.cards) {
      planned.withdraw.push(one);
      note(item("withdraw_card", fact, { card: one, code }));
    }
  };
  for (const fact of [...facts.values()].sort((a, b) => (a.row.fact_key_fp < b.row.fact_key_fp ? -1 : 1))) {
    const key = fact.row.fact_key_fp;
    if (ruled.has(key)) {
      withdrawAll(fact, "ruled");
      continue;
    }
    const fields = fact.record.claim.content.fields;
    const verdict = checkKeyFields(fact.row.type as OwnerSideKind, fields, {
      owner: true,
      kinds: { at: stamp(fact.row.valid_from), clients, people: names },
    });
    const reason = "reason" in verdict ? verdict.reason : null;
    const ends = fact.record.claim.validTo;
    const action: CleanAction =
      reason === "not_about_owner"
        ? "third_person"
        : reason !== null && MISFILED.has(reason)
          ? "misfiled"
          : reason !== null
            ? "undecided"
            : ends !== undefined && Date.parse(ends) < now.getTime()
              ? "lapsed"
              : "duplicate";
    if (action === "duplicate") {
      passed.push(fact);
      continue;
    }
    // A fact the owner confirmed or stated is listed for them whatever a rule would do, code's
    // undecided included, and never retired or vetoed.
    if (fact.confirmed) {
      note(item("confirmed", fact, { would: action, ...(reason === null ? {} : { code: reason }) }));
      continue;
    }
    if (action === "undecided") {
      note(item("undecided", fact, { code: reason ?? "" }));
      continue;
    }
    if (action === "misfiled") {
      const lane = lanesOf.get(fact.row.evidence_id);
      if (lane === undefined || !(LANES as readonly string[]).includes(lane)) {
        note(item("undecided", fact, { code: "not_reextractable" }));
        continue;
      }
      if (!lanes.includes(lane as FactKindLane)) {
        note(item("waits_for_extraction_switch", fact, { code: reason as string }));
        continue;
      }
      planned.retire.push({ fact });
      planned.requeue.push(fact.row.evidence_id);
      planned.lines.push(`retire\t${fact.row.id}`, `requeue\t${fact.row.evidence_id}`);
      note(item("misfiled", fact, { code: reason as string }));
    } else if (action === "third_person") {
      const named = people.find((one) => namesPerson(phraseOf(fact), [one.name]));
      const person =
        planned.role !== null && named !== undefined && (await query(REACHABLE, [named.id])).length > 0
          ? named.id
          : null;
      planned.veto.push({ fact, person });
      planned.lines.push(`veto\t${fact.row.id}`, ...(person === null ? [] : [`task\t${fact.row.id}\t${person}`]));
      note(item("third_person", fact, { code: reason as string, ...(person === null ? {} : { task: person }) }));
    } else {
      // Dated at its end, or at its key's latest claim when one was said after it ("until June", said in
      // August), so the retire stands: one is in force only when no claim of its key is dated after it.
      const [latest] = await query<{ at: Date }>(
        "select max(valid_from) as at from knowledge.claims where fact_key_fp = $1",
        [key],
      );
      const end = new Date(Math.max(Date.parse(ends as string), latest?.at.getTime() ?? 0));
      planned.retire.push({ fact, at: end });
      planned.lines.push(`retire_at\t${fact.row.id}\t${stamp(end)}`);
      note(item("lapsed", fact, { at: stamp(end) }));
    }
    withdrawAll(fact, action);
  }

  // Duplicates: the facts that passed every rule, by their match key; in each group the first (the
  // earliest said) is kept and each other is joined into it; a pair with a confirmed side is joined too
  // and listed as confirmed. A pair joined or split in force already, or one the join's checks refuse, is left.
  const groups = new Map<string, Fact[]>();
  for (const fact of passed) {
    const given =
      fact.record.matchKey ?? matchKey(fact.record.claim.content, keyVersionOf(fact.record.claim.extractorGeneration));
    const fp = given === undefined ? fact.row.fact_key_fp : fingerprint(admin.keys, "fact", given);
    groups.set(fp, [...(groups.get(fp) ?? []), fact]);
  }
  const pairRuled = (a: string, b: string): boolean =>
    factRulings.some((one) => (one.a_fp === a && one.b_fp === b) || (one.a_fp === b && one.b_fp === a));
  for (const group of groups.values()) {
    const [into, ...rest] = group.sort(
      (a, b) =>
        a.row.valid_from.getTime() - b.row.valid_from.getTime() || (a.row.fact_key_fp < b.row.fact_key_fp ? -1 : 1),
    );
    if (into === undefined) continue;
    counts.kept += 1;
    for (const fact of rest) {
      if (pairRuled(into.row.fact_key_fp, fact.row.fact_key_fp)) {
        counts.kept += 1;
        continue;
      }
      try {
        await namedPair(query, admin.keys, "join", into.row.id, fact.row.id);
      } catch (error) {
        if (!(error instanceof AdminError)) throw error;
        note(item("undecided", fact, { code: error.code, into: into.row.id }));
        continue;
      }
      if (into.confirmed || fact.confirmed)
        note(item("confirmed", fact.confirmed ? fact : into, { would: "duplicate", applies: true, into: into.row.id }));
      planned.join.push({ into, fact });
      planned.lines.push(`join\t${into.row.id}\t${fact.row.id}`);
      note(item("duplicate", fact, { into: into.row.id }));
      withdrawAll(fact, "duplicate");
    }
  }
  planned.lines.push(...planned.withdraw.map((one) => `withdraw\t${one}`));
  planned.report.plan = lineHash(planned.lines);
  return planned;
}

const phraseOf = (fact: Fact): string => {
  const value = fact.record.claim.content.fields[KEY_FIELDS[fact.row.type as OwnerSideKind].phrase];
  return typeof value === "string" ? value : "";
};

// `pia facts clean [--apply --plan HASH] [--fact-kinds LANES]`. `lanes`: the lanes the owner has
// switched to their fact-kind versions (PI_EXTRACT_FACT_KINDS). The dry run reads in one
// transaction and writes nothing; the apply holds the extract lock, then the beliefs lock and the
// shared taint lock, for its whole transaction.
export async function cleanFacts(
  admin: AdminContext,
  options: { dryRun: boolean; plan?: string; lanes: readonly FactKindLane[]; requestId: string },
): Promise<CleanReport> {
  if (!options.dryRun && options.plan === undefined) throw new AdminError("invalid_argument");
  const now = admin.now();
  return admin.transaction(async (query) => {
    if (!options.dryRun) {
      await tryExtractLock({ query, keys: admin.keys });
      await query(BELIEFS_LOCK);
      await lockRows(query, []);
    }
    const planned = await plan(admin, query, options.lanes, now);
    const report = { ...planned.report, dryRun: options.dryRun };
    if (options.dryRun) return report;
    if (options.plan !== report.plan) throw new AdminError("plan_changed");
    await ownerDecision(
      query,
      { requestId: options.requestId, kind: "facts_clean", details: { plan: report.plan } },
      now,
    );
    const request = (line: string): string => requestOf(options.requestId, line);
    const applied = { rulings: 0, withdrawn: 0, requeued: 0, tasks: 0 };
    const tag = { via: "cleanup" as const };
    for (const { fact, at } of planned.retire) {
      await ruleIn(admin, query, fact.row.id, "retire", request(`retire\t${fact.row.id}`), undefined, {
        ...tag,
        ...(at === undefined ? {} : { at }),
      });
      applied.rulings += 1;
    }
    for (const { fact, person } of planned.veto) {
      await ruleIn(admin, query, fact.row.id, "veto", request(`veto\t${fact.row.id}`), undefined, tag);
      applied.rulings += 1;
      if (person === null || planned.role === null) continue;
      // A task refused (the person's label, a veto of the owner's on such work) leaves the veto as it is.
      await query("savepoint clean_task");
      try {
        await addOwnerTask(
          { query, keys: admin.keys, now },
          {
            role: planned.role,
            kind: "investigate",
            // The fact too, so the task's label takes the claim's compartments: refused when restricted.
            about: [
              { kind: "entity", id: person },
              { kind: "fact", id: fact.row.id },
            ],
            note: "The cleanup found a fact about this person filed as one about the owner. Read what you can see of them and propose them with propose_person.",
            requestId: request(`task\t${fact.row.id}`),
          },
        );
        await query("release savepoint clean_task");
        applied.tasks += 1;
      } catch (error) {
        if (!(error instanceof AdminError)) throw error;
        await query("rollback to savepoint clean_task");
      }
    }
    for (const { into, fact } of planned.join) {
      const pair = await namedPair(query, admin.keys, "join", into.row.id, fact.row.id);
      await writeFactRuling(query, {
        verdict: "join",
        ...pair,
        requestId: request(`join\t${into.row.id}\t${fact.row.id}`),
        now,
        via: "cleanup",
      });
      applied.rulings += 1;
    }
    for (const id of planned.withdraw) {
      // Only while it is still open: an answer or a withdrawal since the plan stands.
      const withdrawn = await query(
        `insert into ledger.record_events (row_kind, row_id, event, at, by, compartments)
         select 'card', c.id, 'withdrawn', $2, $3, c.compartments from ledger.cards c
         where c.id = $1 and ${CARD_STATE} in ('pending', 'deferred') returning 1`,
        [id, stamp(now), CLEANUP_AUTHOR],
      );
      applied.withdrawn += withdrawn.length;
    }
    applied.requeued = await retryItems({ query, keys: admin.keys }, [...new Set(planned.requeue)]);
    admin.log.info({ event: "facts_clean", counts: { ...applied } });
    return { ...report, applied };
  });
}
