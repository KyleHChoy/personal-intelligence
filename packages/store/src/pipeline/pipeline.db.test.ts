import { inspect } from "node:util";
import type { EvidenceId, Mention, ModelCallRecord, Timestamp } from "@intelligence/contracts";
import { BELIEF_TYPES, type EmailDueItem } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { openRow } from "../core/seal.ts";
import { OWNER, QUENTIN, WORK_ONLY } from "../test-support/cast.ts";
import { insertSecret } from "../test-support/clients.ts";
import { addOwnerAddressUnderived, asOwner, one, session, sqlState } from "../test-support/connections.ts";
import { fingerprint, queryAs, sealRow, type TestDatabase } from "../test-support/database.ts";
import { ingestEvent, type MailFixture, mailFacts, mailRevision, mailSourceId } from "../test-support/items.ts";
import { EVENTS, MAIL } from "../test-support/items-named.ts";
import {
  batchOf,
  beliefsComputed,
  claimRecord,
  countOf,
  rowsOf,
  stored,
  withPipeline,
} from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { seeder } from "../test-support/seeder.ts";
import { lines, snapshot } from "../test-support/snapshot.ts";
import { evidenceIdOf } from "../test-support/values.ts";
import { createPipeline } from "./pipeline.ts";

// The pipeline's reads and writes, on hand-written records through the Pipeline as pi_pipeline.
// Each refusal has its positive control in the same test.

const TIMEOUT = 240_000;
const address = (value: string): Mention =>
  ({ key: { kind: "address", value }, observedAt: "2026-09-01T09:00:00.000Z" }) as Mention;
const evidence = (value: string): EvidenceId => value as EvidenceId;
const rejection = (call: Promise<unknown>): Promise<{ code?: string } | undefined> =>
  call.then(
    () => undefined,
    (error: unknown) => error as { code?: string },
  );

// A held message: the recovery markers' mark, as stage 1's derive sets it.
const HELD: MailFixture = {
  ...MAIL.fromQuentin,
  id: "gm-held-pln-0001",
  threadId: "thread-held-pln-0001",
  messageId: "held-pln-0001@lighthouse.test",
  at: "2026-09-04T08:00:00Z",
  held: true,
};

// The status row's sealed facts, written as pi_admin, as an owner command would leave them.
async function setStatusFacts(
  db: TestDatabase,
  evidenceId: string,
  facts: Record<string, unknown>,
  waiting: boolean,
): Promise<void> {
  const [row] = await queryAs<{ compartments: string[] }>(
    db.urls.admin,
    "select compartments from vault.evidence_items where id = $1",
    [evidenceId],
  );
  const compartments = row?.compartments ?? ["own"];
  await queryAs(
    db.urls.admin,
    `insert into vault.pipeline_items (evidence_id, waiting, extractor_generation, facts_enc, compartments) values ($1, $2, 1, $3, $4)
     on conflict (evidence_id) do update set waiting = excluded.waiting, facts_enc = excluded.facts_enc`,
    [
      evidenceId,
      waiting,
      sealRow(
        db.keys,
        compartments[0] ?? "own",
        { table: "vault.pipeline_items", id: evidenceId, column: "facts_enc" },
        JSON.stringify(facts),
      ),
      compartments,
    ],
  );
}

const statusFacts = async (db: TestDatabase, evidenceId: string): Promise<Record<string, unknown>> => {
  const row = one(
    await rowsOf<{ facts_enc: unknown; compartments: string[] }>(
      db,
      "select facts_enc, compartments from vault.pipeline_items where evidence_id = $1",
      [evidenceId],
    ),
  );
  return JSON.parse(
    openRow(
      db.keys,
      row.compartments[0] ?? "",
      { table: "vault.pipeline_items", id: evidenceId, column: "facts_enc" },
      row.facts_enc as never,
    ),
  ) as Record<string, unknown>;
};

