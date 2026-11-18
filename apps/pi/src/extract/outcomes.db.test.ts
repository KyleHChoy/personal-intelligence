import type { Timestamp } from "@intelligence/contracts";
import type { ClaimRecord } from "@intelligence/contracts/personal";
import { PERSONAL_LIMITS } from "@intelligence/personal-core";
import { deriveItem, importItem, readContacts } from "@intelligence/personal-core/items";
import { LINKEDIN_CONNECTIONS } from "@intelligence/personal-core/testing";
import { createOutcomeStore } from "@intelligence/personal-store";
import {
  asOwner,
  batchOf,
  claimRecord,
  fingerprint,
  MAIL,
  type PipelineStore,
  queryAs,
  rowsOf,
  sealRow,
  stored,
  withPipeline,
} from "@intelligence/personal-store/testing";
import { describe, expect, it, vi } from "vitest";
import { quiet } from "../test-support/extract-fixtures.ts";
import { scripted } from "../test-support/same-fact-fixtures.ts";
import { runOutcomes } from "./outcomes.ts";

// On Postgres: the open path of the relation step's outcome judge, as `pi extract` runs it
// as pi_pipeline: a claim from a contact import meets an open expectation on that person,
// unapplied for the tick to rule on; a candidate and its link carry the union of the work's and the item's labels, so a
// client cleared for the work alone is given neither (invariant 6); past the run's calls,
// candidates are marked unjudged and taken first by the next run. Each item is noted as exposed
// before a request leaves. Reserved domains and made-up words only; the model is a stub.

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const NOW = new Date("2026-09-15T12:00:00Z");
const MODEL = "test/luna";
const JUDGE = `model:${MODEL}@personal_outcome_judge@1`;

// An open opportunity under `compartments`, as the work tools' definers leave one, written by the
// database's owner (seed rows).
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const idOf = (prefix: string): string =>
  `${prefix}_${Array.from({ length: 26 }, () => CROCKFORD[Math.floor(Math.random() * 32)]).join("")}`;
async function work(store: PipelineStore, compartments: string[]): Promise<string> {
  const [caseId, id, goal] = [idOf("cas"), idOf("opp"), idOf("gol")];
  const n = id.slice(-10);
  await asOwner(
    store.db,
    "insert into ledger.cases (id, request_id, created_by, compartments, row_kind, kind, about_kind, about_id, author) values ($1, $2, 'system:seed', $3, 'opportunity', 'follow_up', 'goal', $4, 'run')",
    [caseId, `req-${n}-seed`, compartments, goal],
  );
  await asOwner(
    store.db,
    `insert into ledger.opportunities (id, request_id, created_by, compartments, case_id, kind, about_kind, about_id, proposed_by_class, body_enc)
     values ($1, $2, 'system:seed', $3, $4, 'investigate', 'goal', $5, 'run', $6)`,
    [
      id,
      `req-${n}-opp`,
      compartments,
      caseId,
      goal,
      sealRow(
        store.db.keys,
        compartments[0] ?? "own",
        { table: "ledger.opportunities", id, column: "body_enc" },
        "Seed work",
      ),
    ],
  );
  return id;
}

// An expectation of a role on a person, its success words sealed under the work's label.
async function expectRole(
  store: PipelineStore,
  opportunity: string,
  person: string,
  title: string,
  compartments: string[],
): Promise<string> {
  const success = sealRow(
    store.db.keys,
    compartments[0] ?? "own",
    { table: "ledger.expected_outcomes", id: `${opportunity}/0`, column: "success_enc" },
    JSON.stringify({ title }),
  );
  const [row] = await asOwner<{ id: string }>(
    store.db,
    `insert into ledger.expected_outcomes (opportunity_id, ordinal, created_by, origin, subject_kind, subject_id, outcome_type, success_enc, horizon_days, compartments)
     values ($1, 0, 'system:seed', 'stated', 'entity', $2, 'role', $3, 60, $4) returning id::text`,
    [opportunity, person, success, compartments],
  );
  return (row as { id: string }).id;
}

// A judge that answers `met`, citing the passage's words, when the passage names `title`, and
// `unrelated` otherwise; every other prompt is answered `unrelated`.
const judgeSaying = (title: string) =>
  scripted((request) => {
    if (request.promptId !== "personal_outcome_judge") return { relation: "unrelated", from: "first", cites: [] };
    const text = (JSON.parse(request.data.case ?? "{}") as { passage?: { text?: string | null } }).passage?.text ?? "";
    return text.includes(title)
      ? { outcome: "met", cites: [{ text: `title: ${title}` }] }
      : { outcome: "unrelated", cites: [] };
  });

