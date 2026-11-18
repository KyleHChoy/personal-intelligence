import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntityId, RulingId, UntrustedString } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { testId } from "../test-support/clients.ts";
import { type Message, worldMessages } from "../test-support/commitment-fixtures.ts";
import { session } from "../test-support/connections.ts";
import { fingerprint, queryAs } from "../test-support/database.ts";
import { seedFacts } from "../test-support/fact-fixtures.ts";
import { seeder } from "../test-support/seeder.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue, registration } from "../test-support/values.ts";
import { buildAs, warmthWorld } from "../test-support/warmth-fixtures.ts";
import { seedWorld, WORLD_NOW } from "../test-support/world.ts";

// The owner's name for a person: it outranks every alias wherever the person is named (ownerWho, whoOf
// for the owner's page and agents, their tiers list, search and paths), a new name, a clear and the Undo
// of either each lift what was in force, and erasing the person removes it. Synthetic people on reserved
// domains only.

const DAY_MS = 86_400_000;
const daysAgo = (days: number): string => new Date(WORLD_NOW.getTime() - days * DAY_MS).toISOString();
const OWN = ["own"];

let store: TestStore;
let ada: EntityId;
let bo: EntityId;
let token: string;
let dir: string | undefined;
let n = 0;
const req = (): string => `person-names-${String((n += 1)).padStart(4, "0")}`;
const text = (value: UntrustedString | string | null | undefined): string | null =>
  value === null || value === undefined ? null : typeof value === "string" ? value : value.untrusted;

// The name each read gives the person.
type Named = {
  who: string | null;
  page: string | null;
  panel: string | null;
  tiers: string | null;
  path: string | null;
  agent: string | null;
};
async function namesOf(person: EntityId): Promise<Named> {
  const tiers = (await store.admin.tiers.peopleTiers()).people.find((row) => row.entity === person);
  const path = (await store.admin.people.paths(person))?.paths[0]?.nodes.at(-1);
  return {
    who: text((await store.admin.names.who([person])).get(person)?.name),
    page: text((await store.admin.people.entityPage(person))?.entity.name),
    panel: text((await store.admin.people.person(person))?.who.name),
    tiers: text(tiers?.name),
    path: text(path?.name),
    agent: text(outcomeValue(await store.reader.getEntity(token, { id: person })).names[0]),
  };
}
const everywhere = (name: string | null): Named => ({
  who: name,
  page: name,
  panel: name,
  tiers: name,
  path: name,
  agent: name,
});

