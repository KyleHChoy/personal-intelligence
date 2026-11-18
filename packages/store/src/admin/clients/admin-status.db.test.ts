import type { RawItem } from "@intelligence/contracts";
import { describe, expect, it } from "vitest";
import type { Keys } from "../../core/keys.ts";
import { connect, OWNER } from "../../test-support/cast.ts";
import { insertClient } from "../../test-support/clients.ts";
import { one, session } from "../../test-support/connections.ts";
import { queryAs, type TestDatabase } from "../../test-support/database.ts";
import { derive, mail, mailItem, NOW } from "../../test-support/items.ts";
import { recordingLogger } from "../../test-support/recording.ts";
import { withStore } from "../../test-support/store.ts";
import { createAdmin } from "../admin.ts";
import type { StatusView } from "./admin-accounts.ts";

const TIMEOUT = 120_000;

async function statusWith(
  db: TestDatabase,
  keys: Keys,
  options: Parameters<ReturnType<typeof createAdmin>["accounts"]["status"]>[0] = {},
): Promise<StatusView> {
  const { log } = recordingLogger();
  const admin = createAdmin({ url: db.urls.admin, keys, log });
  try {
    return await admin.accounts.status(options);
  } finally {
    await admin.close();
  }
}

// The key file without one compartment's key, as a copy restored from too old a backup.
const without = (keys: Keys, compartment: string): Keys => ({
  ...keys,
  compartments: new Map([...keys.compartments].filter(([name]) => name !== compartment)),
});

describe("status", { timeout: TIMEOUT }, () => {
  it("status names a compartment the key file lacks, and none when it holds them all", () =>
    withStore(async ({ db, writer }) => {
      const { workMail } = await connect(writer);
      const fixture = mail({
        id: "status-work-1",
        threadId: "thread-status-work-1",
        at: NOW,
        from: { address: "colleague@employer-example.test" },
        to: [{ address: OWNER.work }],
        subject: "Rota",
        labels: ["INBOX"],
      });
      const raw: RawItem = mailItem(fixture, workMail);
      await writer.ingestItem(workMail, raw, (ctx) => derive(raw, ctx));
      expect((await statusWith(db, db.keys)).missingKeys).toEqual([]);
      expect((await statusWith(db, without(db.keys, "employer:example"))).missingKeys).toEqual(["employer:example"]);
      // A key the file lacks for a compartment no row carries is not named.
      expect((await statusWith(db, without(db.keys, "nonesuch"))).missingKeys).toEqual([]);
    }));

  // A label a stored row holds that policy.labels lacks (a row no client would see) is counted;
  // none when the triggers kept them all.
  it("status counts the label keys stored rows hold that policy.labels lacks, and none when it holds them all", () =>
    withStore(async ({ db, writer }) => {
      const { workMail } = await connect(writer);
      const fixture = mail({
        id: "status-labels-1",
        threadId: "thread-status-labels-1",
        at: NOW,
        from: { address: "colleague@employer-example.test" },
        to: [{ address: OWNER.work }],
        subject: "Rota",
        labels: ["INBOX"],
      });
      const raw: RawItem = mailItem(fixture, workMail);
      await writer.ingestItem(workMail, raw, (ctx) => derive(raw, ctx));
      expect((await statusWith(db, db.keys)).missingLabels).toBe(0);
      // A client's clearance is not a row's label, so a newly registered agent
      // whose clearance no row holds yet is no missing label.
      await insertClient(db, "status-labels-new", ["own", "employer:example", "agent:status-labels-new"]);
      expect((await statusWith(db, db.keys)).missingLabels).toBe(0);
      // A path past the triggers: the work mail's label taken out of policy.labels by its owner.
      await session(db.urls.bootstrap, async (query) => {
        await query("begin");
        await query("set local role pi_owner");
        await query("delete from policy.labels where key = 'employer:example'");
        await query("commit");
      });
      expect((await statusWith(db, db.keys)).missingLabels).toBe(1);
      // pi_admin itself reads nothing of the table: the count comes from the definer function.
      expect(
        await queryAs(db.urls.admin, "select key from policy.labels").catch((error: { code?: string }) => error.code),
      ).toBe("42501");
    }));

  it("status counts the tables of every created schema, ledger and projections included, and of no system schema", () =>
    withStore(async ({ db }) => {
      const { tables } = await statusWith(db, db.keys);
      const created = await queryAs<{ name: string }>(
        db.urls.admin,
        `select n.nspname || '.' || c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname in ('policy', 'vault', 'knowledge', 'ledger', 'projections', 'queue') and c.relkind in ('r', 'p')
           and not (n.nspname = 'ledger' and c.relname = 'handles') and not (n.nspname = 'policy' and c.relname = 'capture_push_refusals')
           and not (n.nspname = 'policy' and c.relname = 'labels') order by 1`,
      );
      expect(Object.keys(tables).sort()).toEqual(created.map((row) => row.name).sort());
      // Every created table but ledger.handles, policy.capture_push_refusals and policy.labels,
      // which pi_admin may not read.
      expect(Object.keys(tables)).not.toContain("ledger.handles");
      expect(Object.keys(tables)).not.toContain("policy.capture_push_refusals");
      expect(Object.keys(tables)).not.toContain("policy.labels");
      // No pinned count: the set above is every table of the six schemas but the excluded ones, so a
      // table a migration adds or drops changes both sides alike.
      expect(created.length).toBeGreaterThan(0);
      expect(Object.keys(tables)).toEqual(
        expect.arrayContaining(["ledger.cards", "ledger.basis", "knowledge.claims", "knowledge.owner_decisions"]),
      );
      expect(Object.keys(tables).some((name) => /^(pg_|information_schema\.|public\.)/.test(name))).toBe(false);
    }));

  // Settings reads status on each load, so the page's read must be quick. pia status counts each
  // table in one statement; the page's read takes the catalogue's estimates and counts none; both
  // find the same missing keys and labels, each labelled table's labels read once.
  it("pia status counts each table exactly; the page's estimates name the same tables and find the same keys and labels", () =>
    withStore(async ({ db, writer }) => {
      const { workMail } = await connect(writer);
      const fixture = mail({
        id: "status-fast-1",
        threadId: "thread-status-fast-1",
        at: NOW,
        from: { address: "colleague@employer-example.test" },
        to: [{ address: OWNER.work }],
        subject: "Rota",
        labels: ["INBOX"],
      });
      const raw: RawItem = mailItem(fixture, workMail);
      await writer.ingestItem(workMail, raw, (ctx) => derive(raw, ctx));
      const keys = without(db.keys, "employer:example");
      const counted = await statusWith(db, keys);
      for (const table of ["vault.evidence_items", "vault.source_accounts", "policy.clients"]) {
        expect(counted.tables[table], table).toBe(
          one(await queryAs<{ n: number }>(db.urls.admin, `select count(*)::int as n from ${table}`)).n,
        );
      }
      expect(counted.tables["vault.evidence_items"]).toBeGreaterThan(0);
      expect(counted.missingKeys).toEqual(["employer:example"]);

      const estimated = await statusWith(db, keys, { tables: "estimate" });
      expect(Object.keys(estimated.tables).sort()).toEqual(Object.keys(counted.tables).sort());
      for (const [table, rows] of Object.entries(estimated.tables))
        expect(Number.isInteger(rows) && rows >= 0, table).toBe(true);
      const { tables: _counted, ...rest } = counted;
      const { tables: _estimated, ...restEstimated } = estimated;
      expect(restEstimated).toEqual(rest);
    }));
});
