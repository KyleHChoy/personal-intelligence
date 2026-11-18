import { type EntityId, FiledMention, type GoalId, type MentionBindingId } from "@intelligence/contracts/personal";
import { namedKey } from "@intelligence/personal-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { journalPath } from "../../core/journal.ts";
import { createPipeline, type Pipeline } from "../../pipeline/pipeline.ts";
import { type Accounts, connect, OWNER, type Who } from "../../test-support/cast.ts";
import { one, session } from "../../test-support/connections.ts";
import { createTestDatabase, fingerprint, queryAs, type TestDatabase } from "../../test-support/database.ts";
import { type MailFixture, mail } from "../../test-support/items.ts";
import { batchOf, stored } from "../../test-support/pipeline-fixtures.ts";
import { eventLogger, recordingLogger } from "../../test-support/recording.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../../test-support/timeouts.ts";
import { namedScope } from "../../write/named-binding.ts";
import { createWriter, type Writer } from "../../write/writer.ts";
import { type Admin, createAdmin } from "../admin.ts";

// No model is called. Synthetic people on reserved domains only. One database for the file; each
// case uses names of its own.

const OWN = ["own"];

type World = { db: TestDatabase; writer: Writer; pipeline: Pipeline; admin: Admin; accounts: Accounts };
let w: World;

const ME: Who = { address: OWNER.personal, name: OWNER.name };
const ADA: Who = { address: "ada.fenn@goal-names-one.test", name: "Ada Fenn" };
const CORA: Who = { address: "cora.vance@goal-names-two.test", name: "Cora Vance" };

let letters = 0;
const letter = (from: Who, to: Who[], labels: string[] = ["INBOX"]): MailFixture => {
  letters += 1;
  const n = String(letters).padStart(4, "0");
  return mail({
    id: `gm-gtn-${n}`,
    threadId: `thread-gtn-${n}`,
    messageId: `gtn-${n}@goal-target-names.test`,
    at: "2026-09-10T09:00:00Z",
    from,
    to,
    subject: "A note",
    labels,
  });
};

const addressFp = (address: string): string => fingerprint(w.db.keys, "address", address);
const nameFp = (name: string): string => fingerprint(w.db.keys, "name", name);
const keyFpOf = (name: string, label: string[] = OWN): string =>
  addressFp(namedKey(fingerprint(w.db.keys, "source_id", namedScope(nameFp(name), label, null))) ?? "");
const holderOf = async (fp: string): Promise<string | undefined> =>
  (
    await queryAs<{ entity_id: string }>(
      w.db.urls.admin,
      "select entity_id from knowledge.accounts where value_fp = $1 limit 1",
      [fp],
    )
  )[0]?.entity_id;
const targetOf = async (goal: string): Promise<string | null> =>
  one(
    await queryAs<{ target: string | null }>(
      w.db.urls.admin,
      "select target_entity_id as target from projections.goal_state where goal_id = $1",
      [goal],
    ),
  ).target;
const sync = () => w.writer.bindNamed(new Date());
let requests = 0;
const req = (): string => `gtn-req-${(requests += 1)}`;
const goal = (statement: string): Promise<GoalId> =>
  w.admin.work.addGoal(statement, "own", { requestId: req(), domain: "career" });

// A first-hand relation from Ada naming `name`, filed on a letter of Ada's, as the pipeline files it.
async function mentioned(name: string): Promise<string> {
  const evidence = await stored(w.writer, w.accounts.personalMail, letter(ADA, [ME]));
  const mention = FiledMention.parse({
    name,
    type: "relationship",
    field: "counterparty",
    firstHand: true,
    subjectFp: addressFp(ADA.address),
    speakerFp: addressFp(ADA.address),
  });
  expect(await w.pipeline.commit(batchOf(evidence, [], { unresolved: 1, mentions: [mention] }))).toBe("committed");
  return evidence;
}

// The command item's binding of its name, with its id.
const commandBindings = (goalId: string) =>
  queryAs<{ id: MentionBindingId; origin: string; address_fp: string; lifted: boolean }>(
    w.db.urls.admin,
    `select b.id, b.origin, b.address_fp, b.lifted_at is not null as lifted from knowledge.mention_bindings b
     join knowledge.owner_decisions d on d.details -> 'named' ->> 'item' = b.evidence_id and d.details -> 'named' ->> 'name' = b.mention_fp
     where d.target_id = $1 order by b.created_at, b.id`,
    [goalId],
  );

