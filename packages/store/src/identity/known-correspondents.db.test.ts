import type { Timestamp } from "@intelligence/contracts";
import { currentDefinition, type EmailDueItem, type EntityId } from "@intelligence/contracts/personal";
import { PERSONAL_LIMITS } from "@intelligence/personal-core";
import {
  contactItem,
  deriveItem,
  gmailHeadersItem,
  type ItemContext,
  type ItemFacts,
  whitelistedContact,
} from "@intelligence/personal-core/items";
import { describe, expect, it } from "vitest";
import { openRow } from "../core/seal.ts";
import { OWNER, OWNER_PERSONAL, QUENTIN, SOLO } from "../test-support/cast.ts";
import { testId } from "../test-support/clients.ts";
import { asTablesOwner } from "../test-support/connections.ts";
import { fingerprint, queryAs } from "../test-support/database.ts";
import type { MailFixture } from "../test-support/items.ts";
import { MAIL } from "../test-support/items-named.ts";
import {
  batchOf,
  claimRecord,
  type PipelineStore,
  rowsOf,
  stored,
  withPipeline,
} from "../test-support/pipeline-fixtures.ts";
import { withRulings as withAdmin } from "../test-support/ruling-fixtures.ts";
import type { SourceAccountRow } from "../write/writer-types.ts";

// Each refusal has its positive control in the same test. Synthetic people on reserved domains
// only.

const TIMEOUT = 240_000;
const NOW = "2026-09-15T12:00:00Z" as Timestamp;

// A saved contact of one address, through core's own whitelist and item builder, as sync stores one.
async function saveContact(
  store: PipelineStore,
  account: SourceAccountRow,
  resource: string,
  address: string,
): Promise<void> {
  const own = { metadata: { source: { type: "CONTACT", id: resource } } };
  const read = whitelistedContact({
    resourceName: `people/${resource}`,
    metadata: { sources: [{ type: "CONTACT", id: resource, updateTime: "2026-09-01T09:00:00Z" }] },
    names: [{ ...own, displayName: "Saved Person" }],
    emailAddresses: [{ ...own, value: address }],
  });
  if (read === null) throw new Error("refused");
  const raw = contactItem(read, { sourceAccount: account.id, changeKind: "backfill", now: NOW });
  expect(
    await store.writer.ingestItem(
      account,
      raw,
      (ctx: ItemContext): Promise<ItemFacts> => deriveItem(raw, ctx, PERSONAL_LIMITS),
    ),
  ).toBe("stored");
}

// Each due message's evidence id with its known correspondent flag, as pi_pipeline reads them.
const knownOf = async (store: PipelineStore): Promise<Record<string, boolean>> =>
  Object.fromEntries(
    (await store.pipeline.due(100, 1))
      .filter((item): item is EmailDueItem => item.source === "email")
      .map((item) => [item.evidenceId, item.triage.knownCorrespondent === true]),
  );

const messageOf = async (store: PipelineStore, evidenceId: string): Promise<string> =>
  (await rowsOf<{ id: string }>(store.db, "select id from knowledge.messages where evidence_id = $1", [evidenceId]))[0]
    ?.id ?? "";

const statusFacts = async (store: PipelineStore, evidenceId: string): Promise<Record<string, unknown>> => {
  const [row] = await rowsOf<{ facts_enc: unknown; compartments: string[] }>(
    store.db,
    "select facts_enc, compartments from vault.pipeline_items where evidence_id = $1",
    [evidenceId],
  );
  return JSON.parse(
    openRow(
      store.db.keys,
      row?.compartments[0] ?? "",
      { table: "vault.pipeline_items", id: evidenceId, column: "facts_enc" },
      row?.facts_enc as never,
    ),
  ) as Record<string, unknown>;
};

const statusRows = (store: PipelineStore) =>
  rowsOf<Record<string, unknown>>(
    store.db,
    'select evidence_id, waiting, withheld, screened, extractor_generation, updated_at, facts_enc::text as facts from vault.pipeline_items order by evidence_id collate "C"',
  );

