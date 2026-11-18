import { DECISION_POINT_PINS, type DecisionPointCall } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex, testId } from "../test-support/clients.ts";
import {
  type CommitmentSpec,
  commitClaims,
  logTrigger,
  type Message,
  type Seeded,
  seededOf,
  worldMessages,
} from "../test-support/commitment-fixtures.ts";
import { one, sqlState } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { insertWorkClient } from "../test-support/work-clients.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { createDispatch, type Dispatch } from "./dispatch.ts";

// Wakes from state: the tick's candidates from ledger.state_wakes, as pi_work, which reads the
// after-commit diff's trigger rows. Every refusal has its positive control in the same test. Each
// test uses its own commitments, all seeded once.

const OWN = ["own"];
const WIDE = ["employer:example", "own"];
const HOUR = 3_600_000;
const AT = new Date("2026-06-01T12:00:00.000Z");

const RUN: DecisionPointCall = {
  point: "wake_worth_run",
  version: 1,
  definitionHash: DECISION_POINT_PINS["wake_worth_run@1"] ?? "",
  rung: 0,
  inputHash: sha256Hex("wake_worth_run:run"),
  output: "run",
  effect: "start_run",
  effectClass: "internal_reversible",
  escalated: false,
};
const SKIP: DecisionPointCall = {
  ...RUN,
  inputHash: sha256Hex("wake_worth_run:skip"),
  output: "skip",
  effect: "record_silence",
  effectClass: "narrow",
};

