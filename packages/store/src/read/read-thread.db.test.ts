import type { Timestamp } from "@intelligence/contracts";
import {
  MessageId,
  MessageSummary,
  type ReadItemArgs,
  type ReadOutcome,
  ThreadView,
} from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Accounts, connect, OWNER, type Who } from "../test-support/cast.ts";
import { one } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { ingestMail, type MailFixture, mailFacts, mailItem, mailSourceId } from "../test-support/items.ts";
import { orderFault } from "../test-support/order.ts";
import { openStore, recordingReader as readerOf, type TestStore } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { daysFrom, evidenceIdOf, iso, outcomeValue, registration } from "../test-support/values.ts";
import type { SourceAccountRow } from "../write/writer-types.ts";

// read_item: 20 messages and 50 000 code points a call, 20 000 a message. Seeded through the writer
// with hand-written facts. Reserved domains only.

const NOW = new Date("2026-09-15T12:00:00.000Z");
const BOTH = ["own", "employer:example"];
const NOT_FOUND = { ok: false, code: "not_found" };
const NOT_PERMITTED = { ok: false, code: "not_permitted" };
const at = (days: number, minutes = 0): Timestamp => iso(new Date(daysFrom(NOW, days).getTime() + minutes * 60_000));

const ME: Who = { address: OWNER.personal, name: OWNER.name };
const ME_AT_WORK: Who = { address: OWNER.work, name: OWNER.name };
const PIPPA: Who = { address: "pippa@quayside.test", name: "Pippa Quayside" };
const WREN: Who = { address: "wren@partner-example.test", name: "Wren Partnerfield" };

const inThread = (id: string, threadId: string, over: Partial<MailFixture>): MailFixture => ({
  id,
  threadId,
  at: at(-5),
  from: PIPPA,
  to: [ME],
  subject: id,
  labels: ["INBOX"],
  text: `The words of ${id}.`,
  ...over,
});

// One thread under `own`: three visible messages, one held, one with no text; the same Gmail
// thread id in the employer's mailbox; and a thread of one with no thread id at all.
const T = "thread-shared";
const first = inThread("t-first", T, { at: at(-4) });
const heldOne = inThread("t-held", T, { at: at(-3), text: "Your code is 482913.", held: true });
const second = inThread("t-second", T, { at: at(-2), from: ME, to: [PIPPA], labels: ["SENT"] });
const { text: _none, ...textless } = inThread("t-textless", T, { at: at(-1) });
const elsewhere = inThread("t-elsewhere", T, { at: at(-3, 30), from: WREN, to: [ME_AT_WORK] });
const alone = inThread("t-alone", "unused", { at: at(-1) });
// A thread of three long messages, each past what one message serves.
const L = "thread-long";
const longText = (n: number): string => `${String(n).repeat(3)} \u{1F600} `.repeat(4_000);
const longs = [0, 1, 2].map((n) => inThread(`t-long-${n}`, L, { at: at(-3, n), text: longText(n) }));

let store: TestStore;
const recordingReader = () => readerOf(store);
let accounts: Accounts;

const messageIdOf = async (account: SourceAccountRow, fixture: MailFixture): Promise<MessageId> =>
  MessageId.parse(
    one(
      await queryAs<{ id: string }>(store.db.urls.admin, "select id from knowledge.messages where evidence_id = $1", [
        evidenceIdOf(account, mailSourceId(fixture)),
      ]),
    ).id,
  );
const evidenceOf = (account: SourceAccountRow, fixture: MailFixture): string =>
  evidenceIdOf(account, mailSourceId(fixture));

beforeAll(async () => {
  store = await openStore({ now: NOW });
  accounts = await connect(store.writer);
  for (const fixture of [first, heldOne, second, textless, ...longs])
    expect(await ingestMail(store.writer, accounts.personalMail, fixture), fixture.id).toBe("stored");
  expect(await ingestMail(store.writer, accounts.workMail, elsewhere), elsewhere.id).toBe("stored");
  const { threadId: _threadId, ...threadless } = mailItem(alone, accounts.personalMail);
  expect(await store.writer.ingestItem(accounts.personalMail, threadless, mailFacts(alone))).toBe("stored");
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await store.close();
});

let serial = 0;
async function client(
  compartments: string[],
  views: ("self" | "people" | "work")[] = ["self", "people"],
): Promise<{ token: string; id: string }> {
  serial += 1;
  const name = `thread-client-${serial}`;
  const { token } = await store.admin.clients.addClient(
    registration(name, compartments, { views, tools: ["get_self", "read_message", "read_item"] }),
  );
  const id = (await store.admin.clients.listClients()).find((row) => row.name === name)?.id;
  if (id === undefined) throw new Error("no client");
  return { token, id };
}

