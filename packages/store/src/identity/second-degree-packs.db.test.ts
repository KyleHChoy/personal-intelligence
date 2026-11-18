import type { Claim } from "@intelligence/contracts";
import {
  type ClaimRecord,
  CONNECTION_TYPE,
  ContextPack,
  EntityId,
  EventId,
  FiledMention,
  type SecondDegreeLine,
} from "@intelligence/contracts/personal";
import { namedKey } from "@intelligence/personal-core";
import type { CalendarPerson } from "@intelligence/personal-core/items";
import { secondDegreeRules } from "@intelligence/personal-core/views";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openUnder, sealRow } from "../core/seal.ts";
import { createPipeline, type Pipeline } from "../pipeline/pipeline.ts";
import { RULINGS } from "../read/read-groups.ts";
import { type Accounts, connect, OWNER, type Who } from "../test-support/cast.ts";
import { testId } from "../test-support/clients.ts";
import { type Client, insertReader } from "../test-support/commitment-fixtures.ts";
import { one, session } from "../test-support/connections.ts";
import { fingerprint, queryAs } from "../test-support/database.ts";
import { event, ingestEvent, type MailFixture, mail } from "../test-support/items.ts";
import { knownBy } from "../test-support/known-by.ts";
import { orderFault } from "../test-support/order.ts";
import { batchOf, claimRecord, stored } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { seeder } from "../test-support/seeder.ts";
import { openStore, recordingReader, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue } from "../test-support/values.ts";
import { namedScope } from "../write/named-binding.ts";

// The second degree of meeting_prep@8 and person_brief@4. Named people are made by the binding step
// from filed names, as a sync makes them; relation claims are committed through the Pipeline as a
// replay commits them, each in a letter of its own; beliefs are written as the rebuild writes them;
// a confirmed connection is seeded as the owner's release leaves one; a heard claim is a chat
// moment's, its capture linked to no event. No model is called. Synthetic people on reserved
// domains only.

const NOW = new Date("2026-10-01T09:00:00Z");
const OWN = ["own"];
const WORK = ["employer:example"];
const TOOLS = ["get_entity", "build_context_pack", "list_goals", "find_paths"];
const VIEWS = ["self", "people", "work"];

const ME: Who = { address: OWNER.personal, name: OWNER.name };
const ME_AT_WORK: Who = { address: OWNER.work, name: OWNER.name };
// Ada: the owner mailed Ada both ways, the introducer, at the meeting. Cy: wrote once, at the
// meeting. Kit, Mo, Bram, Lou: each wrote once, so the owner has no tie with them. Wren: the
// owner's colleague at work.
const ADA: Who = { address: "ada.fenn@prep-one.test", name: "Ada Fenn" };
const CY: Who = { address: "cy.dale@prep-two.test", name: "Cy Dale" };
const KIT: Who = { address: "kit.moss@prep-three.test", name: "Kit Moss" };
const MO: Who = { address: "mo.reyes@prep-four.test", name: "Mo Reyes" };
const BRAM: Who = { address: "bram.holt@prep-five.test", name: "Bram Holt" };
const LOU: Who = { address: "lou.park@prep-six.test", name: "Lou Park" };
const WREN: Who = { address: "wren.oak@prep-seven.test", name: "Wren Oak" };

let store: TestStore;
const freshReader = () => recordingReader(store);
let pipeline: Pipeline;
let accounts: Accounts;
let own: Client;
let wide: Client;
let meeting: string;
const ids: Record<"ada" | "cy" | "kit" | "mo" | "bram" | "lou" | "wren" | "theo" | "zoe" | "juno", string> =
  {} as never;

let letters = 0;
const letter = (from: Who, to: Who[], labels: string[] = ["INBOX"], at = "2026-09-10T09:00:00Z"): MailFixture => {
  letters += 1;
  const n = String(letters).padStart(4, "0");
  return mail({
    id: `gm-pck-${n}`,
    threadId: `thread-pck-${n}`,
    messageId: `pck-${n}@second-degree-packs.test`,
    at,
    from,
    to,
    subject: "A note",
    labels,
  });
};

const addressFp = (address: string): string => fingerprint(store.db.keys, "address", address);
const nameFp = (name: string): string => fingerprint(store.db.keys, "name", name);
const keyFpOf = (name: string, label: string[]): string =>
  addressFp(namedKey(fingerprint(store.db.keys, "source_id", namedScope(nameFp(name), label, null))) ?? "");