describe("wakes from state: commitment_due", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let dispatch: Dispatch;
  let seeded: Map<string, Seeded>;
  let reasonerId: string;
  let pat: string;
  let blakeMessage: Message;
  const admin = <Row = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<Row[]> =>
    queryAs<Row>(store.db.urls.admin, text, values);
  const fact = (key: string): string => {
    const found = seeded.get(key);
    if (found === undefined) throw new Error(`no commitment ${key}`);
    return found.fact;
  };
  const candidates = async (now: Date = AT) =>
    (await dispatch.wakeCandidates(now)).filter((one) => one.source === "commitment_due");
  const candidate = async (key: string, now: Date = AT) =>
    (await candidates(now)).find((one) => one.wakeKey === `commitment:${fact(key)}`);
  // A `due` row of the trigger log for the key, as the after-commit diff writes one.
  const logged = (key: string, options: { clearance?: string[]; compartments?: string[]; at?: Date } = {}) =>
    logTrigger(store, {
      fact: fact(key),
      clearance: options.clearance ?? OWN,
      raise: "due",
      compartments: options.compartments ?? OWN,
      at: options.at ?? AT,
    });
  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW });
    const world = await seedWorld(store.writer, store.admin);
    const owner = world.ownerEntity();
    const blake = world.entityOf(WORLD.both.address);
    pat = world.entityOf(WORLD.ownOnly.address);
    const all = await worldMessages(store);
    const own = all.filter((m) => m.compartment === "own");
    const work = all.find((m) => m.compartment === "employer:example");
    const second = own[1];
    if (second === undefined || work === undefined) throw new Error("the world has too few messages");
    // An inbound message, so a veto on its sender's address covers it.
    const [inbound] = await queryAs<{ id: string }>(
      store.db.urls.admin,
      "select id from knowledge.messages where direction = 'inbound' and compartments = '{own}' order by sent_at, id limit 1",
    );
    const found = own.find((m) => m.id === inbound?.id);
    if (found === undefined) throw new Error("the world has no inbound own message");
    blakeMessage = found;
    const spec = (
      key: string,
      due: string,
      counterparty: string = blake,
      message: Message = second,
      subject: string = owner,
    ): CommitmentSpec => ({ key, subject, counterparty, due, claims: [{ message, what: `canary-${key}` }] });
    const specs: CommitmentSpec[] = [
      spec("k-live", "2026-06-01"),
      spec("k-today", "2026-06-01"),
      spec("k-tomorrow", "2026-06-02"),
      spec("k-far", "2026-06-04"),
      spec("k-past", "2026-05-31"),
      spec("k-soon", "2026-06-01T14:00:00.000Z"),
      spec("k-late", "2026-06-02T13:00:00.000Z"),
      spec("k-twice", "2026-06-01"),
      spec("k-moved-a", "2026-06-01"),
      spec("k-moved-b", "2026-06-02"),
      spec("k-pat", "2026-06-01", pat),
      spec("k-sender", "2026-06-01", owner, blakeMessage, blake),
      spec("k-gone", "2026-06-01"),
      spec("k-old", "2026-06-01"),
      spec("k-nobody", "2026-06-01"),
      spec("k-work", "2026-06-01", blake, work),
      spec("k-canary", "2026-06-01"),
    ];
    const records = await commitClaims(store, owner, specs);
    seeded = seededOf(store, specs, records);
    reasonerId = (await insertWorkClient(store.db, "state-wakes-reasoner", OWN, { kind: "reasoner" })).id;
    dispatch = createDispatch({ url: store.db.urls.work, log: recordingLogger().log, journal: "" });
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await dispatch?.close();
    await store?.close();
  });

  it("two due rows of one key are one wake; a moved due date is another key; a run uses the key up", async () => {
    // A moved due date is another fact key, so another belief and another key.
    expect(fact("k-moved-a")).not.toBe(fact("k-moved-b"));

    // The candidate comes from the trigger log: two due rows of one key are one wake.
    expect(await candidate("k-twice")).toBeUndefined();
    await logged("k-twice");
    await logged("k-twice", { at: new Date(AT.getTime() - HOUR) });
    expect((await candidates()).filter((one) => one.wakeKey === `commitment:${fact("k-twice")}`)).toHaveLength(1);
    const found = await candidate("k-twice");
    expect(found).toMatchObject({ source: "commitment_due", anchors: [], compartments: ["own"], vetoed: false });
    if (found === undefined) throw new Error("no candidate");
    expect(await dispatch.queueRun(found, RUN, AT)).not.toBeNull();
    expect(await candidate("k-twice")).toBeUndefined();
    const [run] = await admin<{ wake_source: string; compartments: string[] }>(
      "select wake_source, compartments from ledger.runs where wake_key = $1",
      [found.wakeKey],
    );
    expect(run).toEqual({ wake_source: "commitment_due", compartments: ["own"] });
  });

  it("only the reasoner's clearance wakes, and with no reasoner nothing does", async () => {
    // From the trigger log: a row of another clearance is no candidate of the reasoner's, nor is
    // any with no reasoner; the reasoner's own row is.
    await logged("k-work", { clearance: WIDE, compartments: WIDE });
    expect(await candidate("k-work")).toBeUndefined();
    await logged("k-nobody");
    await admin("update policy.clients set status = 'revoked' where id = $1", [reasonerId]);
    try {
      expect(await candidate("k-nobody")).toBeUndefined();
    } finally {
      await admin("update policy.clients set status = 'active' where id = $1", [reasonerId]);
    }
    expect(await candidate("k-nobody")).toBeDefined();
  });

  it("a veto on the counterparty or on the message's sender silences the wake under the row's label", async () => {
    await logged("k-pat");
    await logged("k-sender");
    expect((await candidate("k-pat"))?.vetoed).toBe(false);
    expect((await candidate("k-sender"))?.vetoed).toBe(false);

    const veto = async (fps: string[]): Promise<void> => {
      const id = testId("rul");
      await admin(
        "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'veto', 0, '{}', '{}', now(), '{own}')",
        [id, testId("req")],
      );
      await admin(
        "insert into knowledge.vetoes (ruling_id, subject, value_fps, work_kind, created_at, compartments) values ($1, 'person', $2, null, now(), '{own}')",
        [id, fps],
      );
    };
    // A veto on the counterparty, by its addresses.
    await veto(
      (await admin<{ fp: string }>("select value_fp as fp from knowledge.accounts where entity_id = $1", [pat])).map(
        (row) => row.fp,
      ),
    );
    // And one on the sender of the message the other commitment was said in.
    await veto([
      one(
        await admin<{ fp: string }>("select sender_fp as fp from knowledge.messages where id = $1", [blakeMessage.id]),
      ).fp,
    ]);
    const vetoed = await candidate("k-pat");
    expect(vetoed?.vetoed).toBe(true);
    expect((await candidate("k-sender"))?.vetoed).toBe(true);
    // The positive control is above: before the vetoes, neither candidate was vetoed.

    if (vetoed === undefined) throw new Error("no candidate");
    expect(await dispatch.recordSilence(vetoed, "vetoed", SKIP, AT)).toBe(true);
    const [silence] = await admin<{ compartments: string[]; wake_source: string }>(
      "select compartments, wake_source from ledger.silences where wake_key = $1",
      [vetoed.wakeKey],
    );
    expect(silence).toEqual({ compartments: ["own"], wake_source: "commitment_due" });
    // A vetoed silence uses the key up.
    expect(await candidate("k-pat")).toBeUndefined();
  });

  it("a trigger row older than the look-ahead is no candidate", async () => {
    await logged("k-old", { at: new Date(AT.getTime() - 25 * HOUR) });
    expect(await candidate("k-old", new Date(AT.getTime() - 24 * HOUR))).toBeDefined();
    expect(await candidate("k-old")).toBeUndefined();
  });

  it("only pi_work reads the candidates, and the pipeline holds no privilege on what uses a wake up", async () => {
    const readSql = "select * from ledger.state_wakes(now())";
    expect(await sqlState(() => queryAs(store.db.urls.pipeline, readSql))).toBe("42501");
    expect(await sqlState(() => queryAs(store.db.urls.reader, readSql))).toBe("42501");
    expect(await sqlState(() => queryAs(store.db.urls.work, readSql))).toBeNull();

    // The pipeline holds no privilege on the tables a wake is used up in. It reads its own
    // agent_claim cards in the ledger, so the schema itself is not closed to it.
    for (const table of ["ledger.runs", "ledger.silences"]) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        expect(
          one(await admin<{ p: boolean }>("select has_table_privilege('pi_pipeline', $1, $2) as p", [table, privilege]))
            .p,
          `${table} ${privilege}`,
        ).toBe(false);
      }
    }
    // The control: the reader does hold one of them.
    expect(
      one(await admin<{ p: boolean }>("select has_table_privilege('pi_reader', 'ledger.runs', 'SELECT') as p")).p,
    ).toBe(true);
  });
});
