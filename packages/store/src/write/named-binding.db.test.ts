import type { SourceDeletion } from "@intelligence/contracts";
import { type EntityId, FiledMention, type MentionBindingId } from "@intelligence/contracts/personal";
import { namedKey } from "@intelligence/personal-core";
import { secondDegreeRules } from "@intelligence/personal-core/views";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Admin, createAdmin } from "../admin/admin.ts";
import type { Query } from "../core/db.ts";
import { journalPath } from "../core/journal.ts";
import { createPipeline, type Pipeline } from "../pipeline/pipeline.ts";
import { namedOnly } from "../pipeline/pipeline-read.ts";
import { type Accounts, connect, OWNER, type Who } from "../test-support/cast.ts";
import { one } from "../test-support/connections.ts";
import { createTestDatabase, fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import { type MailFixture, mail, mailSourceId } from "../test-support/items.ts";
import { batchOf, claimRecord, stored } from "../test-support/pipeline-fixtures.ts";
import { eventLogger, recordingLogger } from "../test-support/recording.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { namedScope } from "./named-binding.ts";
import { createWriter, type Writer } from "./writer.ts";

// The writer's binding step over names relations filed, as pi_writer, with the filings committed as
// pi_pipeline would. No model is called. Synthetic people on reserved domains only. One database
// for the file; each case uses names and letters of its own.

type World = { db: TestDatabase; writer: Writer; pipeline: Pipeline; admin: Admin; accounts: Accounts };
let w: World;

const ME: Who = { address: OWNER.personal, name: OWNER.name };
const ME_AT_WORK: Who = { address: OWNER.work, name: OWNER.name };
const ADA: Who = { address: "ada.fenn@speaker-one.test", name: "Ada Fenn" };
const BRAM: Who = { address: "bram.holt@speaker-two.test", name: "Bram Holt" };
const NOA: Who = { address: "noa.lind@speaker-three.test", name: "Noa Lind" };
const NOA_OTHER: Who = { address: "noa@speaker-four.test", name: "Noa L" };
const WREN: Who = { address: "wren.oak@partner-two.test", name: "Wren Oak" };
const CORA: Who = { address: "cora.vance@held-one.test", name: "Cora Vance" };
const DEX: Who = { address: "dex.rowe@held-two.test", name: "Dex Rowe" };

let letters = 0;
const letter = (from: Who, to: Who[], labels: string[] = ["INBOX"]): MailFixture => {
  letters += 1;
  const n = String(letters).padStart(4, "0");
  return mail({
    id: `gm-bnd-${n}`,
    threadId: `thread-bnd-${n}`,
    messageId: `bnd-${n}@named-binding.test`,
    at: "2026-09-10T09:00:00Z",
    from,
    to,
    subject: "A note",
    labels,
  });
};

const addressFp = (address: string): string => fingerprint(w.db.keys, "address", address);
const nameFp = (name: string): string => fingerprint(w.db.keys, "name", name);

// A filed relation naming `name`, said by `speaker`: first-hand (the speaker's counterparty), or
// reported (`field` subject, not first-hand).
const said = (
  speaker: Who,
  name: string,
  options: { field?: "counterparty" | "subject"; firstHand?: boolean } = {},
): FiledMention =>
  FiledMention.parse({
    name,
    type: "relationship",
    field: options.field ?? "counterparty",
    firstHand: options.firstHand ?? true,
    subjectFp: addressFp(speaker.address),
    speakerFp: addressFp(speaker.address),
  });

// A letter from the speaker, stored and committed with these filed names; its evidence id.
async function filed(from: Who, mentions: FiledMention[], work = false): Promise<string> {
  const account = work ? w.accounts.workMail : w.accounts.personalMail;
  const evidence = await stored(w.writer, account, letter(from, [work ? ME_AT_WORK : ME]));
  expect(await w.pipeline.commit(batchOf(evidence, [], { unresolved: mentions.length, mentions }))).toBe("committed");
  return evidence;
}

// The person a named key of this name and label (and speaker, for one word) is the account of.
const keyFpOf = (name: string, label: string[], speaker: string | null = null): string =>
  addressFp(namedKey(fingerprint(w.db.keys, "source_id", namedScope(nameFp(name), label, speaker))) ?? "");
const holderOf = async (fp: string): Promise<string | undefined> =>
  (
    await queryAs<{ entity_id: string }>(
      w.db.urls.admin,
      "select entity_id from knowledge.accounts where value_fp = $1 limit 1",
      [fp],
    )
  )[0]?.entity_id;
const entityOf = async (who: Who): Promise<string> => (await holderOf(addressFp(who.address))) ?? "";
const bindingsOf = (evidence: string) =>
  queryAs<{ id: MentionBindingId; origin: string; address_fp: string; lifted: boolean; mention_fp: string }>(
    w.db.urls.admin,
    "select id, origin, address_fp, lifted_at is not null as lifted, mention_fp from knowledge.mention_bindings where evidence_id = $1 order by created_at, id",
    [evidence],
  );
const generationOf = async (evidence: string): Promise<number> =>
  one(
    await queryAs<{ g: number }>(
      w.db.urls.admin,
      "select extractor_generation as g from vault.pipeline_items where evidence_id = $1",
      [evidence],
    ),
  ).g;
const sync = () => w.writer.bindNamed(new Date());
// The named people made today count against the cap; a case that needs a fresh day moves them back.
const yesterday = () =>
  queryAs(w.db.urls.admin, "update knowledge.entities set created_at = created_at - interval '2 days' where named");
let requests = 0;
const req = (): string => `bnd-req-${(requests += 1)}`;

beforeAll(async () => {
  const db = await createTestDatabase({ compartments: ["own", "employer:example"] });
  const writer = createWriter({
    url: db.urls.writer,
    keys: db.keys,
    log: eventLogger(),
    journal: journalPath(db.keyFile),
  });
  const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: recordingLogger().log });
  const admin = createAdmin({
    url: db.urls.admin,
    keys: db.keys,
    log: recordingLogger().log,
    journal: journalPath(db.keyFile),
  });
  w = { db, writer, pipeline, admin, accounts: await connect(writer) };
  // Cora: the owner wrote to Cora once, so Cora is established and no own tie. Dex: mail both ways.
  await stored(writer, w.accounts.personalMail, letter(ME, [CORA], ["SENT"]));
  await stored(writer, w.accounts.personalMail, letter(ME, [DEX], ["SENT"]));
  await stored(writer, w.accounts.personalMail, letter(DEX, [ME]));
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await w?.admin.close();
  await w?.pipeline.close();
  await w?.writer.close();
  await w?.db.drop();
}, SLOW_DB_TEST_TIMEOUT);

