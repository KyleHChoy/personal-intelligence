import { createHash } from "node:crypto";
import {
  type CardId,
  DECISION_POINT_PINS,
  type EntityId,
  type NewCard,
  type OpportunityId,
  type RulingId,
} from "@intelligence/contracts/personal";
import { questionRules } from "@intelligence/personal-core/planner";
import { describe, expect, it } from "vitest";
import { setTaskTier } from "../admin/admin-tasks.ts";
import { ownerQuestions } from "../admin/outcomes/admin-outcomes-questions.ts";
import { proposeQuestionRules } from "../cards/question-rules.ts";
import type { Query } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { raiseCard } from "../core/queue.ts";
import { sealUnder } from "../core/seal.ts";
import { ERASURE_HOOKS } from "../erasure/erasure-hooks.ts";
import { DETAIL_CONTACTS } from "../read/read-tools-entity.ts";
import { asRole, asWork, type OwnerWorld, withOwnerWorld } from "../test-support/card-task-world.ts";
import { ALL_TOOLS, request, sha256Hex, testId } from "../test-support/clients.ts";
import { asTablesOwner, session } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { interactionId } from "../test-support/values.ts";
import { AGENT_WORK_TOOLS, READING_AGENT_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { personNamed as person } from "../test-support/work-seeds.ts";
import { workAgent } from "../test-support/work-test-tasks.ts";
import { ok, type WorkWorld } from "../test-support/work-test-world.ts";
import { proposedOpportunities } from "../work/dispatch-read.ts";
import { raiseDecisionCard } from "../work/dispatch-write.ts";
import { exceptionOf, groupsOf, namesakesRuled } from "./groups.ts";
import { recordsRead } from "./identity-questions.ts";

// Made-up values on reserved domains only.

const OWN = ["own"];
const AGENTS = ["agent:scout", "agent:wide"];
const KEYS = ["own", "employer:example", ...AGENTS];

type World = OwnerWorld & { scout: WorkClient; wide: WorkClient };

// A row's label changed as its table's owner: no runtime role updates a label.
const relabel = (w: WorkWorld, table: string, text: string, values: unknown[] = []): Promise<unknown> =>
  asTablesOwner(w.db, [table], (query) => query(text, values));

async function agent(w: WorkWorld, name: string): Promise<WorkClient> {
  const client = await workAgent(w, name, [...OWN, ...AGENTS], {
    tools: READING_AGENT_TOOLS,
    kinds: ["research"],
  });
  await w.admin("update policy.clients set roles = array['network'] where name = $1", [name]);
  return client;
}

const inWorld = (fn: (w: World) => Promise<void>): Promise<void> =>
  withOwnerWorld(KEYS, "identity-agents", async (base) => {
    await base.admin("update policy.work_settings set identity_merges = 'on', default_task_role = 'network'");
    const scout = await agent(base, "scout");
    const wide = await agent(base, "wide");
    await fn({ ...base, scout, wide });
  });

// A message on a person's interaction log, holding this text.
async function wrote(w: WorkWorld, entity: string, text: string): Promise<string> {
  const { id: seeded, evidence } = await w.message(OWN);
  void seeded;
  const id = await w.seed.message(OWN, undefined, { text });
  const [row] = await w.admin<{ evidence_id: string }>("select evidence_id from knowledge.messages where id = $1", [
    id,
  ]);
  const made = row?.evidence_id ?? evidence;
  await w.admin(
    `insert into knowledge.interaction_log (id, evidence_id, member_id, entity_id, direction, channel, occurred_at, compartments, readers, entity_role)
     values ($1, $2, 'm-owner', $3, 'inbound', 'email', now() - interval '10 days', $4, '{m-owner}', 'sender')`,
    [interactionId(made, entity), made, entity, OWN],
  );
  return id;
}

const asPipeline = <T>(w: WorkWorld, fn: (query: Query) => Promise<T>): Promise<T> => asRole(w.db.urls.pipeline, fn);

// A pair offered as many times as agents get, with nobody settling it: it reaches the owner.
const offeredOut = async (w: World): Promise<void> => {
  await sweep(w);
  await w.admin("update ledger.identity_questions set offers = $1", [questionRules().maxOffers]);
  await sweep(w);
};

// A saved contact listing this person, holding these fields.
const card = async (
  w: WorkWorld,
  entity: string,
  facts: {
    names?: string[];
    phones?: { value: string; type: null }[];
    organizations?: { name: string; title: null }[];
    links?: { url: string }[];
  },
  label: string[] = OWN,
): Promise<void> => {
  const id = (await w.seed.into("knowledge.contacts")(label)) as string;
  await w.admin("update knowledge.contacts set facts_enc = $2, phone_fps = $3 where id = $1", [
    id,
    JSON.stringify(
      sealUnder(w.db.keys, label, { table: "knowledge.contacts", id, column: "facts_enc" }, JSON.stringify(facts)),
    ),
    (facts.phones ?? []).map((one) => fingerprint(w.db.keys, "phone", one.value)),
  ]);
  await w.admin(
    "insert into knowledge.contact_addresses (contact_id, value_fp, entity_id, compartments) values ($1, $2, $3, $4)",
    [id, fingerprint(w.db.keys, "address", `${entity.toLowerCase()}@contacts.example`), entity, label],
  );
};
const onRecords = (question: string, because: string, sources: unknown[]) => [
  { question, verdict: "same", because, sources },
];

const NAME = "Dara Vance";
const barePair = async (w: WorkWorld): Promise<[EntityId, EntityId]> => [
  await person(w, "dara.work@example.org", NAME),
  await person(w, "dv-home@example.net", NAME),
];
// A pair an agent could prove: each person has a message on their own log.
const pair = async (w: WorkWorld): Promise<[EntityId, EntityId]> => {
  const [a, b] = await barePair(w);
  await wrote(w, a, "A first note from the work address about the project.");
  await wrote(w, b, "A first note from the home address about the project.");
  return [a, b];
};
let minute = 0;
const sweep = (w: World) =>
  w.writer.proposeIdentity(new Date(Date.parse("2026-11-05T12:00:00Z") + (minute += 1) * 60_000));
const agentsOn = (w: World) => w.owner.identity.setIdentityAgents("on");

const flagOf = async (w: WorkWorld): Promise<OpportunityId> => {
  const [gap] = await queryAs<{ subject: string; about_id: string }>(
    w.db.urls.work,
    "select subject, about_id from ledger.same_person_gaps()",
  );
  if (gap === undefined) throw new Error("no batch waiting");
  const [row] = await queryAs<{ id: string | null }>(
    w.db.urls.work,
    "select ledger.raise_gap_flag($1, 'same_person', $2, 'entity', $3, 'entity', $3, null, null, true) as id",
    [testId("opp"), gap.subject, gap.about_id],
  );
  if (row?.id == null) throw new Error("no flag");
  return row.id as OpportunityId;
};

// Claims the batch's task, and reports these answers: the report's answer.
async function report(w: World, client: WorkClient, flag: OpportunityId, answers: unknown[]) {
  ok(await w.work.claimOpportunity(client.token, { id: flag, requestId: request() }));
  const { move } = ok(
    await w.work.planMove(client.token, { opportunity: flag, stage: "investigate", requestId: request() }),
  );
  return w.work.reportMove(client.token, {
    move,
    outcome: "done",
    report: { samePerson: answers } as never,
    requestId: request(),
  });
}
const onlyQuestion = async (
  w: WorkWorld,
): Promise<{ id: string; state: string; batch: string | null; card_id: string | null }> => {
  const [row] = await w.admin<{ id: string; state: string; batch: string | null; card_id: string | null }>(
    "select id, state, batch, card_id from ledger.identity_questions",
  );
  if (row === undefined) throw new Error("no question");
  return row;
};
const openCards = (w: WorkWorld) =>
  w.admin<{ id: CardId; kind: string }>(
    `select c.id, c.kind from ledger.cards c where c.created_by = 'system:identity'
       and (select r.event from ledger.record_events r where r.row_kind = 'card' and r.row_id = c.id order by r.id desc limit 1) in ('pending', 'deferred')`,
  );
const decide = (w: World, card: CardId, answer: string) =>
  w.owner.cards.decide({ cards: [card], answer, requestId: testId("req").slice(4) });

const SAME = (question: string, message: string, other: string) => ({
  question,
  verdict: "same",
  because: "says_so",
  sources: [
    { message, quote: "writing from my new work address now" },
    { message: other, quote: "my new address from today on" },
  ],
});

// Two people two agents ruled the same from a message each wrote, and the question they answered.
async function agentsJoined(w: World) {
  await agentsOn(w);
  const [a, b] = await pair(w);
  const one = await wrote(w, a, "Dara Vance here, writing from my new work address now");
  const two = await wrote(w, b, "Please use my new address from today on.");
  await sweep(w);
  const question = await onlyQuestion(w);
  ok(await report(w, w.scout, await flagOf(w), [SAME(question.id, one, two)]));
  await sweep(w);
  ok(await report(w, w.wide, await flagOf(w), [SAME(question.id, one, two)]));
  await sweep(w);
  return { a, b, one, two, question };
}

// The erasure's `identity` hook alone, over the evidence of one message, as an erasure of it runs it.
async function eraseCited(w: World, message: string, dryRun = false): Promise<number> {
  const [cited] = await w.admin<{ evidence_id: string }>("select evidence_id from knowledge.messages where id = $1", [
    message,
  ]);
  const hook = ERASURE_HOOKS.find((row) => row.name === "identity");
  if (hook === undefined) throw new Error("no hook");
  const erased = { evidenceIds: [cited?.evidence_id as string], refs: [], addressFps: [], sources: [] };
  return session(w.db.urls.admin, (query) =>
    hook.run(query, { ...erased, records: [], recordEvidenceIds: [] } as never, { dryRun } as never),
  );
}

describe("same-person questions go to agents", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("while the switch is off the sweep cards as before and asks nobody", async () => {
    await inWorld(async (w) => {
      await pair(w);
      await sweep(w);
      expect((await openCards(w)).map((one) => one.kind)).toEqual(["same_person"]);
      expect(await w.admin("select id from ledger.identity_questions")).toEqual([]);
    });
  });

  it("on: no card; the agent's brief lists the pair; a same citing more than the name is a ruling marked as the agent's", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      const [a, b] = await pair(w);
      const one = await wrote(w, a, "Dara Vance here, writing from my new work address now");
      const two = await wrote(w, b, "Please use my new address from today on. Dara Vance");
      await sweep(w);
      expect(await openCards(w)).toEqual([]);
      const question = await onlyQuestion(w);
      expect(question.state).toBe("agents");
      const flag = await flagOf(w);
      const claimed = ok(await w.work.claimOpportunity(w.scout.token, { id: flag, requestId: request() }));
      expect(JSON.stringify(claimed)).toContain(question.id);
      const { move } = ok(
        await w.work.planMove(w.scout.token, { opportunity: flag, stage: "investigate", requestId: request() }),
      );
      ok(
        await w.work.reportMove(w.scout.token, {
          move,
          outcome: "done",
          report: { samePerson: [SAME(question.id, one, two)] } as never,
          requestId: request(),
        }),
      );
      await sweep(w);
      // One agent is not enough for a same.
      expect(await w.admin("select ruling_id from knowledge.identity_rulings")).toEqual([]);
      ok(await report(w, w.wide, await flagOf(w), [SAME(question.id, one, two)]));
      await sweep(w);
      const [ruling] = await w.admin<{ verdict: string; kind: string; basis: string; client: string; id: string }>(
        `select r.verdict, d.kind, d.details ->> 'basis' as basis, d.details ->> 'client' as client, r.ruling_id as id
         from knowledge.identity_rulings r join knowledge.owner_decisions d on d.id = r.ruling_id`,
      );
      expect(ruling).toMatchObject({ verdict: "same", kind: "identity_policy", basis: "agent" });
      expect((await onlyQuestion(w)).state).toBe("settled");
      const audit = await w.owner.identity.listIdentityAnswers();
      expect(audit.map((row) => row.client).sort()).toEqual(["scout", "wide"]);
      expect(audit[0]).toMatchObject({ verdict: "same", because: "says_so", cites: [one, two], lifted: false });
    });
  });

  it("a shared name is refused, and a quote the message does not hold", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      const [a, b] = await pair(w);
      const one = await wrote(w, a, "Regards, Dara Vance");
      const two = await wrote(w, b, "Best, Dara Vance");
      await sweep(w);
      const question = await onlyQuestion(w);
      const flag = await flagOf(w);
      const name = [
        {
          question: question.id,
          verdict: "same",
          because: "signature",
          sources: [
            { message: one, quote: "Dara Vance" },
            { message: two, quote: "Dara Vance" },
          ],
        },
      ];
      const answered = ok(await report(w, w.scout, flag, name));
      expect(answered).toMatchObject({ refused: ["same_person_no_evidence"] });
      expect(await w.admin("select id from ledger.identity_answers")).toEqual([]);
      await sweep(w);
      expect(await w.admin("select ruling_id from knowledge.identity_rulings")).toEqual([]);
    });
  });

  it("two can't-tells reach the owner on one card saying what was tried; leave rests it until something changes", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      const [a] = await pair(w);
      await sweep(w);
      const first = await onlyQuestion(w);
      const cant = (id: string) => [{ question: id, verdict: "cant_tell", why: "name_only" }];
      ok(await report(w, w.scout, await flagOf(w), cant(first.id)));
      await sweep(w);
      // Offered again, to the second agent.
      expect((await onlyQuestion(w)).state).toBe("agents");
      expect(await openCards(w)).toEqual([]);
      ok(await report(w, w.wide, await flagOf(w), cant(first.id)));
      await sweep(w);
      const [card] = await openCards(w);
      expect(card?.kind).toBe("same_person_batch");
      const shown = await w.owner.cards.card(card?.id as CardId);
      expect(JSON.stringify(shown)).toContain("name_only+name_only");
      await decide(w, card?.id as CardId, "leave");
      await sweep(w);
      await sweep(w);
      expect(await openCards(w)).toEqual([]);
      expect((await onlyQuestion(w)).state).toBe("resting");
      // A new name on one of them is new evidence: agents are asked again.
      await w.seed.alias(OWN, a, undefined, "Dara V. Okafor");
      await sweep(w);
      expect((await onlyQuestion(w)).state).toBe("agents");
    });
  });

  it("the owner's batch answer settles every pair on the card, and the owner's different lifts an agent's same in its way", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      const [a, b] = await pair(w);
      const one = await wrote(w, a, "Dara Vance here, writing from my new work address now");
      const two = await wrote(w, b, "Please use my new address from today on.");
      await sweep(w);
      const question = await onlyQuestion(w);
      ok(await report(w, w.scout, await flagOf(w), [SAME(question.id, one, two)]));
      await sweep(w);
      ok(await report(w, w.wide, await flagOf(w), [SAME(question.id, one, two)]));
      await sweep(w);
      const [made] = await w.admin<{ ruling_id: RulingId }>("select ruling_id from knowledge.identity_rulings");
      // An agent's ruling on other people is not in the way of the owner's.
      await queryAs(
        w.db.urls.work,
        "select ledger.propose_question_rule($1, 'same_person', 'same_person:name:0', 'different', 10, null, now(), $2)",
        [`qrl_${testId("x").slice(-26)}`, OWN],
      );
      await w.admin("update ledger.question_rules set status = 'confirmed', decided_at = now()");
      await person(w, "lee.one@example.org", "Lee Stone");
      await person(w, "lee-two@example.net", "Lee Stone");
      await sweep(w);
      const [unrelated] = await w.admin<{ ruling_id: string; verdict: string }>(
        `select ruling_id, verdict from knowledge.identity_rulings where verdict = 'different'`,
      );
      expect(unrelated?.verdict).toBe("different");
      await w.owner.identity.linkPeople(a, b, "different", { requestId: testId("req").slice(4) });
      const rows = await w.admin<{ ruling_id: string; verdict: string; lifted: boolean }>(
        "select ruling_id, verdict, lifted_at is not null as lifted from knowledge.identity_rulings order by created_at",
      );
      expect(rows.find((row) => row.ruling_id === made?.ruling_id)?.lifted).toBe(true);
      expect(rows.filter((row) => row.verdict === "different").every((row) => !row.lifted)).toBe(true);
      expect(rows.find((row) => row.ruling_id === unrelated?.ruling_id)?.lifted).toBe(false);
    });
  });

  it("a rule the owner confirmed answers its shape, and code never lets a same rule stand on a shared name", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      await pair(w);
      await sweep(w);
      const question = await onlyQuestion(w);
      const [shape] = await w.admin<{ pattern: string }>("select pattern from ledger.identity_questions");
      expect(shape?.pattern).toMatch(/^same_person:name:/);
      const rule = async (answer: string): Promise<void> => {
        await w.admin("update ledger.question_rules set status = 'lifted' where status = 'confirmed'");
        await queryAs(
          w.db.urls.work,
          "select ledger.propose_question_rule($1, 'same_person', $2, $3, 10, null, now(), $4)",
          [`qrl_${testId("x").slice(-26)}`, shape?.pattern, answer, OWN],
        );
        await w.admin(
          "update ledger.question_rules set status = 'confirmed', decided_at = now() where status = 'proposed'",
        );
      };
      await rule("same");
      await sweep(w);
      expect(await w.admin("select ruling_id from knowledge.identity_rulings")).toEqual([]);
      await rule("different");
      await sweep(w);
      const [made] = await w.admin<{ verdict: string; basis: string }>(
        `select r.verdict, d.details ->> 'basis' as basis from knowledge.identity_rulings r join knowledge.owner_decisions d on d.id = r.ruling_id`,
      );
      expect(made).toEqual({ verdict: "different", basis: "rule" });
      expect(
        (
          await w.admin<{ state: string }>("select state from ledger.identity_questions where id = $1", [question.id])
        )[0]?.state,
      ).toBe("settled");
    });
  });

  it("a shared phone merges nothing: with the switch off it is not read, and on it is a question", async () => {
    await inWorld(async (w) => {
      const a = await person(w, "first@example.org", "Rowan Hale");
      const b = await person(w, "second@example.net", "R. Hale");
      await wrote(w, a, "A note from the first address about the project.");
      await wrote(w, b, "A note from the second address about the project.");
      const contact = async (entity: string): Promise<void> => {
        const id = (await w.seed.into("knowledge.contacts")(OWN)) as string;
        await w.admin("update knowledge.contacts set phone_fps = $2, name_fps = $3 where id = $1", [
          id,
          [fingerprint(w.db.keys, "phone", "+15550100")],
          [fingerprint(w.db.keys, "name", "Rowan Hale")],
        ]);
        await w.admin(
          "insert into knowledge.contact_addresses (contact_id, value_fp, entity_id, compartments) values ($1, $2, $3, $4)",
          [id, fingerprint(w.db.keys, "address", `${entity.toLowerCase()}@contacts.example`), entity, OWN],
        );
      };
      await contact(a);
      await contact(b);
      await w.admin("update policy.work_settings set identity_merges = 'on'");
      // Off: the sweep behaves as deployed: nothing is read of the phone, nothing merges.
      await sweep(w);
      expect(await w.admin("select id from ledger.identity_questions")).toEqual([]);
      expect(await openCards(w)).toEqual([]);
      expect(await w.admin("select ruling_id from knowledge.identity_rulings")).toEqual([]);
      const [refused] = await queryAs<{ code: string }>(
        w.db.urls.writer,
        "select code from ledger.policy_merge($1, $2, 'phone', null, $3)",
        [a, b, testId("req").slice(4)],
      );
      expect(refused?.code).toBe("basis_absent");
      // On: a question to agents, through the sweep's own read, and still no ruling.
      await agentsOn(w);
      await sweep(w);
      const rows = await w.admin<{ basis: string; state: string }>(
        "select basis, state from ledger.identity_questions",
      );
      expect(rows).toEqual([{ basis: "phone", state: "agents" }]);
      expect(await w.admin("select ruling_id from knowledge.identity_rulings")).toEqual([]);
    });
  });

  it("a phone never displaces a name candidate's holds", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      await w.admin("update policy.clients set compartments = compartments || array['employer:example']");
      const a = await person(w, "same.name@example.org", NAME);
      const b = await person(w, "other@example.net", NAME);
      // Saved under another label than the pair's name, so neither is established for it.
      for (const entity of [a, b]) {
        const id = (await w.seed.into("knowledge.contacts")(["employer:example"])) as string;
        await w.admin("update knowledge.contacts set phone_fps = $2, name_fps = $3 where id = $1", [
          id,
          [fingerprint(w.db.keys, "phone", "+15550101")],
          [fingerprint(w.db.keys, "name", NAME)],
        ]);
        await w.admin(
          "insert into knowledge.contact_addresses (contact_id, value_fp, entity_id, compartments) values ($1, $2, $3, $4)",
          [
            id,
            fingerprint(w.db.keys, "address", `${entity.toLowerCase()}@contacts.example`),
            entity,
            ["employer:example"],
          ],
        );
      }
      await sweep(w);
      const rows = await w.admin<{ basis: string; exception: string | null }>(
        "select basis, exception from ledger.identity_questions",
      );
      expect(rows).toEqual([{ basis: "name", exception: "unestablished" }]);
    });
  });

  it("a cite under another label is refused, and a question carries the label of the alias that made it", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      const [a, b] = await pair(w);
      const one = await wrote(w, a, "Dara Vance here, writing from my new work address now");
      const two = await wrote(w, b, "Please use my new address from today on.");
      await sweep(w);
      const question = await onlyQuestion(w);
      await relabel(
        w,
        "knowledge.messages",
        "update knowledge.messages set compartments = array['agent:wide'] where id = $1",
        [two],
      );
      const answered = ok(await report(w, w.scout, await flagOf(w), [SAME(question.id, one, two)]));
      expect(answered).toMatchObject({ refused: ["same_person_no_evidence"] });
      expect(await w.admin("select id from ledger.identity_answers")).toEqual([]);
    });
    await inWorld(async (w) => {
      await agentsOn(w);
      const a = await person(w, "wider.one@example.org", "Plain One");
      const b = await person(w, "wider.two@example.net", "Plain Two");
      await w.seed.alias(["employer:example"], a, undefined, "Wren Sable");
      await w.seed.alias(["employer:example"], b, undefined, "Wren Sable");
      await wrote(w, a, "A note from the first address about the project.");
      await wrote(w, b, "A note from the second address about the project.");
      await sweep(w);
      const [row] = await w.admin<{ compartments: string[] }>("select compartments from ledger.identity_questions");
      expect(row?.compartments).toEqual(expect.arrayContaining(["employer:example", "own"]));
      // An agent cleared for `own` alone is told nothing of it: the batch is under the wider label, and no
      // cleared agent means it goes to the owner.
      expect((await onlyQuestion(w)).state).toBe("owner");
      const narrow = await w.client("narrow", OWN, { tools: [...ALL_TOOLS, ...AGENT_WORK_TOOLS] });
      const listed = ok(await w.work.listOpportunities(narrow.token, {} as never));
      expect(JSON.stringify(listed)).not.toContain("same_person");
    });
  });

  it("a blocked batch ages nothing, and a vetoed person does not hold other pairs up", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      const [a] = await pair(w);
      const other = await person(w, "lee.one@example.org", "Lee Stone");
      const another = await person(w, "lee-two@example.net", "Lee Stone");
      await wrote(w, other, "A note from the first address about the project.");
      await wrote(w, another, "A note from the second address about the project.");
      await w.owner.cards.addVeto({ entity: a }, { requestId: testId("req").slice(4) });
      await sweep(w);
      await sweep(w);
      const rows = await w.admin<{ a_entity: string; batch: string | null; offers: number; state: string }>(
        "select a_entity, batch, offers, state from ledger.identity_questions",
      );
      const vetoed = rows.find((row) => row.a_entity === a);
      const free = rows.find((row) => row.a_entity !== a);
      expect(vetoed).toMatchObject({ batch: null, offers: 0, state: "agents" });
      expect(free?.batch).not.toBeNull();
      // Its batch can be raised, under its own first person.
      await flagOf(w);
    });
    // With no intent, or the tier off, no task exists, and however long it waits nothing ages.
    await inWorld(async (w) => {
      await agentsOn(w);
      await pair(w);
      await setTaskTier(w.admin, false, new Date());
      await sweep(w);
      const [gap] = await queryAs<{ subject: string; about_id: string }>(
        w.db.urls.work,
        "select subject, about_id from ledger.same_person_gaps()",
      );
      const [made] = await queryAs<{ id: string | null }>(
        w.db.urls.work,
        "select ledger.raise_gap_flag($1, 'same_person', $2, 'entity', $3, 'entity', $3, null, null, true) as id",
        [testId("opp"), gap?.subject, gap?.about_id],
      );
      expect(made?.id).toBeNull();
      await sweep(w);
      await sweep(w);
      expect(await onlyQuestion(w)).toMatchObject({ state: "agents" });
      const [row] = await w.admin<{ offers: number }>("select offers from ledger.identity_questions");
      expect(row?.offers).toBe(0);
    });
  });

  it("with no agent on the route a pair waits, and reaches the owner only if the route's agents can't read it", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      await pair(w);
      const [role] = await w.admin<{ roles: string[] }>(
        "select roles from policy.clients where status = 'active' and kind = 'agent' and roles <> '{}' limit 1",
      );
      await w.admin("update policy.clients set roles = '{}'");
      await sweep(w);
      expect((await onlyQuestion(w)).state).toBe("agents");
      expect(await openCards(w)).toEqual([]);
      // Back on the route, cleared for nothing this pair holds.
      await w.admin(
        "update policy.clients set roles = $1, compartments = array['agent:' || name] where kind = 'agent'",
        [role?.roles ?? []],
      );
      await sweep(w);
      expect((await onlyQuestion(w)).state).toBe("owner");
      expect((await openCards(w)).map((one) => one.kind)).toEqual(["same_person_batch"]);
    });
  });

  it("an agent's different settles its pair and is not the owner's word about anyone else", async () => {
    const groups = groupsOf([{ id: "r", verdict: "different", aFp: "a", bFp: "b", liftedAt: null, byAgent: true }], []);
    const agentRuled = [{ id: "r", verdict: "different", aFp: "a", bFp: "b", liftedAt: null, byAgent: true }] as const;
    expect(exceptionOf(groups, agentRuled, "a", "c", "name", false, true)).toBeUndefined();
    expect(namesakesRuled(agentRuled, [["a"], ["b"]])).toBe(false);
    await inWorld(async (w) => {
      await w.admin("update policy.work_settings set identity_merges = 'on'");
      await agentsOn(w);
      const a = await person(w, "one@example.org", NAME);
      const c = await person(w, "three@example.org", NAME);
      for (const entity of [a, c]) {
        const id = (await w.seed.into("knowledge.contacts")(OWN)) as string;
        await w.admin(
          "insert into knowledge.contact_addresses (contact_id, value_fp, entity_id, compartments) values ($1, $2, $3, $4)",
          [id, fingerprint(w.db.keys, "address", `${entity.toLowerCase()}@contacts.example`), entity, OWN],
        );
      }
      // An agent ruled the first apart from someone else: a merge of the first and third still goes.
      const [d] = await w.admin<{ value_fp: string }>("select value_fp from knowledge.accounts where entity_id = $1", [
        a,
      ]);
      const other = await person(w, "two@example.org", "Unrelated Person");
      const [e] = await w.admin<{ value_fp: string }>("select value_fp from knowledge.accounts where entity_id = $1", [
        other,
      ]);
      const ruling = testId("rul");
      await w.admin(
        "insert into knowledge.owner_decisions (id, request_id, kind, answer, batch, queue_depth, details, decided_at, compartments) values ($1, $2, 'identity_policy', 'different', false, 0, $3, now(), $4)",
        [ruling, ruling.slice(4), JSON.stringify({ basis: "agent", client: "scout" }), OWN],
      );
      await w.admin(
        "insert into knowledge.identity_rulings (ruling_id, verdict, a_fp, b_fp, created_at, by_agent) values ($1, 'different', $2, $3, now(), true)",
        [ruling, ...[d?.value_fp, e?.value_fp].sort()],
      );
      await sweep(w);
      const merges = await w.admin("select ruling_id from knowledge.identity_rulings where verdict = 'same'");
      expect(merges).toHaveLength(1);
    });
  });

  it("a lift rests its pair and any sibling, and neither reaches the owner unchanged", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      const [a, b] = await pair(w);
      const c = await person(w, "dara3@example.com", NAME);
      void c;
      const one = await wrote(w, a, "Dara Vance here, writing from my new work address now");
      const two = await wrote(w, b, "Please use my new address from today on.");
      await sweep(w);
      const questions = await w.admin<{ id: string; a_entity: string; b_entity: string }>(
        "select id, a_entity, b_entity from ledger.identity_questions",
      );
      const ab = questions.find(
        (row) => [a, b].includes(row.a_entity as EntityId) && [a, b].includes(row.b_entity as EntityId),
      );
      if (ab === undefined) throw new Error("no pair");
      // A third holder of the name holds back all but one exact address or one person's profile.
      expect(ok(await report(w, w.scout, await flagOf(w), [SAME(ab.id, one, two)]))).toMatchObject({
        refused: ["same_person_no_evidence"],
      });
      const profile = "https://linkedin.com/in/dara-vance-example";
      await card(w, a, { names: [NAME], links: [{ url: profile }] });
      await card(w, b, { names: [NAME], links: [{ url: profile }] });
      const answer = onRecords(ab.id, "same_link", [
        { record: a, field: "link", value: profile },
        { record: b, field: "link", value: profile },
      ]);
      const flag = await flagOf(w);
      const { move } = ok(
        await w.work.planMove(w.scout.token, { opportunity: flag, stage: "investigate", requestId: request() }),
      );
      ok(
        await w.work.reportMove(w.scout.token, {
          move,
          outcome: "done",
          report: { samePerson: answer } as never,
          requestId: request(),
        }),
      );
      await sweep(w);
      ok(await report(w, w.wide, await flagOf(w), answer));
      await sweep(w);
      const [made] = await w.admin<{ ruling_id: RulingId }>("select ruling_id from knowledge.identity_rulings");
      await w.owner.identity.liftIdentity(made?.ruling_id as RulingId, { requestId: testId("req").slice(4) });
      await sweep(w);
      await sweep(w);
      expect(await openCards(w)).toEqual([]);
      const states = await w.admin<{ state: string }>("select state from ledger.identity_questions");
      expect(states.length).toBeGreaterThan(0);
      for (const row of states) expect(["resting", "settled"]).toContain(row.state);
      expect(await w.admin("select ruling_id from knowledge.identity_rulings where lifted_at is null")).toEqual([]);
    });
  });

  it("a second agent's held batch survives sweeps, and a pair nobody answers reaches the owner saying so", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      await pair(w);
      await sweep(w);
      const first = await onlyQuestion(w);
      const cant = [{ question: first.id, verdict: "cant_tell", why: "name_only" }];
      ok(await report(w, w.scout, await flagOf(w), cant));
      await sweep(w);
      const second = await onlyQuestion(w);
      await flagOf(w);
      await sweep(w);
      await sweep(w);
      expect((await onlyQuestion(w)).batch).toBe(second.batch);
      await w.admin("update ledger.identity_questions set offers = 3");
      await sweep(w);
      expect((await onlyQuestion(w)).state).toBe("owner");
      const [card] = await openCards(w);
      expect(card?.kind).toBe("same_person_batch");
      // Settled some other way, the card goes, and no second comes beside it.
      await w.admin("update ledger.identity_questions set state = 'settled'");
      await sweep(w);
      expect(await openCards(w)).toEqual([]);
    });
  });

  it("a batch whose every pair an agent answered is not offered to it again, and waits for the second agent", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      await pair(w);
      await sweep(w);
      const question = await onlyQuestion(w);
      ok(
        await report(w, w.scout, await flagOf(w), [{ question: question.id, verdict: "cant_tell", why: "name_only" }]),
      );
      await sweep(w);
      const flag = await flagOf(w);
      const listed = async (client: WorkClient) =>
        ok(await w.work.listOpportunities(client.token, { tier: "task" })).opportunities.map((one) => one.id);
      // Nothing in it is the first agent's to answer: off its board, and its claim refused.
      expect(await listed(w.scout)).not.toContain(flag);
      expect(await w.work.claimOpportunity(w.scout.token, { id: flag, requestId: request() })).toEqual({
        ok: false,
        code: "not_found",
        refusal: "work_held",
      });
      // The second agent still finds it, and its brief holds the pair.
      expect(await listed(w.wide)).toContain(flag);
      const claimed = ok(await w.work.claimOpportunity(w.wide.token, { id: flag, requestId: request() }));
      expect(claimed.brief?.samePerson?.map((one) => one.question)).toEqual([question.id]);
      // Released, it is back for the second agent alone.
      ok(await w.work.releaseOpportunity(w.wide.token, { id: flag, reason: "no_time", requestId: request() }));
      expect(await listed(w.scout)).not.toContain(flag);
      expect(await listed(w.wide)).toContain(flag);
    });
  });

  it("a person's erased same-person question is counted before the entity cascade", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      const [a] = await pair(w);
      await sweep(w);
      expect(await w.admin("select id from ledger.identity_questions")).toHaveLength(1);
      const preview = await w.owner.erasure.erasePerson(a as EntityId, { requestId: request(), dryRun: true });
      expect(preview.more.identity).toBe(1);
      expect(await w.admin("select id from ledger.identity_questions")).toHaveLength(1);
      const erased = await w.owner.erasure.erasePerson(a as EntityId, { requestId: request() });
      expect(erased.more.identity).toBe(preview.more.identity);
      expect(await w.admin("select id from ledger.identity_questions")).toEqual([]);
    });
  });

  it("a removed message lifts the ruling that cited it, as nobody's no, and agents answer again", async () => {
    await inWorld(async (w) => {
      const { a, one, two, question } = await agentsJoined(w);
      const preview = await eraseCited(w, one, true);
      expect(preview).toBe(2);
      expect(await w.admin("select id from ledger.identity_answers")).toHaveLength(2);
      const removed = await eraseCited(w, one);
      expect(removed).toBe(preview);
      const [lifted] = await w.admin<{ lifted: boolean; deletion: boolean }>(
        "select lifted_at is not null as lifted, lifted_by_deletion as deletion from knowledge.identity_rulings",
      );
      expect(lifted).toEqual({ lifted: true, deletion: true });
      await sweep(w);
      // Nobody said no: the pair is asked again, of the same agents, not rested or sent to the owner.
      expect((await onlyQuestion(w)).state).toBe("agents");
      expect(await openCards(w)).toEqual([]);
      const three = await wrote(w, a, "Writing again from my new work address, about the same move");
      ok(
        await report(w, w.scout, await flagOf(w), [
          {
            question: question.id,
            verdict: "same",
            because: "says_so",
            sources: [
              { message: three, quote: "from my new work address, about the same move" },
              { message: two, quote: "my new address from today on" },
            ],
          },
        ]),
      );
      const metrics = await ownerQuestions(
        w.admin,
        new Date(Date.now() - 86_400_000).toISOString(),
        new Date(Date.now() + 86_400_000).toISOString(),
        OWN,
      );
      expect(metrics.find((row) => row.metric === "settled_without_owner_overturned")?.parts?.overturned).toBe(0);
    });
  });

  it("invariant 11: the owner's link on a pair agents joined stands when a deletion lifts the agents' ruling: the owner's same takes its place", async () => {
    await inWorld(async (w) => {
      const { a, b, one, question } = await agentsJoined(w);
      const [agents] = await w.admin<{ ruling_id: string; a_fp: string; b_fp: string }>(
        "select ruling_id, a_fp, b_fp from knowledge.identity_rulings where lifted_at is null",
      );
      // The agents' ruling sits on the two addresses, so the owner's link affirms it and writes none:
      // its decision names the ruling it would stand in the place of.
      const link = await w.owner.identity.linkPeople(a as EntityId, b as EntityId, "same", { requestId: request() });
      expect(await w.admin("select ruling_id from knowledge.identity_rulings")).toEqual([
        { ruling_id: agents?.ruling_id },
      ]);
      expect(await w.admin("select details from knowledge.owner_decisions where id = $1", [link])).toEqual([
        { details: { affirms: [agents?.ruling_id], inPlaceOf: agents?.ruling_id } },
      ]);
      const asked = () =>
        w.admin("select state, settled_by from ledger.identity_questions where id = $1", [question.id]);
      const settled = await asked();
      expect(settled).toEqual([expect.objectContaining({ state: "settled" })]);
      await eraseCited(w, one);
      // The agents' ruling is lifted with the message it cited; the owner's word holds the two together.
      expect(
        await w.admin(
          "select ruling_id, verdict, a_fp, b_fp, lifted_at is not null as lifted from knowledge.identity_rulings order by lifted_at nulls first",
        ),
      ).toEqual([
        { ruling_id: link, verdict: "same", a_fp: agents?.a_fp, b_fp: agents?.b_fp, lifted: false },
        { ruling_id: agents?.ruling_id, verdict: "same", a_fp: agents?.a_fp, b_fp: agents?.b_fp, lifted: true },
      ]);
      await expect(
        w.owner.identity.linkPeople(a as EntityId, b as EntityId, "same", { requestId: request() }),
      ).rejects.toMatchObject({ code: "already_settled" });
      // The owner's word settles the pair: the question is left as it stood, not handed back to agents.
      expect(await asked()).toEqual(settled);
      // The owner may change their mind as on any pair they joined themselves: a `different` is
      // refused while their own `same` stands, and stands once they lift it.
      await expect(
        w.owner.identity.linkPeople(a as EntityId, b as EntityId, "different", { requestId: request() }),
      ).rejects.toMatchObject({ code: "conflicting_ruling" });
      expect(await w.owner.identity.liftIdentity(link, { requestId: request() })).toBe(true);
      const apart = await w.owner.identity.linkPeople(a as EntityId, b as EntityId, "different", {
        requestId: request(),
      });
      expect(
        await w.admin("select ruling_id, verdict from knowledge.identity_rulings where lifted_at is null"),
      ).toEqual([{ ruling_id: apart, verdict: "different" }]);
    });
  });

  it("known limit: a link made over a chain before the owner's own same was written with it keeps nothing of the owner's when a deletion lifts one ruling of that chain", async () => {
    await inWorld(async (w) => {
      const { a, b, one } = await agentsJoined(w);
      const [agents] = await w.admin<{ ruling_id: string; a_fp: string; b_fp: string }>(
        "select ruling_id, a_fp, b_fp from knowledge.identity_rulings where lifted_at is null",
      );
      // A third person the standing rule joined to the second: the owner links the first and the third.
      const c = await person(w, "d.vance@example.com", "D. Vance");
      const fps = async (entity: string): Promise<string> =>
        (
          await w.admin<{ fp: string }>("select min(value_fp) as fp from knowledge.accounts where entity_id = $1", [
            entity,
          ])
        )[0]?.fp as string;
      const [fa, fb, fc] = [await fps(a), await fps(b), await fps(c)];
      const rule = testId("rul");
      await w.admin(
        `insert into knowledge.owner_decisions (id, request_id, kind, answer, batch, queue_depth, details, decided_at, compartments)
         values ($1, $2, 'identity_policy', 'same', false, 0, '{"basis":"name"}', now(), '{own}')`,
        [rule, request()],
      );
      await w.admin(
        "insert into knowledge.identity_rulings (ruling_id, verdict, a_fp, b_fp, created_at) values ($1, 'same', $2, $3, now())",
        [rule, ...[fb, fc].sort()],
      );
      const link = await w.owner.identity.linkPeople(a as EntityId, c, "same", { requestId: request() });
      const named = [fa, fc].sort();
      const own = () =>
        w.admin(
          "select a_fp, b_fp, lifted_at is not null as lifted from knowledge.identity_rulings where ruling_id = $1",
          [link],
        );
      // The link named the first and the third: the owner's own `same` is on those two, and its
      // decision names no ruling it stands in the place of.
      expect(await own()).toEqual([{ a_fp: named[0], b_fp: named[1], lifted: false }]);
      expect(await w.admin("select details from knowledge.owner_decisions where id = $1", [link])).toEqual([
        { details: { affirms: [agents?.ruling_id, rule].sort() } },
      ]);
      // A link made before the owner's own `same` was written with it holds the decision alone.
      await w.admin("delete from knowledge.identity_rulings where ruling_id = $1", [link]);
      await eraseCited(w, one);
      // The agents' ruling is lifted with the message it cited. Nothing of the owner's is written
      // on its two addresses, which the owner never named, and the two the owner did name are held
      // by nothing: the link's own `same` is what holds them from this train on, and the migration
      // writes it for a link made before.
      expect(
        await w.admin("select lifted_by_deletion from knowledge.identity_rulings where ruling_id = $1", [
          agents?.ruling_id,
        ]),
      ).toEqual([{ lifted_by_deletion: true }]);
      expect(await own()).toEqual([]);
      expect(
        await w.admin("select 1 from knowledge.identity_rulings where lifted_at is null and a_fp = $1 and b_fp = $2", [
          agents?.a_fp,
          agents?.b_fp,
        ]),
      ).toEqual([]);
    });
  });

  it("a brief shows nothing of a pair under a label the agent cannot see (invariant 6)", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      await pair(w);
      await sweep(w);
      const narrow = await w.client("narrow", ["employer:example"], { tools: [...ALL_TOOLS, ...AGENT_WORK_TOOLS] });
      const question = await onlyQuestion(w);
      const seen = await w.reader
        .findFacts(narrow.token, { query: question.id, requestId: request() } as never)
        .catch(() => null);
      expect(JSON.stringify(seen)).not.toContain(question.id);
    });
  });
});

