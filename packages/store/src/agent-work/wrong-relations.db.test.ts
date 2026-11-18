import type { RequestId } from "@intelligence/contracts/personal";
import { minimumCloses } from "@intelligence/personal-core/planner";
import { relationRules } from "@intelligence/personal-core/views";
import { describe, expect, it } from "vitest";
import type { Query } from "../core/db.ts";
import { runSwitchPass } from "../pipeline/relation-switch.ts";
import { type OwnerWorld, withOwnerWorld } from "../test-support/card-task-world.ts";
import { ALL_TOOLS, sha256Hex, testId } from "../test-support/clients.ts";
import { queryAs } from "../test-support/database.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { log } from "../test-support/unit.ts";
import { AGENT_WORK_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { workAgent } from "../test-support/work-test-tasks.ts";
import { ok } from "../test-support/work-test-world.ts";

// Made-up values only.

const OWN = ["own"];
const WORK = ["employer:example"];
const WIDE = ["employer:example", "own"];
const KEYS = ["own", "employer:example", "agent:scout"];
const JUDGE = "model:test/judge@personal_claim_relations@1";
const CHECKER = "model:test/checker@source_check@1";
const request = (): RequestId => testId("req").slice(4) as RequestId;

type World = OwnerWorld & { scout: WorkClient; wide: WorkClient };
type Relation = { id: string; kind: string; from: string; to: string };

const agent = (w: OwnerWorld, name: string, compartments: string[]): Promise<WorkClient> =>
  workAgent(w, name, compartments, {
    tools: [...ALL_TOOLS, ...AGENT_WORK_TOOLS, "record", "report_wrong_relation"],
    kinds: ["research"],
  });

const inWorld = (fn: (w: World) => Promise<void>, agents: "on" | "off" = "on"): Promise<void> =>
  withOwnerWorld(KEYS, "wrong-relations", async (base) => {
    const scout = await agent(base, "scout", WIDE);
    const wide = await agent(base, "wide", WIDE);
    await base.owner.identity.setIdentityAgents(agents);
    // The owner's second model, so a kind on by each finding's check stays on (linesLive).
    await base.admin("insert into policy.dream_models (role, model) values ('check', 'test/checker')");
    await fn({ ...base, scout, wide });
  });

const pipeline = <Row>(w: OwnerWorld, text: string, values: unknown[] = []) =>
  queryAs<Row>(w.db.urls.pipeline, text, values);

// A model's relation between two claims under `label`, as the dream pass leaves one: its census check
// by the second model held (`checked`), and its kind's switch on (`on`).
async function relation(
  w: OwnerWorld,
  label: string[] = OWN,
  options: { kind?: string; checked?: boolean; on?: boolean } = {},
): Promise<Relation> {
  const kind = options.kind ?? "same_fact";
  const [from, to] = [await w.seed.claimValue(label), await w.seed.claimValue(label)];
  const [row] = await pipeline<{ id: string }>(
    w,
    `insert into knowledge.claim_relations (from_claim_key, to_claim_key, kind, judged_by, version, compartments)
     values ($1, $2, $3, $4, 1, $5) returning id::text as id`,
    [from, to, kind, JUDGE, label],
  );
  if (row === undefined) throw new Error("no relation");
  const made = { id: row.id, kind, from, to };
  if (options.checked !== false) await check(w, made, label, "supported");
  if (options.on !== false)
    await pipeline(
      w,
      "insert into policy.relation_switches (kind, judge, switched_on, decided_by) values ($1, $2, true, 'system')",
      [kind, JUDGE],
    );
  return made;
}

// The second model's check of a relation, live and on its cited passages.
const check = (w: OwnerWorld, r: Relation, label: string[], verdict: "supported" | "unsupported") =>
  pipeline(
    w,
    `insert into ledger.source_checks (target, kind, target_key, relation_id, relation_judge, judge, verdict, on_cited, claim_keys, compartments, census, live)
     values ('relation', $1, $2, $3::bigint, $4, $5, $6, true, $7::text[], $8::text[], true, true)`,
    [r.kind, sha256Hex(`check ${testId("x")}`), r.id, JUDGE, CHECKER, verdict, [r.from, r.to], label],
  );

// The agents' reports count against a kind only from this many of its relations in effect: the
// sample at which one overturn alone no longer passes the bound (minimumCloses).
const SAMPLE = minimumCloses(relationRules().switch.overturnRateMax);

// `n` more same_fact relations of the judge in effect, each with its held check, none reported:
// the rest of the kind's sample. Each joins two of a few stored claims, one pair each.
async function inEffect(w: OwnerWorld, n: number): Promise<void> {
  const keys: string[] = [];
  while ((keys.length * (keys.length - 1)) / 2 < n) keys.push(await w.seed.claimValue(OWN));
  await pipeline(
    w,
    `with pairs as (
       select a.key as from_key, b.key as to_key from unnest($2::text[]) with ordinality as a (key, i)
       join unnest($2::text[]) with ordinality as b (key, j) on a.i < b.j
       order by a.i, b.j limit $3),
     made as (
       insert into knowledge.claim_relations (from_claim_key, to_claim_key, kind, judged_by, version, compartments)
       select p.from_key, p.to_key, 'same_fact', $1, 1, '{own}' from pairs p
       returning id, from_claim_key, to_claim_key)
     insert into ledger.source_checks (target, kind, target_key, relation_id, relation_judge, judge, verdict, on_cited, claim_keys, compartments, census, live)
     select 'relation', 'same_fact', encode(sha256(convert_to('check ' || m.id, 'UTF8')), 'hex'), m.id, $1, $4, 'supported', true,
       array[m.from_claim_key, m.to_claim_key], '{own}', true, true
     from made m`,
    [JUDGE, keys, n, CHECKER],
  );
}

// What the owner said on the relation's audit card, as the card's effect writes it.
const ownerAnswer = (w: OwnerWorld, r: Relation, verdict: "supported" | "wrong") =>
  w.admin(
    `insert into ledger.source_checks (target, kind, target_key, relation_id, relation_judge, judge, verdict, claim_keys, compartments, live)
     values ('relation', $1, $2, $3::bigint, $4, $5, $6, $7::text[], '{own}', true)`,
    [r.kind, "d".repeat(64), r.id, JUDGE, `owner:${testId("rul")}`, verdict, [r.from, r.to]],
  );

const say = (w: World, client: WorkClient, relationId: string, cites: string[], because = "not_same_fact") =>
  w.work.reportWrongRelation(client.token, {
    relation: relationId,
    because: because as never,
    cites: cites as never,
    requestId: request(),
  });

const reports = (w: OwnerWorld) =>
  w.admin<{ relation_id: string; compartments: string[]; because: string }>(
    "select relation_id::text, compartments, because from ledger.relation_reports order by created_at, id",
  );

// The switch job's latest row for same_fact under the judge, after one pass as the Pipeline.
// A row the job did not write (its state unchanged) is the one `relation` wrote, with no code.
async function switchAfterPass(w: OwnerWorld): Promise<{ on: boolean; code: string | null }> {
  const query: Query = async <Row>(text: string, values?: unknown[]) => queryAs<Row>(w.db.urls.pipeline, text, values);
  await runSwitchPass(query, JUDGE, log);
  const [row] = await w.admin<{ on: boolean; code: string | null }>(
    `select switched_on as on, measures ->> 'code' as code from policy.relation_switches
     where kind = 'same_fact' and judge = $1 order by decided_at desc, id desc limit 1`,
    [JUDGE],
  );
  return row ?? { on: false, code: null };
}

describe("wrong relations", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("a relation the caller cannot see, one not in effect, one whose kind is off, and a hidden cite are each not_found, as an absent id is", async () => {
    await inWorld(async (w) => {
      const visible = await relation(w);
      const cite = await w.seed.message(OWN);
      // The positive control: a caller cleared for it files it.
      expect(ok(await say(w, w.scout, visible.id, [cite]))).toMatchObject({ state: "filed" });
      const narrow = await agent(w, "narrow", WORK);
      const absent = await say(w, narrow, "999999999999", [cite]);
      expect(absent).toEqual({ ok: false, code: "not_found" });
      expect(await say(w, narrow, visible.id, [cite])).toEqual(absent);
      // Unchecked, so not in effect; and checked under a kind switched off.
      const unchecked = await relation(w, OWN, { checked: false });
      expect(await say(w, w.wide, unchecked.id, [cite])).toEqual(absent);
      const off = await relation(w, OWN, { kind: "contradicts", on: false });
      expect(await say(w, w.wide, off.id, [cite])).toEqual(absent);
      // A message the caller cannot read.
      const elsewhere = await w.seed.message(["agent:scout"]);
      expect(await say(w, w.wide, visible.id, [elsewhere])).toEqual(absent);
      expect((await reports(w)).map((one) => one.relation_id)).toEqual([visible.id]);
    });
  });

  it("the owner's relation on the pair or answer on its audit card is owner_ruled; no cite is no_evidence; a second report is already_reported", async () => {
    await inWorld(async (w) => {
      const cite = await w.seed.message(OWN);
      const ruled = await relation(w);
      await w.admin(
        `insert into knowledge.claim_relations (from_claim_key, to_claim_key, kind, judged_by, version, compartments)
         values ($1, $2, 'refines', $3, 1, '{own}')`,
        [ruled.to, ruled.from, `owner:${testId("rul")}`],
      );
      expect(ok(await say(w, w.scout, ruled.id, [cite]))).toEqual({ refused: "owner_ruled" });
      const answered = await relation(w);
      await ownerAnswer(w, answered, "wrong");
      expect(ok(await say(w, w.scout, answered.id, [cite]))).toEqual({ refused: "owner_ruled" });
      const open = await relation(w);
      expect(ok(await say(w, w.scout, open.id, []))).toEqual({ refused: "no_evidence" });
      expect(ok(await say(w, w.scout, open.id, [cite]))).toMatchObject({ state: "filed" });
      expect(ok(await say(w, w.scout, open.id, [cite], "source_misread"))).toEqual({ refused: "already_reported" });
      expect((await reports(w)).map((one) => one.relation_id)).toEqual([open.id]);
    });
  });

  it("with agents off every report is agents_off and nothing is written", async () => {
    await inWorld(async (w) => {
      const r = await relation(w);
      const cite = await w.seed.message(OWN);
      expect(ok(await say(w, w.scout, r.id, [cite]))).toEqual({ refused: "agents_off" });
      expect(await reports(w)).toEqual([]);
    }, "off");
  });

  it("a report takes the union of the relation's label and its cites', lifts nothing, and writes no ruling", async () => {
    await inWorld(async (w) => {
      const r = await relation(w);
      const decisions = await w.admin("select id from knowledge.owner_decisions order by id");
      const cite = await w.seed.message(WORK);
      expect(ok(await say(w, w.scout, r.id, [cite]))).toMatchObject({ state: "filed" });
      expect(await reports(w)).toEqual([{ relation_id: r.id, compartments: WIDE, because: "not_same_fact" }]);
      // The relation stands in effect, and no decision is written.
      expect(
        await w.admin(
          "select policy.relation_effective(r.id, r.judged_by, r.kind, r.judged_at, now()) as effective from knowledge.claim_relations r where r.id = $1::bigint",
          [r.id],
        ),
      ).toEqual([{ effective: true }]);
      expect(await w.admin("select id from knowledge.owner_decisions order by id")).toEqual(decisions);
    });
  });

  it("two agreeing agents count against the kind from its sample of relations in effect; one agent alone, or two under different labels, never", async () => {
    await inWorld(async (w) => {
      const [a, b] = [await relation(w), await relation(w)];
      const [own, work] = [await w.seed.message(OWN), await w.seed.message(WORK)];
      await inEffect(w, SAMPLE - 2);
      for (const r of [a, b]) expect(ok(await say(w, w.scout, r.id, [own]))).toMatchObject({ state: "filed" });
      // One agent alone: the kind holds.
      expect(await switchAfterPass(w)).toEqual({ on: true, code: null });
      // A second agent under a wider label does not agree with the first.
      const third = await agent(w, "third", WIDE);
      for (const r of [a, b]) expect(ok(await say(w, third, r.id, [work]))).toMatchObject({ state: "filed" });
      expect(await switchAfterPass(w)).toEqual({ on: true, code: null });
      // A second under the same label agrees on both, and the kind goes off by its overturn bound.
      for (const r of [a, b]) expect(ok(await say(w, w.wide, r.id, [own]))).toMatchObject({ state: "agreed" });
      expect(await switchAfterPass(w)).toEqual({ on: false, code: "overturn_bound" });
    });
  });

  it("below the sample, agreeing agents turn no kind off; the owner's own overturn does from one case", async () => {
    await inWorld(async (w) => {
      const [a, b] = [await relation(w), await relation(w)];
      const own = await w.seed.message(OWN);
      for (const client of [w.scout, w.wide]) for (const r of [a, b]) ok(await say(w, client, r.id, [own]));
      // Every relation of the kind found wrong by two agents, and still under the sample.
      expect(await switchAfterPass(w)).toEqual({ on: true, code: null });
      // The owner's later relation of another kind on one pair overturns it.
      await w.admin(
        `insert into knowledge.claim_relations (from_claim_key, to_claim_key, kind, judged_by, version, compartments)
         values ($1, $2, 'refines', $3, 1, '{own}')`,
        [a.from, a.to, `owner:${testId("rul")}`],
      );
      expect(await switchAfterPass(w)).toEqual({ on: false, code: "overturn_bound" });
    });
  });

  it("one report and a later check by the second model that did not hold turn the kind off, where the report alone did not", async () => {
    await inWorld(async (w) => {
      const [a, b] = [await relation(w), await relation(w)];
      const cite = await w.seed.message(OWN);
      await inEffect(w, SAMPLE - 2);
      for (const r of [a, b]) expect(ok(await say(w, w.scout, r.id, [cite]))).toMatchObject({ state: "filed" });
      expect(await switchAfterPass(w)).toEqual({ on: true, code: null });
      for (const r of [a, b]) await check(w, r, OWN, "unsupported");
      expect(await switchAfterPass(w)).toEqual({ on: false, code: "overturn_bound" });
    });
  });

  it("the owner's right on the relation's audit card cancels the agents' count", async () => {
    await inWorld(async (w) => {
      const [a, b] = [await relation(w), await relation(w)];
      const cite = await w.seed.message(OWN);
      await inEffect(w, SAMPLE - 2);
      for (const client of [w.scout, w.wide]) for (const r of [a, b]) ok(await say(w, client, r.id, [cite]));
      // Two of the sample overturned would pass the bound; the owner's right on one leaves one.
      await ownerAnswer(w, a, "supported");
      expect(await switchAfterPass(w)).toEqual({ on: true, code: null });
    });
  });

  it("a claim's last value row going takes the reports of its relations", async () => {
    await inWorld(async (w) => {
      const r = await relation(w);
      const kept = await relation(w);
      const cite = await w.seed.message(OWN);
      ok(await say(w, w.scout, r.id, [cite]));
      ok(await say(w, w.scout, kept.id, [cite]));
      await w.admin("delete from knowledge.claim_values where claim_key = $1", [r.from]);
      expect((await reports(w)).map((one) => one.relation_id)).toEqual([kept.id]);
    });
  });
});
