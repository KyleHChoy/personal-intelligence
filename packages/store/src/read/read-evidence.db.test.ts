import type { Timestamp } from "@intelligence/contracts";
import { type ClaimRecord, EvidenceSpan, MessageId, type ReadOutcome } from "@intelligence/contracts/personal";
import { passageOf } from "@intelligence/personal-core/items";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { type Accounts, connect, OWNER, type Who } from "../test-support/cast.ts";
import { one } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { ingestMail, type MailFixture, mailSourceId } from "../test-support/items.ts";
import { batchOf, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { insideHold, recordingLogger, recordingPool } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { daysFrom, evidenceIdOf, iso, outcomeValue, registration } from "../test-support/values.ts";
import type { SourceAccountRow } from "../write/writer-types.ts";
import { Reader } from "./read.ts";

// get_evidence_span. The store is seeded through the writer with hand-written facts, and claims are
// committed through the Pipeline as the extraction would, each citing a span of its message's stored
// text. Reserved domains only.

const NOW = new Date("2026-09-15T12:00:00.000Z");
const BOTH = ["own", "employer:example"];
const NOT_FOUND = { ok: false, code: "not_found" };
const NOT_PERMITTED = { ok: false, code: "not_permitted" };
const at = (days: number): Timestamp => iso(daysFrom(NOW, days));

const ME: Who = { address: OWNER.personal, name: OWNER.name };
const ME_AT_WORK: Who = { address: OWNER.work, name: OWNER.name };
const PIPPA: Who = { address: "pippa@quayside.test", name: "Pippa Quayside" };
const WREN: Who = { address: "wren@partner-example.test", name: "Wren Partnerfield" };

// The sender's words, a blank line, more of them, and a quote introduced by an address.
const REPLY =
  "Yes, Thursday works for me.\n\nI will bring the signed lease.\n\nOn Mon, pippa@quayside.test wrote:\n> Can we meet this week?";
// One segment of 101 lines, longer than a passage is served, with a character outside the basic plane.
const LONG = Array.from(
  { length: 101 },
  (_, n) => `Line ${String(n).padStart(3, "0")} of the long note \u{1F600} goes on for a while.`,
).join("\n");

const reply: MailFixture = {
  id: "span-reply",
  threadId: "thread-span-reply",
  at: at(-3),
  from: PIPPA,
  to: [ME],
  subject: "Lease",
  labels: ["INBOX"],
  text: REPLY,
};
const long: MailFixture = {
  id: "span-long",
  threadId: "thread-span-long",
  at: at(-2),
  from: PIPPA,
  to: [ME],
  subject: "Notes",
  labels: ["INBOX"],
  text: LONG,
};
const held: MailFixture = {
  id: "span-held",
  threadId: "thread-span-held",
  at: at(-2),
  from: PIPPA,
  to: [ME],
  subject: "Your code",
  labels: ["INBOX"],
  text: "Your code is 482913.",
  held: true,
};
const work: MailFixture = {
  id: "span-work",
  threadId: "thread-span-work",
  at: at(-1),
  from: WREN,
  to: [ME_AT_WORK],
  subject: "Budget",
  labels: ["INBOX"],
  text: "The budget is approved.",
};

// A fact of a message, as the extraction would commit it: one claim citing `span`.
type Fact = { id: string; evidenceId: string; message: MessageId; span: string; fixture: MailFixture };

let store: TestStore;
let accounts: Accounts;
const facts: Record<"first" | "subject" | "long" | "quote" | "held" | "work", Fact> = {} as never;

async function messageIdOf(evidenceId: string): Promise<MessageId> {
  return MessageId.parse(
    one(
      await queryAs<{ id: string }>(store.db.urls.admin, "select id from knowledge.messages where evidence_id = $1", [
        evidenceId,
      ]),
    ).id,
  );
}

// One claim per span, each its own fact, committed for the message's evidence row in one batch.
async function commitFacts(
  account: SourceAccountRow,
  fixture: MailFixture,
  compartment: string,
  owner: string,
  spans: [keyof typeof facts, string][],
): Promise<void> {
  const evidenceId = evidenceIdOf(account, mailSourceId(fixture));
  const records = spans.map(([name, span], index): ClaimRecord => {
    const record = claimRecord(evidenceId, compartment, owner, { n: index + 1, factKey: `k-span-${name}` });
    return { ...record, claim: { ...record.claim, evidence: [{ evidenceId, span }] } } as ClaimRecord;
  });
  const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
  try {
    expect(await pipeline.commit(batchOf(evidenceId, records))).toBe("committed");
  } finally {
    await pipeline.close();
  }
  const message = await messageIdOf(evidenceId);
  for (const [index, [name, span]] of spans.entries()) {
    // A fact's id is its stored claim id, the claim id's `claim` fingerprint (the Pipeline's commit).
    facts[name] = {
      id: fingerprint(store.db.keys, "claim", (records[index] as ClaimRecord).claim.id),
      evidenceId,
      message,
      span,
      fixture,
    };
  }
}

beforeAll(async () => {
  store = await openStore({ now: NOW });
  accounts = await connect(store.writer);
  for (const fixture of [reply, long, held])
    expect(await ingestMail(store.writer, accounts.personalMail, fixture), fixture.id).toBe("stored");
  expect(await ingestMail(store.writer, accounts.workMail, work), work.id).toBe("stored");
  const owner = one(
    await queryAs<{ id: string }>(store.db.urls.admin, "select id from knowledge.entities where kind = 'owner'"),
  ).id;
  const quote = REPLY.indexOf("> Can");
  await commitFacts(accounts.personalMail, reply, "own", owner, [
    ["first", "chars:0-27"],
    ["subject", "subject:chars:0-5"],
    ["quote", `chars:${quote}-${REPLY.length}`],
  ]);
  await commitFacts(accounts.personalMail, long, "own", owner, [["long", "chars:0-12"]]);
  await commitFacts(accounts.personalMail, held, "own", owner, [["held", "chars:0-12"]]);
  await commitFacts(accounts.workMail, work, "employer:example", owner, [["work", "chars:0-10"]]);
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await store.close();
});

let serial = 0;
async function client(
  compartments: string[],
  views: ("self" | "people" | "work")[] = ["self", "people"],
): Promise<{ token: string; id: string; name: string }> {
  serial += 1;
  const name = `span-client-${serial}`;
  const { token } = await store.admin.clients.addClient(
    registration(name, compartments, { views, tools: ["get_self", "get_evidence_span"] }),
  );
  const id = (await store.admin.clients.listClients()).find((row) => row.name === name)?.id;
  if (id === undefined) throw new Error("no client");
  return { token, id, name };
}

function recordingReader() {
  const recorded = recordingPool(store.readerPool);
  const reader = new Reader({ pool: recorded.pool, keys: store.db.keys, log: store.log, now: () => store.now });
  const during = async <T>(run: () => Promise<T>): Promise<{ answer: T; statements: string[] }> => {
    recorded.statements.length = 0;
    const answer = await run();
    // Inside the taint lock's hold every read call takes around its transaction (FE1); a call
    // refused before any statement has neither.
    return { answer, statements: recorded.statements.length === 0 ? [] : insideHold([...recorded.statements]) };
  };
  return { reader, during };
}

const callsOf = (id: string): Promise<{ tool: string; rows: number; outcome: string; chars: number }[]> =>
  queryAs(
    store.db.urls.admin,
    "select tool, rows, outcome, chars::int as chars from policy.calls where client_id = $1 order by id",
    [id],
  );
const readLogOf = (id: string): Promise<{ tool: string; bound: string[]; shown: string[]; fact_key_fps: string[] }[]> =>
  queryAs(
    store.db.urls.admin,
    "select tool, bound, shown, fact_key_fps from ledger.read_log where client_id = $1 order by id",
    [id],
  );
const factKeyOf = async (fact: Fact): Promise<string> =>
  one(
    await queryAs<{ fact_key_fp: string }>(
      store.db.urls.admin,
      "select fact_key_fp from knowledge.claims where id = $1",
      [fact.id],
    ),
  ).fact_key_fp;

const span = async (token: string, fact: string): Promise<ReadOutcome<EvidenceSpan>> =>
  store.reader.getEvidenceSpan(token, { fact });
const points = (text: string): string[] => Array.from(text);

describe("get_evidence_span", { timeout: DB_TEST_TIMEOUT }, () => {
  it("returns exactly the cited segment for each fact, from the fact's own message", async () => {
    const wide = await client(BOTH);
    for (const name of ["first", "subject", "work"] as const) {
      const fact = facts[name];
      const expected = await passageOf(
        { body: fact.fixture.text ?? null, subject: fact.fixture.subject ?? null },
        fact.span,
      );
      if (expected === null) throw new Error(`no passage for ${name}`);
      const value = EvidenceSpan.parse(outcomeValue(await span(wide.token, fact.id)));
      expect(value, name).toEqual({
        fact: fact.id,
        source: { kind: "message", id: fact.message },
        passage: { untrusted: expected },
        chars: points(expected).length,
        cut: false,
      });
    }
    // Not vacuous: the sender's two paragraphs are one segment, and the quote and its
    // introduction are not in it.
    expect(outcomeValue(await span(wide.token, facts.first.id)).passage).toEqual({
      untrusted: "Yes, Thursday works for me.\n\nI will bring the signed lease.",
    });
    expect(outcomeValue(await span(wide.token, facts.subject.id)).passage).toEqual({ untrusted: "Lease" });
    // A span in the quote is no fact's, and has no passage.
    expect(outcomeValue(await span(wide.token, facts.quote.id))).toMatchObject({
      source: { kind: "message" },
      passage: null,
      chars: 0,
    });
  });

  it("a belief line's fact answers with its claim's passage, and an absent one still answers not_found", async () => {
    const wide = await client(BOTH);
    const fact = facts.first;
    const [row] = await queryAs<{ fact_key_fp: string }>(
      store.db.urls.admin,
      "select fact_key_fp from knowledge.claims where id = $1",
      [fact.id],
    );
    if (row === undefined) throw new Error("no claim");
    const value = EvidenceSpan.parse(outcomeValue(await span(wide.token, row.fact_key_fp)));
    expect(value.source).toEqual({ kind: "message", id: fact.message });
    expect(await span(wide.token, "f".repeat(64))).toEqual(NOT_FOUND);
  });

  it("the passage is cut at 4 000 code points; chars is the whole passage's in the value and the served length in the call log", async () => {
    const wide = await client(BOTH);
    const value = outcomeValue(await span(wide.token, facts.long.id));
    expect(value.cut).toBe(true);
    expect(value.chars).toBe(points(LONG).length);
    expect(points(value.passage?.untrusted ?? "")).toEqual(points(LONG).slice(0, 4000));
    expect(await callsOf(wide.id)).toEqual([{ tool: "get_evidence_span", rows: 1, outcome: "ok", chars: 4000 }]);
  });

  it("chars is the served length and bound holds the source", async () => {
    const wide = await client(BOTH);
    const value = outcomeValue(await span(wide.token, facts.first.id));
    expect(await callsOf(wide.id)).toEqual([{ tool: "get_evidence_span", rows: 1, outcome: "ok", chars: value.chars }]);
    expect(await readLogOf(wide.id)).toEqual([
      {
        tool: "get_evidence_span",
        bound: [facts.first.evidenceId],
        shown: [],
        fact_key_fps: [await factKeyOf(facts.first)],
      },
    ]);
  });

  it("the passage is under untrusted", async () => {
    const wide = await client(BOTH);
    const value = outcomeValue(await span(wide.token, facts.first.id));
    expect(Object.keys(value.passage ?? {})).toEqual(["untrusted"]);
    expect(EvidenceSpan.safeParse({ ...value, passage: value.passage?.untrusted }).success).toBe(false);
  });

  it("a hidden fact, a fact of a held message and an absent id answer the same bytes and statements", async () => {
    const ownOnly = await client(["own"]);
    const wide = await client(BOTH);
    const { reader, during } = recordingReader();
    const absent = "f".repeat(64);
    const cases: [string, string, string][] = [
      ["hidden", ownOnly.token, facts.work.id],
      ["held", wide.token, facts.held.id],
      ["absent to the narrow client", ownOnly.token, absent],
      ["absent to the wide client", wide.token, absent],
    ];
    const seen: { answer: string; statements: string[] }[] = [];
    for (const [name, token, fact] of cases) {
      const { answer, statements } = await during(() => reader.getEvidenceSpan(token, { fact }));
      expect(answer, name).toEqual(NOT_FOUND);
      seen.push({ answer: JSON.stringify(answer), statements });
    }
    for (const one of seen) expect(one).toEqual(seen[0]);
    // The positive controls: each client reads a fact it can see, after the same statements.
    const visible = await during(() => reader.getEvidenceSpan(ownOnly.token, { fact: facts.first.id }));
    expect(visible.answer.ok).toBe(true);
    // Those with no passage send one statement more, whatever the id: where the fact came from.
    expect(visible.statements.slice(0, (seen[0]?.statements.length ?? 0) - 3)).toEqual(
      seen[0]?.statements.slice(0, -3),
    );
    expect((await reader.getEvidenceSpan(wide.token, { fact: facts.work.id })).ok).toBe(true);
    // A refusal logs no read.
    expect(await readLogOf(ownOnly.id)).toHaveLength(1);
    expect((await callsOf(ownOnly.id)).map((row) => [row.outcome, row.rows, row.chars])).toEqual([
      ["not_found", 0, 0],
      ["not_found", 0, 0],
      ["ok", 1, (outcomeValue(visible.answer) as EvidenceSpan).chars],
    ]);
  });

  it("a client without people is refused and recorded", async () => {
    const selfOnly = await client(BOTH, ["self"]);
    const { reader, during } = recordingReader();
    const { answer, statements } = await during(() => reader.getEvidenceSpan(selfOnly.token, { fact: facts.first.id }));
    expect(answer).toEqual(NOT_PERMITTED);
    expect(statements.some((text) => /knowledge\./i.test(text))).toBe(false);
    expect(await callsOf(selfOnly.id)).toEqual([
      { tool: "get_evidence_span", rows: 0, outcome: "not_permitted", chars: 0 },
    ]);
    // The control: the same registration with people reads it.
    const people = await client(BOTH);
    expect((await span(people.token, facts.first.id)).ok).toBe(true);
  });
});