describe("a person's records are evidence, and only a name alone rests", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  const state = async (w: WorkWorld) =>
    (
      await w.admin<{ state: string; passed_code: string | null }>(
        "select state, passed_code from ledger.identity_questions",
      )
    )[0];
  const rulings = (w: WorkWorld) =>
    w.admin<{ verdict: string; by_agent: boolean }>("select verdict, by_agent from knowledge.identity_rulings");

  // One card listing both of these people, holding these fields.
  const household = async (w: WorkWorld, a: string, b: string, facts: Parameters<typeof card>[2]): Promise<void> => {
    await card(w, a, facts);
    const [row] = await w.admin<{ contact_id: string }>(
      "select contact_id from knowledge.contact_addresses where entity_id = $1 order by contact_id desc limit 1",
      [a],
    );
    await w.admin(
      "insert into knowledge.contact_addresses (contact_id, value_fp, entity_id, compartments) values ($1, $2, $3, $4)",
      [row?.contact_id, fingerprint(w.db.keys, "address", `${b.toLowerCase()}@contacts.example`), b, OWN],
    );
  };

  it("one card listing both agrees on nothing, whatever else is cited, and the refusal names the pair", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      const [a, b] = await pair(w);
      await person(w, "third@example.com", "Lee Stone");
      await sweep(w);
      const question = await onlyQuestion(w);
      await household(w, a, b, { names: [NAME], organizations: [{ name: "Northwind", title: null }] });
      const refused = ok(
        await report(
          w,
          w.scout,
          await flagOf(w),
          onRecords(question.id, "same_company", [
            { record: a, field: "company", value: "Northwind" },
            { record: b, field: "company", value: "Northwind" },
            { record: a, field: "name", value: NAME },
            { record: b, field: "name", value: NAME },
          ]),
        ),
      );
      expect(refused).toMatchObject({
        refused: ["same_person_no_evidence"],
        samePersonRefused: [{ question: question.id, code: "no_agreement" }],
      });
    });
  });

  it("a different resting only on a person's own name is refused", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      const [a] = await pair(w);
      await sweep(w);
      const question = await onlyQuestion(w);
      const held = (await w.reader.getEntity(w.scout.token, { id: a })) as {
        value?: { names?: { untrusted: string }[] };
      };
      const value = held.value?.names?.[0]?.untrusted as string;
      const done = ok(
        await report(w, w.scout, await flagOf(w), [
          {
            question: question.id,
            verdict: "different",
            because: "conflicting_place",
            sources: [{ record: a, field: "name", value }],
          },
        ]),
      );
      expect(JSON.stringify(done)).toContain("no_agreement");
      expect(await rulings(w)).toEqual([]);
    });
  });

  it("a lone different goes to a second agent and splits nobody, and two make the ruling", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      const [a, b] = await pair(w);
      const one = await wrote(w, a, "I have left the firm and moved abroad for a new post");
      await sweep(w);
      const question = await onlyQuestion(w);
      const answer = [
        {
          question: question.id,
          verdict: "different",
          because: "conflicting_place",
          sources: [{ message: one, quote: "left the firm and moved abroad" }],
        },
      ];
      ok(await report(w, w.scout, await flagOf(w), answer));
      await sweep(w);
      expect(await rulings(w)).toEqual([]);
      expect((await onlyQuestion(w)).state).toBe("agents");
      ok(await report(w, w.wide, await flagOf(w), answer));
      await sweep(w);
      expect(await rulings(w)).toEqual([{ verdict: "different", by_agent: true }]);
      void b;
    });
  });

  it("one refused answer costs only itself: the rest stand, the report lands, and a replay changes nothing", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      const [a, b] = await pair(w);
      const c = await person(w, "lee.one@example.org", "Lee Stone");
      const d = await person(w, "lee-two@example.net", "Lee Stone");
      await wrote(w, c, "A first note from the first address about the plan.");
      await wrote(w, d, "A first note from the second address about the plan.");
      await sweep(w);
      const questions = await w.admin<{ id: string; a_entity: string }>(
        "select id, a_entity from ledger.identity_questions order by id",
      );
      const ofDara = questions.find((one) => [a, b].includes(one.a_entity as EntityId))?.id as string;
      const ofLee = questions.find((one) => [c, d].includes(one.a_entity as EntityId))?.id as string;
      const answers = [
        { question: ofDara, verdict: "cant_tell", why: "no_evidence" },
        ...onRecords(ofLee, "same_company", [
          { record: c, field: "company", value: "Not On Any Record" },
          { record: d, field: "company", value: "Not On Any Record" },
        ]),
      ];
      const flag = await flagOf(w);
      ok(await w.work.claimOpportunity(w.scout.token, { id: flag, requestId: request() }));
      const { move } = ok(
        await w.work.planMove(w.scout.token, { opportunity: flag, stage: "investigate", requestId: request() }),
      );
      const send = { move, outcome: "done", report: { samePerson: answers } as never, requestId: request() } as const;
      const done = ok(await w.work.reportMove(w.scout.token, send));
      expect(done).not.toHaveProperty("refused");
      expect(done).toMatchObject({ samePersonRefused: [{ question: ofLee, code: "not_on_record" }] });
      const taken = () => w.admin<{ question_id: string }>("select question_id from ledger.identity_answers");
      expect(await taken()).toEqual([{ question_id: ofDara }]);
      const again = ok(await w.work.reportMove(w.scout.token, send));
      expect(again).toMatchObject({ samePersonRefused: [{ question: ofLee, code: "not_on_record" }] });
      expect(await taken()).toEqual([{ question_id: ofDara }]);
    });
  });

  it("a report on a lease it lost takes back every answer", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      await pair(w);
      await sweep(w);
      const { id } = await onlyQuestion(w);
      const flag = await flagOf(w);
      ok(await w.work.claimOpportunity(w.scout.token, { id: flag, requestId: request() }));
      const { move } = ok(
        await w.work.planMove(w.scout.token, { opportunity: flag, stage: "investigate", requestId: request() }),
      );
      ok(await w.work.releaseOpportunity(w.scout.token, { id: flag, reason: "no_time", requestId: request() }));
      const lost = await w.work.reportMove(w.scout.token, {
        move,
        outcome: "done",
        report: { samePerson: [{ question: id, verdict: "cant_tell", why: "no_evidence" }] } as never,
        requestId: request(),
      });
      expect(lost.ok && !("refused" in lost.value)).toBe(false);
      expect(await w.admin("select id from ledger.identity_answers")).toEqual([]);
    });
  });

  it("the dry run says how many pairs records could settle, by what agrees", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      const a = await person(w, "dara@northwind.example", NAME);
      const b = await person(w, "dv-home@example.net", NAME);
      await card(w, b, { names: [NAME], organizations: [{ name: "Northwind Capital", title: null }] });
      await person(w, "lee.one@example.org", "Lee Stone");
      await person(w, "lee-two@example.net", "Lee Stone");
      const dry = await w.owner.identity.dryRunIdentity();
      expect(dry.provable).toEqual({
        pairs: 1,
        by: { shared_address: 0, same_link: 0, same_company: 0, address_matches_company: 1 },
      });
      void a;
    });
  });

  it("a name-only pair rests, reaching neither agents nor the owner, and is counted; a card wakes it", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      const [a] = await barePair(w);
      const counted = await sweep(w);
      expect(await state(w)).toEqual({ state: "resting", passed_code: "nothing_to_read" });
      expect(counted.questions?.nothingToRead).toBe(1);
      expect(await queryAs(w.db.urls.work, "select subject from ledger.same_person_gaps()")).toEqual([]);
      expect(await openCards(w)).toEqual([]);
      const metrics = await ownerQuestions(
        w.admin,
        new Date(Date.now() - 86_400_000).toISOString(),
        new Date(Date.now() + 86_400_000).toISOString(),
        OWN,
      );
      expect(metrics[0]?.parts?.nothing_to_read).toBe(1);
      await card(w, a, { names: [NAME], organizations: [{ name: "Northwind", title: null }] });
      await sweep(w);
      expect(await state(w)).toEqual({ state: "agents", passed_code: null });
      // Nothing else written to a question moves its print.
      const [{ evidence_fp: woke } = { evidence_fp: "" }] = await w.admin<{ evidence_fp: string }>(
        "select evidence_fp from ledger.identity_questions",
      );
      await w.admin("update ledger.identity_questions set passed_code = 'already_settled'");
      await sweep(w);
      const [after] = await w.admin<{ evidence_fp: string; state: string }>(
        "select evidence_fp, state from ledger.identity_questions",
      );
      expect(after).toEqual({ evidence_fp: woke, state: "agents" });
    });
  });

  it("a resting pair no longer a candidate stays resting when a card arrives", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      const [a] = await barePair(w);
      await sweep(w);
      expect((await state(w))?.state).toBe("resting");
      await w.admin("delete from knowledge.aliases where entity_id = $1", [a]);
      await card(w, a, { names: ["Lee Stone"], organizations: [{ name: "Northwind", title: null }] });
      await sweep(w);
      expect(await state(w)).toEqual({ state: "resting", passed_code: "nothing_to_read" });
    });
  });

  it("a card a brief would not serve is nothing to read", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      const [a, b] = await barePair(w);
      await card(w, a, { names: [NAME] }, ["employer:example"]);
      const holds = await session(w.db.urls.admin, recordsRead);
      expect(holds(a, b, ["own", "employer:example"])).toBe(false);
    });
  });

  it("a person's side walks rulings only through addresses the caller's keys show", async () => {
    await inWorld(async (w) => {
      const a = await person(w, "side-a@example.org", "Side One");
      const hidden = await person(w, "side-hidden@example.org", "Side Two");
      const c = await person(w, "side-c@example.org", "Side Three");
      await w.owner.identity.linkPeople(a, hidden, "same", { requestId: testId("req").slice(4) });
      await w.owner.identity.linkPeople(hidden, c, "same", { requestId: testId("req").slice(4) });
      const members = (): Promise<string[]> =>
        session(w.db.urls.bootstrap, async (query) => {
          await query("set role pi_owner");
          const [row] = await query<{ members: string[] }>(
            "select ledger.same_person_side($1, array[policy.label_key(array['own']::text[])]) as members",
            [a],
          );
          return [...(row?.members ?? [])].sort();
        });
      expect(await members()).toEqual([a, hidden, c].sort());
      await relabel(
        w,
        "knowledge.accounts",
        "update knowledge.accounts set compartments = array['employer:example'] where entity_id = $1",
        [hidden],
      );
      expect(await members()).toEqual([a]);
    });
  });

  it("the dry run counts what saved cards hold back on its own, reads companies by meaning, and only under the pair's label", async () => {
    const held = async (
      a: string,
      b: string,
      label: string[] = OWN,
    ): Promise<{ heldByCards: number; namesakes: number }> => {
      let out = { heldByCards: 0, namesakes: 0 };
      await inWorld(async (w) => {
        const [x, y] = await barePair(w);
        await card(w, x, { names: [NAME], organizations: [{ name: a, title: null }] });
        await card(w, y, { names: [NAME] });
        await card(w, y, { names: [NAME], organizations: [{ name: b, title: null }] }, label);
        const dry = await w.owner.identity.dryRunIdentity();
        out = { heldByCards: dry.heldByCards, namesakes: dry.card.common_name };
      });
      return out;
    };
    expect(await held("Northwind", "Southwind")).toEqual({ heldByCards: 1, namesakes: 0 });
    expect(await held("Acme Inc", "Acme, Inc.")).toEqual({ heldByCards: 0, namesakes: 0 });
    expect(await held("Student", "Northwind")).toEqual({ heldByCards: 0, namesakes: 0 });
    expect(await held("Northwind", "Southwind", ["employer:example"])).toEqual({ heldByCards: 0, namesakes: 0 });
  });

  it("an erased address a ruling rests on lifts it, though the question's own people stay", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      const [a, b] = await barePair(w);
      const joined = await person(w, "dara@northwind.example", "Dee");
      await w.owner.identity.linkPeople(a, joined, "same", { requestId: testId("req").slice(4) });
      await card(w, b, { names: [NAME], organizations: [{ name: "Northwind", title: null }] });
      await sweep(w);
      const question = await onlyQuestion(w);
      const answer = onRecords(question.id, "address_matches_company", [
        { record: joined, field: "address", value: "dara@northwind.example" },
        { record: b, field: "company", value: "Northwind" },
      ]);
      ok(await report(w, w.scout, await flagOf(w), answer));
      await sweep(w);
      ok(await report(w, w.wide, await flagOf(w), answer));
      await sweep(w);
      expect((await rulings(w)).filter((one) => one.by_agent)).toEqual([{ verdict: "same", by_agent: true }]);
      const hook = ERASURE_HOOKS.find((row) => row.name === "identity");
      if (hook === undefined) throw new Error("no hook");
      // Hooks run after the removal: the address's row is already gone.
      await w.admin("delete from knowledge.accounts where entity_id = $1", [joined]);
      await session(w.db.urls.admin, (query) =>
        hook.run(
          query,
          {
            evidenceIds: [],
            refs: [],
            addressFps: [fingerprint(w.db.keys, "address", "dara@northwind.example")],
            sources: [],
            records: [],
            recordEvidenceIds: [],
          } as never,
          { dryRun: false } as never,
        ),
      );
      const lifted = await w.admin<{ lifted: boolean; deletion: boolean }>(
        "select lifted_at is not null as lifted, lifted_by_deletion as deletion from knowledge.identity_rulings where by_agent",
      );
      expect(lifted).toEqual([{ lifted: true, deletion: true }]);
      expect(await w.admin("select id from ledger.identity_answers where question_id = $1", [question.id])).toEqual([]);
      expect((await onlyQuestion(w)).state).toBe("agents");
    });
  });

  it("a card keeps saying what was tried after the answers stop counting under a new print", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      await pair(w);
      await sweep(w);
      const { id } = await onlyQuestion(w);
      const cant = [{ question: id, verdict: "cant_tell", why: "name_only" }];
      ok(await report(w, w.scout, await flagOf(w), cant));
      await sweep(w);
      ok(await report(w, w.wide, await flagOf(w), cant));
      await sweep(w);
      const [open] = await openCards(w);
      await w.admin("update ledger.identity_questions set evidence_fp = $1", ["0".repeat(40)]);
      expect(JSON.stringify(await w.owner.cards.card(open?.id as CardId))).toContain("name_only+name_only");
    });
  });

  it("a message on neither person's log, or on both, proves nothing, whichever the verdict", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      const [a, b] = await pair(w);
      const nobody = await w.seed.message(OWN, undefined, {
        text: "Nothing here about either of the two people at all",
      });
      const both = await wrote(w, a, "Addressed to both of them about the shared project plan");
      const [row] = await w.admin<{ evidence_id: string }>("select evidence_id from knowledge.messages where id = $1", [
        both,
      ]);
      await w.admin(
        `insert into knowledge.interaction_log (id, evidence_id, member_id, entity_id, direction, channel, occurred_at, compartments, readers, entity_role)
         values ($1, $2, 'm-owner', $3, 'inbound', 'email', now() - interval '10 days', $4, '{m-owner}', 'recipient')`,
        [interactionId(row?.evidence_id as string, b), row?.evidence_id, b, OWN],
      );
      await sweep(w);
      const question = await onlyQuestion(w);
      const flag = await flagOf(w);
      const different = (message: string, quote: string) => [
        { question: question.id, verdict: "different", because: "other_evidence", sources: [{ message, quote }] },
      ];
      const first = ok(await report(w, w.scout, flag, different(nobody, "about either of the two people at all")));
      expect(first).toMatchObject({ refused: ["same_person_no_evidence"] });
      const { move } = ok(
        await w.work.planMove(w.scout.token, { opportunity: flag, stage: "investigate", requestId: request() }),
      );
      expect(
        ok(
          await w.work.reportMove(w.scout.token, {
            move,
            outcome: "done",
            report: { samePerson: different(both, "both of them about the shared project plan") } as never,
            requestId: request(),
          }),
        ),
      ).toMatchObject({ refused: ["same_person_no_evidence"] });
    });
  });

  it("a brief marks a card use-only, shows at most as many as a read tool, binds its links, and all still count", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      const [a, b] = await barePair(w);
      for (const n of [1, 2, 3, 4, 5, 6])
        await card(w, a, { names: [NAME], organizations: [{ name: `Firm ${n}`, title: null }] });
      await card(w, b, {
        names: [NAME],
        organizations: [{ name: "Southwind", title: null }],
        links: [{ url: "https://linkedin.com/in/dara-vance-example" }],
      });
      await sweep(w);
      const flag = await flagOf(w);
      const claimed = ok(
        await w.work.claimOpportunity(w.scout.token, { id: flag, requestId: request() }),
      ) as unknown as {
        brief: { samePerson: { records: { a: { cards: { disclosure: string }[] }; b: { cards: unknown[] } } }[] };
      };
      const records = claimed.brief.samePerson[0]?.records;
      expect(records?.a.cards).toHaveLength(DETAIL_CONTACTS);
      expect(records?.a.cards.every((one) => one.disclosure === "use_only")).toBe(true);
      const [logged] = await w.admin<{ bound: string[]; shown: string[] }>(
        "select bound, shown from ledger.read_log where tool = 'claim_opportunity' order by read_at desc limit 1",
      );
      expect(logged?.shown.length).toBeGreaterThanOrEqual(DETAIL_CONTACTS + 1);
      expect(logged?.bound).toHaveLength(1);
    });
  });

  it("the dry run says how many pairs hold something to read and how many nothing", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      await barePair(w);
      const a = await person(w, "lee.one@example.org", "Lee Stone");
      await person(w, "lee-two@example.net", "Lee Stone");
      await wrote(w, a, "A note about the project.");
      const dry = await w.owner.identity.dryRunIdentity();
      expect(dry.records).toEqual({ toRead: 1, nothingToRead: 1 });
    });
  });

  it("a contact-only pair sharing a company and an address domain settles with two agents, and one alone does not", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      const a = await person(w, "dara@northwind.example", NAME);
      const b = await person(w, "dv-home@example.net", NAME);
      await card(w, b, { names: [NAME], organizations: [{ name: "Northwind Capital", title: null }] });
      await sweep(w);
      const question = await onlyQuestion(w);
      const answer = onRecords(question.id, "address_matches_company", [
        { record: a, field: "address", value: "dara@northwind.example" },
        { record: b, field: "company", value: "Northwind Capital" },
      ]);
      // The brief holds what the records hold.
      const flag = await flagOf(w);
      const claimed = ok(await w.work.claimOpportunity(w.scout.token, { id: flag, requestId: request() }));
      expect(JSON.stringify(claimed)).toContain("Northwind Capital");
      expect(JSON.stringify(claimed)).toContain("dara@northwind.example");
      const { move } = ok(
        await w.work.planMove(w.scout.token, { opportunity: flag, stage: "investigate", requestId: request() }),
      );
      ok(
        await w.work.reportMove(w.scout.token, {
          move,
          outcome: "done",
          report: { samePerson: answer } as never,
          requestId: request(),
        }),
      );
      await sweep(w);
      expect(await rulings(w)).toEqual([]);
      ok(await report(w, w.wide, await flagOf(w), answer));
      await sweep(w);
      expect(await rulings(w)).toEqual([{ verdict: "same", by_agent: true }]);
    });
  });

  it("a name alone is no answer as it ships; a fund's address on one, a joined person's card at that fund on the other, settles", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      const rare = "Ignatius Vellacott";
      const fund = await person(w, "ignatius@halcyonfund.example", rare);
      const record = await person(w, "iv.old@example.net", rare);
      const joined = await person(w, "iv.home@example.net", "Iggy");
      await w.owner.identity.linkPeople(record, joined, "same", { requestId: testId("req").slice(4) });
      await wrote(w, joined, "A note from the home address about the project.");
      await card(w, joined, { names: [rare], organizations: [{ name: "Halcyon Fund", title: null }] });
      await sweep(w);
      const question = await onlyQuestion(w);
      const flag = await flagOf(w);
      expect(
        ok(
          await report(
            w,
            w.scout,
            flag,
            onRecords(question.id, "rare_full_name", [
              { record: fund, field: "name", value: rare },
              { record: joined, field: "name", value: rare },
            ]),
          ),
        ),
      ).toMatchObject({ refused: ["same_person_no_evidence"] });
      const answer = onRecords(question.id, "address_matches_company", [
        { record: fund, field: "address", value: "ignatius@halcyonfund.example" },
        { record: joined, field: "company", value: "Halcyon Fund" },
      ]);
      const { move } = ok(
        await w.work.planMove(w.scout.token, { opportunity: flag, stage: "investigate", requestId: request() }),
      );
      ok(
        await w.work.reportMove(w.scout.token, {
          move,
          outcome: "done",
          report: { samePerson: answer } as never,
          requestId: request(),
        }),
      );
      await sweep(w);
      ok(await report(w, w.wide, await flagOf(w), answer));
      await sweep(w);
      expect((await rulings(w)).filter((one) => one.by_agent)).toEqual([{ verdict: "same", by_agent: true }]);
    });
  });

  it("two people with one name and different companies don't merge, and an agent may say different", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      const [a, b] = await barePair(w);
      await card(w, a, { names: [NAME], organizations: [{ name: "Northwind", title: null }] });
      await card(w, b, { names: [NAME], organizations: [{ name: "Southwind", title: null }] });
      await sweep(w);
      const question = await onlyQuestion(w);
      const flag = await flagOf(w);
      const refused = ok(
        await report(
          w,
          w.scout,
          flag,
          onRecords(question.id, "rare_full_name", [
            { record: a, field: "name", value: NAME },
            { record: b, field: "name", value: NAME },
          ]),
        ),
      );
      expect(refused).toMatchObject({ refused: ["same_person_no_evidence"] });
      const { move } = ok(
        await w.work.planMove(w.scout.token, { opportunity: flag, stage: "investigate", requestId: request() }),
      );
      ok(
        await w.work.reportMove(w.scout.token, {
          move,
          outcome: "done",
          report: {
            samePerson: [
              {
                question: question.id,
                verdict: "different",
                because: "conflicting_role_or_org",
                sources: [
                  { record: a, field: "company", value: "Northwind" },
                  { record: b, field: "company", value: "Southwind" },
                ],
              },
            ],
          } as never,
          requestId: request(),
        }),
      );
      await sweep(w);
      // One different splits nobody: a job change reads the same.
      expect(await rulings(w)).toEqual([]);
      ok(
        await report(w, w.wide, await flagOf(w), [
          {
            question: question.id,
            verdict: "different",
            because: "conflicting_role_or_org",
            sources: [
              { record: a, field: "company", value: "Northwind" },
              { record: b, field: "company", value: "Southwind" },
            ],
          },
        ]),
      );
      await sweep(w);
      expect(await rulings(w)).toEqual([{ verdict: "different", by_agent: true }]);
    });
  });

  it("a family phone and a shared name don't merge, however it is argued", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      const [a, b] = await barePair(w);
      await card(w, a, { names: [NAME], phones: [{ value: "+15550100", type: null }] });
      await card(w, b, { names: [NAME], phones: [{ value: "+15550100", type: null }] });
      await sweep(w);
      const question = await onlyQuestion(w);
      const flag = await flagOf(w);
      const byPhone = onRecords(question.id, "shared_phone", [
        { record: a, field: "phone", value: "+15550100" },
        { record: b, field: "phone", value: "+15550100" },
      ]);
      expect(ok(await report(w, w.scout, flag, byPhone))).toMatchObject({ refused: ["same_person_no_evidence"] });
      const { move } = ok(
        await w.work.planMove(w.scout.token, { opportunity: flag, stage: "investigate", requestId: request() }),
      );
      const byName = onRecords(question.id, "rare_full_name", [
        { record: a, field: "name", value: NAME },
        { record: b, field: "name", value: NAME },
      ]);
      expect(
        ok(
          await w.work.reportMove(w.scout.token, {
            move,
            outcome: "done",
            report: { samePerson: byName } as never,
            requestId: request(),
          }),
        ),
      ).toMatchObject({ refused: ["same_person_no_evidence"] });
    });
  });

  it("a name a third person carries holds back any same, counted from either side's fingerprint", async () => {
    for (const noAlias of [false, true])
      await inWorld(async (w) => {
        await agentsOn(w);
        const [a, b] = await pair(w);
        await person(w, "third@example.com", NAME);
        await sweep(w);
        const [question] = await w.admin<{ id: string }>(
          "select id from ledger.identity_questions where a_entity = any($1) and b_entity = any($1)",
          [[a, b]],
        );
        await card(w, a, { names: [NAME], organizations: [{ name: "Northwind", title: null }] });
        await card(w, b, { names: [NAME], organizations: [{ name: "Northwind", title: null }] });
        const flag = await flagOf(w);
        // A card with two addresses makes no alias: the name is on the other side's alone.
        if (noAlias) await w.admin("delete from knowledge.aliases where entity_id = $1", [a]);
        const refused = ok(
          await report(
            w,
            w.scout,
            flag,
            onRecords(question?.id as string, "same_company", [
              { record: a, field: "company", value: "Northwind" },
              { record: b, field: "company", value: "Northwind" },
            ]),
          ),
        );
        expect(refused).toMatchObject({ refused: ["same_person_no_evidence"] });
      });
  });

  it("a shared name neither side has a fingerprint for can't be counted, and is refused", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      const [a, b] = await pair(w);
      await person(w, "third@example.com", NAME);
      await sweep(w);
      const [question] = await w.admin<{ id: string }>(
        "select id from ledger.identity_questions where a_entity = any($1) and b_entity = any($1)",
        [[a, b]],
      );
      await card(w, a, { names: [NAME], organizations: [{ name: "Northwind", title: null }] });
      await card(w, b, { names: [NAME], organizations: [{ name: "Northwind", title: null }] });
      const flag = await flagOf(w);
      await w.admin("delete from knowledge.aliases");
      const refused = ok(
        await report(
          w,
          w.scout,
          flag,
          onRecords(question?.id as string, "same_company", [
            { record: a, field: "company", value: "Northwind" },
            { record: b, field: "company", value: "Northwind" },
          ]),
        ),
      );
      expect(refused).toMatchObject({ refused: ["same_person_no_evidence"] });
    });
  });

  it("one line holds back a father and son at one firm, whether cited from records or from mail", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      const [a, b] = await pair(w);
      const one = await wrote(w, a, "Dara Vance here, writing from my new work address now");
      const two = await wrote(w, b, "Please use my new address from today on.");
      const facts = {
        names: [NAME],
        phones: [{ value: "+15550100", type: null }],
        organizations: [{ name: "Smith Plumbing", title: null }],
      };
      await card(w, a, facts);
      await card(w, b, facts);
      await sweep(w);
      const question = await onlyQuestion(w);
      const flag = await flagOf(w);
      expect(
        ok(
          await report(
            w,
            w.scout,
            flag,
            onRecords(question.id, "same_company", [
              { record: a, field: "company", value: "Smith Plumbing" },
              { record: b, field: "company", value: "Smith Plumbing" },
            ]),
          ),
        ),
      ).toMatchObject({ refused: ["same_person_no_evidence"] });
      const { move } = ok(
        await w.work.planMove(w.scout.token, { opportunity: flag, stage: "investigate", requestId: request() }),
      );
      expect(
        ok(
          await w.work.reportMove(w.scout.token, {
            move,
            outcome: "done",
            report: { samePerson: [SAME(question.id, one, two)] } as never,
            requestId: request(),
          }),
        ),
      ).toMatchObject({ refused: ["same_person_no_evidence"] });
    });
  });

  it("a cite outside the label is refused", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      const [a, b] = await pair(w);
      await card(w, b, { names: [NAME], organizations: [{ name: "Northwind", title: null }] });
      await sweep(w);
      const question = await onlyQuestion(w);
      // A card under a label wider than the question's holds the one company that would agree.
      await card(w, a, { names: [NAME], organizations: [{ name: "Northwind", title: null }] }, ["employer:example"]);
      const refused = ok(
        await report(
          w,
          w.scout,
          await flagOf(w),
          onRecords(question.id, "same_company", [
            { record: a, field: "company", value: "Northwind" },
            { record: b, field: "company", value: "Northwind" },
          ]),
        ),
      );
      expect(refused).toMatchObject({ refused: ["same_person_no_evidence"] });
    });
  });

  it("a can't-tell under the old print doesn't stick: the same agent is asked again and can say same", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      const a = await person(w, "dara@northwind.example", NAME);
      const b = await person(w, "dv-home@example.net", NAME);
      await card(w, b, { names: [NAME], organizations: [{ name: "Northwind Capital", title: null }] });
      await sweep(w);
      const question = await onlyQuestion(w);
      const cant = [{ question: question.id, verdict: "cant_tell", why: "name_only" }];
      ok(await report(w, w.scout, await flagOf(w), cant));
      await sweep(w);
      ok(await report(w, w.wide, await flagOf(w), cant));
      await sweep(w);
      expect((await state(w))?.state).toBe("owner");
      expect(await openCards(w)).toHaveLength(1);
      // As they stood before this shipped: on the bare print, a pair at the owner and no card holding it.
      const fps = await w.admin<{ value_fp: string }>(
        "select value_fp from knowledge.aliases where entity_id = any($1) union select value_fp from knowledge.accounts where entity_id = any($1)",
        [[a, b]],
      );
      const bare = createHash("sha256")
        .update(
          fps
            .map((one) => one.value_fp)
            .sort()
            .join(" "),
          "utf8",
        )
        .digest("hex")
        .slice(0, 40);
      const [open] = await openCards(w);
      await decide(w, open?.id as CardId, "leave");
      await w.claims("update ledger.identity_answers set evidence_fp = $1", [bare]);
      await w.admin(
        "update ledger.identity_questions set evidence_fp = $1, state = 'owner', card_id = null, passed_code = null",
        [bare],
      );
      await sweep(w);
      expect((await state(w))?.state).toBe("agents");
      expect(await w.admin("select id from ledger.identity_answers")).toHaveLength(2);
      const answer = onRecords(question.id, "address_matches_company", [
        { record: a, field: "address", value: "dara@northwind.example" },
        { record: b, field: "company", value: "Northwind Capital" },
      ]);
      ok(await report(w, w.scout, await flagOf(w), answer));
      await sweep(w);
      ok(await report(w, w.wide, await flagOf(w), answer));
      await sweep(w);
      expect((await rulings(w)).filter((one) => one.by_agent)).toEqual([{ verdict: "same", by_agent: true }]);
    });
  });

  it("a pair on an open card stays as it is", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      await pair(w);
      await offeredOut(w);
      expect((await openCards(w)).map((one) => one.kind)).toEqual(["same_person_batch"]);
      await relabel(w, "knowledge.messages", "update knowledge.messages set compartments = array['agent:wide']");
      await sweep(w);
      expect(await openCards(w)).toHaveLength(1);
      expect((await state(w))?.state).toBe("owner");
    });
  });

  it("a batch left with nothing to read closes with no offer counted", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      await pair(w);
      await sweep(w);
      await flagOf(w);
      await relabel(w, "knowledge.messages", "update knowledge.messages set compartments = array['agent:wide']");
      await sweep(w);
      const [row] = await w.admin<{ state: string; batch: string | null; offers: number }>(
        "select state, batch, offers from ledger.identity_questions",
      );
      expect(row).toEqual({ state: "resting", batch: null, offers: 0 });
    });
  });
});

