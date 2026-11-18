import { createHash } from "node:crypto";
import { type DraftMessageArgs, type ReadOutcome, SendPayload } from "@intelligence/contracts/personal";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { draftValues } from "../agent-writes/draft-values.ts";
import { openUnder } from "../core/seal.ts";
import { Reader } from "../read/read.ts";
import { testId } from "../test-support/clients.ts";
import { one, readAs, session } from "../test-support/connections.ts";
import { scanForPlaintext, sealRow } from "../test-support/database.ts";
import { claimRecord } from "../test-support/pipeline-fixtures.ts";
import { eventLogger, recordingPool } from "../test-support/recording.ts";
import {
  age,
  appendDraft,
  draftArgs,
  finish,
  insertAccount,
  insertMessage,
  insertPerson,
  insertSendClient,
  knownTo,
  labelOf,
  latest,
  opportunity,
  readyReply,
  recipient,
  type SendCtx,
  type Stored,
  sendNow,
  suppress,
  syncedAt,
  TIMEOUT,
  veto,
  withSendWorld,
} from "../test-support/send-fixtures.ts";
import { createWork, type Work } from "./work.ts";

// Clients, accounts, messages, vetoes and suppressions are written as the send database's tests
// write them (send-fixtures.ts). Reserved domains only.

type Drafting = { work: Work; statements: string[]; close: () => Promise<void> };

// A Reader and its Work on the reader's URL, as pi mcp builds them, every statement recorded.
function drafting(w: SendCtx): Drafting {
  const pool = new pg.Pool({ connectionString: w.db.urls.reader, max: 2, connectionTimeoutMillis: 20_000 });
  const recorded = recordingPool(pool);
  const reader = new Reader({ pool: recorded.pool, keys: w.db.keys, log: eventLogger() });
  return { work: createWork({ reader, log: eventLogger() }), statements: recorded.statements, close: () => pool.end() };
}

async function withDrafting<T>(w: SendCtx, fn: (d: Drafting) => Promise<T>): Promise<T> {
  const d = drafting(w);
  try {
    return await fn(d);
  } finally {
    await d.close();
  }
}

const drafted = (outcome: ReadOutcome<{ draft: string }>): string => {
  if (!outcome.ok) throw new Error(`expected a draft, got ${outcome.code}`);
  return outcome.value.draft;
};

const newMessage = (to: string, over: Partial<DraftMessageArgs> = {}): DraftMessageArgs => ({
  to: [to],
  subject: "A question about Tuesday",
  body: "Shall we meet on Tuesday at ten?",
  requestId: testId("req"),
  ...over,
});

type DraftRow = {
  compartments: string[];
  created_by: string;
  source_account_id: string;
  thread_fp: string | null;
  recipient_fps: string[];
  body_enc: unknown;
};
const draftRow = async (w: SendCtx, id: string): Promise<DraftRow> =>
  one(
    await w.admin<DraftRow>(
      "select compartments, created_by, source_account_id, thread_fp, recipient_fps, body_enc from ledger.drafts where id = $1",
      [id],
    ),
  );

// The draft's sealed payload, opened with the test's keys under its label.
async function payloadOf(w: SendCtx, id: string): Promise<SendPayload> {
  const row = await draftRow(w, id);
  return SendPayload.parse(
    JSON.parse(
      openUnder(w.db.keys, row.compartments, { table: "ledger.drafts", id, column: "body_enc" }, row.body_enc as never),
    ),
  );
}

const calls = (w: SendCtx): Promise<{ outcome: string; rows: number }[]> =>
  w.admin("select outcome, rows from policy.calls where client_id = $1 and tool = 'draft_message' order by id", [
    w.client.id,
  ]);
const readLog = (w: SendCtx): Promise<{ bound: string[]; shown: string[]; compartments: string[] }[]> =>
  w.admin(
    "select bound, shown, compartments from ledger.read_log where client_id = $1 and tool = 'draft_message' order by id",
    [w.client.id],
  );

