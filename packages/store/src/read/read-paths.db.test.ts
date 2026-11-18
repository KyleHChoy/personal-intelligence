import type { Claim } from "@intelligence/contracts";
import { type ClaimRecord, type EntityId, type FindPathsArgs, PathList } from "@intelligence/contracts/personal";
import { afterEach, describe, expect, it } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { bulkClaims } from "../test-support/bulk-claims.ts";
import { type Client, insertReader, type Message, worldMessages } from "../test-support/commitment-fixtures.ts";
import { session } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { knownBy } from "../test-support/known-by.ts";
import { batchOf, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { seeder } from "../test-support/seeder.ts";
import { recordingReader as freshReader, openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { daysFrom, MISSING_ENTITY, outcomeValue } from "../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { BELIEF_KEYS } from "./computed-beliefs.ts";

// find_paths. The world is seeded through the writer: under `own`, Blake and the owner wrote to
// each other and Pat only wrote to the owner; under the employer's label, Blake and Wren did both.
// Relationship and affiliation claims are committed through the Pipeline, and the beliefs are
// computed from them at read; each test has a world of its own holding the claims it needs. Quinn
// and Remy are people and Lantern an organization, each with an `own` account or domain and seen in
// no mail. No model is called. Reserved domains only.

const OWN = ["own"];
const WIDE = ["employer:example", "own"];
const TOOLS = ["find_paths"];
const VIEWS = ["self", "people", "work"];
const NOT_FOUND = { ok: false, code: "not_found" };

type People = { owner: string; blake: string; pat: string; wren: string; quinn: string; remy: string; lantern: string };

// One fact a test's world holds: its claim's key, kind, subject and typed values.
type Spec = {
  key: string;
  kind: "relationship" | "affiliation";
  subject: string;
  values: Record<string, string>;
  message: Message;
};
// What a world says of a fact besides its claim: that it was stated long ago (stale), that the
// other party said otherwise within the month (disputed), or that its subject took it back (closed).
type Said = "stale" | "disputed" | "closed";

// The paths of stated hops alone: the world's people share a mail domain, which makes an observed
// hop between them (read-paths-observed.db.test.ts covers those).
const stated = (list: PathList): PathList["paths"] =>
  list.paths.filter((path) => path.hops.every((hop) => hop.observed === undefined));
const routes = (list: PathList): string[][] =>
  list.paths.map((path) => path.hops.map((hop) => `${hop.from.id}>${hop.to.id}:${hop.via}`));

describe("find_paths on the world", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let people: People;
  let own: Client;
  let wide: Client;
  let specs: Map<string, Spec>;
  let records: Map<string, ClaimRecord>;
  let serial = 0;
  const claimOf = (key: string): string =>
    fingerprint(store.db.keys, "claim", (records.get(key) as ClaimRecord).claim.id);
  const factOf = (key: string): string => fingerprint(store.db.keys, "fact", key);

  const paths = async (client: Client, args: FindPathsArgs): Promise<PathList> =>
    PathList.parse(outcomeValue(await freshReader(store).reader.findPaths(client.token, args)));
  const target = (id: string, maxHops?: number): FindPathsArgs => ({
    target: id as EntityId,
    ...(maxHops === undefined ? {} : { maxHops }),
  });

  // One claim of a spec, as the extraction would commit it: by `by`, of `relation`, at `at`.
  const recordOf = (
    spec: Spec,
    options: { by?: string; values?: Record<string, string>; at?: string; reversal?: boolean } = {},
  ): ClaimRecord => {
    serial += 1;
    const values = options.values ?? spec.values;
    const by = options.by ?? spec.subject;
    const named = [spec.subject, ...Object.values(values).filter((value) => value.startsWith("ent_"))];
    const base = claimRecord(spec.message.evidenceId, spec.message.compartment, spec.subject, {
      n: serial,
      type: spec.kind,
      factKey: spec.key,
      validFrom: options.at ?? spec.message.sentAt,
      entities: named,
    });
    const fieldKinds =
      spec.kind === "relationship"
        ? { counterparty: "entity", relation: "enum" }
        : { organization: "entity", relation: "enum" };
    return {
      ...base,
      claim: {
        ...base.claim,
        assertedBy: by,
        basis: by === spec.subject ? "explicit_self" : "third_party",
        ...(options.reversal === true ? { statementKind: "reversal" } : {}),
        content: { ...base.claim.content, type: spec.kind, fields: values },
      } as Claim,
      subjectKind: "person",
      fieldKinds,
    } as ClaimRecord;
  };

  // The claims of these facts committed, each item's in one commit, with what `said` adds.
  async function commit(keys: string[], said: Partial<Record<string, Said>> = {}): Promise<void> {
    const later = (spec: Spec): string => new Date(Date.parse(spec.message.sentAt) + 3_600_000).toISOString();
    const claims = keys.flatMap((key) => {
      const spec = specs.get(key) as Spec;
      const what = said[key];
      const first = recordOf(spec, what === "stale" ? { at: daysFrom(WORLD_NOW, -200).toISOString() } : {});
      records.set(key, first);
      if (what === "disputed") {
        const other = spec.kind === "relationship" ? (spec.values.counterparty as string) : spec.subject;
        return [
          first,
          recordOf(spec, { by: other, values: { ...spec.values, relation: "colleague" }, at: later(spec) }),
        ];
      }
      if (what === "closed") return [first, recordOf(spec, { at: later(spec), reversal: true })];
      return [first];
    });
    const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
    try {
      const byItem = new Map<string, ClaimRecord[]>();
      for (const record of claims)
        byItem.set(record.claim.primaryEvidenceId, [...(byItem.get(record.claim.primaryEvidenceId) ?? []), record]);
      for (const [evidenceId, batch] of byItem)
        expect(await pipeline.commit(batchOf(evidenceId as never, batch))).toBe("committed");
    } finally {
      await pipeline.close();
    }
    await knownBy(store.db, WORLD_NOW);
  }

  // A world of the test's own, holding the claims of these facts.
  async function world(keys: string[], said: Partial<Record<string, Said>> = {}): Promise<void> {
    store = await openStore({ now: WORLD_NOW });
    const seeded = await seedWorld(store.writer, store.admin);
    const extra = await session(store.db.urls.admin, async (query) => {
      const seed = seeder(store.db, query);
      const person = async (): Promise<string> => {
        const id = await seed.entity("person");
        await seed.account(OWN, id);
        return id;
      };
      const quinn = await person();
      const remy = await person();
      const lantern = await seed.entity("organization");
      await seed.domain(OWN, lantern);
      return { quinn, remy, lantern };
    });
    people = {
      owner: seeded.ownerEntity(),
      blake: seeded.entityOf(WORLD.both.address),
      pat: seeded.entityOf(WORLD.ownOnly.address),
      wren: seeded.entityOf(WORLD.workOnly.address),
      ...extra,
    };
    const messages = await worldMessages(store);
    const on = (compartment: string, n = 0): Message =>
      messages.filter((one) => one.compartment === compartment)[n] as Message;
    const relationship = (key: string, subject: string, counterparty: string, message: Message): Spec => ({
      key,
      kind: "relationship",
      subject,
      values: { counterparty, relation: "friend" },
      message,
    });
    const affiliation = (key: string, subject: string, organization: string, message: Message): Spec => ({
      key,
      kind: "affiliation",
      subject,
      values: { organization, relation: "employee" },
      message,
    });
    specs = new Map(
      [
        relationship("k-blake-pat", people.blake, people.pat, on("own", 0)),
        relationship("k-pat-quinn", people.pat, people.quinn, on("own", 1)),
        relationship("k-quinn-remy", people.quinn, people.remy, on("own", 2)),
        affiliation("k-blake-lantern", people.blake, people.lantern, on("own", 0)),
        affiliation("k-remy-lantern", people.remy, people.lantern, on("own", 1)),
        // The employer's: Wren and Pat, and Wren and Quinn.
        relationship("k-wren-pat", people.wren, people.pat, on("employer:example", 0)),
        relationship("k-wren-quinn", people.wren, people.quinn, on("employer:example", 1)),
      ].map((spec) => [spec.key, spec]),
    );
    records = new Map();
    await commit(keys, said);
    own = await insertReader(store, "own-paths", OWN, { tools: TOOLS, views: VIEWS });
    wide = await insertReader(store, "wide-paths", WIDE, { tools: TOOLS, views: VIEWS });
  }

  // Quinn a saved contact of the owner's, under `own`.
  const saveQuinn = () =>
    session(store.db.urls.admin, async (query) => {
      const seed = seeder(store.db, query);
      const contact = (await seed.into("knowledge.contacts")(OWN)) as string;
      await query(
        "insert into knowledge.contact_addresses (contact_id, value_fp, entity_id, compartments) values ($1, $2, $3, $4)",
        [contact, fingerprint(store.db.keys, "address", "quinn-contact@example.test"), people.quinn, OWN],
      );
    });

  afterEach(async () => {
    await store.close();
  });

  it("a path starts with the owner's own tie and ends at the target, each hop citing its beliefs' facts by fact id", async () => {
    await world(["k-blake-pat"]);
    const { reader } = freshReader(store);
    const list = PathList.parse(outcomeValue(await reader.findPaths(own.token, target(people.pat))));
    expect(routes(list)).toEqual([
      [`${people.owner}>${people.blake}:own_tie`, `${people.blake}>${people.pat}:relationship`],
    ]);
    const [path] = list.paths;
    // The weakest hop's strength, here Blake's own tie (recent mail both ways) or the
    // relationship's fixed 1, whichever is less.
    expect(path?.score).toBeGreaterThan(0);
    expect(path?.score).toBeLessThanOrEqual(1);
    expect(path?.hops.map((hop) => hop.facts)).toEqual([[], [claimOf("k-blake-pat")]]);
    // The owner is the owner's Who, with the visible address; each person their own.
    expect(path?.hops[0]?.from).toMatchObject({
      id: people.owner,
      kind: "owner",
      address: { untrusted: WORLD.ownerPersonal },
    });
    expect(path?.hops[1]?.to).toMatchObject({
      id: people.pat,
      kind: "person",
      address: { untrusted: WORLD.ownOnly.address },
    });
    expect(list.cut).toBe(false);
    // The read log: the fact key of each belief the answer cites, and no evidence id.
    const logged = await queryAs<{ bound: string[]; shown: string[]; fact_key_fps: string[] }>(
      store.db.urls.admin,
      "select bound, shown, fact_key_fps from ledger.read_log where client_id = $1 and tool = 'find_paths' order by id desc limit 1",
      [own.id],
    );
    expect(logged).toEqual([{ bound: [], shown: [], fact_key_fps: [factOf("k-blake-pat")] }]);
  });

  it("own ties are mail both ways, a meeting or a saved contact, at any time: Pat, who only wrote, is none", async () => {
    await world([]);
    // Blake wrote and was written to: one path of the own tie alone.
    expect(routes(await paths(own, target(people.blake)))).toEqual([[`${people.owner}>${people.blake}:own_tie`]]);
    expect((await paths(own, target(people.blake))).paths[0]?.score).toBeGreaterThanOrEqual(0.1);
    // Pat only wrote to the owner, and Quinn is in no mail: no path.
    expect(stated(await paths(own, target(people.pat)))).toEqual([]);
    expect(stated(await paths(own, target(people.quinn)))).toEqual([]);
    // Wren is an own tie under the employer's label: to the wide client, not to the narrow one.
    expect(routes(await paths(wide, target(people.wren)))).toEqual([[`${people.owner}>${people.wren}:own_tie`]]);
  });

  it("held mail makes no own tie and no hop: a belief that rests only on it ties nothing", async () => {
    await world(["k-blake-pat"]);
    const hold = (message: Message, held: boolean) =>
      queryAs(store.db.urls.admin, "update knowledge.messages set held = $2 where evidence_id = $1", [
        message.evidenceId,
        held,
      ]);
    // k-blake-pat's one claim is of Blake's first message.
    const claimed = specs.get("k-blake-pat")?.message as Message;
    await hold(claimed, true);
    try {
      expect(stated(await paths(own, target(people.pat)))).toEqual([]);
    } finally {
      await hold(claimed, false);
    }
    expect(routes(await paths(own, target(people.pat)))).toHaveLength(1);
    // The owner's one message to Blake under `own`, held: Blake is no own tie to the narrow client.
    const sent = (await worldMessages(store)).filter((one) => one.compartment === "own")[1] as Message;
    await hold(sent, true);
    try {
      expect(stated(await paths(own, target(people.blake)))).toEqual([]);
    } finally {
      await hold(sent, false);
    }
    expect(routes(await paths(own, target(people.blake)))).toEqual([[`${people.owner}>${people.blake}:own_tie`]]);
  });

  it("a meeting is an own tie once it started, at any age, when not cancelled, declined or unanswered", async () => {
    await world([]);
    // A person met once, at an event of the seeder's, moved to ten days ago; nothing else of them
    // is in the window.
    const met = await session(store.db.urls.admin, (query) => seeder(store.db, query).world(OWN));
    const set = (response: string | null, days = -10) =>
      queryAs(
        store.db.urls.admin,
        "update knowledge.event_details set owner_response = $2, starts_at = $3, ends_at = $3::timestamptz + interval '1 hour' where event_id = $1",
        [met.eventId, response, new Date(WORLD_NOW.getTime() + days * 86_400_000).toISOString()],
      );
    const reached = async (): Promise<number> => (await paths(own, target(met.person))).paths.length;
    for (const response of [null, "accepted", "tentative"]) {
      await set(response);
      expect(await reached(), String(response)).toBe(1);
    }
    for (const response of ["declined", "needsAction"]) {
      await set(response);
      expect(await reached(), response).toBe(0);
    }
    // A meeting long past is still a tie; one still to come is none.
    await set("accepted", -400);
    expect(await reached()).toBe(1);
    await set("accepted", 3);
    expect(await reached()).toBe(0);
    await set("accepted");
    await queryAs(store.db.urls.admin, "update knowledge.event_details set cancelled = true where event_id = $1", [
      met.eventId,
    ]);
    expect(await reached()).toBe(0);
  });

  it("maxHops counts the own tie: the rule file's 4 by default, which reaches a person two ties past it, and 2 does not", async () => {
    await world(["k-blake-pat", "k-pat-quinn"]);
    const quinn = [
      [
        `${people.owner}>${people.blake}:own_tie`,
        `${people.blake}>${people.pat}:relationship`,
        `${people.pat}>${people.quinn}:relationship`,
      ],
    ];
    expect(routes(await paths(own, target(people.quinn)))).toEqual(quinn);
    expect(routes(await paths(own, target(people.quinn, 4)))).toEqual(quinn);
    expect(routes(await paths(own, target(people.quinn, 3)))).toEqual(quinn);
    expect(stated(await paths(own, target(people.quinn, 2)))).toEqual([]);
    expect(stated(await paths(own, target(people.pat, 1)))).toEqual([]);
  });

  it("a disputed relationship ties nothing, nor a closed one; a stale one ties", async () => {
    await world(["k-blake-pat"], { "k-blake-pat": "disputed" });
    expect(stated(await paths(own, target(people.pat)))).toEqual([]);
    await store.close();
    await world(["k-blake-pat"], { "k-blake-pat": "closed" });
    expect(stated(await paths(own, target(people.pat)))).toEqual([]);
    await store.close();
    // The control: stale is current.
    await world(["k-blake-pat"], { "k-blake-pat": "stale" });
    expect(routes(await paths(own, target(people.pat)))).toHaveLength(1);
  });

  it("an affiliation bridges two people of one organization, citing both; a closed affiliation bridges nothing", async () => {
    await world(["k-blake-lantern", "k-remy-lantern"]);
    const list = await paths(own, target(people.remy));
    expect(routes(list)).toEqual([
      [`${people.owner}>${people.blake}:own_tie`, `${people.blake}>${people.remy}:affiliation`],
    ]);
    expect(list.paths[0]?.hops[1]?.facts).toEqual([claimOf("k-blake-lantern"), claimOf("k-remy-lantern")].sort());
    await store.close();
    await world(["k-blake-lantern", "k-remy-lantern"], { "k-remy-lantern": "closed" });
    expect(stated(await paths(own, target(people.remy)))).toEqual([]);
    // An organization is a target, reached through anyone at it the owner knows:
    // Blake, whose affiliation the last hop cites.
    const lantern = await paths(own, target(people.lantern));
    expect(routes(lantern)).toEqual([
      [`${people.owner}>${people.blake}:own_tie`, `${people.blake}>${people.lantern}:affiliation`],
    ]);
    expect(lantern.paths[0]?.hops[1]?.facts).toEqual([claimOf("k-blake-lantern")]);
    expect(lantern.paths[0]?.hops[1]?.to).toMatchObject({ id: people.lantern, kind: "organization" });
  });

  it("a saved contact is an own tie, the contacts-only person ranked by the floor of a tie", async () => {
    await world(["k-pat-quinn"]);
    // Quinn is in no mail: no path, until Quinn is a saved contact of the owner's, under `own`.
    expect(stated(await paths(own, target(people.remy)))).toEqual([]);
    await commit(["k-quinn-remy"]);
    expect(stated(await paths(own, target(people.remy)))).toEqual([]);
    await saveQuinn();
    const list = await paths(own, target(people.remy));
    expect(routes(list)).toEqual([
      [`${people.owner}>${people.quinn}:own_tie`, `${people.quinn}>${people.remy}:relationship`],
    ]);
    expect(list.paths[0]?.score).toBe(0.1);
  });

  it("a hidden target and an absent one answer the same, with the same statements; so does the owner", async () => {
    await world(["k-blake-pat"]);
    const { reader, during } = freshReader(store);
    const hidden = await during(() => reader.findPaths(own.token, target(people.wren)));
    const absent = await during(() => reader.findPaths(own.token, target(MISSING_ENTITY)));
    const owner = await during(() => reader.findPaths(own.token, target(people.owner)));
    expect(hidden.answer).toEqual(NOT_FOUND);
    expect(absent.answer).toEqual(NOT_FOUND);
    expect(owner.answer).toEqual(NOT_FOUND);
    expect(hidden.statements).toEqual(absent.statements);
    expect(owner.statements).toEqual(absent.statements);
    // The control: a visible target reads on.
    const found = await during(() => reader.findPaths(own.token, target(people.pat)));
    expect(found.answer.ok).toBe(true);
    expect(found.statements.length).toBeGreaterThan(absent.statements.length);
  });

  it("the same bytes and statements with and without rows the client cannot see", async () => {
    await world(["k-blake-pat", "k-pat-quinn", "k-blake-lantern", "k-remy-lantern"]);
    await saveQuinn();
    const { reader, during } = freshReader(store);
    const asks = [target(people.pat), target(people.quinn, 3), target(people.remy), target(people.blake)];
    // The reader opens the client's session on its first call: one call first, so each call
    // compared is a later one.
    await reader.findPaths(own.token, target(people.pat));
    const before = [];
    for (const ask of asks) before.push(await during(() => reader.findPaths(own.token, ask)));

    // Rows the narrow client cannot see: the employer's claims, and the employer's mail, in which
    // Wren is an own tie with ties to Pat and Quinn.
    await commit(["k-wren-pat", "k-wren-quinn"]);
    for (const [n, ask] of asks.entries()) {
      const after = await during(() => reader.findPaths(own.token, ask));
      expect(JSON.stringify(after.answer), JSON.stringify(ask)).toBe(JSON.stringify(before[n]?.answer));
      expect(after.statements, JSON.stringify(ask)).toEqual(before[n]?.statements);
    }
    // The control: the wide client, cleared for them, is shown the route through Wren (in two
    // hops; three also go through Quinn). The two tie in score and tie strength, so their order is
    // that of beliefs computed together: compared as a set.
    expect(routes(await paths(wide, target(people.pat, 2))).sort((a, b) => (a.join() < b.join() ? -1 : 1))).toEqual(
      [
        [`${people.owner}>${people.blake}:own_tie`, `${people.blake}>${people.pat}:relationship`],
        [`${people.owner}>${people.wren}:own_tie`, `${people.wren}>${people.pat}:relationship`],
        // Quinn, a saved contact, is an own tie too.
        [`${people.owner}>${people.quinn}:own_tie`, `${people.quinn}>${people.pat}:relationship`],
      ].sort((a, b) => (a.join() < b.join() ? -1 : 1)),
    );
  });

  it("the bounds hold on a world with 6 000 ties: the 5 000 newest beliefs computed, and cut", async () => {
    await world(["k-blake-pat"]);
    // 120 people with an `own` account each, and 6 000 relationships among them, each stated by
    // its subject.
    const crowd = await session(store.db.urls.admin, async (query) => {
      const seed = seeder(store.db, query);
      const ids: string[] = [];
      for (let n = 0; n < 120; n += 1) {
        const id = await seed.entity("person");
        await seed.account(OWN, id);
        ids.push(id);
      }
      return ids;
    });
    const pairs: [string, string][] = [];
    for (let i = 0; i < crowd.length && pairs.length < 6_000; i += 1)
      for (let j = i + 1; j < crowd.length && pairs.length < 6_000; j += 1)
        pairs.push([crowd[i] as string, crowd[j] as string]);
    expect(pairs).toHaveLength(6_000);
    await bulkClaims(store, pairs.length, daysFrom(WORLD_NOW, -2), (n, { evidenceId, key, validFrom }) => {
      const [a, b] = pairs[n] as [string, string];
      const base = claimRecord(evidenceId, "own", a, {
        n: n + 1,
        type: "relationship",
        factKey: key,
        validFrom,
        entities: [a, b],
      });
      return {
        ...base,
        claim: {
          ...base.claim,
          assertedBy: a,
          content: { ...base.claim.content, type: "relationship", fields: { counterparty: b, relation: "friend" } },
        } as unknown as Claim,
        subjectKind: "person",
        fieldKinds: { counterparty: "entity", relation: "enum" },
      } as ClaimRecord;
    });
    const { reader, during } = freshReader(store);
    const { answer, statements } = await during(() => reader.findPaths(own.token, target(crowd[0] as string, 3)));
    const list = PathList.parse(outcomeValue(answer));
    expect(list.cut).toBe(true);
    expect(list.paths.length).toBeLessThanOrEqual(20);
    // One statement of the newest keys, and the 5 000 kept read a thousand at a time.
    expect(statements.filter((text) => text === BELIEF_KEYS)).toHaveLength(1);
    expect(statements.filter((text) => text.includes("policy.belief_inputs("))).toHaveLength(5);
  });
});
