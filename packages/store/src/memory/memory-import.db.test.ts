import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ClientName,
  type EntityId,
  type ImportMemoryArgs,
  type MemoryChange,
  MemoryProjection,
  type SyncMemoryArgs,
} from "@intelligence/contracts/personal";
import { sha256 } from "@intelligence/personal-core";
import { entryLine, renderEntry } from "@intelligence/personal-core/views";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { sealUnder } from "../core/seal.ts";
import { Reader } from "../read/read.ts";
import { type Accounts, connect, OWNER, QUENTIN, RHEA, SOLO } from "../test-support/cast.ts";
import { testId } from "../test-support/clients.ts";
import { closeSaidClosed } from "../test-support/commitment-fixtures.ts";
import { one, readAs } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { ingestMail, mail, mailSourceId } from "../test-support/items.ts";
import { knownBy } from "../test-support/known-by.ts";
import {
  commitmentOnMail,
  type MailCommitment,
  MEMORY_FIXTURE_NOW,
  projectionOf,
} from "../test-support/memory-fixtures.ts";
import { recordingPool } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue, refusedWith, registration } from "../test-support/values.ts";

// Reader.importMemory, the marks at the call and again at intake, the time rule, and what a memory change yields. Projections are served
// through Reader.syncMemory first, and every stamped line is one renderEntry really issued. Each client is registered through the Admin with
// record and import_memory, so it holds its own `agent:` compartment.

const CLIENTS = ["alpha", "beta", "gamma", "revoked", "busy", "plain"];
const TOOLS = ["get_self", "find_facts", "build_context_pack", "sync_memory", "record", "import_memory"] as const;

type Client = { name: ClientName; token: string; id: string; audience: string[] };
type World = {
  store: TestStore;
  accounts: Accounts;
  admin: Admin;
  reader: Reader;
  owner: string;
  journal: string;
  dir: string;
};

let w: World;
let made: MailCommitment[] = [];
let requests = 0;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-memory-import-"));
  const store = await openStore({
    compartments: ["own", "employer:example", ...CLIENTS.map((name) => `agent:${name}`)],
  });
  const journal = join(dir, "keys.json.erasures");
  const accounts = await connect(store.writer);
  const admin = new Admin({ pool: store.adminPool, keys: store.db.keys, log: store.log, journal, recordEnabled: true });
  const reader = new Reader({
    pool: store.readerPool,
    keys: store.db.keys,
    log: store.log,
    now: () => MEMORY_FIXTURE_NOW,
  });
  const owner = one(
    await queryAs<{ id: string }>(store.db.urls.admin, "select id from knowledge.entities where kind = 'owner'"),
  ).id;
  w = { store, accounts, admin, reader, owner, journal, dir };
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await w.store.close();
  await rm(w.dir, { recursive: true, force: true });
});

async function client(name: string, tools: readonly string[] = TOOLS): Promise<Client> {
  const { token } = await w.admin.clients.addClient(
    registration(name, ["own"], { tools: [...tools] as never, views: ["self", "people", "work"] }),
  );
  const id = (await w.admin.clients.listClients()).find((row) => row.name === name)?.id;
  if (id === undefined) throw new Error(`no client ${name}`);
  return { name: name as ClientName, token, id, audience: [`agent:${name}`, "own"] };
}

// A commitment on a new message, its beliefs written for each client's audience, every earlier
// one kept, so a sync serves it.
async function commitment(id: string, audiences: string[][], from = QUENTIN): Promise<MailCommitment> {
  const one = await commitmentOnMail(w.store, w.accounts.personalMail, w.owner, id, { from, keep: made, audiences });
  // Its claims known by the reader's pinned date, so a sync computes it.
  await knownBy(w.store.db, MEMORY_FIXTURE_NOW);
  made = [...made, one];
  return one;
}

const sync = async (token: string, args: SyncMemoryArgs = { have: [], canDelete: true }): Promise<MemoryProjection> =>
  MemoryProjection.parse(outcomeValue(await w.reader.syncMemory(token, args)));
const entryOf = (projection: MemoryProjection, fact: string) => {
  const found = projection.entries.find((entry) => entry.stamp.fact === fact);
  if (found === undefined) throw new Error("no entry for the fact");
  return found;
};

