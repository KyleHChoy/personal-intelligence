import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ErasureJournalEntry, ErasureReport, PersonalLogEvent } from "@intelligence/contracts/personal";
import type { GmailMessage, PersonalSource } from "@intelligence/personal-core/items";
import { fakeSources, world } from "@intelligence/personal-core/testing";
import { appendJournal, createWriter, journalPath, readJournal, type Writer } from "@intelligence/personal-store";
import {
  copiesOf,
  createTestDatabase,
  fingerprint,
  queryAs,
  type TestDatabase,
} from "@intelligence/personal-store/testing";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { runSync } from "../intake/sync.ts";
import { failed, pi as runPi } from "../test-support/run-pi.ts";

// The erasure's commands through `run`, in-process, on a database of their own and the synthetic
// world. Every key file is written by `pi keys init`, so each test has its own journal beside it.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const NOW = new Date("2026-06-15T12:00:00.000Z");
const HOUR = 3_600_000;

type Stack = {
  db: TestDatabase;
  writer: Writer;
  events: PersonalLogEvent[];
  sources: (PersonalSource & { gmail: { add(message: GmailMessage): void } })[];
  owner: string;
};
const stacks: Stack[] = [];

afterEach(async () => {
  for (const { db, writer } of stacks.splice(0)) {
    await writer.close();
    await db.drop();
  }
});

const pi = (argv: string[], env: Record<string, string>, tty = false) => runPi(argv, env, { tty });

// A database with the world synced into it, through a writer and the fakes. The file syncs the
// world once, and each test gets a copy of that database and its key file (copiesOf), with fresh
// fakes of the same world, which hold what the synced ones held.
let syncedFolder = "";
const synced = copiesOf(async () => {
  const folder = await mkdtemp(join(tmpdir(), "pi-erase-test-"));
  syncedFolder = folder;
  const keyFile = join(folder, "keys.json");
  expect((await pi(["keys", "init", "--compartments", "own,employer:example"], { PI_KEY_FILE: keyFile })).exit).toBe(0);
  const db = await createTestDatabase({ keyFile });
  const s = withWorld(db);
  try {
    await sync(s);
  } finally {
    await s.writer.close();
  }
  return db;
});
afterAll(async () => {
  await synced.drop();
  await rm(syncedFolder, { recursive: true, force: true });
});

function withWorld(db: TestDatabase): Stack {
  const events: PersonalLogEvent[] = [];
  const record = (event: PersonalLogEvent): void => void events.push(PersonalLogEvent.parse(event));
  const writer = createWriter({
    url: db.urls.writer,
    keys: db.keys,
    log: { info: record, warn: record, error: record },
  });
  const w = world({ now: NOW });
  return { db, writer, events, sources: fakeSources(w), owner: w.owner.addresses[0] ?? "" };
}

async function stack(): Promise<Stack> {
  const made = withWorld(await synced.copy());
  stacks.push(made);
  return made;
}

const sync = async (s: Stack, reset: ("gmail" | "calendar")[] = []) => {
  const result = await runSync({
    writer: s.writer,
    sources: s.sources,
    log: {
      info: (e) => void s.events.push(e),
      warn: (e) => void s.events.push(e),
      error: (e) => void s.events.push(e),
    },
    now: NOW,
    reset,
  });
  expect(result.outcomes.every((one) => one.outcome === "ok")).toBe(true);
  expect(result.refused).toBe(0);
  return result;
};

