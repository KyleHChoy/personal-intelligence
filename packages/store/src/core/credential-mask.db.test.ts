import type { Timestamp } from "@intelligence/contracts";
import {
  type ClaimRecord,
  type ClientId,
  ContextPack,
  ContextView,
  type DocumentId,
  DocumentView,
  EntityId,
  EvidenceSpan,
  MessageId,
  MessageList,
  MessageView,
  TemplateView,
  ThreadView,
} from "@intelligence/contracts/personal";
import { maskCredentials, PERSONAL_LIMITS } from "@intelligence/personal-core";
import { type DocBody, type DriveFile, deriveItem, driveItem, passageOf } from "@intelligence/personal-core/items";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPipeline } from "../pipeline/pipeline.ts";
import { type Accounts, connect, OWNER, type Who } from "../test-support/cast.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { insertReader } from "../test-support/commitment-fixtures.ts";
import { one } from "../test-support/connections.ts";
import { ownerSide, seedSpecs } from "../test-support/context-db-fixtures.ts";
import { queryAs } from "../test-support/database.ts";
import { ingestMail, type MailFixture, mailSourceId } from "../test-support/items.ts";
import { batchOf, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { opened } from "../test-support/snapshot.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { daysFrom, evidenceIdOf, iso, outcomeValue, registration } from "../test-support/values.ts";
import type { SourceAccountRow } from "../write/writer-types.ts";
import { fingerprint } from "./fingerprint.ts";

// The credential mask on the reads that serve evidence text. Each match of CREDENTIAL_SHAPED is masked in the whole
// opened text before any window or cut, keeping its prefix and its length in code points, so every offset, cut and
// `chars` stays exact; a result gains `masked`, the count of matches in the text it carries, when above 0. The stored
// evidence, the read log's `bound` and the owner's `pi inspect` are unchanged. The store is seeded through the writer,
// and facts are committed through the Pipeline as the extraction would. Made-up values on reserved domains.

const NOW = new Date("2026-09-15T12:00:00.000Z");
const at = (days: number): Timestamp => iso(daysFrom(NOW, days));
const points = (text: string): string[] => Array.from(text);
const stars = (count: number): string => "*".repeat(count);

const ME: Who = { address: OWNER.personal, name: OWNER.name };
const PIPPA: Who = { address: "pippa@quayside.test", name: "Pippa Quayside" };

// contracts' capture.test.ts vectors, each split in two literals so none has a provider's key
// shape: a ghp_ value and an AKIA one, and look-alikes of the same
// lengths that match no format.
const GHP = "gh" + "p_aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5";
const AKIA = "AKIA" + "IOSFODNN7EXAMPLE";
const NOT_GHP = `xyz_${GHP.slice(4)}`;
const NOT_AKIA = `BKIA${AKIA.slice(4)}`;
const GHP_MASKED = `ghp_${stars(36)}`;
const AKIA_MASKED = `AKIA${stars(16)}`;

// Three segments: the key's, the AKIA value's, and one with no secret.
const body = (ghp: string, akia: string): string =>
  `Here is the deploy key: ${ghp} for the \u{1F6A2} build.\n\nRotate it after use, and ${akia} too.\n\nThe ferry leaves at noon.`;
const KEYED_TEXT = body(GHP, AKIA);
const PLAIN_TEXT = body(NOT_GHP, NOT_AKIA);
const MASKED_TEXT = body(GHP_MASKED, AKIA_MASKED);
const KEYED_SUBJECT = `Deploy key ${GHP}`;
const PLAIN_SUBJECT = `Deploy key ${NOT_GHP}`;
const MASKED_SUBJECT = `Deploy key ${GHP_MASKED}`;

const keyed: MailFixture = {
  id: "mask-keyed",
  threadId: "thread-mask-keyed",
  at: at(-2),
  from: PIPPA,
  to: [ME],
  subject: KEYED_SUBJECT,
  labels: ["INBOX"],
  text: KEYED_TEXT,
};
const plain: MailFixture = {
  id: "mask-plain",
  threadId: "thread-mask-plain",
  at: at(-3),
  from: PIPPA,
  to: [ME],
  subject: PLAIN_SUBJECT,
  labels: ["INBOX"],
  text: PLAIN_TEXT,
};

// The spans the facts cite, the same in both messages: inside the first segment, and the last.
const FIRST_SPAN = "chars:0-22";
// In code points: the text holds a character outside the basic plane before it.
const LAST_AT = points(KEYED_TEXT.slice(0, KEYED_TEXT.indexOf("The ferry"))).length;
const LAST_SPAN = `chars:${LAST_AT}-${LAST_AT + 9}`;

// Documents: an extract root's and a reference root's (a template), each a keyed one and its twin.
const DOCS = "fldMaskDocsRoot0001";
const TEMPLATES = "fldMaskTmplRoot0001";
const docFile = (id: string, root: string): DriveFile => ({
  id,
  name: `Plan ${id}`,
  mimeType: "application/vnd.google-apps.document",
  createdTime: "2026-09-01T09:00:00.000Z",
  modifiedTime: "2026-09-02T09:00:00.000Z",
  parent: root,
  root,
  ownedByMe: true,
  modifiedByMe: true,
  owner: { address: OWNER.personal, name: OWNER.name },
  canDownload: true,
});
const paragraphs = (...texts: string[]): DocBody => ({
  blocks: texts.map((text) => ({ kind: "paragraph" as const, text })),
});
const docBody = (ghp: string, akia: string): DocBody =>
  paragraphs(
    `The deploy key is ${ghp} for \u{1F6A2} builds.`,
    `Rotate ${akia} monthly.`,
    "Ask {{name:text}} before {{day:date}}.",
  );

// The agent that writes the notes, with its own compartment.
const AGENT = "mask-agent";

let store: TestStore;
let accounts: Accounts;
let agent: { id: ClientId; token: string };
const ids = {} as Record<"keyed" | "plain", { evidence: string; message: MessageId; first: string; last: string }>;

async function commitFacts(fixture: MailFixture, owner: string): Promise<{ first: string; last: string }> {
  const evidenceId = evidenceIdOf(accounts.personalMail, mailSourceId(fixture));
  const records = [FIRST_SPAN, LAST_SPAN].map((span, index): ClaimRecord => {
    const record = claimRecord(evidenceId, "own", owner, { n: index + 1, factKey: `k-mask-${fixture.id}-${index}` });
    return { ...record, claim: { ...record.claim, evidence: [{ evidenceId, span }] } } as ClaimRecord;
  });
  const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
  try {
    expect(await pipeline.commit(batchOf(evidenceId, records))).toBe("committed");
  } finally {
    await pipeline.close();
  }
  const [first, last] = records.map((record) => fingerprint(store.db.keys, "claim", record.claim.id));
  return { first: first ?? "", last: last ?? "" };
}

beforeAll(async () => {
  store = await openStore({ now: NOW, compartments: ["own", "employer:example", `agent:${AGENT}`] });
  accounts = await connect(store.writer);
  const drive = await store.writer.ensureSourceAccount("personal", "google_docs", "own", OWNER.personal);
  await store.admin.drive.addRoot("personal", DOCS, "extract");
  await store.admin.drive.addRoot("personal", TEMPLATES, "reference");
  const putDoc = async (account: SourceAccountRow, doc: DriveFile, content: DocBody): Promise<void> => {
    const raw = driveItem(doc, content, null, {
      sourceAccount: account.id,
      changeKind: "backfill",
      ownerAddress: OWNER.personal,
    });
    expect(await store.writer.ingestItem(account, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS)), doc.id).toBe(
      "stored",
    );
  };
  await putDoc(drive, docFile("1MaskKeyedDoc01", DOCS), docBody(GHP, AKIA));
  await putDoc(drive, docFile("1MaskPlainDoc01", DOCS), docBody(NOT_GHP, NOT_AKIA));
  await putDoc(drive, docFile("1MaskKeyedTpl01", TEMPLATES), docBody(GHP, AKIA));
  await putDoc(drive, docFile("1MaskPlainTpl01", TEMPLATES), docBody(NOT_GHP, NOT_AKIA));
  // The agent: inserted as pi_admin, as the pack tests insert theirs, with its own compartment.
  agent = { id: testId("cli") as ClientId, token: `pit_test-${AGENT}-${testId("x")}` };
  await queryAs(
    store.db.urls.admin,
    `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools)
     values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6)`,
    [
      agent.id,
      AGENT,
      sha256Hex(agent.token),
      ["own", `agent:${AGENT}`],
      ["self", "people", "work"],
      ["get_self", "record", "build_context_pack", "read_item", "find_documents", "get_document", "fetch_template"],
    ],
  );
  for (const fixture of [keyed, plain])
    expect(await ingestMail(store.writer, accounts.personalMail, fixture), fixture.id).toBe("stored");
  const owner = one(
    await queryAs<{ id: string }>(store.db.urls.admin, "select id from knowledge.entities where kind = 'owner'"),
  ).id;
  for (const [name, fixture] of [
    ["keyed", keyed],
    ["plain", plain],
  ] as const) {
    const evidence = evidenceIdOf(accounts.personalMail, mailSourceId(fixture));
    const message = MessageId.parse(
      one(
        await queryAs<{ id: string }>(store.db.urls.admin, "select id from knowledge.messages where evidence_id = $1", [
          evidence,
        ]),
      ).id,
    );
    ids[name] = { evidence, message, ...(await commitFacts(fixture, owner)) };
  }
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await store?.close();
});

