import { describe, expect, it } from "vitest";
import { CARD_KINDS } from "../admin/cards/card-kinds.ts";
import { raiseCard } from "../core/queue.ts";
import { ERASURE_HOOKS } from "../erasure/erasure-hooks.ts";
import { insertClient } from "../test-support/clients.ts";
import { one, readAs } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { withDatabase } from "../test-support/store.ts";

// A failure here is reported, never worked around. The two source account checks are read from the
// catalogue; every value the latest earlier migration gave them is one the research migration
// restates.

const TIMEOUT = 120_000;

const CONNECTORS = ["google_mail", "google_calendar", "google_docs", "agent", "google_contacts"];
const PAIRS = [
  ["google_mail", "email"],
  ["google_calendar", "calendar"],
  ["google_docs", "document"],
  ["agent", "agent_record"],
  ["google_contacts", "crm"],
];

const definition = async (url: string, name: string): Promise<string> =>
  one(
    await queryAs<{ def: string }>(
      url,
      "select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'vault.source_accounts'::regclass and conname = $1",
      [name],
    ),
  ).def;

describe("what the research database builds on", { timeout: TIMEOUT }, () => {
  it("the connector check and the kind pair check of vault.source_accounts hold the values the latest migration gave them", () =>
    withDatabase(async (db) => {
      const connectors = await definition(db.urls.admin, "source_accounts_connector_check");
      for (const connector of CONNECTORS) expect(connectors, connector).toContain(`'${connector}'`);
      const pairs = await definition(db.urls.admin, "source_accounts_kind_of_connector");
      for (const [connector, kind] of PAIRS)
        expect(pairs, connector).toMatch(
          new RegExp(`connector = '${connector}'::text\\) AND \\(source_kind = '${kind}'::text`),
        );
      const address = await definition(db.urls.admin, "source_accounts_agent_address");
      expect(address).toContain("'agent'");
    }));

  it("vault.evidence_items.source_kind takes web_research", () =>
    withDatabase(async (db) => {
      const check = one(
        await queryAs<{ def: string }>(
          db.urls.admin,
          "select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'vault.evidence_items'::regclass and conname = 'evidence_items_source_kind_check'",
        ),
      ).def;
      expect(check).toContain("'web_research'");
    }));

  it("policy.record_label exists and answers the token's clearance, with the agent compartment", () =>
    withDatabase(
      async (db) => {
        const client = await insertClient(db, "pub2-label", ["public", "own"]);
        const label = one(
          await readAs(db, client.token, (query) =>
            query<{ label: string[] }>("select policy.record_label() as label"),
          ),
        ).label;
        expect(label).toEqual(["agent:pub2-label", "own", "public"]);
        const clearance = one(
          await readAs(db, client.token, (query) =>
            query<{ clearance: string[] }>("select policy.client_clearance() as clearance"),
          ),
        ).clearance;
        expect([...clearance].sort()).toEqual(["own", "public"]);
      },
      { compartments: ["own", "public"] },
    ));

  it("raiseCard, CARD_KINDS, ERASURE_HOOKS and policy.vetoed exist", () =>
    withDatabase(async (db) => {
      expect(typeof raiseCard).toBe("function");
      expect(typeof CARD_KINDS === "object" && CARD_KINDS !== null).toBe(true);
      expect(Array.isArray(ERASURE_HOOKS)).toBe(true);
      const found = one(
        await queryAs<{ fn: string | null }>(
          db.urls.admin,
          "select to_regprocedure('policy.vetoed(text[], text[], text)')::text as fn",
        ),
      );
      expect(found.fn).not.toBeNull();
      const taint = one(
        await queryAs<{ fn: string | null }>(
          db.urls.admin,
          "select to_regprocedure('ledger.taint_citing(text[], text[], text[])')::text as fn",
        ),
      );
      expect(taint.fn).not.toBeNull();
    }));
});