describe("the pipeline's reads", { timeout: TIMEOUT }, () => {
  it("due gives the newest first, takes up after the last item of a page, leaves out a done item, and gives it again under another generation", () =>
    withPipeline(async ({ pipeline, writer, accounts }) => {
      const canary = await stored(writer, accounts.personalMail, MAIL.canary);
      const quentin = await stored(writer, accounts.personalMail, MAIL.fromQuentin);
      const solo = await stored(writer, accounts.personalMail, MAIL.solo);
      expect((await pipeline.due(10, 1)).map((item) => item.evidenceId)).toEqual([solo, quentin, canary]);

      const page = await pipeline.due(2, 1);
      expect(page.map((item) => item.evidenceId)).toEqual([solo, quentin]);
      const last = page[1];
      expect(
        (
          await pipeline.due(2, 1, {
            after: {
              sentAt: last?.sentAt ?? "",
              evidenceId: evidence(last?.evidenceId ?? ""),
              triage: ((page[1] ?? page[0]) as EmailDueItem).triage,
            },
          })
        ).map((item) => item.evidenceId),
      ).toEqual([canary]);

      expect(await pipeline.commit(batchOf(solo, []))).toBe("committed");
      expect((await pipeline.due(10, 1)).map((item) => item.evidenceId)).toEqual([quentin, canary]);
      // Under another generation the done item is due again, marked so; one never done is not
      // marked.
      expect((await pipeline.due(10, 2)).map((item) => item.evidenceId)).toEqual([solo, quentin, canary]);
      expect((await pipeline.due(10, 2)).map((item) => item.regenerated)).toEqual([true, undefined, undefined]);
      expect((await pipeline.due(10, 1)).map((item) => item.regenerated)).toEqual([undefined, undefined]);
      // A deferred item is due again at the same generation, with its attempts.
      await pipeline.defer(evidence(solo), 1, { code: "model_unavailable", lane: "correspondence" });
      expect((await pipeline.due(10, 1))[0]).toMatchObject({ evidenceId: solo, attempts: 0, override: false });
    }));

  it("an item withheld at generation 1 is not due at 2, and is due after a retry; a done item is due at 2; a waiting item at either", () =>
    withPipeline(async ({ pipeline, writer, accounts, db }) => {
      const withheld = await stored(writer, accounts.personalMail, MAIL.canary);
      const done = await stored(writer, accounts.personalMail, MAIL.fromQuentin);
      const waiting = await stored(writer, accounts.personalMail, MAIL.solo);
      await pipeline.commit(batchOf(withheld, [], { status: "withheld", code: "quarantine" }));
      await pipeline.commit(batchOf(done, []));
      await pipeline.defer(evidence(waiting), 1, { code: "model_unavailable", lane: "correspondence" });
      expect((await pipeline.due(10, 1)).map((item) => item.evidenceId)).toEqual([waiting]);
      expect((await pipeline.due(10, 2)).map((item) => item.evidenceId)).toEqual([waiting, done]);
      // As pi extract retry leaves it: waiting, with or without the release.
      await setStatusFacts(
        db,
        withheld,
        { lane: "correspondence", status: "waiting", attempts: 0, claims: 0, unmapped: 0, unresolved: 0 },
        true,
      );
      expect((await pipeline.due(10, 2)).map((item) => item.evidenceId)).toEqual([waiting, done, withheld]);
    }));

  it("the backlog gives done and bulk-skipped rows of this generation with no saved Jev call, newest first, and no other", () =>
    withPipeline(async ({ pipeline, writer, accounts, db }) => {
      const decideModel = { promptId: "jev_screen", promptVersion: "1" };
      const done = await stored(writer, accounts.personalMail, MAIL.canary);
      const bulk = await stored(writer, accounts.personalMail, MAIL.fromQuentin);
      const noText = await stored(writer, accounts.personalMail, MAIL.solo);
      const withheld = await stored(writer, accounts.personalMail, MAIL.reply);
      const marked = await stored(writer, accounts.personalMail, MAIL.aliasSent);
      await pipeline.commit(batchOf(done, []));
      await pipeline.commit(batchOf(bulk, [], { lane: "skip", status: "skipped", code: "bulk" }));
      await pipeline.commit(batchOf(noText, [], { lane: "skip", status: "skipped", code: "no_text" }));
      await pipeline.commit(batchOf(withheld, [], { status: "withheld", code: "quarantine" }));
      await pipeline.commit(batchOf(marked, []));
      // A saved decide-model call is the mark, whatever the model; another prompt's call is not.
      const revisionOf = async (evidenceId: string) =>
        one(
          await rowsOf<{ revision: number }>(db, "select revision from vault.evidence_items where id = $1", [
            evidenceId,
          ]),
        ).revision;
      const save = async (evidenceId: string, promptId: string, inputHash: string) =>
        pipeline.calls("typesafe/jev-1.13").save({
          key: {
            evidenceId,
            revision: await revisionOf(evidenceId),
            extractorGeneration: 0,
            promptId,
            promptVersion: "1",
            inputHash,
          },
          keys: [{ evidenceId, keyRef: "personal-unsealed" }],
          renderedInput: "x",
          rawOutput: "{}",
          outputHash: "d".repeat(64),
          label: { compartments: ["own"], readers: ["m-owner"] },
          origin: "live",
        } as never);
      await save(marked, "jev_screen", "e".repeat(64));
      await save(done, "personal_correspondence", "f".repeat(64));

      const all = await pipeline.backlog(10, 1, decideModel);
      expect(new Set(all.map((item) => item.evidenceId))).toEqual(new Set([done, bulk]));
      expect(all.find((item) => item.evidenceId === bulk)).toMatchObject({ committedLane: "skip", override: false });
      expect(all.find((item) => item.evidenceId === done)).toMatchObject({ committedLane: "correspondence" });
      const sorted = [...all].sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt));
      expect(all).toEqual(sorted);
      expect(await pipeline.backlog(1, 1, decideModel)).toEqual(all.slice(0, 1));
      // With `saved` (the trial's replay): the items that hold a saved call of the prompt, alone.
      expect((await pipeline.backlog(10, 1, decideModel, { saved: true })).map((item) => item.evidenceId)).toEqual([
        marked,
      ]);
      // Not at another generation, not for a compartment left out, and not once waiting.
      expect(await pipeline.backlog(10, 2, decideModel)).toEqual([]);
      expect(await pipeline.backlog(10, 1, decideModel, { compartments: ["employer:example"] })).toEqual([]);
      await pipeline.defer(evidence(done), 1, { code: "lane_changed", lane: "transaction" });
      expect((await pipeline.backlog(10, 1, decideModel)).map((item) => item.evidenceId)).toEqual([bulk]);
      // A lane change is due again at the same generation.
      expect((await pipeline.due(10, 1)).map((item) => item.evidenceId)).toEqual([done]);
      // A row the owner gave both a lane and a release is not returned, so it takes no place in the limit.
      await setStatusFacts(
        db,
        bulk,
        {
          lane: "correspondence",
          laneOverride: "correspondence",
          override: true,
          status: "done",
          attempts: 0,
          claims: 0,
          unmapped: 0,
          unresolved: 0,
        },
        false,
      );
      expect(await pipeline.backlog(10, 1, decideModel)).toEqual([]);
    }));

  it("due gives the correspondence lane first, then the transaction lane, then the rest, newest first within each, and pages keep that order", () =>
    withPipeline(async ({ pipeline, writer, accounts }) => {
      const bulk = (id: string, at: string, category: string): MailFixture => ({
        ...MAIL.fromQuentin,
        id: `gm-${id}`,
        threadId: `thread-${id}`,
        messageId: `${id}@bulk.test`,
        at,
        labels: ["INBOX", category],
        reads: "bulk",
      });
      const promotion = await stored(
        writer,
        accounts.personalMail,
        bulk("promo-ord", "2026-09-06T08:00:00Z", "CATEGORY_PROMOTIONS"),
      );
      const updateNew = await stored(
        writer,
        accounts.personalMail,
        bulk("update-new-ord", "2026-09-05T08:00:00Z", "CATEGORY_UPDATES"),
      );
      const primaryBulk = await stored(
        writer,
        accounts.personalMail,
        bulk("primary-ord", "2026-09-04T08:00:00Z", "INBOX"),
      );
      const solo = await stored(writer, accounts.personalMail, MAIL.solo);
      const updateOld = await stored(
        writer,
        accounts.personalMail,
        bulk("update-old-ord", "2026-09-02T09:00:00Z", "CATEGORY_UPDATES"),
      );
      const reply = await stored(writer, accounts.personalMail, MAIL.reply);
      const canary = await stored(writer, accounts.personalMail, MAIL.canary);
      const expected = [solo, reply, canary, updateNew, primaryBulk, updateOld, promotion];
      const whole = await pipeline.due(10, 1);
      expect(whole.map((item) => item.evidenceId)).toEqual(expected);

      const paged: string[] = [];
      for (let last: (typeof whole)[number] | undefined; ; ) {
        const page = await pipeline.due(
          2,
          1,
          last === undefined
            ? {}
            : {
                after: {
                  sentAt: last.sentAt,
                  evidenceId: evidence(last.evidenceId),
                  ...(last.source === "email" ? { triage: last.triage } : {}),
                },
              },
        );
        if (page.length === 0) break;
        paged.push(...page.map((item) => item.evidenceId));
        last = page.at(-1);
      }
      expect(paged).toEqual(expected);

      // The cursor's lane is the cursor's own: one whose row is gone stays in its lane.
      const gone = {
        sentAt: "2026-09-04T12:00:00.000Z" as Timestamp,
        evidenceId: evidence("ev-gone-ord"),
        triage: { direction: "inbound", bulk: true, category: "updates", unreadable: false, chars: 10 } as const,
      };
      expect((await pipeline.due(10, 1, { after: gone })).map((item) => item.evidenceId)).toEqual([
        primaryBulk,
        updateOld,
        promotion,
      ]);
    }));

  it("an item of a compartment left out is not due", () =>
    withPipeline(async ({ pipeline, writer, accounts }) => {
      const own = await stored(writer, accounts.personalMail, MAIL.canary);
      const work = await stored(writer, accounts.workMail, MAIL.workCanary);
      expect((await pipeline.due(10, 1, { compartments: ["own"] })).map((item) => item.evidenceId)).toEqual([own]);
      // The positive control: with both, or with none given, both are due.
      expect(
        (await pipeline.due(10, 1, { compartments: ["own", "employer:example"] }))
          .map((item) => item.evidenceId)
          .sort(),
      ).toEqual([own, work].sort());
      expect(await pipeline.due(10, 1)).toHaveLength(2);
      expect((await pipeline.due(10, 1, { compartments: ["employer:example"] }))[0]).toMatchObject({
        evidenceId: work,
        compartments: ["employer:example"],
      });
    }));

  it("a held message is not due and gets no row; once released it is due", () =>
    withPipeline(async ({ pipeline, writer, accounts, db }) => {
      const held = await stored(writer, accounts.personalMail, HELD);
      const open = await stored(writer, accounts.personalMail, MAIL.canary);
      expect((await pipeline.due(10, 1)).map((item) => item.evidenceId)).toEqual([open]);
      expect(await countOf(db, "vault.pipeline_items")).toBe(0);

      const { log } = recordingLogger();
      const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log });
      try {
        const [message] = (await admin.held.messages()).messages;
        await admin.held.releaseHeld({ id: message?.id ?? "" });
      } finally {
        await admin.close();
      }
      expect((await pipeline.due(10, 1)).map((item) => item.evidenceId)).toEqual([held, open]);
    }));

  it("an evidence row of another source kind is never due", () =>
    withPipeline(async ({ pipeline, writer, accounts, db }) => {
      await ingestEvent(writer, accounts.personalCalendar, EVENTS.canary);
      const [calendar] = await rowsOf<{ id: string }>(
        db,
        "select id from vault.evidence_items where source_kind = 'calendar'",
      );
      // A calendar item given a message row by hand.
      await session(db.urls.admin, (query) => seeder(db, query).message(["own"], calendar?.id));
      const mail = await stored(writer, accounts.personalMail, MAIL.canary);
      expect((await pipeline.due(10, 1)).map((item) => item.evidenceId)).toEqual([mail]);
    }));

  it("a message row whose facts hold messageId and references is read as one without", () =>
    withPipeline(async ({ pipeline, writer, accounts }) => {
      const fixture: MailFixture = {
        ...MAIL.fromQuentin,
        references: ["earlier-0001@lighthouse.test"],
        text: "The rota is pinned by the stairs.",
      };
      await stored(writer, accounts.personalMail, fixture);
      const [item] = await pipeline.due(10, 1);
      expect(item?.source === "email" ? item.triage : undefined).toEqual({
        direction: "inbound",
        bulk: false,
        category: "primary",
        unreadable: false,
        chars: [...(fixture.text ?? "")].length,
      });
    }));

  it("open gives the item's two marks as the evidence row holds them", () =>
    withPipeline(async ({ pipeline, writer, accounts, db }) => {
      const plain = await stored(writer, accounts.personalMail, MAIL.canary);
      const marked = await stored(writer, accounts.personalMail, MAIL.fromQuentin);
      await queryAs(
        db.urls.admin,
        "update vault.evidence_items set system_originated = true, answers_system = true where id = $1",
        [marked],
      );
      expect(await pipeline.open(evidence(plain))).toMatchObject({
        systemOriginated: false,
        answersSystem: false,
        changeKind: "backfill",
      });
      const opened = await pipeline.open(evidence(marked));
      expect(opened).toMatchObject({ systemOriginated: true, answersSystem: true });
      expect(opened?.raw.sourceItemId).toBe(mailSourceId(MAIL.fromQuentin));
      expect(opened?.context).toMatchObject({
        evidenceId: marked,
        revision: 0,
        compartment: "own",
        ownerAddresses: [OWNER.personal],
      });
      expect(await pipeline.open(evidence("0".repeat(64)))).toBeNull();
    }));

  it("the identity port resolves a known address and the owner, and nobody else, and writes nothing", () =>
    withPipeline(async ({ pipeline, writer, accounts, db, owner }) => {
      const id = await stored(writer, accounts.personalMail, MAIL.canary);
      const quentin = one(
        await rowsOf<{ entity_id: string }>(db, "select entity_id from knowledge.accounts where value_fp = $1", [
          fingerprint(db.keys, "address", QUENTIN.address),
        ]),
      ).entity_id;
      const item = await pipeline.open(evidence(id));
      if (item === null) throw new Error("no item");
      const before = lines(await snapshot(db));
      const ask = (mention: Mention) => item.context.identity.resolve(mention, "personal", "r" as never);
      expect(await ask(address(` ${QUENTIN.address.toUpperCase()} `))).toEqual({
        outcome: "linked",
        entity: quentin,
        epoch: 0,
      });
      expect(await ask(address(OWNER.personal))).toEqual({ outcome: "linked", entity: owner, epoch: 0 });
      expect(await ask(address("nobody@unknown-pln.test"))).toEqual({ outcome: "not_a_person" });
      expect(await ask(address("not an address"))).toEqual({ outcome: "not_a_person" });
      expect(
        await ask({
          key: { kind: "name", value: "Quentin Lampwick" },
          observedAt: "2026-09-01T09:00:00.000Z",
        } as Mention),
      ).toEqual({ outcome: "not_a_person" });
      expect(item.kindOf(quentin as never)).toBe("person");
      expect(item.kindOf(owner as never)).toBe("owner");
      expect(item.kindOf("ent_00000000000000000000000000" as never)).toBeUndefined();
      expect(lines(await snapshot(db))).toEqual(before);
    }));

  it("an address known only under another compartment resolves to nobody", () =>
    withPipeline(async ({ pipeline, writer, accounts }) => {
      const own = await stored(writer, accounts.personalMail, MAIL.canary);
      const work = await stored(writer, accounts.workMail, MAIL.workOnly);
      const ownItem = await pipeline.open(evidence(own));
      expect(await ownItem?.context.identity.resolve(address(WORK_ONLY.address), "personal", "r" as never)).toEqual({
        outcome: "not_a_person",
      });
      // The positive control: under the work item's own compartment it is that person.
      const workItem = await pipeline.open(evidence(work));
      expect(
        await workItem?.context.identity.resolve(address(WORK_ONLY.address), "personal", "r" as never),
      ).toMatchObject({ outcome: "linked" });
    }));

  it("an address held by the owner and by a person resolves to the owner", () =>
    withPipeline(async ({ pipeline, writer, accounts, db, owner }) => {
      const id = await stored(writer, accounts.personalMail, MAIL.canary);
      await addOwnerAddressUnderived(db, QUENTIN.address, "own");
      expect(
        await countOf(db, "knowledge.accounts", "value_fp = $1", [fingerprint(db.keys, "address", QUENTIN.address)]),
      ).toBe(2);
      const item = await pipeline.open(evidence(id));
      expect(await item?.context.identity.resolve(address(QUENTIN.address), "personal", "r" as never)).toEqual({
        outcome: "linked",
        entity: owner,
        epoch: 0,
      });
    }));

  it("a second extract lock is already_running", () =>
    withPipeline(async ({ pipeline, db }) => {
      const second = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: recordingLogger().log });
      try {
        expect(await pipeline.withExtractLock(() => second.withExtractLock(async () => "ran"))).toBe("already_running");
        // The positive control: once the first has given it back, the second takes it.
        expect(await second.withExtractLock(async () => "ran")).toBe("ran");
      } finally {
        await second.close();
      }
    }));
});