// A document's id by its title, as find_documents lists it.
async function documentOf(title: string): Promise<DocumentId> {
  const listed = outcomeValue(await store.reader.findDocuments(agent.token, { limit: 50 })).documents;
  const found = listed.find((one) => one.title.untrusted === title);
  if (found === undefined) throw new Error(`no document ${title}`);
  return found.id as DocumentId;
}

let serial = 0;
async function client(): Promise<{ token: string; id: string }> {
  serial += 1;
  const name = `mask-client-${serial}`;
  const { token } = await store.admin.clients.addClient(
    registration(name, ["own"], { tools: ["get_self", "find_messages", "read_message", "get_evidence_span"] }),
  );
  const id = (await store.admin.clients.listClients()).find((row) => row.name === name)?.id;
  if (id === undefined) throw new Error("no client");
  return { token, id };
}

const readOne = async (
  token: string,
  id: MessageId,
  window: { offset?: number; limit?: number } = {},
): Promise<MessageView> => MessageView.parse(outcomeValue(await store.reader.readMessage(token, { id, ...window })));
const spanOf = async (token: string, fact: string): Promise<EvidenceSpan> =>
  EvidenceSpan.parse(outcomeValue(await store.reader.getEvidenceSpan(token, { fact })));
// No four characters of a value's secret part, anywhere in a served text.
const holdsNoPartOf = (text: string, value: string): void => {
  for (let from = 4; from + 4 <= value.length; from += 1)
    expect(text, value.slice(from, from + 4)).not.toContain(value.slice(from, from + 4));
};

