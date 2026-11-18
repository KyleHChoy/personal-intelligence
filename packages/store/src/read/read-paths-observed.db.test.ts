import { type EntityId, PathList } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { testId } from "../test-support/clients.ts";
import { type Client, insertReader, type Message, worldMessages } from "../test-support/commitment-fixtures.ts";
import { session } from "../test-support/connections.ts";
import { queryAs, sealRow } from "../test-support/database.ts";
import { seedFacts } from "../test-support/fact-fixtures.ts";
import { recordingPool } from "../test-support/recording.ts";
import { seeder } from "../test-support/seeder.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue } from "../test-support/values.ts";
import { buildAs, type WarmthWorld, warmthWorld } from "../test-support/warmth-fixtures.ts";
import { seedWorld, WORLD_NOW } from "../test-support/world.ts";
import { Reader } from "./read.ts";
import { DOMAIN_MAX_PEOPLE, MEETING_MAX_PEOPLE, OBSERVED_STATEMENTS, THREAD_MAX_PEOPLE } from "./read-observed.ts";

// Rows are the seeder's, written as pi_admin; each test makes its own people, so none can reach
// another's. Reserved domains and made-up ids only. No model is called.

const OWN = ["own"];
const EMPLOYER = ["employer:example"];
const TOOLS = ["find_paths"];
const VIEWS = ["self", "people", "work"];
const DAY_MS = 86_400_000;
const daysAgo = (days: number): string => new Date(WORLD_NOW.getTime() - days * DAY_MS).toISOString();
const AT = daysAgo(3);