const requestId = (): string => {
  requests += 1;
  return `memory-import-${String(requests).padStart(8, "0")}`;
};
const added = (body: string, over: Partial<MemoryChange> = {}): MemoryChange => ({
  requestId: requestId(),
  locator: `/home/agent/memory/MEMORY.md#${testId("e")}`,
  change: "added",
  body,
  ...over,
});
const imported = async (token: string, changes: MemoryChange[], reader = w.reader) =>
  reader.importMemory(token, { changes } as ImportMemoryArgs);

type ImportRow = {
  request_id: string;
  record_id: string | null;
  mark: string;
  change: string;
  matched_projection_ids: string[];
  entry_time: Date | null;
  compartments: string[];
};
const importRow = async (request: string): Promise<ImportRow> =>
  one(
    await queryAs<ImportRow>(
      w.store.db.urls.admin,
      "select request_id, record_id, mark, change, matched_projection_ids, entry_time, compartments from ledger.memory_imports where request_id = $1",
      [request],
    ),
  );
type RecordRow = {
  id: string;
  kind: string;
  body: boolean;
  evidence_id: string | null;
  compartments: string[];
  created_at: Date;
};
const recordRow = async (id: string): Promise<RecordRow> =>
  one(
    await queryAs<RecordRow>(
      w.store.db.urls.admin,
      "select id, kind, body_enc is not null as body, evidence_id, compartments, created_at from ledger.agent_writes where id = $1",
      [id],
    ),
  );
const take = () => w.store.writer.takeRecords();

describe("import_memory at registration", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("a registration may list import_memory beside record, and not without it", async () => {
    const invalid = { name: "AdminError", code: "invalid_registration" };
    expect(
      await refusedWith(() =>
        w.admin.clients.addClient(registration("plain", ["own"], { tools: ["get_self", "import_memory"] })),
      ),
    ).toEqual(invalid);
    await client("plain", ["get_self", "record", "import_memory"]);
    expect((await w.admin.clients.listClients()).find((row) => row.name === "plain")?.tools).toEqual([
      "get_self",
      "record",
      "import_memory",
    ]);
  });
});