describe("what the owner answers alike becomes a rule the owner confirms", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("proposes after the answers agree, holds nothing until the owner confirms, then holds that kind back and counts it", async () => {
    await inWorld(async (w) => {
      // Ten about_you cards of one type, each rejected.
      const claims: string[] = [];
      for (let i = 0; i < 11; i += 1) {
        const message = await w.message(OWN);
        const claim = await w.seed.claim(OWN, message.evidence);
        await w.claims("update knowledge.claims set type = 'situation' where id = $1", [claim]);
        claims.push(claim);
      }
      const raise = async (claim: string | undefined) => {
        const id = testId("crd");
        await w.admin(
          `insert into ledger.cards (id, request_id, created_at, created_by, kind, target_kind, target_id, options, expires_after_days, compartments)
           values ($1, $2, now(), 'system:extract', 'about_you', 'claim', $3, array['confirm', 'reject'], 30, $4)`,
          [id, id.slice(4), claim, OWN],
        );
        await w.admin(
          "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'pending', now(), 'system:extract', $2)",
          [id, OWN],
        );
        return id as CardId;
      };
      for (const claim of claims.slice(0, 10)) await decide(w, await raise(claim), "reject");
      const proposed = await asWork(w, (query) => proposeQuestionRules(query, new Date()));
      expect(proposed).toBe(1);
      const [rule] = await w.admin<{ id: string; status: string; card_id: CardId; pattern: string }>(
        "select id, status, card_id, pattern from ledger.question_rules",
      );
      expect(rule).toMatchObject({ status: "proposed", pattern: "about_you:situation" });
      // Asked once.
      expect(await asWork(w, (query) => proposeQuestionRules(query, new Date()))).toBe(0);
      const [stopBefore] = await queryAs<{ stop: string | null }>(
        w.db.urls.pipeline,
        "select ledger.card_rule_stop('about_you', 'claim', $1, array['own']) as stop",
        [claims[10]],
      );
      expect(stopBefore?.stop).toBeNull();
      await decide(w, rule?.card_id as CardId, "confirm");
      const [stopAfter] = await queryAs<{ stop: string | null }>(
        w.db.urls.pipeline,
        "select ledger.card_rule_stop('about_you', 'claim', $1, array['own']) as stop",
        [claims[10]],
      );
      expect(stopAfter?.stop).toBe(rule?.id);
      // In force: the pipeline's next card of that kind is on record, withdrawn at once, never pending.
      const raised = await asPipeline(w, (query) =>
        raiseCard(
          query,
          {
            id: testId("crd"),
            requestId: testId("req").slice(4),
            kind: "about_you",
            author: "system:extract",
            options: ["confirm", "reject"],
            target: { kind: "claim", id: claims[10] },
            refs: [],
            compartments: OWN,
            expiresAt: null,
            expiresAfterDays: 30,
            caseKey: null,
            run: null,
            body: null,
            bodyFrom: null,
          } as unknown as NewCard,
          { now: new Date() },
        ),
      );
      expect(raised.state).toBe("withdrawn");
      // Lifted, it holds nothing, and is never proposed again.
      const lift = await w.owner.identity.liftQuestionRule(rule?.id as string);
      expect(lift).toEqual({ lifted: true, stopped: [raised.id] });
      // Not raised again by the lift, and reopened by the owner's word alone.
      await w.owner.cards.reopenExpiredCard(raised.id);
      const [back] = await w.admin<{ event: string }>(
        "select event from ledger.record_events where row_kind = 'card' and row_id = $1 order by id desc limit 1",
        [raised.id],
      );
      expect(back?.event).toBe("pending");
      expect(await asWork(w, (query) => proposeQuestionRules(query, new Date()))).toBe(0);
    });
  });

  it("a rule-stopped opportunity closes on record, is counted, and comes back with its card", async () => {
    await inWorld(async (w) => {
      await queryAs(
        w.db.urls.work,
        "select ledger.propose_question_rule($1, 'opportunity_decision', 'opportunity_decision:follow_up', 'no_go', 10, null, now(), $2)",
        [`qrl_${testId("x").slice(-26)}`, OWN],
      );
      await w.admin("update ledger.question_rules set status = 'confirmed', decided_at = now()");
      const id = (await w.seed.into("ledger.opportunities")(OWN)) as OpportunityId;
      await w.status("opportunity", id, "proposed");
      const call = {
        point: "opportunity_go",
        version: 1,
        definitionHash: DECISION_POINT_PINS["opportunity_go@1"] ?? "",
        rung: 4,
        inputHash: sha256Hex("opportunity_go:escalated"),
        output: null,
        effect: null,
        effectClass: null,
        escalated: true,
      } as never;
      const card = await asWork(w, (query) => raiseDecisionCard(query, id, call, new Date()));
      expect(card).not.toBeNull();
      const latest = (rowKind: string, rowId: string) =>
        w.admin<{ event: string; code: string | null }>(
          "select event, code from ledger.record_events where row_kind = $1 and row_id = $2 order by id desc limit 1",
          [rowKind, rowId],
        );
      expect((await latest("opportunity", id))[0]).toEqual({ event: "no_go", code: "rule_stopped" });
      expect((await latest("card", card as string))[0]).toEqual({ event: "withdrawn", code: "rule_stopped" });
      // Not stuck: it is not there to decide again.
      const again = await asWork(w, (query) => proposedOpportunities(query, new Date(), id));
      expect(again).toEqual([]);
      const metrics = await ownerQuestions(
        w.admin,
        new Date(Date.now() - 86_400_000).toISOString(),
        new Date(Date.now() + 86_400_000).toISOString(),
        OWN,
      );
      expect(metrics[0]?.parts?.stopped_by_rule).toBe(1);
      await w.owner.cards.reopenExpiredCard(card as CardId);
      expect((await latest("opportunity", id))[0]?.event).toBe("proposed");
      expect((await latest("card", card as string))[0]?.event).toBe("pending");
    });
  });

  it("a rule holds only within its label", async () => {
    await inWorld(async (w) => {
      await queryAs(
        w.db.urls.work,
        "select ledger.propose_question_rule($1, 'about_you', 'about_you:situation', 'reject', 10, null, now(), $2)",
        [`qrl_${testId("x").slice(-26)}`, OWN],
      );
      await w.admin("update ledger.question_rules set status = 'confirmed', decided_at = now()");
      const message = await w.message(OWN);
      const claim = await w.seed.claim(OWN, message.evidence);
      await w.claims("update knowledge.claims set type = 'situation' where id = $1", [claim]);
      const stop = async (label: string[]) =>
        (
          await queryAs<{ stop: string | null }>(
            w.db.urls.pipeline,
            "select ledger.card_rule_stop('about_you', 'claim', $1, $2) as stop",
            [claim, label],
          )
        )[0]?.stop;
      expect(await stop(OWN)).not.toBeNull();
      expect(await stop(["employer:example"])).toBeNull();
    });
  });

  it("a press across many cards, an answer since replaced and a pair with the switch off count for nothing; an expired proposal is asked again", async () => {
    await inWorld(async (w) => {
      const decideClaims = async (n: number, batch: boolean): Promise<void> => {
        const cards: CardId[] = [];
        for (let i = 0; i < n; i += 1) {
          const message = await w.message(OWN);
          const claim = await w.seed.claim(OWN, message.evidence);
          await w.claims("update knowledge.claims set type = 'situation' where id = $1", [claim]);
          const id = testId("crd");
          await w.admin(
            `insert into ledger.cards (id, request_id, created_at, created_by, kind, target_kind, target_id, options, expires_after_days, compartments)
             values ($1, $2, now(), 'system:extract', 'about_you', 'claim', $3, array['confirm', 'reject'], 30, $4)`,
            [id, id.slice(4), claim, OWN],
          );
          await w.admin(
            "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'pending', now(), 'system:extract', $2)",
            [id, OWN],
          );
          cards.push(id as CardId);
        }
        if (batch) await w.owner.cards.decide({ cards, answer: "reject", requestId: testId("req").slice(4) });
        else for (const card of cards) await decide(w, card, "reject");
      };
      await decideClaims(12, true);
      expect(await asWork(w, (query) => proposeQuestionRules(query, new Date()))).toBe(0);
      await decideClaims(10, false);
      expect(await asWork(w, (query) => proposeQuestionRules(query, new Date()))).toBe(1);
      const [rule] = await w.admin<{ card_id: string }>("select card_id from ledger.question_rules");
      // Still waiting: not asked twice. Its card expired unanswered: asked again, on the same row.
      expect(await asWork(w, (query) => proposeQuestionRules(query, new Date()))).toBe(0);
      await queryAs(
        w.db.urls.work,
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'expired', now(), 'system:card_expiry', $2)",
        [rule?.card_id, OWN],
      );
      expect(await asWork(w, (query) => proposeQuestionRules(query, new Date()))).toBe(1);
      const rows = await w.admin<{ status: string; card_id: string }>(
        "select status, card_id from ledger.question_rules",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.card_id).not.toBe(rule?.card_id);
    });
  });

  it("the owner's all_same writes a ruling of the owner's own per pair, each liftable alone", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      await pair(w);
      await offeredOut(w);
      const [card] = await openCards(w);
      await decide(w, card?.id as CardId, "all_same");
      const [row] = await w.admin<{ kind: string; verdict: string; by_agent: boolean }>(
        `select d.kind, r.verdict, r.by_agent from knowledge.identity_rulings r join knowledge.owner_decisions d on d.id = r.ruling_id`,
      );
      expect(row).toEqual({ kind: "identity", verdict: "same", by_agent: false });
      expect((await onlyQuestion(w)).state).toBe("settled");
    });
  });

  it("the owner's all_different hitting a join says so on the result, and the rest of the answer stands", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      const [a, b] = await pair(w);
      await offeredOut(w);
      const [card] = await openCards(w);
      await w.owner.identity.linkPeople(a, b, "same", { requestId: testId("req").slice(4) });
      const result = await decide(w, card?.id as CardId, "all_different");
      expect(result[0]?.passedOver).toBe(1);
      expect((await onlyQuestion(w)).state).toBe("resting");
    });
  });

  it("outcomes counts questions by kind and what the owner overturned", async () => {
    await inWorld(async (w) => {
      await agentsOn(w);
      await pair(w);
      await w.writer.proposeIdentity(new Date());
      const metrics = await ownerQuestions(
        w.admin,
        new Date(Date.now() - 30 * 86_400_000).toISOString(),
        new Date().toISOString(),
        OWN,
      );
      expect(metrics.map((one) => one.metric)).toEqual([
        "owner_questions_per_week",
        "owner_questions_attempted",
        "questions_paid_share",
        "bets_used_share",
        "agent_settled_precision",
        "settled_without_owner_overturned",
      ]);
    });
  });
});