describe("the pipeline's writes", { timeout: TIMEOUT }, () => {
  it("a commit for a deleted item writes nothing, and a commit for a superseded revision writes nothing", () =>
    withPipeline(async ({ pipeline, writer, accounts, db, owner }) => {
      const solo = await stored(writer, accounts.personalMail, MAIL.solo);
      const quentin = await stored(writer, accounts.personalMail, MAIL.fromQuentin);
      await writer.applyDeletion(accounts.personalMail, {
        sourceAccount: accounts.personalMail.id,
        sourceItemId: mailSourceId(MAIL.fromQuentin),
      } as never);
      const before = lines(await snapshot(db));
      expect(await pipeline.commit(batchOf(quentin, [claimRecord(quentin, "own", owner)]))).toBe("gone");
      await writer.ingestItem(
        accounts.personalMail,
        mailRevision(MAIL.soloAgain, accounts.personalMail),
        mailFacts(MAIL.soloAgain),
      );
      const afterRevision = lines(await snapshot(db));
      expect(afterRevision).not.toEqual(before);
      expect(await pipeline.commit(batchOf(solo, [claimRecord(solo, "own", owner)]))).toBe("superseded");
      expect(lines(await snapshot(db))).toEqual(afterRevision);
      // The positive control: the latest revision commits.
      const latest = evidenceIdOf(accounts.personalMail, mailSourceId(MAIL.solo), 1);
      expect(await pipeline.commit(batchOf(latest, [claimRecord(latest, "own", owner)]))).toBe("committed");
      expect(await countOf(db, "knowledge.claims")).toBe(1);
    }));

  it("a second commit of the same batch inserts and deletes nothing, another answer leaves exactly its claims, and no claims removes them and their beliefs", () =>
    withPipeline(async ({ pipeline, writer, accounts, db, owner }) => {
      const id = await stored(writer, accounts.personalMail, MAIL.canary);
      const quentin = one(
        await rowsOf<{ entity_id: string }>(db, "select entity_id from knowledge.accounts where value_fp = $1", [
          fingerprint(db.keys, "address", QUENTIN.address),
        ]),
      ).entity_id;
      const first = [
        claimRecord(id, "own", owner, { n: 1, entities: [quentin] }),
        claimRecord(id, "own", owner, { n: 2 }),
      ];
      const unmapped = [{ id: "u-1", proposedType: "commitment", reason: "bad_fields" as const }];
      await pipeline.commit(batchOf(id, first, { unmapped }));
      const claimRows = (table: string) =>
        rowsOf<{ key: string; xmin: string }>(
          db,
          `select ${table === "knowledge.claim_entities" ? "claim_id || entity_id" : "id"} as key, xmin::text as xmin from ${table} order by 1`,
        );
      const before = {
        claims: await claimRows("knowledge.claims"),
        entities: await claimRows("knowledge.claim_entities"),
        unmapped: await claimRows("vault.unmapped_claims"),
      };
      expect(before.claims).toHaveLength(2);
      expect(before.entities).toHaveLength(1);
      expect(before.unmapped).toHaveLength(1);

      await pipeline.commit(batchOf(id, first, { unmapped }));
      expect({
        claims: await claimRows("knowledge.claims"),
        entities: await claimRows("knowledge.claim_entities"),
        unmapped: await claimRows("vault.unmapped_claims"),
      }).toEqual(before);

      // Another answer: claim 2 stays, claim 1 goes with its entity, claim 3 comes, and the
      // belief that rested on claim 1 goes with it.
      const resting = async (): Promise<string[]> =>
        (await beliefsComputed(db, ["own"], BELIEF_TYPES, new Date().toISOString()))
          .flatMap((one) => one.belief.support)
          .sort();
      expect(await resting()).toEqual(first.map((record) => record.claim.id).sort());
      const second = [claimRecord(id, "own", owner, { n: 2 }), claimRecord(id, "own", owner, { n: 3 })];
      await pipeline.commit(batchOf(id, second));
      const ids = (await claimRows("knowledge.claims")).map((row) => row.key).sort();
      expect(ids).toEqual(second.map((record) => fingerprint(db.keys, "claim", record.claim.id)).sort());
      expect(await countOf(db, "knowledge.claim_entities")).toBe(0);
      expect(await countOf(db, "vault.unmapped_claims")).toBe(0);
      expect(await resting()).toEqual(second.map((record) => record.claim.id).sort());

      await pipeline.commit(batchOf(id, [], { status: "skipped", code: "bulk", lane: "skip" }));
      expect(await countOf(db, "knowledge.claims")).toBe(0);
      expect(await resting()).toEqual([]);
    }));

  it("a call saved for a deleted or superseded revision writes nothing", () =>
    withPipeline(async ({ pipeline, writer, accounts, db }) => {
      const solo = await stored(writer, accounts.personalMail, MAIL.solo);
      const quentin = await stored(writer, accounts.personalMail, MAIL.fromQuentin);
      const calls = pipeline.calls("configured/model");
      const record = (evidenceId: string, revision = 0): ModelCallRecord =>
        ({
          key: {
            evidenceId,
            revision,
            extractorGeneration: 0,
            promptId: "personal_correspondence",
            promptVersion: "1",
            inputHash: "a".repeat(64),
          },
          keys: [{ evidenceId, keyRef: "personal-unsealed" }],
          renderedInput: "the rendered input",
          rawOutput: '{"claims":[],"narrowing":"none"}',
          outputHash: "b".repeat(64),
          label: { compartments: ["own"], readers: ["m-owner"] },
          origin: "live",
        }) as never;
      await writer.applyDeletion(accounts.personalMail, {
        sourceAccount: accounts.personalMail.id,
        sourceItemId: mailSourceId(MAIL.fromQuentin),
      } as never);
      await calls.save(record(quentin));
      await writer.ingestItem(
        accounts.personalMail,
        mailRevision(MAIL.soloAgain, accounts.personalMail),
        mailFacts(MAIL.soloAgain),
      );
      await calls.save(record(solo));
      expect(await countOf(db, "vault.model_calls")).toBe(0);
      // The positive control: the latest revision's call is saved, without its input or hash.
      const latest = evidenceIdOf(accounts.personalMail, mailSourceId(MAIL.solo), 1);
      await calls.save(record(latest, 1));
      expect(await rowsOf(db, "select model_id, revision, input_fp from vault.model_calls")).toEqual([
        { model_id: "configured/model", revision: 1, input_fp: fingerprint(db.keys, "model_input", "a".repeat(64)) },
      ]);
    }));

  it("a saved call is found by its five key columns and its model's id, and no other", () =>
    withPipeline(async ({ pipeline, writer, accounts }) => {
      const id = await stored(writer, accounts.personalMail, MAIL.canary);
      const key = {
        evidenceId: id,
        revision: 0,
        extractorGeneration: 0,
        promptId: "personal_correspondence",
        promptVersion: "1",
        inputHash: "c".repeat(64),
      };
      const raw = '{"claims":[],"narrowing":"none"}';
      await pipeline.calls("model/one").save({
        key,
        keys: [{ evidenceId: id, keyRef: "personal-unsealed" }],
        renderedInput: "x",
        rawOutput: raw,
        outputHash: "d".repeat(64),
        label: { compartments: ["own"], readers: ["m-owner"] },
        origin: "live",
      } as never);
      expect(await pipeline.calls("model/two").find(key as never)).toBeNull();
      const found = await pipeline.calls("model/one").find(key as never);
      expect(found).toMatchObject({
        key,
        renderedInput: "",
        rawOutput: raw,
        origin: "live",
        label: { compartments: ["own"], readers: ["m-owner"] },
      });
      expect(found?.outputHash).toMatch(/^[0-9a-f]{64}$/);
      expect(found?.outputHash).not.toBe("d".repeat(64));
      for (const other of [
        { revision: 1 },
        { promptId: "personal_transaction" },
        { promptVersion: "2" },
        { inputHash: "e".repeat(64) },
        { evidenceId: "f".repeat(64) },
      ]) {
        expect(await pipeline.calls("model/one").find({ ...key, ...other } as never), JSON.stringify(other)).toBeNull();
      }
      // The generation is no part of the lookup: it is the constant CALL_GENERATION.
      expect(await pipeline.calls("model/one").find({ ...key, extractorGeneration: 3 } as never)).not.toBeNull();
    }));

  it("withheld is true exactly for a withheld item, and withheld_items answers the two marks of a judged item only", () =>
    withPipeline(async ({ pipeline, writer, accounts, db }) => {
      const fixtures = [MAIL.canary, MAIL.fromQuentin, MAIL.solo, MAIL.reply, MAIL.crowd, MAIL.twinA];
      const ids: string[] = [];
      for (const fixture of fixtures) ids.push(await stored(writer, accounts.personalMail, fixture));
      const [done, withheld, skipped, failed, waiting, none] = ids as string[];
      await pipeline.commit(batchOf(done ?? "", []));
      await pipeline.commit(batchOf(withheld ?? "", [], { status: "withheld", code: "sensitive" }));
      await pipeline.commit(batchOf(skipped ?? "", [], { status: "skipped", code: "bulk", lane: "skip" }));
      await pipeline.commit(batchOf(failed ?? "", [], { status: "failed", code: "cut_off" }));
      await pipeline.defer(evidence(waiting ?? ""), 1, { code: "model_unavailable", lane: "correspondence" });
      expect(
        await rowsOf(
          db,
          "select evidence_id, withheld, screened, waiting from vault.pipeline_items order by evidence_id",
        ),
      ).toEqual(
        [
          { evidence_id: done, withheld: false, screened: true, waiting: false },
          { evidence_id: withheld, withheld: true, screened: true, waiting: false },
          { evidence_id: skipped, withheld: false, screened: false, waiting: false },
          { evidence_id: failed, withheld: false, screened: false, waiting: false },
          { evidence_id: waiting, withheld: false, screened: false, waiting: true },
        ].sort((a, b) => ((a.evidence_id ?? "") < (b.evidence_id ?? "") ? -1 : 1)),
      );

      // As pi_owner, the function's owner, through a definer function's eyes.
      const answered = await asOwner(db, (query) =>
        query<{ evidence_id: string; withheld: boolean; screened: boolean }>(
          "select * from policy.withheld_items($1) order by evidence_id",
          [ids],
        ),
      );
      expect(answered).toEqual(
        [
          { evidence_id: done, withheld: false, screened: true },
          { evidence_id: withheld, withheld: true, screened: true },
          { evidence_id: skipped, withheld: false, screened: false },
          { evidence_id: failed, withheld: false, screened: false },
        ].sort((a, b) => ((a.evidence_id ?? "") < (b.evidence_id ?? "") ? -1 : 1)),
      );
      expect(answered.map((row) => row.evidence_id)).not.toContain(none);
      // More than a thousand ids is refused.
      expect(
        await sqlState(() =>
          asOwner(db, (query) =>
            query("select * from policy.withheld_items($1)", [Array.from({ length: 1001 }, (_, n) => String(n))]),
          ),
        ),
      ).toBe("22023");
    }));

  it("no role can run withheld_items until it is granted", () =>
    withPipeline(async ({ db }) => {
      const call = "select * from policy.withheld_items('{}'::text[])";
      for (const url of [db.urls.admin, db.urls.writer, db.urls.pipeline])
        expect(await sqlState(() => queryAs(url, call)), url).toBe("42501");
      // The positive control: a test role granted EXECUTE (and USAGE on policy) runs it.
      const role = `pit_pln_${Date.now().toString(36)}`;
      await queryAs(db.urls.bootstrap, `create role ${role} login password 'local-only'`);
      try {
        await session(db.urls.bootstrap, async (query) => {
          await query("set role pi_owner");
          await query(`grant usage on schema policy to ${role}`);
          await query(`grant execute on function policy.withheld_items(text[]) to ${role}`);
        });
        await queryAs(db.urls.bootstrap, `grant connect on database ${db.name} to ${role}`);
        const url = db.urls.admin.replace("pi_admin:", `${role}:`);
        expect(await queryAs(url, call)).toEqual([]);
      } finally {
        await session(db.urls.bootstrap, async (query) => {
          await query("set role pi_owner");
          await query(`revoke all on function policy.withheld_items(text[]) from ${role}`);
          await query(`revoke usage on schema policy from ${role}`);
        });
        await queryAs(db.urls.bootstrap, `revoke connect on database ${db.name} from ${role}`);
        await queryAs(db.urls.bootstrap, `drop role ${role}`);
      }
    }));

  it("a run writes one run row with its code and counts", () =>
    withPipeline(async ({ pipeline, db }) => {
      const counts = {
        done: 1,
        skipped: 2,
        withheld: 3,
        failed: 4,
        waiting: 5,
        claims: 6,
        unmapped: 7,
        unresolved: 8,
        liveCalls: 9,
        beliefs: 10,
        beliefsChanged: 11,
        beliefsMixed: 12,
        beliefsFailed: 13,
        beliefsRemoved: 14,
        rebuildMs: 15,
      };
      await pipeline.recordRun({ code: "budget", counts });
      const [row] = await rowsOf<Record<string, unknown>>(db, "select * from vault.extraction_runs");
      expect(row).toMatchObject({
        code: "budget",
        done: 1,
        skipped: 2,
        withheld: 3,
        failed: 4,
        waiting: 5,
        claims: 6,
        unmapped: 7,
        unresolved: 8,
        live_calls: 9,
        beliefs: 10,
        beliefs_changed: 11,
        beliefs_mixed: 12,
        beliefs_failed: 13,
        beliefs_removed: 14,
        rebuild_ms: 15,
        compartments: ["own"],
      });
      expect(await countOf(db, "vault.extraction_runs")).toBe(1);
    }));

  it("a commit keeps the owner's lane and the owner's release", () =>
    withPipeline(async ({ pipeline, writer, accounts, db }) => {
      const id = await stored(writer, accounts.personalMail, MAIL.canary);
      await setStatusFacts(
        db,
        id,
        {
          lane: "transaction",
          laneOverride: "transaction",
          override: true,
          status: "waiting",
          attempts: 2,
          claims: 0,
          unmapped: 0,
          unresolved: 0,
        },
        true,
      );
      expect((await pipeline.due(10, 1))[0]).toMatchObject({ lane: "transaction", override: true, attempts: 2 });
      await pipeline.commit(batchOf(id, [], { lane: "transaction" }));
      expect(await statusFacts(db, id)).toMatchObject({
        laneOverride: "transaction",
        override: true,
        status: "done",
        attempts: 0,
      });
    }));

  it("a defer or an attempt for a deleted or superseded item writes nothing", () =>
    withPipeline(async ({ pipeline, writer, accounts, db }) => {
      const solo = await stored(writer, accounts.personalMail, MAIL.solo);
      const quentin = await stored(writer, accounts.personalMail, MAIL.fromQuentin);
      await pipeline.defer(evidence(solo), 1, { code: "model_unavailable", lane: "correspondence" });
      await writer.applyDeletion(accounts.personalMail, {
        sourceAccount: accounts.personalMail.id,
        sourceItemId: mailSourceId(MAIL.fromQuentin),
      } as never);
      await writer.ingestItem(
        accounts.personalMail,
        mailRevision(MAIL.soloAgain, accounts.personalMail),
        mailFacts(MAIL.soloAgain),
      );
      expect(await countOf(db, "vault.pipeline_items")).toBe(0);
      await pipeline.defer(evidence(quentin), 1, { code: "model_unavailable", lane: "correspondence" });
      await pipeline.defer(evidence(solo), 1, { code: "check_failed", lane: "correspondence" });
      await pipeline.countAttempt([evidence(solo), evidence(quentin)], 1);
      expect(await countOf(db, "vault.pipeline_items")).toBe(0);
      // The positive control: the latest revision is deferred.
      const latest = evidenceIdOf(accounts.personalMail, mailSourceId(MAIL.solo), 1);
      await pipeline.defer(evidence(latest), 1, { code: "check_failed", lane: "correspondence" });
      await pipeline.countAttempt([evidence(latest)], 1);
      expect(await statusFacts(db, latest)).toMatchObject({ attempts: 1, status: "waiting" });
    }));

  it("five attempts make an item failed and no longer waiting", () =>
    withPipeline(async ({ pipeline, writer, accounts, db }) => {
      const id = await stored(writer, accounts.personalMail, MAIL.canary);
      await pipeline.defer(evidence(id), 1, { code: "check_failed", lane: "correspondence" });
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await pipeline.countAttempt([evidence(id)], 1);
        expect(await statusFacts(db, id)).toMatchObject({ attempts: attempt, status: "waiting" });
      }
      expect((await pipeline.due(10, 1))[0]).toMatchObject({ attempts: 4 });
      await pipeline.countAttempt([evidence(id)], 1);
      expect(await statusFacts(db, id)).toMatchObject({ attempts: 5, status: "failed", code: "check_failed" });
      expect(await rowsOf(db, "select waiting, withheld, screened from vault.pipeline_items")).toEqual([
        { waiting: false, withheld: false, screened: false },
      ]);
      expect(await pipeline.due(10, 1)).toEqual([]);
    }));

  it("a usage row's id holds no time, and spentSince sums from a day on", () =>
    withPipeline(async ({ pipeline, writer, accounts, db }) => {
      const id = await stored(writer, accounts.workMail, MAIL.workCanary);
      const event = {
        promptId: "personal_correspondence",
        promptVersion: "1",
        modelId: "configured/model",
        inputTokens: 3,
        outputTokens: 2,
        costMicroUsd: 1500,
        outcome: "ok" as const,
      };
      await pipeline.recordUsage({ ...event, evidenceId: evidence(id) });
      await pipeline.recordUsage({ ...event, costMicroUsd: 500, outcome: "check" });
      const rows = await rowsOf<{ id: string; compartments: string[]; day: Date }>(
        db,
        "select id, compartments, day from vault.model_usage order by cost_microusd desc",
      );
      expect(rows.map((row) => row.compartments)).toEqual([["employer:example"], ["own"]]);
      // An entity-style id: no ULID time part, whose first character is 0 to 7.
      for (const row of rows) expect(row.id).toMatch(/^mus_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
      const today = new Date().toISOString().slice(0, 10);
      expect(await pipeline.spentSince(today as never)).toBe(2000);
      expect(await pipeline.spentSince("2999-01-01" as never)).toBe(0);
      expect(
        await rowsOf(
          db,
          "select column_name from information_schema.columns where table_schema = 'vault' and table_name = 'model_usage' and data_type like 'timestamp%'",
        ),
      ).toEqual([]);
    }));

  it("the pipeline reads the model key and no other secret", () =>
    withPipeline(async ({ pipeline, db }) => {
      await insertSecret(db, "openrouter/key", "sk-or-test-key");
      await insertSecret(db, "google/personal/refresh_token", "google-token");
      expect(await pipeline.secret("openrouter/key")).toBe("sk-or-test-key");
      expect(await pipeline.secret("google/personal/refresh_token")).toBeNull();
      expect(await pipeline.audiences()).toEqual([]);
    }));

  it("after the lock connection is ended, commit, calls.save and recordRun write nothing", () =>
    withPipeline(async ({ pipeline, writer, accounts, db, owner }) => {
      const id = await stored(writer, accounts.personalMail, MAIL.canary);
      const record = claimRecord(id, "own", owner);
      const holder =
        "pid in (select l.pid from pg_locks l where l.locktype = 'advisory' and l.granted and l.database = (select oid from pg_database where datname = current_database()))";
      const refused: Record<string, string | undefined> = {};
      let before: string[] = [];
      const outcome = await rejection(
        pipeline.withExtractLock(async () => {
          // The positive control: while the lock is held, a write is made.
          await pipeline.recordRun({
            code: "ok",
            counts: {
              done: 0,
              skipped: 0,
              withheld: 0,
              failed: 0,
              waiting: 0,
              claims: 0,
              unmapped: 0,
              unresolved: 0,
              liveCalls: 0,
              beliefs: 0,
              beliefsChanged: 0,
              beliefsMixed: 0,
              beliefsFailed: 0,
              beliefsRemoved: 0,
              rebuildMs: 0,
            },
          });
          before = lines(await snapshot(db));
          const ended = await queryAs(
            db.urls.pipeline,
            `select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and usename = current_user and pid <> pg_backend_pid() and ${holder}`,
          );
          expect(ended).toHaveLength(1);
          while ((await queryAs(db.urls.admin, `select 1 from pg_stat_activity where ${holder}`)).length > 0)
            await new Promise((resolve) => setTimeout(resolve, 20));
          await new Promise((resolve) => setTimeout(resolve, 100));
          refused.commit = (await rejection(pipeline.commit(batchOf(id, [record]))))?.code;
          refused.save = (
            await rejection(
              pipeline.calls("m").save({
                key: {
                  evidenceId: id,
                  revision: 0,
                  extractorGeneration: 0,
                  promptId: "p",
                  promptVersion: "1",
                  inputHash: "a".repeat(64),
                },
              } as never),
            )
          )?.code;
          refused.recordRun = (await rejection(pipeline.recordRun({ code: "ok", counts: {} } as never)))?.code;
          refused.defer = (
            await rejection(pipeline.defer(evidence(id), 1, { code: "model_unavailable", lane: "correspondence" }))
          )?.code;
          refused.recordUsage = (await rejection(pipeline.recordUsage({} as never)))?.code;
          // Reads are not refused.
          expect(await pipeline.due(10, 1)).toHaveLength(1);
          return "ran";
        }),
      );
      expect(refused).toEqual({
        commit: "unavailable",
        save: "unavailable",
        recordRun: "unavailable",
        defer: "unavailable",
        recordUsage: "unavailable",
      });
      expect(outcome).toMatchObject({ code: "unavailable" });
      expect(lines(await snapshot(db))).toEqual(before);
      // The positive control: outside the lock the same commit is made.
      expect(await pipeline.commit(batchOf(id, [record]))).toBe("committed");
    }));

  it("a database error carries no value", () =>
    withPipeline(async ({ pipeline, writer, accounts, db, owner }) => {
      const id = await stored(writer, accounts.personalMail, MAIL.canary);
      // A claim labelled other than its evidence: the database refuses it.
      const wrong = claimRecord(id, "employer:example", owner);
      const error = await pipeline.commit(batchOf(id, [wrong])).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error).toMatchObject({ code: "write_refused", cause: { sqlstate: "23514" } });
      const shown = `${inspect(error, { depth: 8, showHidden: true })}\n${JSON.stringify(error)}`;
      for (const value of ["employer:example", wrong.claim.id, "Statement number", id])
        expect(shown).not.toContain(value);
      expect(await countOf(db, "knowledge.claims")).toBe(0);
      expect(await countOf(db, "vault.pipeline_items")).toBe(0);
    }));
});