describe("the call", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let alpha: Client;
  let live: MailCommitment;
  let line: string;
  let stamped: string;

  beforeAll(async () => {
    alpha = await client("alpha");
    live = await commitment("import-live", [alpha.audience]);
    const entry = entryOf(await sync(alpha.token), live.fact);
    stamped = renderEntry(entry);
    line = stamped.replace(/ \[pi:[^\]]+\]$/, "");
  }, SLOW_DB_TEST_TIMEOUT);

  it("sync_memory writes each served row's line_fp", async () => {
    const entry = entryOf(await sync(alpha.token), live.fact);
    expect((await projectionOf(w.store.db, entry.stamp.projection)) as unknown as { line_fp: string }).toMatchObject({
      line_fp: fingerprint(w.store.db.keys, "memory_line", entryLine(renderEntry(entry))),
    });
  });

  it("the label is record_label() for every change, and R42: a stamped line of a live projection is marked echo with its projection kept", async () => {
    const change = added(`Notes from the session.\n${stamped}`);
    expect(outcomeValue(await imported(alpha.token, [change]))).toEqual({ received: 1 });
    const row = await importRow(change.requestId);
    const projection = entryOf(await sync(alpha.token), live.fact).stamp.projection;
    expect(row).toMatchObject({
      mark: "echo",
      change: "added",
      matched_projection_ids: [projection],
      compartments: alpha.audience,
    });
    expect(await recordRow(row.record_id as string)).toMatchObject({
      kind: "memory_change",
      body: true,
      evidence_id: null,
      compartments: alpha.audience,
    });
    // The same line without its stamp matches by its line fingerprint.
    const unstamped = added(`* ${line.replace(/^- /, "")}`);
    await imported(alpha.token, [unstamped]);
    expect(await importRow(unstamped.requestId)).toMatchObject({ mark: "echo", matched_projection_ids: [projection] });
    // A line of nothing served is new.
    const fresh = added("The owner keeps a vegetable garden.");
    await imported(alpha.token, [fresh]);
    expect(await importRow(fresh.requestId)).toMatchObject({ mark: "new", matched_projection_ids: [] });
  });

  it("the answer, the calls row and the statements are the same for a stored, a replayed and a refused change", async () => {
    const recorded = recordingPool(w.store.readerPool);
    const reader = new Reader({
      pool: recorded.pool,
      keys: w.store.db.keys,
      log: w.store.log,
      now: () => MEMORY_FIXTURE_NOW,
    });
    const tainted = await commitment("import-tainted", [alpha.audience], RHEA);
    const taintedEntry = entryOf(await sync(alpha.token), tainted.fact);
    await w.store.writer.applyDeletion(w.accounts.personalMail, {
      sourceAccount: w.accounts.personalMail.id,
      sourceItemId: mailSourceId(tainted.fixture),
      deletedAt: "2026-09-03T00:00:00Z",
    });
    expect((await projectionOf(w.store.db, taintedEntry.stamp.projection)).tainted_at).not.toBeNull();

    // The reader's first call of a client opens its session: made before the three compared.
    await imported(alpha.token, [{ requestId: requestId(), locator: "/m/warm", change: "removed" }], reader);
    const stored = added("A fresh line the store has never served.");
    const outcomes: { answer: unknown; statements: string[]; call: unknown }[] = [];
    for (const change of [stored, stored, added(`Kept from before: ${renderEntry(taintedEntry)}`)]) {
      recorded.statements.length = 0;
      const answer = await imported(alpha.token, [change], reader);
      const [call] = await queryAs<{ tool: string; rows: number; outcome: string }>(
        w.store.db.urls.admin,
        "select tool, rows, outcome from policy.calls where client_id = $1 order by id desc limit 1",
        [alpha.id],
      );
      outcomes.push({ answer, statements: recorded.statements.map((text) => text.replace(/\s+/g, " ")), call });
    }
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[2]).toEqual(outcomes[0]);
    expect(outcomes[0]?.answer).toEqual({ ok: true, value: { received: 1 } });
    expect(outcomes[0]?.call).toEqual({ tool: "import_memory", rows: 1, outcome: "ok" });
    // The refused one has its import row and no record.
    const [refused] = await queryAs<ImportRow>(
      w.store.db.urls.admin,
      "select mark, record_id from ledger.memory_imports where client_id = $1 order by id desc limit 1",
      [alpha.id],
    );
    expect(refused).toMatchObject({ mark: "refused", record_id: null });
  });

  it("a revoked client's import answers unauthorized and writes no row", async () => {
    const revoked = await client("revoked");
    await w.admin.clients.revokeClient("revoked");
    const before = one(
      await queryAs<{ n: number }>(
        w.store.db.urls.admin,
        "select (select count(*) from ledger.memory_imports) + (select count(*) from ledger.agent_writes) as n",
      ),
    ).n;
    expect(await imported(revoked.token, [added("anything")])).toEqual({ ok: false, code: "unauthorized" });
    expect(
      one(
        await queryAs<{ n: number }>(
          w.store.db.urls.admin,
          "select (select count(*) from ledger.memory_imports) + (select count(*) from ledger.agent_writes) as n",
        ),
      ).n,
    ).toBe(before);
  });

  it("a client without import_memory is not_permitted, and a batch that repeats a request id is invalid_request", async () => {
    const plain = await client("gamma", ["get_self", "record"]);
    expect(await imported(plain.token, [added("anything")])).toEqual({ ok: false, code: "not_permitted" });
    const twice = added("twice");
    expect(await imported(alpha.token, [twice, { ...twice }])).toEqual({ ok: false, code: "invalid_request" });
    expect(
      await queryAs(w.store.db.urls.admin, "select 1 from ledger.memory_imports where request_id = $1", [
        twice.requestId,
      ]),
    ).toEqual([]);
  });

  it("kept: the 501st memory change in 24 hours is rate_limited", async () => {
    const busy = await client("busy");
    const removed = (): MemoryChange => ({ requestId: requestId(), locator: `/m/${testId("l")}`, change: "removed" });
    for (let batch = 0; batch < 10; batch += 1)
      expect(outcomeValue(await imported(busy.token, Array.from({ length: 50 }, removed)))).toEqual({ received: 50 });
    expect(await imported(busy.token, [removed()])).toEqual({ ok: false, code: "rate_limited" });
    // record is counted apart: the busy adapter does not lock its agent out.
    expect((await w.reader.record(busy.token, { kind: "note", body: "still writes", requestId: requestId() })).ok).toBe(
      true,
    );
  });
});