describe("known correspondents", { timeout: TIMEOUT }, () => {
  it("mail the owner sent that was read by its headers alone raises no one's new mail, and mail read in full does", () =>
    withPipeline(async (store) => {
      const { writer, accounts } = store;
      const account = accounts.personalMail;
      const internalDate = Date.UTC(2023, 0, 10);
      const raw = gmailHeadersItem(
        {
          id: "gm-old-sent-0001",
          threadId: "thread-old-sent-0001",
          internalDate,
          labelIds: ["SENT"],
          headers: [
            { name: "From", value: OWNER_PERSONAL.address },
            { name: "To", value: `${QUENTIN.name} <${QUENTIN.address}>` },
            { name: "Date", value: new Date(internalDate).toUTCString().replace("GMT", "+0000") },
          ],
        },
        { sourceAccount: account.id, changeKind: "backfill" },
      );
      expect(await writer.ingestItem(account, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS))).toBe("stored");

      const quentin = await stored(writer, account, MAIL.fromQuentin);
      expect((await knownOf(store))[quentin]).toBe(false);

      // The control: the owner writes to Quentin in mail read in full.
      await stored(writer, account, MAIL.reply);
      expect((await knownOf(store))[quentin]).toBe(true);
    }));

  it("the fact is true for a sender the owner wrote to and for a saved contact, false otherwise, only under the message's own label, and blind to a restricted row", () =>
    withPipeline(async (store) => {
      const { writer, accounts, db } = store;
      const canary = await stored(writer, accounts.personalMail, MAIL.canary);
      const quentin = await stored(writer, accounts.personalMail, MAIL.fromQuentin);
      const solo = await stored(writer, accounts.personalMail, MAIL.solo);
      const rhea = await stored(writer, accounts.personalMail, MAIL.toAlias);
      const work = await stored(writer, accounts.workMail, MAIL.workCanary);
      const newsletter = await stored(writer, accounts.personalMail, MAIL.newsletter);
      // The control: before the owner writes to anyone, no sender is known.
      expect(await knownOf(store)).toEqual({
        [canary]: false,
        [quentin]: false,
        [solo]: false,
        [rhea]: false,
        [work]: false,
        [newsletter]: false,
      });

      // The owner writes to the canary person, with Quentin and Rhea on Cc, from `own`.
      const reply = await stored(writer, accounts.personalMail, MAIL.reply);
      const known = await knownOf(store);
      expect(known).toMatchObject({
        [canary]: true,
        [quentin]: true,
        [rhea]: true,
        [solo]: false,
        [newsletter]: false,
        [reply]: false,
      });
      // The canary person wrote to the work account too, but the owner wrote under `own` alone: no
      // row under another label moves a lane.
      expect(known[work]).toBe(false);

      // Solo is no one the owner wrote to, but becomes a saved contact.
      const contacts = await writer.ensureSourceAccount("personal", "google_contacts", "own", OWNER.personal);
      await saveContact(store, contacts, "c-solo", SOLO.address);
      expect((await knownOf(store))[solo]).toBe(true);

      // A restricted row never makes the general worker's message known: the saved contact's
      // address row relabelled restricted:health, and the owner's interaction rows with Quentin, each as
      // the table's owner: no runtime role updates a label.
      const relabel = (table: string, text: string, values: unknown[] = []) =>
        asTablesOwner(db, [table], (query) => query(text, values));
      await relabel(
        "knowledge.contact_addresses",
        "update knowledge.contact_addresses set compartments = '{own,restricted:health}'",
      );
      expect(
        one(
          await queryAs<{ n: number }>(db.urls.pipeline, "select count(*)::int as n from knowledge.contact_addresses"),
        ),
      ).toEqual({ n: 0 });
      expect((await knownOf(store))[solo]).toBe(false);
      const quentinEntity = (
        await queryAs<{ entity_id: string }>(
          db.urls.admin,
          "select entity_id from knowledge.accounts where value_fp = (select sender_fp from knowledge.messages where evidence_id = $1)",
          [quentin],
        )
      )[0]?.entity_id;
      await relabel(
        "knowledge.interaction_log",
        "update knowledge.interaction_log set compartments = '{own,restricted:health}' where entity_id = $1 and direction = 'outbound'",
        [quentinEntity],
      );
      const after = await knownOf(store);
      expect(after[quentin]).toBe(false);
      // The control: the canary person's rows are as they were.
      expect(after[canary]).toBe(true);
      expect(QUENTIN.address).not.toBe(SOLO.address);
    }));

  it("one step of the identity group counts: a sender whose address the owner ruled the same person as one the owner wrote to is known", () =>
    withAdmin(async (store) => {
      const { admin, writer, accounts, db } = store;
      const solo = await stored(writer, accounts.personalMail, MAIL.solo);
      // The owner writes to Solo's second address alone.
      const second = "solo.second@one-message.test";
      const toSecond: MailFixture = {
        ...MAIL.reply,
        id: "gm-second-0173",
        threadId: "thread-second-0173",
        messageId: "second-0173@hearth-canary.test",
        to: [{ address: second }],
        cc: [],
      };
      await stored(writer, accounts.personalMail, toSecond);
      expect((await knownOf(store))[solo]).toBe(false);
      const personOf = async (address: string): Promise<EntityId> =>
        (
          await queryAs<{ entity_id: EntityId }>(
            db.urls.admin,
            "select entity_id from knowledge.accounts where value_fp = $1",
            [fingerprint(db.keys, "address", address)],
          )
        )[0]?.entity_id as EntityId;
      const [first, other] = [await personOf(SOLO.address), await personOf(second)];
      expect(first).not.toBe(other);
      await admin.identity.linkPeople(first, other, "same", { requestId: testId("req") });
      expect((await knownOf(store))[solo]).toBe(true);
    }));

  it("pia extract reroute: a dry run counts and changes nothing; the run sets exactly those items waiting, marked backfill; a second finds none", () =>
    withAdmin(async (store) => {
      const { admin, pipeline, writer, accounts, owner, db } = store;
      await pipeline.commit(batchOf(await stored(writer, accounts.personalMail, MAIL.reply), []));
      // Known and done in the transaction lane: the one to move.
      const canary = await stored(writer, accounts.personalMail, MAIL.canary);
      // Known, but the owner set its lane.
      const quentin = await stored(writer, accounts.personalMail, MAIL.fromQuentin);
      // Not known.
      const solo = await stored(writer, accounts.personalMail, MAIL.solo);
      // Known, done in the correspondence lane already.
      const rhea = await stored(writer, accounts.personalMail, MAIL.toAlias);
      // Bulk.
      const newsletter = await stored(writer, accounts.personalMail, MAIL.newsletter);
      const receipt = claimRecord(canary, "own", owner, { type: "transaction.receipt" });
      await pipeline.commit(batchOf(canary, [receipt], { lane: "transaction" }));
      await pipeline.commit(batchOf(quentin, [], { lane: "transaction" }));
      await admin.extraction.retry({ messageId: await messageOf(store, quentin) }, { lane: "transaction" });
      await pipeline.commit(batchOf(quentin, [], { lane: "transaction" }));
      await pipeline.commit(batchOf(solo, [], { lane: "transaction" }));
      await pipeline.commit(batchOf(rhea, []));
      await pipeline.commit(batchOf(newsletter, [], { lane: "transaction" }));
      expect(await statusFacts(store, quentin)).toMatchObject({ laneOverride: "transaction", status: "done" });

      const before = await statusRows(store);
      const dry = await admin.extraction.reroute({ generation: 1, dryRun: true });
      expect(dry).toMatchObject({ selected: 1, rerouted: 0 });
      expect(dry.chars).toBeGreaterThan(0);
      expect(await statusRows(store)).toEqual(before);
      // Another generation's done items are due already, and are not this command's.
      expect(await admin.extraction.reroute({ generation: 2, dryRun: true })).toEqual({
        selected: 0,
        chars: 0,
        rerouted: 0,
      });

      expect(await admin.extraction.reroute({ generation: 1, dryRun: false })).toEqual({ ...dry, rerouted: 1 });
      expect(await statusFacts(store, canary)).toMatchObject({
        lane: "transaction",
        status: "waiting",
        attempts: 0,
        claims: 1,
        rerouted: true,
      });
      for (const other of [quentin, solo, rhea, newsletter])
        expect((await statusFacts(store, other)).status, other).toBe("done");
      // Due again at this generation, as a re-read of old mail, its known correspondent read.
      const due = (await pipeline.due(100, 1)).filter((item): item is EmailDueItem => item.source === "email");
      expect(due.map((item) => item.evidenceId)).toEqual([canary]);
      expect(due[0]).toMatchObject({ regenerated: true, triage: { knownCorrespondent: true } });

      // A second run finds none.
      expect(await admin.extraction.reroute({ generation: 1, dryRun: false })).toEqual({
        selected: 0,
        chars: 0,
        rerouted: 0,
      });

      // The next run's commit, in the correspondence lane, replaces the item's claims as backfill.
      const [{ last } = { last: 0 }] = await queryAs<{ last: number }>(
        db.urls.admin,
        "select coalesce(max(id), 0)::int as last from ledger.trigger_rechecks",
      );
      const relationship = claimRecord(canary, "own", owner, { type: "relationship", n: 2 });
      expect(await pipeline.commit(batchOf(canary, [relationship]))).toBe("committed");
      expect(
        (await rowsOf<{ type: string }>(db, "select type from knowledge.claims where evidence_id = $1", [canary])).map(
          (row) => row.type,
        ),
      ).toEqual(["relationship"]);
      const causes = await queryAs<{ cause: string }>(
        db.urls.admin,
        "select distinct cause from ledger.trigger_rechecks where id > $1",
        [last],
      );
      expect(causes.map((row) => row.cause)).toEqual(["backfill"]);
      const facts = await statusFacts(store, canary);
      expect(facts).toMatchObject({ lane: "correspondence", status: "done" });
      expect(facts.rerouted).toBeUndefined();
      expect((await pipeline.due(100, 1)).length).toBe(0);
    }));

  it("pia extract reroute refuses while a run holds the extract lock, unless a dry run, and writes nothing", () =>
    withAdmin(async (store) => {
      const { admin, pipeline, writer, accounts } = store;
      await stored(writer, accounts.personalMail, MAIL.reply);
      const canary = await stored(writer, accounts.personalMail, MAIL.canary);
      await pipeline.commit(batchOf(canary, [], { lane: "transaction" }));
      const refused = await pipeline.withExtractLock(async () => {
        expect(await admin.extraction.reroute({ generation: 1, dryRun: true })).toMatchObject({ selected: 1 });
        return admin.extraction.reroute({ generation: 1, dryRun: false }).then(
          () => null,
          (error: unknown) => (error as { code?: string }).code,
        );
      });
      expect(refused).toBe("extract_running");
      expect((await statusFacts(store, canary)).status).toBe("done");
      // The control: with the lock free, it runs.
      expect(await admin.extraction.reroute({ generation: 1, dryRun: false })).toMatchObject({ rerouted: 1 });
    }));

  it("pia extract item gives the item's lane, status, generation, triage flags, Jev's number and its counts, and no text or name", () =>
    withAdmin(async (store) => {
      const { admin, pipeline, writer, accounts, owner } = store;
      await stored(writer, accounts.personalMail, MAIL.reply);
      const canary = await stored(writer, accounts.personalMail, MAIL.canary);
      const id = await messageOf(store, canary);
      // Before any run: no status row, no decide model answer, no claim.
      expect(await admin.extraction.extractItem(id)).toMatchObject({
        message: id,
        evidence: canary,
        status: null,
        humanWritten: null,
        claims: {},
        unmapped: {},
        triage: { direction: "inbound", bulk: false, knownCorrespondent: true },
      });

      const prompt = currentDefinition("extract_triage").prompts?.[0];
      if (prompt === undefined) throw new Error("no triage prompt");
      const [revision] = await rowsOf<{ revision: number }>(
        store.db,
        "select revision from vault.evidence_items where id = $1",
        [canary],
      );
      await pipeline.calls("typesafe/jev-1.13").save({
        key: {
          evidenceId: canary,
          revision: revision?.revision ?? 0,
          extractorGeneration: 0,
          promptId: prompt.id,
          promptVersion: prompt.version,
          inputHash: "e".repeat(64),
        },
        keys: [{ evidenceId: canary, keyRef: "personal-unsealed" }],
        renderedInput: "x",
        rawOutput: '{"human_written":0.1,"special_category":0,"quarantine":0}',
        outputHash: "d".repeat(64),
        label: { compartments: ["own"], readers: ["m-owner"] },
        origin: "live",
      } as never);
      await pipeline.commit(
        batchOf(canary, [claimRecord(canary, "own", owner, { type: "transaction.receipt" })], {
          lane: "transaction",
          unmapped: [{ id: "u-1", proposedType: "plan", reason: "bad_times" }],
        }),
      );
      const view = await admin.extraction.extractItem(id);
      expect(view).toEqual({
        message: id,
        evidence: canary,
        status: {
          lane: "transaction",
          laneOverride: null,
          override: false,
          status: "done",
          code: null,
          generation: 1,
          waiting: false,
          attempts: 0,
        },
        triage: expect.objectContaining({
          direction: "inbound",
          bulk: false,
          category: "primary",
          unreadable: false,
          knownCorrespondent: true,
        }) as unknown,
        humanWritten: 0.1,
        claims: { "transaction.receipt": 1 },
        unmapped: { bad_times: 1 },
      });
      const text = JSON.stringify(view);
      for (const content of [
        MAIL.canary.subject,
        MAIL.canary.text ?? "",
        MAIL.canary.from?.address ?? "",
        MAIL.canary.from?.name ?? "",
      ])
        if (content !== "") expect(text).not.toContain(content);
      // No such message.
      expect(await admin.extraction.extractItem("msg_00000000000000000000000000")).toBeNull();
    }));
});

function one<T>(rows: T[]): T {
  expect(rows).toHaveLength(1);
  return rows[0] as T;
}
