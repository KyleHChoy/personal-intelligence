import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ErasureJournalEntry,
  MemoryExposureView,
  MemoryStatusView,
  PersonalLogEvent,
} from "@intelligence/contracts/personal";
import { fakeSources, world } from "@intelligence/personal-core/testing";
import { appendJournal, createWriter, journalPath, type Writer } from "@intelligence/personal-store";
import { copiesOf, createTestDatabase, queryAs, type TestDatabase } from "@intelligence/personal-store/testing";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { runSync } from "../intake/sync.ts";
import { failed, pi } from "../test-support/run-pi.ts";

// `pi memory status` and `pi memory exposures` through `run`, in-process, on a database of their
// own with the synthetic world synced into it. The memory rows are written in SQL as pi_owner, as
// policy.serve_memory and ledger.taint_citing write them: what is tested here is what the commands
// print, and the store's memory-admin tests cover how the rows come to be.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const NOW = new Date("2026-06-15T12:00:00.000Z");

type Stack = { db: TestDatabase; writer: Writer; owner: string; canaries: string[] };
const stacks: Stack[] = [];

afterEach(async () => {
  for (const { db, writer } of stacks.splice(0)) {
    await writer.close();
    await db.drop();
  }
});

// The file syncs the world once, and each test gets a copy of that database and its key file
// (copiesOf).
let syncedFolder = "";
const synced = copiesOf(async () => {
  const folder = await mkdtemp(join(tmpdir(), "pi-memory-test-"));
  syncedFolder = folder;
  const keyFile = join(folder, "keys.json");
  expect((await pi(["keys", "init", "--compartments", "own,employer:example"], { PI_KEY_FILE: keyFile })).exit).toBe(0);
  const db = await createTestDatabase({ keyFile });
  const record = (event: PersonalLogEvent): void => void PersonalLogEvent.parse(event);
  const writer = createWriter({
    url: db.urls.writer,
    keys: db.keys,
    log: { info: record, warn: record, error: record },
  });
  try {
    const result = await runSync({
      writer,
      sources: fakeSources(world({ now: NOW })),
      log: { info: record, warn: record, error: record },
      now: NOW,
    });
    expect(result.outcomes.every((one) => one.outcome === "ok")).toBe(true);
  } finally {
    await writer.close();
  }
  return db;
});
afterAll(async () => {
  await synced.drop();
  await rm(syncedFolder, { recursive: true, force: true });
});

async function stack(): Promise<Stack> {
  const db = await synced.copy();
  const record = (event: PersonalLogEvent): void => void PersonalLogEvent.parse(event);
  const writer = createWriter({
    url: db.urls.writer,
    keys: db.keys,
    log: { info: record, warn: record, error: record },
  });
  const w = world({ now: NOW });
  // What no byte of a command's output may hold: the world's addresses and names. The address
  // pattern runs only over the stretches of address characters that hold an "@": run over the
  // whole world, it rescans the research lane's 1 MiB page body from each of its characters.
  const stretches = (JSON.stringify(w).match(/[A-Za-z0-9._%+@-]+/g) ?? []).filter((one) => one.includes("@"));
  const canaries = [
    ...w.owner.addresses,
    ...stretches.flatMap((one) => one.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g) ?? []),
  ];
  const made = { db, writer, owner: w.owner.addresses[0] ?? "", canaries };
  stacks.push(made);
  return made;
}

const ownerEnv = (s: Stack): Record<string, string> => ({
  PI_DATABASE_URL_ADMIN: s.db.urls.admin,
  PI_KEY_FILE: s.db.keyFile,
});
const REPLAY = failed("erasure_replay_needed", "run pi erase replay (pia on the box)");

// A client given the tool by `pi clients add`, two projection rows of its own, one of them
// tainted with its exposure row.
async function served(s: Stack, name: string): Promise<string> {
  expect(
    (
      await pi(
        ["clients", "add", name, "--broad", "--views", "self,work", "--tools", "get_self,sync_memory"],
        ownerEnv(s),
      )
    ).exit,
  ).toBe(0);
  const [client] = await queryAs<{ id: string }>(s.db.urls.admin, "select id from policy.clients where name = $1", [
    name,
  ]);
  const id = client?.id ?? "";
  const row = (n: number, tainted: boolean) =>
    `insert into ledger.memory_projections (id, client_id, audience, template, fact_key_fp, state_fp, belief_id, evidence_ids, compartments, first_served_at, last_served_at, ended_at, reason, tainted_at)
     values ('mpr_${String(n).padStart(40, "0")}', '${id}', '{own}', 'active_memory@1', '${"a".repeat(63)}${n}', '${"b".repeat(63)}${n}', ${tainted ? "null" : `'blf_${"c".repeat(40)}'`}, '{}', '{own}', now(), now(), ${tainted ? "now(), 'withdrawn', now()" : "null, null, null"})`;
  await queryAs(
    s.db.urls.bootstrap,
    `set role pi_owner; ${row(1, false)}; ${row(2, true)};
    insert into ledger.memory_exposures (client_id, projection_id, first_served_at, recorded_at, retention, removal, compartments)
    values ('${id}', 'mpr_${String(2).padStart(40, "0")}', now(), now(), 'none', 'pending', '{own}')`,
  );
  return id;
}