const holderOf = async (fp: string): Promise<string> =>
  one(
    await queryAs<{ entity_id: string }>(
      store.db.urls.admin,
      "select entity_id from knowledge.accounts where value_fp = $1 limit 1",
      [fp],
    ),
  ).entity_id;

// A letter from the speaker, with a first-hand relation naming `name` filed; then the sync's
// binding step makes the named person. Its id.
async function named(speaker: Who, name: string, work = false): Promise<string> {
  const account = work ? accounts.workMail : accounts.personalMail;
  const evidence = await stored(store.writer, account, letter(speaker, [work ? ME_AT_WORK : ME]));
  const mention = FiledMention.parse({
    name,
    type: "relationship",
    field: "counterparty",
    firstHand: true,
    subjectFp: addressFp(speaker.address),
    speakerFp: addressFp(speaker.address),
  });
  expect(await pipeline.commit(batchOf(evidence, [], { unresolved: 1, mentions: [mention] }))).toBe("committed");
  expect(await store.writer.bindNamed(NOW)).toMatchObject({ created: 1 });
  return holderOf(keyFpOf(name, work ? WORK : OWN));
}

type Content = { type: "relationship" | "intro_offer"; subject: string; fields: Record<string, string> };
let claims = 0;
const relationRecord = (evidence: string, label: string[], by: string, content: Content, at: string): ClaimRecord => {
  claims += 1;
  const others = Object.values(content.fields).filter((value) => value.startsWith("ent_"));
  const base = claimRecord(evidence, label, content.subject, {
    n: claims,
    type: content.type,
    factKey: `pck ${content.type} ${claims}`,
    validFrom: at,
    entities: [content.subject, ...others],
  });
  const fieldKinds =
    content.type === "intro_offer" ? { person: "entity", offer: "enum" } : { counterparty: "entity", relation: "enum" };
  return {
    ...base,
    claim: {
      ...base.claim,
      assertedBy: by,
      basis: by === content.subject ? "explicit_self" : "third_party",
      content: { ...base.claim.content, ...content },
    } as Claim,
    subjectKind: "person",
    fieldKinds,
  } as ClaimRecord;
};

// One relation claim, said by `speaker` in a letter of its own to the owner, committed as a replay
// commits it; its stored id (a fact id) and its record.
async function said(
  speaker: Who,
  by: string,
  content: Content,
  options: { at: string; work?: boolean },
): Promise<{ fact: string; record: ClaimRecord }> {
  const work = options.work === true;
  const evidence = await stored(
    store.writer,
    work ? accounts.workMail : accounts.personalMail,
    letter(speaker, [work ? ME_AT_WORK : ME], ["INBOX"], options.at),
  );
  const record = relationRecord(evidence, work ? WORK : OWN, by, content, options.at);
  expect(await pipeline.commit(batchOf(evidence, [record]))).toBe("committed");
  return { fact: fingerprint(store.db.keys, "claim", record.claim.id), record };
}

// Its stored id.
async function heard(by: string, content: Content, at: string): Promise<string> {
  const evidence = await session(store.db.urls.admin, async (query) => {
    const seed = seeder(store.db, query);
    const account = await seed.sourceAccount(OWN);
    const evidenceId = await seed.evidence(OWN, account);
    const id = testId("cap");
    await query(
      `insert into knowledge.captures (id, evidence_id, source_account_id, capture_key, revision, kind, started_at, ended_at, first_pushed_at, local_day, facts_enc, compartments)
       values ($1, $2, $3, $4, 0, 'moment', $5::timestamptz, $5::timestamptz, $5::timestamptz, ($5::timestamptz)::date, $6, $7)`,
      [
        id,
        evidenceId,
        account,
        `moment:${id.slice(4)}`,
        at,
        JSON.stringify(sealRow(store.db.keys, "own", { table: "knowledge.captures", id, column: "facts_enc" }, "{}")),
        OWN,
      ],
    );
    return evidenceId;
  });
  const record = { ...relationRecord(evidence, OWN, by, content, at), lane: "moment" } as ClaimRecord;
  expect(await pipeline.commit(batchOf(evidence, [record], { lane: "moment" }))).toBe("committed");
  return fingerprint(store.db.keys, "claim", record.claim.id);
}

