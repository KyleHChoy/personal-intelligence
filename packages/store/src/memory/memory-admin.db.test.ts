import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ClientName,
  MemoryExposureView,
  MemoryProjection,
  type MemoryProjectionId,
  MemoryStatusView,
  type SyncMemoryArgs,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { Reader } from "../read/read.ts";
import { type Accounts, connect, QUENTIN, RHEA, SOLO } from "../test-support/cast.ts";
import { testId } from "../test-support/clients.ts";
import { one } from "../test-support/connections.ts";
import { queryAs, type TestDatabase } from "../test-support/database.ts";
import { mailSourceId } from "../test-support/items.ts";
import { knownBy } from "../test-support/known-by.ts";
import {
  commitmentOnMail,
  type MailCommitment,
  MEMORY_FIXTURE_NOW,
  projectionsOf,
} from "../test-support/memory-fixtures.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue, refusedWith, registration } from "../test-support/values.ts";

// The grant of sync_memory, the taint through the writer and through the owner's erasure, and the
// owner's two reads. Each world is its own store, with the journal of its own folder.

const MEMORY = { tools: ["get_self", "sync_memory"], views: ["self", "work"] } as const;

type World = {
  store: TestStore;
  db: TestDatabase;
  accounts: Accounts;
  admin: Admin;
  reader: Reader;
  owner: string;
  journal: string;
};