async function step(store: PipelineStore, model: ReturnType<typeof scripted>, callsLeft = 20) {
  const outcomes = createOutcomeStore({ url: store.db.urls.pipeline, keys: store.db.keys, log: quiet });
  try {
    return await runOutcomes({
      outcomes,
      pipeline: store.pipeline,
      client: { model: model.model, modelId: MODEL },
      callsLeft,
      log: quiet,
      now: () => NOW,
    });
  } finally {
    await outcomes.close();
  }
}

type Link = {
  evidence_id: string;
  claim_key: string | null;
  kind: string;
  path: string;
  judge: string;
  attribution: string;
  applied: boolean;
  compartments: string[];
};
const links = (store: PipelineStore): Promise<Link[]> =>
  rowsOf<Link>(
    store.db,
    "select evidence_id, claim_key, kind, path, judge, attribution, applied, compartments from ledger.outcome_links where move_result_link_id is null order by id",
  );
type Check = {
  evidence_id: string;
  state: string;
  first_answer: string | null;
  second_answer: string | null;
  agreed: boolean | null;
  written: string | null;
  code: string | null;
  compartments: string[];
};
const checks = (store: PipelineStore): Promise<Check[]> =>
  queryAs<Check>(
    store.db.urls.pipeline,
    "select evidence_id, state, first_answer, second_answer, agreed, written, code, compartments from ledger.outcome_checks order by id",
  );

describe("the open path: a claim from any source", () => {
  it("a claim from a contact import meets an open expectation on that person, unapplied, observed, judged by the model; asked once", () =>
    withPipeline(async (store) => {
      // A LinkedIn import through the writer's real path: the person and their role.
      const read = readContacts("linkedin-connections", LINKEDIN_CONNECTIONS, { now: NOW });
      const record = read.records.find((one) => one.emails.length > 0);
      expect(record).toBeDefined();
      const account = await store.writer.ensureImportAccount("outcome-import");
      const raw = importItem(record as NonNullable<typeof record>, {
        sourceAccount: account.id,
        now: NOW.toISOString() as Timestamp,
        id: `import:${fingerprint(store.db.keys, "source_id", "import:outcome-ivo")}`,
      });
      expect(await store.writer.ingestItem(account, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS))).toBe(
        "stored",
      );
      const [person] = await rowsOf<{ entity_id: string }>(
        store.db,
        "select entity_id from knowledge.accounts where value_fp = $1",
        [fingerprint(store.db.keys, "address", record?.emails[0] ?? "")],
      );
      const [item] = await rowsOf<{ evidence_id: string; compartments: string[] }>(
        store.db,
        "select evidence_id, compartments from knowledge.claims where type = 'role' limit 1",
      );
      expect(person).toBeDefined();
      const opportunity = await work(store, item?.compartments ?? ["own"]);
      await expectRole(store, opportunity, person?.entity_id as string, "Partner", item?.compartments ?? ["own"]);

      const model = judgeSaying("Partner");
      const counts = await step(store, model);
      expect(counts).toMatchObject({ links: 1, saved: 1 });
      expect(await links(store)).toEqual([
        {
          evidence_id: item?.evidence_id,
          claim_key: expect.stringMatching(/^[0-9a-f]{64}$/),
          kind: "met",
          path: "open",
          judge: JUDGE,
          attribution: "observed",
          applied: false,
          compartments: item?.compartments,
        },
      ]);
      // One candidate a work's expectation and item, asked in both orders: the item's claims (its
      // role and its affiliation) are shown together, in their typed words, since an import keeps
      // no passage.
      const asked = model.sent.filter((request) => request.promptId === "personal_outcome_judge");
      expect(asked).toHaveLength(2);
      expect(asked.map((request) => Object.keys(JSON.parse(request.data.case ?? "{}") as object)[0])).toEqual([
        "expected",
        "passage",
      ]);
      // Each item was noted as exposed to the model before its request left (FE1).
      const [exposed] = await rowsOf<{ n: number }>(
        store.db,
        "select count(*)::int as n from ledger.exposures where ref = $1",
        [item?.evidence_id],
      );
      expect(exposed?.n).toBeGreaterThan(0);
      // A second run asks nothing: every candidate is judged.
      const again = judgeSaying("Partner");
      await step(store, again);
      expect(again.sent).toHaveLength(0);
      expect(await links(store)).toHaveLength(1);
    }));
});