const ownerEnv = (s: Stack): Record<string, string> => ({
  PI_DATABASE_URL_ADMIN: s.db.urls.admin,
  PI_KEY_FILE: s.db.keyFile,
});
const rows = <Row>(s: Stack, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(s.db.urls.admin, text, values);
const REPLAY = failed("erasure_replay_needed", "run pi erase replay (pia on the box)");

// Every table's row count and the newest xmin of its rows: what a write would change. All but
// ledger.handles, which no runtime role, pi_admin included, reads, policy.capture_push_refusals, pi_owner's
// alone the same way and written by policy.push_capture alone, and policy.labels, pi_owner's alone and
// written only by the trigger on a labelled row's insert or relabelling: no erasure writes any of them. Nor
// ledger.owner_read_marks, pi_owner's alone: one row for each transaction that wrote a table the owner's
// graph reads, so a write that marks it shows in that table too.
async function state(s: Stack): Promise<string[]> {
  const tables = await rows<{ name: string }>(
    s,
    "select schemaname || '.' || tablename as name from pg_tables where schemaname in ('policy', 'vault', 'knowledge', 'projections', 'ledger') and not (schemaname = 'ledger' and tablename = 'handles') and not (schemaname = 'policy' and tablename = 'capture_push_refusals') and not (schemaname = 'policy' and tablename = 'labels') and not (schemaname = 'ledger' and tablename = 'owner_read_marks') order by 1",
  );
  const lines: string[] = [];
  for (const { name } of tables) {
    const [row] = await rows<{ n: number; x: string }>(
      s,
      `select count(*)::int as n, coalesce(max(xmin::text::bigint), 0)::text as x from ${name}`,
    );
    lines.push(`${name} ${row?.n} ${row?.x}`);
  }
  return lines;
}

// A message of the test's own, on reserved domains.
function message(id: string, from: string, to: string, hoursAgo: number): GmailMessage {
  const internalDate = NOW.getTime() - hoursAgo * HOUR;
  return {
    id,
    threadId: id,
    internalDate,
    labelIds: ["INBOX"],
    headers: [
      { name: "From", value: from },
      { name: "To", value: to },
      { name: "Date", value: new Date(internalDate - 60_000).toUTCString().replace("GMT", "+0000") },
      { name: "Subject", value: "An erasure test" },
      { name: "Message-ID", value: `<${id}@id.example.com>` },
    ],
  };
}

const IVO = "ivo.erasable@example.org";
const personal = (s: Stack) => {
  const source = s.sources[0];
  if (source === undefined) throw new Error("the world has two accounts");
  return source;
};
const anyMessage = async (s: Stack): Promise<string> =>
  (await rows<{ id: string }>(s, "select id from knowledge.messages order by id limit 1"))[0]?.id ?? "";
const personOf = async (s: Stack, address: string): Promise<string> =>
  (
    await rows<{ entity_id: string }>(s, "select entity_id from knowledge.accounts where value_fp = $1", [
      fingerprint(s.db.keys, "address", address),
    ])
  )[0]?.entity_id ?? "";

describe("pi erase", () => {
  it("erase item prints the report and nothing else", async () => {
    const s = await stack();
    const id = await anyMessage(s);
    const erased = await pi(["erase", "item", id], ownerEnv(s));
    expect(erased.exit).toBe(0);
    expect(erased.stderr).toBe("");
    const lines = erased.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const report = ErasureReport.parse(JSON.parse(lines[0] ?? ""));
    expect(report).toMatchObject({ items: 1, people: 0, suppressed: 0, more: {} });
    expect(await rows(s, "select id from knowledge.messages where id = $1", [id])).toEqual([]);
    // A usage error for an id that is no message or event id.
    expect((await pi(["erase", "item", "ent_01JABCDEFGHJKMNPQRSTVWXYZ0"], ownerEnv(s))).exit).toBe(2);
  });

  it("erase person with --dry-run changes no row", async () => {
    const s = await stack();
    const person =
      (
        await rows<{ entity_id: string }>(
          s,
          "select entity_id from knowledge.interaction_log where entity_role = 'sender' order by entity_id limit 1",
        )
      )[0]?.entity_id ?? "";
    const before = await state(s);
    const dry = await pi(["erase", "person", person, "--dry-run"], ownerEnv(s));
    expect(dry.exit).toBe(0);
    const report = ErasureReport.parse(JSON.parse(dry.stdout));
    expect(report.erasure).toBeNull();
    expect(report.people).toBe(1);
    expect(report.items).toBeGreaterThan(0);
    expect(await state(s)).toEqual(before);
    expect(await readJournal(journalPath(s.db.keyFile))).toEqual({ entries: [], seq: 0 });
  });

  it("erase list shows no content", async () => {
    const s = await stack();
    personal(s).gmail.add(message("19e0000000000001", `Ivo Erasable <${IVO}>`, s.owner, 20));
    await sync(s);
    const erased = ErasureReport.parse(
      JSON.parse((await pi(["erase", "person", await personOf(s, IVO)], ownerEnv(s))).stdout),
    );
    const listed = await pi(["erase", "list"], ownerEnv(s));
    expect(listed.exit).toBe(0);
    const views = JSON.parse(listed.stdout) as Record<string, unknown>[];
    expect(views).toEqual([
      {
        id: erased.erasure,
        kind: "person",
        erasedAt: expect.any(String),
        liftedAt: null,
        items: 1,
        suppressed: 1,
        exposedClients: 0,
      },
    ]);
    expect(listed.stdout).not.toMatch(/ivo|erasable|@/i);
    // The lift prints nothing, and the list then shows it lifted.
    expect(await pi(["erase", "lift", String(erased.erasure)], ownerEnv(s))).toEqual({
      exit: 0,
      stdout: "",
      stderr: "",
    });
    expect(
      (JSON.parse((await pi(["erase", "list"], ownerEnv(s))).stdout) as { liftedAt: string | null }[])[0]?.liftedAt,
    ).toEqual(expect.any(String));
    expect((await pi(["erase", "lift", String(erased.erasure)], ownerEnv(s))).exit).toBe(1);
  });

  it("sync, mcp and erase list refuse while the journal is ahead, and status and erase replay still run (review is tested in-process)", async () => {
    const s = await stack();
    const [account] = await rows<{ id: string }>(
      s,
      "select id from vault.source_accounts where connector = 'google_mail' order by id limit 1",
    );
    // A journal entry the database lacks: the store after a restore.
    await appendJournal(journalPath(s.db.keyFile), {
      seq: 1,
      erasure: "ers_01JABCDEFGHJKMNPQRSTVWXYZ0",
      kind: "item",
      items: [{ account: account?.id ?? "", fp: "a".repeat(64) }],
      suppress: [],
    } as unknown as ErasureJournalEntry);

    expect(await pi(["sync"], { PI_DATABASE_URL_WRITER: s.db.urls.writer, PI_KEY_FILE: s.db.keyFile })).toEqual({
      exit: 1,
      stdout: "",
      stderr: REPLAY,
    });
    expect(await pi(["mcp"], { PI_DATABASE_URL_READER: s.db.urls.reader, PI_KEY_FILE: s.db.keyFile })).toEqual({
      exit: 1,
      stdout: "",
      stderr: REPLAY,
    });
    expect(await pi(["erase", "list"], ownerEnv(s))).toEqual({ exit: 1, stdout: "", stderr: REPLAY });
    expect(await pi(["clients", "list"], ownerEnv(s))).toEqual({ exit: 1, stdout: "", stderr: REPLAY });
    expect((await pi(["review"], ownerEnv(s), true)).exit).toBe(1);

    expect((await pi(["status"], ownerEnv(s))).exit).toBe(0);
    expect(await pi(["erase", "replay"], ownerEnv(s))).toEqual({
      exit: 0,
      stdout: `${JSON.stringify({ applied: 1, journalled: 0 })}\n`,
      stderr: "",
    });
    // The positive control: level again, every command runs.
    expect((await pi(["erase", "list"], ownerEnv(s))).exit).toBe(0);
    expect((await pi(["clients", "list"], ownerEnv(s))).exit).toBe(0);
  });

  it("an item not stored because it was erased, or because its sender is suppressed, is counted in items_not_stored under removed or suppressed, and the run exits 0", async () => {
    const s = await stack();
    const id = await anyMessage(s);
    const [mail] = await rows<{ source_account_id: string }>(
      s,
      "select e.source_account_id from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where m.id = $1",
      [id],
    );
    expect((await pi(["erase", "item", id], ownerEnv(s))).exit).toBe(0);
    // A full listing hands the erased message over again.
    s.events.length = 0;
    await sync(s, ["gmail"]);
    const notStored = (account: string | undefined) =>
      s.events.filter((one) => one.event === "items_not_stored" && one.ids?.account === account);
    expect(notStored(mail?.source_account_id)).toEqual([
      {
        event: "items_not_stored",
        ids: { account: mail?.source_account_id },
        counts: { junk: expect.any(Number), category: expect.any(Number), removed: 1 },
      },
    ]);

    personal(s).gmail.add(message("19e0000000000002", `Ivo Erasable <${IVO}>`, s.owner, 20));
    await sync(s);
    expect((await pi(["erase", "person", await personOf(s, IVO)], ownerEnv(s))).exit).toBe(0);
    personal(s).gmail.add(message("19e0000000000003", `Ivo Erasable <${IVO}>`, s.owner, 10));
    s.events.length = 0;
    await sync(s);
    const [ivoAccount] = await rows<{ id: string }>(
      s,
      "select id from vault.source_accounts where label = 'personal' and connector = 'google_mail'",
    );
    expect(notStored(ivoAccount?.id)).toEqual([
      { event: "items_not_stored", ids: { account: ivoAccount?.id }, counts: { junk: 0, category: 0, suppressed: 1 } },
    ]);
    expect(await personOf(s, IVO)).toBe("");
  });

  it("erase replay on a store with no erasure and no journal creates the empty journal", async () => {
    const s = await stack();
    const journal = journalPath(s.db.keyFile);
    await expect(stat(journal)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await pi(["erase", "replay"], ownerEnv(s))).toEqual({
      exit: 0,
      stdout: `${JSON.stringify({ applied: 0, journalled: 0 })}\n`,
      stderr: "",
    });
    expect((await stat(journal)).mode & 0o777).toBe(0o600);
    expect(await readJournal(journal, { mustExist: true })).toEqual({ entries: [], seq: 0 });
  });
});