async function inWorld(fn: (world: World) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-memory-"));
  const store = await openStore();
  try {
    const journal = join(dir, "keys.json.erasures");
    const accounts = await connect(store.writer);
    const admin = new Admin({ pool: store.adminPool, keys: store.db.keys, log: store.log, journal });
    const reader = new Reader({
      pool: store.readerPool,
      keys: store.db.keys,
      log: store.log,
      now: () => MEMORY_FIXTURE_NOW,
    });
    const owner = one(
      await queryAs<{ id: string }>(store.db.urls.admin, "select id from knowledge.entities where kind = 'owner'"),
    ).id;
    await fn({ store, db: store.db, accounts, admin, reader, journal, owner });
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// A commitment on a new message of `from`'s, under `own`, with every earlier one kept.
const commitment = async (
  world: World,
  id: string,
  keep: MailCommitment[] = [],
  from = QUENTIN,
): Promise<MailCommitment> => {
  const made = await commitmentOnMail(world.store, world.accounts.personalMail, world.owner, id, { from, keep });
  await knownBy(world.db, MEMORY_FIXTURE_NOW);
  return made;
};

async function client(
  world: World,
  name: string,
  retention: "none" | "retains" | "unknown" = "none",
): Promise<{ name: ClientName; token: string; id: string }> {
  const { token } = await world.admin.clients.addClient(
    registration(name, ["own"], { ...MEMORY, vendorRetention: retention } as never),
  );
  const id = (await world.admin.clients.listClients()).find((row) => row.name === name)?.id;
  if (id === undefined) throw new Error(`no client ${name}`);
  return { name: name as ClientName, token, id };
}

const sync = async (
  world: World,
  token: string,
  args: SyncMemoryArgs = { have: [], canDelete: true },
): Promise<MemoryProjection> => MemoryProjection.parse(outcomeValue(await world.reader.syncMemory(token, args)));
const idOf = (projection: MemoryProjection, fact: string): MemoryProjectionId | undefined =>
  projection.entries.find((entry) => entry.stamp.fact === fact)?.stamp.projection;
const deleteAtSource = (world: World, made: MailCommitment) =>
  world.store.writer.applyDeletion(world.accounts.personalMail, {
    sourceAccount: world.accounts.personalMail.id,
    sourceItemId: mailSourceId(made.fixture),
    deletedAt: "2026-09-03T00:00:00Z",
  });

describe("sync_memory at registration", { timeout: DB_TEST_TIMEOUT }, () => {
  it("sync_memory is given to a client whatever its recorded retention", () =>
    inWorld(async (world) => {
      for (const retention of ["none", "retains", "unknown"] as const)
        await client(world, `memory-${retention}`, retention);
      expect(
        (await world.admin.clients.listClients()).map((row) => [row.name, row.vendorRetention, row.tools]),
      ).toEqual([
        ["memory-none", "none", ["get_self", "sync_memory"]],
        ["memory-retains", "retains", ["get_self", "sync_memory"]],
        ["memory-unknown", "unknown", ["get_self", "sync_memory"]],
      ]);
      // And by setTools.
      await world.admin.clients.addClient(
        registration("later", ["own"], { views: ["self", "work"], tools: ["get_self"] }),
      );
      await world.admin.clients.setTools("later", ["get_self", "sync_memory"]);
      expect((await world.admin.clients.listClients()).find((row) => row.name === "later")?.tools).toEqual([
        "get_self",
        "sync_memory",
      ]);
    }));

  it("sync_memory is refused with invalid_registration for a client of kind reasoner, at addClient and at setTools, and given to the same registration of kind agent", () =>
    inWorld(async (world) => {
      const invalid = { name: "AdminError", code: "invalid_registration" };
      const made = registration("reasons", ["own"], { ...MEMORY, kind: "reasoner" } as never);
      expect(await refusedWith(() => world.admin.clients.addClient(made))).toEqual(invalid);
      expect(await world.admin.clients.listClients()).toEqual([]);
      // A reasoner registered in SQL, as the reasoner's own registration makes one.
      await queryAs(
        world.db.urls.admin,
        `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind)
         values ($1, 'reasoner-one', $2, 'active', 'none', 'local', '{own}', '{self,work}', '{get_self}', 'reasoner')`,
        [testId("cli"), "a".repeat(64)],
      );
      expect(
        await refusedWith(() => world.admin.clients.setTools("reasoner-one", ["get_self", "sync_memory"])),
      ).toEqual(invalid);
      expect((await world.admin.clients.listClients()).find((row) => row.name === "reasoner-one")?.tools).toEqual([
        "get_self",
      ]);
      // The positive control: the same registration of kind agent.
      await world.admin.clients.addClient({ ...made, kind: "agent" });
      expect((await world.admin.clients.listClients()).find((row) => row.name === "reasons")?.tools).toEqual([
        "get_self",
        "sync_memory",
      ]);
    }));
});

describe("a deletion under a projection", { timeout: DB_TEST_TIMEOUT }, () => {
  it("after a message under a projected commitment is deleted at the source through the writer, the next sync has no entry for it, its id under remove, and a correction with no current value", () =>
    inWorld(async (world) => {
      const agent = await client(world, "deleted-at-source");
      const made = await commitment(world, "r24-writer");
      const first = await sync(world, agent.token);
      const id = idOf(first, made.fact);
      expect(id).toBeDefined();
      await deleteAtSource(world, made);
      const next = await sync(world, agent.token, {
        have: first.entries.map((entry) => entry.stamp.projection),
        canDelete: true,
      });
      expect(idOf(next, made.fact)).toBeUndefined();
      expect(next.remove).toContain(id);
      expect(next.corrections).toContainEqual({
        projection: id,
        endedAt: expect.any(String),
        reason: "withdrawn",
        current: null,
      });
      expect(JSON.stringify(next)).not.toContain("canary-");
      expect(
        await queryAs(
          world.db.urls.admin,
          "select projection_id, removal from ledger.memory_exposures where client_id = $1",
          [agent.id],
        ),
      ).toEqual([{ projection_id: id, removal: "pending" }]);
    }));

  it("the same after pi erase item, through Admin.eraseItem", () =>
    inWorld(async (world) => {
      const agent = await client(world, "erased-item");
      const made = await commitment(world, "r24-erase");
      const first = await sync(world, agent.token);
      const id = idOf(first, made.fact);
      await world.admin.erasure.eraseItem({ kind: "message", id: made.message.id }, { requestId: testId("req") });
      const next = await sync(world, agent.token, {
        have: first.entries.map((entry) => entry.stamp.projection),
        canDelete: true,
      });
      expect(idOf(next, made.fact)).toBeUndefined();
      expect(next.remove).toContain(id);
      expect(next.corrections).toContainEqual({
        projection: id,
        endedAt: expect.any(String),
        reason: "withdrawn",
        current: null,
      });
    }));

  it("an erased item is removed from every projection, each client that was served it has its id under remove and an exposure row, reported after a sync without it and not_possible for a target that cannot delete", () =>
    inWorld(async (world) => {
      const deletes = await client(world, "m6-deletes");
      const cannot = await client(world, "m6-cannot", "retains");
      const bystander = await client(world, "m6-bystander");
      const kept = await commitment(world, "m6-kept", [], RHEA);
      const made = await commitment(world, "m6-erased", [kept]);
      const served = new Map<string, MemoryProjection>();
      for (const one of [deletes, cannot]) {
        const first = await sync(world, one.token);
        served.set(one.name, first);
        // The adapter wrote the file: its report.
        await sync(world, one.token, {
          have: first.entries.map((entry) => entry.stamp.projection),
          canDelete: one === deletes,
        });
      }
      await world.admin.erasure.eraseItem({ kind: "message", id: made.message.id }, { requestId: testId("req") });
      for (const one of [deletes, cannot]) {
        const before = served.get(one.name) as MemoryProjection;
        const id = idOf(before, made.fact);
        const have = before.entries.map((entry) => entry.stamp.projection);
        const next = await sync(world, one.token, { have, canDelete: one === deletes });
        expect(idOf(next, made.fact), one.name).toBeUndefined();
        expect(next.remove, one.name).toEqual([id]);
        // The commitment that rested on nothing erased keeps its entry.
        expect(idOf(next, kept.fact), one.name).toBe(idOf(before, kept.fact));
        expect(
          (
            await queryAs<{ projection_id: string }>(
              world.db.urls.admin,
              "select projection_id from ledger.memory_exposures where client_id = $1",
              [one.id],
            )
          ).map((row) => row.projection_id),
          one.name,
        ).toEqual([id]);
      }
      // The adapter that can delete reports it gone; the one that cannot keeps it.
      const deletesNow = await sync(world, deletes.token, {
        have: [idOf(served.get(deletes.name) as MemoryProjection, kept.fact) as MemoryProjectionId],
        canDelete: true,
      });
      expect(deletesNow.inStep).toBe(true);
      const removal = async (who: { id: string }) =>
        (
          await queryAs<{ removal: string }>(
            world.db.urls.admin,
            "select removal from ledger.memory_exposures where client_id = $1",
            [who.id],
          )
        ).map((row) => row.removal);
      expect(await removal(deletes)).toEqual(["reported"]);
      expect(await removal(cannot)).toEqual(["not_possible"]);
      // A client that was never served it has no exposure.
      await sync(world, bystander.token);
      expect(await removal(bystander)).toEqual([]);
    }));

  it("the erasure's dry run and its report count the projection rows it taints", () =>
    inWorld(async (world) => {
      const agent = await client(world, "counted");
      const made = await commitment(world, "counted");
      expect(idOf(await sync(world, agent.token), made.fact)).toBeDefined();
      const target = { kind: "message", id: made.message.id } as const;
      const dry = await world.admin.erasure.eraseItem(target, { requestId: testId("req"), dryRun: true });
      const real = await world.admin.erasure.eraseItem(target, { requestId: testId("req") });
      // No card or decision cites the message: the one row is the projection.
      expect(real.taintedRows).toBe(1);
      expect(dry.taintedRows).toBe(real.taintedRows);
    }));

  it("replaying the journal against a restored copy taints the same projection rows", () =>
    inWorld(async (world) => {
      const agent = await client(world, "restored");
      const made = await commitment(world, "r28");
      const first = await sync(world, agent.token);
      const id = idOf(first, made.fact);
      // As a restore leaves it: the journal holds the erasure and the database does not. The
      // erasure's transaction is killed before its commit, after its journal line.
      const kill = (sql: string) => queryAs(world.db.urls.bootstrap, `set role pi_owner; ${sql}`);
      await kill("alter table knowledge.removed_evidence add constraint test_kill check (false) not valid");
      await expect(
        world.admin.erasure.eraseItem({ kind: "message", id: made.message.id }, { requestId: testId("req") }),
      ).rejects.toMatchObject({ code: "unavailable" });
      await kill("alter table knowledge.removed_evidence drop constraint test_kill");
      expect(await world.admin.erasure.level()).toBe("behind");
      expect((await projectionsOf(world.db, { id: agent.id })).find((row) => row.id === id)?.tainted_at).toBeNull();
      expect(await world.admin.erasure.replayErasures()).toEqual({ applied: 1, journalled: 0 });
      const row = (await projectionsOf(world.db, { id: agent.id })).find((one) => one.id === id);
      expect(row).toMatchObject({ reason: "withdrawn", evidence_ids: [], belief_id: null });
      expect(row?.tainted_at).not.toBeNull();
      expect(
        await queryAs(world.db.urls.admin, "select projection_id from ledger.memory_exposures where client_id = $1", [
          agent.id,
        ]),
      ).toEqual([{ projection_id: id }]);
    }));
});

describe("the owner's memory reads", { timeout: DB_TEST_TIMEOUT }, () => {
  it("memoryStatus counts live, unconfirmed and ended-not-absent rows and exposures by removal, and shows a client in step after a confirming sync", () =>
    inWorld(async (world) => {
      const agent = await client(world, "status-agent", "retains");
      const other = await client(world, "status-other");
      const kept = await commitment(world, "status-kept", [], RHEA);
      const made = await commitment(world, "status-erased", [kept], SOLO);
      const status = async (name?: ClientName) => MemoryStatusView.parse(await world.admin.agents.memoryStatus(name));
      const of = async () => (await status(agent.name)).clients[0];

      expect(await of()).toEqual({
        client: agent.id,
        name: agent.name,
        status: "active",
        retention: "retains",
        lastSyncAt: null,
        live: 0,
        unconfirmed: 0,
        endedNotAbsent: 0,
        exposures: { pending: 0, reported: 0, notPossible: 0 },
      });
      const first = await sync(world, agent.token);
      expect(await of()).toMatchObject({ live: 2, unconfirmed: 2, endedNotAbsent: 0, lastSyncAt: expect.any(String) });
      const have = first.entries.map((entry) => entry.stamp.projection);
      await sync(world, agent.token, { have, canDelete: true });
      // In step: everything served is confirmed, and nothing ended is still in the file.
      expect(await of()).toMatchObject({ live: 2, unconfirmed: 0, endedNotAbsent: 0 });

      await deleteAtSource(world, made);
      await sync(world, agent.token, { have, canDelete: true });
      // The ended row is still reported in the file.
      expect(await of()).toMatchObject({
        live: 1,
        unconfirmed: 0,
        endedNotAbsent: 1,
        exposures: { pending: 1, reported: 0, notPossible: 0 },
      });
      await sync(world, agent.token, { have: [idOf(first, kept.fact) as MemoryProjectionId], canDelete: true });
      expect(await of()).toMatchObject({
        live: 1,
        unconfirmed: 0,
        endedNotAbsent: 0,
        exposures: { pending: 0, reported: 1, notPossible: 0 },
      });

      // Every client, by name; the other has never synced.
      const all = await status();
      expect(all.clients.map((row) => row.name)).toEqual([agent.name, other.name].sort());
      expect(all.clients.find((row) => row.name === other.name)).toMatchObject({ lastSyncAt: null, live: 0 });
      // lastSyncAt is the latest ok sync.
      const [latest] = await queryAs<{ at: Date }>(
        world.db.urls.admin,
        "select max(at) as at from policy.calls where client_id = $1 and tool = 'sync_memory' and outcome = 'ok'",
        [agent.id],
      );
      expect((await of())?.lastSyncAt).toBe(latest?.at.toISOString());
    }));

  it("memoryStatus of an unknown client is not_found", () =>
    inWorld(async (world) => {
      expect(await refusedWith(() => world.admin.agents.memoryStatus("nobody" as ClientName))).toEqual({
        name: "AdminError",
        code: "not_found",
      });
      // The control: a known one is listed.
      await client(world, "somebody");
      expect((await world.admin.agents.memoryStatus("somebody" as ClientName)).clients).toHaveLength(1);
    }));

  it("memoryExposures is newest first and says more past its limit", () =>
    inWorld(async (world) => {
      const agent = await client(world, "exposed");
      const made: MailCommitment[] = [];
      for (const [n, from] of [QUENTIN, RHEA, SOLO].entries())
        made.push(await commitment(world, `exposure-${n}`, made, from));
      await sync(world, agent.token);
      for (const one of made) await deleteAtSource(world, one);
      const all = MemoryExposureView.parse(await world.admin.agents.memoryExposures({ client: agent.name }));
      expect(all.more).toBe(false);
      expect(all.exposures).toHaveLength(3);
      const order = [...all.exposures].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.id - a.id);
      expect(all.exposures).toEqual(order);
      expect(all.exposures[0]).toMatchObject({
        client: agent.id,
        name: agent.name,
        retention: "none",
        removal: "pending",
        removalAt: null,
        firstRemoval: null,
        firstRemovalAt: null,
      });
      const two = await world.admin.agents.memoryExposures({ client: agent.name, limit: 2 });
      expect(two.exposures).toEqual(all.exposures.slice(0, 2));
      expect(two.more).toBe(true);
      expect((await world.admin.agents.memoryExposures({ limit: 500 })).exposures).toHaveLength(3);
      for (const limit of [0, 501, 1.5])
        expect(await refusedWith(() => world.admin.agents.memoryExposures({ limit })), String(limit)).toEqual({
          name: "AdminError",
          code: "invalid_argument",
        });
    }));
});
