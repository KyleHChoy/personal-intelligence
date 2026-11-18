import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceDeletion } from "@intelligence/contracts";
import { BELIEF_TYPES, type FactList, PersonalCompartment } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { addCompartmentKey, generateKeyFile, loadKeys } from "../core/keys.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { connect } from "../test-support/cast.ts";
import { ALL_VIEWS, insertClient } from "../test-support/clients.ts";
import { one, readAs } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { ingestMail, mailFacts, mailRevision, mailSourceId } from "../test-support/items.ts";
import { MAIL } from "../test-support/items-named.ts";
import { batchOf, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { storeFiles, storeText } from "../test-support/sources.ts";
import { openStore, withDatabase } from "../test-support/store.ts";
import { evidenceIdOf, outcomeValue, registration } from "../test-support/values.ts";
import { Admin } from "./admin.ts";

// What the rest of the owner surface assumes of what it builds on. Each test fails with a plain name when one of
// them does not hold. The two assumptions about the belief builder are in personal-extract's
// owner-rest-preconditions.test.ts, beside the extraction's rebuild they watch.

const TIMEOUT = 180_000;

// Every statement of the store's own source, tests aside, that deletes from knowledge.claims,
// directly or through a removal function.
const CLAIM_DELETE = /delete\s+from\s+knowledge\.claims\b|knowledge\.remove_(?:extracted_)?claims\(/g;
const isSource = (file: string): boolean =>
  file.endsWith(".ts") && !file.includes(".test.") && !file.includes("fixtures") && file !== "testing.ts";

async function claimDeletes(): Promise<{ file: string; at: number; text: string }[]> {
  const found: { file: string; at: number; text: string }[] = [];
  for (const file of storeFiles().filter(isSource)) {
    const text = storeText(file);
    for (const match of text.matchAll(CLAIM_DELETE)) found.push({ file, at: match.index, text });
  }
  return found;
}

describe("what corrections-and-digest builds on", { timeout: TIMEOUT }, () => {
  it("BELIEF_TYPES holds commitment and no type of transaction.receipt", () => {
    expect(BELIEF_TYPES).toContain("commitment");
    expect(BELIEF_TYPES.filter((type: string) => type === "transaction" || type.startsWith("transaction."))).toEqual(
      [],
    );
  });

  it("the statements that delete from knowledge.claims, directly or through a removal function, are in removeClaims and the re-derive, and nowhere else in the store", async () => {
    const found = await claimDeletes();
    // removeClaims twice: through the definer, and as the pipeline does.
    expect(found.map((one) => one.file)).toEqual(["rederive.ts", "writer-removal.ts", "writer-removal.ts"]);
    // The scan finds what it looks for, and not a delete from another table.
    expect([...'await query("delete from knowledge.claims where id = any($1)")'.matchAll(CLAIM_DELETE)]).toHaveLength(
      1,
    );
    expect([
      ...'await query("delete from knowledge.claim_entities where claim_id = any($1)")'.matchAll(CLAIM_DELETE),
    ]).toHaveLength(0);
    expect([...'await query("select knowledge.remove_extracted_claims()")'.matchAll(CLAIM_DELETE)]).toHaveLength(1);
  });

  it("each of them runs after the beliefs lock in its transaction", async () => {
    // The function each delete is in: from the last function head before it. The beliefs lock is
    // taken in that function, before the delete.
    const HEAD = /\n(?:export )?(?:async )?function \w+/g;
    for (const { file, at, text } of await claimDeletes()) {
      const heads = [...text.slice(0, at).matchAll(HEAD)];
      const start = heads.at(-1)?.index ?? 0;
      const body = text.slice(start, at);
      expect(/query\(BELIEFS_LOCK\)/.test(body), file).toBe(true);
    }
    // The control: the same check fails on a function that takes no lock.
    const planted = '\nasync function planted(tx) {\n  await tx.query("delete from knowledge.claims");\n}\n';
    expect(/query\(BELIEFS_LOCK\)/.test(planted.slice(0, planted.indexOf("delete from")))).toBe(false);
  });

  it("PersonalCompartment accepts declassified, and pi keys add-compartment declassified makes a key", async () => {
    expect(PersonalCompartment.safeParse("declassified").success).toBe(true);
    // The control: a compartment of no known form is refused.
    expect(PersonalCompartment.safeParse("declassified:extra").success).toBe(false);
    const folder = await mkdtemp(join(tmpdir(), "pi-cli-keys-"));
    try {
      const file = join(folder, "keys.json");
      await generateKeyFile(file, ["own"]);
      expect((await loadKeys(file)).compartments.has("declassified")).toBe(false);
      // What `pi keys add-compartment declassified` runs.
      await addCompartmentKey(file, "declassified");
      const keys = await loadKeys(file);
      expect([...keys.compartments.keys()].sort()).toEqual(["declassified", "own"]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("policy.clients.compartments is the clearance policy.client_clearance returns", () =>
    withDatabase(async (db) => {
      for (const [name, compartments] of [
        ["cli-own", ["own"]],
        ["cli-wide", ["own", "employer:example"]],
      ] as const) {
        const client = await insertClient(db, name, [...compartments]);
        const stored = one(
          await queryAs<{ compartments: string[] }>(
            db.urls.admin,
            "select compartments from policy.clients where id = $1",
            [client.id],
          ),
        ).compartments;
        const clearance = one(
          await readAs(db, client.token, (query) =>
            query<{ clearance: string[] }>("select policy.client_clearance() as clearance"),
          ),
        ).clearance;
        expect([...clearance].sort(), name).toEqual([...stored].sort());
        expect([...clearance].sort(), name).toEqual([...compartments].sort());
      }
      // The control: with no token there is no clearance.
      expect(
        one(
          await readAs(db, null, (query) =>
            query<{ clearance: string[] | null }>("select policy.client_clearance() as clearance"),
          ),
        ).clearance ?? [],
      ).toEqual([]);
    }));

  it("a policy.calls row records the client, the tool, the outcome and the row count", () =>
    withDatabase(async (db) => {
      const client = await insertClient(db, "cli-caller", ["own"]);
      await readAs(db, client.token, (query) => query("select policy.log_call('find_facts', 3, 'ok')"));
      expect(await queryAs(db.urls.admin, "select client_id, tool, outcome, rows from policy.calls")).toEqual([
        { client_id: client.id, tool: "find_facts", outcome: "ok", rows: 3 },
      ]);
    }));

  it("every evidence row has source_account_id and source_item_fp, and a new revision of one item keeps both", async () => {
    const store = await openStore();
    try {
      const accounts = await connect(store.writer);
      await ingestMail(store.writer, accounts.personalMail, MAIL.canary);
      await ingestMail(store.writer, accounts.personalMail, MAIL.solo);
      const missing = `select count(*)::int as n from vault.evidence_items where source_account_id is null or source_item_fp is null`;
      expect(one(await queryAs<{ n: number }>(store.db.urls.admin, missing)).n).toBe(0);

      await store.writer.ingestItem(
        accounts.personalMail,
        mailRevision(MAIL.canary, accounts.personalMail),
        mailFacts(MAIL.canary),
      );
      const revisions = await queryAs<{ revision: number; source_account_id: string; source_item_fp: string }>(
        store.db.urls.admin,
        "select revision, source_account_id, source_item_fp from vault.evidence_items where id in ($1, $2) order by revision",
        [
          evidenceIdOf(accounts.personalMail, mailSourceId(MAIL.canary), 0),
          evidenceIdOf(accounts.personalMail, mailSourceId(MAIL.canary), 1),
        ],
      );
      // The control: there are two revisions of the one item.
      expect(revisions.map((row) => row.revision)).toEqual([0, 1]);
      expect(new Set(revisions.map((row) => `${row.source_account_id} ${row.source_item_fp}`)).size).toBe(1);
      expect(one(await queryAs<{ n: number }>(store.db.urls.admin, missing)).n).toBe(0);
    } finally {
      await store.close();
    }
  });

  it("find_facts adds each fact's message evidence id to the read log's bound, and agent-records's removeResting removes a record that bound it", async () => {
    // A client that records needs its agent key in the key file.
    const store = await openStore({ compartments: ["own", "employer:example", "agent:cli-finder"] });
    try {
      const accounts = await connect(store.writer);
      await ingestMail(store.writer, accounts.personalMail, MAIL.canary);
      const evidenceId = evidenceIdOf(accounts.personalMail, mailSourceId(MAIL.canary));
      const owner = one(
        await queryAs<{ id: string }>(store.db.urls.admin, "select id from knowledge.entities where kind = 'owner'"),
      ).id;
      const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
      try {
        expect(await pipeline.commit(batchOf(evidenceId, [claimRecord(evidenceId, "own", owner)]))).toBe("committed");
      } finally {
        await pipeline.close();
      }

      const admin = new Admin({ pool: store.adminPool, keys: store.db.keys, log: store.log, recordEnabled: true });
      const { token } = await admin.clients.addClient(
        registration("cli-finder", ["own"], { views: ALL_VIEWS as never, tools: ["get_self", "find_facts", "record"] }),
      );
      const facts: FactList = outcomeValue(await store.reader.findFacts(token, { type: "commitment" }));
      expect(facts.facts).toHaveLength(1);
      const logged = await queryAs<{ tool: string; bound: string[] }>(
        store.db.urls.admin,
        "select tool, bound from ledger.read_log order by id",
      );
      expect(logged).toEqual([{ tool: "find_facts", bound: [evidenceId] }]);

      // A record its session writes after the read rests on the item, and goes with it.
      const { recordId } = outcomeValue(
        await store.reader.record(token, {
          kind: "note",
          body: "an agent record after find_facts",
          requestId: "request-cli-00000001",
        }),
      );
      expect((await store.writer.takeRecords()).taken).toBe(1);
      const deletion = {
        sourceAccount: accounts.personalMail.id,
        sourceItemId: mailSourceId(MAIL.canary),
      } as SourceDeletion;
      expect(await store.writer.applyDeletion(accounts.personalMail, deletion)).toEqual({ recordsRemoved: 1 });
      const [row] = await queryAs<{ body: boolean; tainted: boolean }>(
        store.db.urls.admin,
        "select body_enc is not null as body, tainted_at is not null as tainted from ledger.agent_writes where id = $1",
        [recordId],
      );
      expect(row).toEqual({ body: false, tainted: true });
    } finally {
      await store.close();
    }
  });
});