describe("observed hops", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let world: WarmthWorld;
  let owner: string;
  let own: Client;
  let wide: Client;
  let onOwn: Message[];

  const fresh = () => {
    const recorded = recordingPool(store.readerPool);
    const reader = new Reader({ pool: recorded.pool, keys: store.db.keys, log: store.log, now: () => store.now });
    return { reader, statements: recorded.statements };
  };
  const paths = async (client: Client, target: string): Promise<PathList> =>
    PathList.parse(outcomeValue(await fresh().reader.findPaths(client.token, { target: target as EntityId })));
  const routes = (list: PathList): string[][] =>
    list.paths.map((path) => path.hops.map((hop) => `${hop.from.id}>${hop.to.id}:${hop.via}`));

  // Someone the owner wrote with both ways.
  const known = async (label = OWN): Promise<string> => {
    const person = await world.person(label);
    await world.mail(label, { at: AT, to: [person] });
    await world.mail(label, { at: AT, from: person });
    return person;
  };

  // One more address of a person's, on the domain given or a domain of its own.
  const address = (
    label: string[],
    person: string,
    domain = `${testId("own")}.test`,
    kind = "email",
  ): Promise<void> => {
    const id = testId("adr");
    const value = `${testId("someone")}@${domain}`.toLowerCase();
    return session(store.db.urls.admin, async (query) => {
      await query(
        `insert into knowledge.accounts (id, entity_id, kind, value_fp, domain_fp, compartments, value_enc)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          person,
          kind,
          fingerprint(store.db.keys, "address", value),
          fingerprint(store.db.keys, "domain", domain),
          label,
          sealRow(store.db.keys, label[0] ?? "own", { table: "knowledge.accounts", id, column: "value_enc" }, value),
        ],
      );
    });
  };

  // An organization holding a domain under `label`, and an address of each person on it.
  // Each has a message under the label, which a domain's hop binds, unless `mail` says none or
  // `mailFor` names who.
  const atDomain = async (
    domain: string,
    label: string[],
    people: string[],
    options: { mail?: boolean; mailFor?: string[] } = {},
  ): Promise<string> => {
    const made = await session(store.db.urls.admin, async (query) => {
      const seed = seeder(store.db, query);
      const made = await seed.entity("organization");
      const fp = fingerprint(store.db.keys, "domain", domain);
      const id = testId("dom");
      await query(
        "insert into knowledge.domains (id, domain_fp, entity_id, domain_enc, compartments) values ($1, $2, $3, $4, $5)",
        [
          id,
          fp,
          made,
          sealRow(store.db.keys, label[0] ?? "own", { table: "knowledge.domains", id, column: "domain_enc" }, domain),
          label,
        ],
      );
      return made;
    });
    for (const person of people) await address(label, person, domain);
    if (options.mail !== false)
      for (const person of options.mailFor ?? people) await world.mail(label, { at: daysAgo(30), from: person });
    return made;
  };

  // A stated relationship, as the rebuild writes its belief.
  const stated = (subject: string, counterparty: string): Promise<void> =>
    seedFacts(
      store,
      owner,
      [
        {
          key: `observed-stated-${subject}-${counterparty}`,
          type: "relationship",
          kind: "relationship",
          subject,
          by: subject,
          message: onOwn[0] as Message,
          fields: { counterparty, relation: "friend" },
          fieldKinds: { counterparty: "entity", relation: "enum" },
          values: { counterparty, relation: "friend" },
          entities: [subject, counterparty],
        },
      ],
      [OWN],
    );

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW, compartments: ["own", "employer:example"] });
    owner = (await seedWorld(store.writer, store.admin)).ownerEntity();
    world = warmthWorld(store.db);
    onOwn = (await worldMessages(store)).filter((one) => one.compartment === "own");
    own = await insertReader(store, "observed-own", OWN, { tools: TOOLS, views: VIEWS });
    wide = await insertReader(store, "observed-wide", [...EMPLOYER, ...OWN], { tools: TOOLS, views: VIEWS });
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store?.close();
  });

  it("owner knows A, A and B share a thread, B is on the target's domain: find_paths returns owner, A, B, target, each hop's kind marked observed", async () => {
    const a = await known();
    const b = await world.person(OWN);
    const target = await world.person(OWN);
    await world.mail(OWN, { at: AT, from: a, to: [b], thread: "observed-first" });
    await atDomain("observed-first.test", OWN, [b, target]);

    const list = await paths(own, target);
    expect(routes(list)).toEqual([[`${owner}>${a}:own_tie`, `${a}>${b}:shared_thread`, `${b}>${target}:same_domain`]]);
    const [, thread, domain] = list.paths[0]?.hops ?? [];
    expect(thread?.observed).toMatchObject({ weight: 0.2, count: 1, ref: expect.stringMatching(/^msg_/) });
    expect(thread?.facts).toEqual([]);
    expect(domain?.observed).toEqual({ weight: 0.1, count: 0, lastAt: null, ref: null });
    // The weakest hop's strength: the domain's.
    expect(list.paths[0]?.score).toBe(0.1);
    expect(list.paths[0]?.hops[0]?.observed).toBeUndefined();
  });

  it("meeting together is a hop, as is a person reaching an organization by its domain alone", async () => {
    const a = await known();
    const target = await world.person(OWN);
    // A meeting the owner kept makes everyone at it their own tie, so the hop that adds a route is
    // one they declined.
    await world.meeting(OWN, [a, target], AT, { response: "declined" });
    const list = await paths(own, target);
    expect(routes(list)).toEqual([[`${owner}>${a}:own_tie`, `${a}>${target}:met_together`]]);
    expect(list.paths[0]?.hops[1]?.observed).toMatchObject({
      weight: 0.2,
      count: 1,
      ref: expect.stringMatching(/^evt_/),
    });

    const member = await known();
    const organization = await atDomain("observed-at.test", OWN, [member]);
    expect(routes(await paths(own, organization))).toEqual([
      [`${owner}>${member}:own_tie`, `${member}>${organization}:same_domain`],
    ]);
  });

  // The riskiest rule: each row is read under the caller's own token, or the owner's stated audience.
  it("a thread, a meeting or a domain under a compartment the caller cannot see makes no hop for them, and does for a caller who can see it", async () => {
    const a = await known();
    const byThread = await world.person(OWN);
    await address(EMPLOYER, byThread);
    await address(EMPLOYER, a);
    await world.mail(EMPLOYER, { at: AT, from: a, to: [byThread], thread: "observed-hidden" });
    expect((await paths(own, byThread)).paths).toEqual([]);
    expect(routes(await paths(wide, byThread))).toContainEqual([
      `${owner}>${a}:own_tie`,
      `${a}>${byThread}:shared_thread`,
    ]);

    const byMeeting = await world.person(OWN);
    await world.meeting(EMPLOYER, [a, byMeeting], AT, { response: "declined" });
    expect((await paths(own, byMeeting)).paths).toEqual([]);
    expect(routes(await paths(wide, byMeeting))).toContainEqual([
      `${owner}>${a}:own_tie`,
      `${a}>${byMeeting}:met_together`,
    ]);

    const byDomain = await world.person(OWN);
    await atDomain("observed-hidden.test", EMPLOYER, [a, byDomain]);
    expect((await paths(own, byDomain)).paths).toEqual([]);
    expect(routes(await paths(wide, byDomain))).toContainEqual([
      `${owner}>${a}:own_tie`,
      `${a}>${byDomain}:same_domain`,
    ]);
  });

  it("rows a caller cannot see change neither their answer nor the statements sent", async () => {
    const a = await known();
    const target = await world.person(OWN);
    await world.mail(OWN, { at: AT, from: a, to: [target], thread: "observed-seen" });
    const answer = async (): Promise<{ list: unknown; sent: string[] }> => {
      const { reader, statements } = fresh();
      const list = outcomeValue(await reader.findPaths(own.token, { target: target as EntityId }));
      return { list, sent: [...statements] };
    };
    const before = await answer();
    // Hidden from `own`: another thread between them, a wide one that would drop nothing it sees, a
    // meeting, and a domain.
    await address(EMPLOYER, target);
    await world.mail(EMPLOYER, { at: daysAgo(1), from: a, to: [target], thread: "observed-seen" });
    const crowd = await Promise.all(Array.from({ length: THREAD_MAX_PEOPLE + 1 }, () => world.person(EMPLOYER)));
    await world.mail(EMPLOYER, { at: daysAgo(1), from: target, to: crowd, thread: "observed-seen" });
    await world.meeting(EMPLOYER, [a, target], AT, { response: "declined" });
    await atDomain("observed-seen.test", EMPLOYER, [a, target]);
    const after = await answer();
    expect(after.list).toEqual(before.list);
    expect(after.sent).toEqual(before.sent);
    // The positive control: the caller who can see them gets a different answer, more messages first.
    const shown = PathList.parse(
      outcomeValue(await fresh().reader.findPaths(wide.token, { target: target as EntityId })),
    );
    expect(JSON.stringify(shown)).not.toEqual(JSON.stringify(after.list));
  });

  it("the read log records the message and the meeting an observed hop cites, never one it does not", async () => {
    const a = await known();
    const target = await world.person(OWN);
    const shown = await world.mail(OWN, { at: AT, from: a, to: [target], thread: "observed-log" });
    await paths(own, target);
    const rows = await queryAs<{ shown: string[] }>(
      store.db.urls.admin,
      `select l.shown from ledger.read_log l
       where l.client_id = $1 and l.tool = 'find_paths' order by l.read_at desc, l.id desc limit 1`,
      [own.id],
    );
    expect(rows[0]?.shown).toEqual([shown]);

    // Rows of two labels under one hop: a caller cleared for both is shown one of each, and the
    // caller cleared for one, only its own.
    await address(EMPLOYER, a);
    await address(EMPLOYER, target);
    const hidden = await world.mail(EMPLOYER, { at: daysAgo(5), from: a, to: [target], thread: "observed-log" });
    await paths(wide, target);
    const both = await queryAs<{ shown: string[] }>(
      store.db.urls.admin,
      `select l.shown from ledger.read_log l
       where l.client_id = $1 and l.tool = 'find_paths' order by l.read_at desc, l.id desc limit 1`,
      [wide.id],
    );
    expect(both[0]?.shown.sort()).toEqual([shown, hidden].sort());
    const list = await paths(wide, target);
    expect(list.paths[0]?.hops[1]?.observed?.count).toBe(2);
    expect((await paths(own, target)).paths[0]?.hops[1]?.observed?.count).toBe(1);
  });

  const lastShown = async (client: Client): Promise<string[]> => {
    const rows = await queryAs<{ shown: string[] }>(
      store.db.urls.admin,
      `select l.shown from ledger.read_log l
       where l.client_id = $1 and l.tool = 'find_paths' order by l.read_at desc, l.id desc limit 1`,
      [client.id],
    );
    return [...(rows[0]?.shown ?? [])].sort();
  };

  it("one message cited by several hops: each hop still binds every label of its own", async () => {
    const a = await known();
    const b = await world.person(OWN);
    // The tie read after A and B's, which cites the same newest message.
    let c = await world.person(OWN);
    while (c < a) c = await world.person(OWN);
    await address(EMPLOYER, a);
    await address(EMPLOYER, b);
    const older = await world.mail(EMPLOYER, { at: daysAgo(5), from: a, to: [b] });
    const newest = await world.mail(OWN, { at: AT, from: a, to: [b, c] });
    const list = await paths(wide, b);
    expect(routes(list)).toContainEqual([`${owner}>${a}:own_tie`, `${a}>${b}:shared_thread`]);
    expect(await lastShown(wide)).toEqual([newest, older].sort());
  });

  it("a domain's hop binds each person's newest evidence under that label, and with none there is no hop", async () => {
    const a = await known();
    const target = await world.person(OWN);
    await address(EMPLOYER, a);
    await address(EMPLOYER, target);
    const organization = await atDomain("observed-binds.test", EMPLOYER, [a, target], { mail: false });
    // Neither has evidence under the employer's label: nothing to bind, so no hop, for anyone.
    expect((await paths(wide, target)).paths).toEqual([]);
    expect((await paths(wide, organization)).paths).toEqual([]);
    // The older of the target's two messages is not bound.
    await world.mail(EMPLOYER, { at: daysAgo(9), from: target });
    const theirs = await world.mail(EMPLOYER, { at: daysAgo(8), from: target });
    const mine = await world.mail(EMPLOYER, { at: daysAgo(7), from: a });
    const list = await paths(wide, target);
    expect(routes(list)).toEqual([[`${owner}>${a}:own_tie`, `${a}>${target}:same_domain`]]);
    expect(await lastShown(wide)).toEqual([mine, theirs].sort());
    await paths(wide, organization);
    expect(await lastShown(wide)).toEqual([mine]);
  });

  it("held and restricting messages use up none of a layer's bound and do not say cut", async () => {
    const a = await world.person(OWN);
    const peer = await world.person(OWN);
    const visible = await world.mail(OWN, { at: daysAgo(9), from: a, to: [peer] });
    await world.mail(OWN, { at: daysAgo(2), from: a, to: [peer], held: true });
    const restricting = await world.mail(OWN, { at: daysAgo(1), from: a, to: [peer] });
    await queryAs(store.db.urls.admin, "update knowledge.messages set restricting = true where evidence_id = $1", [
      restricting,
    ]);
    const client = await store.readerPool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('pi.client_token', $1, true)", [own.token]);
      // A bound of 2, which the two hidden messages would fill.
      const thread = await client.query(OBSERVED_STATEMENTS.THREAD_PEERS, [
        [a],
        2,
        THREAD_MAX_PEOPLE,
        null,
        WORLD_NOW.toISOString(),
        [],
      ]);
      expect(thread.rows.map((row: { peer: string }) => row.peer)).toEqual([peer]);
      expect(thread.rows[0].evidence_id).toBe(visible);
      expect(thread.rows[0].scanned).toBe(1);
      await client.query("rollback");
    } finally {
      client.release();
    }
  });

  // An ignore covers a person's addresses, and the world's people share one, so this one holds its own.
  const ownAddressOnly = async (): Promise<string> => {
    const person = await session(store.db.urls.admin, (query) => seeder(store.db, query).entity("person"));
    await address(OWN, person);
    return person;
  };

  it("a size counts only the people the caller can see, for a client and for the owner", async () => {
    const a = await known();
    const target = await world.person(OWN);
    const room = await Promise.all(Array.from({ length: THREAD_MAX_PEOPLE - 2 }, () => world.person(OWN)));
    const ignored = await ownAddressOnly();
    await world.mail(OWN, { at: AT, from: a, to: [target, ...room, ignored], thread: "observed-ignored" });
    expect((await paths(own, target)).paths).toEqual([]);
    await store.admin.ignores.addIgnore("entity", ignored, { requestId: testId("req") });
    expect(routes(await paths(own, target))[0]).toEqual([`${owner}>${a}:own_tie`, `${a}>${target}:shared_thread`]);

    await stated(a, await world.person(OWN));
    await buildAs(store.db, OWN);
    expect((await store.admin.people.paths(target as EntityId))?.paths[0]?.edges.map((one) => one.kind)).toEqual([
      "tie",
      "shared_thread",
    ]);

    // An organization of as many people as it may hold, once the one above the bound is ignored.
    const domain = "observed-ignored-size.test";
    const onIt = await Promise.all(Array.from({ length: DOMAIN_MAX_PEOPLE - 1 }, () => world.person(OWN)));
    const over = await ownAddressOnly();
    const member = await known();
    const organization = await atDomain(domain, OWN, [member, ...onIt, over], { mailFor: [member] });
    await buildAs(store.db, OWN);
    expect((await store.admin.people.paths(organization as EntityId))?.paths).toEqual([]);
    await store.admin.ignores.addIgnore("entity", over, { requestId: testId("req") });
    await buildAs(store.db, OWN);
    expect((await store.admin.people.paths(organization as EntityId))?.paths[0]?.edges.map((one) => one.kind)).toEqual([
      "tie",
      "same_domain",
    ]);
  });

  it("a stated organization's domain holds someone nobody stated is there: the route is observed", async () => {
    const q = await known();
    const target = await world.person(OWN);
    const organization = await atDomain("observed-stated-org.test", OWN, [q]);
    await seedFacts(
      store,
      owner,
      [
        {
          key: `observed-affiliation-${target}`,
          type: "affiliation",
          kind: "affiliation",
          subject: target,
          by: target,
          message: onOwn[0] as Message,
          fields: { organization, relation: "employee" },
          fieldKinds: { organization: "entity", relation: "enum" },
          values: { organization, relation: "employee" },
          entities: [target, organization],
        },
      ],
      [OWN],
    );
    const list = await paths(own, target);
    expect(routes(list)).toEqual([[`${owner}>${q}:own_tie`, `${q}>${target}:same_domain`]]);
    // The stated side's claim, so a read of this hop carries that claim's label too.
    expect(list.paths[0]?.hops[1]?.facts).toHaveLength(1);
  });

  it("bulk, held, list-filed and crowded mail, and a crowded meeting, make no hop; at the bound they do", async () => {
    const a = await known();
    const hidden = async (make: (target: string) => Promise<unknown>): Promise<string> => {
      const target = await world.person(OWN);
      await make(target);
      return target;
    };
    const none = [
      await hidden((target) => world.mail(OWN, { at: AT, from: a, to: [target], bulk: true })),
      await hidden((target) => world.mail(OWN, { at: AT, from: a, to: [target], held: true })),
      await hidden(async (target) => {
        const evidence = await world.mail(OWN, { at: AT, from: a, to: [target] });
        await queryAs(store.db.urls.admin, "update knowledge.messages set category = 'forums' where evidence_id = $1", [
          evidence,
        ]);
      }),
      await hidden(async (target) => {
        const others = await Promise.all(Array.from({ length: THREAD_MAX_PEOPLE }, () => world.person(OWN)));
        await world.mail(OWN, { at: AT, from: a, to: [target, ...others], thread: "observed-crowd" });
      }),
      await hidden(async (target) => {
        const others = await Promise.all(Array.from({ length: MEETING_MAX_PEOPLE - 1 }, () => world.person(OWN)));
        await world.meeting(OWN, [a, target, ...others], AT, { response: "declined" });
      }),
      await hidden((target) => world.meeting(OWN, [a, target], AT, { response: "declined", cancelled: true })),
      await hidden((target) => world.meeting(OWN, [a, target], daysAgo(-3), { response: "declined" })),
    ];
    for (const target of none) expect(routes(await paths(own, target))).toEqual([]);

    // Exactly at the bounds, each still makes its hop.
    const inThread = await world.person(OWN);
    const beside = await Promise.all(Array.from({ length: THREAD_MAX_PEOPLE - 2 }, () => world.person(OWN)));
    await world.mail(OWN, { at: AT, from: a, to: [inThread, ...beside], thread: "observed-bound" });
    expect(routes(await paths(own, inThread))).toContainEqual([
      `${owner}>${a}:own_tie`,
      `${a}>${inThread}:shared_thread`,
    ]);
    const inMeeting = await world.person(OWN);
    const room = await Promise.all(Array.from({ length: MEETING_MAX_PEOPLE - 2 }, () => world.person(OWN)));
    await world.meeting(OWN, [a, inMeeting, ...room], AT, { response: "declined" });
    expect(routes(await paths(own, inMeeting))).toContainEqual([
      `${owner}>${a}:own_tie`,
      `${a}>${inMeeting}:met_together`,
    ]);
  });

  it(`a domain holding more than ${DOMAIN_MAX_PEOPLE} people bridges no one`, async () => {
    const a = await known();
    const target = await world.person(OWN);
    const domain = "observed-large.test";
    await atDomain(domain, OWN, [a, target]);
    expect(routes(await paths(own, target))).toEqual([[`${owner}>${a}:own_tie`, `${a}>${target}:same_domain`]]);
    await session(store.db.urls.admin, async (query) => {
      const seed = seeder(store.db, query);
      for (let n = 0; n < DOMAIN_MAX_PEOPLE; n += 1) {
        const id = testId("adr");
        const value = `crowd-${n}@${domain}`;
        await query(
          `insert into knowledge.accounts (id, entity_id, kind, value_fp, domain_fp, compartments, value_enc)
           values ($1, $2, 'email', $3, $4, $5, $6)`,
          [
            id,
            await seed.entity("person"),
            fingerprint(store.db.keys, "address", value),
            fingerprint(store.db.keys, "domain", domain),
            OWN,
            sealRow(store.db.keys, "own", { table: "knowledge.accounts", id, column: "value_enc" }, value),
          ],
        );
      }
    });
    expect((await paths(own, target)).paths).toEqual([]);
  });

  it("an address on a free-mail domain bridges no one, even if a row says an organization holds it; a role address neither", async () => {
    const a = await known();
    const target = await world.person(OWN);
    await address(OWN, a, "gmail.com");
    await address(OWN, target, "gmail.com");
    expect((await paths(own, target)).paths).toEqual([]);
    await atDomain("gmail.com", OWN, [a, target]);
    expect((await paths(own, target)).paths).toEqual([]);
    // The positive control: the same two on an ordinary domain.
    await atDomain("observed-ordinary.test", OWN, [a, target]);
    expect(routes(await paths(own, target))).toEqual([[`${owner}>${a}:own_tie`, `${a}>${target}:same_domain`]]);

    // A role address on a thread with each of two people joins neither to the other.
    const role = await world.person(OWN);
    await queryAs(store.db.urls.admin, "update knowledge.accounts set kind = 'role' where entity_id = $1", [role]);
    const past = await world.person(OWN);
    await world.mail(OWN, { at: AT, from: a, to: [role] });
    await world.mail(OWN, { at: AT, from: past, to: [role] });
    expect((await paths(own, past)).paths).toEqual([]);
  });

  it("a stated relation stands over an observed hop between the same two, and a stated path ranks first even with a weaker own tie", async () => {
    const a = await known();
    const through = await known();
    const target = await world.person(OWN);
    // Both share a thread with the target; only `through` has a stated relation to them too, and a
    // second thread with `a` makes `a` no stronger.
    await world.mail(OWN, { at: AT, from: a, to: [target], thread: "observed-outrank-a" });
    await world.mail(OWN, { at: AT, from: through, to: [target], thread: "observed-outrank-b" });
    await stated(through, target);
    const list = await paths(own, target);
    expect(routes(list)[0]).toEqual([`${owner}>${through}:own_tie`, `${through}>${target}:relationship`]);
    expect(routes(list)).toContainEqual([`${owner}>${a}:own_tie`, `${a}>${target}:shared_thread`]);
    expect(list.paths[0]?.hops[1]?.observed).toBeUndefined();
  });

  it("pi outcomes: a goal's target the owner has a person-to-person route to counts; one they have a tie with is not sampled", async () => {
    const a = await known();
    const reached = await world.person(OWN);
    await world.mail(OWN, { at: AT, from: a, to: [reached], thread: "observed-goal" });
    const stranded = await world.person(OWN);
    const tied = await known();
    await stated(a, await world.person(OWN));
    await buildAs(store.db, OWN);
    await session(store.db.urls.admin, async (query) => {
      const seed = seeder(store.db, query);
      for (const target of [reached, stranded, tied]) {
        const goal = await seed.goalState(OWN);
        await query("update projections.goal_state set status = 'active', target_entity_id = $2 where goal_id = $1", [
          goal,
          target,
        ]);
      }
    });
    const view = await store.admin.box.outcomes(14);
    expect(view.metrics.find((one) => one.metric === "goal_targets_with_person_path")).toMatchObject({
      value: 0.5,
      sample: 2,
    });
  });

  it("the owner's paths walk observed hops under their audience, and a thread outside it, held or restricting makes none", async () => {
    const a = await known();
    const target = await world.person(OWN);
    await world.mail(OWN, { at: AT, from: a, to: [target], thread: "observed-owner" });
    // A person of the same walk who shares only what the owner's read may not rest on.
    const outside = await world.person(OWN);
    await world.mail(EMPLOYER, { at: AT, from: a, to: [outside], thread: "observed-outside" });
    const heldOnly = await world.person(OWN);
    await world.mail(OWN, { at: AT, from: a, to: [heldOnly], held: true });
    const restricting = await world.person(OWN);
    const evidence = await world.mail(OWN, { at: AT, from: a, to: [restricting] });
    await queryAs(store.db.urls.admin, "update knowledge.messages set restricting = true where evidence_id = $1", [
      evidence,
    ]);
    // The owner's audience is `own`: the audience their beliefs and warmth are built for.
    await stated(a, await world.person(OWN));
    await buildAs(store.db, OWN);

    const found = await store.admin.people.paths(target as EntityId);
    expect(found?.paths[0]?.nodes.map((one) => one.id)).toEqual([owner, a, target]);
    expect(found?.paths[0]?.edges.map((one) => one.kind)).toEqual(["tie", "shared_thread"]);
    expect(found?.paths[0]?.edges[1]).toMatchObject({ weight: 0.2, fact: null });
    expect(found?.paths[0]?.nodes[2]?.name).not.toBeNull();
    for (const none of [outside, heldOnly, restricting])
      expect((await store.admin.people.paths(none as EntityId))?.paths).toEqual([]);
  });
});