describe("intake", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let beta: Client;
  let live: MailCommitment;
  let liveEntry: ReturnType<typeof entryOf>;

  beforeAll(async () => {
    beta = await client("beta");
    live = await commitment("intake-live", [beta.audience], SOLO);
    liveEntry = entryOf(await sync(beta.token), live.fact);
  }, SLOW_DB_TEST_TIMEOUT);

  it("a memory change's evidence observed_at is the matched projection's first_served_at when that is earlier than its entryTime, and never later than its receipt", async () => {
    const firstServed = (await projectionOf(w.store.db, liveEntry.stamp.projection)).first_served_at;
    // An entryTime after the first serving, and before the receipt: the first serving is earlier.
    const echo = added(renderEntry(liveEntry), { entryTime: new Date(firstServed.getTime() + 1).toISOString() });
    const future = added("A line from the future.", { entryTime: "2099-01-01T00:00:00Z" });
    const earlier = added("A line first seen long ago.", { entryTime: "2020-01-01T00:00:00Z" });
    await imported(beta.token, [echo, future, earlier]);
    await take();
    const observed = async (request: string): Promise<{ observed_at: Date; created_at: Date; item: string }> => {
      const row = await importRow(request);
      return one(
        await queryAs<{ observed_at: Date; created_at: Date; item: string }>(
          w.store.db.urls.admin,
          "select e.observed_at, w.created_at, e.source_kind as item from ledger.agent_writes w join vault.evidence_items e on e.id = w.evidence_id where w.id = $1",
          [row.record_id],
        ),
      );
    };
    const echoed = await observed(echo.requestId);
    expect(echoed.observed_at).toEqual(firstServed);
    expect(echoed.item).toBe("agent_record");
    const late = await observed(future.requestId);
    expect(late.observed_at).toEqual(late.created_at);
    expect((await observed(earlier.requestId)).observed_at).toEqual(new Date("2020-01-01T00:00:00Z"));
    // The marks intake made stand on the import rows.
    expect((await importRow(echo.requestId)).mark).toBe("echo");
    expect((await importRow(future.requestId)).mark).toBe("new");
  });

  it("a row appended through raw SQL with a tainted line and no fingerprints is refused at intake", async () => {
    const tainted = await commitment("intake-tainted", [beta.audience], RHEA);
    const entry = entryOf(await sync(beta.token), tainted.fact);
    await w.store.writer.applyDeletion(w.accounts.personalMail, {
      sourceAccount: w.accounts.personalMail.id,
      sourceItemId: mailSourceId(tainted.fixture),
      deletedAt: "2026-09-03T00:00:00Z",
    });
    // The tainted line without its stamp, through the function with no stamp and no line
    // fingerprint: the write marks it new, and intake finds the line from the body.
    const body = renderEntry(entry).replace(/ \[pi:[^\]]+\]$/, "");
    const recordId = testId("rec");
    const request = requestId();
    const label = beta.audience;
    await readAs(w.store.db, beta.token, async (query) => {
      const session = testId("ses");
      await query("select policy.open_session($1)", [session]);
      const change = {
        request_id: request,
        locator_fp: "a".repeat(64),
        change: "added",
        entry_time: null,
        stamps: [],
        line_fps: [],
        record_id: recordId,
        content_fp: fingerprint(w.store.db.keys, "content_hash", sha256(body)),
        cites_fp: fingerprint(w.store.db.keys, "cites", ""),
        body_enc: sealUnder(
          w.store.db.keys,
          label,
          { table: "ledger.agent_writes", id: recordId, column: "body_enc" },
          body,
        ),
      };
      expect(
        one(
          await query<{ outcome: string }>("select outcome from policy.import_memory($1, $2::jsonb, $3)", [
            session,
            JSON.stringify([change]),
            label,
          ]),
        ).outcome,
      ).toBe("ok");
    });
    expect(await importRow(request)).toMatchObject({ mark: "new", record_id: recordId });
    await take();
    expect(await recordRow(recordId)).toMatchObject({ body: false, evidence_id: null });
    expect(await importRow(request)).toMatchObject({ mark: "refused", record_id: null });
  });

  it("a change naming a suppressed address is stored at the call and refused at intake: no body, no evidence row, no blob", async () => {
    await suppress("suppressed.person@example.org");
    const named = added("Write to Suppressed.Person@example.org about the lease.");
    const none = added("Write to someone.else@example.org about the lease.");
    const counts = async () =>
      one(
        await queryAs<{ imports: number; records: number }>(
          w.store.db.urls.admin,
          "select (select count(*) from ledger.memory_imports)::int as imports, (select count(*) from ledger.agent_writes)::int as records",
        ),
      );
    const before = await counts();
    await imported(beta.token, [named]);
    const between = await counts();
    await imported(beta.token, [none]);
    const after = await counts();
    expect([between.imports - before.imports, between.records - before.records]).toEqual([
      after.imports - between.imports,
      after.records - between.records,
    ]);
    const stored = await importRow(named.requestId);
    expect(stored).toMatchObject({ mark: "new" });
    await take();
    expect(await recordRow(stored.record_id as string)).toMatchObject({ body: false, evidence_id: null });
    expect(await importRow(named.requestId)).toMatchObject({ mark: "refused", record_id: null });
    expect(
      await queryAs(w.store.db.urls.admin, "select 1 from vault.evidence_items where source_item_fp = $1", [
        fingerprint(w.store.db.keys, "source_id", `record:${stored.record_id}`),
      ]),
    ).toEqual([]);
    const kept = await importRow(none.requestId);
    expect((await recordRow(kept.record_id as string)).evidence_id).not.toBeNull();
  });

  it("a stamped memory change of an ended projection is stale; R46: no tool and no pack returns a memory change", async () => {
    const ending = await commitment("intake-ending", [beta.audience], RHEA);
    const entry = entryOf(await sync(beta.token), ending.fact);
    // The owner retires it, so its belief is closed: the next sync ends it.
    await closeSaidClosed(w.store, [{ ...ending.spec, status: "closed" }], ending.records);
    await commitment("intake-after", [beta.audience], QUENTIN);
    await sync(beta.token);
    expect((await projectionOf(w.store.db, entry.stamp.projection)).ended_at).not.toBeNull();
    const stale = added(`canary-memory-change ${renderEntry(entry)}`);
    await imported(beta.token, [stale]);
    await take();
    expect(await importRow(stale.requestId)).toMatchObject({
      mark: "stale",
      matched_projection_ids: [entry.stamp.projection],
    });
    expect((await recordRow((await importRow(stale.requestId)).record_id as string)).evidence_id).not.toBeNull();
    const pack = outcomeValue(await w.reader.buildContextPack(beta.token, { purpose: "agent_bootstrap" }));
    const facts = outcomeValue(await w.reader.findFacts(beta.token, { limit: 50 }));
    expect(JSON.stringify([pack, facts])).not.toContain("canary-memory-change");
    const evidence = (await recordRow((await importRow(stale.requestId)).record_id as string)).evidence_id;
    expect(
      await queryAs(w.store.db.urls.admin, "select 1 from knowledge.claims where evidence_id = $1", [evidence]),
    ).toEqual([]);
  });
});

// A person who sent the owner one message, erased by the owner: their address is suppressed.
async function suppress(address: string): Promise<void> {
  const fixture = mail({
    id: `suppress-${testId("m").slice(-8)}`,
    threadId: `thread-${testId("t").slice(-8)}`,
    at: "2026-09-02T09:00:00Z",
    from: { address, name: "Suppressed Person" },
    to: [{ address: OWNER.personal, name: OWNER.name }],
    subject: "about the lease",
    labels: ["INBOX"],
  });
  await ingestMail(w.store.writer, w.accounts.personalMail, fixture);
  const [person] = await queryAs<{ entity_id: EntityId }>(
    w.store.db.urls.admin,
    "select distinct entity_id from knowledge.accounts where value_fp = $1",
    [fingerprint(w.store.db.keys, "address", address)],
  );
  if (person === undefined) throw new Error("no person");
  await w.admin.erasure.erasePerson(person.entity_id, { requestId: testId("req") });
}
