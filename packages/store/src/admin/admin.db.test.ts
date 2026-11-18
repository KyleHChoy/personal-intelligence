import { ConnectorCursor, type Envelope, Timestamp } from "@intelligence/contracts";
import {
  ClientId,
  type ClientRegistration,
  EntityId,
  type PersonalTool,
  SearchResult,
  SelfView,
} from "@intelligence/contracts/personal";
import type { Person } from "@intelligence/personal-core/items";
import pg from "pg";
import { describe, expect, it } from "vitest";
import type { Keys } from "../core/keys.ts";
import { openRow } from "../core/seal.ts";
import { tablesIn } from "../test-support/catalogue-grants.ts";
import { sha256Hex } from "../test-support/clients.ts";
import { session } from "../test-support/connections.ts";
import {
  createTestDatabase,
  fingerprint,
  queryAs,
  scanForPlaintext,
  type TestDatabase,
} from "../test-support/database.ts";
import { eventLogger } from "../test-support/recording.ts";
import { snapshot } from "../test-support/snapshot.ts";
import { knowledgeTables, openStore } from "../test-support/store.ts";
import {
  daysFrom,
  hoursFrom,
  instant,
  iso,
  MISSING_ENTITY,
  outcomeValue,
  refusedWith,
  registration,
} from "../test-support/values.ts";
import { seedWorld, storeSeeder, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { Admin, createAdmin } from "./admin.ts";
import { googleSecretName } from "./admin-base.ts";

// Each refusal has its positive control in the same test.

const sortBy = <T>(rows: T[], key: (row: T) => string): T[] =>
  [...rows].sort((one, other) => (key(one) < key(other) ? -1 : key(one) > key(other) ? 1 : 0));

// Every knowledge row as "<table> <key>" with its xmin, read as pi_admin with `snapshot`: a row
// that was rewritten, even to the same values, has a new xmin.
async function knowledgeRows(db: TestDatabase): Promise<Record<string, string>> {
  expect(await knowledgeTables(db.urls.admin)).toEqual(
    tablesIn("knowledge")
      .map((table) => table.name)
      .sort(),
  );
  return Object.fromEntries([...(await snapshot(db))].filter(([key]) => key.startsWith("knowledge.")));
}

describe("the admin: clients", { timeout: 180_000 }, () => {
  it("addClient accepts own with restricted:health and read tools, and refuses restricted:health alone and beside record", async () => {
    const store = await openStore({ writer: false });
    try {
      const { admin } = store;
      const invalid = { name: "AdminError", code: "invalid_registration" };
      expect(await refusedWith(() => admin.clients.addClient(registration("alone", ["restricted:health"])))).toEqual(
        invalid,
      );
      expect(
        await refusedWith(() =>
          admin.clients.addClient(
            registration("recorder", ["own", "restricted:health"], { tools: ["get_self", "record"] }),
          ),
        ),
      ).toEqual(invalid);
      const { token } = await admin.clients.addClient(registration("cleared", ["own", "restricted:health"]));
      expect(token).toMatch(/^pit_/);
      expect((await admin.clients.listClients()).map((row) => [row.name, row.compartments])).toEqual([
        ["cleared", ["own", "restricted:health"]],
      ]);
    } finally {
      await store.close();
    }
  });

  it("store: `addClient` refuses empty lists, a restricted compartment alone and a duplicate name", async () => {
    const store = await openStore({ writer: false });
    try {
      const { admin } = store;
      const refused = (made: unknown) => refusedWith(() => admin.clients.addClient(made as ClientRegistration));
      const invalid = { name: "AdminError", code: "invalid_registration" };

      expect(await refused(registration("no-compartments", []))).toEqual(invalid);
      expect(await refused(registration("no-views", ["own"], { views: [] }))).toEqual(invalid);
      expect(await refused(registration("no-tools", ["own"], { tools: [] }))).toEqual(invalid);
      expect(await refused(registration("restricted-client", ["restricted:health"]))).toEqual(invalid);
      // Whatever else fails ClientRegistration: a name, a compartment or a tool it does not know,
      // and a field it does not have.
      expect(await refused(registration("Bad Name", ["own"]))).toEqual(invalid);
      expect(await refused(registration("odd-compartment", ["everything"]))).toEqual(invalid);
      expect(await refused(registration("odd-tool", ["own"], { tools: ["get_everything"] as never }))).toEqual(invalid);
      expect(await refused({ ...registration("extra-field", ["own"]), clearance: "all" })).toEqual(invalid);

      // The positive control: the same registration, valid, is accepted.
      const { token } = await admin.clients.addClient(registration("valid-client", ["own", "employer:example"]));
      expect(token).toMatch(/^pit_/);

      // Its name is taken, whatever the rest says.
      expect(await refused(registration("valid-client", ["own"]))).toEqual({
        name: "AdminError",
        code: "duplicate_name",
      });
      expect(await refused(registration("valid-client", ["own", "employer:example"], { runtime: "cloud" }))).toEqual({
        name: "AdminError",
        code: "duplicate_name",
      });

      // No refusal left a row.
      expect((await admin.clients.listClients()).map((row) => row.name)).toEqual(["valid-client"]);
      expect(await queryAs(store.db.urls.admin, "select name, compartments from policy.clients")).toEqual([
        { name: "valid-client", compartments: ["own", "employer:example"] },
      ]);
    } finally {
      await store.close();
    }
  });

  it("a client recorded as `retains` may hold `own`", async () => {
    const store = await openStore({ now: WORLD_NOW });
    try {
      const world = await seedWorld(store.writer, store.admin);
      const { token } = await store.admin.clients.addClient(
        registration("retaining-client", ["own"], { vendorRetention: "retains", runtime: "cloud" }),
      );
      const { token: plain } = await store.admin.clients.addClient(
        registration("plain-client", ["own"], { vendorRetention: "none" }),
      );

      // Recorded.
      const listed = sortBy(await store.admin.clients.listClients(), (row) => row.name);
      expect(listed.map((row) => [row.name, row.vendorRetention, row.runtime, row.compartments])).toEqual([
        ["plain-client", "none", "local", ["own"]],
        ["retaining-client", "retains", "cloud", ["own"]],
      ]);
      // And never a gate: it sees exactly what a client whose vendor retains nothing sees.
      expect((await store.reader.client(token))?.compartments).toEqual(["own"]);
      const found = SearchResult.parse(outcomeValue(await store.reader.search(token, { query: "canary" }))).results;
      expect(found.map((one) => one.id)).toEqual([
        world.entityOf(WORLD.both.address),
        world.entityOf(WORLD.ownOnly.address),
      ]);
      expect(outcomeValue(await store.reader.getSelf(token))).toEqual(outcomeValue(await store.reader.getSelf(plain)));
      expect(SelfView.parse(outcomeValue(await store.reader.getSelf(token))).contacts).toHaveLength(2);
    } finally {
      await store.close();
    }
  });

  it("a token is `pit_` and 43 base64url characters, shown once and stored as its SHA-256 hex; `listClients` returns neither", async () => {
    const store = await openStore({ writer: false });
    try {
      const { admin } = store;
      const before = Date.now();
      const { token } = await admin.clients.addClient(registration("first-client", ["own"]));
      const { token: second } = await admin.clients.addClient(
        registration("second-client", ["own", "employer:example"], { views: ["people"], tools: ["search"] }),
      );

      // `pit_` and 32 random bytes in base64url: 43 characters, no padding.
      for (const one of [token, second]) expect(one).toMatch(/^pit_[A-Za-z0-9_-]{43}$/);
      expect(second).not.toBe(token);
      // addClient returns the token and nothing else.
      expect(Object.keys(await admin.clients.addClient(registration("third-client", ["own"])))).toEqual(["token"]);

      // Stored only as the hex SHA-256 of its UTF-8 bytes.
      const stored = await queryAs<{ name: string; token_hash: string }>(
        store.db.urls.admin,
        "select name, token_hash from policy.clients where name <> 'third-client' order by name",
      );
      expect(stored).toEqual([
        { name: "first-client", token_hash: sha256Hex(token) },
        { name: "second-client", token_hash: sha256Hex(second) },
      ]);
      for (const row of stored) expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(await scanForPlaintext(store.db.urls.admin, [token, second])).toEqual([]);
      // The positive control for the scan: it finds the hash where the hash is.
      expect(await scanForPlaintext(store.db.urls.admin, [sha256Hex(token)])).toEqual([
        { table: "policy.clients", column: "token_hash" },
      ]);

      // And the token is the credential: the reader knows its client by it.
      expect((await store.reader.client(token))?.name).toBe("first-client");
      expect((await store.reader.client(second))?.name).toBe("second-client");

      // Shown once: nothing the admin returns afterwards holds a token or a hash.
      const listed = sortBy(await admin.clients.listClients(), (row) => row.name);
      const [first] = listed;
      expect(Object.keys(first ?? {}).sort()).toEqual(
        [
          "compartments",
          "createdAt",
          "id",
          "kind",
          "lastCallAt",
          "name",
          "revokedAt",
          "roles",
          "runtime",
          "status",
          "tools",
          "vendorRetention",
          "views",
          "webhook",
        ].sort(),
      );
      expect(first).toEqual({
        id: expect.any(String),
        name: "first-client",
        kind: "agent",
        status: "active",
        runtime: "local",
        vendorRetention: "none",
        compartments: ["own"],
        views: ["self", "people"],
        tools: ["get_self", "search", "get_entity", "get_timeline"],
        createdAt: expect.any(String),
        revokedAt: null,
        lastCallAt: null,
        // The owner's roles for the agent, none at registration.
        roles: [],
        // No work-notice address until the owner sets one.
        webhook: false,
      });
      expect(ClientId.safeParse(first?.id).success).toBe(true);
      expect(Timestamp.safeParse(first?.createdAt).success).toBe(true);
      expect(Math.abs((instant(first?.createdAt ?? null) ?? 0) - before)).toBeLessThan(5 * 60_000);
      expect(listed[1]).toMatchObject({
        name: "second-client",
        compartments: ["own", "employer:example"],
        views: ["people"],
        tools: ["search"],
      });

      await admin.clients.revokeClient("second-client");
      const text = JSON.stringify([
        listed,
        await admin.clients.listClients(),
        await admin.accounts.status(),
        store.log.events,
      ]);
      for (const secret of [token, second, sha256Hex(token), sha256Hex(second), token.slice(4), second.slice(4)])
        expect(text).not.toContain(secret);
    } finally {
      await store.close();
    }
  });

  // A clearance holds at most 32 compartments. The count is taken after the store adds
  // `agent:<name>` for a client with record, so such a client may name at most 31.
  it("addClient refuses 33 compartments with too_many_compartments and accepts 32", async () => {
    const employers = Array.from({ length: 32 }, (_, index) => `employer:org-${index + 1}`);
    const store = await openStore({
      writer: false,
      compartments: ["own", ...employers, "agent:capped-over", "agent:capped-under"],
    });
    try {
      const recording = new Admin({ pool: store.adminPool, keys: store.db.keys, log: store.log, recordEnabled: true });
      const over = ["own", ...employers];
      const cap = ["own", ...employers.slice(0, 31)];
      const under = ["own", ...employers.slice(0, 30)];
      const tooMany = { name: "AdminError", code: "too_many_compartments" };
      const withRecord = { tools: ["get_self", "record"] as PersonalTool[] };

      // Without record: 33 are refused, 32 taken.
      expect(over).toHaveLength(33);
      expect(await refusedWith(() => store.admin.clients.addClient(registration("capped-wide", over)))).toEqual(
        tooMany,
      );
      await store.admin.clients.addClient(registration("capped-cap", cap));

      // With record: 32 named and the agent compartment are 33, refused; 31 and the agent
      // compartment are 32, taken.
      expect(
        await refusedWith(() => recording.clients.addClient(registration("capped-over", cap, withRecord))),
      ).toEqual(tooMany);
      await recording.clients.addClient(registration("capped-under", under, withRecord));

      // The refusals wrote nothing; the two taken are stored with their 32 compartments each.
      const stored = await queryAs<{ name: string; n: number }>(
        store.db.urls.admin,
        "select name, cardinality(compartments)::int as n from policy.clients order by name",
      );
      expect(stored).toEqual([
        { name: "capped-cap", n: 32 },
        { name: "capped-under", n: 32 },
      ]);
    } finally {
      await store.close();
    }
  });
});

describe("the admin: status and inspect", { timeout: 180_000 }, () => {
  it("status reports, per source account, its label, connector, last sync, outcome, cursor time and skipped items; per label, the refresh token's age; the key check; and each client's last call", async () => {
    const store = await openStore({ now: WORLD_NOW });
    try {
      const { admin, writer, db } = store;
      const world = await seedWorld(writer, admin);
      const { personalMail, personalCalendar, workMail, workCalendar } = world.accounts;
      if (
        personalMail === undefined ||
        personalCalendar === undefined ||
        workMail === undefined ||
        workCalendar === undefined
      )
        throw new Error("the world has four accounts");

      // What a sync leaves: outcomes, skipped items, a cursor.
      const syncedAt = hoursFrom(WORLD_NOW, -2);
      const failedAt = hoursFrom(WORLD_NOW, -1);
      await writer.recordOutcome(personalMail, "ok", iso(syncedAt), 3);
      await writer.recordOutcome(workMail, "rate_limited", iso(failedAt));
      await writer.setCursor(personalMail, ConnectorCursor.parse("canary-cursor-personal-mail"));

      // Three clients: one that called, one that never did, one revoked.
      const { token } = await admin.clients.addClient(registration("called-client", ["own"]));
      await admin.clients.addClient(registration("idle-client", ["own"]));
      await admin.clients.addClient(registration("revoked-client", ["own"]));
      expect(await admin.clients.revokeClient("revoked-client")).toBe(true);
      expect((await store.reader.getSelf(token)).ok).toBe(true);
      expect((await store.reader.search(token, { query: "blake" })).ok).toBe(true);

      const status = await admin.accounts.status();
      // The open box health cards and those an agent marked seen, and the agents' recent learnings,
      // none in this world.
      expect(Object.keys(status).sort()).toEqual([
        "accounts",
        "boxHealth",
        "boxHealthSeen",
        "clients",
        "drive",
        "googleTokens",
        "keyCheck",
        "learnings",
        "migration",
        "missingKeys",
        "missingLabels",
        "tables",
      ]);
      // The latest migration applied, by its number: the one the migrations table holds last.
      expect(status.migration).toMatch(/^\d{4}$/);
      expect(status.migration).toBe((await admin.box.latestMigration())?.slice(0, 4));
      expect(status.boxHealth).toEqual([]);
      expect(status.boxHealthSeen).toEqual([]);
      expect(status.learnings).toEqual([]);

      // Per source account. A time is the stored one, never an age.
      const stored = await queryAs<{ id: string; cursor_updated_at: Date | null }>(
        db.urls.admin,
        "select id, cursor_updated_at from vault.source_accounts",
      );
      const cursorAt = stored.find((row) => row.id === personalMail.id)?.cursor_updated_at;
      expect(cursorAt).toBeInstanceOf(Date);
      const accounts = sortBy(status.accounts, (row) => `${row.label}/${row.connector}`);
      expect(
        accounts.map((row) => ({
          ...row,
          lastSyncAt: instant(row.lastSyncAt),
          cursorUpdatedAt: instant(row.cursorUpdatedAt),
        })),
      ).toEqual([
        {
          id: personalCalendar.id,
          label: "personal",
          connector: "google_calendar",
          compartment: "own",
          lastSyncAt: null,
          lastOutcome: null,
          cursorUpdatedAt: null,
          skippedItems: 0,
        },
        {
          id: personalMail.id,
          label: "personal",
          connector: "google_mail",
          compartment: "own",
          lastSyncAt: syncedAt.getTime(),
          lastOutcome: "ok",
          cursorUpdatedAt: cursorAt?.getTime(),
          skippedItems: 3,
        },
        {
          id: workCalendar.id,
          label: "work",
          connector: "google_calendar",
          compartment: "employer:example",
          lastSyncAt: null,
          lastOutcome: null,
          cursorUpdatedAt: null,
          skippedItems: 0,
        },
        {
          id: workMail.id,
          label: "work",
          connector: "google_mail",
          compartment: "employer:example",
          lastSyncAt: failedAt.getTime(),
          lastOutcome: "rate_limited",
          cursorUpdatedAt: null,
          skippedItems: 0,
        },
      ]);

      // Per label, the refresh token: when it was last set. The client secrets are not tokens.
      const secrets = await queryAs<{ name: string; updated_at: Date }>(
        db.urls.admin,
        "select name, updated_at from policy.secrets where name like 'google/%/refresh_token' order by name",
      );
      expect(secrets.map((row) => row.name)).toEqual([
        googleSecretName("personal", "refresh_token"),
        googleSecretName("work", "refresh_token"),
      ]);
      expect(sortBy(status.googleTokens, (row) => row.label).map((row) => [row.label, instant(row.updatedAt)])).toEqual(
        [
          ["personal", secrets[0]?.updated_at.getTime()],
          ["work", secrets[1]?.updated_at.getTime()],
        ],
      );

      // Each client's last call.
      const [{ at: lastCall } = { at: null }] = await queryAs<{ at: Date | null }>(
        db.urls.admin,
        "select max(at) as at from policy.calls",
      );
      expect(lastCall).toBeInstanceOf(Date);
      expect(
        sortBy(status.clients, (row) => row.name).map((row) => ({ ...row, lastCallAt: instant(row.lastCallAt) })),
      ).toEqual([
        { name: "called-client", status: "active", lastCallAt: lastCall?.getTime() },
        { name: "idle-client", status: "active", lastCallAt: null },
        { name: "revoked-client", status: "revoked", lastCallAt: null },
      ]);
      const listed = (await admin.clients.listClients()).find((row) => row.name === "called-client");
      expect(instant(listed?.lastCallAt ?? null)).toBe(lastCall?.getTime());

      // Every policy, vault, knowledge, projections, ledger and queue table, with its row count.
      const tables = (
        await queryAs<{ name: string }>(
          db.urls.admin,
          "select schemaname || '.' || tablename as name from pg_tables where schemaname in ('policy', 'vault', 'knowledge', 'projections', 'ledger', 'queue') order by 1",
        )
      )
        .map((row) => row.name)
        // ledger.handles, policy.capture_push_refusals and policy.labels are left out: no runtime
        // role, pi_admin included, reads any of them (status in admin-accounts.ts).
        .filter((name) => !["ledger.handles", "policy.capture_push_refusals", "policy.labels"].includes(name));
      // The list is pinned by what it includes, not its length, so that adding an entry breaks nothing.
      // The rule under test is the line after: status lists every table pi_admin may count.
      expect(Object.keys(status.tables)).toEqual(
        expect.arrayContaining([
          "policy.client_webhooks",
          "ledger.work_notices",
          "ledger.work_declines",
          "ledger.fact_settlements",
        ]),
      );
      expect(Object.keys(status.tables).sort()).toEqual([...tables].sort());
      for (const table of tables) {
        const [count] = await queryAs<{ n: number }>(db.urls.admin, `select count(*)::int as n from ${table}`);
        expect(status.tables[table], table).toBe(count?.n);
      }
      expect(status.tables["policy.clients"]).toBe(3);
      expect(status.tables["policy.calls"]).toBe(2);
      expect(status.tables["vault.source_accounts"]).toBe(4);

      // No secret, cursor or address: stored fields about them only.
      const text = JSON.stringify(status);
      for (const needle of [
        "canary-refresh-token",
        "canary-client-secret",
        "canary-cursor",
        WORLD.ownerPersonal,
        WORLD.ownerWork,
        token,
      ])
        expect(text).not.toContain(needle);

      // The key check. Every account's address opens under its compartment's key.
      expect(status.keyCheck).toBe("ok");
      // With keys that lack one account's compartment, it fails.
      const ownOnly: Keys = {
        compartments: new Map([...db.keys.compartments].filter(([name]) => name === "own")),
        fingerprintKey: db.keys.fingerprintKey,
      };
      expect(
        (await new Admin({ pool: store.adminPool, keys: ownOnly, log: store.log }).accounts.status()).keyCheck,
      ).toBe("failed");
      // And when one account's sealed address is another's, moved, it fails.
      await queryAs(
        db.urls.admin,
        "update vault.source_accounts set address_enc = (select o.address_enc from vault.source_accounts o where o.id = $2) where id = $1",
        [personalMail.id, workMail.id],
      );
      const after = await admin.accounts.status();
      expect(after.keyCheck).toBe("failed");
      // Nothing else in the report changed.
      // The update moved a row, so each list is compared in one order.
      const settled = (view: typeof status) => ({
        ...view,
        accounts: sortBy(view.accounts, (row) => `${row.label}/${row.connector}`),
        googleTokens: sortBy(view.googleTokens, (row) => row.label),
        clients: sortBy(view.clients, (row) => row.name),
      });
      // The database's size moves with any write; the drive's counts do not.
      const sized = {
        ...after.drive,
        databaseBytes: status.drive.databaseBytes,
        ceilingWarning: status.drive.ceilingWarning,
      };
      expect(settled({ ...after, keyCheck: "ok", drive: sized })).toEqual(settled(status));
    } finally {
      await store.close();
    }
  });

  it("inspect returns an entity's names, addresses and last ten interactions, by id and by address; an unknown query returns null", async () => {
    const now = new Date("2026-03-10T12:00:00.000Z");
    const store = await openStore({ now });
    try {
      const { admin, writer } = store;
      const seed = storeSeeder(writer, now);
      const personal = await writer.ensureSourceAccount("personal", "google_mail", "own", "owner.inspect@example.com");
      const work = await writer.ensureSourceAccount(
        "work",
        "google_mail",
        "employer:example",
        "owner.inspect@example.org",
      );
      const owner: Person = { address: "owner.inspect@example.com" };
      const atWork: Person = { address: "owner.inspect@example.org" };
      const quinn = { address: "quinn@inspect.example.org", name: "Quinn Canary-Inspect" };
      const quinnAtWork = { address: quinn.address, name: "Quinn Canary-Workname" };
      const other = { address: "other@inspect.example.org", name: "Other Sender" };

      // Eleven interactions: eight received under `own`, and three under the employer's label,
      // one the owner sent and two Quinn was only copied on.
      for (let day = 1; day <= 8; day += 1)
        await seed.mail(personal, {
          id: `inspect-own-${day}`,
          from: quinn,
          to: [owner],
          at: daysFrom(now, -day),
          subject: "canary-inspect-own",
        });
      await seed.mail(work, {
        id: "inspect-work-sent",
        from: atWork,
        to: [quinnAtWork],
        at: hoursFrom(now, -12),
        subject: "canary-inspect-sent",
        sent: true,
      });
      await seed.mail(work, {
        id: "inspect-work-cc-9",
        from: other,
        to: [atWork],
        cc: [quinnAtWork],
        at: daysFrom(now, -9),
        subject: "canary-inspect-cc",
      });
      await seed.mail(work, {
        id: "inspect-work-cc-10",
        from: other,
        to: [atWork],
        cc: [quinnAtWork],
        at: daysFrom(now, -10),
        subject: "canary-inspect-cc",
      });
      const id = seed.entityOf(quinn.address);

      const view = await admin.accounts.inspect(quinn.address);
      expect(Object.keys(view ?? {}).sort()).toEqual(["addresses", "id", "interactions", "kind", "names"]);
      expect([view?.id, view?.kind]).toEqual([id, "person"]);
      // Each name and each address with its compartment. A name several items show is one name.
      const distinct = (rows: { value: string; compartment: string }[] | undefined): string[] =>
        [...new Set((rows ?? []).map((row) => `${row.compartment} ${row.value}`))].sort();
      expect(distinct(view?.names)).toEqual([`employer:example ${quinnAtWork.name}`, `own ${quinn.name}`]);
      expect(distinct(view?.addresses)).toEqual([`employer:example ${quinn.address}`, `own ${quinn.address}`]);
      // The last ten of the eleven: the oldest, the copy at -10d, is the one left out.
      const interactions = sortBy(
        (view?.interactions ?? []).map((row) => ({ ...row, at: instant(row.at) ?? 0 })),
        (row) => String(10 ** 15 - row.at),
      );
      expect(interactions).toEqual([
        {
          at: hoursFrom(now, -12).getTime(),
          direction: "outbound",
          role: "recipient",
          compartment: "employer:example",
        },
        ...Array.from({ length: 8 }, (_, n) => ({
          at: daysFrom(now, -(n + 1)).getTime(),
          direction: "inbound",
          role: "sender",
          compartment: "own",
        })),
        { at: daysFrom(now, -9).getTime(), direction: "inbound", role: "recipient", compartment: "employer:example" },
      ]);
      for (const row of view?.interactions ?? []) expect(Timestamp.safeParse(row.at).success).toBe(true);

      // By id, the same.
      expect(await admin.accounts.inspect(id)).toEqual(view);
      // Someone with fewer than ten interactions shows them all.
      expect((await admin.accounts.inspect(other.address))?.interactions).toHaveLength(2);

      // An unknown query is null: an address nobody has, an id no entity has, and neither.
      expect(await admin.accounts.inspect("nobody@inspect.example.org")).toBeNull();
      expect(await admin.accounts.inspect(MISSING_ENTITY)).toBeNull();
      expect(await admin.accounts.inspect("canary neither an id nor an address")).toBeNull();
    } finally {
      await store.close();
    }
  });
});

describe("the admin: owner addresses", { timeout: 180_000 }, () => {
  it("an owner address a person held is the owner's alone when addOwnerAddress returns: it re-derives in its own transaction", async () => {
    const store = await openStore({ now: WORLD_NOW });
    try {
      const { admin, writer, db } = store;
      const world = await seedWorld(writer, admin);
      const { token } = await admin.clients.addClient(registration("own-client", ["own"]));
      const address = WORLD.both.address;
      const print = fingerprint(db.keys, "address", address);
      const heldByAPerson = async (): Promise<number | undefined> =>
        (
          await queryAs<{ n: number }>(
            db.urls.admin,
            "select count(*)::int as n from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where e.kind = 'person' and a.value_fp = $1",
            [print],
          )
        )[0]?.n;

      // Before: nothing needs a re-derive, and the person holds the address under both labels.
      expect(await writer.rederiveIfNeeded(world.derive)).toEqual({ rederived: false, items: 0, coarser: 0 });
      expect(await heldByAPerson()).toBe(2);

      const first = await admin.accounts.addOwnerAddress(address, "own");
      expect(first.rederived).toBe(true);
      expect(first.items).toBeGreaterThan(0);
      expect(await heldByAPerson()).toBe(0);
      // The owner's account row for the address, under `own`.
      expect(
        await queryAs(
          db.urls.admin,
          "select e.kind, a.kind as account_kind, a.compartments from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where a.value_fp = $1",
          [print],
        ),
      ).toEqual([{ kind: "owner", account_kind: "email", compartments: ["own"] }]);
      // Nothing is left for the next re-derive.
      expect(await writer.rederiveIfNeeded(world.derive)).toEqual({ rederived: false, items: 0, coarser: 0 });

      // Adding it again re-derives nothing and changes no row at all.
      const after = await knowledgeRows(db);
      expect(await admin.accounts.addOwnerAddress(address, "own")).toEqual({ rederived: false, items: 0 });
      expect(await knowledgeRows(db)).toEqual(after);

      // So the address is the owner's alone: among the owner's addresses, and found by no search.
      const self = SelfView.parse(outcomeValue(await store.reader.getSelf(token)));
      expect(self.addresses.map((one) => one.untrusted).sort()).toEqual([address, WORLD.ownerPersonal].sort());
      expect(outcomeValue(await store.reader.search(token, { query: address }))).toEqual({ results: [] });
    } finally {
      await store.close();
    }
  });

  it("addOwnerAddress refuses with sync_running while a sync holds the sync lock, and writes nothing", async () => {
    const store = await openStore({ writer: false });
    try {
      const { admin, db } = store;
      await session(db.urls.writer, async (query) => {
        await query("begin");
        await query("select pg_advisory_xact_lock(hashtext('intelligence personal sync'))");
        await expect(admin.accounts.addOwnerAddress("owner.alias@example.com", "own")).rejects.toMatchObject({
          code: "sync_running",
        });
        await query("rollback");
      });
      expect(await knowledgeRows(db)).toEqual({});
    } finally {
      await store.close();
    }
  });

  it("on an empty store, addOwnerAddress makes the owner entity and its one account row", async () => {
    const store = await openStore({ writer: false });
    try {
      const { admin, db } = store;
      expect(await knowledgeRows(db)).toEqual({});

      // Trimmed and lower-cased, as normalizeAddress gives it. No person held it, so no re-derive.
      expect(await admin.accounts.addOwnerAddress("  Owner.Alias@Example.COM ", "own")).toEqual({
        rederived: false,
        items: 0,
      });

      const entities = await queryAs<{ id: string; kind: string }>(
        db.urls.admin,
        "select id, kind from knowledge.entities",
      );
      expect(entities).toEqual([{ id: expect.any(String), kind: "owner" }]);
      expect(EntityId.safeParse(entities[0]?.id).success).toBe(true);
      const accounts = await queryAs<{
        id: string;
        entity_id: string;
        kind: string;
        value_fp: string;
        value_enc: Envelope;
        compartments: string[];
      }>(db.urls.admin, "select id, entity_id, kind, value_fp, value_enc, compartments from knowledge.accounts");
      expect(accounts.map(({ value_enc: _sealed, ...row }) => row)).toEqual([
        {
          id: expect.stringMatching(/^adr_/),
          entity_id: entities[0]?.id,
          kind: "email",
          value_fp: fingerprint(db.keys, "address", "owner.alias@example.com"),
          compartments: ["own"],
        },
      ]);
      const [account] = accounts;
      if (account === undefined) throw new Error("no account row");
      // Sealed under the `own` key, bound to its row and column.
      expect(
        openRow(
          db.keys,
          "own",
          { table: "knowledge.accounts", id: account.id, column: "value_enc" },
          account.value_enc,
        ),
      ).toBe("owner.alias@example.com");
      expect(await scanForPlaintext(db.urls.admin, ["owner.alias"])).toEqual([]);
      // Nothing else: no domain row, and no other table has a row.
      const rows = await knowledgeRows(db);
      expect(Object.keys(rows).sort()).toEqual(
        [`knowledge.accounts ${account.id}`, `knowledge.entities ${entities[0]?.id}`].sort(),
      );

      // The same address again, in any spelling, changes nothing.
      await admin.accounts.addOwnerAddress("owner.alias@example.com", "own");
      await admin.accounts.addOwnerAddress("OWNER.ALIAS@example.com", "own");
      expect(await knowledgeRows(db)).toEqual(rows);

      // Another address, under another compartment, is a second row of the same one owner.
      await admin.accounts.addOwnerAddress("owner.work@example.org", "employer:example");
      expect(await queryAs(db.urls.admin, "select kind from knowledge.entities")).toEqual([{ kind: "owner" }]);
      expect(
        await queryAs(db.urls.admin, "select entity_id, compartments from knowledge.accounts order by compartments"),
      ).toEqual([
        { entity_id: entities[0]?.id, compartments: ["employer:example"] },
        { entity_id: entities[0]?.id, compartments: ["own"] },
      ]);
      expect(Object.keys(await knowledgeRows(db)).filter((key) => key.startsWith("knowledge.domains "))).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it("addOwnerAddress refuses an address that does not normalize, and a compartment the keys lack", async () => {
    const store = await openStore({ writer: false });
    try {
      const { admin, db } = store;
      for (const bad of [
        "",
        "canary-not-an-address",
        "two@@example.com",
        "nodot@localhost",
        "@example.com",
        "name@example..com",
      ]) {
        expect(await refusedWith(() => admin.accounts.addOwnerAddress(bad, "own")), bad).toEqual({
          name: "AdminError",
          code: "invalid_address",
        });
      }
      // A compartment the keys lack is a plain Error with a code: matched by the code alone.
      for (const compartment of ["employer:nobody", "public", ""]) {
        expect(
          (await refusedWith(() => admin.accounts.addOwnerAddress("owner.alias@example.com", compartment))).code,
          compartment,
        ).toBe("unknown_compartment");
      }
      // No refusal wrote anything.
      expect(await knowledgeRows(db)).toEqual({});

      // The positive control: the same address under a compartment the keys hold.
      await admin.accounts.addOwnerAddress("owner.alias@example.com", "employer:example");
      expect(await queryAs(db.urls.admin, "select compartments from knowledge.accounts")).toEqual([
        { compartments: ["employer:example"] },
      ]);
    } finally {
      await store.close();
    }
  });
});

describe("the admin: secrets and source accounts", { timeout: 180_000 }, () => {
  it("`googleSecretName` names a label's refresh token and its client secret", () => {
    expect(googleSecretName("personal", "refresh_token")).toBe("google/personal/refresh_token");
    expect(googleSecretName("personal", "client")).toBe("google/personal/client");
    expect(googleSecretName("work-two", "client")).toBe("google/work-two/client");
  });

  it("`deleteSecret` removes a secret: the writer's `secret` then returns null", async () => {
    const store = await openStore();
    try {
      const { admin, writer } = store;
      const name = googleSecretName("personal", "refresh_token");
      const kept = googleSecretName("work", "refresh_token");
      await admin.secrets.setSecret(name, "canary-secret-to-delete");
      await admin.secrets.setSecret(kept, "canary-secret-to-keep");
      // The positive control: the writer reads what the admin set.
      expect(await writer.secret(name)).toBe("canary-secret-to-delete");
      expect([...(await writer.listSecretNames("google/"))].sort()).toEqual([name, kept].sort());

      await admin.secrets.deleteSecret(name);
      // Deleting it again, or a name that never was, does nothing and does not fail.
      await admin.secrets.deleteSecret(name);
      await admin.secrets.deleteSecret(googleSecretName("nobody", "client"));

      expect(await writer.secret(name)).toBeNull();
      expect(await admin.secrets.secret(name)).toBeNull();
      expect(await writer.listSecretNames("google/")).toEqual([kept]);
      // The other secret is untouched.
      expect(await writer.secret(kept)).toBe("canary-secret-to-keep");
      expect(await queryAs(store.db.urls.admin, "select name from policy.secrets")).toEqual([{ name: kept }]);
    } finally {
      await store.close();
    }
  });

  it("`listSecretNames` lists the names under a prefix, and `secret` opens one; an unknown name is null", async () => {
    const store = await openStore({ writer: false });
    try {
      const { admin, db } = store;
      const values: Record<string, string> = {
        [googleSecretName("personal", "refresh_token")]: "canary-secret-personal-token",
        [googleSecretName("personal", "client")]: JSON.stringify({
          compartment: "own",
          secret: "canary-secret-personal-client",
        }),
        [googleSecretName("work", "client")]: JSON.stringify({
          compartment: "employer:example",
          secret: "canary-secret-work-client",
        }),
        "other/thing": "canary-secret-other",
      };
      for (const [name, value] of Object.entries(values)) await admin.secrets.setSecret(name, value);

      expect([...(await admin.secrets.listSecretNames("google/"))].sort()).toEqual(
        Object.keys(values)
          .filter((name) => name.startsWith("google/"))
          .sort(),
      );
      expect([...(await admin.secrets.listSecretNames("google/personal/"))].sort()).toEqual([
        googleSecretName("personal", "client"),
        googleSecretName("personal", "refresh_token"),
      ]);
      expect(await admin.secrets.listSecretNames("other/")).toEqual(["other/thing"]);
      expect([...(await admin.secrets.listSecretNames(""))].sort()).toEqual(Object.keys(values).sort());
      expect(await admin.secrets.listSecretNames("google/nobody/")).toEqual([]);

      for (const [name, value] of Object.entries(values)) expect(await admin.secrets.secret(name), name).toBe(value);
      expect(await admin.secrets.secret(googleSecretName("nobody", "client"))).toBeNull();
      expect(await admin.secrets.secret("google/")).toBeNull();

      // Setting a name again replaces its value and makes no second row.
      await admin.secrets.setSecret("other/thing", "canary-secret-other-replaced");
      expect(await admin.secrets.secret("other/thing")).toBe("canary-secret-other-replaced");
      expect(await admin.secrets.listSecretNames("other/")).toEqual(["other/thing"]);

      // Stored sealed, under the `own` key, bound to the secret's name.
      expect(await scanForPlaintext(db.urls.admin, ["canary-secret"])).toEqual([]);
      const stored = await queryAs<{ name: string; value_enc: Envelope }>(
        db.urls.admin,
        "select name, value_enc from policy.secrets order by name",
      );
      expect(stored.map((row) => row.name)).toEqual(Object.keys(values).sort());
      for (const row of stored) {
        const expected = row.name === "other/thing" ? "canary-secret-other-replaced" : values[row.name];
        expect(
          openRow(db.keys, "own", { table: "policy.secrets", id: row.name, column: "value_enc" }, row.value_enc),
          row.name,
        ).toBe(expected);
      }
      // The positive control for the scan: a name is plaintext, and found.
      expect(await scanForPlaintext(db.urls.admin, ["other/thing"])).toEqual([
        { table: "policy.secrets", column: "name" },
      ]);
    } finally {
      await store.close();
    }
  });

  it("`listSourceAccounts` lists each label and connector with its compartment", async () => {
    const store = await openStore();
    try {
      const { admin, writer } = store;
      expect(await admin.accounts.listSourceAccounts()).toEqual([]);

      const personalMail = await writer.ensureSourceAccount(
        "personal",
        "google_mail",
        "own",
        "owner.personal@example.com",
      );
      const personalCalendar = await writer.ensureSourceAccount(
        "personal",
        "google_calendar",
        "own",
        "owner.personal@example.com",
      );
      const workMail = await writer.ensureSourceAccount(
        "work",
        "google_mail",
        "employer:example",
        "owner.work@example.org",
      );
      const syncedAt = new Date("2026-03-10T09:30:00.000Z");
      await writer.recordOutcome(workMail, "ok", iso(syncedAt));

      const listed = sortBy(await admin.accounts.listSourceAccounts(), (row) => `${row.label}/${row.connector}`);
      // The stored fields, with the address opened; no source kind.
      for (const row of listed)
        expect(Object.keys(row).sort()).toEqual([
          "address",
          "compartment",
          "connector",
          "id",
          "label",
          "lastOutcome",
          "lastSyncAt",
        ]);
      expect(listed.map((row) => ({ ...row, lastSyncAt: instant(row.lastSyncAt) }))).toEqual([
        {
          id: personalCalendar.id,
          label: "personal",
          connector: "google_calendar",
          compartment: "own",
          address: "owner.personal@example.com",
          lastSyncAt: null,
          lastOutcome: null,
        },
        {
          id: personalMail.id,
          label: "personal",
          connector: "google_mail",
          compartment: "own",
          address: "owner.personal@example.com",
          lastSyncAt: null,
          lastOutcome: null,
        },
        {
          id: workMail.id,
          label: "work",
          connector: "google_mail",
          compartment: "employer:example",
          address: "owner.work@example.org",
          lastSyncAt: syncedAt.getTime(),
          lastOutcome: "ok",
        },
      ]);
    } finally {
      await store.close();
    }
  });

  it("close ends the pool createAdmin made, and leaves a pool the caller passed", async () => {
    const db = await createTestDatabase();
    const pool = new pg.Pool({ connectionString: db.urls.admin, max: 1 });
    let made: Admin | undefined;
    try {
      const log = eventLogger();
      // How many connections pi_admin holds to this database, once the server has caught up.
      const connections = async (wanted: (n: number) => boolean): Promise<number> => {
        let n = -1;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const rows = await queryAs<{ n: number }>(
            db.urls.bootstrap,
            "select count(*)::int as n from pg_stat_activity where datname = $1 and usename = 'pi_admin'",
            [db.name],
          );
          n = rows[0]?.n ?? -1;
          if (wanted(n)) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return n;
      };

      // With `new`, the caller owns the pool: close() leaves it usable.
      const mine = new Admin({ pool, keys: db.keys, log });
      expect(await mine.clients.listClients()).toEqual([]);
      await mine.close();
      expect((await pool.query("select 1 as one")).rows).toEqual([{ one: 1 }]);
      await pool.end();
      expect(await connections((n) => n === 0)).toBe(0);

      // The factory makes its own pool, and close() ends it.
      made = createAdmin({ url: db.urls.admin, keys: db.keys, log });
      expect(await made.clients.listClients()).toEqual([]);
      expect(await connections((n) => n > 0)).toBeGreaterThan(0);
      await made.close();
      made = undefined;
      expect(await connections((n) => n === 0)).toBe(0);
    } finally {
      await made?.close().catch(() => {});
      if (!pool.ended) await pool.end();
      await db.drop();
    }
  });
});