describe("the credential mask on evidence reads", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a subject with a key is masked in find_messages", async () => {
    const { token } = await client();
    const list = MessageList.parse(outcomeValue(await store.reader.findMessages(token, { sender: PIPPA.address })));
    const byId = new Map(list.messages.map((summary) => [summary.id, summary]));
    const masked = byId.get(ids.keyed.message);
    const clear = byId.get(ids.plain.message);
    expect(masked?.subject).toEqual({ untrusted: MASKED_SUBJECT });
    expect(masked?.masked).toBe(1);
    // A summary carries the subject alone: the body's two values are not its count.
    expect(points(masked?.subject?.untrusted ?? "").length).toBe(points(KEYED_SUBJECT).length);
    // The control: the look-alike is served as it is, with no count.
    expect(clear?.subject).toEqual({ untrusted: PLAIN_SUBJECT });
    expect(clear).not.toHaveProperty("masked");
    // chars is the body's length, the same with and without the keys.
    expect(masked?.chars).toBe(points(KEYED_TEXT).length);
    expect(masked?.chars).toBe(clear?.chars);
  });

  it("a key across a window's edge is masked in both windows, and the two windows join to the masked whole", async () => {
    const { token } = await client();
    // An edge inside the ghp_ value's secret part, in code points.
    const edge = points(KEYED_TEXT).indexOf("g", points(KEYED_TEXT).indexOf(":")) + 20;
    const first = await readOne(token, ids.keyed.message, { offset: 0, limit: edge });
    const second = await readOne(token, ids.keyed.message, { offset: edge });
    expect(first.more).toBe(true);
    expect(second.offset).toBe(edge);
    const joined = `${first.text?.untrusted ?? ""}${second.text?.untrusted ?? ""}`;
    expect(joined).toBe(MASKED_TEXT);
    expect(first.text?.untrusted).toBe(points(MASKED_TEXT).slice(0, edge).join(""));
    for (const window of [first, second]) {
      holdsNoPartOf(window.text?.untrusted ?? "", GHP);
      holdsNoPartOf(window.text?.untrusted ?? "", AKIA);
    }
    // A window's count is the matches that overlap the text it serves (the owner's ruling): the
    // subject's in each, the cut ghp_ value in both, and the AKIA value in the second alone.
    expect(first.masked).toBe(2);
    expect(second.masked).toBe(3);
    // A window past both of the body's values serves the subject's alone.
    const tail = await readOne(token, ids.keyed.message, { offset: LAST_AT });
    expect(tail.text).toEqual({ untrusted: "The ferry leaves at noon." });
    expect(tail.masked).toBe(1);
    // And the whole read.
    expect((await readOne(token, ids.keyed.message)).text).toEqual({ untrusted: MASKED_TEXT });
    // The control: the look-alike's windows join to its text as stored.
    const plainFirst = await readOne(token, ids.plain.message, { offset: 0, limit: edge });
    const plainSecond = await readOne(token, ids.plain.message, { offset: edge });
    expect(`${plainFirst.text?.untrusted ?? ""}${plainSecond.text?.untrusted ?? ""}`).toBe(PLAIN_TEXT);
  });

  it("masked counts the matches", async () => {
    const { token } = await client();
    const whole = await readOne(token, ids.keyed.message);
    // The subject's one and the body's two.
    expect(whole.masked).toBe(3);
    expect(whole.subject).toEqual({ untrusted: MASKED_SUBJECT });
    expect(whole.chars).toBe(points(KEYED_TEXT).length);
    const clear = await readOne(token, ids.plain.message);
    expect(clear).not.toHaveProperty("masked");
    expect(clear.text).toEqual({ untrusted: PLAIN_TEXT });
  });

  it("a passage's offsets and chars are the same with and without a key in it", async () => {
    const { token } = await client();
    const keyedFirst = await spanOf(token, ids.keyed.first);
    const plainFirst = await spanOf(token, ids.plain.first);
    // The segment the span falls in, cut from the masked whole. With no quote the sender's words
    // are one segment (passageOf), so the passage holds both values.
    const expected = await passageOf({ body: MASKED_TEXT, subject: MASKED_SUBJECT }, FIRST_SPAN);
    const plainExpected = await passageOf({ body: PLAIN_TEXT, subject: PLAIN_SUBJECT }, FIRST_SPAN);
    expect(expected).toBe(MASKED_TEXT);
    expect(plainFirst.passage).toEqual({ untrusted: plainExpected });
    expect(keyedFirst.passage).toEqual({ untrusted: expected });
    // The count is the served passage's own: both values.
    expect(keyedFirst.masked).toBe(2);
    holdsNoPartOf(keyedFirst.passage?.untrusted ?? "", GHP);
    holdsNoPartOf(keyedFirst.passage?.untrusted ?? "", AKIA);
    expect({
      chars: keyedFirst.chars,
      cut: keyedFirst.cut,
      length: points(keyedFirst.passage?.untrusted ?? "").length,
    }).toEqual({
      chars: plainFirst.chars,
      cut: plainFirst.cut,
      length: points(plainFirst.passage?.untrusted ?? "").length,
    });
    expect(plainFirst).not.toHaveProperty("masked");
    // A span after both keys, at the same offsets in both messages, cites the same segment.
    const keyedLast = await spanOf(token, ids.keyed.last);
    const plainLast = await spanOf(token, ids.plain.last);
    expect(keyedLast.passage).toEqual({
      untrusted: await passageOf({ body: MASKED_TEXT, subject: MASKED_SUBJECT }, LAST_SPAN),
    });
    expect(plainLast.passage).toEqual({
      untrusted: await passageOf({ body: PLAIN_TEXT, subject: PLAIN_SUBJECT }, LAST_SPAN),
    });
    expect(keyedLast.passage?.untrusted ?? "").toContain("The ferry leaves at noon.");
    expect([keyedLast.chars, keyedLast.cut]).toEqual([plainLast.chars, plainLast.cut]);
    expect(keyedLast.masked).toBe(2);
    expect(plainLast).not.toHaveProperty("masked");
  });

  it("get_document masks a key in the document's text, keeping its length and offsets", async () => {
    const keyedView = DocumentView.parse(
      outcomeValue(await store.reader.getDocument(agent.token, { id: await documentOf("Plan 1MaskKeyedDoc01") })),
    );
    const plainView = DocumentView.parse(
      outcomeValue(await store.reader.getDocument(agent.token, { id: await documentOf("Plan 1MaskPlainDoc01") })),
    );
    const plainText = plainView.text?.untrusted ?? "";
    expect(plainText).toContain(NOT_GHP);
    expect(keyedView.text).toEqual({
      untrusted: plainText.replace(NOT_GHP, GHP_MASKED).replace(NOT_AKIA, AKIA_MASKED),
    });
    expect(keyedView.masked).toBe(2);
    expect(plainView).not.toHaveProperty("masked");
    expect({
      chars: keyedView.chars,
      outline: keyedView.outline,
      offset: keyedView.offset,
      more: keyedView.more,
    }).toEqual({
      chars: plainView.chars,
      outline: plainView.outline,
      offset: plainView.offset,
      more: plainView.more,
    });
    // A window from an offset past the key starts at the same words in both. get_document's offsets
    // are code units, so the character outside the basic plane before it counts two.
    const at = plainText.indexOf("Rotate");
    const keyedTail = DocumentView.parse(
      outcomeValue(
        await store.reader.getDocument(agent.token, {
          id: await documentOf("Plan 1MaskKeyedDoc01"),
          offset: at,
          limit: 6,
        }),
      ),
    );
    expect(keyedTail.text).toEqual({ untrusted: "Rotate" });
    expect(keyedTail).not.toHaveProperty("masked");
  });

  it("fetch_template masks a key in the template's text, keeping its length and placeholders", async () => {
    const keyedView = TemplateView.parse(
      outcomeValue(
        await store.reader.fetchTemplate(agent.token, { document: await documentOf("Plan 1MaskKeyedTpl01") }),
      ),
    );
    const plainView = TemplateView.parse(
      outcomeValue(
        await store.reader.fetchTemplate(agent.token, { document: await documentOf("Plan 1MaskPlainTpl01") }),
      ),
    );
    const plainText = plainView.text?.untrusted ?? "";
    expect(plainText).toContain(NOT_AKIA);
    expect(keyedView.text).toEqual({
      untrusted: plainText.replace(NOT_GHP, GHP_MASKED).replace(NOT_AKIA, AKIA_MASKED),
    });
    expect(keyedView.masked).toBe(2);
    expect(plainView).not.toHaveProperty("masked");
    expect(keyedView.placeholders).toEqual(plainView.placeholders);
    expect(keyedView.placeholders.map((one) => one.name.untrusted)).toEqual(["name", "day"]);
    expect([keyedView.document.chars, keyedView.offset, keyedView.more]).toEqual([
      plainView.document.chars,
      plainView.offset,
      plainView.more,
    ]);
  });

  it("read_item masks a key in a thread's message, keeping its length", async () => {
    const view = ThreadView.parse(
      outcomeValue(await store.reader.readItem(agent.token, { message: ids.keyed.message })),
    );
    const [message] = view.messages;
    expect(message?.text).toEqual({ untrusted: MASKED_TEXT });
    expect(message?.summary.subject).toEqual({ untrusted: MASKED_SUBJECT });
    expect([message?.offset, message?.cut, message?.summary.chars]).toEqual([0, false, points(KEYED_TEXT).length]);
    // The subject's one and the body's two.
    expect(view.masked).toBe(3);
    const clear = ThreadView.parse(
      outcomeValue(await store.reader.readItem(agent.token, { message: ids.plain.message })),
    );
    expect(clear.messages[0]?.text).toEqual({ untrusted: PLAIN_TEXT });
    expect(clear).not.toHaveProperty("masked");
  });

  it("an agent record's body in a pack is masked, keeping its length", async () => {
    const note = `Deploy with ${GHP} then rotate \u{1F6A2}.`;
    const plainNote = `Deploy with ${NOT_GHP} then rotate \u{1F6A2}.`;
    for (const [n, body] of [note, plainNote].entries()) {
      expect(
        (await store.reader.record(agent.token, { kind: "note", body, requestId: `mask-note-${n}` })).ok,
        body,
      ).toBe(true);
    }
    const pack = ContextPack.parse(
      outcomeValue(await store.reader.buildContextPack(agent.token, { purpose: "agent_bootstrap" })),
    );
    const records = pack.items.flatMap((item) => (item.kind === "record" ? [item.record] : []));
    const masked = records.find((one) => one.body?.untrusted.includes("ghp_"));
    const clear = records.find((one) => one.body?.untrusted.includes(NOT_GHP));
    expect(masked?.body).toEqual({ untrusted: `Deploy with ${GHP_MASKED} then rotate \u{1F6A2}.` });
    expect(masked?.masked).toBe(1);
    expect([masked?.chars, masked?.cut]).toEqual([points(note).length, false]);
    expect(clear?.body).toEqual({ untrusted: plainNote });
    expect(clear).not.toHaveProperty("masked");
  });

  it("a context pack's message item masks a key in its subject", async () => {
    const [pippa] = await queryAs<{ entity_id: string }>(
      store.db.urls.admin,
      "select distinct entity_id from knowledge.accounts where value_fp = $1",
      [fingerprint(store.db.keys, "address", PIPPA.address)],
    );
    if (pippa === undefined) throw new Error("no entity for the sender");
    const pack = ContextPack.parse(
      outcomeValue(
        await store.reader.buildContextPack(agent.token, {
          purpose: "person_brief",
          entity: EntityId.parse(pippa.entity_id),
        }),
      ),
    );
    const messages = pack.items.flatMap((item) => (item.kind === "message" ? [item.message] : []));
    const masked = messages.find((one) => one.id === ids.keyed.message);
    const clear = messages.find((one) => one.id === ids.plain.message);
    expect(masked?.subject).toEqual({ untrusted: MASKED_SUBJECT });
    expect(masked?.masked).toBe(1);
    expect(masked?.chars).toBe(points(KEYED_TEXT).length);
    expect(clear?.subject).toEqual({ untrusted: PLAIN_SUBJECT });
    expect(clear).not.toHaveProperty("masked");
  });

  it("the vault, the read log's bound and pi inspect are unchanged", async () => {
    const inspectBefore = await store.admin.accounts.inspect(PIPPA.address);
    const reader = await client();
    await readOne(reader.token, ids.keyed.message);
    await spanOf(reader.token, ids.keyed.first);
    // The stored message holds the values whole.
    const [row] = await queryAs<{ id: string; subject_enc: unknown; body_enc: unknown }>(
      store.db.urls.admin,
      "select id, subject_enc, body_enc from knowledge.messages where id = $1",
      [ids.keyed.message],
    );
    if (row === undefined) throw new Error("no message row");
    expect(opened(store.db, "own", { table: "knowledge.messages", id: row.id, column: "body_enc" }, row.body_enc)).toBe(
      KEYED_TEXT,
    );
    expect(
      opened(store.db, "own", { table: "knowledge.messages", id: row.id, column: "subject_enc" }, row.subject_enc),
    ).toBe(KEYED_SUBJECT);
    // The read log binds the evidence read, as for any message.
    const logged = await queryAs<{ tool: string; bound: string[] }>(
      store.db.urls.admin,
      "select tool, bound from ledger.read_log where client_id = $1 order by id",
      [reader.id],
    );
    expect(logged).toEqual([
      { tool: "read_message", bound: [ids.keyed.evidence] },
      { tool: "get_evidence_span", bound: [ids.keyed.evidence] },
    ]);
    // The owner's inspect of the sender is what it was before the reads.
    expect(inspectBefore).not.toBeNull();
    expect(await store.admin.accounts.inspect(PIPPA.address)).toEqual(inspectBefore);
  });
});

