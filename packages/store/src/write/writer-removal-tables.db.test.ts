import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDatabase, queryAs, type TestDatabase } from "../test-support/database.ts";
import { KEEPS_A_PERSON } from "./writer-removal.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// The tables that name an entity and keep no person's account alive, each with the reason.
const NOT_A_REASON_TO_KEEP: Readonly<Record<string, string>> = {
  "knowledge.accounts": "the row being removed",
  "knowledge.domains": "an organization's, removed after the accounts",
  "knowledge.projects": "a project's entity, never a person's",
  "knowledge.chat_lines": "removed with the person: a chat line never cites an account",
  "knowledge.org_names": "an organization's name, removed with it",
  "ledger.identity_questions": "a question about the pair, removed with either by its cascade",
  "ledger.dream_subjects": "the dream pass's mark on an entity, removed with it by its cascade",
  "ledger.dream_findings": "the dream pass's finding about an entity, removed with it by its cascade",
  "ledger.dream_identity_candidates":
    "the dream pass's same-person candidate, removed with either entity by its cascade",
};

describe("removeUncited's tables", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(() => db.drop());

  it("every table that names an entity is on the list or has a reason not to be", async () => {
    const rows = await queryAs<{ name: string }>(
      db.urls.bootstrap,
      `select distinct n.nspname || '.' || c.relname as name
       from pg_constraint k
       join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
       join pg_class t on t.oid = k.confrelid join pg_namespace tn on tn.oid = t.relnamespace
       where k.contype = 'f' and tn.nspname = 'knowledge' and t.relname = 'entities' and k.conrelid <> k.confrelid`,
    );
    const keeps = KEEPS_A_PERSON.map(([table]) => table as string);
    const unanswered = rows
      .map((row) => row.name)
      .filter((name) => !keeps.includes(name) && !(name in NOT_A_REASON_TO_KEEP));
    expect(unanswered).toEqual([]);
    for (const table of keeps) expect(rows.map((row) => row.name)).toContain(table);
  });
});
