import { BELIEF_TYPES } from "@intelligence/contracts/personal";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { createPipeline, createReader } from "@intelligence/personal-store";
import { fingerprint, queryAs, type TestDatabase } from "@intelligence/personal-store/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  builtOnce,
  type Env,
  evidenceOf,
  findFacts,
  pi,
  quiet,
  type Synced,
  withAdmin,
} from "../test-support/extract-fixtures.ts";

// The world names Bryn Calder by name alone in one message, and the owner has written to Bryn, so
// Bryn is the established candidate.

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const made: Synced[] = [];
afterEach(async () => {
  for (const one of made.splice(0)) await one.drop();
});

// The beliefs computed for every audience, each active client's and the owner's, as of the
// database's clock, that rest on one of the stored claims named.
async function beliefsOn(db: TestDatabase, claims: readonly string[]) {
  const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: quiet });
  try {
    return (await pipeline.sweepBeliefs(BELIEF_TYPES)).flatMap(({ records }) =>
      records.filter((record) =>
        record.belief.support.some((id) => claims.includes(fingerprint(db.keys, "claim", id))),
      ),
    );
  } finally {
    await pipeline.close();
  }
}

type World = Synced & { calls: string[]; extract(): Promise<number>; bryn: string; item: string; token: string };

// The world, synced and extracted once; `calls` then collects the evidence id of each live call of
// every later run. Built once for the file; each test gets a copy, with the reader's token.
const extractedOnce = builtOnce(async (s) => {
  expect((await pi(["extract"], s.pipeline, { deps: { model: fakeModelClient(s.outputs) } })).exit).toBe(0);
  const [person] = await queryAs<{ entity_id: string }>(
    s.db.urls.admin,
    "select entity_id from knowledge.accounts where value_fp = $1",
    [fingerprint(s.db.keys, "address", s.w.handles.nameMentionAddress)],
  );
  if (person === undefined) throw new Error("the world's named person is not stored");
  const token = await withAdmin(
    s.db,
    async (admin) =>
      (
        await admin.clients.addClient({
          name: "mentions-reader",
          runtime: "local",
          vendorRetention: "unknown",
          compartments: ["own", "employer:example"],
          views: ["self", "people", "work"],
          tools: ["find_facts", "get_entity", "search"],
        })
      ).token,
  );
  return { bryn: person.entity_id, token };
});
async function extracted(): Promise<World> {
  const {
    s,
    made: { bryn, token },
  } = await extractedOnce();
  made.push(s);
  const calls: string[] = [];
  const extract = async (env: Env = {}) =>
    (await pi(["extract"], { ...s.pipeline, ...env }, { deps: { model: fakeModelClient(s.outputs, calls) } })).exit;
  return { ...s, calls, extract, bryn, item: evidenceOf(s, s.w.handles.nameMentionMessageId), token };
}

const filedOf = (w: World) =>
  queryAs<{ id: string }>(
    w.db.urls.admin,
    "select id from vault.unresolved_mentions where evidence_id = $1 order by id",
    [w.item],
  );

const json = (result: { exit: number; stdout: string }): unknown => {
  expect(result.exit).toBe(0);
  return JSON.parse(result.stdout) as unknown;
};

// What three tools answer about the named person, and the facts of the naming message.
async function answers(w: World): Promise<unknown> {
  const reader = createReader({ url: w.db.urls.reader, keys: w.db.keys, log: quiet });
  try {
    const entity = await reader.getEntity(w.token, { id: w.bryn as never });
    const search = await reader.search(w.token, { query: "Bryn Calder" } as never);
    const facts = await findFacts(w.db, w.token);
    return { entity, search, facts };
  } finally {
    await reader.close();
  }
}

// The facts the naming message holds now, by type and subject.
async function factsOfItem(w: World): Promise<{ type: string; subject: string | null }[]> {
  const ids = (
    await queryAs<{ id: string }>(w.db.urls.admin, "select id from knowledge.claims where evidence_id = $1", [w.item])
  ).map((row) => row.id);
  return (await findFacts(w.db, w.token)).facts
    .filter((fact) => ids.includes(fact.id))
    .map((fact) => ({ type: fact.type, subject: fact.subject.id }));
}

