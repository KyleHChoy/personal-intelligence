import type { Claim } from "@intelligence/contracts";
import { type CardId, type ClaimRecord, type FactId, SelfReviewPage, SelfView } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { Reader } from "../read/read.ts";
import { testId } from "../test-support/clients.ts";
import { type Client, insertReader, type Message, worldMessages } from "../test-support/commitment-fixtures.ts";
import { queryAs } from "../test-support/database.ts";
import { knownBy } from "../test-support/known-by.ts";
import { batchOf, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { daysFrom, outcomeValue } from "../test-support/values.ts";
import { seedWorld, storeSeeder, WORLD, WORLD_NOW } from "../test-support/world.ts";

// The owner's belief hygiene. get_self lists no claim the owner rejected, none of bulk mail and
// none of their own words that states nothing; `pi self review` lists their beliefs and the claims
// get_self lists, and a retired fact shows as retired. Claims are committed through the Pipeline,
// their beliefs computed when asked. No model is called.
// Reserved domains only. A retire is its own ruling, true until restated; and the owner's need
// asked as a question raises an about_you card, every one found (no daily limit), whose confirm
// makes it count.

const OWN = ["own"];
// How many more of the owner's questions as needs the world states, beside the first.
const MORE_QUESTIONS = 3;
const VIEWS = ["self", "people", "work"];

type Spec = {
  key: string;
  type: string;
  by: "owner" | "other";
  statementKind?: Claim["statementKind"];
  message: Message;
  what: string;
  belief: boolean;
};

describe("the owner's belief hygiene", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let owner: string;
  let blake: string;
  let client: Client;
  const ids = new Map<string, FactId>();
  // Each claim's own id, as the belief build names it (raiseNeedQuestions).
  const ownIds = new Map<string, string>();
  let spare: Message[] = [];

  const self = async () =>
    SelfView.parse(
      outcomeValue(
        await new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log, now: () => store.now }).getSelf(
          client.token,
        ),
      ),
    );
  // The claims the review lists in no belief (get_self serves beliefs alone).
  const listed = async () => (await store.admin.self.review({ status: "no_belief" })).map((row) => row.words).sort();
  const request = (name: string) => `req-0084-${name}-${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW });
    const world = await seedWorld(store.writer, store.admin);
    owner = world.ownerEntity();
    blake = world.entityOf(WORLD.both.address);
    const mailbox = world.accounts.personalMail;
    if (mailbox === undefined) throw new Error("the world has no personal mailbox");
    const seed = storeSeeder(store.writer, WORLD_NOW);
    // The needs-as-questions cases need four messages under {own}, one more per further question and
    // one spare; the world holds fewer, so the rest are Blake's, seeded here.
    const needed = 5 + MORE_QUESTIONS;
    const held = (await worldMessages(store)).filter((one) => one.compartment === "own").length;
    for (let n = held; n < needed; n += 1) {
      await seed.mail(mailbox, {
        id: `own-extra-0088-${n}`,
        from: { address: WORLD.both.address, name: WORLD.both.ownName },
        to: [{ address: WORLD.ownerPersonal }],
        at: daysFrom(WORLD_NOW, -(2 + n)),
        subject: `canary-0088-extra-${n}`,
      });
    }
    const own = (await worldMessages(store)).filter((one) => one.compartment === "own");
    // The world holds no bulk mail: one bulk message under {own}, seeded here, after `own` is read.
    await seed.mail(mailbox, {
      id: "own-bulk-0084",
      from: { address: "bulletin@news.example.org", name: "Bulletin Canary" },
      to: [{ address: WORLD.ownerPersonal }],
      at: daysFrom(WORLD_NOW, -1),
      subject: "canary-0084-bulk-subject",
      bulk: true,
    });
    const [bulkRow] = await queryAs<{ id: string; evidence_id: string; sent_at: Date; compartment: string }>(
      store.db.urls.admin,
      "select id, evidence_id, sent_at, compartments[1] as compartment from knowledge.messages where bulk and compartments = '{own}' order by sent_at, id limit 1",
    );
    if (bulkRow === undefined) throw new Error("the bulk message was not stored");
    const bulk: Message = {
      id: bulkRow.id,
      evidenceId: bulkRow.evidence_id,
      sentAt: bulkRow.sent_at.toISOString(),
      compartment: bulkRow.compartment,
    };
    const at = (n: number) => own[n] as Message;
    const specs: Spec[] = [
      // The owner's own goal: a belief.
      { key: "h-goal", type: "goal", by: "owner", message: at(0), what: "canary-0084-goal", belief: true },
      // The owner's own question, typed as their need: no belief, and get_self does not list it.
      {
        key: "h-question",
        type: "need",
        by: "owner",
        statementKind: "question",
        message: at(1),
        what: "canary-0084-question",
        belief: false,
      },
      // Two third parties' statements about the owner: listed, until one is rejected.
      {
        key: "h-reported",
        type: "preference",
        by: "other",
        message: at(2),
        what: "canary-0084-reported",
        belief: false,
      },
      { key: "h-rejected", type: "goal", by: "other", message: at(3), what: "canary-0084-rejected", belief: false },
      // A bulk message's statement about the owner: never listed.
      { key: "h-bulk", type: "situation", by: "other", message: bulk, what: "canary-0084-bulk", belief: false },
      // More of the owner's questions as needs.
      ...Array.from(
        { length: MORE_QUESTIONS },
        (_, n): Spec => ({
          key: `h-question-${n + 2}`,
          type: "need",
          by: "owner",
          statementKind: "question",
          message: at(4 + n),
          what: `canary-0088-question-${n + 2}`,
          belief: false,
        }),
      ),
    ];
    spare = own.slice(4 + MORE_QUESTIONS);
    const records = new Map(
      specs.map((spec, index) => {
        const by = spec.by === "owner" ? owner : blake;
        const base = claimRecord(spec.message.evidenceId, spec.message.compartment, owner, {
          n: 840 + index,
          type: spec.type,
          factKey: spec.key,
          validFrom: spec.message.sentAt,
          entities: by === owner ? [] : [by],
        });
        const fields = spec.type === "preference" ? { what: spec.what, polarity: "prefers" } : { what: spec.what };
        const record = {
          ...base,
          claim: {
            ...base.claim,
            assertedBy: by,
            basis: by === owner ? "explicit_self" : "third_party",
            statementKind: spec.statementKind ?? "stated_fact",
            content: { ...base.claim.content, type: spec.type, fields },
          } as unknown as Claim,
          subjectKind: "owner",
          fieldKinds: spec.type === "preference" ? { what: "text", polarity: "enum" } : { what: "text" },
        } as ClaimRecord;
        return [spec.key, record] as const;
      }),
    );
    const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
    try {
      const byItem = new Map<string, ClaimRecord[]>();
      for (const record of records.values())
        byItem.set(record.claim.primaryEvidenceId, [...(byItem.get(record.claim.primaryEvidenceId) ?? []), record]);
      for (const [evidenceId, claims] of byItem)
        expect(await pipeline.commit(batchOf(evidenceId as never, claims))).toBe("committed");
    } finally {
      await pipeline.close();
    }
    // Known by the world's date, as the reader pinned to it computes the owner's beliefs.
    await knownBy(store.db, store.now);
    for (const [key, record] of records) {
      ids.set(key, fingerprint(store.db.keys, "claim", record.claim.id) as FactId);
      ownIds.set(key, record.claim.id);
    }
    client = await insertReader(store, "hygiene-0084", OWN, { tools: ["get_self"], views: VIEWS });
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  it("get_self serves the owner's goal alone; the review lists neither the owner's question nor a bulk message's claim, and lists a third party's", async () => {
    const view = await self();
    // The self page serves beliefs, never a claim in none.
    expect((view.sections ?? []).flatMap((one) => one.lines).map((one) => one.line.untrusted)).toEqual([
      "Goal: canary-0084-goal",
    ]);
    expect(await listed()).toEqual(["canary-0084-rejected", "canary-0084-reported"]);
    for (const canary of ["canary-0084-question", "canary-0084-bulk", "canary-0084-rejected", "canary-0084-reported"])
      expect(JSON.stringify(view)).not.toContain(canary);
  });

  it("self review lists the owner's belief with its words and source, then the claims get_self lists", async () => {
    const rows = await store.admin.self.review();
    expect(rows.map((row) => [row.n, row.kind, row.status, row.words, row.source, row.ownWords])).toEqual([
      [1, "goal", "active", "canary-0084-goal", "mail", true],
      [2, "goal", "no_belief", "canary-0084-rejected", "mail", false],
      [3, "preference", "no_belief", "canary-0084-reported", "mail", false],
    ]);
    expect(rows[0]?.facts).toEqual([ids.get("h-goal")]);
    expect((await store.admin.self.review({ kind: "preference" })).map((row) => row.words)).toEqual([
      "canary-0084-reported",
    ]);
    expect((await store.admin.self.review({ status: "active" })).map((row) => row.words)).toEqual(["canary-0084-goal"]);
  });

  it("self review ranks each row as get_self ranks its line, and says no row is a notice here", async () => {
    const rows = await store.admin.self.review();
    expect(rows.map((row) => row.rank).sort((a, b) => a - b)).toEqual(rows.map((_, index) => index + 1));
    expect(rows.find((row) => row.words === "canary-0084-goal")?.rank).toBe(1);
    expect(rows.every((row) => row.notice === null)).toBe(true);
    expect(rows.every((row) => row.use >= 0 && row.use <= 5)).toBe(true);
  });

  it("owner-reads R-the review a page at a time is the whole review, in order, numbered as in it", async () => {
    // The page carries the words inside { untrusted } and the owner's entity id.
    const whole = (await store.admin.self.review()).map((row) => ({ ...row, words: { untrusted: row.words } }));
    const owner = expect.stringMatching(/^ent_/);
    const first = await store.admin.self.reviewPage({}, { limit: 2 });
    expect(SelfReviewPage.parse(first)).toEqual({ owner, rows: whole.slice(0, 2), next: expect.any(String) });
    const second = await store.admin.self.reviewPage({}, { limit: 2, cursor: first.next ?? undefined });
    expect(second).toEqual({ owner, rows: whole.slice(2), next: null });
    expect(await store.admin.self.reviewPage({}, {})).toEqual({ owner, rows: whole, next: null });
    await expect(store.admin.self.reviewPage({}, { cursor: "bm90LWEtY3Vyc29y" })).rejects.toMatchObject({
      code: "invalid_argument",
    });
  });

  it("owner-reads R-a claim from a held message leaves the review, as it leaves get_self", async () => {
    const hold = (held: boolean) =>
      queryAs(
        store.db.urls.admin,
        "update knowledge.messages set held = $2 where evidence_id = (select evidence_id from knowledge.claims where id = $1)",
        [ids.get("h-reported"), held],
      );
    await hold(true);
    try {
      expect(await listed()).toEqual(["canary-0084-rejected"]);
    } finally {
      await hold(false);
    }
    expect(await listed()).toEqual(["canary-0084-rejected", "canary-0084-reported"]);
  });

  it("a rejected claim leaves the review at once; a lift brings it back", async () => {
    const ruling = await store.admin.facts.rejectClaim(ids.get("h-rejected") as FactId, {
      requestId: request("reject"),
    });
    expect(await listed()).toEqual(["canary-0084-reported"]);
    expect((await store.admin.self.review()).map((row) => row.words)).not.toContain("canary-0084-rejected");
    expect(await store.admin.facts.liftRuling(ruling, { requestId: request("lift") })).toBe(true);
    expect(await listed()).toEqual(["canary-0084-rejected", "canary-0084-reported"]);
  });

  it("a retired fact shows as retired in the review, its claim is kept, and the pipeline reads it as a retire, not a veto", async () => {
    const ruling = await store.admin.facts.retireFact(ids.get("h-goal") as FactId, { requestId: request("retire") });
    const goal = (await store.admin.self.review({ kind: "goal" })).find((row) => row.words === "canary-0084-goal");
    expect(goal?.status).toBe("retired");
    expect((await store.admin.facts.show(ids.get("h-goal") as FactId))?.rulings).toEqual([ruling]);
    expect((await store.admin.facts.listRulings()).find((one) => one.id === ruling)).toMatchObject({
      verdict: "retire",
      liftedAt: null,
      claimGone: false,
    });
    const [decision] = await queryAs<{ kind: string }>(
      store.db.urls.admin,
      "select kind from knowledge.owner_decisions where id = $1",
      [ruling],
    );
    expect(decision?.kind).toBe("fact_retire");
    // A second retire while no claim is dated after the first is refused.
    await expect(
      store.admin.facts.retireFact(ids.get("h-goal") as FactId, { requestId: request("retire-again") }),
    ).rejects.toMatchObject({ code: "already_ruled" });
    const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
    try {
      const read = await pipeline.beliefDecisions();
      const factKeyFp = fingerprint(store.db.keys, "fact", "h-goal");
      expect(read.retirements).toEqual([{ id: ruling, factKeyFp, at: expect.any(String), compartments: ["own"] }]);
      expect(read.decisions.map((one) => one.targetId)).not.toContain(factKeyFp);
    } finally {
      await pipeline.close();
    }
  });

  it("once the owner states a retired fact again, it may be retired again, and a lift ends each", async () => {
    const message = spare[0] as Message;
    const later = new Date(store.now.getTime() + 86_400_000).toISOString();
    const base = claimRecord(message.evidenceId, message.compartment, owner, {
      n: 880,
      type: "goal",
      factKey: "h-goal",
      validFrom: later,
      entities: [],
    });
    const restated = {
      ...base,
      claim: {
        ...base.claim,
        assertedBy: owner,
        basis: "explicit_self",
        content: { ...base.claim.content, type: "goal", fields: { what: "canary-0088-restated" } },
      } as unknown as Claim,
      subjectKind: "owner",
      fieldKinds: { what: "text" },
    } as ClaimRecord;
    const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
    try {
      expect(await pipeline.commit(batchOf(message.evidenceId as never, [restated]))).toBe("committed");
    } finally {
      await pipeline.close();
    }
    const first = (await store.admin.facts.listRulings())
      .filter((one) => one.verdict === "retire" && one.liftedAt === null)
      .map((one) => one.id);
    expect(first).toHaveLength(1);
    const second = await store.admin.facts.retireFact(ids.get("h-goal") as FactId, {
      requestId: request("retire-restated"),
    });
    expect(second).not.toBe(first[0]);
    for (const ruling of [...first, second])
      expect(await store.admin.facts.liftRuling(ruling, { requestId: request("lift-retire") })).toBe(true);
    const lifts = await queryAs<{ kind: string }>(
      store.db.urls.admin,
      "select kind from knowledge.owner_decisions where supersedes = any ($1::text[])",
      [[...first, second]],
    );
    expect(lifts.map((one) => one.kind)).toEqual(["fact_retire_lift", "fact_retire_lift"]);
  });

  it("the owner's questions as needs raise an about_you card each, with no daily limit, once each, and a confirm makes one count", async () => {
    const asked = ["h-question", ...Array.from({ length: MORE_QUESTIONS }, (_, n) => `h-question-${n + 2}`)];
    const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
    try {
      expect(await pipeline.raiseNeedQuestions(asked.map((key) => ownIds.get(key) as string))).toEqual({
        raised: asked.length,
      });
      const cards = await queryAs<{
        id: CardId;
        target_kind: string;
        target_id: string;
        created_by: string;
        compartments: string[];
      }>(
        store.db.urls.admin,
        "select id, target_kind, target_id, created_by, compartments from ledger.cards where kind = 'about_you' order by created_at, id",
      );
      expect(cards.map((card) => [card.target_kind, card.target_id, card.created_by, card.compartments])).toEqual(
        asked.map((key) => ["claim", ids.get(key), "system:extract", ["own"]]),
      );
      // A claim already carded is passed over.
      expect(await pipeline.raiseNeedQuestions(asked.map((key) => ownIds.get(key) as string))).toEqual({ raised: 0 });
      // Each card rests on its claim's message, so a deletion taints it.
      const [basis] = await queryAs<{ n: number }>(
        store.db.urls.admin,
        "select count(*)::int as n from ledger.basis where row_kind = 'card' and row_id = $1 and ref_kind = 'message'",
        [cards[0]?.id],
      );
      expect(basis?.n).toBe(1);

      await store.admin.cards.decide({
        cards: [cards[0]?.id as CardId],
        answer: "confirm",
        requestId: testId("req").slice(4),
      });
      const groups = await pipeline.beliefClaims();
      const marked = groups
        .flatMap((group) => group.claims)
        .filter((one) => one.ownerConfirmed === true)
        .map((one) => one.claim.id as string);
      expect(marked).toEqual([ownIds.get(asked[0] as string)]);

      // A card on a need from the owner's mail takes their Edit as an agent's does: the
      // claim from their mail is rejected and their words kept, in one decision.
      await store.admin.cards.decide({
        cards: [cards[1]?.id as CardId],
        answer: "confirm",
        correct: { object: "canary-0187-his-words" },
        requestId: testId("req").slice(4),
      });
      const edited = await queryAs<{ verdict: string; standing: boolean }>(
        store.db.urls.admin,
        "select verdict, lifted_at is null as standing from knowledge.belief_rulings where claim_fp = $1",
        [ids.get(asked[1] as string)],
      );
      expect(edited).toEqual([{ verdict: "reject", standing: true }]);
    } finally {
      await pipeline.close();
    }
  });

  it("policy.fact_retirements is the pipeline's alone", async () => {
    for (const url of [store.db.urls.admin, store.db.urls.writer]) {
      await expect(queryAs(url, "select * from policy.fact_retirements()")).rejects.toMatchObject({ code: "42501" });
    }
    await expect(queryAs(store.db.urls.pipeline, "select * from policy.fact_retirements()")).resolves.toBeDefined();
  });
});
