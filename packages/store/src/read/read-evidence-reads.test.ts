import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MessageId, NO_PASSAGE, type SessionId } from "@intelligence/contracts/personal";
import { passageOf } from "@intelligence/personal-core/items";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyFile, type Keys, loadKeys } from "../core/keys.ts";
import { type Ctx, Unavailable } from "../core/read-ctx.ts";
import { sealUnder } from "../core/seal.ts";
import { claimRecord } from "../test-support/pipeline-fixtures.ts";
import { log } from "../test-support/unit.ts";
import { EVIDENCE_SPAN, evidenceSpanOf, getEvidenceSpan } from "./read-evidence.ts";
import { readItem, THREAD_NAMED, THREAD_PAGE } from "./read-thread.ts";

// What get_evidence_span and read_item make of the rows their statements return, on a fake statement
// runner that answers as the row policy would. Which rows a token is given, and the statements' text,
// are the database tests' (read-evidence.db.test.ts, read-thread.db.test.ts).

let dir = "";
let keys: Keys;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-evidence-reads-"));
  await generateKeyFile(join(dir, "keys.json"), ["own"]);
  keys = await loadKeys(join(dir, "keys.json"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const OWN = ["own"];
const ulid = (n: number): string => String(n).padStart(26, "0");
const seal = (table: string, id: string, column: string, value: string) =>
  sealUnder(keys, OWN, { table, id, column }, value);

// A fake runner: each statement answers the rows given for it, and every statement is kept.
// The passage alone, past the pointer that a fact with none falls back to.
const passageFor = async (ctx: Ctx, args: Parameters<typeof evidenceSpanOf>[1]) =>
  (await evidenceSpanOf(ctx, args))?.found ?? null;

function fakeCtx(answer: (text: string, values: unknown[]) => unknown[]): {
  ctx: Ctx;
  sent: { text: string; values: unknown[] }[];
} {
  const sent: { text: string; values: unknown[] }[] = [];
  const ctx: Ctx = {
    run: async <Row>(text: string, values: unknown[]) => {
      sent.push({ text, values });
      return answer(text, values) as Row[];
    },
    keys,
    session: async () => "ses_x" as SessionId,
    log,
  };
  return { ctx, sent };
}

// A message row as the reader's summary columns give it, with its body.
function messageRow(n: number, text: string | null, at: string) {
  const id = `msg_${ulid(n)}`;
  const facts = JSON.stringify({
    chars: text === null ? 0 : Array.from(text).length,
    unreadable: false,
    attachments: [],
  });
  return {
    id,
    sent_at: new Date(at),
    direction: "inbound",
    bulk: false,
    category: "primary",
    subject_enc: seal("knowledge.messages", id, "subject_enc", `Subject ${n}`),
    sender_enc: null,
    sender_name_enc: null,
    facts_enc: seal("knowledge.messages", id, "facts_enc", facts),
    compartments: OWN,
    evidence_id: String(n).padStart(64, "e"),
    body_enc: text === null ? null : seal("knowledge.messages", id, "body_enc", text),
  };
}

describe("get_evidence_span", () => {
  const BODY =
    "Yes, Thursday works for me.\nI will bring the lease.\n\nOn Mon, pippa@quayside.test wrote:\n> Can we meet?";
  const LONG = Array.from({ length: 120 }, (_, n) => `Line ${n} of the note \u{1F600} runs on a while.`).join("\n");
  const EVIDENCE = "e".repeat(64);
  const MESSAGE = `msg_${ulid(1)}`;

  // The row the statement returns for a fact citing `span` of a message holding `body`.
  function spanRow(body: string | null, span: string) {
    const made = claimRecord(EVIDENCE, "own", `ent_${ulid(2)}`, { factKey: "k-unit" });
    const record = { ...made, claim: { ...made.claim, evidence: [{ evidenceId: EVIDENCE, span }] } };
    return {
      id: made.claim.id,
      fact_key_fp: "f".repeat(64),
      content_enc: seal("knowledge.claims", made.claim.id, "content_enc", JSON.stringify(record)),
      compartments: OWN,
      message_id: MESSAGE,
      evidence_id: EVIDENCE,
      message_compartments: OWN,
      subject_enc: seal("knowledge.messages", MESSAGE, "subject_enc", "Lease"),
      body_enc: body === null ? null : seal("knowledge.messages", MESSAGE, "body_enc", body),
      record_id: null,
      record_compartments: null,
      record_body_enc: null,
    };
  }

  // The row for a finding's fact: no message, the agent record's body instead.
  const RECORD = `rec_${ulid(7)}`;
  function recordRow(body: string | null, span: string) {
    return {
      ...spanRow(null, span),
      message_id: null,
      message_compartments: null,
      subject_enc: null,
      record_id: RECORD,
      record_compartments: OWN,
      record_body_enc: body === null ? null : seal("ledger.agent_writes", RECORD, "body_enc", body),
    };
  }

  it("a finding's fact gives its agent record's whole body, shown and never bound", async () => {
    const body = "Rhea will send the owner the plans by Friday.";
    const row = recordRow(body, "chars:0-4");
    const { ctx, sent } = fakeCtx(() => [row]);
    const found = await getEvidenceSpan(ctx, { fact: row.id });
    expect(found?.value).toEqual({
      fact: row.id,
      source: { kind: "record", id: RECORD },
      passage: { untrusted: body },
      chars: body.length,
      cut: false,
    });
    expect(sent).toEqual([{ text: EVIDENCE_SPAN, values: [row.id] }]);
    // No bound entry is ever an agent record's: the record is shown.
    expect(found?.read).toEqual({ bound: [], shown: [RECORD], factKeyFps: ["f".repeat(64)] });
    expect(found?.chars).toBe(body.length);
    // A removed record, and a span past its body, have no passage.
    expect(await passageFor(fakeCtx(() => [recordRow(null, "chars:0-4")]).ctx, { fact: row.id })).toBeNull();
    expect(
      await passageFor(fakeCtx(() => [recordRow(body, `chars:0-${body.length + 1}`)]).ctx, { fact: row.id }),
    ).toBeNull();
    // A body that does not open is a stored value that does not open.
    const sealedElsewhere = {
      ...recordRow(body, "chars:0-4"),
      record_body_enc: seal("ledger.agent_writes", `rec_${ulid(8)}`, "body_enc", body),
    };
    await expect(getEvidenceSpan(fakeCtx(() => [sealedElsewhere]).ctx, { fact: row.id })).rejects.toBeInstanceOf(
      Unavailable,
    );
  });

  it("get_evidence_span serves the passage of one fact the caller can see, from its own message", async () => {
    const row = spanRow(BODY, "chars:28-51");
    const { ctx, sent } = fakeCtx(() => [row]);
    const found = await getEvidenceSpan(ctx, { fact: row.id });
    const passage = "Yes, Thursday works for me.\nI will bring the lease.";
    expect(found?.value).toEqual({
      fact: row.id,
      source: { kind: "message", id: MESSAGE },
      passage: { untrusted: passage },
      chars: passage.length,
      cut: false,
    });
    expect(await passageOf({ body: BODY, subject: "Lease" }, "chars:28-51")).toBe(passage);
    // One statement, with the fact's id; the source is bound, and the fact's key is logged.
    expect(sent).toEqual([{ text: EVIDENCE_SPAN, values: [row.id] }]);
    expect(found?.read).toEqual({ bound: [EVIDENCE], shown: [], factKeyFps: ["f".repeat(64)] });
    expect(found?.rows).toBe(1);
    expect(found?.chars).toBe(passage.length);
    expect(
      (await getEvidenceSpan(fakeCtx(() => [spanRow(BODY, "subject:chars:0-5")]).ctx, { fact: row.id }))?.value.passage,
    ).toEqual({ untrusted: "Lease" });
  });

  it("a passage is cut at 4 000 code points, never inside a character; chars is the whole one's", async () => {
    const found = await getEvidenceSpan(fakeCtx(() => [spanRow(LONG, "chars:0-4")]).ctx, { fact: "c".repeat(64) });
    expect(found?.value.cut).toBe(true);
    expect(found?.value.chars).toBe(Array.from(LONG).length);
    expect(Array.from(found?.value.passage?.untrusted ?? "")).toEqual(Array.from(LONG).slice(0, 4_000));
    expect(found?.chars).toBe(4_000);
  });

  it("no row, a span the store keeps no text for, and a span past the text answer null", async () => {
    expect(await passageFor(fakeCtx(() => []).ctx, { fact: "c".repeat(64) })).toBeNull();
    expect(
      await passageFor(fakeCtx(() => [spanRow(BODY, "attachment:0:chars:0-5")]).ctx, { fact: "c".repeat(64) }),
    ).toBeNull();
    expect(await passageFor(fakeCtx(() => [spanRow(BODY, "chars:500-510")]).ctx, { fact: "c".repeat(64) })).toBeNull();
    expect(await passageFor(fakeCtx(() => [spanRow(null, "chars:0-5")]).ctx, { fact: "c".repeat(64) })).toBeNull();
  });

  it("a fact with no passage answers its source and no text; none at all answers null", async () => {
    const pointer = {
      id: "c".repeat(64),
      fact_key_fp: "f".repeat(64),
      content_enc: null,
      compartments: ["own"],
      evidence_id: "evd_x",
      message_id: null,
      document_id: null,
      page_id: null,
      capture_id: null,
      capture_kind: null,
      capture_source: null,
      record_id: null,
      contact: false,
    };
    const only = (row: object) => fakeCtx((text) => (text === EVIDENCE_SPAN ? [] : [row])).ctx;
    const doc = `doc_${ulid(5)}`;
    const found = await getEvidenceSpan(only({ ...pointer, document_id: doc }), { fact: "c".repeat(64) });
    expect(found?.value).toEqual({
      fact: "c".repeat(64),
      source: { kind: "document", id: doc },
      passage: null,
      chars: 0,
      cut: false,
      noPassage: NO_PASSAGE.document,
    });
    // Reading no text binds nothing, so it counts as reading no source; what it points at is shown.
    expect(found?.read).toEqual({ bound: [], shown: ["evd_x"], factKeyFps: ["f".repeat(64)] });
    const meeting = seal("knowledge.claims", pointer.id, "content_enc", "{}");
    // A meeting fact whose claim cites no turn names its meeting, which read_meeting opens.
    const unspanned = await getEvidenceSpan(
      only({ ...pointer, capture_id: `cap_${ulid(6)}`, capture_kind: "meeting", content_enc: meeting }),
      { fact: "c".repeat(64) },
    );
    expect(unspanned?.value.source).toEqual({ kind: "meeting", id: `cap_${ulid(6)}` });
    expect(unspanned?.value.noPassage).toBe(NO_PASSAGE.meeting);
    // A chat's fact: no passage, its kind, and word of why, never a not_found.
    const chat = await getEvidenceSpan(
      only({
        ...pointer,
        capture_id: `cap_${ulid(7)}`,
        capture_kind: "moment",
        capture_source: "imessage",
        content_enc: meeting,
      }),
      { fact: "c".repeat(64) },
    );
    expect(chat?.value).toMatchObject({ passage: null, source: { kind: "elsewhere", from: "messages" } });
    expect(chat?.value.noPassage).toContain("not served");
    expect(await getEvidenceSpan(fakeCtx(() => []).ctx, { fact: "c".repeat(64) })).toBeNull();
  });

  it("a span of the subject or of an attachment opens no body", async () => {
    // A body that does not open: reaching for it would answer unavailable.
    const sealedWrongly = { body_enc: seal("knowledge.messages", `msg_${ulid(7)}`, "body_enc", BODY) };
    const subject = await getEvidenceSpan(
      fakeCtx(() => [{ ...spanRow(BODY, "subject:chars:0-5"), ...sealedWrongly }]).ctx,
      { fact: "c".repeat(64) },
    );
    expect(subject?.value.passage).toEqual({ untrusted: "Lease" });
    expect(
      await passageFor(fakeCtx(() => [{ ...spanRow(BODY, "attachment:0:chars:0-5"), ...sealedWrongly }]).ctx, {
        fact: "c".repeat(64),
      }),
    ).toBeNull();
    // The control: a body span reaches for the body, which does not open.
    await expect(
      getEvidenceSpan(fakeCtx(() => [{ ...spanRow(BODY, "chars:0-5"), ...sealedWrongly }]).ctx, {
        fact: "c".repeat(64),
      }),
    ).rejects.toBeInstanceOf(Unavailable);
  });

  it("the span is the one of the passage that cites the fact's own message, and a claim with none does not open", async () => {
    const made = claimRecord(EVIDENCE, "own", `ent_${ulid(2)}`, { factKey: "k-unit" });
    const other = "d".repeat(64);
    const record = {
      ...made,
      claim: {
        ...made.claim,
        evidence: [
          { evidenceId: other, span: "chars:0-3" },
          { evidenceId: EVIDENCE, span: "subject:chars:0-5" },
        ],
      },
    };
    const row = {
      ...spanRow(BODY, "chars:0-3"),
      content_enc: seal("knowledge.claims", made.claim.id, "content_enc", JSON.stringify(record)),
    };
    expect((await getEvidenceSpan(fakeCtx(() => [row]).ctx, { fact: row.id }))?.value.passage).toEqual({
      untrusted: "Lease",
    });
    const elsewhere = {
      ...made,
      claim: { ...made.claim, evidence: [{ evidenceId: other, span: "chars:0-3" }], primaryEvidenceId: other },
    };
    const none = {
      ...row,
      content_enc: seal("knowledge.claims", made.claim.id, "content_enc", JSON.stringify(elsewhere)),
    };
    await expect(getEvidenceSpan(fakeCtx(() => [none]).ctx, { fact: row.id })).rejects.toBeInstanceOf(Unavailable);
  });

  it("a claim record that does not read is a stored value that does not open", async () => {
    const row = {
      ...spanRow(BODY, "chars:0-5"),
      content_enc: seal("knowledge.claims", "c".repeat(64), "content_enc", "{}"),
    };
    await expect(
      getEvidenceSpan(fakeCtx(() => [{ ...row, id: "c".repeat(64) }]).ctx, { fact: "c".repeat(64) }),
    ).rejects.toBeInstanceOf(Unavailable);
  });
});

describe("read_item", () => {
  const named = (thread: string | null) => ({
    id: `msg_${ulid(1)}`,
    thread_fp: thread,
    compartments: OWN,
    thread_id_enc: thread === null ? null : seal("knowledge.messages", `msg_${ulid(1)}`, "thread_id_enc", "thread-1"),
  });

  // A thread of `rows`, served as the page statement would from its offset and limit.
  function thread(rows: ReturnType<typeof messageRow>[], name = named("fp")) {
    return fakeCtx((text, values) => {
      if (text === THREAD_NAMED) return [name];
      if (text === THREAD_PAGE) return rows.slice(values[3] as number, (values[3] as number) + (values[4] as number));
      throw new Error("an unexpected statement");
    });
  }

  it("read_item serves the visible messages of one thread, oldest first, each with its summary and text", async () => {
    const rows = [
      messageRow(1, "first", "2026-09-10T09:00:00Z"),
      messageRow(2, null, "2026-09-11T09:00:00Z"),
      messageRow(3, "third \u{1F600}", "2026-09-12T09:00:00Z"),
    ];
    const { ctx, sent } = thread(rows);
    const found = await readItem(ctx, { message: `msg_${ulid(1)}` as MessageId });
    expect(found?.value.thread).toEqual({ untrusted: "thread-1" });
    expect(found?.value.messages.map((one) => [one.summary.id, one.text, one.offset, one.cut])).toEqual([
      [rows[0]?.id, { untrusted: "first" }, 0, false],
      [rows[1]?.id, null, 0, false],
      [rows[2]?.id, { untrusted: "third \u{1F600}" }, 0, false],
    ]);
    expect(found?.value.messages[0]?.summary).toMatchObject({
      subject: { untrusted: "Subject 1" },
      chars: 5,
      attachments: 0,
    });
    expect(found?.value.next).toBeNull();
    // The thread by the named message's fingerprint and compartments, from 0, 21 rows asked.
    expect(sent.map((one) => one.text)).toEqual([THREAD_NAMED, THREAD_PAGE]);
    expect(sent[1]?.values).toEqual(["fp", OWN, `msg_${ulid(1)}`, 0, 21]);
    // A served text is bound, a message with none only shown; code points, not UTF-16 units.
    expect(found?.read).toEqual({
      bound: [rows[0]?.evidence_id, rows[2]?.evidence_id],
      shown: [rows[1]?.evidence_id],
      factKeyFps: [],
    });
    expect(found?.chars).toBe(5 + 7);
    expect(found?.rows).toBe(3);
  });

  it("a message the token does not return answers null after one statement", async () => {
    const { ctx, sent } = fakeCtx(() => []);
    expect(await readItem(ctx, { message: `msg_${ulid(9)}` as MessageId })).toBeNull();
    expect(sent.map((one) => one.text)).toEqual([THREAD_NAMED]);
  });

  it("a message with no thread is a thread of one, and its thread is null", async () => {
    const rows = [messageRow(1, "alone", "2026-09-10T09:00:00Z")];
    const { ctx, sent } = thread(rows, named(null));
    const found = await readItem(ctx, { message: `msg_${ulid(1)}` as MessageId });
    expect(found?.value).toMatchObject({ thread: null, next: null });
    expect(found?.value.messages).toHaveLength(1);
    expect(sent[1]?.values.slice(0, 3)).toEqual([null, OWN, `msg_${ulid(1)}`]);
  });

  it("at most limit messages, and next is the position of the first one not served", async () => {
    const rows = Array.from({ length: 5 }, (_, n) => messageRow(n + 1, `text ${n}`, `2026-09-1${n}T09:00:00Z`));
    const page = await readItem(thread(rows).ctx, { message: `msg_${ulid(1)}` as MessageId, limit: 2 });
    expect(page?.value.messages.map((one) => one.summary.id)).toEqual([rows[0]?.id, rows[1]?.id]);
    expect(page?.value.next).toBe(2);
    const last = await readItem(thread(rows).ctx, { message: `msg_${ulid(1)}` as MessageId, from: 4, limit: 2 });
    expect(last?.value.messages.map((one) => one.summary.id)).toEqual([rows[4]?.id]);
    expect(last?.value.next).toBeNull();
  });

  it("next is never past the last position from takes, 999", async () => {
    const rows = Array.from({ length: 1_020 }, (_, n) =>
      messageRow(n + 1, null, new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString()),
    );
    const near = await readItem(thread(rows).ctx, { message: `msg_${ulid(1)}` as MessageId, from: 979 });
    expect(near?.value.messages).toHaveLength(20);
    expect(near?.value.next).toBe(999);
    // From 990, twenty more remain, but no call can ask from past 999.
    const last = await readItem(thread(rows).ctx, { message: `msg_${ulid(1)}` as MessageId, from: 990 });
    expect(last?.value.messages).toHaveLength(20);
    expect(last?.value.next).toBeNull();
  });

  it("each text is cut at 20 000 code points, and 50 000 stop the page before the message that would pass them", async () => {
    const long = (n: number): string => `${n}\u{1F600}`.repeat(12_000);
    const rows = [0, 1, 2].map((n) => messageRow(n + 1, long(n), `2026-09-1${n}T09:00:00Z`));
    const page = await readItem(thread(rows).ctx, { message: `msg_${ulid(1)}` as MessageId });
    expect(page?.value.messages).toHaveLength(2);
    for (const [n, one] of (page?.value.messages ?? []).entries()) {
      expect(Array.from(one.text?.untrusted ?? "")).toEqual(Array.from(long(n)).slice(0, 20_000));
      expect(one.cut).toBe(true);
    }
    expect(page?.value.next).toBe(2);
    expect(page?.chars).toBe(40_000);
    expect(page?.read.bound).toEqual([rows[0]?.evidence_id, rows[1]?.evidence_id]);
    const rest = await readItem(thread(rows).ctx, { message: `msg_${ulid(1)}` as MessageId, from: 2 });
    expect(rest?.value.messages.map((one) => one.summary.id)).toEqual([rows[2]?.id]);
    expect(rest?.value.next).toBeNull();
    expect(rest?.chars).toBe(20_000);
  });
});
