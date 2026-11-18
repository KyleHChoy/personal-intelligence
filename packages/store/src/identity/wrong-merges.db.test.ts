import type { EntityId, RequestId } from "@intelligence/contracts/personal";
import {
  groupKey,
  isoWeek,
  MERGE_AUDIT_DAYS,
  MERGE_AUDIT_SAMPLE,
  partitionKey,
  weekSample,
} from "@intelligence/personal-core/planner";
import { describe, expect, it } from "vitest";
import { mergeAudits } from "../admin/outcomes/admin-outcomes-merges.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { sealUnder } from "../core/seal.ts";
import { asRole, type OwnerWorld, withOwnerWorld } from "../test-support/card-task-world.ts";
import { ALL_TOOLS, testId } from "../test-support/clients.ts";
import { queryAs } from "../test-support/database.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { interactionId } from "../test-support/values.ts";
import { AGENT_WORK_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { workAgent } from "../test-support/work-test-tasks.ts";
import { ok, type WorkWorld } from "../test-support/work-test-world.ts";
import { expireSourceItem, removeSourceItem, SCRUB_ON_SOURCE_DELETION } from "../write/writer-item-removal.ts";
import { removeForGood } from "../write/writer-removal.ts";
import { eraseFromWrongMerges, settleWrongMerges } from "./wrong-merges.ts";

// Made-up values on reserved domains only.

const OWN = ["own"];
const WORK = ["employer:example"];
const KEYS = ["own", "employer:example", "agent:scout"];
const request = (): RequestId => testId("req").slice(4) as RequestId;

type World = OwnerWorld & { scout: WorkClient; wide: WorkClient };

const agent = (w: WorkWorld, name: string, compartments: string[]): Promise<WorkClient> =>
  workAgent(w, name, compartments, {
    tools: [...ALL_TOOLS, ...AGENT_WORK_TOOLS, "record", "report_wrong_merge"],
    kinds: ["research"],
  });

const inWorld = (fn: (w: World) => Promise<void>, agents: "on" | "off" = "on"): Promise<void> =>
  withOwnerWorld(KEYS, "wrong-merges", async (base) => {
    const scout = await agent(base, "scout", [...OWN, ...WORK]);
    const wide = await agent(base, "wide", [...OWN, ...WORK]);
    await base.owner.identity.setIdentityAgents(agents);
    await fn({ ...base, scout, wide });
  });

// An address of a person's, under a label.
async function address(w: WorkWorld, entity: string, value: string, label: string[] = OWN): Promise<void> {
  const account = testId("adr");
  await w.admin(
    "insert into knowledge.accounts (id, entity_id, kind, value_fp, domain_fp, value_enc, compartments) values ($1, $2, 'email', $3, $4, $5, $6)",
    [
      account,
      entity,
      fingerprint(w.db.keys, "address", value),
      fingerprint(w.db.keys, "domain", value.slice(value.indexOf("@") + 1)),
      JSON.stringify(
        sealUnder(w.db.keys, label, { table: "knowledge.accounts", id: account, column: "value_enc" }, value),
      ),
      label,
    ],
  );
}

async function person(w: WorkWorld, value: string, label: string[] = OWN): Promise<EntityId> {
  const id = testId("ent");
  await w.admin("insert into knowledge.entities (id, kind) values ($1, 'person')", [id]);
  await address(w, id, value, label);
  return id as EntityId;
}

// A message on a person's interaction log.
async function wrote(w: WorkWorld, entity: string, label: string[] = OWN): Promise<string> {
  const id = await w.seed.message(label, undefined, { text: "A note about the project from this address." });
  const [row] = await w.admin<{ evidence_id: string }>("select evidence_id from knowledge.messages where id = $1", [
    id,
  ]);
  if (row === undefined) throw new Error("no message");
  await w.admin(
    `insert into knowledge.interaction_log (id, evidence_id, member_id, entity_id, direction, channel, occurred_at, compartments, readers, entity_role)
     values ($1, $2, 'm-owner', $3, 'inbound', 'email', now() - interval '10 days', $4, '{m-owner}', 'sender')`,
    [interactionId(row.evidence_id, entity), row.evidence_id, entity, label],
  );
  return id;
}

const fpOf = async (w: WorkWorld, entity: string): Promise<string> => {
  const [row] = await w.admin<{ fp: string }>(
    'select min(value_fp collate "C") as fp from knowledge.accounts where entity_id = $1',
    [entity],
  );
  if (row === undefined) throw new Error("no account");
  return row.fp;
};

// A merge as the standing rule, an agent or a confirmed rule writes one: an identity_policy decision
// and its same ruling.
async function policyMerge(w: WorkWorld, a: string, b: string, basis = "name", label: string[] = OWN): Promise<string> {
  const id = testId("rul");
  const [x, y] = [await fpOf(w, a), await fpOf(w, b)].sort();
  await w.admin(
    `insert into knowledge.owner_decisions (id, request_id, kind, answer, batch, queue_depth, details, decided_at, compartments)
     values ($1, $2, 'identity_policy', 'same', false, 0, $3, now(), $4)`,
    [id, request(), JSON.stringify({ basis }), label],
  );
  await w.admin(
    "insert into knowledge.identity_rulings (ruling_id, verdict, a_fp, b_fp, created_at, by_agent) values ($1, 'same', $2, $3, now(), $4)",
    [id, x, y, basis === "agent"],
  );
  return id;
}

// The sweep's step alone, as the writer.
const settle = (w: WorkWorld) => settleWrongMerges({ transaction: (work) => asRole(w.db.urls.writer, work) });

const rulings = (w: WorkWorld) =>
  w.admin<{ ruling_id: string; verdict: string; lifted: boolean; by_agent: boolean; lift_ruling_id: string | null }>(
    "select ruling_id, verdict, lifted_at is not null as lifted, by_agent, lift_ruling_id from knowledge.identity_rulings order by created_at, ruling_id",
  );
const reports = (w: WorkWorld) =>
  w.admin<{ id: string; client_name: string; state: string; code: string | null; compartments: string[] }>(
    "select id, client_name, state, code, compartments from ledger.wrong_merge_reports order by created_at, id",
  );

const A = "dara.work@example.org";
const B = "dv-home@example.net";
const C = "d.varga@example.com";

// Two people the standing rule joined, each with a message on its own log.
async function merged(w: WorkWorld): Promise<{ a: EntityId; b: EntityId; merge: string; cite: string }> {
  const a = await person(w, A);
  const b = await person(w, B);
  const cite = await wrote(w, a);
  await wrote(w, b);
  return { a, b, merge: await policyMerge(w, a, b), cite };
}

const say = (w: World, client: WorkClient, entity: EntityId, parts: string[][], cites: string[]) =>
  w.work.reportWrongMerge(client.token, {
    entity,
    parts,
    because: "different_employers",
    cites: cites as never,
    requestId: request(),
  });

describe("wrong merges", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("a report on a person the caller cannot see, or naming an address it cannot see, is not_found, as one that does not exist is", async () => {
    await inWorld(async (w) => {
      const { a, cite } = await merged(w);
      const narrow = await agent(w, "narrow", WORK);
      // The positive control: a caller cleared for the person files it.
      expect(ok(await say(w, w.scout, a, [[A], [B]], [cite]))).toMatchObject({ state: "filed" });
      const hidden = await say(w, narrow, a, [[A], [B]], []);
      const absent = await say(w, narrow, testId("ent") as EntityId, [[A], [B]], []);
      expect(hidden).toEqual({ ok: false, code: "not_found" });
      expect(absent).toEqual(hidden);
      // An address of nobody's, and a message the caller cannot read.
      expect(await say(w, w.wide, a, [[A], ["nobody@example.com"]], [cite])).toEqual({ ok: false, code: "not_found" });
      const elsewhere = await w.seed.message(["agent:scout"]);
      expect(await say(w, w.wide, a, [[A], [B]], [elsewhere])).toEqual({ ok: false, code: "not_found" });
      expect((await reports(w)).map((one) => one.client_name)).toEqual(["scout"]);
    });
  });

  it("one person in two parts is same_record, a person in no part is incomplete, and no cite is no_evidence", async () => {
    await inWorld(async (w) => {
      const { a, b, cite } = await merged(w);
      await address(w, a, "dara.second@example.org");
      const c = await person(w, "third@example.com");
      await policyMerge(w, b, c);
      const sayAs = (entity: EntityId, parts: string[][], cites: string[] = [cite]) =>
        say(w, w.scout, entity, parts, cites);
      expect(ok(await sayAs(a, [[A], ["dara.second@example.org"], [B, "third@example.com"]]))).toEqual({
        refused: "same_record",
      });
      expect(ok(await sayAs(a, [[A, "dara.second@example.org"], [B]]))).toEqual({ refused: "incomplete" });
      expect(
        ok(
          await sayAs(
            a,
            [
              [A, "dara.second@example.org"],
              [B, "third@example.com"],
            ],
            [],
          ),
        ),
      ).toEqual({
        refused: "no_evidence",
      });
      expect(await reports(w)).toEqual([]);
      // The positive control: the same report with its cite is filed.
      expect(
        ok(
          await sayAs(a, [
            [A, "dara.second@example.org"],
            [B, "third@example.com"],
          ]),
        ),
      ).toMatchObject({
        state: "filed",
      });
    });
  });

  it("a person joined to nobody is not_merged", async () => {
    await inWorld(async (w) => {
      const alone = await person(w, "alone@example.com");
      await address(w, alone, "alone.too@example.com");
      const cite = await wrote(w, alone);
      expect(ok(await say(w, w.scout, alone, [["alone@example.com"], ["alone.too@example.com"]], [cite]))).toEqual({
        refused: "not_merged",
      });
    });
  });

  it("a merge the owner ruled is refused owner_ruled and stays", async () => {
    await inWorld(async (w) => {
      const a = await person(w, A);
      const b = await person(w, B);
      const cite = await wrote(w, a);
      await w.owner.identity.linkPeople(a, b, "same", { requestId: request() });
      expect(ok(await say(w, w.scout, a, [[A], [B]], [cite]))).toEqual({ refused: "owner_ruled" });
      expect(ok(await say(w, w.wide, b, [[B], [A]], [cite]))).toEqual({ refused: "owner_ruled" });
      await settle(w);
      expect(await reports(w)).toEqual([]);
      expect((await rulings(w)).map((one) => [one.verdict, one.lifted])).toEqual([["same", false]]);
    });
  });

  it("a merge the owner affirmed is the owner's: pi identity link on a pair a rule joined records the owner's same, and no agents split it", async () => {
    await inWorld(async (w) => {
      const { a, b, merge, cite } = await merged(w);
      // Two agents had reported before the owner spoke.
      expect(ok(await say(w, w.scout, a, [[A], [B]], [cite]))).toMatchObject({ state: "filed" });
      expect(ok(await say(w, w.wide, b, [[B], [A]], [cite]))).toMatchObject({ state: "agreed" });
      const affirmed = await w.owner.identity.linkPeople(a, b, "same", { requestId: request() });
      expect(
        await w.admin("select kind, answer, details from knowledge.owner_decisions where id = $1", [affirmed]),
      ).toEqual([{ kind: "identity", answer: "same", details: { affirms: [merge], inPlaceOf: merge } }]);
      // No second ruling is written, and a repeat of the owner's word is already settled.
      expect((await rulings(w)).map((one) => [one.ruling_id, one.lifted])).toEqual([[merge, false]]);
      await expect(w.owner.identity.linkPeople(a, b, "same", { requestId: request() })).rejects.toMatchObject({
        code: "already_settled",
      });
      await settle(w);
      expect((await reports(w)).map((one) => [one.state, one.code])).toEqual([
        ["refused", "owner_ruled"],
        ["refused", "owner_ruled"],
      ]);
      expect((await rulings(w)).map((one) => [one.ruling_id, one.lifted])).toEqual([[merge, false]]);
      // And a new report is refused at once.
      expect(ok(await say(w, w.scout, a, [[A], [B]], [cite]))).toEqual({ refused: "owner_ruled" });
    });
  });

  it("the owner's link on two people of a group affirms the rule's merge between them, though the group holds the owner's own ruling too", async () => {
    await inWorld(async (w) => {
      const a = await person(w, A);
      const b = await person(w, B);
      const c = await person(w, C);
      const cite = await wrote(w, c);
      const own = await w.owner.identity.linkPeople(a, b, "same", { requestId: request() });
      const merge = await policyMerge(w, b, c);
      const affirmed = await w.owner.identity.linkPeople(b, c, "same", { requestId: request() });
      expect(await w.admin("select details from knowledge.owner_decisions where id = $1", [affirmed])).toEqual([
        { details: { affirms: [merge], inPlaceOf: merge } },
      ]);
      await expect(w.owner.identity.linkPeople(b, c, "same", { requestId: request() })).rejects.toMatchObject({
        code: "already_settled",
      });
      // No agents set the third person apart from the two.
      expect(ok(await say(w, w.scout, a, [[A, B], [C]], [cite]))).toEqual({ refused: "owner_ruled" });
      await settle(w);
      expect((await rulings(w)).map((one) => [one.ruling_id, one.lifted]).sort()).toEqual(
        [
          [own, false],
          [merge, false],
        ].sort(),
      );
    });
  });

  it("the owner's link on two people affirms the merge between them alone: another merge of the group stays the agents' to split", async () => {
    await inWorld(async (w) => {
      const a = await person(w, A);
      const b = await person(w, B);
      const c = await person(w, C);
      const cite = await wrote(w, c);
      const ab = await policyMerge(w, a, b);
      const bc = await policyMerge(w, b, c);
      const affirmed = await w.owner.identity.linkPeople(a, b, "same", { requestId: request() });
      expect(await w.admin("select details from knowledge.owner_decisions where id = $1", [affirmed])).toEqual([
        { details: { affirms: [ab], inPlaceOf: ab } },
      ]);
      expect(ok(await say(w, w.scout, a, [[A], [B, C]], [cite]))).toEqual({ refused: "owner_ruled" });
      expect(ok(await say(w, w.scout, a, [[A, B], [C]], [cite]))).toMatchObject({ state: "filed" });
      expect(ok(await say(w, w.wide, c, [[C], [B, A]], [cite]))).toMatchObject({ state: "agreed" });
      await settle(w);
      expect(
        (await rulings(w))
          .filter((one) => one.verdict === "same")
          .map((one) => [one.ruling_id, one.lifted])
          .sort(),
      ).toEqual(
        [
          [ab, false],
          [bc, true],
        ].sort(),
      );
    });
  });

  it("invariant 11: the owner's link on two people joined through a third writes the owner's own same between the two, which stands when a merge of the chain is lifted by a deletion", async () => {
    await inWorld(async (w) => {
      const a = await person(w, A);
      const b = await person(w, B);
      const c = await person(w, C);
      const ab = await policyMerge(w, a, b);
      const bc = await policyMerge(w, b, c);
      const link = await w.owner.identity.linkPeople(a, c, "same", { requestId: request() });
      expect(await w.admin("select details from knowledge.owner_decisions where id = $1", [link])).toEqual([
        { details: { affirms: [ab, bc].sort() } },
      ]);
      const [fa, fc] = [await fpOf(w, a), await fpOf(w, c)].sort();
      const own = () =>
        w.admin(
          "select verdict, a_fp, b_fp, lifted_at is not null as lifted from knowledge.identity_rulings where ruling_id = $1",
          [link],
        );
      expect(await own()).toEqual([{ verdict: "same", a_fp: fa, b_fp: fc, lifted: false }]);
      // One decision and one ruling of the owner's, and a repeat is settled.
      await expect(w.owner.identity.linkPeople(a, c, "same", { requestId: request() })).rejects.toMatchObject({
        code: "already_settled",
      });
      expect(await w.admin("select 1 from knowledge.identity_rulings")).toHaveLength(3);
      // A deletion lifts a merge of the chain, as when a message an agent's answer cited is erased.
      await w.admin(
        "update knowledge.identity_rulings set lifted_at = now(), lift_ruling_id = ruling_id, lifted_by_deletion = true where ruling_id = $1",
        [ab],
      );
      expect(await own()).toEqual([{ verdict: "same", a_fp: fa, b_fp: fc, lifted: false }]);
    });
  });

  it("the owner's same on other addresses of the two people, outside the agents' label, holds them together: refused as a merge the owner ruled", async () => {
    await inWorld(async (w) => {
      const { a, b, merge, cite } = await merged(w);
      // Each person holds a second address under a label neither agent is cleared for, and the
      // owner ruled those two the same.
      const [a2, b2] = ["dara.private@example.org", "dv.private@example.net"];
      await address(w, a, a2, ["agent:scout"]);
      await address(w, b, b2, ["agent:scout"]);
      const owners = testId("rul");
      const [x, y] = [fingerprint(w.db.keys, "address", a2), fingerprint(w.db.keys, "address", b2)].sort();
      await w.admin(
        `insert into knowledge.owner_decisions (id, request_id, kind, answer, batch, queue_depth, details, decided_at, compartments)
         values ($1, $2, 'identity', 'same', false, 0, '{}', now(), '{agent:scout}')`,
        [owners, request()],
      );
      await w.admin(
        "insert into knowledge.identity_rulings (ruling_id, verdict, a_fp, b_fp, created_at) values ($1, 'same', $2, $3, now())",
        [owners, x, y],
      );
      expect(ok(await say(w, w.scout, a, [[A], [B]], [cite]))).toMatchObject({ state: "filed" });
      expect(ok(await say(w, w.wide, b, [[B], [A]], [cite]))).toMatchObject({ state: "agreed" });
      await settle(w);
      // The same name as for a merge the owner ruled: it tells of no ruling the agents cannot see.
      expect((await reports(w)).map((one) => [one.state, one.code])).toEqual([
        ["refused", "owner_ruled"],
        ["refused", "owner_ruled"],
      ]);
      expect((await rulings(w)).map((one) => [one.ruling_id, one.verdict, one.lifted]).sort()).toEqual(
        [
          [merge, "same", false],
          [owners, "same", false],
        ].sort(),
      );
    });
  });

  it("an erasure of a person a split names lifts the split as a deletion's, then removes its reports: the dry run counts what the real run does", async () => {
    await inWorld(async (w) => {
      const { a, b, merge, cite } = await merged(w);
      ok(await say(w, w.scout, a, [[A], [B]], [cite]));
      ok(await say(w, w.wide, a, [[A], [B]], [cite]));
      await settle(w);
      expect((await reports(w)).map((one) => one.state)).toEqual(["split", "split"]);
      // The person erased is not the one the reports were filed on, and no cited message is its own.
      const dry = await w.owner.erasure.erasePerson(b, { requestId: request(), dryRun: true });
      expect(await reports(w)).toHaveLength(2);
      const real = await w.owner.erasure.erasePerson(b, { requestId: request() });
      expect(dry.more.identity).toBeGreaterThanOrEqual(2);
      expect(real.more.identity).toBe(dry.more.identity);
      expect(await reports(w)).toEqual([]);
      // The agents' different named the erased address, so it went with the address's rulings, as
      // the merge did; neither is left in force on what was erased.
      expect(await w.admin("select 1 from knowledge.identity_rulings where lifted_at is null")).toEqual([]);
      expect(await w.admin("select 1 from knowledge.identity_rulings where ruling_id = $1", [merge])).toEqual([]);
    });
  });

  it("an erasure of one person of a part keeps the split between the people left: nothing is lifted, and the person leaves the report", async () => {
    await inWorld(async (w) => {
      // The rule joined two people to a third, each by a merge of its own; the agents set the third apart.
      const { a, b, merge, cite } = await merged(w);
      const c = await person(w, C);
      const ac = await policyMerge(w, a, c);
      const parts = [[A], [B, C]];
      ok(await say(w, w.scout, a, parts, [cite]));
      ok(await say(w, w.wide, a, parts, [cite]));
      await settle(w);
      const made = (await rulings(w)).find((one) => one.verdict === "different");
      expect(made).toMatchObject({ lifted: false });
      // The agents' different is on the least address of each part: erase the person of the second
      // part that does not hold it, so the erasure's own delete of an erased address's rulings
      // does not reach the different. The reports cite a message of the first person's.
      const [fb, fc] = [await fpOf(w, b), await fpOf(w, c)];
      const [other, left] = fb < fc ? [c, b] : [b, c];
      const dry = await w.owner.erasure.erasePerson(other, { requestId: request(), dryRun: true });
      const real = await w.owner.erasure.erasePerson(other, { requestId: request() });
      expect(real.more.identity).toBe(dry.more.identity);
      // Nothing about the two people left changed: the agents' different stands between them.
      expect(
        await w.admin(
          "select lifted_at is not null as lifted, lifted_by_deletion from knowledge.identity_rulings where ruling_id = $1",
          [made?.ruling_id],
        ),
      ).toEqual([{ lifted: false, lifted_by_deletion: false }]);
      // The merge the split lifted between them stays lifted as the agents lifted it, so the
      // standing rule does not read the pair again.
      const kept = other === c ? merge : ac;
      expect(
        await w.admin(
          "select lifted_at is not null as lifted, lifted_by_deletion, lift_ruling_id from knowledge.identity_rulings where ruling_id = $1",
          [kept],
        ),
      ).toEqual([{ lifted: true, lifted_by_deletion: false, lift_ruling_id: made?.ruling_id }]);
      // Each report stays as the record of the split, naming the two people left and nobody erased.
      const stripped = await w.admin<{ state: string; entity_id: string; members: string[]; parts: string[] }>(
        "select state, entity_id, members, parts from ledger.wrong_merge_reports order by created_at, id",
      );
      expect(stripped).toHaveLength(2);
      for (const report of stripped)
        expect(report).toEqual({ state: "split", entity_id: a, members: [a, left].sort(), parts: [a, left].sort() });
      expect(await w.admin("select 1 from ledger.wrong_merge_reports where members && $1::text[]", [[other]])).toEqual(
        [],
      );
    });
  });

  it("an erasure of every person of a part leaves the report no subject: it goes, and with three parts the other two stay", async () => {
    await inWorld(async (w) => {
      const { a, b, cite } = await merged(w);
      const c = await person(w, C);
      await policyMerge(w, a, c);
      const parts = [[A], [B], [C]];
      ok(await say(w, w.scout, a, parts, [cite]));
      ok(await say(w, w.wide, a, parts, [cite]));
      await settle(w);
      expect((await reports(w)).map((one) => one.state)).toEqual(["split", "split"]);
      await w.owner.erasure.erasePerson(c, { requestId: request() });
      const two = await w.admin<{ members: string[]; parts: string[] }>(
        "select members, parts from ledger.wrong_merge_reports order by created_at, id",
      );
      expect(two).toEqual([
        { members: [a, b].sort(), parts: [a, b].sort() },
        { members: [a, b].sort(), parts: [a, b].sort() },
      ]);
      await w.owner.erasure.erasePerson(b, { requestId: request() });
      expect(await reports(w)).toEqual([]);
    });
  });

  it("a person an erasure leaves nothing of leaves a settled report stripped; left with one part it stays, to find its split by, until the evidence it cited is erased", async () => {
    await inWorld(async (w) => {
      const { a, b, cite } = await merged(w);
      const c = await person(w, C);
      await policyMerge(w, a, c);
      const parts = [[A], [B, C]];
      ok(await say(w, w.scout, a, parts, [cite]));
      ok(await say(w, w.wide, a, parts, [cite]));
      await settle(w);
      const made = (await rulings(w)).find((one) => one.verdict === "different");
      // Nothing cites the third person once an item's erasure took what did: the person and the
      // address go, as removeSourceItem's last step does for an erased item.
      await w.admin("delete from knowledge.interaction_log where entity_id = $1", [c]);
      await asRole(w.db.urls.writer, (query) => removeForGood({ query }, [c]));
      expect(await w.admin("select 1 from knowledge.entities where id = $1", [c])).toEqual([]);
      const left = () =>
        w.admin<{ state: string; entity_id: string; members: string[]; parts: string[] }>(
          "select state, entity_id, members, parts from ledger.wrong_merge_reports order by created_at, id",
        );
      expect(await left()).toEqual([
        { state: "split", entity_id: a, members: [a, b].sort(), parts: [a, b].sort() },
        { state: "split", entity_id: a, members: [a, b].sort(), parts: [a, b].sort() },
      ]);
      // The second part's last person goes the same way. No address was erased, so the agents'
      // different still stands on the two addresses, resting on the message the reports cited.
      // Each report stays with its one part: it alone links that ruling to the message.
      await w.admin("delete from knowledge.interaction_log where entity_id = $1", [b]);
      await asRole(w.db.urls.writer, (query) => removeForGood({ query }, [b]));
      expect(await left()).toEqual([
        { state: "split", entity_id: a, members: [a], parts: [a] },
        { state: "split", entity_id: a, members: [a], parts: [a] },
      ]);
      expect(
        await w.admin("select lifted_at is not null as lifted from knowledge.identity_rulings where ruling_id = $1", [
          made?.ruling_id,
        ]),
      ).toEqual([{ lifted: false }]);
      // The message is erased later: the reports are found by it, and the split is lifted as a deletion's.
      const [message] = await w.admin<{ evidence_id: string }>(
        "select evidence_id from knowledge.messages where id = $1",
        [cite],
      );
      await asRole(w.db.urls.admin, (query) =>
        eraseFromWrongMerges(
          query,
          { addressFps: [], evidenceIds: [message?.evidence_id as string], people: [] },
          false,
        ),
      );
      expect(await reports(w)).toEqual([]);
      expect(
        await w.admin(
          "select lifted_at is not null as lifted, lifted_by_deletion from knowledge.identity_rulings where ruling_id = $1",
          [made?.ruling_id],
        ),
      ).toEqual([{ lifted: true, lifted_by_deletion: true }]);
    });
  });

  it("an expiry and a deletion at the source leave a report and its split as they are; switched on, a deletion at the source does what an erasure does", async () => {
    await inWorld(async (w) => {
      const { a, b, cite } = await merged(w);
      ok(await say(w, w.scout, a, [[A], [B]], [cite]));
      ok(await say(w, w.wide, a, [[A], [B]], [cite]));
      await settle(w);
      const before = {
        reports: await w.admin("select * from ledger.wrong_merge_reports order by id"),
        rulings: await rulings(w),
      };
      expect(before.reports).toHaveLength(2);
      const itemOf = async (entity: string) => {
        const [row] = await w.admin<{ id: string; source_account_id: string; source_item_fp: string }>(
          `select e.id, e.source_account_id, e.source_item_fp from vault.evidence_items e
           join knowledge.interaction_log l on l.evidence_id = e.id where l.entity_id = $1`,
          [entity],
        );
        if (row === undefined) throw new Error("no item");
        return { evidence: row.id, account: { id: row.source_account_id, compartment: "own" }, fp: row.source_item_fp };
      };
      const asWriter = <T>(fn: (tx: { query: never; keys: typeof w.db.keys }) => Promise<T>): Promise<T> =>
        asRole(w.db.urls.writer, (query) => fn({ query: query as never, keys: w.db.keys }));
      // The second person's only item expires: the person goes, since nothing cites it, and may
      // come back at the next capture. The reports and the split are as they were.
      const second = await itemOf(b);
      await asWriter((tx) => expireSourceItem(tx, second.account, second.fp, new Date()));
      expect(await w.admin("select 1 from knowledge.entities where id = $1", [b])).toEqual([]);
      expect(await w.admin("select * from ledger.wrong_merge_reports order by id")).toEqual(before.reports);
      expect(await rulings(w)).toEqual(before.rulings);
      // The message the reports cite is deleted at its source, as shipped: the same.
      expect(SCRUB_ON_SOURCE_DELETION).toBe(false);
      const first = await itemOf(a);
      await asWriter((tx) => removeSourceItem(tx, first.account, first.fp, "deleted"));
      expect(await w.admin("select 1 from vault.evidence_items where id = $1", [first.evidence])).toEqual([]);
      expect(await w.admin("select * from ledger.wrong_merge_reports order by id")).toEqual(before.reports);
      expect(await rulings(w)).toEqual(before.rulings);
      // Only the sweep closes an open report that names a person who is gone (WM9); these are settled.
      await settle(w);
      expect(await w.admin("select * from ledger.wrong_merge_reports order by id")).toEqual(before.reports);
    });
    // Switched on: the deletion finds the reports by the message they cite, as the writer runs
    // it, and lifts the split as a deletion's.
    await inWorld(async (w) => {
      const { a, merge, cite } = await merged(w);
      ok(await say(w, w.scout, a, [[A], [B]], [cite]));
      ok(await say(w, w.wide, a, [[A], [B]], [cite]));
      await settle(w);
      const [row] = await w.admin<{ source_account_id: string; source_item_fp: string }>(
        "select e.source_account_id, e.source_item_fp from vault.evidence_items e join knowledge.messages m on m.evidence_id = e.id where m.id = $1",
        [cite],
      );
      await asRole(w.db.urls.writer, (query) =>
        removeSourceItem(
          { query: query as never, keys: w.db.keys },
          { id: row?.source_account_id as string, compartment: "own" },
          row?.source_item_fp as string,
          "deleted",
          true,
        ),
      );
      expect(await reports(w)).toEqual([]);
      expect((await rulings(w)).find((one) => one.verdict === "different")).toMatchObject({ lifted: true });
      expect(
        await w.admin("select lifted_by_deletion from knowledge.identity_rulings where ruling_id = $1", [merge]),
      ).toEqual([{ lifted_by_deletion: true }]);
    });
  });

  it("an erasure that makes two open reports of one client the same keeps one, and does not fail", async () => {
    await inWorld(async (w) => {
      // The agent reported the second and third as wrongly joined; then the rule joined the first
      // to them, and the agent reported all three.
      const b = await person(w, B);
      const c = await person(w, C);
      const cite = await wrote(w, b);
      await wrote(w, c);
      await policyMerge(w, b, c);
      ok(await say(w, w.scout, b, [[B], [C]], [cite]));
      const a = await person(w, A);
      await wrote(w, a);
      const joined = await policyMerge(w, a, b);
      ok(await say(w, w.scout, b, [[A], [B], [C]], [cite]));
      expect((await reports(w)).map((one) => one.state)).toEqual(["open", "open"]);
      // The owner sets the first apart again, so its erasure is of that person alone. Erasing it
      // leaves the second report naming the two the first report names.
      expect(await w.owner.identity.liftIdentity(joined as never, { requestId: request() })).toBe(true);
      const dry = await w.owner.erasure.erasePerson(a, { requestId: request(), dryRun: true });
      const real = await w.owner.erasure.erasePerson(a, { requestId: request() });
      expect(real.more.identity).toBe(dry.more.identity);
      expect(
        await w.admin<{ state: string; members: string[]; parts: string[] }>(
          "select state, members, parts from ledger.wrong_merge_reports",
        ),
      ).toEqual([{ state: "open", members: [b, c].sort(), parts: [b, c].sort() }]);
    });
  });

  it("the owner's different on two people they linked is refused as on any pair they joined, until they lift their own link", async () => {
    await inWorld(async (w) => {
      const a = await person(w, A);
      const b = await person(w, B);
      const c = await person(w, C);
      const ab = await policyMerge(w, a, b, "agent");
      const bc = await policyMerge(w, b, c, "agent");
      const link = await w.owner.identity.linkPeople(a, c, "same", { requestId: request() });
      // An ordinary pair the owner joined themselves: a different is refused, and the owner lifts
      // their own ruling to change their mind. A link over a chain is no other.
      const d = await person(w, "d.other@example.org");
      const e = await person(w, "e.other@example.net");
      const plain = await w.owner.identity.linkPeople(d, e, "same", { requestId: request() });
      for (const [x, y] of [
        [a, c],
        [d, e],
      ] as const)
        await expect(w.owner.identity.linkPeople(x, y, "different", { requestId: request() })).rejects.toMatchObject({
          code: "conflicting_ruling",
        });
      expect(await w.owner.identity.liftIdentity(plain, { requestId: request() })).toBe(true);
      expect(await w.owner.identity.linkPeople(d, e, "different", { requestId: request() })).toMatch(/^rul_/);
      expect(await w.owner.identity.liftIdentity(link, { requestId: request() })).toBe(true);
      // Their newer word then outranks the agents' merges between the two, which it lifts as far as it must.
      const apart = await w.owner.identity.linkPeople(a, c, "different", { requestId: request() });
      const after = await rulings(w);
      expect(after.find((one) => one.ruling_id === apart)).toMatchObject({ verdict: "different", lifted: false });
      expect(after.filter((one) => [ab, bc].includes(one.ruling_id) && one.lift_ruling_id === apart)).not.toEqual([]);
    });
  });

  it("a re-derive keeps a report: every person deleted and made again under its id leaves it as it was", async () => {
    await inWorld(async (w) => {
      const { a, b, cite } = await merged(w);
      ok(await say(w, w.scout, a, [[A], [B]], [cite]));
      const before = await reports(w);
      const accounts = await w.admin("select * from knowledge.accounts where entity_id = any($1)", [[a, b]]);
      // As write/rederive.ts does: what names a person, the person, then both again.
      await w.admin("delete from knowledge.interaction_log where entity_id = any($1)", [[a, b]]);
      await w.admin("delete from knowledge.accounts where entity_id = any($1)", [[a, b]]);
      await w.admin("delete from knowledge.entities where id = any($1)", [[a, b]]);
      await w.admin("insert into knowledge.entities (id, kind) select unnest($1::text[]), 'person'", [[a, b]]);
      await w.admin(
        "insert into knowledge.accounts select * from jsonb_populate_recordset(null::knowledge.accounts, $1::jsonb)",
        [JSON.stringify(accounts)],
      );
      await settle(w);
      expect(await reports(w)).toEqual(before);
    });
  });

  it("a person removed for good closes its open report at the sweep as changed, and a split report stays", async () => {
    await inWorld(async (w) => {
      const { a, b, cite } = await merged(w);
      ok(await say(w, w.scout, a, [[A], [B]], [cite]));
      // As the writer removes a person nothing cites: no erasure, and no hook.
      await w.admin("delete from knowledge.interaction_log where entity_id = $1", [b]);
      await w.admin("delete from knowledge.accounts where entity_id = $1", [b]);
      expect(await w.admin("delete from knowledge.entities where id = $1 returning id", [b])).toEqual([{ id: b }]);
      expect((await reports(w)).map((one) => one.state)).toEqual(["open"]);
      expect(await settle(w)).toMatchObject({ toOwner: 0 });
      expect((await reports(w)).map((one) => [one.state, one.code])).toEqual([["refused", "changed"]]);
    });
  });

  it("one report splits nothing, and the same client twice splits nothing", async () => {
    await inWorld(async (w) => {
      const { a, b, merge, cite } = await merged(w);
      expect(ok(await say(w, w.scout, a, [[A], [B]], [cite]))).toMatchObject({ state: "filed" });
      // The same split again, from the other person and in the other order: one report each.
      expect(ok(await say(w, w.scout, b, [[B], [A]], [cite]))).toEqual({ refused: "already_reported" });
      expect(await settle(w)).toMatchObject({ open: 1, one_agent: 1, toOwner: 0 });
      expect(await rulings(w)).toEqual([
        { ruling_id: merge, verdict: "same", lifted: false, by_agent: false, lift_ruling_id: null },
      ]);
      expect((await reports(w)).map((one) => one.state)).toEqual(["open"]);
    });
  });

  it("two agents agreeing split the merge: the rulings are lifted, the agents' different stands, each person reads apart", async () => {
    await inWorld(async (w) => {
      const { a, b, merge, cite } = await merged(w);
      const first = ok(await say(w, w.scout, a, [[A], [B]], [cite])) as { report: string; state: string };
      expect(first.state).toBe("filed");
      // The second agent names the same split from the other person, in the other order.
      expect(ok(await say(w, w.wide, b, [[B], [A]], [cite]))).toMatchObject({ state: "agreed" });
      const [stored] = await w.admin<{ partition_key: string; group_key: string; cross_rulings: string[] }>(
        "select partition_key, group_key, cross_rulings from ledger.wrong_merge_reports where id = $1",
        [first.report],
      );
      // The database's keys are the core's.
      expect(stored).toEqual({
        partition_key: partitionKey([[a], [b]]),
        group_key: groupKey([a, b]),
        cross_rulings: [merge],
      });

      expect(await settle(w)).toMatchObject({ open: 2, split: 1, toOwner: 0 });
      const after = await rulings(w);
      const made = after.find((one) => one.verdict === "different");
      expect(made).toMatchObject({ lifted: false, by_agent: true });
      expect(after.find((one) => one.ruling_id === merge)).toMatchObject({
        lifted: true,
        lift_ruling_id: made?.ruling_id,
      });
      expect(
        await w.admin(
          "select kind, answer, details ->> 'basis' as basis, details ->> 'client' as client, details ->> 'agrees' as agrees from knowledge.owner_decisions where id = $1",
          [made?.ruling_id],
        ),
      ).toEqual([{ kind: "identity_policy", answer: "different", basis: "agent", client: "scout", agrees: "wide" }]);
      expect((await reports(w)).map((one) => one.state)).toEqual(["split", "split"]);
      // Each person reads apart again, with the address it had.
      const seen = (await w.reader.getEntity(w.scout.token, { id: a })) as {
        ok: true;
        value: { addresses: { untrusted: string }[] };
      };
      expect(seen.value.addresses.map((one) => one.untrusted)).toEqual([A]);
      // A second sweep repeats nothing.
      expect(await settle(w)).toMatchObject({ open: 0, toOwner: 0 });
      expect((await rulings(w)).length).toBe(after.length);
    });
  });

  it("the sweep makes the split, and the owner's link after it joins them again and lifts the agents' ruling", async () => {
    await inWorld(async (w) => {
      const { a, b, cite } = await merged(w);
      ok(await say(w, w.scout, a, [[A], [B]], [cite]));
      ok(await say(w, w.wide, a, [[A], [B]], [cite]));
      await w.writer.proposeIdentity(new Date("2026-11-11T12:00:00Z"));
      expect((await reports(w)).map((one) => one.state)).toEqual(["split", "split"]);
      const owners = await w.owner.identity.linkPeople(a, b, "same", { requestId: request() });
      const after = await rulings(w);
      expect(after.find((one) => one.verdict === "different")).toMatchObject({ lifted: true, lift_ruling_id: owners });
      expect(after.find((one) => one.ruling_id === owners)).toMatchObject({ verdict: "same", lifted: false });
    });
  });

  it("a group that changed is refused changed", async () => {
    await inWorld(async (w) => {
      const { a, b, cite } = await merged(w);
      ok(await say(w, w.scout, a, [[A], [B]], [cite]));
      ok(await say(w, w.wide, a, [[A], [B]], [cite]));
      const c = await person(w, "third@example.com");
      await policyMerge(w, b, c);
      expect(await settle(w)).toMatchObject({ changed: 1 });
      expect((await reports(w)).map((one) => [one.state, one.code])).toEqual([
        ["refused", "changed"],
        ["refused", "changed"],
      ]);
      expect((await rulings(w)).every((one) => !one.lifted)).toBe(true);
    });
  });

  it("with the switch off the tool is refused agents_off and the sweep splits nothing", async () => {
    await inWorld(async (w) => {
      const { a, cite } = await merged(w);
      ok(await say(w, w.scout, a, [[A], [B]], [cite]));
      ok(await say(w, w.wide, a, [[A], [B]], [cite]));
      await w.owner.identity.setIdentityAgents("off");
      const late = await agent(w, "late", OWN);
      expect(ok(await say(w, late, a, [[A], [B]], [cite]))).toEqual({ refused: "agents_off" });
      expect(await settle(w)).toMatchObject({ agents_off: 2 });
      expect((await rulings(w)).every((one) => !one.lifted)).toBe(true);
    });
  });

  it("two reports that disagree, and a lone report once its wait is over, close for the owner", async () => {
    await inWorld(async (w) => {
      const { a, b, cite } = await merged(w);
      const c = await person(w, "third@example.com");
      await policyMerge(w, b, c);
      ok(await say(w, w.scout, a, [[A], [B, "third@example.com"]], [cite]));
      ok(await say(w, w.wide, a, [[A, B], ["third@example.com"]], [cite]));
      expect(await settle(w)).toMatchObject({ toOwner: 2 });
      expect((await reports(w)).map((one) => [one.state, one.code])).toEqual([
        ["owner", "disagreed"],
        ["owner", "disagreed"],
      ]);
      // A lone report, old enough.
      const x = await person(w, "x.one@example.org");
      const y = await person(w, "x.two@example.net");
      const seen = await wrote(w, x);
      await policyMerge(w, x, y);
      ok(await say(w, w.scout, x, [["x.one@example.org"], ["x.two@example.net"]], [seen]));
      expect(await settle(w)).toMatchObject({ toOwner: 0 });
      // The wait is the sweep's to give: with none, the lone report closes.
      expect(await queryAs(w.db.urls.writer, "select ledger.wrong_merges_to_owner(0) as n")).toEqual([{ n: 1 }]);
      expect((await reports(w)).map((one) => one.code)).toEqual(["disagreed", "disagreed", "one_agent"]);
      expect((await rulings(w)).every((one) => !one.lifted)).toBe(true);
    });
  });

  it("a report under a wider label changes nothing a narrower agent reads", async () => {
    await inWorld(async (w) => {
      const { a, b, cite } = await merged(w);
      // The second person has an address only the wider agents can see.
      await address(w, b, "dv-office@example.com", WORK);
      const low = await agent(w, "low", OWN);
      const before = ok(await say(w, low, a, [[A], [B]], [cite]));
      expect(before).toMatchObject({ state: "filed" });
      // A wider agent names the same people apart, under the wider label.
      expect(ok(await say(w, w.scout, a, [[A], [B, "dv-office@example.com"]], [cite]))).toMatchObject({
        state: "filed",
      });
      expect((await reports(w)).map((one) => [one.client_name, one.compartments])).toEqual([
        ["low", OWN],
        ["scout", [...WORK, ...OWN].sort()],
      ]);
      // The narrower agent's own call answers as before, and nothing is split across labels.
      const repeat = await w.work.reportWrongMerge(low.token, {
        entity: b,
        parts: [[B], [A]],
        because: "different_employers",
        cites: [cite] as never,
        requestId: request(),
      });
      expect(ok(repeat)).toEqual({ refused: "already_reported" });
      expect(await settle(w)).toMatchObject({ one_agent: 2 });
      expect((await rulings(w)).every((one) => !one.lifted)).toBe(true);
    });
  });

  it("a repeat of a request answers what the first call wrote only to a caller still cleared for the report, and a report holds no label of the rulings", async () => {
    await inWorld(async (w) => {
      const { a, cite } = await merged(w);
      const args = {
        entity: a,
        parts: [[A], [B]],
        because: "different_employers",
        cites: [cite] as never,
        requestId: request(),
      };
      const first = ok(await w.work.reportWrongMerge(w.scout.token, args));
      expect(first).toMatchObject({ state: "filed" });
      expect(ok(await w.work.reportWrongMerge(w.scout.token, args))).toEqual(first);
      // The caller's clearance narrows: the report is a row it can no longer read, by the tool as by the table.
      await w.admin("update policy.clients set compartments = $2 where id = $1", [w.scout.id, WORK]);
      expect(await w.work.reportWrongMerge(w.scout.token, args)).toEqual({ ok: false, code: "not_found" });
      // The label of the rulings a split would lift is no column a reader is served.
      expect(
        await w.admin(
          "select column_name from information_schema.columns where table_schema = 'ledger' and table_name = 'wrong_merge_reports' and column_name like '%label%'",
        ),
      ).toEqual([]);
    });
  });

  it("the split's decision takes the label of the rulings it lifts, wider than the reports' own", async () => {
    await inWorld(async (w) => {
      const a = await person(w, A);
      const b = await person(w, B);
      const cite = await wrote(w, a);
      // The rule's merge rested on something under the employer's label too.
      const merge = await policyMerge(w, a, b, "name", [...WORK, ...OWN].sort());
      ok(await say(w, w.scout, a, [[A], [B]], [cite]));
      ok(await say(w, w.wide, a, [[A], [B]], [cite]));
      expect((await reports(w)).map((one) => one.compartments)).toEqual([OWN, OWN]);
      await settle(w);
      const made = (await rulings(w)).find((one) => one.verdict === "different");
      expect(made).toMatchObject({ lifted: false });
      expect(
        await w.admin("select compartments, details -> 'lifts' as lifts from knowledge.owner_decisions where id = $1", [
          made?.ruling_id,
        ]),
      ).toEqual([{ compartments: [...WORK, ...OWN].sort(), lifts: [merge] }]);
    });
  });

  it("an audit task is raised for a sampled policy merge, under the ruling's label, and not for an agent's ruling or the owner's", async () => {
    await inWorld(async (w) => {
      const { a, merge } = await merged(w);
      const p = await person(w, "p.one@example.org");
      const q = await person(w, "p.two@example.net");
      await policyMerge(w, p, q, "agent");
      const r = await person(w, "r.one@example.org");
      const s = await person(w, "r.two@example.net");
      await w.owner.identity.linkPeople(r, s, "same", { requestId: request() });
      const gaps = () =>
        queryAs<{ subject: string; about_id: string; label: string[] }>(
          w.db.urls.work,
          "select subject, about_id, label from ledger.merge_audit_gaps(now(), $1, $2)",
          [MERGE_AUDIT_SAMPLE, MERGE_AUDIT_DAYS],
        );
      const [gap] = await gaps();
      expect(await gaps()).toEqual([{ subject: merge, about_id: gap?.about_id, label: OWN }]);
      const [flag] = await queryAs<{ id: string | null }>(
        w.db.urls.work,
        "select ledger.raise_gap_flag($1, 'merge_audit', $2, 'entity', $3, 'entity', $3, null, null, true) as id",
        [testId("opp"), merge, gap?.about_id],
      );
      expect(flag?.id).toMatch(/^opp_/);
      expect(
        await w.admin("select gap_trigger, gap_subject, compartments, tier from ledger.opportunities where id = $1", [
          flag?.id,
        ]),
      ).toEqual([{ gap_trigger: "merge_audit", gap_subject: merge, compartments: OWN, tier: "task" }]);
      // Its gap holds while the task is open, and no second is raised for it.
      expect((await gaps()).map((one) => one.subject)).toEqual([merge]);
      // A flag for a ruling that is no policy merge is refused.
      const [none] = await queryAs<{ id: string | null }>(
        w.db.urls.work,
        "select ledger.raise_gap_flag($1, 'merge_audit', $2, 'entity', $3, 'entity', $3, null, null, true) as id",
        [testId("opp"), testId("rul"), a],
      );
      expect(none?.id).toBeNull();
      // Off: nothing is audited.
      await w.owner.identity.setIdentityAgents("off");
      expect(await gaps()).toEqual([]);
    });
  });

  it("an open report raises one second look on the board for the merge it names, and never another", async () => {
    await inWorld(async (w) => {
      const { a, merge, cite } = await merged(w);
      const gaps = () =>
        queryAs<{ subject: string; about_id: string; label: string[] }>(
          w.db.urls.work,
          "select subject, about_id, label from ledger.merge_audit_gaps(now(), $1, $2)",
          [MERGE_AUDIT_SAMPLE, MERGE_AUDIT_DAYS],
        );
      const raise = async (gap: { subject: string; about_id: string } | undefined): Promise<string> => {
        const [flag] = await queryAs<{ id: string | null }>(
          w.db.urls.work,
          "select ledger.raise_gap_flag($1, 'merge_audit', $2, 'entity', $3, 'entity', $3, null, null, true) as id",
          [testId("opp"), gap?.subject, gap?.about_id],
        );
        if (flag?.id == null) throw new Error("no flag");
        return flag.id;
      };
      // The week's audit of the merge, done with nothing reported: no second look.
      const [sampled] = await gaps();
      expect(sampled?.subject).toBe(merge);
      await w.status("opportunity", await raise(sampled), "done", "client:scout");
      expect(await gaps()).toEqual([]);
      // One agent reports the merge wrong: the board holds a task for a second agent, under the merge's label.
      expect(ok(await say(w, w.scout, a, [[A], [B]], [cite]))).toMatchObject({ state: "filed" });
      const [second] = await gaps();
      expect(second).toEqual({ subject: `${merge}_2`, about_id: sampled?.about_id, label: OWN });
      const task = await raise(second);
      expect(
        await w.admin("select gap_trigger, gap_subject, compartments, tier from ledger.opportunities where id = $1", [
          task,
        ]),
      ).toEqual([{ gap_trigger: "merge_audit", gap_subject: `${merge}_2`, compartments: OWN, tier: "task" }]);
      // It holds while it is open, and once it ends no third is raised though the report still waits.
      expect((await gaps()).map((one) => one.subject)).toEqual([`${merge}_2`]);
      await w.status("opportunity", task, "done", "client:wide");
      expect(await gaps()).toEqual([]);
      expect((await reports(w)).map((one) => one.state)).toEqual(["open"]);
    });
  });

  it("a second look nobody takes ends with its report: the gap stops holding when the report goes to the owner", async () => {
    await inWorld(async (w) => {
      const { a, merge, cite } = await merged(w);
      const gaps = () =>
        queryAs<{ subject: string; about_id: string }>(
          w.db.urls.work,
          "select subject, about_id from ledger.merge_audit_gaps(now(), $1, $2)",
          [MERGE_AUDIT_SAMPLE, MERGE_AUDIT_DAYS],
        );
      expect(ok(await say(w, w.scout, a, [[A], [B]], [cite]))).toMatchObject({ state: "filed" });
      const [second] = await gaps();
      expect(second?.subject).toBe(`${merge}_2`);
      const [flag] = await queryAs<{ id: string | null }>(
        w.db.urls.work,
        "select ledger.raise_gap_flag($1, 'merge_audit', $2, 'entity', $3, 'entity', $3, null, null, true) as id",
        [testId("opp"), second?.subject, second?.about_id],
      );
      expect(flag?.id).toMatch(/^opp_/);
      expect((await gaps()).map((one) => one.subject)).toEqual([`${merge}_2`]);
      // The report's days run out with no second agent: it is the owner's, and the open task's gap
      // no longer holds, so the tick closes it. No third look is raised.
      await w.admin("select ledger.wrong_merges_to_owner(0)");
      expect((await reports(w)).map((one) => one.state)).toEqual(["owner"]);
      expect(await gaps()).toEqual([]);
    });
  });

  it("the SQL sample is the core's, and the outcomes report counts audited, found wrong and split", async () => {
    await inWorld(async (w) => {
      const merges: string[] = [];
      const people: [EntityId, EntityId][] = [];
      for (let i = 0; i < 8; i += 1) {
        const x = await person(w, `one.${i}@example.org`);
        const y = await person(w, `two.${i}@example.net`);
        people.push([x, y]);
        merges.push(await policyMerge(w, x, y));
      }
      const at = new Date();
      const sampled = await queryAs<{ subject: string; about_id: string }>(
        w.db.urls.work,
        "select subject, about_id from ledger.merge_audit_gaps($1::timestamptz, $2, $3)",
        [at.toISOString(), MERGE_AUDIT_SAMPLE, MERGE_AUDIT_DAYS],
      );
      expect(sampled.map((one) => one.subject).sort()).toEqual(
        weekSample(merges, isoWeek(at, "W"), MERGE_AUDIT_SAMPLE).sort(),
      );
      // Two are raised; one is done, and the other is reported wrong by two agents and split.
      const [done, wrong] = sampled;
      if (done === undefined || wrong === undefined) throw new Error("no sample");
      const flags: string[] = [];
      for (const one of [done, wrong]) {
        const [flag] = await queryAs<{ id: string }>(
          w.db.urls.work,
          "select ledger.raise_gap_flag($1, 'merge_audit', $2, 'entity', $3, 'entity', $3, null, null, true) as id",
          [testId("opp"), one.subject, one.about_id],
        );
        flags.push(flag?.id as string);
      }
      // What is left of the week's sample is three, not five more.
      expect(
        await queryAs(w.db.urls.work, "select subject from ledger.merge_audit_gaps($1::timestamptz, $2, $3)", [
          at.toISOString(),
          MERGE_AUDIT_SAMPLE,
          MERGE_AUDIT_DAYS,
        ]),
      ).toHaveLength(MERGE_AUDIT_SAMPLE);
      await w.status("opportunity", flags[0] as string, "done", "client:scout");
      const pair = people[merges.indexOf(wrong.subject)];
      if (pair === undefined) throw new Error("no pair");
      const i = merges.indexOf(wrong.subject);
      const cite = await wrote(w, pair[0]);
      const parts = [[`one.${i}@example.org`], [`two.${i}@example.net`]];
      ok(await say(w, w.scout, pair[0], parts, [cite]));
      ok(await say(w, w.wide, pair[1], parts, [cite]));
      await settle(w);
      const metric = await asRole(w.db.urls.admin, (query) =>
        mergeAudits(query, 30, {
          now: new Date(),
          within: KEYS,
          ago: (days) => new Date(Date.now() - days * 86_400_000).toISOString() as never,
        }),
      );
      expect(metric).toMatchObject({
        metric: "policy_merges_wrong_share",
        value: 0.5,
        sample: 2,
        parts: { audited: 2, found_wrong: 1, split: 1, waiting_owner: 0 },
      });
    });
  });

  it("a removed message a report cites removes the report and lifts the split made from it as a deletion's", async () => {
    await inWorld(async (w) => {
      const { a, merge, cite } = await merged(w);
      ok(await say(w, w.scout, a, [[A], [B]], [cite]));
      ok(await say(w, w.wide, a, [[A], [B]], [cite]));
      await settle(w);
      const [message] = await w.admin<{ evidence_id: string }>(
        "select evidence_id from knowledge.messages where id = $1",
        [cite],
      );
      const removed = await asRole(w.db.urls.admin, (query) =>
        eraseFromWrongMerges(
          query,
          { addressFps: [], evidenceIds: [message?.evidence_id as string], people: [] },
          false,
        ),
      );
      expect(removed).toBe(2);
      expect(await reports(w)).toEqual([]);
      const after = await rulings(w);
      expect(after.find((one) => one.verdict === "different")).toMatchObject({ lifted: true });
      expect(
        await w.admin("select lifted_by_deletion from knowledge.identity_rulings where ruling_id = $1", [merge]),
      ).toEqual([{ lifted_by_deletion: true }]);
    });
  });
});