describe("names relations filed, bound or made by code", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("a first-hand relationship naming an unknown full name makes one named person, binds it, and sets the item due with its saved call kept", async () => {
    const evidence = await filed(ADA, [said(ADA, "Theo Marsh")]);
    await w.pipeline.calls("configured/model").save({
      key: {
        evidenceId: evidence,
        revision: 0,
        extractorGeneration: 1,
        promptId: "personal_correspondence",
        promptVersion: "1",
        inputHash: "a".repeat(64),
      },
      keys: [{ evidenceId: evidence, keyRef: "personal-unsealed" }],
      renderedInput: "",
      rawOutput: JSON.stringify({ claims: [], narrowing: "none" }),
      outputHash: "b".repeat(64),
      label: { compartments: ["own"], readers: ["m-owner"] },
      origin: "live",
    } as never);
    expect(await sync()).toMatchObject({ created: 1, bound: 1, failed: 0 });
    const theo = await holderOf(keyFpOf("Theo Marsh", ["own"]));
    expect(theo).toBeDefined();
    expect(
      one(
        await queryAs<{ named: boolean; kind: string }>(
          w.db.urls.admin,
          "select named, kind from knowledge.entities where id = $1",
          [theo],
        ),
      ).named,
    ).toBe(true);
    expect(
      await queryAs(
        w.db.urls.admin,
        "select 1 from knowledge.aliases where entity_id = $1 and value_fp = $2 and evidence_id = $3",
        [theo, nameFp("Theo Marsh"), evidence],
      ),
    ).toHaveLength(1);
    expect(await bindingsOf(evidence)).toEqual([
      expect.objectContaining({ origin: "code", address_fp: keyFpOf("Theo Marsh", ["own"]), lifted: false }),
    ]);
    // Due again, so the next run replays it, and its saved call kept: no call is bought.
    expect(await generationOf(evidence)).toBe(0);
    expect(
      one(
        await queryAs<{ n: number }>(
          w.db.urls.admin,
          "select count(*)::int as n from vault.model_calls where evidence_id = $1",
          [evidence],
        ),
      ).n,
    ).toBe(1);
    // A second sync makes and binds nothing.
    expect(await sync()).toMatchObject({ created: 0, bound: 0 });
  });

  it("a second mention of the name under the same label binds to the same person; under another label, to another", async () => {
    const theo = await holderOf(keyFpOf("Theo Marsh", ["own"]));
    const again = await filed(BRAM, [said(BRAM, "Theo Marsh")]);
    const atWork = await filed(WREN, [said(WREN, "Theo Marsh")], true);
    expect(await sync()).toMatchObject({ created: 1, bound: 2 });
    expect(one(await bindingsOf(again)).address_fp).toBe(keyFpOf("Theo Marsh", ["own"]));
    expect(await holderOf(one(await bindingsOf(again)).address_fp)).toBe(theo);
    const work = await holderOf(one(await bindingsOf(atWork)).address_fp);
    expect(one(await bindingsOf(atWork)).address_fp).toBe(keyFpOf("Theo Marsh", ["employer:example"]));
    expect(work).toBeDefined();
    expect(work).not.toBe(theo);
  });

  it("a full name an established person without an own tie holds binds to them and makes nobody; one held by a person the owner mailed both ways stays filed", async () => {
    const cora = await filed(ADA, [said(ADA, "Cora Vance")]);
    const dex = await filed(ADA, [said(ADA, "Dex Rowe")]);
    const counts = await sync();
    expect(counts).toMatchObject({ created: 0, bound: 1 });
    expect(counts.tied).toBeGreaterThanOrEqual(1);
    expect(await holderOf(one(await bindingsOf(cora)).address_fp)).toBe(await entityOf(CORA));
    expect(await bindingsOf(dex)).toEqual([]);
    expect(await generationOf(dex)).not.toBe(0);
  });

  it("a reported relation's subject and counterparty are both made; the speaker's own name is skipped", async () => {
    const evidence = await filed(BRAM, [
      said(BRAM, "Lena Ortiz", { field: "subject", firstHand: false }),
      said(BRAM, "Milo Grant", { firstHand: false }),
      said(BRAM, "Bram Holt"),
    ]);
    const counts = await sync();
    expect(counts).toMatchObject({ created: 2, bound: 2 });
    expect(counts.self).toBeGreaterThanOrEqual(1);
    expect((await bindingsOf(evidence)).map((one) => one.mention_fp).sort()).toEqual(
      [nameFp("Lena Ortiz"), nameFp("Milo Grant")].sort(),
    );
    expect(await holderOf(keyFpOf("Bram Holt", ["own"]))).toBeUndefined();
  });

  it("a one-word name is keyed by the speaker's group: two addresses of one speaker give one person, another speaker's is another, and no alias of the name is a candidate", async () => {
    const first = await filed(NOA, [said(NOA, "Theo")]);
    const second = await filed(NOA_OTHER, [said(NOA_OTHER, "Theo")]);
    const ada = await filed(ADA, [said(ADA, "Theo")]);
    const [noa, other] = [await entityOf(NOA), await entityOf(NOA_OTHER)];
    await w.admin.identity.linkPeople(noa as EntityId, other as EntityId, "same", { requestId: req() });
    expect(await sync()).toMatchObject({ created: 2, bound: 3 });
    const lowest = [noa, other].sort()[0] ?? "";
    expect(one(await bindingsOf(first)).address_fp).toBe(keyFpOf("Theo", ["own"], lowest));
    expect(one(await bindingsOf(second)).address_fp).toBe(keyFpOf("Theo", ["own"], lowest));
    const adas = one(await bindingsOf(ada)).address_fp;
    expect(adas).toBe(keyFpOf("Theo", ["own"], await entityOf(ADA)));
    expect(await holderOf(adas)).not.toBe(await holderOf(keyFpOf("Theo", ["own"], lowest)));
  });

  it("the step opens no filed row without relation and has_speaker, and none already bound", async () => {
    const before = (await sync()).opened;
    await filed(ADA, [
      FiledMention.parse({
        name: "Rory Dale",
        type: "role",
        field: "subject",
        firstHand: false,
        speakerFp: addressFp(ADA.address),
      }),
      FiledMention.parse({ name: "Sana Bloom", type: "relationship", field: "counterparty", firstHand: false }),
      said(ADA, "Tamsin Reed"),
    ]);
    expect(await sync()).toMatchObject({ opened: before + 1, created: 1 });
    expect((await sync()).opened).toBe(before);
  });

  it("the owner's unbind of a code binding splits it, and a later sync does not rebind the person the owner lifted", async () => {
    const evidence = await filed(ADA, [said(ADA, "Kit Moss")]);
    expect(await sync()).toMatchObject({ created: 1 });
    const [binding] = await bindingsOf(evidence);
    const lifted = await holderOf(binding?.address_fp ?? "");
    expect(await w.admin.mentions.unbindMention(binding?.id as MentionBindingId, { requestId: req() })).toBe(true);
    const split = await sync();
    expect(split).toMatchObject({ created: 1, bound: 1 });
    expect(split.removed).toBeGreaterThanOrEqual(1);
    expect(
      await queryAs(
        w.db.urls.admin,
        "select 1 from knowledge.accounts where entity_id = $1 union all select 1 from knowledge.aliases where entity_id = $1",
        [lifted],
      ),
    ).toEqual([]);
    const live = (await bindingsOf(evidence)).filter((one) => !one.lifted);
    expect(live).toHaveLength(1);
    expect(live[0]?.address_fp).not.toBe(binding?.address_fp);
    expect(await holderOf(live[0]?.address_fp ?? "")).not.toBe(lifted);
    expect(await sync()).toMatchObject({ created: 0, bound: 0 });
    expect((await bindingsOf(evidence)).filter((one) => !one.lifted)).toEqual(live);
  });

  it("a named person a live claim names is kept when no live binding names them", async () => {
    const evidence = await filed(ADA, [said(ADA, "Pia Stone")]);
    expect(await sync()).toMatchObject({ created: 1 });
    const [binding] = await bindingsOf(evidence);
    const pia = (await holderOf(binding?.address_fp ?? "")) ?? "";
    const other = await stored(w.writer, w.accounts.personalMail, letter(BRAM, [ME]));
    expect(await w.pipeline.commit(batchOf(other, [claimRecord(other, "own", pia, { entities: [pia] })]))).toBe(
      "committed",
    );
    expect(await w.admin.mentions.unbindMention(binding?.id as MentionBindingId, { requestId: req() })).toBe(true);
    await sync();
    expect(await queryAs(w.db.urls.admin, "select 1 from knowledge.accounts where entity_id = $1", [pia])).toHaveLength(
      1,
    );
  });

  it("deleting the only source item withholds the named person, and the next sync removes the account and aliases", async () => {
    const fixture = letter(ADA, [ME]);
    const evidence = await stored(w.writer, w.accounts.personalMail, fixture);
    expect(await w.pipeline.commit(batchOf(evidence, [], { unresolved: 1, mentions: [said(ADA, "Juno Pike")] }))).toBe(
      "committed",
    );
    expect(await sync()).toMatchObject({ created: 1 });
    const juno = await holderOf(keyFpOf("Juno Pike", ["own"]));
    expect(juno).toBeDefined();
    await w.writer.applyDeletion(w.accounts.personalMail, {
      sourceAccount: w.accounts.personalMail.id,
      sourceItemId: mailSourceId(fixture),
    } as SourceDeletion);
    // The deletion's own cleanup takes the alias the item cited, and the account nothing cites;
    // the sync finds nothing left of them and binds nothing.
    expect(await sync()).toMatchObject({ created: 0, bound: 0, failed: 0 });
    expect(await queryAs(w.db.urls.admin, "select 1 from knowledge.accounts where entity_id = $1", [juno])).toEqual([]);
    expect(await queryAs(w.db.urls.admin, "select 1 from knowledge.aliases where entity_id = $1", [juno])).toEqual([]);
    // A named person a live binding still names is kept.
    expect(await holderOf(keyFpOf("Theo Marsh", ["own"]))).toBeDefined();
  });

  it("erasing a named person suppresses the key and the full name under the label; the same name later makes nobody", async () => {
    await filed(BRAM, [said(BRAM, "Ilse Brand")]);
    expect(await sync()).toMatchObject({ created: 1 });
    const ilse = await holderOf(keyFpOf("Ilse Brand", ["own"]));
    await w.admin.erasure.erasePerson(ilse as EntityId, { requestId: req() });
    const suppressed = await queryAs<{ value_fp: string }>(
      w.db.urls.admin,
      "select value_fp from knowledge.suppressions where value_fp = any($1::text[])",
      [[keyFpOf("Ilse Brand", ["own"]), nameFp("Ilse Brand")]],
    );
    expect(suppressed.map((row) => row.value_fp).sort()).toEqual(
      [keyFpOf("Ilse Brand", ["own"]), nameFp("Ilse Brand")].sort(),
    );
    // Ada's letter is not one the erasure removed, so Ada's speaker resolves and the name is refused.
    const later = await filed(ADA, [said(ADA, "Ilse Brand")]);
    const counts = await sync();
    expect(counts).toMatchObject({ created: 0, bound: 0 });
    expect(counts.skipped).toBeGreaterThanOrEqual(1);
    expect(await bindingsOf(later)).toEqual([]);
    expect(await holderOf(keyFpOf("Ilse Brand", ["own"]))).toBeUndefined();
  });

  it("a named person counts as named only, so a heard claim naming them builds no belief until linked; a person with an address does not", async () => {
    const theo = (await holderOf(keyFpOf("Theo Marsh", ["own"]))) ?? "";
    const ada = await entityOf(ADA);
    const query = ((sql: string, values?: unknown[]) => queryAs(w.db.urls.admin, sql, values)) as Query;
    expect([...(await namedOnly(query, w.db.keys, [theo, ada]))]).toEqual([theo]);
    expect([...(await namedOnly(query, w.db.keys, [theo, ada], ["own"]))]).toEqual([theo]);
  });

  it("past the daily cap per label the name waits as capped and binds at a later sync; another label's cap is its own", async () => {
    await yesterday();
    const cap = secondDegreeRules().namedPerLabelPerDay;
    const names = Array.from(
      { length: cap + 1 },
      (_, n) => `Capper ${String.fromCharCode(65 + Math.floor(n / 26))}${String.fromCharCode(97 + (n % 26))}son`,
    );
    const evidence = await filed(
      ADA,
      names.map((name) => said(ADA, name)),
    );
    expect(await sync()).toMatchObject({ created: cap, capped: 1 });
    expect(await sync()).toMatchObject({ created: 0, capped: 1 });
    const atWork = await filed(WREN, [said(WREN, "Vera Quill")], true);
    expect(await sync()).toMatchObject({ created: 1, capped: 1 });
    expect(await bindingsOf(atWork)).toHaveLength(1);
    await yesterday();
    expect(await sync()).toMatchObject({ created: 1, capped: 0 });
    expect(await bindingsOf(evidence)).toHaveLength(cap + 1);
  });
});
