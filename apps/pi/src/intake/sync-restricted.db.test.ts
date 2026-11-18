import { PersonalLogEvent, type RestrictedCategory } from "@intelligence/contracts/personal";
import { gmailItemId } from "@intelligence/personal-core";
import { fakeSources, type World, world } from "@intelligence/personal-core/testing";
import { createWriter, type Keys, type Writer } from "@intelligence/personal-store";
import { createTestDatabase, fingerprint, queryAs, type TestDatabase } from "@intelligence/personal-store/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pi } from "../test-support/run-pi.ts";
import { runSync } from "./sync.ts";

// The restricted screen through sync: the synthetic world on the fake Gmail, with the health key in
// the restricted file. Each database is its own.

const NOW = new Date("2026-06-15T12:00:00.000Z");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
const HEALTH = ["own", "restricted:health"];

type Stack = { db: TestDatabase; writer: Writer };
const stacks: Stack[] = [];

async function stack(restricted: RestrictedCategory[]): Promise<Stack> {
  const db = await createTestDatabase({ compartments: ["own", "employer:example"], restricted });
  const record = (event: PersonalLogEvent): void => void PersonalLogEvent.parse(event);
  const made = {
    db,
    writer: createWriter({ url: db.urls.writer, keys: db.keys, log: { info: record, warn: record, error: record } }),
  };
  stacks.push(made);
  return made;
}

afterEach(async () => {
  for (const { db, writer } of stacks.splice(0)) {
    await writer.close();
    await db.drop();
  }
});

const sync = (s: Stack, w: World, restrictedOn?: RestrictedCategory[]) =>
  runSync({
    writer: s.writer,
    sources: fakeSources(w),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    now: NOW,
    ...(restrictedOn === undefined ? {} : { restrictedOn }),
  });

// The labels of a world message's evidence rows and its message row.
async function labelsOf(s: Stack, gmailId: string): Promise<{ evidence: string[][]; message: string[][] }> {
  const fp = fingerprint(s.db.keys, "source_id", gmailItemId(gmailId));
  const evidence = await queryAs<{ compartments: string[] }>(
    s.db.urls.admin,
    "select compartments from vault.evidence_items where source_item_fp = $1 order by revision",
    [fp],
  );
  const rows = await queryAs<{ compartments: string[] }>(
    s.db.urls.admin,
    "select m.compartments from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where e.source_item_fp = $1",
    [fp],
  );
  return { evidence: evidence.map((row) => row.compartments), message: rows.map((row) => row.compartments) };
}

