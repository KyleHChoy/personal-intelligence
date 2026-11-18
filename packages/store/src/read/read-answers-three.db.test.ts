import { type EntityId, EntityView, SelfView } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testId } from "../test-support/clients.ts";
import { type Client, insertReader } from "../test-support/commitment-fixtures.ts";
import { queryAs } from "../test-support/database.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue } from "../test-support/values.ts";
import { seedLines } from "../test-support/warmth-lines.ts";
import { seedWorld, storeSeeder, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { Reader } from "./read.ts";

// The outcome test's third round, end to end under a client's token, on the synthetic world: what an
// agent found sits beside the fields and moves none of them, marked, and a passed deadline reads as
// passed. A close tie the system cannot see reads as that, never as quiet. Reserved domains only.

const VIEWS = ["self", "people", "work"];
const DAY = 86_400_000;

describe("answers, third round", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let reader: Reader;
  let reads: Client;
  let noSelf: Client;
  let elsewhere: Client;
  let person: string;
  let tied: string;
  let personName: string;
  let record: string;

  const day = (back: number): Date => new Date(WORLD_NOW.getTime() - back * DAY);
  const written = (when: Date): string =>
    `${when.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${when.getUTCDate()}`;
  const card = async (client: Client) =>
    EntityView.parse(outcomeValue(await reader.getEntity(client.token, { id: person as EntityId })));
  const page = async (client: Client) => SelfView.parse(outcomeValue(await reader.getSelf(client.token, {})));

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW, compartments: ["own", "employer:example", "agent:reads-reports"] });
    const world = await seedWorld(store.writer, store.admin);
    person = world.entityOf(WORLD.both.address);
    reader = new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log, now: () => store.now });
    reads = await insertReader(store, "reads-reports", ["own", "agent:reads-reports"], {
      tools: ["get_self", "get_entity", "read_message", "get_open_items", "record", "search", "find_records"],
      views: VIEWS,
    });
    noSelf = await insertReader(store, "no-self-view", ["own", "agent:reads-reports"], {
      tools: ["get_entity"],
      views: ["people"],
    });
    elsewhere = await insertReader(store, "other-label", ["employer:example"], {
      tools: ["get_self", "get_entity"],
      views: VIEWS,
    });
    const named = EntityView.parse(outcomeValue(await reader.getEntity(reads.token, { id: person as EntityId })));
    personName = named.names[0]?.untrusted ?? WORLD.both.address;

    const seed = storeSeeder(store.writer, WORLD_NOW);
    const mailbox = world.accounts.personalMail;
    if (mailbox === undefined) throw new Error("the world has the mailbox");
    await seed.mail(mailbox, {
      id: "linden-deadline",
      from: { address: "team@linden.example" },
      to: [{ address: WORLD.ownerPersonal }],
      at: day(9),
      subject: `Linden fellowship applications deadline is ${written(day(3))}`,
    });

    await seed.mail(mailbox, {
      id: "ash-old",
      from: { address: "rowan@ash.example", name: "Rowan Ash" },
      to: [{ address: WORLD.ownerPersonal }],
      at: day(40),
      subject: "A note from the summer",
    });
    const found = outcomeValue(await reader.search(reads.token, { query: "Rowan Ash" }));
    tied = found.results[0]?.id as string;

    const ack = outcomeValue(
      await reader.record(reads.token, {
        kind: "finding",
        body: [
          `${personName} moved the ${written(new Date(WORLD_NOW.getTime() + 2 * DAY))} review.`,
          "The owner decided not to apply to the Linden fellowship this round.",
          "The owner is applying for the operations lead role at Sorrel.",
        ].join(" "),
        requestId: "req-answers-three-finding",
      }),
    );
    record = ack.recordId as string;
  });

  afterAll(async () => {
    await store.close();
  });

  it("a card sets what an agent reported of the person beside the next step, marked, moving nothing", async () => {
    const lead = (await card(reads)).lead;
    expect(lead?.reported?.[0]).toMatchObject({ record, unconfirmed: true });
    expect(lead?.reported?.[0]?.said.untrusted).toContain("moved");
    // The field stands as its rows say: the words moved no kind, and closed nothing.
    const without = (await card(elsewhere)).lead;
    expect(without?.reported).toBeUndefined();
  });

  it("a client without the Self view is given no report, nor one holding no tool that serves records, and one under another label cannot tell", async () => {
    expect((await card(noSelf)).lead?.reported).toBeUndefined();
    const viewAlone = await insertReader(store, "view-alone", ["own", "agent:reads-reports"], {
      tools: ["get_self", "get_entity"],
      views: VIEWS,
    });
    expect((await card(viewAlone)).lead?.reported).toBeUndefined();
    expect(((await page(viewAlone)).applications ?? []).some((one) => one.state === "reported")).toBe(false);
    const signs = (await page(elsewhere)).applications ?? [];
    expect(signs.some((one) => one.state === "reported")).toBe(false);
    for (const sign of signs) expect(sign.reported).toBeUndefined();
  });

  it("a deadline gone by reads as passed, its state unmoved, with the agent's report beside it", async () => {
    const sign = ((await page(reads)).applications ?? []).find((one) => one.what.untrusted.startsWith("Linden"));
    expect(sign).toMatchObject({ state: "deadline", passed: true });
    expect(sign?.reported?.[0]).toMatchObject({ record, unconfirmed: true });
  });

  it("what only a finding says is listed as reported, and the read log says it was shown", async () => {
    const signs = (await page(reads)).applications ?? [];
    const reported = signs.find((one) => one.state === "reported");
    expect(reported?.what.untrusted).toContain("Sorrel");
    expect(reported?.reported?.[0]?.record).toBe(record);
    const rows = await queryAs<{ n: number }>(
      store.db.urls.admin,
      "select count(*)::int as n from ledger.read_log r where r.client_id = $1 and r.tool = 'get_self' and $2 = any(r.shown)",
      [reads.id, record],
    );
    expect(rows[0]?.n).toBeGreaterThan(0);
  });

  it("the career domain's read serves the same marks", async () => {
    const view = SelfView.parse(outcomeValue(await reader.getSelf(reads.token, { domain: "career" })));
    expect(view.applications?.some((one) => one.state === "reported")).toBe(true);
  });

  it("the owner's stated close tie outranks a quiet reading when no chat reaches the system", async () => {
    const asOf = new Date(WORLD_NOW.getTime() - 40 * DAY).toISOString();
    // The owner ruled them inner; two-way contact forty days ago, by mail or by chat.
    const seed = (entity: string, channels: string[]) =>
      seedLines(
        store.db,
        ["own"],
        [
          {
            entity,
            tier: "inner",
            warmth: 0,
            tierSource: "owner",
            ...(channels.includes("chat") ? { chatAt: new Date(asOf) } : { emailAt: new Date(asOf) }),
          },
        ],
        { today: WORLD_NOW },
      );
    const quiet = await insertReader(store, "tied", ["own"], { tools: ["get_entity"], views: ["people"] });
    const stepOf = async () =>
      EntityView.parse(outcomeValue(await reader.getEntity(quiet.token, { id: tied as EntityId }))).lead?.nextStep;
    await seed(tied, ["email"]);
    expect((await stepOf())?.kind).toBe("channel_unseen");
    await seed(tied, ["email", "chat"]);
    expect((await stepOf())?.kind).toBe("quiet");
    // `pi outcomes` reads the same line under the owner's audience, or says it has none.
    const metric = (await store.admin.box.outcomes(7)).metrics.find((one) => one.metric === "inner_ties_with_chat");
    expect(metric).toBeDefined();
  });

  it("a close tie with truly no contact reads channel_unseen; only a line out of date withholds it", async () => {
    // The owner ruled them inner, and no contact at all.
    await seedLines(store.db, ["own"], [{ entity: tied, tier: "inner", warmth: 0, tierSource: "owner" }], {
      today: WORLD_NOW,
    });
    const client = await insertReader(store, "tied-zero", ["own"], { tools: ["get_entity"], views: ["people"] });
    const stepOf = async () =>
      EntityView.parse(outcomeValue(await reader.getEntity(client.token, { id: tied as EntityId }))).lead?.nextStep;
    expect((await stepOf())?.kind).toBe("channel_unseen");

    const line = async (compartments: string[]): Promise<string> => {
      const [evidence] = await queryAs<{ evidence_id: string }>(
        store.db.urls.admin,
        "select evidence_id from knowledge.messages where compartments = $1::text[] order by id limit 1",
        [compartments],
      );
      const id = `chl_${testId("cli").slice(4)}`;
      await queryAs(
        store.db.urls.writer,
        `insert into knowledge.chat_lines (id, evidence_id, line, entity_id, direction, occurred_at, others, thread_fp, compartments)
         values ($1, $2, 900, $3, 'inbound', now(), 1, $4, $5)`,
        [id, evidence?.evidence_id, tied, "b".repeat(64), compartments],
      );
      return id;
    };
    // Invariant 6: a chat line this reader cannot see changes nothing it reads.
    const hidden = await line(["employer:example"]);
    expect((await stepOf())?.kind).toBe("channel_unseen");
    // One it can see, newer than the build: the line is out of date, and says nothing of a chat.
    const seen = await line(["own"]);
    expect((await stepOf())?.kind).not.toBe("channel_unseen");
    await queryAs(store.db.urls.admin, "delete from knowledge.chat_lines where id = any($1::text[])", [[hidden, seen]]);
    expect((await stepOf())?.kind).toBe("channel_unseen");
  });

  it("policy.group_chat_newer answers no one without a client", async () => {
    await expect(
      queryAs(store.db.urls.reader, "select policy.group_chat_newer($1::text[])", [[tied]]),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