// A stored message whose sealed columns the test chooses: the fixture's row, written again with
// these values (the fixture's facts hold no References and its sender is fixed).
async function storedMessage(
  w: SendCtx,
  options: {
    from?: string;
    subject?: string | null;
    thread?: string | null;
    messageId?: string | null;
    references?: string[];
    held?: boolean;
  } = {},
): Promise<Stored> {
  const from = options.from ?? "rowan@send-example.test";
  const thread = options.thread === undefined ? `thread-draft-${testId("t")}` : options.thread;
  const base = await insertMessage(w, { from, thread, held: options.held ?? false });
  const [row] = await w.admin<{ sent_at: Date; thread_fp: string | null; sender_fp: string; sender_domain_fp: string }>(
    "select sent_at, thread_fp, sender_fp, sender_domain_fp from knowledge.messages where id = $1",
    [base.id],
  );
  if (row === undefined) throw new Error("the fixture's message was not stored");
  await w.admin("delete from knowledge.messages where id = $1", [base.id]);
  const seal = (column: string, value: string) =>
    sealRow(w.db.keys, "own", { table: "knowledge.messages", id: base.id, column }, value);
  const facts = {
    chars: 10,
    unreadable: false,
    attachments: [],
    ...(options.messageId === null ? {} : { messageId: options.messageId ?? `<mid-${testId("m")}@send-example.test>` }),
    ...(options.references === undefined ? {} : { references: options.references }),
  };
  await w.admin(
    `insert into knowledge.messages (id, evidence_id, sent_at, direction, bulk, category, held, thread_fp, sender_fp, sender_domain_fp, compartments,
       subject_enc, thread_id_enc, sender_enc, body_enc, facts_enc)
     values ($1, $2, $3, 'inbound', false, 'primary', $4, $5, $6, $7, '{own}', $8, $9, $10, $11, $12)`,
    [
      base.id,
      base.evidence,
      row.sent_at,
      options.held ?? false,
      row.thread_fp,
      row.sender_fp,
      row.sender_domain_fp,
      options.subject === null ? null : seal("subject_enc", options.subject ?? "Lunch on Friday"),
      thread === null ? null : seal("thread_id_enc", thread),
      seal("sender_enc", from),
      seal("body_enc", "Are you free?"),
      seal("facts_enc", JSON.stringify(facts)),
    ],
  );
  return base;
}

