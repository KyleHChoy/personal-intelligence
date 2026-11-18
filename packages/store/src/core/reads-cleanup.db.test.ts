import type { Claim } from "@intelligence/contracts";
import {
  type ClaimRecord,
  CommitmentList,
  ContextPack,
  dayIn,
  type EntityId,
  EventId,
  type FactId,
  FactList,
  MemoryProjection,
  MessageList,
  SelfView,
} from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPipeline } from "../pipeline/pipeline.ts";
import { Reader } from "../read/read.ts";
import { testId } from "../test-support/clients.ts";
import { type Client, insertReader, type Message, seedCommitments } from "../test-support/commitment-fixtures.ts";
import { asTablesOwner } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { knownBy } from "../test-support/known-by.ts";
import { batchOf, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { daysFrom, outcomeValue } from "../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { fingerprint } from "./fingerprint.ts";
import { open, type Sealed } from "./seal.ts";

// The reads cleanup: get_self's `changes` and `history`, the owner's time zone as a date bound's
// day and a change's day, and a courtesy commitment that lapses in get_commitments,
// agent_bootstrap@7, meeting_prep@5, person_brief@2 and active_memory@2. Claims are committed
// through the Pipeline and every belief is computed when asked: a goal's change is dated by its end
// or by the owner's retire, each at the time the test names. No model is called. Reserved domains
// only.

const OWN = ["own"];
const ZONE_EAST = "Pacific/Kiritimati";
const ZONE_WEST = "Pacific/Pago_Pago";

type Goal = { key: string; what: string; status: "active" | "closed" | "expired"; recorded: string; message: number };

// Each goal's claim is on its own message but the first two's, so the read log tells them apart.
const GOALS: Goal[] = [
  { key: "g-active", what: "canary-0087-active", status: "active", recorded: "2026-03-09T12:00:00.000Z", message: 1 },
  // 03:00 UTC on the 8th is the evening of the 7th in Chicago.
  {
    key: "g-expired",
    what: "canary-0087-expired",
    status: "expired",
    recorded: "2026-03-08T03:00:00.000Z",
    message: 1,
  },
  // Closed an hour after its message (the 7th, noon UTC) was sent: a close is never before its claim.
  { key: "g-closed", what: "canary-0087-closed", status: "closed", recorded: "2026-03-07T13:00:00.000Z", message: 2 },
  // Forty days before now: past the thirty days of `changes`.
  { key: "g-old", what: "canary-0087-old", status: "closed", recorded: "2026-01-29T12:00:00.000Z", message: 3 },
];

describe("the reads cleanup", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let owner: string;
  let blake: string;
  let client: Client;
  let own: Message[];
  const facts = new Map<string, FactId>();

  const reader = () =>
    new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log, now: () => store.now });
  const self = async (history?: boolean) =>
    SelfView.parse(outcomeValue(await reader().getSelf(client.token, history === undefined ? {} : { history })));
  const whats = (list: CommitmentList): string[] => list.commitments.map((one) => one.what?.untrusted ?? "").sort();

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW });
    const world = await seedWorld(store.writer, store.admin);
    owner = world.ownerEntity();
    blake = world.entityOf(WORLD.both.address);
    const rows = await queryAs<{ id: string; evidence_id: string; sent_at: Date; compartment: string }>(
      store.db.urls.admin,
      "select id, evidence_id, sent_at, compartments[1] as compartment from knowledge.messages where not bulk and compartments = '{own}' order by sent_at, id",
    );
    own = rows.map((row) => ({
      id: row.id,
      evidenceId: row.evidence_id,
      sentAt: row.sent_at.toISOString(),
      compartment: row.compartment,
    }));
    if (own.length < 4) throw new Error("the world holds fewer than four of the owner's own messages");
    const at = (n: number) => own[n] as Message;

    // The commitments, each owed by the owner to Blake, on the first message.
    await seedCommitments(
      store,
      owner,
      [
        {
          key: "c-lapsed",
          subject: owner,
          counterparty: blake,
          statementKind: "proposal",
          claims: [{ message: at(0), what: "canary-0087-lapsed", at: daysFrom(WORLD_NOW, -45).toISOString() }],
        },
        {
          key: "c-past-date",
          subject: owner,
          counterparty: blake,
          due: daysFrom(WORLD_NOW, -15).toISOString().slice(0, 10),
          claims: [{ message: at(0), what: "canary-past-date", at: daysFrom(WORLD_NOW, -40).toISOString() }],
        },
        {
          key: "c-recent",
          subject: owner,
          counterparty: blake,
          statementKind: "proposal",
          claims: [{ message: at(0), what: "canary-0087-recent", at: daysFrom(WORLD_NOW, -10).toISOString() }],
        },
        {
          key: "c-stated",
          subject: owner,
          counterparty: blake,
          claims: [{ message: at(0), what: "canary-0087-stated", at: daysFrom(WORLD_NOW, -45).toISOString() }],
        },
        {
          key: "c-dated",
          subject: owner,
          counterparty: blake,
          statementKind: "proposal",
          due: "2026-04-01",
          claims: [{ message: at(0), what: "canary-0087-dated", at: daysFrom(WORLD_NOW, -45).toISOString() }],
        },
      ],
      [OWN],
    );

    // The owner's goals: claims through the Pipeline, each computed when asked. Each starts by its
    // recorded time at the latest (the old one's before its message: forty days back); an expired
    // one ends then, and a closed one is retired by the owner then, so each changed when the test
    // names.
    const records = GOALS.map((goal, index) => {
      const message = at(goal.message);
      const base = claimRecord(message.evidenceId, "own", owner, {
        n: 870 + index,
        type: "goal",
        factKey: goal.key,
        validFrom: message.sentAt < goal.recorded ? message.sentAt : goal.recorded,
      });
      return {
        goal,
        record: {
          ...base,
          claim: {
            ...base.claim,
            assertedBy: owner,
            basis: "explicit_self",
            statementKind: "stated_fact",
            content: { ...base.claim.content, type: "goal", fields: { what: goal.what } },
            ...(goal.status === "expired" ? { validTo: goal.recorded } : {}),
          } as unknown as Claim,
          subjectKind: "owner",
          fieldKinds: { what: "text" },
        } as ClaimRecord,
      };
    });
    const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
    try {
      const byItem = new Map<string, ClaimRecord[]>();
      for (const { record } of records)
        byItem.set(record.claim.primaryEvidenceId, [...(byItem.get(record.claim.primaryEvidenceId) ?? []), record]);
      for (const [evidenceId, claims] of byItem)
        expect(await pipeline.commit(batchOf(evidenceId as never, claims))).toBe("committed");
    } finally {
      await pipeline.close();
    }
    for (const { goal, record } of records) {
      const claim = fingerprint(store.db.keys, "claim", record.claim.id) as FactId;
      facts.set(goal.key, claim);
      if (goal.status !== "closed") continue;
      await store.admin.facts.retireFact(claim, { requestId: testId("req").slice(4) });
      // The claim known from its own date, then the retire at its time: never a retire before what
      // it retires was known.
      await asTablesOwner(store.db, ["knowledge.claims", "knowledge.belief_rulings"], async (query) => {
        await query("update knowledge.claims set first_known_at = $2, created_at = $2 where id = $1", [
          claim,
          record.claim.validFrom,
        ]);
        await query(
          "update knowledge.belief_rulings set created_at = $2 where fact_key_fp = $1 and verdict = 'retire'",
          [fingerprint(store.db.keys, "fact", goal.key), goal.recorded],
        );
      });
    }
    await knownBy(store.db, store.now);
    client = await insertReader(store, "cleanup-0087", OWN, {
      tools: ["get_self", "get_commitments", "build_context_pack", "find_messages", "find_facts", "sync_memory"],
      views: ["self", "people", "work"],
    });
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  it("get_self lists the beliefs about the owner that closed or expired in thirty days, newest first, one line each, and its sections the open ones alone", async () => {
    const view = await self();
    expect(view.timeZone).toBeNull();
    expect(view.changes).toEqual([
      { kind: "goal", status: "expired", at: "2026-03-08", what: { untrusted: "canary-0087-expired" } },
      { kind: "goal", status: "closed", at: "2026-03-07", what: { untrusted: "canary-0087-closed" } },
    ]);
    expect((view.sections ?? []).flatMap((one) => one.lines).map((one) => [one.kind, one.status])).toEqual([
      ["goal", "active"],
    ]);
    expect(JSON.stringify(view)).not.toContain("canary-0087-old");
  });

  it("get_self's read log binds the messages of what it served, the changes' among them, and nothing it left out", async () => {
    const view = await self();
    // Its open items are served too, each by its message.
    const open = (view.openItems?.items ?? []).filter((one) => one.source.kind === "commitment");
    const openEvidence = await queryAs<{ evidence_id: string }>(
      store.db.urls.admin,
      "select evidence_id from knowledge.messages where id = any($1)",
      [open.flatMap((one) => one.source.message ?? [])],
    );
    const [row] = await queryAs<{ bound: string[]; fact_key_fps: string[] }>(
      store.db.urls.admin,
      "select bound, fact_key_fps from ledger.read_log where client_id = $1 and tool = 'get_self' order by id desc limit 1",
      [client.id],
    );
    expect([...(row?.bound ?? [])].sort()).toEqual(
      [...new Set([own[1]?.evidenceId, own[2]?.evidenceId, ...openEvidence.map((one) => one.evidence_id)])].sort(),
    );
    const fact = (key: string) => fingerprint(store.db.keys, "fact", key);
    expect([...(row?.fact_key_fps ?? [])].sort()).toEqual(
      [...new Set([fact("g-active"), fact("g-expired"), fact("g-closed"), ...open.map((one) => one.source.id)])].sort(),
    );
  });

  it("history true keeps the beliefs that are no longer open in the sections too, the old one among them", async () => {
    const view = await self(true);
    expect(
      (view.sections ?? [])
        .flatMap((one) => one.lines)
        .map((one) => one.status)
        .sort(),
    ).toEqual(["active", "closed", "closed", "expired"]);
    expect(JSON.stringify(view.sections)).toContain("canary-0087-old");
    // `changes` is the same with or without it.
    expect(view.changes).toEqual((await self()).changes);
  });

  it("get_commitments serves no courtesy as open once thirty days pass: undated, a proposal, last confirmed 45 days ago", async () => {
    const ask = async (state?: "open" | "closed" | "any") =>
      CommitmentList.parse(
        outcomeValue(await reader().getCommitments(client.token, state === undefined ? {} : { state })),
      );
    expect(whats(await ask())).toEqual(["canary-0087-dated", "canary-0087-recent", "canary-0087-stated"]);
    expect(whats(await ask("closed"))).toEqual(["canary-0087-lapsed", "canary-past-date"]);
    expect(whats(await ask("any"))).toEqual([
      "canary-0087-dated",
      "canary-0087-lapsed",
      "canary-0087-recent",
      "canary-0087-stated",
      "canary-past-date",
    ]);
  });

  it("agent_bootstrap@7's commitments leave the lapsed courtesy out", async () => {
    const pack = ContextPack.parse(
      outcomeValue(await reader().buildContextPack(client.token, { purpose: "agent_bootstrap" })),
    );
    // agent_bootstrap@16 is the current template.
    expect(pack.template).toBe("agent_bootstrap@16");
    const served = pack.items
      .flatMap((item) => (item.kind === "commitment" ? [item.commitment.what?.untrusted ?? ""] : []))
      .sort();
    expect(served).toEqual(["canary-0087-dated", "canary-0087-recent", "canary-0087-stated"]);
  });

  // Wherever commitments are served.
  it("meeting_prep@5 and person_brief@2 leave the lapsed courtesy out", async () => {
    const served = (pack: ContextPack) =>
      pack.items.flatMap((item) => (item.kind === "commitment" ? [item.commitment.what?.untrusted ?? ""] : [])).sort();
    const brief = ContextPack.parse(
      outcomeValue(
        await reader().buildContextPack(client.token, { purpose: "person_brief", entity: blake as EntityId }),
      ),
    );
    expect(brief.template).toBe("person_brief@5");
    expect(served(brief)).toEqual(["canary-0087-dated", "canary-0087-recent", "canary-0087-stated"]);
    // The owner's meeting with Blake among its attendees.
    const events = await queryAs<{ id: string; compartments: string[]; title_enc: Sealed | null }>(
      store.db.urls.admin,
      "select event_id as id, compartments, title_enc from knowledge.event_details order by event_id",
    );
    const meeting = events.find(
      (row) =>
        row.title_enc !== null &&
        open(store.db.keys, row, "knowledge.event_details.title_enc", "throw") === WORLD.ownMeeting,
    );
    const prep = ContextPack.parse(
      outcomeValue(
        await reader().buildContextPack(client.token, { purpose: "meeting_prep", event: EventId.parse(meeting?.id) }),
      ),
    );
    expect(prep.template).toBe("meeting_prep@8");
    expect(served(prep)).toEqual(["canary-0087-dated", "canary-0087-recent", "canary-0087-stated"]);
  });

  it("active_memory@2 syncs the open commitments but the lapsed courtesy", async () => {
    const projection = MemoryProjection.parse(
      outcomeValue(await reader().syncMemory(client.token, { have: [], canDelete: true })),
    );
    expect(projection.template).toBe("active_memory@2");
    // Five commitments with Blake, three of them undated: the two lapsed are not among the entries.
    const dues = projection.entries
      .map((entry) => (entry.counterparty === blake ? (entry.due ?? "none") : "other"))
      .sort();
    expect(dues).toEqual(["2026-04-01", "none", "none"]);
  });

  it("a date alone is the owner's local day once the owner sets a zone, in find_messages and find_facts, and get_self says the zone", async () => {
    const message = own[2] as Message;
    const utc = message.sentAt.slice(0, 10);
    // One of the two zones puts the message on another day than UTC's, whatever its hour.
    const zone = dayIn(new Date(message.sentAt), ZONE_EAST) !== utc ? ZONE_EAST : ZONE_WEST;
    const local = dayIn(new Date(message.sentAt), zone);
    expect(local).not.toBe(utc);
    const messages = async (day: string) =>
      MessageList.parse(
        outcomeValue(await reader().findMessages(client.token, { from: day, to: day, limit: 50 })),
      ).messages.map((one) => one.id);
    const goals = async (day: string) =>
      FactList.parse(
        outcomeValue(await reader().findFacts(client.token, { type: "goal", from: day, to: day, limit: 50 })),
      ).facts.map((one) => one.id);

    // Unset: the UTC day.
    expect(await messages(utc)).toContain(message.id);
    expect(await goals(utc)).toContain(facts.get("g-closed"));

    expect(await store.admin.accounts.setTimeZone(zone)).toBe(zone);
    expect((await self()).timeZone).toBe(zone);
    expect(await messages(utc)).not.toContain(message.id);
    expect(await messages(local)).toContain(message.id);
    expect(await goals(utc)).not.toContain(facts.get("g-closed"));
    expect(await goals(local)).toContain(facts.get("g-closed"));
  });

  it("a change's day is the owner's local day, and a name Intl does not know is refused and changes nothing", async () => {
    expect(await store.admin.accounts.setTimeZone("america/chicago")).toBe("America/Chicago");
    const view = await self();
    expect(view.timeZone).toBe("America/Chicago");
    expect(view.changes.map((one) => [one.status, one.at])).toEqual([
      ["expired", "2026-03-07"],
      ["closed", "2026-03-07"],
    ]);
    await expect(store.admin.accounts.setTimeZone("Mars/Base")).rejects.toMatchObject({ code: "invalid_argument" });
    expect((await self()).timeZone).toBe("America/Chicago");
  });

  it("the reader, the tick, the Pipeline and the writer select the zone and no other column of the owner's settings", async () => {
    for (const url of [store.db.urls.pipeline, store.db.urls.work, store.db.urls.writer]) {
      expect(await queryAs(url, "select time_zone from policy.owner_settings")).toEqual([
        { time_zone: "America/Chicago" },
      ]);
      await expect(queryAs(url, "select one from policy.owner_settings")).rejects.toMatchObject({ code: "42501" });
    }
    expect(await queryAs(store.db.urls.admin, "select one, time_zone from policy.owner_settings")).toEqual([
      { one: true, time_zone: "America/Chicago" },
    ]);
  });
});