describe("restricted-compartments: the screen at sync", () => {
  it("with the restricted key locked, a restricted message is not stored, is no fault and is counted as waiting on an unlock", async () => {
    const s = await stack(["health"]);
    const w = world({ now: NOW });
    // The keys sync holds once the restricted file is wrapped: the general file's, and health locked.
    const keys: Keys = {
      compartments: new Map([...s.db.keys.compartments].filter(([name]) => !name.startsWith("restricted:"))),
      fingerprintKey: s.db.keys.fingerprintKey,
      locked: new Set(["restricted:health"]),
    };
    const lines: PersonalLogEvent[] = [];
    const log = {
      info: (one: PersonalLogEvent) => void lines.push(one),
      warn: (one: PersonalLogEvent) => void lines.push(one),
      error: () => {},
    };
    const writer = createWriter({ url: s.db.urls.writer, keys, log });
    try {
      const result = await runSync({ writer, sources: fakeSources(w), log, now: NOW, restrictedOn: ["health"] });
      expect(result.outcomes.every((one) => one.outcome === "ok")).toBe(true);
      expect(result.refused).toBe(0);
      expect(lines.filter((one) => one.event === "items_waiting_unlock").map((one) => one.counts)).toEqual([
        { items: 1 },
      ]);
      expect(lines.filter((one) => one.event === "item_skipped")).toEqual([]);
      expect(await labelsOf(s, w.handles.healthTermMessageId)).toEqual({ evidence: [], message: [] });
      // The positive control: every other message is stored.
      expect(await labelsOf(s, w.handles.moneyTermMessageId)).toEqual({ evidence: [["own"]], message: [["own"]] });
    } finally {
      await writer.close();
    }
  });

  it("with health on, the health term message is stored under own and restricted:health, and every other message under its account's compartment", async () => {
    const s = await stack(["health"]);
    const w = world({ now: NOW });
    const result = await sync(s, w, ["health"]);
    expect(result.outcomes.every((one) => one.outcome === "ok")).toBe(true);
    expect(await labelsOf(s, w.handles.healthTermMessageId)).toEqual({ evidence: [HEALTH], message: [HEALTH] });
    // Money and legal are off: their messages are stored as any other. So are the decide model's two.
    for (const id of [
      w.handles.moneyTermMessageId,
      w.handles.legalTermMessageId,
      w.handles.decideHealthMessageId,
      w.handles.decideBelowMessageId,
    ]) {
      expect(await labelsOf(s, id), id).toEqual({ evidence: [["own"]], message: [["own"]] });
    }
    // Exactly one item carries a restricted label, in every table that has the column.
    const restricted = await queryAs<{ n: number }>(
      s.db.urls.admin,
      "select count(*)::int as n from vault.evidence_items where policy.is_restricted(compartments)",
    );
    expect(restricted).toEqual([{ n: 1 }]);
    const tables = await queryAs<{ name: string }>(
      s.db.urls.admin,
      `select c.table_schema || '.' || c.table_name as name from information_schema.columns c
       join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
       where c.column_name = 'compartments' and c.table_schema in ('policy', 'vault', 'knowledge', 'projections', 'ledger', 'queue') order by 1`,
    );
    const labels = new Set<string>();
    for (const { name } of tables) {
      for (const row of await queryAs<{ compartments: string[] }>(
        s.db.urls.admin,
        `select distinct compartments from ${name} where policy.is_restricted(compartments)`,
      ))
        labels.add(`${name} ${row.compartments.join(",")}`);
    }
    // Its evidence, its blob, its message, its sender's and Cc's rows: all under the one label.
    expect([...labels].every((one) => one.endsWith(" own,restricted:health"))).toBe(true);
    expect([...labels].map((one) => one.split(" ")[0]).sort()).toEqual(
      expect.arrayContaining([
        "knowledge.accounts",
        "knowledge.messages",
        "vault.evidence_blobs",
        "vault.evidence_items",
      ]),
    );

    // A second sync stores nothing new and changes no label.
    await sync(s, w, ["health"]);
    expect(await labelsOf(s, w.handles.healthTermMessageId)).toEqual({ evidence: [HEALTH], message: [HEALTH] });
  });

  it("an off category is never computed: with no category on, every message is stored under own, whatever keys the file holds", async () => {
    const s = await stack(["health"]);
    const w = world({ now: NOW });
    await sync(s, w);
    for (const id of [w.handles.healthTermMessageId, w.handles.moneyTermMessageId, w.handles.legalTermMessageId]) {
      expect(await labelsOf(s, id), id).toEqual({ evidence: [["own"]], message: [["own"]] });
    }
    expect(
      await queryAs(s.db.urls.admin, "select 1 from vault.evidence_items where policy.is_restricted(compartments)"),
    ).toEqual([]);
  });

  it("pi sync refuses to start with restricted_keys_mismatch when the table names a category the restricted file lacks, and when the file holds one the table does not", async () => {
    const s = await stack(["health"]);
    const env = {
      PI_DATABASE_URL_WRITER: s.db.urls.writer,
      PI_KEY_FILE: s.db.keyFile,
      PI_RESTRICTED_KEY_FILE: s.db.restrictedKeyFile ?? "",
    };
    const refused = {
      exit: 1,
      stdout: "",
      stderr: expect.stringContaining(JSON.stringify({ event: "command_failed", code: "restricted_keys_mismatch" })),
    };
    // The file holds health; the table names none.
    expect(await pi(["sync"], env)).toEqual(refused);
    // They agree: sync starts, and finds no account.
    await queryAs(s.db.urls.admin, "insert into policy.restricted_categories (category) values ('health')");
    expect(await pi(["sync"], env)).toEqual({
      exit: 0,
      stdout: "",
      stderr: `${JSON.stringify({ event: "no_accounts" })}\n`,
    });
    // The table names money, which the file lacks.
    await queryAs(s.db.urls.admin, "insert into policy.restricted_categories (category) values ('money')");
    expect(await pi(["sync"], env)).toEqual(refused);
    // Without the restricted file, health is named and no key holds it.
    await queryAs(s.db.urls.admin, "delete from policy.restricted_categories where category = 'money'");
    expect(await pi(["sync"], { PI_DATABASE_URL_WRITER: s.db.urls.writer, PI_KEY_FILE: s.db.keyFile })).toEqual(
      refused,
    );
  });
});