beforeAll(async () => {
  store = await openStore({ now: WORLD_NOW, compartments: ["own", "employer:example"] });
  const world = await seedWorld(store.writer, store.admin);
  const warmth = warmthWorld(store.db);
  const people: EntityId[] = [];
  for (const exchanges of [3, 2]) {
    const person = (await warmth.person(OWN)) as EntityId;
    // Each seeder gives its first account the same address: each person here gets one of their own.
    await queryAs(store.db.urls.writer, "update knowledge.accounts set value_fp = $2 where entity_id = $1", [
      person,
      fingerprint(store.db.keys, "address", `${person}@person-names.test`),
    ]);
    for (let k = 0; k < exchanges; k += 1) {
      const thread = testId("thr");
      await warmth.mail(OWN, { at: daysAgo(3 + k * 7), to: [person], thread });
      await warmth.mail(OWN, { at: daysAgo(3 + k * 7 - 0.1), from: person, thread });
    }
    people.push(person);
  }
  [ada, bo] = people as [EntityId, EntityId];
  // One belief in the owner's audience, so their owner reads are built: about two others, as admin-people's.
  const [cy, di] = [await warmth.person(OWN), await warmth.person(OWN)];
  const messages = await worldMessages(store);
  const on = messages.find((one) => one.compartment === "own") as Message;
  await seedFacts(
    store,
    world.ownerEntity(),
    [
      {
        key: "rel-cy-di",
        type: "relationship",
        kind: "relationship",
        subject: cy,
        by: cy,
        message: on,
        fields: { counterparty: di, note: "a note" },
        fieldKinds: { note: "text" },
        values: { counterparty: di },
        entities: [cy, di],
      },
    ],
    [OWN],
  );
  await buildAs(store.db, OWN);
  ({ token } = await store.admin.clients.addClient(registration("person-names", OWN)));
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await store?.close();
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

describe("the owner's name for a person", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("the owner's name outranks every alias in every read that names them, and the owner's search finds it", async () => {
    const alias = (await namesOf(ada)).who;
    expect(alias).not.toBeNull();
    expect(await namesOf(ada)).toEqual(everywhere(alias));
    const ruling = await store.admin.identity.namePerson(ada, "  Ada Example-Person ", { requestId: req() });
    expect(await namesOf(ada)).toEqual(everywhere("Ada Example-Person"));
    expect((await store.admin.people.person(ada))?.nameRuling).toBe(ruling);
    expect((await store.admin.search.entities("ada example")).hits.map((hit) => hit.who.id)).toContain(ada);
    // The owner's agent's search and its people answer it too.
    expect(
      outcomeValue(await store.reader.search(token, { query: "Ada Example-Person" })).results.find(
        (one) => one.id === ada,
      )?.name,
    ).toEqual({ untrusted: "Ada Example-Person" });
    // The decision names the person and holds no name; the row is sealed under the person's label.
    const [decision] = await queryAs(
      store.db.urls.admin,
      "select kind, target_kind, target_id, body_enc from knowledge.owner_decisions where id = $1",
      [ruling],
    );
    expect(decision).toEqual({ kind: "person_name", target_kind: "entity", target_id: ada, body_enc: null });
    const rows = await queryAs<{ compartments: string[]; text: string }>(
      store.db.urls.admin,
      "select compartments, name_enc::text as text from knowledge.person_names where ruling_id = $1",
      [ruling],
    );
    expect(rows.map((row) => row.compartments)).toEqual([OWN]);
    expect(rows[0]?.text).not.toContain("Ada");
    // Bo keeps the alias.
    expect((await namesOf(bo)).who).not.toBe("Ada Example-Person");
  });

  it("a new name lifts the old, its Undo puts the old back, a clear returns to the aliases, and the Undo of a clear names them again", async () => {
    const second = await store.admin.identity.namePerson(ada, "Ada Second-Name", { requestId: req() });
    expect((await namesOf(ada)).who).toBe("Ada Second-Name");
    // A repeated request writes nothing more.
    const repeat = req();
    const third = await store.admin.identity.namePerson(ada, "Ada Third-Name", { requestId: repeat });
    expect(await store.admin.identity.namePerson(ada, "Ada Third-Name", { requestId: repeat })).toBe(third);
    expect(
      await queryAs(
        store.db.urls.admin,
        "select count(*)::int as n from knowledge.person_names where lifted_at is null",
      ),
    ).toEqual([{ n: 1 }]);
    // Undo of the third: the second is back, everywhere.
    const undo = await store.admin.identity.liftPersonName(third, { requestId: req() });
    expect(await namesOf(ada)).toEqual(everywhere("Ada Second-Name"));
    // The second's effect was undone too: an Undo of a ruling no longer in force is refused.
    await expect(store.admin.identity.liftPersonName(third, { requestId: req() })).rejects.toMatchObject({
      code: "not_found",
    });
    // The Undo of the Undo names them the third again.
    await store.admin.identity.liftPersonName(undo, { requestId: req() });
    expect((await namesOf(ada)).who).toBe("Ada Third-Name");
    // A clear: the aliases name them again, everywhere; nothing of the owner's is live.
    const cleared = await store.admin.identity.namePerson(ada, null, { requestId: req() });
    const named = await namesOf(ada);
    expect(named.who).not.toMatch(/^Ada /);
    expect(named).toEqual(everywhere(named.who));
    expect((await store.admin.people.person(ada))?.nameRuling).toBeNull();
    // A second clear has nothing to clear.
    await expect(store.admin.identity.namePerson(ada, null, { requestId: req() })).rejects.toMatchObject({
      code: "not_found",
    });
    // Undo of the clear: the owner's name is back.
    await store.admin.identity.liftPersonName(cleared, { requestId: req() });
    expect((await namesOf(ada)).who).toBe("Ada Third-Name");
    expect(second).not.toBe(third);
  });

  // A name is held by the group's ids as well as its
  // addresses, so a person known by a name alone is named, and a record that later holds one of
  // their addresses is named too.
  it("names a person known by a name alone, and a record that later holds a named person's address", async () => {
    const named = await session(store.db.urls.admin, async (query) => {
      const seed = seeder(store.db, query);
      const made = await seed.entity("person");
      await seed.alias(OWN, made);
      return made as EntityId;
    });
    expect(
      await queryAs(store.db.urls.admin, "select count(*)::int as n from knowledge.accounts where entity_id = $1", [
        named,
      ]),
    ).toEqual([{ n: 0 }]);
    const ruling = await store.admin.identity.namePerson(named, "Known By Name", { requestId: req() });
    expect(text((await store.admin.names.who([named])).get(named)?.name)).toBe("Known By Name");
    expect(text((await store.admin.people.entityPage(named))?.entity.name)).toBe("Known By Name");
    const [row] = await queryAs<{ entity_ids: string[]; value_fps: string[]; compartments: string[] }>(
      store.db.urls.admin,
      "select entity_ids, value_fps, compartments from knowledge.person_names where ruling_id = $1",
      [ruling],
    );
    expect(row).toEqual({ entity_ids: [named], value_fps: [], compartments: OWN });
    await store.admin.identity.liftPersonName(ruling, { requestId: req() });
    expect(text((await store.admin.names.who([named])).get(named)?.name)).not.toBe("Known By Name");

    // A record minted later on one of Ada's addresses is named by the owner's name for Ada.
    const [fp] = (
      await queryAs<{ value_fp: string }>(
        store.db.urls.admin,
        "select value_fp from knowledge.accounts where entity_id = $1",
        [ada],
      )
    ).map((one) => one.value_fp);
    const later = await session(store.db.urls.admin, async (query) => {
      const seed = seeder(store.db, query);
      const made = await seed.entity("person");
      await seed.account(OWN, made);
      return made as EntityId;
    });
    await queryAs(store.db.urls.writer, "update knowledge.accounts set value_fp = $2 where entity_id = $1", [
      later,
      fp,
    ]);
    const adas = text((await store.admin.names.who([ada])).get(ada)?.name);
    expect(adas).toMatch(/^Ada /);
    expect(text((await store.admin.names.who([later])).get(later)?.name)).toBe(adas);
    await queryAs(store.db.urls.writer, "update knowledge.accounts set value_fp = $2 where entity_id = $1", [
      later,
      fingerprint(store.db.keys, "address", `${later}@person-names.test`),
    ]);
  });

  it("refuses a name for no person, an empty name and a control character, writing nothing", async () => {
    const count = async () =>
      (await queryAs<{ n: number }>(store.db.urls.admin, "select count(*)::int as n from knowledge.owner_decisions"))[0]
        ?.n;
    const before = await count();
    const organization = (
      await queryAs<{ id: EntityId }>(
        store.db.urls.admin,
        "select id from knowledge.entities where kind = 'organization' order by id limit 1",
      )
    )[0]?.id;
    if (organization === undefined) throw new Error("the world holds no organization");
    await expect(store.admin.identity.namePerson(organization, "Org", { requestId: req() })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      store.admin.identity.namePerson(`ent_${"0".repeat(25)}9` as EntityId, "Nobody", { requestId: req() }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(store.admin.identity.namePerson(bo, "   ", { requestId: req() })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(store.admin.identity.namePerson(bo, "Bo\nName", { requestId: req() })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(
      store.admin.identity.liftPersonName(`rul_${"0".repeat(25)}9` as RulingId, { requestId: req() }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await count()).toBe(before);
  });

  it("erasing the person removes the owner's names for them, lifted ones too; the owner's decisions stay", async () => {
    const ruling = await store.admin.identity.namePerson(bo, "Bo Example-Person", { requestId: req() });
    await store.admin.identity.namePerson(bo, "Bo Renamed-Person", { requestId: req() });
    const fps = (
      await queryAs<{ value_fp: string }>(
        store.db.urls.admin,
        "select value_fp from knowledge.accounts where entity_id = $1",
        [bo],
      )
    ).map((row) => row.value_fp);
    const held = async () =>
      (
        await queryAs<{ n: number }>(
          store.db.urls.admin,
          "select count(*)::int as n from knowledge.person_names where entity_ids && array[$2] or value_fps && $1::text[]",
          [fps, bo],
        )
      )[0]?.n;
    expect(await held()).toBe(2);
    dir = await mkdtemp(join(tmpdir(), "pi-person-names-"));
    const eraser = new Admin({
      pool: store.adminPool,
      keys: store.db.keys,
      log: store.log,
      journal: join(dir, "keys.json.erasures"),
    });
    const dry = await eraser.erasure.erasePerson(bo, { requestId: req(), dryRun: true });
    expect(dry.more.person_names).toBe(2);
    const report = await eraser.erasure.erasePerson(bo, { requestId: req() });
    expect(report.more.person_names).toBe(2);
    expect(await held()).toBe(0);
    expect(
      await queryAs(store.db.urls.admin, "select id from knowledge.owner_decisions where id = $1", [ruling]),
    ).toEqual([{ id: ruling }]);
    // Ada's name stands, once the owner's warmth is built again.
    await buildAs(store.db, OWN);
    expect((await namesOf(ada)).who).toBe("Ada Third-Name");
  });
});
