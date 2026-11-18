import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ErasureJournalEntry, PersonalLogEvent } from "@intelligence/contracts/personal";
import { fakeSources, type World, world } from "@intelligence/personal-core/testing";
import {
  appendJournal,
  createAdmin,
  createWriter,
  googleSecretName,
  journalPath,
  type Writer,
} from "@intelligence/personal-store";
import {
  copiesOf,
  createTestDatabase,
  fingerprint,
  queryAs,
  type TestDatabase,
} from "@intelligence/personal-store/testing";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { runSync } from "../intake/sync.ts";
import { failed, pi } from "../test-support/run-pi.ts";

// Contacts and identity, n6.3: `pi identity ...` and `pi contacts remove` through `run`,
// in-process, on a database of their own with the synthetic world synced into it, the personal
// label's contacts on. Every key file is written by `pi keys init`, so each test has its own
// erasure journal beside it.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const NOW = new Date("2026-06-15T12:00:00.000Z");

type Stack = { db: TestDatabase; writer: Writer; events: PersonalLogEvent[]; w: World };
const stacks: Stack[] = [];

afterEach(async () => {
  for (const { db, writer } of stacks.splice(0)) {
    await writer.close();
    await db.drop();
  }
});

const ownerEnv = (s: Stack): Record<string, string> => ({
  PI_DATABASE_URL_ADMIN: s.db.urls.admin,
  PI_KEY_FILE: s.db.keyFile,
});
const json = (stdout: string): unknown => JSON.parse(stdout);
const rows = <Row>(s: Stack, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(s.db.urls.admin, text, values);

// A database with the world synced into it, the personal label's contacts on. The file syncs the
// world once, and each test gets a copy of that database and its key file (copiesOf).
let syncedFolder = "";
const synced = copiesOf(async () => {
  const folder = await mkdtemp(join(tmpdir(), "pi-identity-test-"));
  syncedFolder = folder;
  const keyFile = join(folder, "keys.json");
  expect((await pi(["keys", "init", "--compartments", "own,employer:example"], { PI_KEY_FILE: keyFile })).exit).toBe(0);
  const db = await createTestDatabase({ keyFile });
  const log = { info() {}, warn() {}, error() {} };
  const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log });
  try {
    await admin.secrets.setSecret(googleSecretName("personal", "contacts_refresh_token"), "sentinel-contacts-token");
  } finally {
    await admin.close();
  }
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log });
  try {
    const result = await runSync({
      writer,
      sources: fakeSources(world({ now: NOW }), { contacts: ["personal"] }),
      log,
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
  const events: PersonalLogEvent[] = [];
  const record = (event: PersonalLogEvent): void => void events.push(PersonalLogEvent.parse(event));
  const made = {
    db,
    writer: createWriter({ url: db.urls.writer, keys: db.keys, log: { info: record, warn: record, error: record } }),
    events,
    w: world({ now: NOW }),
  };
  stacks.push(made);
  return made;
}

// The person that holds an address.
async function personOf(s: Stack, address: string): Promise<string> {
  const [found] = await rows<{ id: string }>(
    s,
    "select distinct e.id from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where a.value_fp = $1 and e.kind = 'person'",
    [fingerprint(s.db.keys, "address", address)],
  );
  if (found === undefined) throw new Error("no person holds the address");
  return found.id;
}

// What a command printed holds no address and no name of the world's.
function noContent(s: Stack, printed: string): void {
  for (const value of [...s.w.handles.samAddresses, s.w.handles.sharedContactAddress, "Sam Orrin", "Odile Brandt"])
    expect(printed).not.toContain(value);
}

const RULING = /^rul_[0-9A-Z]{26}$/;

describe("pi identity", () => {
  it("link prints a ruling id and no content", async () => {
    const s = await stack();
    const [a, b] = await Promise.all(s.w.handles.samAddresses.map((one) => personOf(s, one)));
    const linked = await pi(["identity", "link", a ?? "", b ?? ""], ownerEnv(s));
    expect(linked).toMatchObject({ exit: 0, stderr: "" });
    expect(json(linked.stdout)).toEqual({ ruling: expect.stringMatching(RULING) });
    noContent(s, linked.stdout);
    expect(await rows(s, "select verdict from knowledge.identity_rulings")).toEqual([{ verdict: "same" }]);
  });

  it("link on a joined pair prints already_settled and the ruling id", async () => {
    const s = await stack();
    const [a, b] = await Promise.all(s.w.handles.samAddresses.map((one) => personOf(s, one)));
    const { ruling } = json((await pi(["identity", "link", a ?? "", b ?? ""], ownerEnv(s))).stdout) as {
      ruling: string;
    };
    // The same pair again, either way round: nothing written.
    for (const pair of [
      [a, b],
      [b, a],
    ]) {
      const again = await pi(["identity", "link", pair[0] ?? "", pair[1] ?? ""], ownerEnv(s));
      expect(again).toEqual({
        exit: 0,
        stdout: `${JSON.stringify({ code: "already_settled", rulings: [ruling] })}\n`,
        stderr: "",
      });
    }
    expect(await rows(s, "select count(*)::int as n from knowledge.identity_rulings")).toEqual([{ n: 1 }]);
  });

  it("differ, share and lift print what they wrote, and list the rulings in force and lifted", async () => {
    const s = await stack();
    const env = ownerEnv(s);
    const boss = await personOf(s, s.w.handles.bossAddress);
    const assistant = await personOf(s, s.w.handles.assistantAddress);
    const shared = await personOf(s, s.w.handles.sharedContactAddress);
    const [a, b] = await Promise.all(s.w.handles.samAddresses.map((one) => personOf(s, one)));

    const differ = await pi(["identity", "differ", boss, assistant], env);
    expect(differ).toMatchObject({ exit: 0, stderr: "" });
    const { ruling: different } = json(differ.stdout) as { ruling: string };
    const share = await pi(["identity", "share", shared], env);
    const { ruling: marked } = json(share.stdout) as { ruling: string };
    // Marked again: nothing written, and the ruling that marks it printed, as link prints.
    expect(await pi(["identity", "share", shared], env)).toEqual({
      exit: 0,
      stdout: `${JSON.stringify({ code: "already_settled", rulings: [marked] })}\n`,
      stderr: "",
    });
    const { ruling: same } = json((await pi(["identity", "link", a ?? "", b ?? ""], env)).stdout) as { ruling: string };
    for (const one of [different, marked, same]) expect(one).toMatch(RULING);

    const lift = await pi(["identity", "lift", same], env);
    expect(lift).toEqual({ exit: 0, stdout: `${JSON.stringify({ lifted: same })}\n`, stderr: "" });
    // Lifted already, and an id that is no ruling: not found.
    expect(await pi(["identity", "lift", same], env)).toEqual({ exit: 1, stdout: "", stderr: failed("not_found") });

    const listed = await pi(["identity", "list"], env);
    expect(listed).toMatchObject({ exit: 0, stderr: "" });
    noContent(s, listed.stdout);
    expect(json(listed.stdout)).toEqual([
      {
        id: different,
        verdict: "different",
        a: expect.any(String),
        b: expect.any(String),
        at: expect.any(String),
        liftedAt: null,
        by: "owner",
      },
      { id: marked, verdict: "shared", a: shared, b: null, at: expect.any(String), liftedAt: null, by: "owner" },
      {
        id: same,
        verdict: "same",
        a: expect.any(String),
        b: expect.any(String),
        at: expect.any(String),
        liftedAt: expect.any(String),
        by: "owner",
      },
    ]);
    // A same across the different is refused, and writes nothing.
    expect(await pi(["identity", "link", boss, assistant], env)).toEqual({
      exit: 1,
      stdout: "",
      stderr: failed("conflicting_ruling"),
    });
    expect(await rows(s, "select count(*)::int as n from knowledge.identity_rulings")).toEqual([{ n: 3 }]);
  });

  it("sweep prints its three counts and the dream merges' counts, and exits 1 with sync_running while a sync runs", async () => {
    const s = await stack();
    const env = ownerEnv(s);
    // While the sync lock is held: refused, and nothing written.
    const held = await s.writer.withSyncLock(() => pi(["identity", "sweep"], env));
    expect(held).toEqual({
      exit: 1,
      stdout: "",
      stderr: failed("sync_running", "a sync is running; hold it with the sync-hold file and try again"),
    });
    expect(await rows(s, "select count(*)::int as n from ledger.cards")).toEqual([{ n: 0 }]);

    const swept = await pi(["identity", "sweep"], env);
    expect(swept).toMatchObject({ exit: 0 });
    const counts = json(swept.stdout) as { candidates: number; raised: number; skipped: number; dream: unknown };
    expect(Object.keys(counts).sort()).toEqual(["candidates", "dream", "raised", "skipped"]);
    // No dream pass ran, so the dream merges settled nothing.
    expect(counts.dream).toEqual({ judges: 0, merged: 0, refused: 0, lifted: 0, paused: false });
    expect(counts.raised).toBeGreaterThan(0);
    expect(await rows(s, "select count(*)::int as n from ledger.cards")).toEqual([{ n: counts.raised }]);
    noContent(s, swept.stdout + swept.stderr);
  });

  it("each identity command, the sweep and contacts remove exit 1 with erasure_replay_needed when the journal is ahead", async () => {
    const s = await stack();
    const env = ownerEnv(s);
    const [a, b] = await Promise.all(s.w.handles.samAddresses.map((one) => personOf(s, one)));
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
    const ruling = `rul_${"0".repeat(25)}1`;
    const replay = {
      exit: 1,
      stdout: "",
      stderr: failed("erasure_replay_needed", "run pi erase replay (pia on the box)"),
    };
    for (const argv of [
      ["identity", "link", a ?? "", b ?? ""],
      ["identity", "differ", a ?? "", b ?? ""],
      ["identity", "share", a ?? ""],
      ["identity", "list"],
      ["identity", "lift", ruling],
      ["identity", "sweep"],
      ["contacts", "remove", "personal"],
    ]) {
      expect(await pi(argv, env), argv.join(" ")).toEqual(replay);
    }
    expect(await rows(s, "select count(*)::int as n from knowledge.identity_rulings")).toEqual([{ n: 0 }]);
    // The positive control: once replayed, the same commands run.
    expect((await pi(["erase", "replay"], env)).exit).toBe(0);
    expect((await pi(["identity", "list"], env)).exit).toBe(0);
  });

  it("contacts remove is refused while the label's contacts token exists", async () => {
    const s = await stack();
    const env = ownerEnv(s);
    const stored = await rows<{ n: number }>(s, "select count(*)::int as n from knowledge.contacts");
    expect(stored[0]?.n).toBeGreaterThan(0);
    expect(await pi(["contacts", "remove", "personal"], env)).toEqual({
      exit: 1,
      stdout: "",
      stderr: failed("contacts_connected", "run pi google disconnect LABEL --contacts first (pia on the box)"),
    });
    expect(await rows(s, "select count(*)::int as n from knowledge.contacts")).toEqual(stored);

    // Disconnected: removed, with their count, and every ruling left as it was.
    const [a, b] = await Promise.all(s.w.handles.samAddresses.map((one) => personOf(s, one)));
    expect((await pi(["identity", "link", a ?? "", b ?? ""], env)).exit).toBe(0);
    expect((await pi(["google", "disconnect", "personal", "--contacts"], env)).exit).toBe(0);
    expect(await pi(["contacts", "remove", "personal"], env)).toEqual({
      exit: 0,
      stdout: `${JSON.stringify({ items: stored[0]?.n })}\n`,
      stderr: "",
    });
    expect(await rows(s, "select count(*)::int as n from knowledge.contacts")).toEqual([{ n: 0 }]);
    expect(await rows(s, "select count(*)::int as n from knowledge.identity_rulings")).toEqual([{ n: 1 }]);
  });
});