// A connection the owner confirmed, as the owner's release leaves it.
async function confirmedConnection(subject: string, other: string): Promise<string> {
  const evidence = await session(store.db.urls.admin, async (query) => {
    await seeder(store.db, query).into("knowledge.claim_releases")(OWN);
    const [release] = (await query(
      "select evidence_id from knowledge.claim_releases order by created_at desc, ruling_id desc limit 1",
    )) as { evidence_id: string }[];
    return release?.evidence_id ?? "";
  });
  return session(store.db.urls.pipeline, async (query) => {
    claims += 1;
    const base = claimRecord(evidence, OWN, subject, {
      n: claims,
      type: CONNECTION_TYPE,
      factKey: `pck connection ${claims}`,
      entities: [subject, other],
      origin: "agent_record",
    });
    const record = {
      ...base,
      claim: {
        ...base.claim,
        content: { type: CONNECTION_TYPE, subject, fields: { kind: "knows", other, inferred: false } },
      },
      subjectKind: "person",
      fieldKinds: { kind: "enum", other: "entity" },
    };
    const id = fingerprint(store.db.keys, "claim", testId("connection"));
    await query(
      `insert into knowledge.claims (id, evidence_id, type, valid_from, fact_key_fp, extractor_generation, readers, compartments, released, content_enc)
       values ($1, $2, $3, $4, $5, 1, array['m-owner'], array['own'], true, $6)`,
      [
        id,
        evidence,
        CONNECTION_TYPE,
        "2026-09-13T09:00:00Z",
        fingerprint(store.db.keys, "fact", `pck connection ${claims}`),
        sealRow(store.db.keys, "own", { table: "knowledge.claims", id, column: "content_enc" }, JSON.stringify(record)),
      ],
    );
    for (const entity of [subject, other])
      await query(
        "insert into knowledge.claim_entities (claim_id, entity_id, compartments) values ($1, $2, array['own'])",
        [id, entity],
      );
    return id;
  });
}

const prep = async (client: Client): Promise<ContextPack> =>
  ContextPack.parse(
    outcomeValue(
      await freshReader().reader.buildContextPack(client.token, {
        purpose: "meeting_prep",
        event: EventId.parse(meeting),
      }),
    ),
  );
const brief = async (client: Client, entity: string): Promise<ContextPack> =>
  ContextPack.parse(
    outcomeValue(
      await freshReader().reader.buildContextPack(client.token, {
        purpose: "person_brief",
        entity: EntityId.parse(entity),
      }),
    ),
  );
const linesOf = (pack: ContextPack): SecondDegreeLine[] =>
  pack.items.flatMap((item) => (item.kind === "second_degree" ? [item.line] : []));
// Each line as `through>person:tie[/offer][ heard]`.
const shapes = (pack: ContextPack): string[] =>
  linesOf(pack).map(
    (line) =>
      `${line.through.id}>${line.person.id}:${line.tie}${line.offer === undefined ? "" : `/${line.offer}`}${line.heard === true ? " heard" : ""}`,
  );

const attendee = (who: Who): CalendarPerson => ({
  email: who.address,
  ...(who.name === undefined ? {} : { displayName: who.name }),
  responseStatus: "accepted",
});
const MEETING_TITLE = "Second degree prep";

beforeAll(async () => {
  store = await openStore({ now: NOW });
  pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
  accounts = await connect(store.writer);
  const w = store.writer;
  await stored(w, accounts.personalMail, letter(ME, [ADA], ["SENT"]));
  await stored(w, accounts.personalMail, letter(ADA, [ME]));
  for (const who of [CY, KIT, MO, BRAM, LOU]) await stored(w, accounts.personalMail, letter(who, [ME]));
  await stored(w, accounts.workMail, letter(ME_AT_WORK, [WREN], ["SENT"]));
  await stored(w, accounts.workMail, letter(WREN, [ME_AT_WORK]));
  for (const [key, who] of [
    ["ada", ADA],
    ["cy", CY],
    ["kit", KIT],
    ["mo", MO],
    ["bram", BRAM],
    ["lou", LOU],
    ["wren", WREN],
  ] as const)
    ids[key] = await holderOf(addressFp(who.address));
  // The meeting, tomorrow: the owner organizes, Ada and Cy attend.
  const fixture = event({
    event: {
      id: "evpckprep0001",
      status: "confirmed",
      etag: '"etag-pck-1"',
      updated: "2026-09-20T08:00:00Z",
      summary: MEETING_TITLE,
      start: { dateTime: "2026-10-02T15:00:00Z" },
      end: { dateTime: "2026-10-02T16:00:00Z" },
      organizer: { email: OWNER.personal, self: true },
      attendees: [
        { email: OWNER.personal, displayName: OWNER.name, responseStatus: "accepted", self: true },
        attendee(ADA),
        attendee(CY),
      ],
    },
    title: MEETING_TITLE,
    startsAt: "2026-10-02T15:00:00.000Z",
    endsAt: "2026-10-02T16:00:00.000Z",
    allDay: false,
  });
  await ingestEvent(w, accounts.personalCalendar, fixture);
  const events = await queryAs<{ id: string; compartments: string[]; title_enc: unknown }>(
    store.db.urls.admin,
    "select event_id as id, compartments, title_enc from knowledge.event_details order by event_id",
  );
  meeting =
    events.find(
      (row) =>
        row.title_enc !== null &&
        openUnder(
          store.db.keys,
          row.compartments,
          { table: "knowledge.event_details", id: row.id, column: "title_enc" },
          row.title_enc as never,
        ) === MEETING_TITLE,
    )?.id ?? "";
  // Theo Marsh, Zoe Lark and Juno Pike, named by Ada.
  ids.theo = await named(ADA, "Theo Marsh");
  ids.zoe = await named(ADA, "Zoe Lark");
  ids.juno = await named(ADA, "Juno Pike");
  own = await insertReader(store, "own-pck", OWN, { tools: TOOLS, views: VIEWS });
  wide = await insertReader(store, "wide-pck", [...WORK, ...OWN], { tools: TOOLS, views: VIEWS });
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await pipeline?.close();
  await store?.close();
}, SLOW_DB_TEST_TIMEOUT);