// get_timeline's subjects and documents' titles masked; a PEM key cut by a segment's edge counted
// in the passage served; context's passages carry their count; a heading's key counted once, and
// only when served.
describe("the credential mask on subjects, titles, split keys and headings", { timeout: DB_TEST_TIMEOUT }, () => {
  const PEM =
    "-----BEGIN RSA PRIVATE" +
    " KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE" +
    " KEY-----";
  const PEM_HEAD = "-----BEGIN RSA PRIVATE" + " KEY-----";
  // The key's header in the sender's words, its END under a quote: two segments.
  const PEM_TEXT = `Here it is:\n${PEM.slice(0, PEM.indexOf("\n-----END"))}\n\nOn Mon, Sep 14, 2026 at 9:00 AM Pippa Quayside <${PIPPA.address}> wrote:\n> -----END RSA PRIVATE${" "}KEY-----\n> Thanks.`;
  const pem: MailFixture = {
    id: "mask-pem",
    threadId: "thread-mask-pem",
    at: at(-1),
    from: PIPPA,
    to: [ME],
    subject: "The key",
    labels: ["INBOX"],
    text: PEM_TEXT,
  };
  const QUINN: Who = { address: "quinn@harbourside.test", name: "Quinn Harbourside" };
  const CONTEXT_SUBJECT = `Interview key ${GHP}`;
  const contextMail: MailFixture = {
    id: "mask-context",
    threadId: "thread-mask-context",
    at: at(-4),
    from: QUINN,
    to: [ME],
    subject: CONTEXT_SUBJECT,
    labels: ["INBOX"],
    text: "See you at the interview.",
  };
  let pemFact = "";
  let reader: { token: string; id: string };

  beforeAll(async () => {
    const drive = await store.writer.ensureSourceAccount("personal", "google_docs", "own", OWNER.personal);
    const putDoc = async (doc: DriveFile, content: DocBody): Promise<void> => {
      const raw = driveItem(doc, content, null, {
        sourceAccount: drive.id,
        changeKind: "backfill",
        ownerAddress: OWNER.personal,
      });
      expect(await store.writer.ingestItem(drive, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS)), doc.id).toBe(
        "stored",
      );
    };
    await putDoc({ ...docFile("1MaskTitleDoc001", DOCS), name: `Key ${AKIA}` }, paragraphs("Nothing secret here."));
    await putDoc(docFile("1MaskHeadDoc0001", DOCS), {
      blocks: [
        { kind: "heading", level: 1, text: `Key ${GHP}` },
        { kind: "paragraph", text: "Rotate it after use." },
      ],
    });
    for (const fixture of [pem, contextMail])
      expect(await ingestMail(store.writer, accounts.personalMail, fixture), fixture.id).toBe("stored");
    const owner = one(
      await queryAs<{ id: string }>(store.db.urls.admin, "select id from knowledge.entities where kind = 'owner'"),
    ).id;
    pemFact = (await commitFacts(pem, owner)).first;
    const evidence = evidenceIdOf(accounts.personalMail, mailSourceId(contextMail));
    const message = one(
      await queryAs<{ id: string }>(store.db.urls.admin, "select id from knowledge.messages where evidence_id = $1", [
        evidence,
      ]),
    ).id;
    await seedSpecs(store, owner, [
      ownerSide(
        "mask-ctx-goal",
        "goal",
        owner,
        { id: message, evidenceId: evidence, sentAt: contextMail.at, compartment: "own" },
        "career",
        "canary-mask-ctx-goal",
      ),
    ]);
    reader = await insertReader(store, "mask-review", ["own"], {
      tools: ["get_timeline", "find_documents", "get_document", "get_evidence_span", "context"],
      views: ["self", "people", "work"],
    });
  }, DB_TEST_TIMEOUT);

  it("get_timeline masks a key in an email entry's subject", async () => {
    const [pippa] = await queryAs<{ entity_id: string }>(
      store.db.urls.admin,
      "select distinct entity_id from knowledge.accounts where value_fp = $1",
      [fingerprint(store.db.keys, "address", PIPPA.address)],
    );
    if (pippa === undefined) throw new Error("no entity for the sender");
    const timeline = outcomeValue(
      await store.reader.getTimeline(reader.token, { id: EntityId.parse(pippa.entity_id) }),
    );
    const emails = timeline.entries.flatMap((entry) => (entry.kind === "email" ? [entry] : []));
    expect(emails.find((one) => one.id === ids.keyed.message)?.subject).toEqual({ untrusted: MASKED_SUBJECT });
    expect(emails.find((one) => one.id === ids.plain.message)?.subject).toEqual({ untrusted: PLAIN_SUBJECT });
    holdsNoPartOf(JSON.stringify(emails.find((one) => one.id === ids.keyed.message)), GHP);
  });

  it("a document's title is masked in find_documents and get_document, and counted in get_document", async () => {
    const listed = outcomeValue(await store.reader.findDocuments(reader.token, { limit: 50 })).documents;
    const titled = listed.find((one) => one.title.untrusted === `Key ${AKIA_MASKED}`);
    expect(titled).toBeDefined();
    holdsNoPartOf(JSON.stringify(listed), AKIA);
    const view = DocumentView.parse(
      outcomeValue(await store.reader.getDocument(reader.token, { id: titled!.id as DocumentId })),
    );
    expect(view.title).toEqual({ untrusted: `Key ${AKIA_MASKED}` });
    expect(view.masked).toBe(1);
  });

  it("a PEM key cut by a segment's edge is masked and counted in the passage served", async () => {
    const span = EvidenceSpan.parse(outcomeValue(await store.reader.getEvidenceSpan(reader.token, { fact: pemFact })));
    expect(span.passage?.untrusted ?? "").toContain(`${PEM_HEAD}\n*`);
    expect(span.passage?.untrusted ?? "").toBe(
      await passageOf({ body: maskCredentials(PEM_TEXT).text, subject: null }, FIRST_SPAN),
    );
    holdsNoPartOf(span.passage?.untrusted ?? "", "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu");
    expect(span.masked).toBe(1);
  });

  it("context's passages carry their masked count", async () => {
    const view = ContextView.parse(
      outcomeValue(await store.reader.context(reader.token, { task: "Prepare for my job interview" })),
    );
    const passage = view.evidence.find((one) => one.passage.untrusted.includes("Interview key"));
    expect(passage?.passage).toEqual({ untrusted: `Interview key ${GHP_MASKED}` });
    expect(passage?.masked).toBe(1);
    holdsNoPartOf(JSON.stringify(view), GHP);
  });

  it("get_document counts a key in a heading once, and not when the heading is not served", async () => {
    const id = (outcomeValue(await store.reader.findDocuments(reader.token, { limit: 50 })).documents.find(
      (one) => one.title.untrusted === "Plan 1MaskHeadDoc0001",
    )?.id ?? "") as DocumentId;
    const whole = DocumentView.parse(outcomeValue(await store.reader.getDocument(reader.token, { id })));
    expect(whole.outline.map((one) => one.heading.untrusted)).toEqual([`Key ${GHP_MASKED}`]);
    expect(whole.text?.untrusted).toContain(`Key ${GHP_MASKED}`);
    expect(whole.masked).toBe(1);
    // A window after the heading serves neither the heading nor its key.
    const at = (whole.text?.untrusted ?? "").indexOf("Rotate");
    const tail = DocumentView.parse(outcomeValue(await store.reader.getDocument(reader.token, { id, offset: at })));
    expect(tail.outline).toEqual([]);
    expect(tail.text).toEqual({ untrusted: "Rotate it after use." });
    expect(tail).not.toHaveProperty("masked");
  });
});
