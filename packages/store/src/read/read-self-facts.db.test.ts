import type { Claim } from "@intelligence/contracts";
import { type ClaimRecord, SelfView } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPipeline } from "../pipeline/pipeline.ts";
import { bulkCommitments } from "../test-support/bulk-claims.ts";
import { type Client, insertReader, type Message, worldMessages } from "../test-support/commitment-fixtures.ts";
import { queryAs } from "../test-support/database.ts";
import { knownBy } from "../test-support/known-by.ts";
import { batchOf, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger, recordingPool } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { daysFrom, outcomeValue } from "../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { Reader } from "./read.ts";

// Claims are committed through the Pipeline, their beliefs computed when asked. No model is called.
// Reserved domains only.

const OWN = ["own"];
const WIDE = ["employer:example", "own"];
const VIEWS = ["self", "people", "work"];

let serial = 0;

type Spec = {
  key: string;
  type: string;
  subject: string;
  by: string;
  message: Message;
  fields: Record<string, unknown>;
  fieldKinds: Record<string, string>;
  values: Record<string, unknown>;
  belief: boolean;
  owner: boolean;
};

function recordOf(spec: Spec): ClaimRecord {
  serial += 1;
  const base = claimRecord(spec.message.evidenceId, spec.message.compartment, spec.subject, {
    n: serial,
    type: spec.type,
    factKey: spec.key,
    validFrom: spec.message.sentAt,
    entities: spec.owner ? (spec.by === spec.subject ? [] : [spec.by]) : [spec.subject],
  });
  return {
    ...base,
    claim: {
      ...base.claim,
      assertedBy: spec.by,
      basis: spec.by === spec.subject ? "explicit_self" : "third_party",
      content: { ...base.claim.content, type: spec.type, fields: spec.fields },
    } as Claim,
    subjectKind: spec.owner ? "owner" : "person",
    fieldKinds: spec.fieldKinds,
  } as ClaimRecord;
}

async function seed(store: TestStore, specs: Spec[], _audiences: string[][]): Promise<Map<string, ClaimRecord>> {
  const records = new Map(specs.map((spec) => [spec.key, recordOf(spec)]));
  const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
  try {
    const byItem = new Map<string, ClaimRecord[]>();
    for (const record of records.values())
      byItem.set(record.claim.primaryEvidenceId, [...(byItem.get(record.claim.primaryEvidenceId) ?? []), record]);
    for (const [evidenceId, claims] of byItem)
      expect(await pipeline.commit(batchOf(evidenceId as never, claims))).toBe("committed");
    await knownBy(store.db, store.now);
  } finally {
    await pipeline.close();
  }
  return records;
}