describe("the second degree of meeting_prep and person_brief", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("meeting_prep for a meeting with the introducer lists the named person first when a goal targets them, with the cite", async () => {
    expect(meeting).not.toBe("");
    await said(
      ADA,
      ids.ada,
      { type: "intro_offer", subject: ids.ada, fields: { person: ids.theo, offer: "offered" } },
      { at: "2026-09-12T09:00:00Z" },
    );
    const { fact: zoeOffer } = await said(
      ADA,
      ids.ada,
      { type: "intro_offer", subject: ids.ada, fields: { person: ids.zoe, offer: "suggested" } },
      { at: "2026-09-11T09:00:00Z" },
    );
    // With no goal, the offer before the suggestion.
    const before = await prep(own);
    expect(before.template).toBe("meeting_prep@8");
    expect(shapes(before)).toEqual([
      `${ids.ada}>${ids.theo}:intro_offer/offered`,
      `${ids.ada}>${ids.zoe}:intro_offer/suggested`,
    ]);

    const goal = await store.admin.work.addGoal("Meet a landscape architect.", "own", { requestId: testId("req") });
    expect(await store.admin.work.setGoalTarget(goal, ids.zoe as EntityId, { requestId: testId("req") })).toBe(true);
    const pack = await prep(own);
    expect(shapes(pack)).toEqual([
      `${ids.ada}>${ids.zoe}:intro_offer/suggested`,
      `${ids.ada}>${ids.theo}:intro_offer/offered`,
    ]);
    const [first] = linesOf(pack);
    expect(first).toMatchObject({
      through: { id: ids.ada, name: { untrusted: "Ada Fenn" } },
      person: { id: ids.zoe, nameOnly: true, address: null, name: { untrusted: "Zoe Lark" } },
      offer: "suggested",
      fact: zoeOffer,
      at: "2026-09-11T09:00:00.000Z",
      goal: { id: goal, statement: { untrusted: "Meet a landscape architect." } },
    });
    expect(linesOf(pack)[1]?.goal).toBeUndefined();
    // The section is required, each item's id its place.
    expect(
      pack.items.filter((item) => item.section === "second_degree").map((item) => [item.id, item.required]),
    ).toEqual([
      ["second_degree:0", true],
      ["second_degree:1", true],
    ]);

    // A client that may not read goals is shown the lines without the goal, in kind order.
    const blind = await insertReader(store, "blind-pck", OWN, {
      tools: ["build_context_pack"],
      views: ["self", "people"],
    });
    const unseen = await prep(blind);
    expect(shapes(unseen)).toEqual(shapes(before));
    expect(linesOf(unseen).every((line) => line.goal === undefined)).toBe(true);

    // person_brief of Ada holds the same block.
    const ofAda = await brief(own, ids.ada);
    expect(ofAda.template).toBe("person_brief@5");
    expect(shapes(ofAda)).toEqual(shapes(pack));
  });

  it("a heard claim from an unlinked chat is listed marked heard and is never a hop", async () => {
    const fact = await heard(
      ids.cy,
      { type: "relationship", subject: ids.cy, fields: { counterparty: ids.lou, relation: "friend" } },
      "2026-09-14T09:00:00Z",
    );
    const pack = await prep(own);
    expect(shapes(pack)).toContain(`${ids.cy}>${ids.lou}:relationship heard`);
    expect(linesOf(pack).find((line) => line.person.id === ids.lou)).toMatchObject({
      relation: "friend",
      fact,
      heard: true,
      at: "2026-09-14T09:00:00.000Z",
    });
    // No path reaches Lou through Cy.
    expect(outcomeValue(await freshReader().reader.findPaths(own.token, { target: ids.lou as EntityId }))).toEqual({
      paths: [],
      cut: false,
    });
  });

  it("past prepPerAttendee (5) the cut is goal, offered, suggested, a relationship, an acquaintance, a connection, then reported", async () => {
    expect(secondDegreeRules().prepPerAttendee).toBe(5);
    // Ada's own word: a colleague and an acquaintance, each a belief.
    const colleague = await said(
      ADA,
      ids.ada,
      { type: "relationship", subject: ids.ada, fields: { counterparty: ids.kit, relation: "colleague" } },
      { at: "2026-09-15T09:00:00Z" },
    );
    await said(
      ADA,
      ids.ada,
      { type: "relationship", subject: ids.ada, fields: { counterparty: ids.mo, relation: "acquaintance" } },
      { at: "2026-09-16T09:00:00Z" },
    );
    // Each builds its belief at read, once known by the reader's clock.
    await knownBy(store.db, NOW);
    await confirmedConnection(ids.ada, ids.bram);
    // Cy reports that Ada works with Juno: a reported relation, the last kind.
    await said(
      CY,
      ids.cy,
      { type: "relationship", subject: ids.ada, fields: { counterparty: ids.juno, relation: "colleague" } },
      { at: "2026-09-17T09:00:00Z" },
    );

    const pack = await prep(own);
    const ada = shapes(pack).filter((line) => line.startsWith(`${ids.ada}>`));
    expect(ada).toEqual([
      `${ids.ada}>${ids.zoe}:intro_offer/suggested`,
      `${ids.ada}>${ids.theo}:intro_offer/offered`,
      `${ids.ada}>${ids.kit}:relationship`,
      `${ids.ada}>${ids.mo}:acquaintance`,
      `${ids.ada}>${ids.bram}:connection`,
    ]);
    expect(linesOf(pack).find((line) => line.person.id === ids.kit)).toMatchObject({
      relation: "colleague",
      fact: colleague.fact,
    });
    // Juno, reported, is past the cut; with no goal on Zoe Juno would be too, so the cut is the order's.
    expect(shapes(pack)).not.toContain(`${ids.ada}>${ids.juno}:reported`);
    // Cy's heard line is Cy's own, untouched by Ada's cut.
    expect(shapes(pack)).toContain(`${ids.cy}>${ids.lou}:relationship heard`);
    // The same on every run.
    expect(shapes(await prep(own))).toEqual(shapes(pack));
    const { reader, during } = freshReader();
    for (const call of [
      () => reader.buildContextPack(own.token, { purpose: "meeting_prep", event: EventId.parse(meeting) }),
      () => reader.buildContextPack(own.token, { purpose: "person_brief", entity: EntityId.parse(ids.ada) }),
    ]) {
      const { statements } = await during(call);
      for (const text of statements.filter((one) => one !== RULINGS)) expect(orderFault(text), text).toBeNull();
    }
  });

  it("an attendee's named person under a label the client lacks is not in its pack", async () => {
    const { reader, during } = freshReader();
    const call = () => reader.buildContextPack(own.token, { purpose: "meeting_prep", event: EventId.parse(meeting) });
    await call();
    const before = await during(call);

    // Under the employer's label: Wren names Vera Quill and says Ada can introduce Vera, offered.
    const vera = await named(WREN, "Vera Quill", true);
    await said(
      WREN,
      ids.wren,
      { type: "intro_offer", subject: ids.ada, fields: { person: vera, offer: "offered" } },
      { at: "2026-09-18T09:00:00Z", work: true },
    );

    const after = await during(call);
    expect(JSON.stringify(after.answer)).toBe(JSON.stringify(before.answer));
    expect(after.statements).toEqual(before.statements);
    expect(shapes(ContextPack.parse(outcomeValue(after.answer)))).not.toContain(
      `${ids.ada}>${vera}:intro_offer/offered`,
    );
    // The control: the wide client is shown Vera, under Ada.
    expect(shapes(await prep(wide))).toContain(`${ids.ada}>${vera}:intro_offer/offered`);
  });
});
