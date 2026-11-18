import { describe, expect, it } from "vitest";
import { storeFiles, storeText } from "../test-support/sources.ts";

// "One label everywhere": every seal and open of a row's value takes the row's whole label, with
// sealUnder and openedUnder. A single name (sealRow, openRow, opened, compartments[0], or a
// one-name list handed to sealUnder or openedUnder) would seal a restricted row's value under its
// source compartment alone, which the general file opens. A source scan: each store source may hold
// these only where it is listed below, as many times as listed, each for a reason that no
// restricted row reaches. A fixed one is struck off.

const SINGLE =
  /compartments\[0\]|sealRow\(|openRow\(|(?<![\w.])opened\(|(?:sealUnder|openedUnder|openUnder)\(\s*[^,()]+,\s*\[[^\],]+\]/g;

const KNOWN: Record<string, { count: number; why: string }> = {
  "seal.ts": { count: 1, why: "sealRow itself" },
  "tx.ts": { count: 1, why: "opened itself" },
  "keys.ts": { count: 1, why: "a key file's check values, one per compartment, not rows" },
  "writer-accounts.ts": {
    count: 6,
    why: "vault.source_accounts (its compartment, address, cursor and send-as aliases), whose label is single (compartments_single), and policy.secrets, always own: never restricted",
  },
  "admin-accounts.ts": {
    count: 5,
    why: "a source account's compartment shown by list, status and owner aliases, and policy.secrets, always own",
  },
  "admin-declassify.ts": { count: 1, why: "the declassified label, one compartment by definition" },
  "admin-work-planner.ts": {
    count: 2,
    why: "his planner mission under own and a lesson in his words under own; no restricted compartment is either",
  },
  "admin-projects.ts": {
    count: 1,
    why: "a project's name the owner added, under the one compartment he named, as admin-work's goal",
  },
  "admin-erase.ts": { count: 1, why: "a source account's compartment" },
  "admin-identity.ts": { count: 1, why: "a source account's compartment" },
  "admin-person-names.ts": {
    count: 1,
    why: "not a single name: a person name sealed under its whole label, spread as [...compartments]",
  },
  "admin-imports.ts": { count: 1, why: "an import's source account's compartment, always own" },
  "admin-roots.ts": { count: 2, why: "policy.drive_roots, always own" },
  "key-fingerprint.ts": {
    count: 1,
    why: "the key file's recorded identity, one row of policy.secrets, always own, sealed at the record",
  },
  "writer-documents.ts": {
    count: 2,
    why: "documents and roots: restricted screening reads email only",
  },
  "writer-contacts.ts": {
    count: 2,
    why: "contacts, sealed and (the reclaim and the phone_fps catch-up) opened under the contact's own account compartment: restricted screening reads email only",
  },
  "writer-pages.ts": {
    count: 1,
    why: "a fetched web page under its research account's compartment, whose label is single: restricted screening reads email only",
  },
  "sender.ts": {
    count: 5,
    why: "the send path: source accounts, secrets, and a draft's own label check; a restricted label never reaches it",
  },
  "work-draft.ts": { count: 1, why: "a label check for public, not a seal" },
  "capture-push.ts": { count: 1, why: "an inbox body, always own, the staging label" },
  "lens-scope.ts": {
    count: 2,
    why: "a scope rule's value and account, always own, sealed by addScope",
  },
  "lens-browsing.ts": {
    count: 2,
    why: "an exclusion's host and a mapped account, always own, sealed by addExclude and addAccount",
  },
  "owner-words.ts": {
    count: 1,
    why: "a repeated note's owner_command account, looked up from its note_add's one compartment; an account lookup, not a seal or an open",
  },
  "work-outcome-test.ts": {
    count: 2,
    why: "the outcome test's own rows: their stored label opens them, each compartment checked against the keys held first; it seals nothing itself",
  },
  "promotion-intake.ts": {
    count: 1,
    why: "a promoted claim, sealed under the one compartment its row is stored under, which the intake refuses when it is restricted",
  },
};

async function sources(): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  for (const name of storeFiles()) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name.includes("fixtures") || name === "testing.ts")
      continue;
    const count = (storeText(name).match(SINGLE) ?? []).length;
    if (count > 0) found.set(name, count);
  }
  return found;
}

describe("one label in every seal and open", () => {
  it("no store source outside seal.ts reads compartments[0] or calls sealRow or openRow, but its known callers", async () => {
    const found = await sources();
    expect(Object.fromEntries(found)).toEqual(
      Object.fromEntries(Object.entries(KNOWN).map(([name, { count }]) => [name, count])),
    );
  });

  it("the writer, the re-derive, the pipeline store and the admin's extraction and reader paths hold none", async () => {
    const found = await sources();
    for (const name of [
      "writer-derived.ts",
      "writer-item-removal.ts",
      "identity-port.ts",
      "rederive.ts",
      "admin-extraction.ts",
      "admin-extraction-review.ts",
      "admin-extraction-status.ts",
      "admin-queue.ts",
      "pipeline-write.ts",
      "pipeline-cards.ts",
      "pipeline-calls.ts",
      "pipeline-beliefs.ts",
      "pipeline-read.ts",
      "pipeline-due.ts",
      "pipeline-due-captures.ts",
      "pipeline-open.ts",
      "read-db.ts",
      "read-fact-rows.ts",
      "read-facts.ts",
      "read-compiled.ts",
      "read-messages.ts",
      "identity-sweep.ts",
      "card-kinds-identity.ts",
    ]) {
      expect(found.get(name) ?? 0, name).toBe(0);
    }
  });

  it("the scan finds each single-name form", () => {
    for (const text of [
      "x.compartments[0]",
      "sealRow(keys, c, at, v)",
      "openRow(keys, c, at, e)",
      "= opened(keys, c, at, e)",
      "sealUnder(tx.keys, [account.compartment], at, v)",
      'openedUnder(keys, ["own"], at, e)',
    ]) {
      expect(text.match(SINGLE)?.length, text).toBe(1);
    }
    for (const text of [
      "sealUnder(keys, cs, at, v)",
      "openedUnder(keys, row.compartments, at, e)",
      "sealUnder(keys, [...a, b], at, v)",
      "row.opened(x)",
      "compartments[1]",
    ])
      expect(text.match(SINGLE), text).toBeNull();
  });
});