describe("mentions end to end", () => {
  it("B6: an unresolved mention changes no tool's answer; after the owner binds it, the next run's replay yields its claim and buys no call", async () => {
    const w = await extracted();
    const [filed] = await filedOf(w);
    expect(filed).toBeDefined();
    expect(await factsOfItem(w)).toEqual([]);

    const withRow = await answers(w);
    const [row] = await queryAs<Record<string, unknown>>(
      w.db.urls.admin,
      "select * from vault.unresolved_mentions where id = $1",
      [filed?.id],
    );
    await queryAs(w.db.urls.admin, "delete from vault.unresolved_mentions where id = $1", [filed?.id]);
    expect(await answers(w)).toEqual(withRow);
    await queryAs(
      w.db.urls.admin,
      "insert into vault.unresolved_mentions (id, evidence_id, extractor_generation, name_fp, facts_enc, compartments) values ($1, $2, $3, $4, $5, $6)",
      [row?.id, row?.evidence_id, row?.extractor_generation, row?.name_fp, row?.facts_enc, row?.compartments],
    );

    const listed = json(await pi(["identity", "mentions"], w.admin)) as Record<string, unknown>[];
    expect(listed[0]).toEqual({
      mention: filed?.id,
      count: 1,
      entity: w.bryn,
      established: true,
      type: "role",
      field: "subject",
    });
    expect(JSON.stringify(listed)).not.toContain("Bryn");
    expect(
      (
        json(await pi(["identity", "mentions", "--limit", "1"], w.admin, { tty: true })) as Record<string, unknown>[]
      )[0],
    ).toMatchObject({ entity: w.bryn, name: "Bryn Calder" });

    const { binding } = json(await pi(["identity", "bind", filed?.id ?? "", w.bryn], w.admin)) as { binding: string };
    expect(binding).toMatch(/^mbd_/);
    expect(await w.extract()).toBe(0);
    expect(w.calls).toEqual([]);
    expect(await factsOfItem(w)).toEqual([{ type: "role", subject: w.bryn }]);
    expect(await filedOf(w)).toEqual([]);
    // Nothing else is listed for that name now.
    expect(
      (json(await pi(["identity", "mentions"], w.admin)) as unknown[]).filter(
        (one) => (one as { mention: string }).mention === filed?.id,
      ),
    ).toEqual([]);
  });

  // A bind takes a filed mention, and a run that resolved the name files none, so a second bind
  // needs the run after the unbind: the unbind's own removal is asserted before that run.
  it("an unbind removes the claim at once; bound to B and lifted, then bound to A before any run, the next run's claim names A", async () => {
    const w = await extracted();
    const [filed] = await filedOf(w);
    // Another person of the same compartment, whom nothing names: the owner's binding is theirs to make.
    const [other] = await queryAs<{ entity_id: string }>(
      w.db.urls.admin,
      "select a.entity_id from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where e.kind = 'person' and a.compartments = '{own}' and a.entity_id <> $1 order by a.id limit 1",
      [w.bryn],
    );
    const { binding } = json(await pi(["identity", "bind", filed?.id ?? "", w.bryn], w.admin)) as { binding: string };
    expect(await w.extract()).toBe(0);
    expect(await factsOfItem(w)).toEqual([{ type: "role", subject: w.bryn }]);
    expect(json(await pi(["identity", "unbind", binding], w.admin))).toEqual({ unbound: binding });
    // Gone with the unbind itself, not by the next run's commit.
    expect(await factsOfItem(w)).toEqual([]);
    expect(await w.extract()).toBe(0);
    const [again] = await filedOf(w);
    expect(await factsOfItem(w)).toEqual([]);
    // Unbound, then bound to the other before any run.
    const { binding: toB } = json(await pi(["identity", "bind", again?.id ?? "", other?.entity_id ?? ""], w.admin)) as {
      binding: string;
    };
    expect(json(await pi(["identity", "unbind", toB], w.admin))).toEqual({ unbound: toB });
    expect(json(await pi(["identity", "bind", again?.id ?? "", w.bryn], w.admin))).toMatchObject({
      binding: expect.stringMatching(/^mbd_/),
    });
    expect(await w.extract()).toBe(0);
    expect(w.calls).toEqual([]);
    expect(await factsOfItem(w)).toEqual([{ type: "role", subject: w.bryn }]);
  });

  it("B7: erasing a person removes their claims, beliefs, filed mentions and bindings; a later replay does not bring them back", async () => {
    const w = await extracted();
    const [filed] = await filedOf(w);
    json(await pi(["identity", "bind", filed?.id ?? "", w.bryn], w.admin));
    expect(await w.extract()).toBe(0);
    expect(await factsOfItem(w)).toEqual([{ type: "role", subject: w.bryn }]);
    const naming = async () =>
      (
        await queryAs<{ n: number }>(
          w.db.urls.admin,
          "select count(*)::int as n from knowledge.claim_entities where entity_id = $1",
          [w.bryn],
        )
      )[0]?.n;

    const claims = (
      await queryAs<{ id: string }>(w.db.urls.admin, "select id from knowledge.claims where evidence_id = $1", [w.item])
    ).map((row) => row.id);
    // The positive control: a belief rests on the item's claims before the erasure.
    expect(await beliefsOn(w.db, claims)).not.toEqual([]);

    const report = json(await pi(["erase", "person", w.bryn], w.admin)) as { more: Record<string, number> };
    expect(report.more).toMatchObject({ mention_bindings: 1 });
    expect(await naming()).toBe(0);
    expect(await queryAs(w.db.urls.admin, "select id from knowledge.mention_bindings")).toEqual([]);
    expect(await beliefsOn(w.db, claims)).toEqual([]);

    // A later replay of every saved call, as a re-derive or a generation raise makes one: every
    // item due again with its calls kept. No call is bought, and nothing names the person again.
    // The naming message's name is filed again, a fact of that message, and is no one's candidate:
    // the person's aliases went with them.
    await queryAs(w.db.urls.admin, "update vault.pipeline_items set waiting = true");
    expect(await w.extract()).toBe(0);
    expect(w.calls).toEqual([]);
    expect(await naming()).toBe(0);
    expect(await factsOfItem(w)).toEqual([]);
    expect(await queryAs(w.db.urls.admin, "select id from knowledge.mention_bindings")).toEqual([]);
    expect(
      (json(await pi(["identity", "mentions"], w.admin)) as { entity: string }[]).filter(
        (one) => one.entity === w.bryn,
      ),
    ).toEqual([]);
  });

  it("refile sets every item with a saved call waiting, keeps the calls, and the next run files their name mentions and buys no call", async () => {
    const w = await extracted();
    // A store from before mentions were filed: the filed mention gone, and the item done.
    await queryAs(w.db.urls.admin, "delete from vault.unresolved_mentions");
    const calls = (await queryAs<{ n: number }>(w.db.urls.admin, "select count(*)::int as n from vault.model_calls"))[0]
      ?.n;
    const { items } = json(await pi(["identity", "refile"], w.admin)) as { items: number };
    expect(items).toBeGreaterThan(0);
    expect(
      (await queryAs<{ n: number }>(w.db.urls.admin, "select count(*)::int as n from vault.model_calls"))[0]?.n,
    ).toBe(calls);
    expect(
      (
        await queryAs<{ n: number }>(
          w.db.urls.admin,
          "select count(*)::int as n from vault.pipeline_items where waiting",
        )
      )[0]?.n,
    ).toBeGreaterThanOrEqual(items);
    expect(await w.extract()).toBe(0);
    expect(w.calls).toEqual([]);
    expect(await filedOf(w)).toHaveLength(1);
  });

  it("bind of an unknown mention or entity is not_found, and an unknown binding's unbind is not_found", async () => {
    const w = await extracted();
    const [filed] = await filedOf(w);
    const failed = (code: string) => expect.stringContaining(`"code":"${code}"`);
    expect(await pi(["identity", "bind", `umn_${"0".repeat(26)}`, w.bryn], w.admin)).toMatchObject({
      exit: 1,
      stdout: "",
      stderr: failed("not_found"),
    });
    expect(await pi(["identity", "bind", filed?.id ?? "", `ent_${"0".repeat(26)}`], w.admin)).toMatchObject({
      exit: 1,
      stdout: "",
      stderr: failed("not_found"),
    });
    expect(await pi(["identity", "unbind", `mbd_${"0".repeat(26)}`], w.admin)).toMatchObject({
      exit: 1,
      stdout: "",
      stderr: failed("not_found"),
    });
    // The positive control: the known mention and person bind.
    expect(json(await pi(["identity", "bind", filed?.id ?? "", w.bryn], w.admin))).toMatchObject({
      binding: expect.stringMatching(/^mbd_/),
    });
  });
});