describe("pi memory", () => {
  it("each memory command prints one JSON document of ids, names, counts, times and states", async () => {
    const s = await stack();
    const id = await served(s, "memory-agent");
    const status = await pi(["memory", "status"], ownerEnv(s));
    expect(status.exit).toBe(0);
    expect(status.stderr).toBe("");
    expect(status.stdout.endsWith("\n")).toBe(true);
    expect(status.stdout.trimEnd().split("\n")).toHaveLength(1);
    const view = MemoryStatusView.parse(JSON.parse(status.stdout));
    expect(view.clients).toEqual([
      {
        client: id,
        name: "memory-agent",
        status: "active",
        retention: "unknown",
        lastSyncAt: null,
        live: 1,
        unconfirmed: 1,
        endedNotAbsent: 0,
        exposures: { pending: 1, reported: 0, notPossible: 0 },
      },
    ]);
    const one = await pi(["memory", "status", "--client", "memory-agent"], ownerEnv(s));
    expect(JSON.parse(one.stdout)).toEqual(view);

    const exposures = await pi(["memory", "exposures", "--client", "memory-agent", "--limit", "1"], ownerEnv(s));
    expect(exposures.exit).toBe(0);
    expect(exposures.stdout.trimEnd().split("\n")).toHaveLength(1);
    const listed = MemoryExposureView.parse(JSON.parse(exposures.stdout));
    expect(listed).toEqual({
      exposures: [
        {
          id: expect.any(Number),
          client: id,
          name: "memory-agent",
          projection: `mpr_${"0".repeat(39)}2`,
          firstServedAt: expect.any(String),
          recordedAt: expect.any(String),
          retention: "none",
          removal: "pending",
          removalAt: null,
          firstRemoval: null,
          firstRemovalAt: null,
        },
      ],
      more: false,
    });
    // No word of the world: no address, no name, no subject.
    for (const output of [status.stdout, one.stdout, exposures.stdout]) {
      expect(output).not.toContain("@");
      for (const canary of s.canaries) expect(output).not.toContain(canary);
    }
    // An unknown client is not_found, and prints nothing.
    for (const argv of [
      ["memory", "status", "--client", "nobody"],
      ["memory", "exposures", "--client", "nobody"],
    ]) {
      const missing = await pi(argv, ownerEnv(s));
      expect({ exit: missing.exit, stdout: missing.stdout }).toEqual({ exit: 1, stdout: "" });
    }
  });

  it("memory imports and memory purge each print one JSON document with no text and no locator, and an unknown name exits 1 with not_found", async () => {
    const s = await stack();
    const id = await served(s, "memory-importer");
    // Import rows as policy.import_memory writes them, one of each mark, none with a record.
    await queryAs(
      s.db.urls.bootstrap,
      `set role pi_owner; insert into ledger.memory_imports (client_id, request_id, record_id, locator_fp, change, mark, matched_projection_ids, entry_time, created_at, compartments)
       select '${id}', 'memory-request-' || m, null, '${"d".repeat(64)}', 'removed', m, '{}', null, now(), '{own}' from unnest(array['new', 'echo', 'stale', 'refused']) as m`,
    );
    const imports = await pi(["memory", "imports", "--client", "memory-importer"], ownerEnv(s));
    expect(imports.exit).toBe(0);
    expect(imports.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(imports.stdout)).toEqual({
      clients: [
        {
          client: id,
          name: "memory-importer",
          marks: { new: 1, echo: 1, stale: 1, refused: 1 },
          latestAt: expect.any(String),
        },
      ],
    });
    expect(imports.stdout).not.toContain("d".repeat(64));
    const purge = await pi(["memory", "purge", "memory-importer"], ownerEnv(s));
    expect({ exit: purge.exit, stdout: purge.stdout }).toEqual({
      exit: 0,
      stdout: `${JSON.stringify({ removed: 0 })}\n`,
    });
    for (const argv of [
      ["memory", "imports", "--client", "nobody"],
      ["memory", "purge", "nobody"],
    ]) {
      const missing = await pi(argv, ownerEnv(s));
      expect({ exit: missing.exit, stdout: missing.stdout }).toEqual({ exit: 1, stdout: "" });
      expect(missing.stderr).toContain('"code":"not_found"');
    }
  });

  it("each memory command refuses to start with erasure_replay_needed when the journal is ahead of the database", async () => {
    const s = await stack();
    await served(s, "memory-behind");
    const [account] = await queryAs<{ id: string }>(
      s.db.urls.admin,
      "select id from vault.source_accounts where connector = 'google_mail' order by id limit 1",
    );
    await appendJournal(journalPath(s.db.keyFile), {
      seq: 1,
      erasure: "ers_01JABCDEFGHJKMNPQRSTVWXYZ0",
      kind: "item",
      items: [{ account: account?.id ?? "", fp: "a".repeat(64) }],
      suppress: [],
    } as unknown as ErasureJournalEntry);
    for (const argv of [
      ["memory", "status"],
      ["memory", "exposures"],
    ])
      expect(await pi(argv, ownerEnv(s))).toEqual({ exit: 1, stdout: "", stderr: REPLAY });
    expect((await pi(["erase", "replay"], ownerEnv(s))).exit).toBe(0);
    // The positive control: level again, both run.
    for (const argv of [
      ["memory", "status"],
      ["memory", "exposures"],
    ])
      expect((await pi(argv, ownerEnv(s))).exit).toBe(0);
  });
});