beforeAll(async () => {
  const db = await createTestDatabase({ compartments: ["own", "employer:example"] });
  const writer = createWriter({
    url: db.urls.writer,
    keys: db.keys,
    log: eventLogger(),
    journal: journalPath(db.keyFile),
  });
  const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: recordingLogger().log });
  const admin = createAdmin({
    url: db.urls.admin,
    keys: db.keys,
    log: recordingLogger().log,
    journal: journalPath(db.keyFile),
  });
  w = { db, writer, pipeline, admin, accounts: await connect(writer) };
  // Cora: the owner wrote to Cora, so Cora holds that name under `own`.
  await stored(writer, w.accounts.personalMail, letter(ME, [CORA], ["SENT"]));
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await w?.admin.close();
  await w?.pipeline.close();
  await w?.writer.close();
  await w?.db.drop();
}, SLOW_DB_TEST_TIMEOUT);

describe("pia goal target --name", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("pia goal target --name makes a named person when nobody holds the name, and a later mention binds to it", async () => {
    const id = await goal("Meet a landscape architect.");
    expect(await w.admin.work.targetGoalByName(id, "Theo Marsh", { requestId: req() })).toEqual({ kind: "pending" });
    // The owner command made nobody: an item, its filed row and the owner's pending decision, no entity.
    expect(await holderOf(keyFpOf("Theo Marsh"))).toBeUndefined();
    expect(await targetOf(id)).toBeNull();
    const [decision] = await queryAs<{ details: { entity: null; named: { item: string; name: string } } }>(
      w.db.urls.admin,
      "select details from knowledge.owner_decisions where kind = 'goal_target' and target_id = $1",
      [id],
    );
    expect(decision?.details).toMatchObject({ entity: null, named: { name: nameFp("Theo Marsh") } });
    const item = decision?.details.named.item ?? "";
    expect(
      one(
        await queryAs<{ source_kind: string; compartments: string[] }>(
          w.db.urls.admin,
          "select source_kind, compartments from vault.evidence_items where id = $1",
          [item],
        ),
      ),
    ).toEqual({ source_kind: "owner_command", compartments: OWN });
    expect(
      await queryAs(
        w.db.urls.admin,
        "select 1 from vault.unresolved_mentions where evidence_id = $1 and name_fp = $2",
        [item, nameFp("Theo Marsh")],
      ),
    ).toHaveLength(1);

    // The writer's next sync makes the named person by its full-name key, and the goal's target
    // follows the binding.
    expect(await sync()).toMatchObject({ commanded: 1, created: 1, bound: 1, failed: 0 });
    const theo = await holderOf(keyFpOf("Theo Marsh"));
    expect(theo).toBeDefined();
    expect(
      one(
        await queryAs<{ named: boolean }>(w.db.urls.admin, "select named from knowledge.entities where id = $1", [
          theo,
        ]),
      ).named,
    ).toBe(true);
    expect(await targetOf(id)).toBe(theo);
    expect(await sync()).toMatchObject({ commanded: 0, created: 0, bound: 0 });

    // Ada's later mention of the name under the label binds to the same person and makes nobody.
    const later = await mentioned("Theo Marsh");
    expect(await sync()).toMatchObject({ created: 0, bound: 1 });
    expect(
      one(
        await queryAs<{ address_fp: string }>(
          w.db.urls.admin,
          "select address_fp from knowledge.mention_bindings where evidence_id = $1",
          [later],
        ),
      ).address_fp,
    ).toBe(keyFpOf("Theo Marsh"));

    // The projection rebuilt from the owner's decisions alone keeps the target, by the binding.
    await w.admin.work.rebuildGoalState();
    expect(await targetOf(id)).toBe(theo);
  });

  it("lists the people holding the name under the goal's label, and sets the one the owner picks with --entity", async () => {
    const theo = (await holderOf(keyFpOf("Theo Marsh"))) as EntityId;
    const cora = (await holderOf(addressFp(CORA.address))) as EntityId;
    const id = await goal("Find a garden designer.");
    expect(await w.admin.work.targetGoalByName(id, "Theo Marsh", { requestId: req() })).toEqual({
      kind: "holders",
      holders: [{ entity: theo, established: false, named: true, lastSeen: null, name: { untrusted: "Theo Marsh" } }],
    });
    expect(await w.admin.work.targetGoalByName(id, "Cora Vance", { requestId: req() })).toEqual({
      kind: "holders",
      holders: [
        {
          entity: cora,
          established: true,
          named: false,
          lastSeen: "2026-09-10T09:00:00.000Z",
          name: { untrusted: "Cora Vance" },
        },
      ],
    });
    // Listing writes nothing.
    expect(await targetOf(id)).toBeNull();
    expect(
      await queryAs(
        w.db.urls.admin,
        "select 1 from knowledge.owner_decisions where kind = 'goal_target' and target_id = $1",
        [id],
      ),
    ).toEqual([]);
    expect(await w.admin.work.targetGoalByName(id, "Theo Marsh", { requestId: req(), entity: theo })).toEqual({
      kind: "set",
      entity: theo,
    });
    expect(await targetOf(id)).toBe(theo);
    // One who does not hold the name is not the owner's pick.
    await expect(
      w.admin.work.targetGoalByName(id, "Theo Marsh", { requestId: req(), entity: cora }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await targetOf(id)).toBe(theo);
    // A name of one word, and a goal that does not exist.
    await expect(w.admin.work.targetGoalByName(id, "Theo", { requestId: req() })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    expect(
      await w.admin.work.targetGoalByName(`gol_${"0".repeat(26)}` as GoalId, "Theo Marsh", { requestId: req() }),
    ).toBeNull();
  });

  it("a named person a goal targets is never removed, though nothing else names them; one no goal targets is", async () => {
    const kept = await mentioned("Lio Park");
    const gone = await mentioned("Uma Rees");
    expect(await sync()).toMatchObject({ created: 2, bound: 2 });
    const lio = (await holderOf(keyFpOf("Lio Park"))) as EntityId;
    const uma = (await holderOf(keyFpOf("Uma Rees"))) as EntityId;
    const id = await goal("Talk to a gallery owner.");
    expect(await w.admin.work.targetGoalByName(id, "Lio Park", { requestId: req(), entity: lio })).toEqual({
      kind: "set",
      entity: lio,
    });
    // Nothing names either any more: their bindings and filed rows gone, no claim ever made.
    for (const evidence of [kept, gone]) {
      await queryAs(w.db.urls.admin, "delete from knowledge.mention_bindings where evidence_id = $1", [evidence]);
      await queryAs(w.db.urls.admin, "delete from vault.unresolved_mentions where evidence_id = $1", [evidence]);
    }
    await sync();
    expect(await holderOf(keyFpOf("Lio Park"))).toBe(lio);
    expect(await holderOf(keyFpOf("Uma Rees"))).toBeUndefined();
    expect(uma).toBeDefined();
    expect(await targetOf(id)).toBe(lio);
  });

  it("a repeated request id writes nothing more", async () => {
    const id = await goal("Meet a bookbinder.");
    const request = req();
    expect(await w.admin.work.targetGoalByName(id, "Wren Hale", { requestId: request })).toEqual({ kind: "pending" });
    expect(await w.admin.work.targetGoalByName(id, "Wren Hale", { requestId: request })).toEqual({ kind: "pending" });
    expect(
      one(
        await queryAs<{ n: number }>(
          w.db.urls.admin,
          "select count(*)::int as n from knowledge.owner_decisions where target_id = $1 and kind = 'goal_target'",
          [id],
        ),
      ).n,
    ).toBe(1);
    expect(await sync()).toMatchObject({ commanded: 1, created: 1 });
  });

  it("the person a goal names by name stays while its command item does; the owner's unbind clears the target; erasing the goal removes the person at the next sync", async () => {
    const id = await goal("Meet a stonemason.");
    expect(await w.admin.work.targetGoalByName(id, "Ivo Blake", { requestId: req() })).toEqual({ kind: "pending" });
    expect(await sync()).toMatchObject({ created: 1 });
    const ivo = await holderOf(keyFpOf("Ivo Blake"));
    expect(await targetOf(id)).toBe(ivo);
    // No claim names Ivo; the command item's live binding keeps Ivo.
    expect((await sync()).removed).toBe(0);
    expect(await holderOf(keyFpOf("Ivo Blake"))).toBe(ivo);

    // The owner's unbind of the code binding clears the target; the next sync splits it, as the split
    // of any code binding does, and the target follows the new binding.
    const [binding] = await commandBindings(id);
    expect(binding).toMatchObject({ origin: "code", lifted: false });
    expect(await w.admin.mentions.unbindMention(binding?.id as MentionBindingId, { requestId: req() })).toBe(true);
    expect(await targetOf(id)).toBeNull();
    expect(await sync()).toMatchObject({ commanded: 1, created: 1, bound: 1 });
    const split = (await commandBindings(id)).filter((one) => !one.lifted);
    expect(split).toHaveLength(1);
    const after = await holderOf(split[0]?.address_fp ?? "");
    expect(after).toBeDefined();
    expect(after).not.toBe(ivo);
    expect(await targetOf(id)).toBe(after);

    // The owner's erasure of the goal erases its command item with the goal's own (two items): the
    // erasure's cleanup takes the alias the item cited and the account nothing else cites, as an
    // item's deletion does (SD-B7), and the next sync makes nobody again.
    expect(await w.admin.erasure.eraseGoal(id, { requestId: req() })).toMatchObject({ items: 2 });
    expect(
      await queryAs(
        w.db.urls.admin,
        "select 1 from knowledge.accounts where entity_id = $1 union all select 1 from knowledge.aliases where entity_id = $1",
        [after],
      ),
    ).toEqual([]);
    expect(await sync()).toMatchObject({ commanded: 0, created: 0, bound: 0, failed: 0 });
    // The goal's other command item's person, made by an earlier case, stays.
    expect(await holderOf(keyFpOf("Theo Marsh"))).toBeDefined();
  });
});

describe("a goal's target by an organization's name", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  const orgRows = (entity: string) =>
    queryAs(w.db.urls.admin, "select 1 from knowledge.org_names where entity_id = $1", [entity]);

  it("a one-word name is taken; with nobody holding it, the next sync makes the organization and the target follows", async () => {
    const id = await goal("Find a role in clinic operations");
    expect(await w.admin.work.targetGoalByName(id, "Northwind", { requestId: req(), organization: true })).toEqual({
      kind: "pending",
    });
    expect(await targetOf(id)).toBeNull();
    expect(await sync()).toMatchObject({ commanded: 1, orgMade: 1, orgBound: 1, failed: 0 });
    const target = await targetOf(id);
    expect(target).not.toBeNull();
    expect(await orgRows(target as string)).toHaveLength(1);
    // The sync after makes no second one, and its stale-row sweep leaves the owner's word standing.
    expect(await sync()).toMatchObject({ commanded: 0, orgMade: 0, orgBound: 0, orgRemoved: 0 });
    expect(await targetOf(id)).toBe(target);

    // A second goal naming it finds the holder and binds to the pick.
    const second = await goal("Meet the clinic's operations lead");
    const held = await w.admin.work.targetGoalByName(second, " Northwind ", { requestId: req(), organization: true });
    expect(held).toEqual({
      kind: "holders",
      holders: [{ entity: target, established: false, named: true, lastSeen: null, name: { untrusted: "Northwind" } }],
    });
    expect(
      await w.admin.work.targetGoalByName(second, "Northwind", {
        requestId: req(),
        organization: true,
        entity: target as EntityId,
      }),
    ).toEqual({ kind: "set", entity: target });
    expect(await targetOf(second)).toBe(target);
  });

  it("a person's name of one word is still refused without --org", async () => {
    const id = await goal("Find a role in clinic research");
    await expect(w.admin.work.targetGoalByName(id, "Northwind", { requestId: req() })).rejects.toMatchObject({
      code: "invalid_argument",
    });
  });

  it("the goal's erasure takes the name row and the target, and the next sync makes nobody", async () => {
    const id = await goal("Find a role at a hospital group");
    await w.admin.work.targetGoalByName(id, "Harbor Hospitals", { requestId: req(), organization: true });
    await sync();
    const target = await targetOf(id);
    expect(target).not.toBeNull();
    await w.admin.erasure.eraseGoal(id, { requestId: req() });
    expect(await orgRows(target as string)).toEqual([]);
    expect(await sync()).toMatchObject({ commanded: 0, orgMade: 0, orgBound: 0, failed: 0 });
  });
});

