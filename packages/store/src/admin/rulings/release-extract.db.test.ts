import pg from "pg";
import { describe, expect, it } from "vitest";
import { MAIL } from "../../test-support/items-named.ts";
import {
  batchOf,
  countOf,
  type PipelineStore,
  rowsOf,
  stored,
  withPipeline,
} from "../../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../../test-support/recording.ts";
import { Admin } from "../admin.ts";

// A retry without the override writes none, and no command raises a card for a withheld item or a
// held message.

const TIMEOUT = 240_000;

// An admin on a pool of the test's own. `failOn` makes the first statement whose text holds it
// fail, as the database would.
async function withAdmin<T>(store: PipelineStore, fn: (admin: Admin) => Promise<T>, failOn?: string): Promise<T> {
  const pool = new pg.Pool({ connectionString: store.db.urls.admin, max: 2 });
  const wrapped =
    failOn === undefined
      ? pool
      : ({
          connect: async () => {
            const client = await pool.connect();
            return {
              query: (statement: string, values?: unknown[]) =>
                statement.includes(failOn)
                  ? Promise.reject(Object.assign(new Error("injected"), { code: "XX000" }))
                  : client.query(statement, values),
              release: (destroy?: boolean) => client.release(destroy),
            };
          },
        } as unknown as pg.Pool);
  try {
    return await fn(new Admin({ pool: wrapped, keys: store.db.keys, log: recordingLogger().log }));
  } finally {
    await pool.end();
  }
}

const messageOf = async (store: PipelineStore, evidenceId: string): Promise<string> =>
  (await rowsOf<{ id: string }>(store.db, "select id from knowledge.messages where evidence_id = $1", [evidenceId]))[0]
    ?.id ?? "";

const decisions = (store: PipelineStore) =>
  rowsOf<{
    kind: string;
    target_kind: string;
    target_id: string;
    batch: boolean;
    answer: string | null;
    card_id: string | null;
    supersedes: string | null;
    compartments: string[];
    request_id: string;
  }>(
    store.db,
    "select kind, target_kind, target_id, batch, answer, card_id, supersedes, compartments, request_id from knowledge.owner_decisions order by target_id",
  );

const withheldItem = async (store: PipelineStore): Promise<{ evidenceId: string; message: string }> => {
  const evidenceId = await stored(store.writer, store.accounts.personalMail, MAIL.canary);
  await store.pipeline.commit(batchOf(evidenceId, [], { status: "withheld", code: "sensitive" }));
  return { evidenceId, message: await messageOf(store, evidenceId) };
};

const isWithheld = async (store: PipelineStore, evidenceId: string): Promise<boolean> =>
  (
    await rowsOf<{ withheld: boolean }>(store.db, "select withheld from vault.pipeline_items where evidence_id = $1", [
      evidenceId,
    ])
  )[0]?.withheld === true;

describe("the release of a withheld item is an owner decision", { timeout: TIMEOUT }, () => {
  it("extract retry with the override writes one release decision whose target is the message, in the retry's own transaction", () =>
    withPipeline(async (store) => {
      const { evidenceId, message } = await withheldItem(store);
      // A failing decision insert rolls the release back with it: the item is still withheld.
      await expect(
        withAdmin(store, (admin) => admin.extraction.release(message), "insert into knowledge.owner_decisions"),
      ).rejects.toBeDefined();
      expect(await isWithheld(store, evidenceId)).toBe(true);
      expect(await decisions(store)).toEqual([]);
      // The positive control: with nothing failing both commit.
      await withAdmin(store, (admin) => admin.extraction.release(message));
      expect((await store.pipeline.due(10, 1))[0]).toMatchObject({ evidenceId, override: true });
      expect(await decisions(store)).toEqual([
        {
          kind: "release",
          target_kind: "message",
          target_id: message,
          batch: false,
          answer: null,
          card_id: null,
          supersedes: null,
          compartments: ["own"],
          request_id: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/),
        },
      ]);
    }));

  it("a refused release writes no decision", () =>
    withPipeline(async (store) => {
      const done = await stored(store.writer, store.accounts.personalMail, MAIL.fromQuentin);
      await store.pipeline.commit(batchOf(done, []));
      await expect(
        withAdmin(store, async (admin) => admin.extraction.release(await messageOf(store, done))),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(
        withAdmin(store, (admin) => admin.extraction.release("msg_00000000000000000000000000")),
      ).rejects.toMatchObject({
        code: "not_found",
      });
      expect(await decisions(store)).toEqual([]);
    }));

  it("a retry without the override writes none", () =>
    withPipeline(async (store) => {
      const { evidenceId, message } = await withheldItem(store);
      expect(await withAdmin(store, (admin) => admin.extraction.retry({ messageId: message }))).toEqual({
        selected: 1,
      });
      expect(await withAdmin(store, (admin) => admin.extraction.retry({ status: "failed" }))).toEqual({ selected: 0 });
      expect(await withAdmin(store, (admin) => admin.extraction.retry({ all: true }))).toEqual({ selected: 1 });
      expect((await store.pipeline.due(10, 1))[0]).toMatchObject({ evidenceId, override: false });
      expect(await decisions(store)).toEqual([]);
    }));

  it("no card is raised for a withheld item or a held message, by any command", () =>
    withPipeline(async (store) => {
      const { message } = await withheldItem(store);
      const held = await stored(store.writer, store.accounts.personalMail, { ...MAIL.solo, held: true });
      expect(await countOf(store.db, "ledger.cards")).toBe(0);
      await withAdmin(store, async (admin) => {
        await admin.extraction.release(message);
        await admin.extraction.retry({ messageId: message });
        expect(await admin.held.releaseHeld({ id: await messageOf(store, held) })).toEqual({ released: 1 });
      });
      expect(await countOf(store.db, "ledger.cards")).toBe(0);
      expect(await countOf(store.db, "ledger.record_events")).toBe(0);
      expect((await decisions(store)).map((row) => row.kind)).toEqual(["release", "release"]);
    }));
});