describe("get_self's stated facts", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let people: { owner: string; blake: string };
  let own: Client;
  let wide: Client;
  let noSelf: Client;
  let messages: Message[];
  let _records: Map<string, ClaimRecord>;

  const freshReader = () => {
    const recorded = recordingPool(store.readerPool);
    const reader = new Reader({ pool: recorded.pool, keys: store.db.keys, log: store.log, now: () => store.now });
    return { reader, statements: recorded.statements };
  };
  const self = async (client: Client) => SelfView.parse(outcomeValue(await freshReader().reader.getSelf(client.token)));
  const on = (compartment: string, n = 0): Message =>
    messages.filter((one) => one.compartment === compartment)[n] as Message;

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW });
    const world = await seedWorld(store.writer, store.admin);
    people = { owner: world.ownerEntity(), blake: world.entityOf(WORLD.both.address) };
    messages = await worldMessages(store);
    const { owner, blake } = people;
    _records = await seed(
      store,
      [
        // The owner's own words: a goal and a preference, each a belief.
        {
          key: "s-goal",
          type: "goal",
          subject: owner,
          by: owner,
          message: on("own", 0),
          fields: { what: "canary-goal-owner finish the survey" },
          fieldKinds: { what: "text" },
          values: {},
          belief: true,
          owner: true,
        },
        {
          key: "s-pref",
          type: "preference",
          subject: owner,
          by: owner,
          message: on("own", 1),
          fields: { what: "canary-pref-owner long morning walks", polarity: "prefers" },
          fieldKinds: { what: "text", polarity: "enum" },
          values: { polarity: "prefers" },
          belief: true,
          owner: true,
        },
        // A third party's statement of the owner's goal: a claim, no belief.
        {
          key: "s-reported",
          type: "goal",
          subject: owner,
          by: blake,
          message: on("own", 2),
          fields: { what: "canary-goal-reported" },
          fieldKinds: { what: "text" },
          values: {},
          belief: false,
          owner: true,
        },
        // A person's need: Blake's, never the owner's.
        {
          key: "s-blake",
          type: "need",
          subject: blake,
          by: blake,
          message: on("own", 3),
          fields: { what: "canary-need-blake" },
          fieldKinds: { what: "text" },
          values: {},
          belief: true,
          owner: false,
        },
        // The owner's own commitment: get_commitments serves it, under the work view, not stated.
        {
          key: "s-commit",
          type: "commitment",
          subject: owner,
          by: owner,
          message: on("own", 3),
          fields: { counterparty: blake, what: "canary-commit-owner" },
          fieldKinds: { counterparty: "entity", what: "text" },
          values: { counterparty: blake },
          belief: true,
          owner: true,
        },
        // The owner's constraint in work mail: for the wide audience alone.
        {
          key: "s-work",
          type: "constraint",
          subject: owner,
          by: owner,
          message: on("employer:example", 0),
          fields: { what: "canary-constraint-work" },
          fieldKinds: { what: "text" },
          values: {},
          belief: true,
          owner: true,
        },
      ],
      [OWN, WIDE],
    );
    own = await insertReader(store, "own-self-facts", OWN, { tools: ["get_self"], views: VIEWS });
    wide = await insertReader(store, "wide-self-facts", ["own", "employer:example"], {
      tools: ["get_self"],
      views: VIEWS,
    });
    noSelf = await insertReader(store, "no-self-facts", OWN, { tools: ["get_self"], views: ["people", "work"] });
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  // get_self serves the owner's beliefs as the self page's lines. These beliefs carry no domain,
  // so they are `unsorted`'s.
  const lines = (view: SelfView) => (view.sections ?? []).flatMap((section) => section.lines);
  const words = (view: SelfView) =>
    lines(view)
      .map((line) => line.line.untrusted)
      .sort();

  it("get_self's sections hold the owner's goal and preference in their words, and none of another's", async () => {
    const view = await self(own);
    expect("stated" in view).toBe(false);
    expect(view.sections?.map((one) => one.domain)).toEqual(["unsorted"]);
    expect(words(view)).toEqual([
      "Goal: canary-goal-owner finish the survey",
      "Prefers: canary-pref-owner long morning walks",
    ]);
    for (const line of lines(view)) expect(line.cites).toBe(1);
    expect(JSON.stringify(view)).not.toContain("canary-need-blake");
    // A commitment, the owner's included, is no section's line; a client with the Work view sees it in
    // openItems.
    expect(JSON.stringify(view.sections)).not.toContain("canary-commit-owner");
    // A third party's statement of the owner's goal builds no belief of the owner's, so no line.
    expect(JSON.stringify(view)).not.toContain("canary-goal-reported");
    expect(view.sections?.[0]?.more).toBe(false);
  });

  it("a hidden compartment changes nothing in the sections", async () => {
    const narrow = await self(own);
    const both = await self(wide);
    expect(words(both)).toEqual([
      "Constraint: canary-constraint-work",
      "Goal: canary-goal-owner finish the survey",
      "Prefers: canary-pref-owner long morning walks",
    ]);
    const work = lines(both)
      .filter((one) => one.line.untrusted.includes("canary-constraint-work"))
      .map((one) => one.fact);
    expect(work).toHaveLength(1);
    expect(lines(narrow).map((one) => one.fact)).toEqual(
      lines(both)
        .map((one) => one.fact)
        .filter((fact) => !work.includes(fact)),
    );
    expect(JSON.stringify(narrow)).not.toContain("canary-constraint-work");
    expect(narrow.sections?.map((one) => one.more)).toEqual(both.sections?.map((one) => one.more));
  });

  it("a client without the self view gets no self page: get_self is not permitted", async () => {
    expect(await freshReader().reader.getSelf(noSelf.token)).toEqual({ ok: false, code: "not_permitted" });
    // The control: the same clearance with the self view.
    expect(lines(await self(own)).length).toBeGreaterThan(0);
  });

  it("get_self logs each line's fact key and each line's cited message as bound", async () => {
    await self(own);
    const [row] = await queryAs<{ bound: string[]; fact_key_fps: string[] }>(
      store.db.urls.admin,
      "select bound, fact_key_fps from ledger.read_log where client_id = $1 and tool = 'get_self' order by id desc limit 1",
      [own.id],
    );
    const view = await self(own);
    expect(row?.fact_key_fps ?? []).toEqual(expect.arrayContaining(lines(view).map((one) => one.fact)));
    expect(row?.bound ?? []).toEqual(expect.arrayContaining([on("own", 0).evidenceId, on("own", 1).evidenceId]));
  });

  it("with 501 beliefs in the audience, an owner belief updated longest ago is still on the page", async () => {
    const before = lines(await self(own)).map((one) => one.fact);
    // 501 of Blake's, each stated after the owner's: the owner's are read after them.
    await bulkCommitments(store, {
      owner: people.owner,
      subject: people.blake,
      counterparty: people.owner,
      count: 501,
      at: daysFrom(WORLD_NOW, -0.5),
    });
    const after = await self(own);
    expect(lines(after).map((one) => one.fact)).toEqual(before);
    expect(after.sections?.every((one) => !one.more)).toBe(true);
  });
});
