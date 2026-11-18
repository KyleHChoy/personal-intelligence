import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublicIdentifier } from "@intelligence/contracts";
import type {
  CardId,
  ClientRegistration,
  EntityId,
  MessageId,
  PageUrl,
  RequestId,
  ResearchArgs,
  ResearchRequestId,
} from "@intelligence/contracts/personal";
import { canonicalUrl } from "@intelligence/personal-core/research";
import { describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { type Accounts, connect, OWNER, type Who, WORK_ONLY } from "../test-support/cast.ts";
import { testId } from "../test-support/clients.ts";
import { one } from "../test-support/connections.ts";
import { fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import { ingestMail, type MailFixture, mailSourceId } from "../test-support/items.ts";
import { MAIL } from "../test-support/items-named.ts";
import { callLog, openStore, type TestStore } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { iso, outcomeValue, registration } from "../test-support/values.ts";
import type { Writer } from "../write/writer.ts";
import { REQUEST_BODY } from "./research.ts";
import { openUnder } from "./seal.ts";

// The run's side, `pi research run`, is not built, and its tests went with it. The database tests of the
// migration itself are research-database.db.test.ts's. Every refusal has its positive control in the same
// test. Synthetic people on reserved hosts only.

const COMPARTMENTS = ["own", "public", "employer:example"];
const READ_TOOLS = [
  "get_self",
  "search",
  "get_entity",
  "get_timeline",
  "find_messages",
  "read_message",
  "find_facts",
] as ClientRegistration["tools"];
const VIEWS = ["self", "people", "work"] as ClientRegistration["views"];

const OWNER_HOME: Who = { address: OWNER.personal, name: OWNER.name };
const OWNER_AT_WORK: Who = { address: OWNER.work, name: OWNER.name };
const SUBJECT: Who = { address: "ilse.marrow@marrowworks.example", name: "Ilse Marrow" };
const SUBJECT_NAME: PublicIdentifier = { kind: "person_name", value: "Ilse Marrow" };
const SUBJECT_DOMAIN: PublicIdentifier = { kind: "domain", value: "marrowworks.example" };

const ROTA = "https://rota.marrowworks.example/week-twelve";
const SEATING = "https://rota.marrowworks.example/week-twelve?seat=7";
const NOT_IN_TEXT = "https://rota.marrowworks.example/week-thirteen";
const WORK_ROTA = "https://rota.partnerfield.example/shifts";
const PROFILE = "https://profiles.marrowworks.example/ilse-marrow";
const PRIVATE_PROFILE = "https://profiles.marrowworks.example/ilse-marrow?ref=7";

// The subject writes to the owner with two links, and the owner answers in the same thread, so a
// client's link may name the message. A work message carries a link of its own.
const FROM_SUBJECT: MailFixture = {
  id: "gm-research-0301",
  threadId: "thread-research-0301",
  at: "2026-09-10T09:00:00Z",
  from: SUBJECT,
  to: [OWNER_HOME],
  subject: "The new rota",
  labels: ["INBOX"],
  text: `The new rota is at ${ROTA} and the seating plan at ${SEATING} for Thursday.`,
};
const ANSWER_TO_SUBJECT: MailFixture = {
  id: "gm-research-0302",
  threadId: "thread-research-0301",
  at: "2026-09-10T10:00:00Z",
  from: OWNER_HOME,
  to: [SUBJECT],
  subject: "Re: The new rota",
  labels: ["SENT"],
  text: "Thank you, see you on Thursday.",
};
const AT_WORK: MailFixture = {
  id: "gm-research-0303",
  threadId: "thread-research-0303",
  at: "2026-09-10T11:00:00Z",
  from: WORK_ONLY,
  to: [OWNER_AT_WORK],
  subject: "Shifts",
  labels: ["INBOX"],
  text: `The shifts are at ${WORK_ROTA}.`,
};

// ---------------------------------------------------------------------------------------------
// The world: a store with keys for `public`, its four mail accounts and an Admin with its journal
// ---------------------------------------------------------------------------------------------

type World = {
  store: TestStore;
  db: TestDatabase;
  writer: Writer;
  admin: Admin;
  accounts: Accounts;
  owner: EntityId;
};

async function inWorld(fn: (w: World) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-research-"));
  const store = await openStore({ compartments: COMPARTMENTS });
  try {
    const accounts = await connect(store.writer);
    const admin = new Admin({
      pool: store.adminPool,
      keys: store.db.keys,
      log: store.log,
      journal: join(dir, "keys.json.erasures"),
    });
    const owner = one(
      await sql<{ id: EntityId }>(store.db, "select id from knowledge.entities where kind = 'owner'"),
    ).id;
    await fn({ store, db: store.db, writer: store.writer, admin, accounts, owner });
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const sql = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);
const count = async (db: TestDatabase, table: string, where = "true", values: unknown[] = []): Promise<number> =>
  one(await sql<{ n: number }>(db, `select count(*)::int as n from ${table} where ${where}`, values)).n;
const req = (): RequestId => testId("req") as RequestId;

const url = (text: string): PageUrl => {
  const canonical = canonicalUrl(text);
  if (canonical === undefined) throw new Error("not a page URL");
  return canonical;
};

// The mail: the subject's message with its links and the owner's reply, Solo's message, and a
// work message with a link. The subject's entity.
async function seedMail(w: World): Promise<EntityId> {
  for (const fixture of [FROM_SUBJECT, ANSWER_TO_SUBJECT, MAIL.solo])
    expect(await ingestMail(w.writer, w.accounts.personalMail, fixture)).toBe("stored");
  expect(await ingestMail(w.writer, w.accounts.workMail, AT_WORK)).toBe("stored");
  return personOf(w, SUBJECT.address);
}

const personOf = async (w: World, address: string): Promise<EntityId> =>
  one(
    await sql<{ entity_id: EntityId }>(w.db, "select distinct entity_id from knowledge.accounts where value_fp = $1", [
      fingerprint(w.db.keys, "address", address),
    ]),
  ).entity_id;

const messageOf = async (w: World, fixture: MailFixture, account = w.accounts.personalMail): Promise<MessageId> =>
  one(
    await sql<{ id: MessageId }>(
      w.db,
      "select m.id from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where e.source_account_id = $1 and e.source_item_fp = $2",
      [account.id, fingerprint(w.db.keys, "source_id", mailSourceId(fixture))],
    ),
  ).id;

// ---------------------------------------------------------------------------------------------
// Requests: the owner's, through the Admin; a client's, through the Reader
// ---------------------------------------------------------------------------------------------

const fileUrl = (
  w: World,
  page: string,
  about: EntityId | null = null,
  names: string[] = [],
): Promise<ResearchRequestId> =>
  w.admin.research.fileOwnerResearch({
    requestId: req(),
    kind: "url",
    url: url(page),
    about,
    names,
    privateUrl: false,
  });
const fileLink = (w: World, message: MessageId, page: string): Promise<ResearchRequestId> =>
  w.admin.research.fileOwnerResearch({ requestId: req(), kind: "link", message, url: url(page) });

// A client of the read tools, given request_research as pi_admin when `research`: the owner's
// commands refuse to register the tool while it is not served.
async function client(w: World, name: string, compartments: string[], research = true): Promise<string> {
  const { token } = await w.store.admin.clients.addClient(
    registration(name, compartments, { tools: READ_TOOLS, views: VIEWS }),
  );
  if (research)
    await sql(w.db, "update policy.clients set tools = tools || array['request_research'] where name = $1", [name]);
  return token;
}

const searchArgs = (about: EntityId, identifiers: PublicIdentifier[], template = "person_profile"): ResearchArgs =>
  ({ kind: "search", requestId: req(), template, identifiers, about }) as ResearchArgs;
const linkArgs = (message: MessageId, page: string): ResearchArgs => ({
  kind: "link",
  requestId: req(),
  message,
  url: url(page),
});
const filed = async (w: World, token: string, args: ResearchArgs): Promise<ResearchRequestId> =>
  outcomeValue(await w.store.reader.fileResearch(token, args)).request as ResearchRequestId;

const cardOf = async (w: World, request: ResearchRequestId): Promise<CardId> =>
  one(await sql<{ card_id: CardId }>(w.db, "select card_id from ledger.research_requests where id = $1", [request]))
    .card_id;
const latest = async (w: World, kind: string, id: string): Promise<string | undefined> =>
  (
    await sql<{ event: string }>(
      w.db,
      "select event from ledger.record_events where row_kind = $1 and row_id = $2 order by id desc limit 1",
      [kind, id],
    )
  )[0]?.event;
const stateOf = (w: World, request: ResearchRequestId): Promise<string | undefined> =>
  latest(w, "research_request", request);
const tainted = (w: World, ids: string[]): Promise<{ id: string; tainted: boolean; dropped: boolean }[]> =>
  sql(
    w.db,
    'select id, tainted_at is not null as tainted, body_enc is null as dropped from ledger.research_requests where id = any($1) order by id collate "C"',
    [ids],
  );

// ---------------------------------------------------------------------------------------------
// Filing, owner requests and the card
// ---------------------------------------------------------------------------------------------

describe("filing, the owner's requests and the card", { timeout: DB_TEST_TIMEOUT }, () => {
  it("Reader.fileResearch files a held name for a client cleared for own and public, answers the request id alone, and logs its call; an unheld name is not_found; a client without the tool is not_permitted", () =>
    inWorld(async (w) => {
      const subject = await seedMail(w);
      const token = await client(w, "file-agent", ["own", "public"]);
      const outcome = await w.store.reader.fileResearch(token, searchArgs(subject, [SUBJECT_NAME]));
      expect(outcome).toEqual({ ok: true, value: { request: expect.stringMatching(/^rsq_/), state: "pending" } });
      const request = outcomeValue(outcome).request as ResearchRequestId;
      const row = one(
        await sql<{
          author: string;
          kind: string;
          compartments: string[];
          by_client: boolean;
          in_session: boolean;
          body_enc: unknown;
        }>(
          w.db,
          "select author, kind, compartments, client_id is not null as by_client, session_id is not null as in_session, body_enc from ledger.research_requests where id = $1",
          [request],
        ),
      );
      expect(row).toMatchObject({
        author: expect.stringMatching(/^client:cli_/),
        kind: "search",
        compartments: ["own", "public"],
        by_client: true,
        in_session: true,
      });
      expect(JSON.parse(openUnder(w.db.keys, ["own", "public"], REQUEST_BODY(request), row.body_enc as never))).toEqual(
        { kind: "search", template: "person_profile", identifiers: [SUBJECT_NAME], about: subject },
      );
      expect(await latest(w, "card", await cardOf(w, request))).toBe("pending");

      expect(
        await w.store.reader.fileResearch(
          token,
          searchArgs(subject, [{ kind: "person_name", value: "Odile Fernmoor" }]),
        ),
      ).toEqual({ ok: false, code: "not_found" });
      const plain = await client(w, "plain-agent", ["own"], false);
      expect(await w.store.reader.fileResearch(plain, searchArgs(subject, [SUBJECT_NAME]))).toEqual({
        ok: false,
        code: "not_permitted",
      });
      expect(await count(w.db, "ledger.research_requests")).toBe(1);
      expect(await callLog(w.db.urls.admin)).toEqual([
        { client: "file-agent", tool: "request_research", rows: 1, outcome: "ok" },
        { client: "file-agent", tool: "request_research", rows: 0, outcome: "not_found" },
        { client: "plain-agent", tool: "request_research", rows: 0, outcome: "not_permitted" },
      ]);
    }));

  it("public-and-research, the owner's side: a URL not in the message's text and a message that is not stored are not_found, a message outside own is not_permitted; a URL in an own message is filed approved, once per request id", () =>
    inWorld(async (w) => {
      await seedMail(w);
      const home = await messageOf(w, FROM_SUBJECT);
      const work = await messageOf(w, AT_WORK, w.accounts.workMail);
      await expect(fileLink(w, home, NOT_IN_TEXT)).rejects.toMatchObject({ code: "not_found" });
      await expect(fileLink(w, testId("msg") as MessageId, ROTA)).rejects.toMatchObject({ code: "not_found" });
      await expect(fileLink(w, work, WORK_ROTA)).rejects.toMatchObject({ code: "not_permitted" });
      expect(await count(w.db, "ledger.research_requests")).toBe(0);

      const requestId = req();
      const link = await w.admin.research.fileOwnerResearch({ requestId, kind: "link", message: home, url: url(ROTA) });
      expect(await w.admin.research.fileOwnerResearch({ requestId, kind: "link", message: home, url: url(ROTA) })).toBe(
        link,
      );
      expect(
        await sql(w.db, "select author, kind, message_id, card_id, compartments from ledger.research_requests"),
      ).toEqual([{ author: "owner", kind: "link", message_id: home, card_id: null, compartments: ["own"] }]);
      expect(await stateOf(w, link)).toBe("approved");
      expect(
        await sql(
          w.db,
          "select kind, answer, target_kind, target_id from knowledge.owner_decisions where kind = 'research'",
        ),
      ).toEqual([{ kind: "research", answer: "typed", target_kind: "research_request", target_id: link }]);
    }));

  it("public-and-research, a client's side: while off every link is not_permitted; on, a URL not in the text is not_found, a private one is not_permitted, one in the text is filed, and a second on the message is not_permitted", () =>
    inWorld(async (w) => {
      await seedMail(w);
      const home = await messageOf(w, FROM_SUBJECT);
      const token = await client(w, "link-agent", ["own"]);
      expect(await w.store.reader.fileResearch(token, linkArgs(home, ROTA))).toEqual({
        ok: false,
        code: "not_permitted",
      });
      await w.admin.research.setResearchSettings({ clientLinkRequests: true }, { requestId: req() });
      expect(await w.store.reader.fileResearch(token, linkArgs(home, NOT_IN_TEXT))).toEqual({
        ok: false,
        code: "not_found",
      });
      expect(await w.store.reader.fileResearch(token, linkArgs(testId("msg") as MessageId, ROTA))).toEqual({
        ok: false,
        code: "not_found",
      });
      // In the text, and private: refused for what the client could see.
      expect(await w.store.reader.fileResearch(token, linkArgs(home, SEATING))).toEqual({
        ok: false,
        code: "not_permitted",
      });
      expect(await count(w.db, "ledger.research_requests")).toBe(0);

      const link = await filed(w, token, linkArgs(home, ROTA));
      expect(await sql(w.db, "select id, kind, message_id, compartments from ledger.research_requests")).toEqual([
        { id: link, kind: "link", message_id: home, compartments: ["own"] },
      ]);
      expect(await w.store.reader.fileResearch(token, linkArgs(home, ROTA))).toEqual({
        ok: false,
        code: "not_permitted",
      });
      expect(await count(w.db, "ledger.research_requests")).toBe(1);
    }));

  it("the owner's private URL is refused private_url without privateUrl, and filed with it, its decision saying so; names without a subject are refused", () =>
    inWorld(async (w) => {
      await expect(
        w.admin.research.fileOwnerResearch({
          requestId: req(),
          kind: "url",
          url: url(PRIVATE_PROFILE),
          about: null,
          names: [],
          privateUrl: false,
        }),
      ).rejects.toMatchObject({
        code: "private_url",
      });
      await expect(
        w.admin.research.fileOwnerResearch({
          requestId: req(),
          kind: "url",
          url: url(PROFILE),
          about: null,
          names: ["Ilse Marrow"],
          privateUrl: false,
        }),
      ).rejects.toMatchObject({
        code: "invalid_argument",
      });
      expect(await count(w.db, "ledger.research_requests")).toBe(0);
      const id = await w.admin.research.fileOwnerResearch({
        requestId: req(),
        kind: "url",
        url: url(PRIVATE_PROFILE),
        about: null,
        names: [],
        privateUrl: true,
      });
      expect(
        await sql(w.db, "select answer, details from knowledge.owner_decisions where target_id = $1", [id]),
      ).toEqual([{ answer: "typed", details: { privateUrl: true } }]);
    }));

  it("every line of the card is marked code and names each identifier's compartments; two identifiers add the pairing line, one does not", () =>
    inWorld(async (w) => {
      const subject = await seedMail(w);
      const token = await client(w, "card-agent", ["own", "public"]);
      const pair = await filed(w, token, searchArgs(subject, [SUBJECT_NAME, SUBJECT_DOMAIN], "person_role"));
      const single = await filed(w, token, searchArgs(subject, [SUBJECT_NAME]));
      const pairing = "these values together may state a private fact about this person";
      const card = async (request: ResearchRequestId) => {
        const detail = await w.admin.cards.card(await cardOf(w, request));
        if (detail === null) throw new Error("no card");
        expect(detail.lines.length).toBeGreaterThan(0);
        expect(detail.lines.every((line) => line.from === "code")).toBe(true);
        return detail.lines.map((line) => line.text);
      };
      const paired = await card(pair);
      expect(paired).toEqual(
        expect.arrayContaining([
          "person_name: Ilse Marrow (held under: own)",
          "domain: marrowworks.example (held under: own)",
          "Ilse Marrow: known only from your private sources; the search vendor will see it",
          "marrowworks.example: known only from your private sources; the search vendor will see it",
          pairing,
          "approving makes public, to every client cleared for public, that these pages are about this subject",
        ]),
      );
      expect(paired.some((text) => text.startsWith("requester: client:cli_"))).toBe(true);
      const alone = await card(single);
      expect(alone).toContain("person_name: Ilse Marrow (held under: own)");
      expect(alone).not.toContain(pairing);
    }));

  it("approve writes an owner decision of kind research and the approved event; decline writes declined", () =>
    inWorld(async (w) => {
      const subject = await seedMail(w);
      const token = await client(w, "decide-agent", ["own"]);
      const approved = await filed(w, token, searchArgs(subject, [SUBJECT_NAME]));
      const declined = await filed(w, token, searchArgs(subject, [SUBJECT_NAME]));
      const approveCard = await cardOf(w, approved);
      const declineCard = await cardOf(w, declined);
      await w.admin.cards.decide({ cards: [approveCard], answer: "approve", requestId: req() });
      await w.admin.cards.decide({ cards: [declineCard], answer: "decline", requestId: req() });
      expect(
        await sql(
          w.db,
          "select answer, target_kind, target_id, card_id from knowledge.owner_decisions where kind = 'research' order by answer",
        ),
      ).toEqual([
        { answer: "approve", target_kind: "research_request", target_id: approved, card_id: approveCard },
        { answer: "decline", target_kind: "research_request", target_id: declined, card_id: declineCard },
      ]);
      expect([await stateOf(w, approved), await stateOf(w, declined)]).toEqual(["approved", "declined"]);
    }));

  it("withdrawResearch withdraws a pending request with its card and an approved one, and nothing that has ended or does not exist", () =>
    inWorld(async (w) => {
      const subject = await seedMail(w);
      const token = await client(w, "withdraw-agent", ["own"]);
      const pending = await filed(w, token, searchArgs(subject, [SUBJECT_NAME]));
      const approved = await fileUrl(w, PROFILE);
      expect(await w.admin.research.withdrawResearch(pending)).toBe(true);
      expect([await stateOf(w, pending), await latest(w, "card", await cardOf(w, pending))]).toEqual([
        "withdrawn",
        "withdrawn",
      ]);
      expect(await w.admin.research.withdrawResearch(approved)).toBe(true);
      expect(await stateOf(w, approved)).toBe("withdrawn");
      expect(await w.admin.research.withdrawResearch(pending)).toBe(false);
      expect(await w.admin.research.withdrawResearch(testId("rsq") as ResearchRequestId)).toBe(false);
      expect((await w.admin.research.listResearch("withdrawn")).map((row) => row.id).sort()).toEqual(
        [pending, approved].sort(),
      );
      expect(await w.admin.research.showResearch(approved)).toMatchObject({
        id: approved,
        kind: "url",
        state: "withdrawn",
        body: { kind: "url", url: url(PROFILE) },
      });
    }));

  it("settings: the defaults; a change written with its research_settings decision; a repeated request id and an empty patch change nothing", () =>
    inWorld(async (w) => {
      const defaults = {
        clientLinkRequests: false,
        maxRequestsPerClientPerDay: 5,
        maxSearchesPerDay: 10,
        maxFetchesPerDay: 30,
        maxPagesPerRequest: 5,
        refetchAfterDays: 30,
        cardExpiryDays: 14,
      };
      expect(await w.admin.research.settings()).toEqual(defaults);
      const requestId = req();
      const ruling = await w.admin.research.setResearchSettings(
        { maxFetchesPerDay: 12, clientLinkRequests: true },
        { requestId },
      );
      const changed = { ...defaults, maxFetchesPerDay: 12, clientLinkRequests: true };
      expect(await w.admin.research.settings()).toEqual(changed);
      expect(
        await sql(w.db, "select id, kind, target_kind, details from knowledge.owner_decisions where request_id = $1", [
          requestId,
        ]),
      ).toEqual([
        {
          id: ruling,
          kind: "research_settings",
          target_kind: null,
          details: { maxFetchesPerDay: 12, clientLinkRequests: true },
        },
      ]);
      expect(await w.admin.research.setResearchSettings({ maxFetchesPerDay: 3 }, { requestId })).toBe(ruling);
      await expect(w.admin.research.setResearchSettings({}, { requestId: req() })).rejects.toMatchObject({
        code: "invalid_argument",
      });
      expect(await w.admin.research.settings()).toEqual(changed);
      expect(await count(w.db, "knowledge.owner_decisions", "kind = 'research_settings'")).toBe(1);
    }));
});

// ---------------------------------------------------------------------------------------------
// Erasure
// ---------------------------------------------------------------------------------------------

describe("erasure and research", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a client request whose session read an item later deleted at the source is tainted and its body dropped; another client's request is not", () =>
    inWorld(async (w) => {
      const subject = await seedMail(w);
      const reading = await client(w, "reading-agent", ["own"]);
      const clean = await client(w, "clean-agent", ["own"]);
      outcomeValue(await w.store.reader.readMessage(reading, { id: await messageOf(w, MAIL.solo) }));
      const afterRead = await filed(w, reading, searchArgs(subject, [SUBJECT_NAME]));
      const other = await filed(w, clean, searchArgs(subject, [SUBJECT_NAME]));
      for (const request of [afterRead, other])
        await w.admin.cards.decide({ cards: [await cardOf(w, request)], answer: "approve", requestId: req() });

      await w.writer.applyDeletion(w.accounts.personalMail, {
        sourceAccount: w.accounts.personalMail.id,
        sourceItemId: mailSourceId(MAIL.solo),
        deletedAt: iso(new Date()),
      });
      expect(await tainted(w, [afterRead])).toEqual([{ id: afterRead, tainted: true, dropped: true }]);
      expect(await tainted(w, [other])).toEqual([{ id: other, tainted: false, dropped: false }]);
      expect(await stateOf(w, afterRead)).toBe("tainted");
    }));
});
