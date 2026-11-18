import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaimRecord } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Query } from "../core/db.ts";
import type { Db } from "../core/job-db.ts";
import { generateKeyFile, type Keys, loadKeys } from "../core/keys.ts";
import { sealUnder } from "../core/seal.ts";
import { claimRecord } from "../test-support/pipeline-fixtures.ts";
import { createOutcomeStore, type OutcomeRunRow } from "./outcome-store.ts";

// The outcome judge's store over a query that answers as the database would, recording each
// statement it sends: which statements, in which order, and what jobs finds and builds, on the
// watched path (a thread, an entity, a document, a series), the open path and an earlier run's
// unjudged candidate, past the run's calls; and save's rows. Ids that are valid but mean nothing.

const fake: { query: Query | undefined } = { query: undefined };
vi.mock("../core/job-db.ts", async (original) => {
  const real = await original<typeof import("../core/job-db.ts")>();
  return {
    ...real,
    createDb: (): Db =>
      ({
        query: ((sql: string, values?: unknown[]) => (fake.query as Query)(sql, values)) as Query,
        transaction: (fn: (query: Query) => Promise<unknown>) => fn(fake.query as Query),
        close: async () => {},
      }) as unknown as Db,
  };
});

let dir = "";
let keys: Keys;
const LABEL = ["own"];
const NOW = "2026-09-15T12:00:00.000Z";
const JUDGE = "model:test/luna@personal_outcome_judge@1";
const WORK = `opp_${"0".repeat(25)}1`;
const CLOSED = `opp_${"0".repeat(25)}2`;
const PERSON = `ent_${"0".repeat(25)}3`;
const COLLEAGUE = `ent_${"0".repeat(25)}4`;
const MESSAGE = `msg_${"0".repeat(25)}5`;
const ev = (char: string): string => char.repeat(64);
const [REPLY, SENT, JUDGED, OLD, CLAIMED, LEFT] = ["1", "2", "3", "4", "0", "6"].map(ev) as [
  string,
  string,
  string,
  string,
  string,
  string,
];
const at = (iso: string): Date => new Date(iso);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-outcome-store-"));
  await generateKeyFile(join(dir, "keys.json"), LABEL);
  keys = await loadKeys(join(dir, "keys.json"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const statement = (text: string): string =>
  `${text.slice(0, 60)} #${createHash("sha256").update(text).digest("hex").slice(0, 8)}`;

const channel = (kind: string | null, watchKey: string | null, opportunity = WORK) => ({
  opportunity_id: opportunity,
  kind,
  account_id: "acc_1",
  watch_key: watchKey,
  began_at: at("2026-09-01T00:00:00Z"),
  until: null,
  moved_at: at("2026-09-05T00:00:00Z"),
  counterpart_fps: ["fp-sender"],
  compartments: LABEL,
});

const item = (id: string, first: string, options: { direction?: string; message?: string | null } = {}) => ({
  evidence_id: id,
  account_id: "acc_1",
  thread_fp: "thread-1",
  first_at: at(first),
  sender_fp: options.direction === undefined ? null : "fp-sender",
  direction: options.direction ?? null,
  message_id: options.message ?? null,
  compartments: LABEL,
});
const ITEMS = [
  item(REPLY, "2026-09-10T00:00:00Z", { direction: "inbound", message: MESSAGE }),
  item(SENT, "2026-09-10T00:00:00Z", { direction: "outbound" }),
  item(JUDGED, "2026-09-10T00:00:00Z", { direction: "inbound" }),
  item(OLD, "2026-08-01T00:00:00Z"),
  item(CLAIMED, "2026-09-11T00:00:00Z"),
  item(LEFT, "2026-09-12T00:00:00Z"),
];

// The claim of CLAIMED: the person's own word about themselves.
const claimed = (): ClaimRecord => {
  const record = claimRecord(CLAIMED, LABEL, PERSON, { type: "role" });
  return { ...record, claim: { ...record.claim, assertedBy: PERSON } } as ClaimRecord;
};

let channelWorks: unknown = [];
function database(): string[] {
  const sent: string[] = [];
  channelWorks = [];
  const sealed = (table: string, id: string, column: string, text: string) =>
    sealUnder(keys, LABEL, { table, id, column }, text);
  fake.query = (async (sql: string, values: unknown[] = []) => {
    const text = sql.replace(/\s+/g, " ").trim();
    sent.push(statement(text));
    if (text.startsWith("select (select count(*) from ledger.relation_checks")) return [{ pairs: 1, asked: 1 }];
    if (text.startsWith("select distinct opportunity_id from ledger.expected_outcomes"))
      return [{ opportunity_id: WORK }, { opportunity_id: CLOSED }];
    if (text.startsWith("select opportunity_id from ledger.gap_default_works")) return [{ opportunity_id: WORK }];
    if (text.startsWith("select * from ledger.outcome_channels")) {
      channelWorks = values[0];
      return [
        channel(null, null),
        channel("thread", "thread-1"),
        channel("entity", PERSON),
        channel("document", "doc_1"),
        channel("series", "series-1"),
        channel("thread", "thread-2", CLOSED),
      ];
    }
    if (text.startsWith("select x.id::text as id, x.opportunity_id"))
      return [
        {
          id: "11",
          opportunity_id: WORK,
          ordinal: 0,
          subject_kind: "counterpart",
          subject_id: null,
          outcome_type: "answered",
          success_enc: null,
          failure_enc: null,
          compartments: LABEL,
          person: true,
        },
        {
          id: "12",
          opportunity_id: WORK,
          ordinal: 1,
          subject_kind: "entity",
          subject_id: PERSON,
          outcome_type: "role",
          success_enc: sealed(
            "ledger.expected_outcomes",
            `${WORK}/1`,
            "success_enc",
            JSON.stringify({ title: "Lead" }),
          ),
          failure_enc: null,
          compartments: LABEL,
          person: false,
        },
        // Under a compartment these keys do not open: never a candidate.
        {
          ...{ id: "13", opportunity_id: WORK, ordinal: 2, subject_kind: "counterpart", subject_id: null },
          outcome_type: "answered",
          success_enc: null,
          failure_enc: null,
          compartments: ["work"],
          person: true,
        },
      ];
    if (text.startsWith("select distinct on (expected_outcome_id, evidence_id)"))
      return [
        { expected_outcome_id: "11", evidence_id: JUDGED, state: "judged", claim_id: null, path: "watched" },
        { expected_outcome_id: "12", evidence_id: LEFT, state: "unjudged", claim_id: null, path: "open" },
      ];
    if (text.startsWith("select e.id from vault.evidence_items e join knowledge.messages m"))
      return [{ id: REPLY }, { id: SENT }, { id: JUDGED }];
    if (text.startsWith("select m.evidence_id as id from knowledge.messages m join knowledge.accounts"))
      return [{ id: REPLY }];
    if (text.startsWith("select d.evidence_id as id from knowledge.documents")) return [{ id: OLD }];
    if (text.startsWith("select e.id as evidence_id, e.source_account_id"))
      return ITEMS.filter((row) => (values[0] as string[]).includes(row.evidence_id));
    if (text.startsWith("select c.id, c.evidence_id, c.fact_key_fp"))
      return [
        {
          id: "clm_1",
          evidence_id: CLAIMED,
          fact_key_fp: "f".repeat(64),
          compartments: LABEL,
          content_enc: null,
          subjects: [COLLEAGUE],
        },
      ];
    if (text.startsWith("select array(select distinct one from")) return [{ ids: [COLLEAGUE, PERSON] }];
    if (text.startsWith("select e.id, exists (select 1 from knowledge.captures k"))
      return (values[0] as string[]).map((id) => ({
        id,
        agent: false,
        domain: "domain-1",
        thread: "thread-1",
        auth: "pass",
        flagged: id === LEFT,
        organizations: [],
      }));
    if (text.startsWith("select distinct value_fp from knowledge.accounts")) return [{ value_fp: "fp-person" }];
    if (text.startsWith("select id, evidence_id, fact_key_fp, compartments, content_enc from knowledge.claims"))
      return (values[0] as string[]).includes(CLAIMED)
        ? [
            {
              id: "clm_1",
              evidence_id: CLAIMED,
              fact_key_fp: "f".repeat(64),
              compartments: LABEL,
              content_enc: sealed("knowledge.claims", "clm_1", "content_enc", JSON.stringify(claimed())),
            },
          ]
        : [];
    if (text.startsWith("select distinct entity_id from knowledge.accounts")) return [{ entity_id: PERSON }];
    if (text.startsWith("select id, compartments, body_enc from knowledge.messages"))
      return [
        {
          id: MESSAGE,
          compartments: LABEL,
          body_enc: sealed("knowledge.messages", MESSAGE, "body_enc", "Yes, gladly."),
        },
      ];
    if (text.startsWith("insert into ledger.outcome_checks")) return [{ id: "1" }];
    return [];
  }) as Query;
  return sent;
}

const quiet = { info() {}, warn() {}, error() {} } as never;
const store = () => createOutcomeStore({ url: "postgres://unused", keys, log: quiet, judgeGapDefaults: true });

describe("the outcome store's jobs and save, each statement in order", () => {
  it("with the judging of gap work off, code-raised work's default expectations reach no judge", async () => {
    database();
    await createOutcomeStore({ url: "postgres://unused", keys, log: quiet }).jobs(JUDGE, NOW, {
      calls: 4,
      callsPerDay: 100,
    });
    expect(channelWorks).toEqual([CLOSED]);
    database();
    await store().jobs(JUDGE, NOW, { calls: 4, callsPerDay: 100 });
    expect(channelWorks).toEqual([WORK, CLOSED]);
  });

  it("jobs finds on each path, builds while the calls reach, and defers the rest", async () => {
    const sent = database();
    const outcomes = store();
    const found = await outcomes.jobs(JUDGE, NOW, { calls: 4, callsPerDay: 100 });
    expect(sent).toEqual(EXPECTED.jobs);
    expect(found.calls).toBe(4);
    expect([...found.checked]).toEqual([`11\n${JUDGED}`]);
    expect(
      found.candidates.map((one) => ({ ...one, item: { ...one.item, claimKey: one.item.claimKey !== null } })),
    ).toEqual(CANDIDATES);
    expect(found.deferred).toEqual(DEFERRED);

    const sentBefore = sent.length;
    const run: OutcomeRunRow = {
      links: [
        {
          expectationId: "11",
          opportunityId: WORK,
          evidenceId: REPLY,
          claimKey: null,
          kind: "met",
          path: "watched",
          judge: JUDGE,
          attribution: "caused",
          passage: { start: 0, end: 4 },
          applied: false,
          compartments: ["own", "own"],
        },
        { ...({} as OutcomeRunRow["links"][number]), compartments: ["restricted:health"] },
      ],
      checks: [
        { ...(found.deferred[0] as OutcomeRunRow["checks"][number]) },
        {
          expectationId: "12",
          evidenceId: CLAIMED,
          claimKey: "k",
          path: "open",
          state: "judged",
          firstAnswer: "met",
          secondAnswer: "met",
          agreed: true,
          written: "met",
          code: null,
          compartments: LABEL,
        },
        { ...(found.deferred[0] as OutcomeRunRow["checks"][number]), compartments: ["restricted:health"] },
      ],
    };
    const values: unknown[][] = [];
    const recording = fake.query as Query;
    fake.query = ((sql: string, params?: unknown[]) => {
      values.push(params ?? []);
      return recording(sql, params);
    }) as Query;
    expect(await outcomes.save(run, JUDGE)).toEqual({ links: 1, checks: 2 });
    expect(sent.slice(sentBefore)).toEqual(EXPECTED.save);
    expect(values).toEqual(SAVED);
    await outcomes.close();
  });

  it("subjectOf is facts: and the two keyed fingerprints, in order", () => {
    const outcomes = store();
    const subject = outcomes.subjectOf({
      expectation: { id: "11" } as never,
      item: { evidenceId: REPLY } as never,
    });
    expect(subject).toMatch(/^facts:[0-9a-f]{64}:[0-9a-f]{64}$/);
    const [, a, b] = subject.split(":") as [string, string, string];
    expect(a < b).toBe(true);
  });
});

// What jobs and save sent, found and built, read off createOutcomeStore before its methods were
// split into named steps.
const EXPECTED: Record<string, string[]> = {
  jobs: [
    "select (select count(*) from ledger.relation_checks where sp #612b8359",
    "select distinct opportunity_id from ledger.expected_outcomes #74ad48cb",
    "select * from ledger.outcome_channels($1::text[], $2::timest #21b305de",
    "select x.id::text as id, x.opportunity_id, x.ordinal, x.subj #6b7e6abd",
    "select distinct on (expected_outcome_id, evidence_id) expect #2f7b9462",
    "select e.id from vault.evidence_items e join knowledge.messa #14671292",
    "select e.id as evidence_id, e.source_account_id as account_i #6410bfc6",
    "select m.evidence_id as id from knowledge.messages m join kn #5dad2c4f",
    "select e.id as evidence_id, e.source_account_id as account_i #6410bfc6",
    "select d.evidence_id as id from knowledge.documents w join k #b0d4f47b",
    "select e.id as evidence_id, e.source_account_id as account_i #6410bfc6",
    "select c.id, c.evidence_id, c.fact_key_fp, c.compartments, c #02383f6a",
    "select array(select distinct one from ( select unnest($1::te #cfd6b459",
    "select e.id, exists (select 1 from knowledge.captures k wher #3fa96023",
    "select e.id as evidence_id, e.source_account_id as account_i #6410bfc6",
    "select distinct value_fp from knowledge.accounts where entit #5eba63e9",
    "select id, evidence_id, fact_key_fp, compartments, content_e #64d49891",
    "select id, evidence_id, fact_key_fp, compartments, content_e #64d49891",
    "select distinct entity_id from knowledge.accounts where valu #f15a354a",
    "select id, compartments, body_enc from knowledge.messages wh #4b0cd1c3",
    "select id, evidence_id, fact_key_fp, compartments, content_e #64d49891",
    "select id, compartments, held, subject_enc, body_enc from kn #4539a6bd",
    "select blob_ref, compartments, source_kind from vault.eviden #4a2783ba",
  ],
  save: [
    "insert into ledger.outcome_links (opportunity_id, expected_o #52729635",
    "insert into ledger.outcome_checks (expected_outcome_id, evid #32816bc3",
    "insert into ledger.outcome_checks (expected_outcome_id, evid #32816bc3",
  ],
};
const CANDIDATES: unknown[] = [
  {
    expectation: {
      id: "12",
      opportunityId: WORK,
      type: "role",
      success: "title: Lead",
      failure: null,
      person: false,
      compartments: ["own"],
    },
    item: {
      evidenceId: LEFT,
      claimKey: false,
      passage: null,
      at: "2026-09-12T00:00:00.000Z",
      compartments: ["own"],
      flagged: true,
      fromPerson: false,
      firstHand: false,
      decline: false,
      reply: false,
      afterMove: true,
      source: {
        item: LEFT,
        domain: "domain-1",
        thread: "thread-1",
        agent: false,
        firstHand: false,
        authenticated: true,
        domainMatches: false,
        at: "2026-09-12T00:00:00.000Z",
        flagged: true,
      },
    },
    path: "open",
    unjudged: true,
  },
  {
    expectation: {
      id: "11",
      opportunityId: WORK,
      type: "answered",
      success: null,
      failure: null,
      person: true,
      compartments: ["own"],
    },
    item: {
      evidenceId: REPLY,
      claimKey: false,
      passage: "Yes, gladly.",
      at: "2026-09-10T00:00:00.000Z",
      compartments: ["own"],
      flagged: false,
      fromPerson: true,
      firstHand: false,
      decline: false,
      reply: true,
      afterMove: true,
      source: {
        item: REPLY,
        domain: "domain-1",
        thread: "thread-1",
        agent: false,
        firstHand: false,
        authenticated: true,
        domainMatches: false,
        at: "2026-09-10T00:00:00.000Z",
        flagged: false,
      },
    },
    path: "watched",
    unjudged: false,
  },
  {
    expectation: {
      id: "12",
      opportunityId: WORK,
      type: "role",
      success: "title: Lead",
      failure: null,
      person: false,
      compartments: ["own"],
    },
    item: {
      evidenceId: CLAIMED,
      claimKey: true,
      passage: "what: Statement number 1.",
      at: "2026-09-01T09:00:00.000Z",
      compartments: ["own"],
      flagged: false,
      fromPerson: true,
      firstHand: true,
      decline: false,
      reply: false,
      afterMove: true,
      source: {
        item: CLAIMED,
        domain: "domain-1",
        thread: "thread-1",
        agent: false,
        firstHand: true,
        authenticated: true,
        domainMatches: false,
        at: "2026-09-01T09:00:00.000Z",
        flagged: false,
      },
    },
    path: "open",
    unjudged: false,
  },
];
const DEFERRED: unknown[] = [
  {
    expectationId: "12",
    evidenceId: REPLY,
    claimKey: null,
    path: "watched",
    state: "unjudged",
    firstAnswer: null,
    secondAnswer: null,
    agreed: null,
    written: null,
    code: null,
    compartments: ["own"],
  },
  {
    expectationId: "12",
    evidenceId: JUDGED,
    claimKey: null,
    path: "watched",
    state: "unjudged",
    firstAnswer: null,
    secondAnswer: null,
    agreed: null,
    written: null,
    code: null,
    compartments: ["own"],
  },
];
const SAVED: unknown[] = [
  [WORK, "11", REPLY, null, "met", "watched", JUDGE, "caused", 0, 4, false, ["own"]],
  ["12", REPLY, null, null, "watched", JUDGE, "unjudged", null, null, null, null, null, ["own"]],
  ["12", CLAIMED, "k", "clm_1", "open", JUDGE, "judged", "met", "met", true, "met", null, ["own"]],
];