describe("Work.draftMessage", { timeout: TIMEOUT }, () => {
  // A task is read-only work between agents: it drafts to no one, whatever its stage plan.
  it("a draft for a task's opportunity is refused", () =>
    withSendWorld((w) =>
      withDrafting(w, async ({ work }) => {
        const id = await opportunity(w, "investigate");
        await session(w.db.urls.bootstrap, async (query) => {
          await query("set role pi_owner");
          await query("update ledger.opportunities set tier = 'task' where id = $1", [id]);
        });
        expect(
          await work.draftMessage(w.client.token, newMessage("one@send-example.test", { opportunity: id as never })),
        ).toEqual({ ok: false, code: "invalid_request" });
        expect(await w.admin("select count(*)::int as n from ledger.drafts where opportunity_id = $1", [id])).toEqual([
          { n: 0 },
        ]);
      }),
    ));

  it("an argument named label or from is refused, and the stored label is the client's clearance", () =>
    withSendWorld(
      (w) =>
        withDrafting(w, async ({ work }) => {
          for (const extra of [{ label: ["own"] }, { from: "owner@send-home.test" }, { compartments: ["own"] }]) {
            expect(
              await work.draftMessage(w.client.token, { ...newMessage("one@send-example.test"), ...extra } as never),
            ).toEqual({ ok: false, code: "invalid_request" });
          }
          const id = drafted(await work.draftMessage(w.client.token, newMessage("one@send-example.test")));
          const row = await draftRow(w, id);
          expect(row.compartments).toEqual(labelOf(w.client.compartments));
          expect(row.created_by).toBe(`client:${w.client.id}`);
          expect(row.source_account_id).toBe(w.account.id);
          expect(row.thread_fp).toBeNull();
          expect((await payloadOf(w, id)).account).toBe(w.account.id);
        }),
      { clientCompartments: ["own", "agent:drafter"] },
    ));

  it("a draft's text, subject and addresses are in no column in plaintext", () =>
    withSendWorld((w) =>
      withDrafting(w, async ({ work }) => {
        const to = "canary-recipient-7d1e@send-example.test";
        const cc = "canary-copied-4b2a@send-example.test";
        drafted(
          await work.draftMessage(
            w.client.token,
            newMessage(to, { cc: [cc], subject: "canary subject 51c9", body: "canary body text 0e8f" }),
          ),
        );
        expect(
          await scanForPlaintext(w.db.urls.admin, [to, cc, "canary subject 51c9", "canary body text 0e8f"]),
        ).toEqual([]);
      }),
    ));

  it("a draft to a vetoed address, one to a suppressed address and one to a plain address answer the same shape, write the same calls row, send the same statements and receive the same facts", () =>
    withSendWorld((w) =>
      withDrafting(w, async ({ work, statements }) => {
        const vetoed = recipient(w.db, "vetoed@send-example.test");
        const suppressed = recipient(w.db, "suppressed@send-example.test");
        await veto(w, "person", [vetoed.fp]);
        await suppress(w, suppressed.fp);
        // A first call opens the client's session; the three after it all reuse it.
        drafted(await work.draftMessage(w.client.token, newMessage("first@send-example.test")));
        const runs: { answer: ReadOutcome<{ draft: string }>; statements: string[] }[] = [];
        for (const address of ["vetoed@send-example.test", "suppressed@send-example.test", "plain@send-example.test"]) {
          statements.length = 0;
          const answer = await work.draftMessage(w.client.token, newMessage(address));
          runs.push({ answer, statements: [...statements] });
        }
        for (const run of runs) expect(Object.keys(run.answer.ok ? run.answer.value : {})).toEqual(["draft"]);
        expect(runs[1]?.statements).toEqual(runs[0]?.statements);
        expect(runs[2]?.statements).toEqual(runs[0]?.statements);
        expect(await calls(w)).toEqual([
          { outcome: "ok", rows: 1 },
          { outcome: "ok", rows: 1 },
          { outcome: "ok", rows: 1 },
          { outcome: "ok", rows: 1 },
        ]);
        // What pi mcp received from gate_facts, asked again as the client: byte-equal.
        const asked = await Promise.all(
          runs.map(
            async (run) =>
              one(
                await readAs(w.db, w.client.token, (query) =>
                  query<{ facts: string }>("select ledger.gate_facts($1::text, 'draft')::text as facts", [
                    drafted(run.answer),
                  ]),
                ),
              ).facts,
          ),
        );
        // Asked again after the gate, the facts hold each draft's own status, which the gate set
        // (held, held, made); pi mcp received them before it, when every draft was made.
        const atDraft = asked.map((text) => {
          const facts = JSON.parse(text) as { draft: { status: string } };
          return JSON.stringify({ ...facts, draft: { ...facts.draft, status: "made" } });
        });
        expect(atDraft[1]).toBe(atDraft[0]);
        expect(atDraft[2]).toBe(atDraft[0]);
        // The stored rows differ: the vetoed and the suppressed drafts are held, the plain one made.
        expect(await Promise.all(runs.map((run) => latest(w, "draft", drafted(run.answer))))).toEqual([
          "held",
          "held",
          "made",
        ]);
      }),
    ));

  it("a reply's thread, In-Reply-To and References are the stored message's, its References cut to the last 20 with the answered id appended", () =>
    withSendWorld((w) =>
      withDrafting(w, async ({ work }) => {
        const references = Array.from({ length: 21 }, (_, n) => `<ref-${n}@send-example.test>`);
        const message = await storedMessage(w, {
          thread: "thread-gmail-17f3",
          messageId: "<answered@send-example.test>",
          references: [...references, "has space@x"],
        });
        const id = drafted(
          await work.draftMessage(w.client.token, {
            replyTo: message.id as never,
            body: "Friday works.",
            requestId: testId("req"),
          }),
        );
        const payload = await payloadOf(w, id);
        expect(payload.thread).toEqual({
          id: "thread-gmail-17f3",
          inReplyTo: "<answered@send-example.test>",
          references: [...references.slice(-19), "<answered@send-example.test>"],
        });
        expect((await draftRow(w, id)).thread_fp).toBe(message.threadFp);
      }),
    ));

  it("a reply to a message whose facts hold no messageId, and one whose sender sendAddress refuses, are invalid_request with no draft row", () =>
    withSendWorld((w) =>
      withDrafting(w, async ({ work }) => {
        const before = one(await w.admin<{ n: number }>("select count(*)::int as n from ledger.drafts")).n;
        const noId = await storedMessage(w, { messageId: null });
        const badSender = await storedMessage(w, { from: "Rowan.@send-example.test" });
        for (const message of [noId, badSender]) {
          expect(
            await work.draftMessage(w.client.token, {
              replyTo: message.id as never,
              body: "Yes.",
              requestId: testId("req"),
            }),
          ).toEqual({ ok: false, code: "invalid_request" });
        }
        expect(one(await w.admin<{ n: number }>("select count(*)::int as n from ledger.drafts")).n).toBe(before);
        // The control: a sender it accepts.
        const good = await storedMessage(w);
        drafted(
          await work.draftMessage(w.client.token, {
            replyTo: good.id as never,
            body: "Yes.",
            requestId: testId("req"),
          }),
        );
      }),
    ));

  it("a subject beside replyTo is invalid_request", () =>
    withSendWorld((w) =>
      withDrafting(w, async ({ work }) => {
        const message = await storedMessage(w);
        expect(
          await work.draftMessage(w.client.token, {
            replyTo: message.id as never,
            subject: "Re: lunch",
            body: "Yes.",
            requestId: testId("req"),
          } as never),
        ).toEqual({
          ok: false,
          code: "invalid_request",
        });
      }),
    ));

  it("a reply with no to goes to the sender of the message answered, and its subject is Re: and the stored subject, once", () =>
    withSendWorld((w) =>
      withDrafting(w, async ({ work }) => {
        const plain = await storedMessage(w, { from: "Rowan@Send-Example.test", subject: "Lunch on Friday" });
        const already = await storedMessage(w, { subject: "Re: Lunch on Friday" });
        const none = await storedMessage(w, { subject: null });
        const reply = async (message: Stored) =>
          payloadOf(
            w,
            drafted(
              await work.draftMessage(w.client.token, {
                replyTo: message.id as never,
                body: "Yes.",
                requestId: testId("req"),
              }),
            ),
          );
        const first = await reply(plain);
        expect(first.to).toEqual(["rowan@send-example.test"]);
        expect(first.subject).toBe("Re: Lunch on Friday");
        expect((await reply(already)).subject).toBe("Re: Lunch on Friday");
        expect((await reply(none)).subject).toBe("Re:");
      }),
    ));

  it("a reply's account is the answered message's, whatever account the client names", () =>
    withSendWorld((w) =>
      withDrafting(w, async ({ work }) => {
        await insertAccount(w.db, w.admin, "second");
        const message = await storedMessage(w);
        const id = drafted(
          await work.draftMessage(w.client.token, {
            replyTo: message.id as never,
            account: "second",
            body: "Yes.",
            requestId: testId("req"),
          }),
        );
        expect((await draftRow(w, id)).source_account_id).toBe(w.account.id);
        expect((await payloadOf(w, id)).account).toBe(w.account.id);
      }),
    ));

  it("a stored subject folded with a tab or a line break gives a reply subject with a space", () =>
    withSendWorld((w) =>
      withDrafting(w, async ({ work }) => {
        const message = await storedMessage(w, { subject: "Lunch\ton\r\n Friday" });
        const id = drafted(
          await work.draftMessage(w.client.token, {
            replyTo: message.id as never,
            body: "Yes.",
            requestId: testId("req"),
          }),
        );
        expect((await payloadOf(w, id)).subject).toBe("Re: Lunch on Friday");
      }),
    ));

  // One maker of a draft's four values: what pi mcp stores is what pi send makes again from the
  // sealed payload, or every send is draft_mismatch.
  it("the four values pi mcp stores are the ones the Sender's draftValues makes again from the sealed payload", () =>
    withSendWorld((w) =>
      withDrafting(w, async ({ work }) => {
        const id = drafted(
          await work.draftMessage(
            w.client.token,
            newMessage("Rowan.Upper@Send-Example.TEST", { cc: ["cc@send-example.test", "second@other-example.test"] }),
          ),
        );
        const row = one(
          await w.admin<{
            payload_fp: string;
            body_fp: string;
            recipient_fps: string[];
            recipient_domain_fps: string[];
          }>("select payload_fp, body_fp, recipient_fps, recipient_domain_fps from ledger.drafts where id = $1", [id]),
        );
        const again = await draftValues(w.db.keys, await payloadOf(w, id));
        expect({
          payloadFp: row.payload_fp,
          bodyFp: row.body_fp,
          recipientFps: row.recipient_fps,
          recipientDomainFps: row.recipient_domain_fps,
        }).toEqual(again);
      }),
    ));

  it("an address in upper case is stored in lower case", () =>
    withSendWorld((w) =>
      withDrafting(w, async ({ work }) => {
        const id = drafted(
          await work.draftMessage(
            w.client.token,
            newMessage("Rowan.Upper@Send-Example.TEST", { cc: ["CC@SEND-EXAMPLE.TEST"] }),
          ),
        );
        const payload = await payloadOf(w, id);
        expect(payload.to).toEqual(["rowan.upper@send-example.test"]);
        expect(payload.cc).toEqual(["cc@send-example.test"]);
        expect((await draftRow(w, id)).recipient_fps).toEqual(
          [recipient(w.db, "rowan.upper@send-example.test").fp, recipient(w.db, "cc@send-example.test").fp].sort(),
        );
      }),
    ));

  it("two mail accounts in the clearance and no account named is invalid_request", () =>
    withSendWorld((w) =>
      withDrafting(w, async ({ work }) => {
        const second = await insertAccount(w.db, w.admin, "second");
        expect(await work.draftMessage(w.client.token, newMessage("one@send-example.test"))).toEqual({
          ok: false,
          code: "invalid_request",
        });
        // The control: one named.
        const id = drafted(
          await work.draftMessage(w.client.token, newMessage("one@send-example.test", { account: "second" })),
        );
        expect((await draftRow(w, id)).source_account_id).toBe(second.id);
        expect((await payloadOf(w, id)).account).toBe(second.id);
      }),
    ));

  it("a replyTo the client cannot see, and one that names a held message, are not_found, as one that does not exist is", () =>
    withSendWorld((w) =>
      withDrafting(w, async ({ work }) => {
        const employer = await insertAccount(w.db, w.admin, "work", ["employer:example"]);
        const hidden = await insertMessage(w, { account: employer });
        const held = await storedMessage(w, { held: true });
        for (const replyTo of [hidden.id, held.id, testId("msg")]) {
          expect(
            await work.draftMessage(w.client.token, {
              replyTo: replyTo as never,
              body: "Yes.",
              requestId: testId("req"),
            }),
          ).toEqual({ ok: false, code: "not_found" });
        }
        expect((await calls(w)).map((row) => row.outcome)).toEqual(["not_found", "not_found", "not_found"]);
      }),
    ));

  it("the gate ran at phase draft: nine rows, and the draft is made or held", () =>
    withSendWorld((w) =>
      withDrafting(w, async ({ work }) => {
        const id = drafted(await work.draftMessage(w.client.token, newMessage("one@send-example.test")));
        const rows = await w.admin<{ kind: string; phase: string; created_by: string }>(
          "select kind, phase, created_by from ledger.gate_checks where draft_id = $1 order by kind",
          [id],
        );
        expect(rows.map((row) => row.kind)).toEqual([
          "authority",
          "channel_cap",
          "conflict_lists",
          "consent",
          "contact_policy",
          "disclosure",
          "freshness",
          "payload_hash",
          "vetoes",
        ]);
        expect(new Set(rows.map((row) => `${row.phase} ${row.created_by}`))).toEqual(
          new Set([`draft client:${w.client.id}`]),
        );
        expect(["made", "held"]).toContain(await latest(w, "draft", id));
        expect(await latest(w, "draft", id)).toBe("made");
      }),
    ));

  it("a draft from an account with no send secret, with a missing copy or with a sync 31 minutes old is made, not held", () =>
    withSendWorld((w) =>
      withDrafting(w, async ({ work }) => {
        const noSecret = drafted(await work.draftMessage(w.client.token, newMessage("one@send-example.test")));
        expect(await latest(w, "draft", noSecret)).toBe("made");
        const ready = await readyReply(w, { to: ["two@send-example.test"] });
        const send = await sendNow(w, ready);
        await finish(w, send, "sent");
        await age(w.db, "ledger.sent_messages", "sent_at", "id = $1", [send], 45 * 60);
        const missing = drafted(await work.draftMessage(w.client.token, newMessage("three@send-example.test")));
        expect(await latest(w, "draft", missing)).toBe("made");
        await syncedAt(w, w.account, 31 * 60);
        const stale = drafted(await work.draftMessage(w.client.token, newMessage("four@send-example.test")));
        expect(await latest(w, "draft", stale)).toBe("made");
      }),
    ));

  it("a draft that repeats a use-only fact to someone off its thread is held", () =>
    withSendWorld((w) =>
      withDrafting(w, async ({ work }) => {
        // A third party's fact, taken from a message on a thread the recipient was never on.
        const source = await insertMessage(w, { from: "teller@send-example.test" });
        const claim = createHash("sha256").update(`claim ${source.evidence}`).digest("hex");
        // A whole ClaimRecord, as extraction writes one: a record that does not parse is a
        // candidate that did not open, which fails disclosure for every draft.
        const base = claimRecord(source.evidence, "own", "ent_x", { type: "plan" });
        const record = {
          ...base,
          claim: {
            ...base.claim,
            id: claim,
            content: { type: "plan", subject: "ent_x", fields: { what: "the merger closes in March" } },
          },
          disclosure: ["third_party"],
          factKey: `fact ${claim}`,
          fieldKinds: { what: "text" },
        };
        await w.admin(
          `insert into knowledge.claims (id, evidence_id, type, valid_from, fact_key_fp, extractor_generation, readers, content_enc, compartments)
           values ($1, $2, 'plan', now(), $3, 1, '{m-owner}', $4, '{own}')`,
          [
            claim,
            source.evidence,
            createHash("sha256").update(`fact ${claim}`).digest("hex"),
            sealRow(
              w.db.keys,
              "own",
              { table: "knowledge.claims", id: claim, column: "content_enc" },
              JSON.stringify(record),
            ),
          ],
        );
        const repeats = drafted(
          await work.draftMessage(
            w.client.token,
            newMessage("outsider@send-example.test", { body: "I hear The Merger closes in  March, is that so?" }),
          ),
        );
        expect(await latest(w, "draft", repeats)).toBe("held");
        expect(
          one(
            await w.admin<{ passed: boolean }>(
              "select passed from ledger.gate_checks where draft_id = $1 and kind = 'disclosure'",
              [repeats],
            ),
          ).passed,
        ).toBe(false);
        // The control: the same recipient, without the fact.
        const plain = drafted(
          await work.draftMessage(
            w.client.token,
            newMessage("outsider@send-example.test", { body: "Is lunch still on?" }),
          ),
        );
        expect(await latest(w, "draft", plain)).toBe("made");
      }),
    ));

  it("a draft by a client that holds record is made when nothing else holds it", () =>
    withSendWorld(
      (w) =>
        withDrafting(w, async ({ work }) => {
          const id = drafted(await work.draftMessage(w.client.token, newMessage("one@send-example.test")));
          expect((await draftRow(w, id)).compartments).toEqual(["agent:drafter", "own"]);
          expect(await latest(w, "draft", id)).toBe("made");
        }),
      { clientCompartments: ["own", "agent:drafter"] },
    ));

  it("the fifty-first open draft is rate_limited and writes no calls row of outcome ok", () =>
    withSendWorld((w) =>
      withDrafting(w, async ({ work }) => {
        for (let n = 0; n < 50; n += 1) await appendDraft(w, draftArgs(w, { to: [`n${n}@send-example.test`] }));
        expect(await work.draftMessage(w.client.token, newMessage("fifty-one@send-example.test"))).toEqual({
          ok: false,
          code: "rate_limited",
        });
        expect(await calls(w)).toEqual([{ outcome: "rate_limited", rows: 0 }]);
        expect(await readLog(w)).toEqual([]);
      }),
    ));

  it("a repeated request id returns the first draft", () =>
    withSendWorld((w) =>
      withDrafting(w, async ({ work }) => {
        const args = newMessage("one@send-example.test");
        const first = drafted(await work.draftMessage(w.client.token, args));
        const again = drafted(await work.draftMessage(w.client.token, { ...args, body: "Something else entirely." }));
        expect(again).toBe(first);
        expect(
          one(
            await w.admin<{ n: number }>("select count(*)::int as n from ledger.drafts where created_by = $1", [
              `client:${w.client.id}`,
            ]),
          ).n,
        ).toBe(1);
        expect(
          one(
            await w.admin<{ n: number }>("select count(*)::int as n from ledger.gate_checks where draft_id = $1", [
              first,
            ]),
          ).n,
        ).toBe(9);
      }),
    ));

  it("each call writes one calls row and one read-log row", () =>
    withSendWorld((w) =>
      withDrafting(w, async ({ work }) => {
        await knownTo(w, ["one@send-example.test"]);
        await insertPerson(w, "one@send-example.test");
        drafted(await work.draftMessage(w.client.token, newMessage("one@send-example.test")));
        expect(await calls(w)).toEqual([{ outcome: "ok", rows: 1 }]);
        expect(await readLog(w)).toEqual([{ bound: [], shown: [], compartments: labelOf(w.client.compartments) }]);
        // A client without the tool: one calls row, no read-log row.
        const narrow = await insertSendClient(w.db, "narrow", ["own"], { tools: ["get_self"] });
        expect(await work.draftMessage(narrow.token, newMessage("one@send-example.test"))).toEqual({
          ok: false,
          code: "not_permitted",
        });
        expect(await w.admin("select outcome from policy.calls where client_id = $1", [narrow.id])).toEqual([
          { outcome: "not_permitted" },
        ]);
        expect(await w.admin("select 1 from ledger.read_log where client_id = $1", [narrow.id])).toEqual([]);
      }),
    ));
});
