import { describe, expect, it } from "vitest";
import { namesSealed } from "./recording.ts";

// The detector the "opens no sealed value" tests rest on: it must find a sealed column, an
// envelope and every form of all-columns, and must not take a product for one.
describe("namesSealed", () => {
  it.each([
    "select body_enc from ledger.agent_writes",
    "select c.id, c.quote_enc from ledger.card_relays c",
    "select envelope from vault.blobs",
    "select * from ledger.cards",
    "select c.* from ledger.cards c",
    "select c.id, * from ledger.cards c",
    "select distinct * from ledger.cards",
    "update ledger.cards set kind = $1 returning *",
    "select count(*), c.* from ledger.cards c group by c.id",
    "select distinct on (kind) * from ledger.cards",
    "select distinct on (c.kind, lower(c.created_by)) * from ledger.cards c",
    "select /* every column */ * from ledger.cards",
    "select -- every column\n * from ledger.cards",
    "select c.id, /* and the rest */ c.* from ledger.cards c",
  ])("finds %s", (text) => {
    expect(namesSealed(text)).toBe(true);
  });

  it.each([
    "select count(*)::int as n from ledger.cards",
    "select count( * ) from ledger.cards",
    "select c.id from ledger.cards c where c.expires_after_days * 24 >= 48",
    "select (c.n + 1) * 2 as twice from ledger.cards c",
    "select c.kind, c.created_at from ledger.cards c",
    "select distinct on (c.kind) c.kind, c.created_at from ledger.cards c",
    "select c.id /* not c.* */ from ledger.cards c",
    "select c.id from ledger.cards c -- where c.n * 2 > 1",
    "select count(/* all */ *) from ledger.cards",
  ])("passes %s", (text) => {
    expect(namesSealed(text)).toBe(false);
  });
});