const item = async (token: string, args: ReadItemArgs): Promise<ThreadView> =>
  ThreadView.parse(outcomeValue(await store.reader.readItem(token, args)));
const ids = (view: ThreadView): string[] => view.messages.map((message) => message.summary.id);
const points = (text: string): string[] => Array.from(text);
const callsOf = (id: string): Promise<{ tool: string; rows: number; outcome: string; chars: number }[]> =>
  queryAs(
    store.db.urls.admin,
    "select tool, rows, outcome, chars::int as chars from policy.calls where client_id = $1 order by id",
    [id],
  );
const readLogOf = (id: string): Promise<{ tool: string; bound: string[]; shown: string[] }[]> =>
  queryAs(store.db.urls.admin, "select tool, bound, shown from ledger.read_log where client_id = $1 order by id", [id]);

// The summary read_message gives the same message: the fields of MessageSummary.
async function summaryOf(token: string, id: MessageId): Promise<MessageSummary> {
  const whole = outcomeValue(await store.reader.readMessage(token, { id }));
  return MessageSummary.parse(
    Object.fromEntries(Object.keys(MessageSummary.shape).map((key) => [key, whole[key as keyof typeof whole]])),
  );
}

describe("read_item", { timeout: DB_TEST_TIMEOUT }, () => {
  it("returns one thread's visible messages, oldest first, each with its summary and text; a held one is absent", async () => {
    const wide = await client(BOTH);
    const expected = await Promise.all(
      [first, second, textless].map((fixture) => messageIdOf(accounts.personalMail, fixture)),
    );
    // Whichever message of the thread is named, the thread is the same.
    for (const named of expected) {
      const view = await item(wide.token, { message: named });
      expect(ids(view)).toEqual(expected);
      expect(view.thread).toEqual({ untrusted: T });
      expect(view.next).toBeNull();
    }
    const view = await item(wide.token, { message: expected[0] as MessageId });
    for (const [index, message] of view.messages.entries()) {
      expect(message.summary).toEqual(await summaryOf(wide.token, expected[index] as MessageId));
      expect(message.offset).toBe(0);
      expect(message.cut).toBe(false);
    }
    expect(view.messages.map((message) => message.text)).toEqual([
      { untrusted: first.text },
      { untrusted: second.text },
      null,
    ]);
    // The held message is named nowhere, and naming it finds nothing.
    expect(JSON.stringify(view)).not.toContain("482913");
    expect(
      await store.reader.readItem(wide.token, { message: await messageIdOf(accounts.personalMail, heldOne) }),
    ).toEqual(NOT_FOUND);
  });

  it("a message of the same thread id in another mailbox is not in it", async () => {
    const wide = await client(BOTH);
    const mine = await item(wide.token, { message: await messageIdOf(accounts.personalMail, first) });
    const theirs = await item(wide.token, { message: await messageIdOf(accounts.workMail, elsewhere) });
    expect(ids(theirs)).toEqual([await messageIdOf(accounts.workMail, elsewhere)]);
    expect(ids(mine)).not.toContain(ids(theirs)[0]);
  });

  it("a thread of one when thread_fp is null", async () => {
    const wide = await client(BOTH);
    const id = await messageIdOf(accounts.personalMail, alone);
    const view = await item(wide.token, { message: id });
    expect(view).toEqual({
      thread: null,
      messages: [{ summary: await summaryOf(wide.token, id), text: { untrusted: alone.text }, offset: 0, cut: false }],
      next: null,
    });
  });

  it("next pages to the end, limit messages at a time", async () => {
    const wide = await client(BOTH);
    const expected = await Promise.all(
      [first, second, textless].map((fixture) => messageIdOf(accounts.personalMail, fixture)),
    );
    const named = expected[2] as MessageId;
    const pages: string[][] = [];
    let from: number | null = 0;
    while (from !== null) {
      const view = await item(wide.token, { message: named, from, limit: 2 });
      pages.push(ids(view));
      from = view.next;
    }
    expect(pages).toEqual([expected.slice(0, 2), expected.slice(2)]);
    // Past the end: nothing, and no next.
    expect(await item(wide.token, { message: named, from: 3 })).toEqual({
      thread: { untrusted: T },
      messages: [],
      next: null,
    });
  });

  it("50 000 code points stop the page and next points to the first message not served; each text is cut at 20 000", async () => {
    const wide = await client(BOTH);
    const expected = await Promise.all(longs.map((fixture) => messageIdOf(accounts.personalMail, fixture)));
    const page = await item(wide.token, { message: expected[0] as MessageId });
    // Two texts of 20 000 are 40 000; a third would pass 50 000.
    expect(ids(page)).toEqual(expected.slice(0, 2));
    expect(page.next).toBe(2);
    for (const [index, message] of page.messages.entries()) {
      expect(points(message.text?.untrusted ?? "")).toEqual(points(longText(index)).slice(0, 20_000));
      expect(message.cut).toBe(true);
    }
    const rest = await item(wide.token, { message: expected[0] as MessageId, from: 2 });
    expect(ids(rest)).toEqual(expected.slice(2));
    expect(rest.next).toBeNull();
    // read_message reads on from where read_item cut.
    const on = outcomeValue(
      await store.reader.readMessage(wide.token, { id: expected[2] as MessageId, offset: 20_000 }),
    );
    expect(on.text?.untrusted).toBe(points(longText(2)).slice(20_000, 40_000).join(""));
    // The code points served, as the call log counts them.
    expect(
      (await callsOf(wide.id))
        .filter((row) => row.tool === "read_item")
        .map((row) => [row.outcome, row.rows, row.chars]),
    ).toEqual([
      ["ok", 2, 40_000],
      ["ok", 1, 20_000],
    ]);
  });

  it("each message whose text was served is bound, and one with no text is shown", async () => {
    const wide = await client(BOTH);
    await item(wide.token, { message: await messageIdOf(accounts.personalMail, first) });
    const [row] = await readLogOf(wide.id);
    expect(row?.tool).toBe("read_item");
    expect([...(row?.bound ?? [])].sort()).toEqual(
      [evidenceOf(accounts.personalMail, first), evidenceOf(accounts.personalMail, second)].sort(),
    );
    expect(row?.shown).toEqual([evidenceOf(accounts.personalMail, textless)]);
    expect(await callsOf(wide.id)).toEqual([
      {
        tool: "read_item",
        rows: 3,
        outcome: "ok",
        chars: points(first.text ?? "").length + points(second.text ?? "").length,
      },
    ]);
  });

  it("a hidden, a held and an absent message answer the same bytes and statements", async () => {
    const ownOnly = await client(["own"]);
    const wide = await client(BOTH);
    const { reader, during } = recordingReader();
    const absent = MessageId.parse(`msg_7${"Z".repeat(25)}`);
    const cases: [string, string, MessageId][] = [
      ["hidden", ownOnly.token, await messageIdOf(accounts.workMail, elsewhere)],
      ["held", wide.token, await messageIdOf(accounts.personalMail, heldOne)],
      ["absent", ownOnly.token, absent],
    ];
    const seen: { answer: string; statements: string[] }[] = [];
    for (const [name, token, message] of cases) {
      const { answer, statements } = await during(
        (): Promise<ReadOutcome<ThreadView>> => reader.readItem(token, { message }),
      );
      expect(answer, name).toEqual(NOT_FOUND);
      seen.push({ answer: JSON.stringify(answer), statements });
    }
    for (const one of seen) expect(one).toEqual(seen[0]);
    // The control: the narrow client reads its own thread.
    expect(
      (await reader.readItem(ownOnly.token, { message: await messageIdOf(accounts.personalMail, first) })).ok,
    ).toBe(true);
    expect(await readLogOf(ownOnly.id)).toHaveLength(1);
  });

  it("every query has an order by with a unique key", async () => {
    const wide = await client(BOTH);
    const { reader, during } = recordingReader();
    for (const message of [
      await messageIdOf(accounts.personalMail, first),
      await messageIdOf(accounts.personalMail, alone),
      MessageId.parse(`msg_7${"Z".repeat(25)}`),
    ]) {
      const { statements } = await during(() => reader.readItem(wide.token, { message, limit: 2 }));
      expect(statements.some((text) => /knowledge\.messages/i.test(text))).toBe(true);
      for (const text of statements) expect(orderFault(text), text).toBeNull();
    }
  });

  it("a client without people is refused and recorded", async () => {
    const selfOnly = await client(BOTH, ["self"]);
    expect(
      await store.reader.readItem(selfOnly.token, { message: await messageIdOf(accounts.personalMail, first) }),
    ).toEqual(NOT_PERMITTED);
    expect(await callsOf(selfOnly.id)).toEqual([{ tool: "read_item", rows: 0, outcome: "not_permitted", chars: 0 }]);
  });
});