// A role claim of a person, from a stored message of the world under `compartment`.
function role(evidenceId: string, compartment: string, person: string, n: number, title: string): ClaimRecord {
  const base = claimRecord(evidenceId, compartment, person, {
    n,
    type: "role",
    factKey: `outcome role ${evidenceId} ${n}`,
    entities: [person],
    basis: "third_party",
  });
  return {
    ...base,
    subjectKind: "person",
    fieldKinds: { title: "text" },
    claim: { ...base.claim, content: { ...base.claim.content, fields: { title } } },
  } as unknown as ClaimRecord;
}

describe("invariant 6 and the budget", () => {
  it("a candidate, its saved call, its check and its link carry the union of the work's and the item's labels: a client cleared for the work alone is given none", () =>
    withPipeline(async (store) => {
      const workItem = await stored(store.writer, store.accounts.workMail, MAIL.workOnly);
      const [person] = await rowsOf<{ id: string }>(
        store.db,
        "select entity_id as id from knowledge.accounts where value_fp = $1",
        [fingerprint(store.db.keys, "address", "wren@partner-example.test")],
      );
      expect(
        await store.pipeline.commit(
          batchOf(workItem, [role(workItem, "employer:example", person?.id as string, 1, "Chair of the Board")]),
        ),
      ).toBe("committed");
      const opportunity = await work(store, ["own"]);
      await expectRole(store, opportunity, person?.id as string, "Chair of the Board", ["own"]);
      await step(store, judgeSaying("Chair of the Board"));
      const both = ["employer:example", "own"];
      expect((await links(store)).map((one) => one.compartments)).toEqual([both]);
      expect((await checks(store)).map((one) => one.compartments)).toEqual([both]);
      const calls = await rowsOf<{ compartments: string[] }>(
        store.db,
        "select compartments from vault.decision_calls where point = 'outcome_judge'",
      );
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((one) => JSON.stringify(one.compartments) === JSON.stringify(both))).toBe(true);
      // No reader, delegate or agent employee holds any grant on either table.
      for (const table of ["ledger.outcome_links", "ledger.outcome_checks"]) {
        const [grant] = await rowsOf<{ n: number }>(
          store.db,
          "select count(*)::int as n from information_schema.role_table_grants where table_schema = 'ledger' and table_name = $1 and grantee = 'pi_reader'",
          [table.slice(7)],
        );
        expect(grant?.n, table).toBe(0);
      }
    }));

  it("past the run's calls, candidates are marked unjudged without their passages opened, and the next run takes them first", () =>
    withPipeline(async (store) => {
      const items = [
        await stored(store.writer, store.accounts.personalMail, MAIL.solo),
        await stored(store.writer, store.accounts.personalMail, MAIL.fromQuentin),
        await stored(store.writer, store.accounts.personalMail, MAIL.reply),
      ];
      const [person] = await rowsOf<{ id: string }>(
        store.db,
        "select entity_id as id from knowledge.accounts where value_fp = $1",
        [fingerprint(store.db.keys, "address", "quentin@lighthouse.test")],
      );
      for (const [n, item] of items.entries())
        expect(
          await store.pipeline.commit(
            batchOf(item, [role(item, "own", person?.id as string, n + 1, `Warden number ${n + 1}`)]),
          ),
        ).toBe("committed");
      const opportunity = await work(store, ["own"]);
      await expectRole(store, opportunity, person?.id as string, "Warden number 9", ["own"]);
      // Room for one candidate's two calls.
      const first = judgeSaying("Warden number 9");
      const counts = await step(store, first, 2);
      expect(first.sent.filter((request) => request.promptId === "personal_outcome_judge")).toHaveLength(2);
      expect(counts.unjudged).toBe(2);
      const after = await checks(store);
      expect(after.map((one) => one.state).sort()).toEqual(["judged", "unjudged", "unjudged"]);
      const left = after.filter((one) => one.state === "unjudged").map((one) => one.evidence_id);
      // The next run, with room for one more: an unjudged candidate first.
      const next = judgeSaying("Warden number 9");
      await step(store, next, 2);
      expect(next.sent.filter((request) => request.promptId === "personal_outcome_judge")).toHaveLength(2);
      const judgedNow = (await checks(store)).filter((one) => one.state === "judged").map((one) => one.evidence_id);
      expect(judgedNow.filter((id) => left.includes(id))).toHaveLength(1);
    }));
});
