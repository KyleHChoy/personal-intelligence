import { type AutonomyRules, DECISION_POINT_PINS, type DecisionPointCall } from "@intelligence/contracts/personal";
import { autonomyRules } from "@intelligence/personal-core/planner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import {
  type CommitmentSpec,
  commitClaims,
  logTrigger,
  type Message,
  worldMessages,
} from "../test-support/commitment-fixtures.ts";
import { one, session } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { seeder } from "../test-support/seeder.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { insertWorkClient } from "../test-support/work-clients.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { createDispatch, type Dispatch } from "../work/dispatch.ts";
import { MAX_CHANGE_ANCHORS } from "./triggers.ts";

// Each refusal has its positive control in the same test.

const OWN = ["own"];
const WIDE = ["employer:example", "own"];
const MINUTE = 60_000;
const AT = new Date("2026-06-01T12:00:00.000Z");
// Offers made two days before AT: never live at AT, so the fold below sees only its own.
const MANY = MAX_CHANGE_ANCHORS + 2;

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

describe("wakes from state: belief_changed", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let dispatch: Dispatch;
  let specs: CommitmentSpec[];
  let reasonerId: string;
  // Each fold test's people, by spec key: the anchor its change names.
  const people = new Map<string, string>();
  const admin = <Row = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<Row[]> =>
    queryAs<Row>(store.db.urls.admin, text, values);
  const fact = (key: string): string => fingerprint(store.db.keys, "fact", key);

  // A `changed` row of the trigger log for the key, as the after-commit diff writes one, its
  // anchors the key's person; and the wake key it makes.
  const changed = (key: string, at: Date, clearance: string[] = OWN, compartments: string[] = OWN) =>
    logTrigger(store, {
      fact: fact(key),
      clearance,
      raise: "changed",
      compartments,
      at,
      anchors: people.has(key) ? [people.get(key) as string] : [],
    });
  const wakeKey = (key: string): string =>
    `belief:${fact(key)}:${fingerprint(store.db.keys, "belief_state", `${fact(key)}:changed`)}`;
  // The rule data mutes belief_changed runs; these tests turn them on.
  const ON = { ...autonomyRules(), beliefChangedRunsOn: true };
  const changes = async (now: Date, rules: AutonomyRules = ON) =>
    (await dispatch.wakeCandidates(now, rules)).filter((one) => one.source === "belief_changed");

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW });
    const world = await seedWorld(store.writer, store.admin);
    const owner = world.ownerEntity();
    const blake = world.entityOf(WORLD.both.address);
    const all = await worldMessages(store);
    const own = all.filter((m) => m.compartment === "own");
    const work = all.find((m) => m.compartment === "employer:example");
    const message = own[1];
    if (message === undefined || work === undefined) throw new Error("the world has too few messages");
    // A person of their own for each change the fold reads, each with an address under own, so
    // the reasoner can see each one.
    const folded = Array.from({ length: MANY }, (_, n) => `f-${String(n).padStart(2, "0")}`);
    await session(store.db.urls.admin, async (query) => {
      const seed = seeder(store.db, query);
      for (const key of [...folded, "f-late", "f-veto"]) {
        const person = await seed.entity("person");
        await seed.account(OWN, person);
        people.set(key, person);
      }
    });
    const spec = (key: string, counterparty: string, from: Message = message): CommitmentSpec => ({
      key,
      subject: owner,
      counterparty,
      claims: [{ message: from, what: `canary-${key}` }],
    });
    specs = [
      ...[...folded, "f-late", "f-veto"].map((key) => spec(key, people.get(key) ?? "")),
      spec("c-wide", blake, work),
    ];
    await commitClaims(store, owner, specs);
    reasonerId = (await insertWorkClient(store.db, "belief-wakes-reasoner", OWN, { kind: "reasoner" })).id;
    dispatch = createDispatch({ url: store.db.urls.work, log: recordingLogger().log, journal: "" });
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await dispatch?.close();
    await store?.close();
  });

  it("the fold: every live change waiting is one run, with the newest changes' entities as anchors, at most twenty; its run uses every key up", async () => {
    const folded = Array.from({ length: MANY }, (_, n) => `f-${String(n).padStart(2, "0")}`);
    // One rebuild's changes, a minute apart, the first oldest.
    for (const [n, key] of folded.entries()) await changed(key, new Date(AT.getTime() - (MANY - n) * MINUTE));
    const found = await changes(AT);
    expect(found).toHaveLength(1);
    const [batch] = found;
    if (batch === undefined) throw new Error("no candidate");
    const keys = folded.map(wakeKey);
    expect(batch).toEqual({
      source: "belief_changed",
      wakeKey: keys[0],
      anchors: [...folded]
        .reverse()
        .slice(0, MAX_CHANGE_ANCHORS)
        .map((key) => ({ kind: "entity", id: people.get(key) })),
      compartments: ["own"],
      vetoed: false,
      covers: keys.slice(1),
    });

    const run = await dispatch.queueRun(batch, RUN, AT);
    expect(run).not.toBeNull();
    expect(
      await admin("select wake_source, wake_key, covered_keys, compartments from ledger.runs where id = $1", [run]),
    ).toEqual([
      { wake_source: "belief_changed", wake_key: keys[0], covered_keys: keys.slice(1), compartments: ["own"] },
    ]);
    expect(
      await admin("select ref_kind, ref_id from ledger.basis where row_kind = 'run' and row_id = $1 order by id", [
        run,
      ]),
    ).toEqual(
      [...folded]
        .reverse()
        .slice(0, MAX_CHANGE_ANCHORS)
        .map((key) => ({ ref_kind: "entity", ref_id: people.get(key) })),
    );
    // Every key is used up, the covered ones as the run's own; a second queue of the same fold
    // writes nothing.
    expect(await changes(AT)).toEqual([]);
    expect(await dispatch.queueRun(batch, RUN, AT)).toBeNull();
    // A key stays used up when its row is logged again, as when the diff records the same state.
    await changed("f-01", AT);
    expect(await changes(new Date(AT.getTime() + MINUTE))).toEqual([]);

    // A change after the run is a fold of its own.
    await changed("f-late", new Date(AT.getTime() + MINUTE));
    const late = await changes(new Date(AT.getTime() + 2 * MINUTE));
    expect(late).toEqual([
      expect.objectContaining({
        wakeKey: wakeKey("f-late"),
        covers: [],
        anchors: [{ kind: "entity", id: people.get("f-late") }],
      }),
    ]);
  });

  it("the rule data's switch off (the mute): a live change queues no run, and its offer stays live for the switch on", async () => {
    // The fold above left f-late's change live and unqueued.
    const later = new Date(AT.getTime() + 3 * MINUTE);
    expect(autonomyRules().beliefChangedRunsOn).toBe(false);
    expect(await changes(later, autonomyRules())).toEqual([]);
    expect(await changes(later)).toEqual([expect.objectContaining({ wakeKey: wakeKey("f-late") })]);
  });

  it("a vetoed change is a candidate of its own, silenced vetoed, and is no part of the fold", async () => {
    const at = new Date(AT.getTime() + 3 * MINUTE);
    await changed("f-veto", at);
    const fp = one(
      await admin<{ fp: string }>("select value_fp as fp from knowledge.accounts where entity_id = $1", [
        people.get("f-veto"),
      ]),
    ).fp;
    const ruling = testId("rul");
    await admin(
      "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'veto', 0, '{}', '{}', now(), '{own}')",
      [ruling, testId("req")],
    );
    await admin(
      "insert into knowledge.vetoes (ruling_id, subject, value_fps, work_kind, created_at, compartments) values ($1, 'person', $2, null, now(), '{own}')",
      [ruling, [fp]],
    );
    const now = new Date(at.getTime() + MINUTE);
    const key = wakeKey("f-veto");
    const found = await changes(now);
    const vetoed = found.find((one) => one.wakeKey === key);
    expect(vetoed).toEqual({
      source: "belief_changed",
      wakeKey: key,
      anchors: [],
      compartments: ["own"],
      vetoed: true,
    });
    // The change still waiting from the test before is a fold of its own, without it.
    const fold = found.find((one) => !one.vetoed);
    expect(fold?.covers ?? []).not.toContain(key);
    expect(fold?.wakeKey).not.toBe(key);
    if (vetoed === undefined) throw new Error("no candidate");
    expect(await dispatch.recordSilence(vetoed, "vetoed", SKIP, now)).toBe(true);
    expect((await changes(now)).map((one) => one.wakeKey)).not.toContain(key);
  });

  it("a change outside the active reasoner's compartments wakes nothing, and widens no fold", async () => {
    // A reasoner cleared for the wide audience, in place of the own-only one, offers its change.
    await admin("update policy.clients set status = 'revoked' where id = $1", [reasonerId]);
    const wide = await insertWorkClient(store.db, "belief-wakes-wide", WIDE, { kind: "reasoner" });
    const at = new Date(AT.getTime() + 5 * MINUTE);
    const now = new Date(at.getTime() + MINUTE);
    try {
      // The wide reasoner's own rows: the employer's change and an own one, a fold of both labels.
      await changed("c-wide", at, WIDE, ["employer:example"]);
      await changed("f-late", at, WIDE, OWN);
      const key = wakeKey("c-wide");
      const keysWide = (await changes(now)).flatMap((one) => [one.wakeKey, ...(one.covers ?? [])]);
      expect(keysWide).toContain(key);
      expect((await changes(now)).find((one) => !one.vetoed)?.compartments).toEqual(WIDE);
      // With the own-only reasoner back, the wide change is no candidate and in no fold.
      await admin("update policy.clients set status = 'revoked' where id = $1", [wide.id]);
      await admin("update policy.clients set status = 'active' where id = $1", [reasonerId]);
      const found = await changes(now);
      expect(found.flatMap((one) => [one.wakeKey, ...(one.covers ?? [])])).not.toContain(key);
      for (const one of found) expect(one.compartments).toEqual(OWN);
    } finally {
      await admin("update policy.clients set status = 'revoked' where id = $1", [wide.id]);
      await admin("update policy.clients set status = 'active' where id = $1", [reasonerId]);
    }
  });
});