// Invariant 10: the erasure of the person a goal targets leaves the goal targeting no one and its
// decision tainted, naming no one; an erasure killed after its journal line is finished by the
// replay, as a restore's replay is.
describe("a person's erasure reaches the goals that target them", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  const kill = (statement: string): Promise<void> =>
    session(w.db.urls.bootstrap, async (query) => {
      await query("set role pi_owner");
      await query(statement);
    });

  it("the owner's goal targets no one after the replay, and a rebuild sets no target from its decision", async () => {
    const dana: Who = { address: "dana.moss@goal-names-three.test", name: "Dana Moss" };
    await stored(w.writer, w.accounts.personalMail, letter(ME, [dana], ["SENT"]));
    const person = (await holderOf(addressFp(dana.address))) as EntityId;
    expect(person).toBeDefined();
    const id = await goal("Hire the designer.");
    expect(await w.admin.work.setGoalTarget(id, person, { requestId: req() })).toBe(true);
    expect(await targetOf(id)).toBe(person);
    await kill("alter table knowledge.removed_evidence add constraint test_kill check (false) not valid");
    await expect(w.admin.erasure.erasePerson(person, { requestId: req() })).rejects.toMatchObject({
      code: "unavailable",
    });
    await kill("alter table knowledge.removed_evidence drop constraint test_kill");
    expect(await targetOf(id)).toBe(person);
    expect(await w.admin.erasure.replayErasures()).toEqual({ applied: 1, journalled: 0 });
    expect(await targetOf(id)).toBeNull();
    expect(
      await queryAs(
        w.db.urls.admin,
        "select details ->> 'entity' as entity, tainted_at is not null as tainted from knowledge.owner_decisions where kind = 'goal_target' and target_id = $1",
        [id],
      ),
    ).toEqual([{ entity: null, tainted: true }]);
    await w.admin.work.rebuildGoalState();
    expect(await targetOf(id)).toBeNull();
  });
});
