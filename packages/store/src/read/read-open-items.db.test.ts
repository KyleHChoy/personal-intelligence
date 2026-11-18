import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ClaimRecord,
  ContextPack,
  EventId,
  OpenItem,
  OpenItems,
  SelfView,
} from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import {
  type Client,
  type CommitmentSpec,
  commitClaims,
  insertReader,
  type Message,
  type Records,
  worldMessages,
} from "../test-support/commitment-fixtures.ts";
import { queryAs } from "../test-support/database.ts";
import { knownBy } from "../test-support/known-by.ts";
import { batchOf, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue } from "../test-support/values.ts";
import { seedWorld, storeSeeder, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { PLANS } from "./read-open-items.ts";

const TOOLS = [
  "get_self",
  "get_open_items",
  "get_entity",
  "get_commitments",
  "build_context_pack",
  "context",
  "record",
  "find_facts",
];
const VIEWS = ["self", "people", "work"];
const OWN = ["own"];
const WITH_AGENT = ["agent:writer", "own"];
const WIDE = ["agent:writer", "employer:example", "own"];

const DEADLINE = "Essay for the econ seminar is due";
const REMINDER = "Problem set 4 due";
const COMMITMENT = "Send the slides to Blake";
const OVERDUE = "Send the lease back";
const NEXT = "Order the firebricks for the kiln";
const COPIED = "7:30 AM - Workout";
const OWN_BRIEF = "12:30 PM - Lunch with Pat";
const REOPENED = "Return the kiln manual to Blake";
const GONE_QUIET = "Canary lapsed promise";
const HIDDEN_PLAN = "Canary employer filing deadline";
const HIDDEN_REMINDER = "Canary employer form due";
const THIRD_PARTY = "Canary send the draft to someone else";

const whats = (items: readonly OpenItem[]): string[] => items.map((one) => one.what?.untrusted ?? "");
const kinds = (items: readonly OpenItem[]): string[] =>
  items.map((one) => `${one.source.kind}: ${one.what?.untrusted}`);

describe("open items on the world", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let owner: string;
  let project: string;
  let writerToken: string;
  let own: Client;
  let withAgent: Client;
  let wide: Client;
  let specs: CommitmentSpec[];

  const openFor = async (client: Client): Promise<OpenItems> =>
    outcomeValue(await store.reader.getOpenItems(client.token, {})) as OpenItems;
  const planOf = (message: Message, n: number, key: string, what: string, when: string, at?: string): ClaimRecord => {
    const base = claimRecord(message.evidenceId, message.compartment, owner, {
      n,
      type: "plan",
      factKey: key,
      validFrom: at ?? message.sentAt,
    });
    return {
      ...base,
      claim: { ...base.claim, content: { ...base.claim.content, fields: { what, when } } },
      fieldKinds: { what: "text", when: "date" },
    } as ClaimRecord;
  };
  const commit = async (evidence: string, claims: ClaimRecord[], options: { lane?: "agent" } = {}): Promise<void> => {
    const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
    try {
      expect(await pipeline.commit(batchOf(evidence as never, claims, options))).toBe("committed");
    } finally {
      await pipeline.close();
    }
  };

  beforeAll(async () => {
    store = await openStore({
      now: WORLD_NOW,
      compartments: ["own", "employer:example", "agent:writer", "agent:other"],
    });
    const world = await seedWorld(store.writer, store.admin);
    owner = world.ownerEntity();
    const blake = world.entityOf(WORLD.both.address);
    const wren = world.entityOf(WORLD.workOnly.address);
    const messages = await worldMessages(store);
    const on = (days: number, compartment: string): Message => {
      const found = messages.find(
        (one) =>
          one.compartment === compartment &&
          Math.round((Date.parse(one.sentAt) - WORLD_NOW.getTime()) / 86_400_000) === days,
      );
      if (found === undefined) throw new Error(`no ${compartment} message on day ${days}`);
      return found;
    };

    // A real commitment, and one under the compartment `own` cannot read.
    specs = [
      {
        key: "owed-to-blake",
        subject: owner,
        counterparty: blake,
        due: "2026-03-11",
        claims: [{ message: on(-5, "own"), what: COMMITMENT }],
      },
      // Both past their date in silence: one the owner reopens, one left to lapse.
      {
        key: "reopened-late",
        subject: owner,
        counterparty: blake,
        due: "2026-02-01",
        claims: [{ message: on(-5, "own"), what: REOPENED, at: "2026-02-01T09:00:00.000Z" }],
      },
      {
        key: "gone-quiet",
        subject: owner,
        counterparty: blake,
        due: "2026-02-20",
        claims: [{ message: on(-5, "own"), what: GONE_QUIET, at: "2026-02-20T09:00:00.000Z" }],
      },
      // Between two other people, long since: on no list of what is owed.
      {
        key: "between-others",
        subject: blake,
        counterparty: wren,
        claims: [{ message: on(-5, "own"), what: THIRD_PARTY, at: "2026-01-05T09:00:00.000Z" }],
      },
      {
        key: "owed-at-work",
        subject: owner,
        counterparty: wren,
        due: "2026-03-13",
        claims: [{ message: on(-7, "employer:example"), what: "Canary employer commitment" }],
      },
    ];
    await commitClaims(store, owner, specs);
    await knownBy(store.db, store.now);

    // The deadline, in mail someone else sent; the overdue one; a brief's lines from the owner's own address.
    await commit(on(-3, "own").evidenceId, [planOf(on(-3, "own"), 1, "deadline", DEADLINE, "2026-03-13")]);
    await commit(on(-2, "own").evidenceId, [
      planOf(on(-2, "own"), 1, "overdue", OVERDUE, "2026-03-09"),
      planOf(on(-2, "own"), 2, "copy", COPIED, "2026-03-11"),
    ]);
    await commit(on(-4, "own").evidenceId, [planOf(on(-4, "own"), 1, "brief", OWN_BRIEF, "2026-03-11")]);
    await commit(on(-6, "employer:example").evidenceId, [
      planOf(on(-6, "employer:example"), 1, "hidden", HIDDEN_PLAN, "2026-03-14"),
    ]);

    // The calendar: a reminder, the line the plan above restates, and a reminder at work.
    const seed = storeSeeder(store.writer, WORLD_NOW);
    const personal = world.accounts.personalCalendar;
    const work = world.accounts.workCalendar;
    if (personal === undefined || work === undefined) throw new Error("no calendars");
    const self = { address: WORLD.ownerPersonal };
    const day = (date: string): Date => new Date(`${date}T00:00:00.000Z`);
    await seed.event(personal, {
      id: "reminder",
      title: REMINDER,
      start: day("2026-03-12"),
      end: day("2026-03-13"),
      allDay: true,
      organizer: self,
    });
    await seed.event(personal, {
      id: "workout",
      title: "Workout",
      start: new Date("2026-03-11T13:30:00.000Z"),
      end: new Date("2026-03-11T14:30:00.000Z"),
      organizer: self,
    });
    await seed.event(work, {
      id: "reminder-at-work",
      title: HIDDEN_REMINDER,
      start: day("2026-03-12"),
      end: day("2026-03-13"),
      allDay: true,
      organizer: { address: WORLD.ownerWork },
    });

    writerToken = (
      await new Admin({
        pool: store.adminPool,
        keys: store.db.keys,
        log: store.log,
        recordEnabled: true,
      }).clients.addClient({
        name: "writer",
        runtime: "local",
        vendorRetention: "none",
        compartments: OWN as never,
        views: VIEWS as never,
        tools: TOOLS as never,
      })
    ).token;
    own = await insertReader(store, "own-reader", OWN, { tools: TOOLS, views: VIEWS });
    withAgent = await insertReader(store, "agent-reader", WITH_AGENT, { tools: TOOLS, views: VIEWS });
    wide = await insertReader(store, "wide-reader", WIDE, { tools: TOOLS, views: VIEWS });

    // An agent's next step for the owner, on a project, as extraction would commit it.
    project = await store.admin.projects.add("Canary project: the kiln", { requestId: "req-project" });
    const { recordId } = outcomeValue(
      await store.reader.record(writerToken, {
        kind: "finding",
        body: `Next: ${NEXT}.`,
        requestId: "req-finding",
        project: project as never,
      }),
    ) as { recordId: string };
    await store.writer.takeRecords();
    const [written] = await queryAs<{ evidence_id: string; compartments: string[] }>(
      store.db.urls.admin,
      "select evidence_id, compartments from ledger.agent_writes where id = $1",
      [recordId],
    );
    if (written === undefined) throw new Error("no record");
    const base = claimRecord(written.evidence_id, written.compartments, project, {
      type: "project.next_step",
      factKey: "next-step",
      validFrom: new Date(WORLD_NOW.getTime() - 3_600_000).toISOString(),
      origin: "agent_record",
      basis: "third_party",
      entities: [project],
    });
    await commit(
      written.evidence_id,
      [
        {
          ...base,
          subjectKind: "project",
          claim: { ...base.claim, content: { ...base.claim.content, fields: { what: NEXT, who: owner } } },
          fieldKinds: { what: "text", who: "entity" },
        } as ClaimRecord,
      ],
      { lane: "agent" },
    );
  }, SLOW_DB_TEST_TIMEOUT);
  afterAll(() => store.close());

  it("a deadline, a reminder, a next step and a commitment each appear once, soonest first", async () => {
    const { items } = await openFor(withAgent);
    expect(kinds(items)).toEqual([
      `plan: ${OVERDUE}`,
      `commitment: ${COMMITMENT}`,
      `calendar: ${REMINDER}`,
      `plan: ${DEADLINE}`,
      `next_step: ${NEXT}`,
    ]);
    const step = items.find((one) => one.source.kind === "next_step");
    expect(step?.project?.id).toBe(project);
    expect(step?.whoActs.kind).toBe("owner");
  });

  it("a plan copied from a calendar line, or a schedule line from the owner's own address, is no item", async () => {
    const said = whats((await openFor(withAgent)).items);
    expect(said).not.toContain(COPIED);
    expect(said).not.toContain(OWN_BRIEF);
    // Readable through find_facts still: it was left out of this read, not removed.
    const facts = JSON.stringify(outcomeValue(await store.reader.findFacts(withAgent.token, { type: "plan" })));
    expect(facts).toContain(COPIED);
  });

  it("an overdue item says so, by whole days in the owner's zone", async () => {
    const [first] = (await openFor(withAgent)).items;
    expect(first).toMatchObject({ overdue: true, lateDays: 1, due: "2026-03-09" });
    const others = (await openFor(withAgent)).items.slice(1);
    expect(others.every((one) => !one.overdue && one.lateDays === null)).toBe(true);
  });

  it("get_self carries them after the goals and the next moves, and the pack and context the same items", async () => {
    const view = outcomeValue(await store.reader.getSelf(withAgent.token)) as SelfView;
    expect(Object.keys(view).slice(0, 4)).toEqual(["goals", "withheld", "next", "openItems"]);
    const { items } = await openFor(withAgent);
    expect(view.openItems).toEqual({ items, more: false });
    const pack = outcomeValue(
      await store.reader.buildContextPack(withAgent.token, { purpose: "agent_bootstrap" }),
    ) as ContextPack;
    expect(pack.template).toBe("agent_bootstrap@16");
    expect(pack.items.flatMap((one) => (one.kind === "open_item" ? [one.openItem] : []))).toEqual(items);
    const context = outcomeValue(await store.reader.context(withAgent.token, { task: "plan my week" })) as {
      openItems: OpenItems;
    };
    expect(context.openItems.items).toEqual(items);
  });

  it(
    "the box records this read by id: one row a day per surface and item, the first time kept, and no words",
    async () => {
      const open = await store.admin.openItems.list();
      const first = await store.admin.box.backtestRecord();
      const rows = await queryAs<{
        surface: string;
        source_kind: string;
        item_key: string;
        evidence_ids: string[];
        compartments: string[];
      }>(store.db.urls.admin, "select * from ledger.surfaced_items order by item_key");
      expect(first).toMatchObject({ written: rows.length, unreached: 0 });
      expect(
        rows
          .filter((row) => row.surface === "open")
          .map((row) => row.item_key)
          .sort(),
      ).toEqual(open.items.map((one) => one.source.id as string).sort());
      for (const row of rows) {
        expect(row.evidence_ids.length).toBeGreaterThan(0);
        expect(row.compartments.length).toBeGreaterThan(0);
      }
      const words = JSON.stringify(rows);
      for (const line of [DEADLINE, REMINDER, COMMITMENT, OVERDUE, NEXT]) expect(words).not.toContain(line);
      expect((await store.admin.box.backtestRecord()).written).toBe(0);
    },
    SLOW_DB_TEST_TIMEOUT,
  );

  it("the owner's read is the same items as an agent's cleared as they are", async () => {
    const theirs = await store.admin.openItems.list();
    const shape = (items: readonly OpenItem[]) =>
      items.map(({ what, due, source, overdue }) => [what, due, source, overdue]);
    expect(shape(theirs.items)).toEqual(shape((await openFor(wide)).items));
    expect(whats(theirs.items)).toEqual(expect.arrayContaining([HIDDEN_PLAN, HIDDEN_REMINDER, NEXT, COMMITMENT]));
  });

  it("a project's card names its open next step", async () => {
    const entity = outcomeValue(await store.reader.getEntity(withAgent.token, { id: project as never })) as {
      openItems?: OpenItems;
    };
    expect(whats(entity.openItems?.items ?? [])).toEqual([NEXT]);
    const none = outcomeValue(await store.reader.getEntity(own.token, { id: project as never })) as {
      openItems?: OpenItems;
    };
    expect(none.openItems).toBeUndefined();
  });

  it("logs what it served, by id alone", async () => {
    await openFor(withAgent);
    const [row] = await queryAs<{ bound: string[]; shown: string[]; fact_key_fps: string[] }>(
      store.db.urls.admin,
      "select bound, shown, fact_key_fps from ledger.read_log where client_id = $1 and tool = 'get_open_items' order by id desc limit 1",
      [withAgent.id],
    );
    const { items } = await openFor(withAgent);
    const facts = await queryAs<{ fact_key_fp: string }>(
      store.db.urls.admin,
      "select distinct fact_key_fp from knowledge.claims where type in ('plan', 'project.next_step', 'commitment')",
    );
    const known = facts.map((one) => one.fact_key_fp);
    expect(row?.fact_key_fps.length).toBe(items.filter((one) => one.source.kind !== "calendar").length);
    for (const fact of row?.fact_key_fps ?? []) expect(known).toContain(fact);
    expect(row?.shown.length).toBeGreaterThan(0);
    expect(row?.bound.length).toBeGreaterThan(0);
    expect(JSON.stringify(row)).not.toContain(DEADLINE);
  });

  describe("an item under a compartment the caller cannot see", () => {
    it("is on the list of a client that can see it, the positive control", async () => {
      expect(whats((await openFor(wide)).items)).toEqual(
        expect.arrayContaining([HIDDEN_PLAN, HIDDEN_REMINDER, "Canary employer commitment"]),
      );
    });

    it("changes nothing the other client sees: words, order, count or more", async () => {
      const said = JSON.stringify(await openFor(own));
      for (const canary of [HIDDEN_PLAN, HIDDEN_REMINDER, "Canary employer commitment", "employer"])
        expect(said).not.toContain(canary);
      const before = said;
      // More under the hidden compartment: three more plans, sooner than anything it sees.
      const hidden = (await worldMessages(store)).filter((one) => one.compartment === "employer:example");
      const message = hidden.find(
        (one) => Math.round((Date.parse(one.sentAt) - WORLD_NOW.getTime()) / 86_400_000) === -1,
      );
      if (message === undefined) throw new Error("no message");
      await commit(message.evidenceId, [
        planOf(message, 1, "hidden-a", "Canary sooner a", "2026-03-10"),
        planOf(message, 2, "hidden-b", "Canary sooner b", "2026-03-10"),
        planOf(message, 3, "hidden-c", "Canary sooner c", "2026-03-10"),
      ]);
      expect(JSON.stringify(await openFor(own))).toBe(before);
      expect(whats((await openFor(wide)).items)).toContain("Canary sooner a");
    });

    it("a client with no work view gets the plans and the calendar, and no commitment or next step", async () => {
      const selfOnly = await insertReader(store, "self-reader", WITH_AGENT, { tools: TOOLS, views: ["self"] });
      expect(kinds((await openFor(selfOnly)).items)).toEqual([
        `plan: ${OVERDUE}`,
        `calendar: ${REMINDER}`,
        `plan: ${DEADLINE}`,
      ]);
    });
  });

  describe("the owner's Done or Drop", () => {
    it("takes an item off every reader's list, a reopen brings it back, and a client it cannot read sees no close", async () => {
      const item = (await openFor(withAgent)).items.find((one) => one.what?.untrusted === DEADLINE);
      if (item === undefined) throw new Error("no deadline");
      await store.admin.openItems.close(
        { source: "plan", key: item.source.id, ending: "done" },
        { requestId: "req-close-1" },
      );
      expect(whats((await openFor(withAgent)).items)).not.toContain(DEADLINE);
      expect(whats((await store.admin.openItems.list()).items)).not.toContain(DEADLINE);
      await store.admin.openItems.reopen(item.source.id, { requestId: "req-reopen-1" });
      expect(whats((await openFor(withAgent)).items)).toContain(DEADLINE);
    });

    it("a statement the client cannot read keeps nothing open that it can read", async () => {
      // The deadline restated under the compartment `withAgent` cannot read: the close's label holds both.
      const hidden = (await worldMessages(store)).find(
        (one) =>
          one.compartment === "employer:example" &&
          Math.round((Date.parse(one.sentAt) - WORLD_NOW.getTime()) / 86_400_000) === -6,
      );
      if (hidden === undefined) throw new Error("no message");
      await commit(hidden.evidenceId, [
        planOf(hidden, 1, "hidden", HIDDEN_PLAN, "2026-03-14"),
        planOf(hidden, 2, "deadline", DEADLINE, "2026-03-13"),
      ]);
      const item = (await openFor(withAgent)).items.find((one) => one.what?.untrusted === DEADLINE);
      if (item === undefined) throw new Error("no deadline");
      await store.admin.openItems.close(
        { source: "plan", key: item.source.id, ending: "done" },
        { requestId: "req-close-4" },
      );
      const [label] = await queryAs<{ compartments: string[] }>(
        store.db.urls.admin,
        "select compartments from knowledge.owner_decisions where request_id = 'req-close-4'",
      );
      expect(label?.compartments).toContain("employer:example");
      expect(whats((await openFor(withAgent)).items)).not.toContain(DEADLINE);
      expect(whats((await openFor(wide)).items)).not.toContain(DEADLINE);
      await store.admin.openItems.reopen(item.source.id, { requestId: "req-reopen-4" });
      expect(whats((await openFor(withAgent)).items)).toContain(DEADLINE);
    });

    it("pia outcomes counts what is open, and a Done reopened counts as nothing, one that stands as done", async () => {
      const metric = async (name: string) =>
        (await store.admin.box.outcomes(14)).metrics.find((one) => one.metric === name);
      const open = (await store.admin.openItems.list()).items.length;
      expect(await metric("open_items_count")).toMatchObject({ value: open });
      // The Done above was reopened, so nothing has ended as done; the promise gone quiet ended lapsed.
      const before = await metric("open_items_done_share");
      expect(before).toMatchObject({ value: 0, sample: 1 });
      const item = (await openFor(withAgent)).items.find((one) => one.what?.untrusted === OVERDUE);
      if (item === undefined) throw new Error("no overdue item");
      await store.admin.openItems.close(
        { source: "plan", key: item.source.id, ending: "done" },
        { requestId: "req-close-5" },
      );
      expect(await metric("open_items_count")).toMatchObject({ value: open - 1 });
      expect(await metric("open_items_done_share")).toMatchObject({ value: 0.5, sample: 2, state: "no_data" });
      await store.admin.openItems.reopen(item.source.id, { requestId: "req-reopen-5" });
    });

    // Findings on a project, as extraction commits them; each its own record, with the fact keys given.
    const report = async (
      token: string,
      steps: { key: string; what: string; due?: string; n?: number }[],
      request: string,
      minutesAgo = 30,
    ): Promise<void> => {
      const { recordId } = outcomeValue(
        await store.reader.record(token, {
          kind: "finding",
          body: `Next: ${steps.map((one) => one.what).join(", ")}.`,
          requestId: request,
          project: project as never,
        }),
      ) as { recordId: string };
      await store.writer.takeRecords();
      const [written] = await queryAs<{ evidence_id: string; compartments: string[] }>(
        store.db.urls.admin,
        "select evidence_id, compartments from ledger.agent_writes where id = $1",
        [recordId],
      );
      if (written === undefined) throw new Error("no record");
      await commit(
        written.evidence_id,
        steps.map((one, n) => {
          const base = claimRecord(written.evidence_id, written.compartments, project, {
            n: n + 1,
            type: "project.next_step",
            factKey: one.key,
            validFrom: new Date(WORLD_NOW.getTime() - minutesAgo * 60_000).toISOString(),
            origin: "agent_record",
            basis: "third_party",
            entities: [project],
          });
          return {
            ...base,
            subjectKind: "project",
            claim: {
              ...base.claim,
              content: {
                ...base.claim.content,
                fields: { what: one.what, who: owner, ...(one.due === undefined ? {} : { due: one.due }) },
              },
            },
            fieldKinds: { what: "text", who: "entity", due: "date" },
          } as ClaimRecord;
        }),
        { lane: "agent" },
      );
    };
    const steps = async (): Promise<OpenItem[]> =>
      (await openFor(withAgent)).items.filter((one) => one.source.kind === "next_step");
    const itemNamed = async (what: string): Promise<OpenItem> => {
      const found = (await openFor(withAgent)).items.find((one) => one.what?.untrusted === what);
      if (found === undefined) throw new Error(`no item: ${what}`);
      return found;
    };
    const close = (item: OpenItem, ending: "done" | "dropped", request: string) =>
      store.admin.openItems.close(
        { source: item.source.kind as "plan", key: item.source.id, ending },
        { requestId: request },
      );

    it("two steps of one report under one fact key are two items, and Done closes the one", async () => {
      await report(
        writerToken,
        [
          { key: "one-thread-key", what: "Cut the shelf boards" },
          { key: "one-thread-key", what: "Seal the kiln door" },
        ],
        "req-two-steps",
        20,
      );
      const listed = await steps();
      expect(whats(listed).sort()).toEqual(["Cut the shelf boards", "Seal the kiln door"]);
      expect(new Set(listed.map((one) => one.source.id)).size).toBe(2);
      await close(await itemNamed("Seal the kiln door"), "done", "req-done-one-of-two");
      expect(whats(await steps())).toEqual(["Cut the shelf boards"]);
    });

    it("two plans of one date under one fact key are two items, and Drop closes the one", async () => {
      const message = (await worldMessages(store)).find(
        (one) =>
          one.compartment === "own" && Math.round((Date.parse(one.sentAt) - WORLD_NOW.getTime()) / 86_400_000) === -3,
      );
      if (message === undefined) throw new Error("no message");
      await commit(message.evidenceId, [
        planOf(message, 1, "deadline", DEADLINE, "2026-03-13"),
        planOf(message, 2, "thread-plan", "Book the kiln delivery", "2026-03-20"),
        planOf(message, 3, "thread-plan", "Book the flue inspection", "2026-03-20"),
      ]);
      await close(await itemNamed("Book the kiln delivery"), "dropped", "req-drop-one-of-two");
      const said = whats((await openFor(withAgent)).items);
      expect(said).toContain("Book the flue inspection");
      expect(said).not.toContain("Book the kiln delivery");
    });

    it("a dropped step re-reported in a new record under a new fact key stays dropped; a new date brings it back", async () => {
      await close(await itemNamed("Cut the shelf boards"), "dropped", "req-drop-boards");
      await report(writerToken, [{ key: "another-thread", what: "cut the  shelf boards." }], "req-again", 10);
      expect(whats(await steps())).toEqual([]);
      await report(
        writerToken,
        [{ key: "a-third-thread", what: "Cut the shelf boards", due: "2026-03-25" }],
        "req-dated",
        5,
      );
      expect(whats(await steps())).toEqual(["Cut the shelf boards"]);
    });

    it("a held message's later statement ends no Done; one the read serves does", async () => {
      const held = (await worldMessages(store)).find(
        (one) =>
          one.compartment === "own" && Math.round((Date.parse(one.sentAt) - WORLD_NOW.getTime()) / 86_400_000) === -4,
      );
      if (held === undefined) throw new Error("no message");
      const later = new Date(WORLD_NOW.getTime() + 60_000).toISOString();
      const item = await itemNamed(DEADLINE);
      await store.admin.openItems.close(
        { source: "plan", key: item.source.id, ending: "done" },
        { requestId: "req-done-held" },
      );
      await commit(held.evidenceId, [
        planOf(held, 1, "brief", OWN_BRIEF, "2026-03-11"),
        planOf(held, 2, "deadline", DEADLINE, "2026-03-13", later),
      ]);
      await queryAs(store.db.urls.admin, "update knowledge.messages set held = true where id = $1", [held.id]);
      expect(whats((await openFor(withAgent)).items)).not.toContain(DEADLINE);
      await queryAs(store.db.urls.admin, "update knowledge.messages set held = false where id = $1", [held.id]);
      expect(whats((await openFor(withAgent)).items)).toContain(DEADLINE);
      await store.admin.openItems.reopen(item.source.id, { requestId: "req-reopen-held" });
    });

    it("a report naming only someone else's step, or another agent's, erases none of the owner's", async () => {
      const both = await insertReader(store, "both-reader", ["agent:other", "agent:writer", "own"], {
        tools: TOOLS,
        views: VIEWS,
      });
      const stepsOf = async (): Promise<string[]> =>
        whats((await openFor(both)).items.filter((one) => one.source.kind === "next_step"));
      const before = await stepsOf();
      expect(before.length).toBeGreaterThan(0);
      const other = await new Admin({
        pool: store.adminPool,
        keys: store.db.keys,
        log: store.log,
        recordEnabled: true,
      }).clients.addClient({
        name: "other",
        runtime: "local",
        vendorRetention: "none",
        compartments: ["own"] as never,
        views: VIEWS as never,
        tools: TOOLS as never,
      });
      await report(other.token, [{ key: "other-agent", what: "Vent the kiln room" }], "req-other-agent", 1);
      expect((await stepsOf()).sort()).toEqual([...before, "Vent the kiln room"].sort());
    });

    it("works on a calendar reminder by its id, and refuses a key of the wrong form", async () => {
      const item = (await openFor(withAgent)).items.find((one) => one.source.kind === "calendar");
      if (item === undefined) throw new Error("no reminder");
      await store.admin.openItems.close(
        { source: "calendar", key: item.source.id, ending: "dropped" },
        { requestId: "req-close-2" },
      );
      expect(whats((await openFor(withAgent)).items)).not.toContain(REMINDER);
      await expect(
        store.admin.openItems.close(
          { source: "plan", key: item.source.id, ending: "done" },
          { requestId: "req-close-3" },
        ),
      ).rejects.toMatchObject({ code: "not_found" });
      await store.admin.openItems.reopen(item.source.id, { requestId: "req-reopen-2" });
      expect(whats((await openFor(withAgent)).items)).toContain(REMINDER);
    });
  });

  describe("what moved on, and what else is owed", () => {
    const ownOn = async (days: number): Promise<Message> => {
      const found = (await worldMessages(store)).find(
        (one) =>
          one.compartment === "own" && Math.round((Date.parse(one.sentAt) - WORLD_NOW.getTime()) / 86_400_000) === days,
      );
      if (found === undefined) throw new Error(`no message on day ${days}`);
      return found;
    };

    it("one sender's notices of a deadline are one item, its later receipt ends it, and another sender's stays", async () => {
      const [first, second] = [await ownOn(-3), await ownOn(-2)];
      const senders = await queryAs<{ id: string; sender_fp: string | null }>(
        store.db.urls.admin,
        "select id, sender_fp from knowledge.messages where id = any($1::text[])",
        [[first.id, second.id]],
      );
      const mark = (id: string, sender: string | null, bulk = true): Promise<unknown> =>
        queryAs(store.db.urls.admin, "update knowledge.messages set bulk = $3, sender_fp = $2 where id = $1", [
          id,
          sender,
          bulk,
        ]);
      await mark(first.id, "b".repeat(64));
      await mark(second.id, "b".repeat(64));
      const DUE = "Canary your Week 3 studio report is due";
      const LATE = "Canary we have not received your Week 3 studio report, and its deadline has passed";
      const AD = "Canary fellowship: apply by March 20, application deadline";
      await commit(first.evidenceId, [
        planOf(first, 801, "notice-due", DUE, "2026-03-15"),
        planOf(first, 802, "notice-ad", AD, "2026-03-20"),
      ]);
      await commit(second.evidenceId, [planOf(second, 803, "notice-late", LATE, "2026-03-15")]);
      const shown = whats((await openFor(withAgent)).items);
      expect(shown).toContain(LATE);
      expect(shown).not.toContain(DUE);
      expect(shown).not.toContain(AD);

      await commit(second.evidenceId, [
        planOf(second, 804, "notice-received", "Canary Week 3 studio report received.", "2026-03-15"),
      ]);
      const auth = (id: string, value: string): Promise<unknown> =>
        queryAs(store.db.urls.admin, "update knowledge.messages set auth = $2 where id = $1", [id, value]);
      // A receipt from mail that did not pass ends nothing, and no line of its says anything was done.
      await auth(second.id, "none");
      const spoofed = whats((await openFor(withAgent)).items);
      expect(spoofed).toContain(DUE);
      expect(spoofed.filter((one) => one?.includes("report received"))).toEqual([]);
      await auth(second.id, "pass");
      const after = whats((await openFor(withAgent)).items);
      expect(after.filter((one) => one?.includes("studio report"))).toEqual([]);
      // Mail that failed gives no notice: no item, and no stay.
      await auth(second.id, "none");
      await auth(first.id, "fail");
      expect(whats((await openFor(withAgent)).items).filter((one) => one?.includes("studio report"))).toEqual([]);
      await auth(first.id, "none");

      await mark(second.id, "c".repeat(64));
      expect(whats((await openFor(withAgent)).items)).toContain(DUE);

      // As the tests after this one expect them.
      for (const { id, sender_fp } of senders) await mark(id, sender_fp, false);
      await commit(second.evidenceId, [
        planOf(second, 1, "overdue", OVERDUE, "2026-03-09"),
        planOf(second, 2, "copy", COPIED, "2026-03-11"),
      ]);
      await commit(first.evidenceId, [planOf(first, 1, "deadline", DEADLINE, "2026-03-13")]);
    });

    it("the owner's later message on a thread closes nothing and is marked; a later plan of the owner's moving it to a new date replaces it", async () => {
      const first = await ownOn(-2);
      const reply = await ownOn(-3);
      const thread = "a".repeat(64);
      const set = (id: string, direction: string): Promise<unknown> =>
        queryAs(store.db.urls.admin, "update knowledge.messages set thread_fp = $2, direction = $3 where id = $1", [
          id,
          thread,
          direction,
        ]);
      await set(first.id, "inbound");
      // A commit replaces an item's claims, so this message's plans above are said again.
      await commit(first.evidenceId, [
        planOf(first, 1, "overdue", OVERDUE, "2026-03-09"),
        planOf(first, 2, "copy", COPIED, "2026-03-11"),
        planOf(first, 901, "moved-meeting", "Canary Thursday at 4pm works great", "2099-01-05"),
        planOf(first, 902, "kept-deadline", "Canary thread form due", "2099-01-05"),
      ]);
      const before = (await openFor(withAgent)).items.find(
        (one) => one.what?.untrusted === "Canary Thursday at 4pm works great",
      );
      expect(before).toBeDefined();
      expect(before?.repliedAt).toBeUndefined();

      const later = new Date(WORLD_NOW.getTime() - 3_600_000).toISOString();
      await queryAs(store.db.urls.admin, "update knowledge.messages set sent_at = $2 where id = $1", [reply.id, later]);
      await set(reply.id, "outbound");
      const replied = (await openFor(withAgent)).items.find(
        (one) => one.what?.untrusted === "Canary Thursday at 4pm works great",
      );
      expect(replied?.repliedAt).toBe(later);

      await commit(reply.evidenceId, [
        planOf(reply, 1, "deadline", DEADLINE, "2026-03-13"),
        planOf(reply, 903, "moving-it", "Canary let us move it to Friday", "2099-01-06", later),
      ]);
      const said = whats((await openFor(withAgent)).items);
      expect(said).not.toContain("Canary Thursday at 4pm works great");
      expect(said).toContain("Canary let us move it to Friday");
      expect(said).toContain("Canary thread form due");
      // Readable through find_facts still: it was left out of this read, not removed.
      const facts = JSON.stringify(outcomeValue(await store.reader.findFacts(withAgent.token, { type: "plan" })));
      expect(facts).toContain("Canary Thursday at 4pm works great");
    });

    it("a dated situation that says a deadline is an item at its date, with its record; one that does not is none", async () => {
      const { recordId } = outcomeValue(
        await store.reader.record(writerToken, {
          kind: "finding",
          body: "Canary grant application is open.",
          requestId: "req-situation",
        }),
      ) as { recordId: string };
      await store.writer.takeRecords();
      const [written] = await queryAs<{ evidence_id: string; compartments: string[] }>(
        store.db.urls.admin,
        "select evidence_id, compartments from ledger.agent_writes where id = $1",
        [recordId],
      );
      if (written === undefined) throw new Error("no record");
      const situation = (n: number, factKey: string, what: string): ClaimRecord => {
        const base = claimRecord(written.evidence_id, written.compartments, owner, {
          n,
          type: "situation",
          factKey,
          validFrom: new Date(WORLD_NOW.getTime() - 3_600_000).toISOString(),
          origin: "agent_record",
          basis: "third_party",
        });
        return {
          ...base,
          claim: {
            ...base.claim,
            validTo: "2099-01-08T23:59:59.999Z",
            content: { ...base.claim.content, fields: { what, until: "2099-01-08" } },
          },
          fieldKinds: { what: "text", until: "date" },
        } as ClaimRecord;
      };
      await commit(
        written.evidence_id,
        [
          situation(1, "applying", "Canary grant application"),
          situation(2, "budget", "Canary team budget about thirty"),
        ],
        { lane: "agent" },
      );
      const { items } = await openFor(withAgent);
      expect(items.find((one) => one.what?.untrusted === "Canary grant application")).toMatchObject({
        due: "2099-01-08",
        source: { kind: "plan", record: recordId, agent: "writer" },
      });
      expect(whats(items)).not.toContain("Canary team budget about thirty");
    });

    it("a commitment between two others stays off the lists, and lapsed reads dormant, not active", async () => {
      expect(whats((await openFor(wide)).items)).not.toContain(THIRD_PARTY);
      const { facts } = outcomeValue(await store.reader.findFacts(wide.token, { type: "commitment", limit: 50 })) as {
        facts: { status?: string; fields: { what?: { untrusted: string } } }[];
      };
      expect(facts.find((one) => one.fields.what?.untrusted === THIRD_PARTY)?.status).toBe("dormant");
    });
  });

  it("a commitment past its date is off the list; reopened, its read's clock starts again and it stays", async () => {
    expect(whats((await openFor(withAgent)).items)).not.toContain(REOPENED);
    const fact = fingerprint(store.db.keys, "fact", "reopened-late");
    await store.admin.commitments.closeCommitment(fact, "released", { requestId: "req-close-late" });
    await store.admin.commitments.reopenCommitment(fact, { requestId: "req-reopen-late" });
    const said = (await openFor(withAgent)).items.find((one) => one.what?.untrusted === REOPENED);
    expect(said).toMatchObject({ overdue: true, due: "2026-02-01" });
    expect(whats((await store.admin.openItems.list()).items)).toContain(REOPENED);
    expect(whats((await openFor(withAgent)).items)).not.toContain(GONE_QUIET);
  });

  // Last: it erases the reminder the tests above read.
  it("erasing a reminder its close and reopen name taints them, and no id or date of it stays", async () => {
    const item = (await openFor(withAgent)).items.find((one) => one.what?.untrusted === REMINDER);
    if (item === undefined) throw new Error("no reminder");
    const event = item.source.id;
    await store.admin.openItems.close(
      { source: "calendar", key: event, ending: "done" },
      { requestId: "req-close-erased" },
    );
    const named = (): Promise<{ id: string; subject_fps: string[] }[]> =>
      queryAs(
        store.db.urls.admin,
        "select id, subject_fps from knowledge.owner_decisions where kind in ('open_item_close', 'open_item_reopen') and details ->> 'key' = $1 order by id",
        [event],
      );
    const decided = await named();
    expect(decided.length).toBeGreaterThanOrEqual(3);
    const [source] = await queryAs<{ evidence_id: string }>(
      store.db.urls.admin,
      "select evidence_id from knowledge.events where id = $1",
      [event],
    );
    for (const one of decided) expect(one.subject_fps).toEqual([source?.evidence_id]);
    const dir = await mkdtemp(join(tmpdir(), "pi-open-items-"));
    const erasing = new Admin({
      pool: store.adminPool,
      keys: store.db.keys,
      log: store.log,
      journal: join(dir, "keys.json.erasures"),
      recordEnabled: true,
    });
    try {
      await erasing.erasure.eraseItem({ kind: "event", id: event as EventId }, { requestId: "req-erase-reminder" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(await named()).toEqual([]);
    const after = await queryAs<{ tainted: boolean; subject_fps: string[]; details: Record<string, unknown> }>(
      store.db.urls.admin,
      "select tainted_at is not null as tainted, subject_fps, details from knowledge.owner_decisions where id = any($1::text[])",
      [decided.map((one) => one.id)],
    );
    expect(after.length).toBe(decided.length);
    for (const one of after) {
      expect(one).toMatchObject({ tainted: true, subject_fps: [] });
      for (const gone of ["key", "match", "due"]) expect(one.details).not.toHaveProperty(gone);
    }
  });

  describe("a deadline in a person's mail", () => {
    const FOR_OWNER = "Your essay on tidal power is due Friday.";
    const THEIR_OWN = "My grant report is due Friday.";
    const NO_DATE = "Your essay on tidal power is due sometime.";
    const REMARK = "Lovely to see you at the cafe.";
    const AGREED = "Coffee at the pier cafe on Thursday at 10.";
    const ELSEWHERE = "Site visit at the depot on Thursday at 2.";

    it("is an open item in its own words; their own deadline, a remark and a line with no date are not", async () => {
      const [row] = await queryAs<{ evidence_id: string; entity_id: string }>(
        store.db.urls.admin,
        `select m.evidence_id, i.entity_id from knowledge.messages m
         join knowledge.interaction_log i on i.evidence_id = m.evidence_id and i.entity_role = 'sender' and i.direction = 'inbound'
         where m.compartments = array['own'] and m.direction = 'inbound' and not m.bulk and not m.held
         order by m.sent_at desc, m.id limit 1`,
      );
      const message = (await worldMessages(store)).find((one) => one.evidenceId === row?.evidence_id) as Message;
      expect(message).toBeDefined();
      const auth = (value: string): Promise<unknown> =>
        queryAs(store.db.urls.admin, "update knowledge.messages set auth = $2 where id = $1", [message.id, value]);
      await auth("none");
      const person = row?.entity_id as string;
      const line = (
        n: number,
        key: string,
        what: string,
        when?: string,
        subject = person,
        counterparty?: string,
      ): ClaimRecord => {
        const plan = planOf(
          message,
          n,
          key,
          what,
          when ?? "2099-01-05",
          new Date(WORLD_NOW.getTime() - 3_600_000).toISOString(),
        );
        const fields = {
          what,
          ...(when === null ? {} : { when: when ?? "2099-01-05" }),
          ...(counterparty === undefined ? {} : { counterparty }),
        };
        return {
          ...plan,
          subjectKind: "person",
          ...(counterparty === undefined ? {} : { fieldKinds: { ...plan.fieldKinds, counterparty: "entity" } }),
          claim: { ...plan.claim, content: { ...plan.claim.content, subject, fields } },
        } as unknown as ClaimRecord;
      };
      await commit(message.evidenceId, [
        line(951, "person-deadline", FOR_OWNER),
        line(952, "person-own", THEIR_OWN),
        line(953, "person-remark", REMARK),
        line(954, "person-other", FOR_OWNER.replace("tidal", "solar"), undefined, project),
        line(955, "person-undated", NO_DATE, null as never),
        line(956, "person-agreed", AGREED, undefined, person, owner),
        line(957, "person-elsewhere", ELSEWHERE, undefined, person, project),
      ]);
      // Mail that did not pass authentication says nothing to the owner by itself.
      expect(whats((await openFor(own)).items)).not.toContain(FOR_OWNER);
      await auth("pass");
      const listed = whats((await openFor(own)).items);
      expect(listed).toContain(FOR_OWNER);
      for (const off of [THEIR_OWN, REMARK, NO_DATE, FOR_OWNER.replace("tidal", "solar"), ELSEWHERE])
        expect(listed).not.toContain(off);
      // A plan the person proposed with the owner as its counterparty is the owner's arrangement.
      expect(listed).toContain(AGREED);
      // Whether the owner ever wrote to the sender, which puts a stranger's date after a reply owed.
      const rows = await queryAs<{ sender_entity: string | null; sender_written: boolean }>(
        store.db.urls.admin,
        PLANS,
        [0, 1000, ["own"], []],
      );
      const outbound = await queryAs<{ n: number }>(
        store.db.urls.admin,
        "select count(*)::int as n from knowledge.interaction_log where entity_id = $1 and direction = 'outbound'",
        [person],
      );
      expect(rows.find((one) => one.sender_entity === person)?.sender_written).toBe((outbound[0]?.n ?? 0) > 0);
      // The owner's own page reads it too.
      expect(whats((await store.admin.openItems.list()).items)).toContain(FOR_OWNER);
      // A line filed under a person reads only with their view.
      const noPeople = await insertReader(store, "self-only", OWN, { tools: TOOLS, views: ["self", "work"] });
      expect(whats((await openFor(noPeople)).items)).not.toContain(FOR_OWNER);
      expect(whats((await openFor(noPeople)).items)).not.toContain(AGREED);
    });
  });
});
