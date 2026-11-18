import type { Claim } from "@intelligence/contracts";
import { type ClaimRecord, ContextPack, type PackItem } from "@intelligence/contracts/personal";
import { byBeliefOrder } from "@intelligence/personal-core/views";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { type Client, insertReader, type Message, worldMessages } from "../test-support/commitment-fixtures.ts";
import { queryAs } from "../test-support/database.ts";
import { knownBy } from "../test-support/known-by.ts";
import { batchOf, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { daysFrom, outcomeValue } from "../test-support/values.ts";
import { seedWorld, WORLD_NOW } from "../test-support/world.ts";
import { Reader } from "./read.ts";

// A commitment stays in the commitments section. Beliefs are written through the Pipeline as the
// rebuild writes them. No model is called.

const OWN = ["own"];
const TOOLS = ["get_self", "build_context_pack", "get_commitments"];
const VIEWS = ["self", "people", "work"];
const KINDS = ["goal", "preference", "constraint", "situation"];
// The fourth, a situation of the owner's, said 400 days before: stale after 365.
const STALE = 3;

type BeliefItem = Extract<PackItem, { kind: "belief" }>;
const factsIn = (pack: ContextPack): BeliefItem[] =>
  pack.items.filter((item): item is BeliefItem => item.section === "facts" && item.kind === "belief");

describe("agent_bootstrap@4's facts", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let owner: string;
  let messages: Message[];
  let claim: ClaimRecord;
  let full: Client;

  const reader = () =>
    new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log, now: () => store.now });
  const bootstrap = async (client: Client) =>
    ContextPack.parse(outcomeValue(await reader().buildContextPack(client.token, { purpose: "agent_bootstrap" })));

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW });
    const world = await seedWorld(store.writer, store.admin);
    owner = world.ownerEntity();
    messages = await worldMessages(store);
    const message = messages.find((one) => one.compartment === "own") as Message;
    const atOf = (n: number): string =>
      n === STALE
        ? daysFrom(new Date(message.sentAt), -400).toISOString()
        : new Date(Date.parse(message.sentAt) + n * 60_000).toISOString();
    // 22 open beliefs in the owner's own words, one claim each, of the four kinds by turn, a minute
    // apart; the fourth (a situation) said long ago, so stale; a goal said longer ago, so dormant;
    // and an open commitment of the owner's.
    const record = (n: number, kind: string, at: string, fields: Record<string, unknown>): ClaimRecord => {
      const base = claimRecord(message.evidenceId, "own", owner, {
        n: n + 1,
        type: kind,
        factKey: `f-${n}`,
        validFrom: at,
      });
      return {
        ...base,
        claim: {
          ...base.claim,
          assertedBy: owner,
          content: { ...base.claim.content, type: kind, fields },
        } as unknown as Claim,
        subjectKind: "owner",
        fieldKinds: Object.fromEntries(
          Object.keys(fields).map((field) => [
            field,
            field === "polarity" ? "enum" : field === "counterparty" ? "entity" : "text",
          ]),
        ),
      } as ClaimRecord;
    };
    const records = [
      ...Array.from({ length: 22 }, (_, n) => {
        const kind = KINDS[n % KINDS.length] as string;
        return record(n, kind, atOf(n), {
          what: `canary-facts-${n}`,
          ...(kind === "preference" ? { polarity: "prefers" } : {}),
        });
      }),
      record(30, "goal", daysFrom(new Date(message.sentAt), -400).toISOString(), { what: "canary-facts-dormant" }),
      record(31, "commitment", message.sentAt, { what: "canary-facts-commitment", counterparty: owner }),
    ];
    claim = records[0] as ClaimRecord;
    const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
    try {
      expect(await pipeline.commit(batchOf(message.evidenceId as never, records))).toBe("committed");
    } finally {
      await pipeline.close();
    }
    await knownBy(store.db, store.now);
    full = await insertReader(store, "facts-full", OWN, { tools: TOOLS, views: VIEWS });
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  it("the facts section holds the owner's open beliefs, at most 20, in compileFacts' order, after commitments", async () => {
    const pack = await bootstrap(full);
    // agent_bootstrap@16 is the current template.
    expect(pack.template).toBe("agent_bootstrap@16");
    const facts = factsIn(pack);
    expect(facts).toHaveLength(20);
    // The 22 open beliefs as seeded, in compileFacts' order: the first 20.
    const base = Date.parse((messages.find((one) => one.compartment === "own") as Message).sentAt);
    const open = Array.from({ length: 22 }, (_, n) => ({
      fact: fingerprint(store.db.keys, "fact", `f-${n}`),
      kind: KINDS[n % KINDS.length] as string,
      status: n === STALE ? "stale" : "active",
      confirmedAt:
        n === STALE ? daysFrom(new Date(base), -400).toISOString() : new Date(base + n * 60_000).toISOString(),
      subjectKind: "owner" as const,
    }));
    expect(facts.map((item) => item.id)).toEqual(
      open
        .sort(byBeliefOrder)
        .slice(0, 20)
        .map((one) => one.fact),
    );
    for (const item of facts) {
      expect(item).toMatchObject({
        section: "facts",
        required: false,
        provenance: "source",
        asOf: item.belief.confirmedAt,
      });
      expect(item.belief.subject.kind).toBe("owner");
      expect(item.belief.kind).not.toBe("commitment");
    }
    // Optional, so cut by selection: truncated stays false.
    expect(pack.truncated).toBe(false);
    const sections = [...new Set(pack.items.map((item) => item.section))];
    expect(sections.indexOf("facts")).toBe(sections.indexOf("commitments") + 1);
  });

  it("the pack logs each fact's key and each cited message as shown, and nothing as bound", async () => {
    const client = await insertReader(store, "facts-log", OWN, { tools: TOOLS, views: VIEWS });
    const pack = await bootstrap(client);
    const [row] = await queryAs<{ bound: string[]; shown: string[]; fact_key_fps: string[] }>(
      store.db.urls.admin,
      "select bound, shown, fact_key_fps from ledger.read_log where client_id = $1 order by id",
      [client.id],
    );
    expect(row?.bound).toEqual([]);
    for (const item of factsIn(pack)) expect(row?.fact_key_fps).toContain(item.id);
    expect(row?.shown).toContain(claim.claim.primaryEvidenceId);
  });

  it("a client without the self view gets none: agent_bootstrap is not permitted", async () => {
    const narrow = await insertReader(store, "facts-no-self", OWN, { tools: TOOLS, views: ["people", "work"] });
    expect(await reader().buildContextPack(narrow.token, { purpose: "agent_bootstrap" })).toEqual({
      ok: false,
      code: "not_permitted",
    });
    expect(factsIn(await bootstrap(full)).length).toBeGreaterThan(0);
  });
});
