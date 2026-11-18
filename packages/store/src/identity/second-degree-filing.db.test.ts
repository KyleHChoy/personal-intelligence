import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FiledMention } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { type Admin, createAdmin } from "../admin/admin.ts";
import { QUENTIN, SOLO } from "../test-support/cast.ts";
import { one } from "../test-support/connections.ts";
import { fingerprint } from "../test-support/database.ts";
import { MAIL } from "../test-support/items-named.ts";
import {
  batchOf,
  countOf,
  type PipelineStore,
  rowsOf,
  stored,
  withPipeline,
} from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";

// The commit writes each filed name's three clear flags, and the refile reaches the meeting and
// moment lanes. Through the Pipeline as pi_pipeline and the Admin as pi_admin. Synthetic values
// only.

const TIMEOUT = 240_000;
const THEO = "Theo Marsh";

type World = PipelineStore & { admin: Admin; item: string };

async function withFiling<T>(fn: (world: World) => Promise<T>): Promise<T> {
  return withPipeline(async (store) => {
    const item = await stored(store.writer, store.accounts.personalMail, MAIL.solo);
    const folder = await mkdtemp(join(tmpdir(), "pi-fil-"));
    const admin = createAdmin({
      url: store.db.urls.admin,
      keys: store.db.keys,
      log: recordingLogger().log,
      journal: join(folder, "keys.json.erasures"),
    });
    try {
      return await fn({ ...store, admin, item });
    } finally {
      await admin.close();
      await rm(folder, { recursive: true, force: true });
    }
  });
}

type Flags = { relation: boolean; has_speaker: boolean; first_hand: boolean };
const flagsOf = (world: World, evidenceId = world.item) =>
  rowsOf<Flags & { name_fp: string }>(
    world.db,
    "select name_fp, relation, has_speaker, first_hand from vault.unresolved_mentions where evidence_id = $1 order by name_fp",
    [evidenceId],
  );

// A saved call of an item, its answer empty: what a replay reads in place of buying one.
async function saveCall(world: World, evidenceId: string, mark: string): Promise<void> {
  await world.pipeline.calls("configured/model").save({
    key: {
      evidenceId,
      revision: 0,
      extractorGeneration: 1,
      promptId: "personal_meeting",
      promptVersion: "7",
      inputHash: mark.repeat(64),
    },
    keys: [{ evidenceId, keyRef: "personal-unsealed" }],
    renderedInput: "",
    rawOutput: JSON.stringify({ claims: [], narrowing: "none" }),
    outputHash: "b".repeat(64),
    label: { compartments: ["own"], readers: ["m-owner"] },
    origin: "live",
  } as never);
}

const waitingOf = async (world: World, evidenceId: string): Promise<boolean> =>
  one(
    await rowsOf<{ waiting: boolean }>(world.db, "select waiting from vault.pipeline_items where evidence_id = $1", [
      evidenceId,
    ]),
  ).waiting;

describe("the commit's clear flags", { timeout: TIMEOUT }, () => {
  it("a filed relationship counterparty from its subject's own segment stores relation, has_speaker and first_hand true", () =>
    withFiling(async (world) => {
      const solo = fingerprint(world.db.keys, "address", SOLO.address);
      const mention = FiledMention.parse({
        name: THEO,
        type: "relationship",
        field: "counterparty",
        firstHand: true,
        subjectFp: solo,
        speakerFp: solo,
      });
      expect(await world.pipeline.commit(batchOf(world.item, [], { unresolved: 1, mentions: [mention] }))).toBe(
        "committed",
      );
      expect(await flagsOf(world)).toEqual([
        { name_fp: fingerprint(world.db.keys, "name", THEO), relation: true, has_speaker: true, first_hand: true },
      ]);
    }));

  it("a reported relation's subject is a relation, not first-hand; a role, an agent's and an unknown speaker's are not bindable", () =>
    withFiling(async (world) => {
      const solo = fingerprint(world.db.keys, "address", SOLO.address);
      const quentin = fingerprint(world.db.keys, "address", QUENTIN.address);
      const mentions = [
        // Solo reports that Ada works with Quentin: Ada is a side known by name alone.
        FiledMention.parse({
          name: "Ada Fenn",
          type: "relationship",
          field: "subject",
          firstHand: false,
          subjectFp: fingerprint(world.db.keys, "name", "Ada Fenn"),
          speakerFp: solo,
        }),
        // A role is no relation, whoever says it.
        FiledMention.parse({
          name: "Bryn Calder",
          type: "role",
          field: "subject",
          firstHand: false,
          speakerFp: quentin,
        }),
        // An agent's finding: no speaker.
        FiledMention.parse({ name: "Cleo Ward", type: "relationship", field: "counterparty", firstHand: false }),
        FiledMention.parse({ name: "Dov Pratt", type: "relationship", field: "counterparty" }),
      ];
      expect(await world.pipeline.commit(batchOf(world.item, [], { unresolved: 4, mentions }))).toBe("committed");
      const byName = new Map((await flagsOf(world)).map(({ name_fp, ...flags }) => [name_fp, flags]));
      const of = (name: string) => byName.get(fingerprint(world.db.keys, "name", name));
      expect(of("Ada Fenn")).toEqual({ relation: true, has_speaker: true, first_hand: false });
      expect(of("Bryn Calder")).toEqual({ relation: false, has_speaker: true, first_hand: false });
      expect(of("Cleo Ward")).toEqual({ relation: true, has_speaker: false, first_hand: false });
      expect(of("Dov Pratt")).toEqual({ relation: true, has_speaker: false, first_hand: false });
    }));
});

describe("the refile reaches the capture lanes", { timeout: TIMEOUT }, () => {
  // The refile reads the item's committed lane, its saved calls and its filed rows, never its
  // source; a message's evidence stands in for the meeting's.
  it("refile sets a meeting with a filed name waiting and buys no call", () =>
    withFiling(async (world) => {
      const { pipeline, writer, accounts, db, item } = world;
      const bare = await stored(writer, accounts.personalMail, MAIL.fromQuentin);
      // A meeting with a filed name and a saved call: refiled. Its candidates all resolved, as a
      // speaker's filed name leaves the count at 0.
      expect(
        await pipeline.commit(
          batchOf(item, [], {
            lane: "meeting",
            unresolved: 0,
            mentions: [FiledMention.parse({ name: THEO, type: "relationship", field: "counterparty" })],
          }),
        ),
      ).toBe("committed");
      await saveCall(world, item, "a");
      // A meeting with a saved call and nothing filed: left as it is.
      expect(await pipeline.commit(batchOf(bare, [], { lane: "meeting", unresolved: 0 }))).toBe("committed");
      await saveCall(world, bare, "b");
      expect(await world.admin.mentions.refileMentions()).toEqual({ items: 1 });
      expect(await waitingOf(world, item)).toBe(true);
      expect(await waitingOf(world, bare)).toBe(false);
      // Its calls kept, so the next run replays it at no cost.
      expect(await countOf(db, "vault.model_calls")).toBe(2);
    }));
});
