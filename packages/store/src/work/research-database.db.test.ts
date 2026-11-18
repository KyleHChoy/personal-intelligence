import { randomBytes } from "node:crypto";
import { evidenceIdFor } from "@intelligence/contracts/evidence-id";
import { SourceAccountId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { openUnder, sealUnder } from "../core/seal.ts";
import { RUNTIME_ROLES } from "../test-support/catalogue-grants.ts";
import {
  ALL_TOOLS,
  ALL_VIEWS,
  hashFingerprint,
  insertClient,
  sha256Hex,
  type TestClient,
  testId,
} from "../test-support/clients.ts";
import {
  ownerCommitted as asTableOwner,
  one,
  type Query,
  readAs,
  refusal,
  session,
  openSession as sessionOf,
  sqlState,
} from "../test-support/connections.ts";
import { fingerprint, queryAs, scanForPlaintext, sealRow, type TestDatabase } from "../test-support/database.ts";
import { seeder } from "../test-support/seeder.ts";
import { withDatabase } from "../test-support/store.ts";
import { MISSING_ENTITY } from "../test-support/values.ts";

// Each function is called in SQL as its role, with a token set where it takes one. Every refusal
// has its positive control in the same test, and a permission refusal is SQLSTATE 42501. Synthetic
// values on reserved `.example` hosts only.

const TIMEOUT = 180_000;
const COMPARTMENTS = ["own", "public", "employer:example"];
const RESEARCH_TOOLS = [...ALL_TOOLS, "request_research"];
// A well-formed envelope, for a label whose keys the test key file does not hold: the function
// refuses such a label before it reads the body.
const UNSEALABLE = { v: 1, nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAA", tag: "AAAAAAAAAAAAAAAAAAAAAA==" };
const TABLES = ["ledger.research_requests", "ledger.research_fetches", "knowledge.pages", "policy.research_settings"];
const PAGE_READER_COLUMNS = [
  "id",
  "evidence_id",
  "request_id",
  "url_fp",
  "host_fp",
  "fetched_at",
  "media_type",
  "about_entity_id",
  "page_enc",
  "compartments",
];

// One database per test, with keys for `public` beside the default two.
const withResearch = <T>(fn: (db: TestDatabase) => Promise<T>): Promise<T> =>
  withDatabase(fn, { compartments: COMPARTMENTS });
const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);
const writer = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.writer, text, values);

// ---------------------------------------------------------------------------------------------
// Clients, sessions and filings
// ---------------------------------------------------------------------------------------------

type Client = TestClient & { tools: string[]; views: string[] };

// A client given request_research as pi_admin: the owner's commands refuse to register the tool
// while nothing serves it.
async function researcher(
  db: TestDatabase,
  name: string,
  compartments: string[] = ["own"],
  options: { tools?: string[]; views?: string[] } = {},
): Promise<Client> {
  const client = await insertClient(db, name, compartments);
  const tools = options.tools ?? RESEARCH_TOOLS;
  const views = options.views ?? ALL_VIEWS;
  await admin(db, "update policy.clients set tools = $2, views = $3 where id = $1", [client.id, tools, views]);
  return { ...client, tools, views };
}

type Filing = {
  session: string;
  label: string[];
  kind?: "search" | "link";
  id?: string;
  requestId?: string;
  cardId?: string;
  template?: string;
  version?: number;
  about?: string;
  kinds?: string[];
  fps?: string[];
  message?: string;
  url?: string;
  queryFp?: string;
  body?: unknown;
  // The plaintext the body seals: identifiers' values for a search, the URL for a link.
  value?: string;
};
type Filed = { outcome: string; research_id: string | null };

const FILE =
  "select outcome, research_id from ledger.file_research($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)";

const sealable = (db: TestDatabase, label: string[]): boolean =>
  label.length > 0 && label.every((compartment) => db.keys.compartments.has(compartment));

function fileArgs(db: TestDatabase, f: Filing): unknown[] {
  const id = f.id ?? testId("rsq");
  const kind = f.kind ?? "search";
  const url = f.url ?? "https://links.example/a-page";
  const value =
    f.value ?? (kind === "search" ? JSON.stringify({ identifiers: ["synthetic value"] }) : JSON.stringify({ url }));
  const body =
    f.body ??
    (sealable(db, f.label)
      ? sealUnder(db.keys, f.label, { table: "ledger.research_requests", id, column: "body_enc" }, value)
      : UNSEALABLE);
  const search = kind === "search";
  return [
    f.session,
    id,
    f.requestId ?? testId("req"),
    f.cardId ?? testId("crd"),
    kind,
    search ? (f.template ?? "person_profile") : null,
    search ? (f.version ?? 1) : null,
    search ? (f.about ?? MISSING_ENTITY) : null,
    search ? (f.kinds ?? (f.fps ?? []).map(() => "person_name")) : [],
    search ? (f.fps ?? []) : [],
    search ? null : (f.message ?? testId("msg")),
    search ? null : true,
    f.queryFp ?? fingerprint(db.keys, "research_query", `${kind}\n${randomBytes(8).toString("hex")}`),
    search ? null : fingerprint(db.keys, "source_id", url),
    f.label,
    body,
  ];
}

const file = (db: TestDatabase, client: Client, f: Filing): Promise<Filed> =>
  readAs(db, client.token, async (query) => one(await query<Filed>(FILE, fileArgs(db, f))));

const NOT_FOUND: Filed = { outcome: "not_found", research_id: null };
const NOT_PERMITTED: Filed = { outcome: "not_permitted", research_id: null };
const RATE_LIMITED: Filed = { outcome: "rate_limited", research_id: null };

// The rows a filing writes, counted as pi_admin.
async function counts(db: TestDatabase): Promise<Record<string, number>> {
  const row = one(
    await admin<Record<string, number>>(
      db,
      `select (select count(*)::int from ledger.research_requests) as requests, (select count(*)::int from ledger.research_fetches) as fetches,
              (select count(*)::int from ledger.cards) as cards, (select count(*)::int from ledger.record_events) as events,
              (select count(*)::int from knowledge.pages) as pages`,
    ),
  );
  return row;
}

type Seed = ReturnType<typeof seeder>;

// An alias with a name of the test's own, so two seeders never make one name twice.
async function alias(
  db: TestDatabase,
  query: Query,
  seed: Seed,
  entity: string,
  compartments: string[],
  name: string,
): Promise<string> {
  const id = testId("als");
  const valueFp = fingerprint(db.keys, "name", name);
  await query(
    "insert into knowledge.aliases (id, entity_id, value_fp, evidence_id, compartments, value_enc) values ($1, $2, $3, $4, $5, $6)",
    [
      id,
      entity,
      valueFp,
      await seed.evidence(),
      compartments,
      sealRow(db.keys, compartments[0] ?? "own", { table: "knowledge.aliases", id, column: "value_enc" }, name),
    ],
  );
  return valueFp;
}

const accountFps = async (query: Query, account: string): Promise<{ address: string; domain: string }> =>
  one(
    await query<{ address: string; domain: string }>(
      "select value_fp as address, domain_fp as domain from knowledge.accounts where id = $1",
      [account],
    ),
  );

// A person the store holds under `own`: an account and one alias, both `own`.
type Person = { entity: string; nameFp: string; domainFp: string; addressFp: string };
async function person(db: TestDatabase, name: string, compartments: string[] = ["own"]): Promise<Person> {
  return session(db.urls.admin, async (query) => {
    const seed = seeder(db, query);
    const entity = await seed.entity("person");
    const fps = await accountFps(query, await seed.account(compartments, entity));
    const nameFp = await alias(db, query, seed, entity, compartments, name);
    return { entity, nameFp, domainFp: fps.domain, addressFp: fps.address };
  });
}

// ---------------------------------------------------------------------------------------------
// Owner requests, fetches and pages, as `pi fetch`, the run and the writer leave them
// ---------------------------------------------------------------------------------------------

const approve = (db: TestDatabase, request: string, label: string[]): Promise<unknown> =>
  admin(
    db,
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('research_request', $1, 'approved', now(), 'owner', $2)",
    [request, label],
  );

// An owner request, inserted as pi_admin as `pi fetch` files one, labelled `own`, and approved.
async function ownerRequest(
  db: TestDatabase,
  options: { kind: "url" | "link"; url?: string; about?: string | null; approved?: boolean },
): Promise<string> {
  const id = testId("rsq");
  const url = options.url ?? `https://pages.example/${randomBytes(4).toString("hex")}`;
  await admin(
    db,
    `insert into ledger.research_requests (id, request_id, author, kind, about_entity_id, message_id, query_fp, source_item_fp, body_enc, compartments)
     values ($1, $2, 'owner', $3, $4, $5, $6, $7, $8, '{own}')`,
    [
      id,
      testId("req"),
      options.kind,
      options.about ?? null,
      options.kind === "link" ? testId("msg") : null,
      fingerprint(db.keys, "research_query", `${options.kind}\n${url}`),
      fingerprint(db.keys, "source_id", url),
      sealUnder(
        db.keys,
        ["own"],
        { table: "ledger.research_requests", id, column: "body_enc" },
        JSON.stringify({ url }),
      ),
    ],
  );
  if (options.approved ?? true) await approve(db, id, ["own"]);
  return id;
}

// A request's stored page fetch, as the research run would record it: the request's running
// event, once, and the ended fetch row, written as pi_admin, since the run is not built.
async function storedFetch(db: TestDatabase, request: string, label: string[], url: string, evidence: string) {
  if ((await stateOf(db, "research_request", request)) !== "running")
    await admin(
      db,
      "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('research_request', $1, 'running', now(), 'system:research', $2)",
      [request, label],
    );
  const id = testId("rft");
  await admin(
    db,
    `insert into ledger.research_fetches (id, research_request_id, kind, started_at, ended_at, outcome, evidence_id, host_fp, url_fp, body_enc, compartments)
     values ($1, $2, 'page', now(), now(), 'stored', $3, $4, $5, $6, $7)`,
    [
      id,
      request,
      evidence,
      fingerprint(db.keys, "host", new URL(url).host),
      fingerprint(db.keys, "url", url),
      sealUnder(db.keys, label, { table: "ledger.research_fetches", id, column: "body_enc" }, url),
      label,
    ],
  );
}

// The web account of a compartment, made once, as ensureWebAccount makes it: label = compartment.
async function webAccount(db: TestDatabase, compartment: "public" | "own"): Promise<string> {
  const found = await admin<{ id: string }>(
    db,
    "select id from vault.source_accounts where connector = 'web' and label = $1",
    [compartment],
  );
  if (found[0] !== undefined) return found[0].id;
  const id = SourceAccountId.parse(testId("acc"));
  await admin(
    db,
    "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, $2, 'web', 'web_research', $3)",
    [id, compartment, [compartment]],
  );
  return id;
}

// One web_research evidence row, its payload the page text, sealed.
async function webEvidence(
  db: TestDatabase,
  compartment: "public" | "own",
  url: string,
  text: string,
): Promise<string> {
  const account = SourceAccountId.parse(await webAccount(db, compartment));
  const blobRef = testId("blb");
  await admin(db, "insert into vault.evidence_blobs (blob_ref, compartments, envelope) values ($1, $2, $3)", [
    blobRef,
    [compartment],
    sealRow(
      db.keys,
      compartment,
      { table: "vault.evidence_blobs", id: blobRef, column: "envelope" },
      Buffer.from(text).toString("base64"),
    ),
  ]);
  const at = { vault: "personal" as const, sourceAccount: account, sourceItemId: url };
  const id = evidenceIdFor({ ...at, revision: 0 });
  await admin(
    db,
    `insert into vault.evidence_items (id, source_account_id, source_kind, source_item_fp, revision_tag_fp, revision, next_revision_id, content_hash, media_type,
       observed_at, change_kind, participant_members, system_originated, answers_system, payload_state, compartments, readers, blob_ref, item_enc)
     values ($1, $2, 'web_research', $3, $4, 0, $5, $6, 'text/html', now(), 'live', '{}', false, false, 'present', $7, '{m-owner}', $8, $9)`,
    [
      id,
      account,
      fingerprint(db.keys, "source_id", url),
      fingerprint(db.keys, "revision_tag", sha256Hex(text)),
      evidenceIdFor({ ...at, revision: 1 }),
      hashFingerprint(db.keys, "content_hash", sha256Hex(text)),
      [compartment],
      blobRef,
      sealRow(
        db.keys,
        compartment,
        { table: "vault.evidence_items", id, column: "item_enc" },
        JSON.stringify({ sourceItemId: url, markers: ["web"] }),
      ),
    ],
  );
  return id;
}

// A stored page of a request: its first egress (the request runs), its evidence, and the page
// row written as pi_writer. A link request's page is `own`; any other's `public`.
type PageOptions = {
  request: string;
  requestLabel: string[];
  compartment: "public" | "own";
  about?: string | null;
  url?: string;
  title?: string;
  text?: string;
  names?: string[];
};
async function page(db: TestDatabase, options: PageOptions): Promise<string> {
  const url = options.url ?? `https://pages.example/${randomBytes(4).toString("hex")}`;
  const evidence = await webEvidence(db, options.compartment, url, options.text ?? "A synthetic page body.");
  await storedFetch(db, options.request, options.requestLabel, url, evidence);
  const id = testId("pag");
  const at = (column: string) => ({ table: "knowledge.pages", id, column });
  await writer(
    db,
    `insert into knowledge.pages (id, evidence_id, request_id, url_fp, host_fp, fetched_at, media_type, about_entity_id, page_enc, names_enc, compartments)
     values ($1, $2, $3, $4, $5, now(), 'text/html', $6, $7, $8, $9)`,
    [
      id,
      evidence,
      options.request,
      fingerprint(db.keys, "url", url),
      fingerprint(db.keys, "host", new URL(url).host),
      options.about ?? null,
      sealRow(
        db.keys,
        options.compartment,
        at("page_enc"),
        JSON.stringify({ url, title: options.title ?? "A synthetic title" }),
      ),
      sealRow(db.keys, options.compartment, at("names_enc"), JSON.stringify(options.names ?? [])),
      [options.compartment],
    ],
  );
  return id;
}

// One public page (an owner `url` request) and one own page (an owner `link` request).
async function twoPages(
  db: TestDatabase,
): Promise<{ publicPage: string; ownPage: string; publicRequest: string; ownRequest: string }> {
  const publicRequest = await ownerRequest(db, { kind: "url" });
  const ownRequest = await ownerRequest(db, { kind: "link" });
  const publicPage = await page(db, { request: publicRequest, requestLabel: ["own"], compartment: "public" });
  const ownPage = await page(db, { request: ownRequest, requestLabel: ["own"], compartment: "own" });
  return { publicPage, ownPage, publicRequest, ownRequest };
}

const stateOf = async (db: TestDatabase, kind: string, id: string): Promise<string | undefined> =>
  (
    await admin<{ event: string }>(
      db,
      "select event from ledger.record_events where row_kind = $1 and row_id = $2 order by id desc limit 1",
      [kind, id],
    )
  )[0]?.event;

describe("ledger.file_research", { timeout: TIMEOUT }, () => {
  it("a held name is accepted; an unheld name, a name held only under employer, and an entity outside the clearance each answer not_found, identically to an entity that does not exist", () =>
    withResearch(async (db) => {
      const client = await researcher(db, "r6-agent");
      const ses = await sessionOf(db, client);
      const world = await session(db.urls.admin, async (query) => {
        const seed = seeder(db, query);
        const held = await seed.entity("person");
        const heldAccount = await accountFps(query, await seed.account(["own"], held));
        const heldName = await alias(db, query, seed, held, ["own"], "Corvina Haldane");
        const employerName = await alias(db, query, seed, held, ["employer:example"], "Corvina Haldane-Workfield");
        const outside = await seed.entity("person");
        await seed.account(["employer:example"], outside);
        const outsideName = await alias(db, query, seed, outside, ["employer:example"], "Tobiah Fennimore");
        const organization = await seed.entity("organization");
        const orgDomain = one(
          await query<{ fp: string }>("select domain_fp as fp from knowledge.domains where id = $1", [
            await seed.domain(["own"], organization),
          ]),
        ).fp;
        const employerDomain = one(
          await query<{ fp: string }>("select domain_fp as fp from knowledge.domains where id = $1", [
            await seed.domain(["employer:example"], organization),
          ]),
        ).fp;
        return {
          held,
          heldAccount,
          heldName,
          employerName,
          outside,
          outsideName,
          organization,
          orgDomain,
          employerDomain,
        };
      });
      const search = (about: string, fps: string[], kinds?: string[]) =>
        file(db, client, { session: ses, label: ["own"], about, fps, ...(kinds === undefined ? {} : { kinds }) });

      const before = await counts(db);
      const refused = [
        await search(world.held, [fingerprint(db.keys, "name", "A Name Never Stored")]),
        await search(world.held, [world.employerName]),
        await search(world.held, [world.heldName, world.employerName]),
        await search(world.outside, [world.outsideName]),
        await search(MISSING_ENTITY, [world.heldName]),
        await search(world.organization, [world.employerDomain], ["domain"]),
      ];
      for (const answer of refused) expect(answer).toEqual(NOT_FOUND);
      expect(await counts(db)).toEqual(before);

      // The positive controls: a held name, the domain of a held account, a held domain row.
      expect((await search(world.held, [world.heldName])).outcome).toBe("ok");
      expect(
        (await search(world.held, [world.heldName, world.heldAccount.domain], ["person_name", "domain"])).outcome,
      ).toBe("ok");
      expect((await search(world.organization, [world.orgDomain], ["domain"])).outcome).toBe("ok");
    }));

  it("a client without the tool or the people view is not_permitted", () =>
    withResearch(async (db) => {
      const subject = await person(db, "Ambrose Quillfeather");
      const noTool = await researcher(db, "r5-no-tool", ["own"], { tools: ALL_TOOLS });
      const noView = await researcher(db, "r5-no-view", ["own"], { views: ["self", "work"] });
      const allowed = await researcher(db, "r5-allowed");
      const filing = async (client: Client) =>
        file(db, client, {
          session: await sessionOf(db, client),
          label: ["own"],
          about: subject.entity,
          fps: [subject.nameFp],
        });

      const before = await counts(db);
      expect(await filing(noTool)).toEqual(NOT_PERMITTED);
      expect(await filing(noView)).toEqual(NOT_PERMITTED);
      expect(await counts(db)).toEqual(before);
      expect((await filing(allowed)).outcome).toBe("ok");
    }));

  it("a client cleared for employer, for restricted:health or for an unknown compartment is not_permitted", () =>
    withResearch(async (db) => {
      const subject = await person(db, "Ottoline Brackwater");
      const filing = async (client: Client) =>
        file(db, client, {
          session: await sessionOf(db, client),
          label: [...client.compartments].sort(),
          about: subject.entity,
          fps: [subject.nameFp],
        });

      const before = await counts(db);
      for (const [name, clearance] of [
        ["r8-employer", ["own", "employer:example"]],
        ["r8-employer-released", ["own", "employer:example-released"]],
        ["r8-restricted", ["own", "restricted:health"]],
        ["r8-declassified", ["own", "declassified"]],
      ] as const) {
        expect(await filing(await researcher(db, name, [...clearance])), name).toEqual(NOT_PERMITTED);
      }
      // A client cleared for an unknown compartment cannot exist: the database refuses its row
      // (compartments_syntax), so no filing is ever asked under one.
      await expect(researcher(db, "r8-unknown", ["own", "unheard-of:compartment"])).rejects.toThrow(
        /compartments_syntax/,
      );
      expect(await counts(db)).toEqual(before);

      // The positive controls: `own`, and `own` with `public`.
      expect((await filing(await researcher(db, "r8-own", ["own"]))).outcome).toBe("ok");
      const both = await filing(await researcher(db, "r8-both", ["own", "public"]));
      expect(both.outcome).toBe("ok");
      expect(
        one(
          await admin<{ compartments: string[] }>(
            db,
            "select compartments from ledger.research_requests where id = $1",
            [both.research_id],
          ),
        ).compartments,
      ).toEqual(["own", "public"]);
    }));

  it("a request's label is the token's clearance without the agent compartment", () =>
    withResearch(async (db) => {
      const subject = await person(db, "Isaura Penhallow");
      // A client with record holds its own agent compartment (admin-clients.ts, labelled).
      const agent = await researcher(db, "r8-alpha", ["own", "public", "agent:r8-alpha"], {
        tools: [...RESEARCH_TOOLS, "record"],
      });
      const recordLabel = one(
        await readAs(db, agent.token, (query) => query<{ label: string[] }>("select policy.record_label() as label")),
      ).label;
      expect(recordLabel).toEqual(["agent:r8-alpha", "own", "public"]);
      const ses = await sessionOf(db, agent);

      // The agent compartment is not the request's label: handed in, it is not the token's label.
      expect(
        await sqlState(() =>
          file(db, agent, {
            session: ses,
            label: ["agent:r8-alpha", "own", "public"],
            about: subject.entity,
            fps: [subject.nameFp],
          }),
        ),
      ).toBe("42501");

      const filed = await file(db, agent, {
        session: ses,
        label: ["own", "public"],
        about: subject.entity,
        fps: [subject.nameFp],
      });
      expect(filed.outcome).toBe("ok");
      const request = one(
        await admin<{ compartments: string[]; card_id: string }>(
          db,
          "select compartments, card_id from ledger.research_requests where id = $1",
          [filed.research_id],
        ),
      );
      expect(request.compartments).toEqual(["own", "public"]);
      expect(
        one(
          await admin<{ compartments: string[] }>(db, "select compartments from ledger.cards where id = $1", [
            request.card_id,
          ]),
        ).compartments,
      ).toEqual(["own", "public"]);
      const events = await admin<{ compartments: string[] }>(
        db,
        "select compartments from ledger.record_events where (row_kind = 'research_request' and row_id = $1) or (row_kind = 'card' and row_id = $2)",
        [filed.research_id, request.card_id],
      );
      expect(events).toHaveLength(2);
      for (const event of events) expect(event.compartments).toEqual(["own", "public"]);

      // Another agent's compartment is no agent compartment of the filer's: it is refused.
      const other = await researcher(db, "r8-beta", ["own", "agent:r8-gamma"]);
      expect(
        await file(db, other, {
          session: await sessionOf(db, other),
          label: ["agent:r8-gamma", "own"],
          about: subject.entity,
          fps: [subject.nameFp],
        }),
      ).toEqual(NOT_PERMITTED);
    }));

  it("while client_link_requests is off every client link request is not_permitted, with a held and an unheld message alike", () =>
    withResearch(async (db) => {
      const client = await researcher(db, "r7-agent");
      const ses = await sessionOf(db, client);
      // Two inbound own messages in a thread the owner answered; one of them held.
      const { open, held } = await session(db.urls.admin, async (query) => {
        const seed = seeder(db, query);
        const thread = fingerprint(db.keys, "thread", `r7-thread-${randomBytes(4).toString("hex")}`);
        const openId = await seed.message(["own"], undefined, {
          text: "See https://links.example/a-page for the agenda.",
        });
        const heldId = await seed.message(["own"], undefined, {
          held: true,
          text: "See https://links.example/a-page for the agenda.",
        });
        const answer = await seed.message(["own"]);
        await query("update knowledge.messages set thread_fp = $2 where id = any ($1)", [
          [openId, heldId, answer],
          thread,
        ]);
        await query("update knowledge.messages set direction = 'outbound' where id = $1", [answer]);
        return { open: openId, held: heldId };
      });
      const link = (message: string) =>
        file(db, client, { session: ses, label: ["own"], kind: "link", message, url: "https://links.example/a-page" });

      expect(
        one(await admin<{ on: boolean }>(db, "select client_link_requests as on from policy.research_settings")).on,
      ).toBe(false);
      const before = await counts(db);
      expect(await link(open)).toEqual(NOT_PERMITTED);
      expect(await link(held)).toEqual(NOT_PERMITTED);
      expect(await link(MISSING_ENTITY.replace("ent_", "msg_"))).toEqual(NOT_PERMITTED);
      expect(await counts(db)).toEqual(before);

      // The positive control: with the switch on, the unheld message's link is filed and the
      // held one is not_found.
      await admin(db, "update policy.research_settings set client_link_requests = true");
      expect(await link(held)).toEqual(NOT_FOUND);
      expect((await link(open)).outcome).toBe("ok");
    }));

  it("a client with ten pending cards is rate_limited and nothing is written", () =>
    withResearch(async (db) => {
      const subject = await person(db, "Lisandro Whitcombe");
      const client = await researcher(db, "r9-cards");
      const ses = await sessionOf(db, client);
      const author = `client:${client.id}`;
      for (let index = 0; index < 9; index += 1) {
        const id = testId("crd");
        await admin(
          db,
          `insert into ledger.cards (id, request_id, created_at, created_by, kind, target_kind, target_id, options, expires_after_days, compartments)
           values ($1, $2, now(), $3, 'agent_claim', 'claim', $2, '{confirm,reject}', 30, '{own}')`,
          [id, testId("req"), author],
        );
        await admin(
          db,
          "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'pending', now(), $2, '{own}')",
          [id, author],
        );
      }
      const filing = () =>
        file(db, client, { session: ses, label: ["own"], about: subject.entity, fps: [subject.nameFp] });

      // Nine pending: the tenth card is the research card itself.
      expect((await filing()).outcome).toBe("ok");
      const before = await counts(db);
      expect(await filing()).toEqual(RATE_LIMITED);
      expect(await counts(db)).toEqual(before);
      const cards = await admin<{ kind: string }>(db, "select kind from ledger.cards where created_by = $1", [author]);
      expect(cards).toHaveLength(10);
    }));

  it("the sixth request of a UTC day is rate_limited, and another client's requests change no count", () =>
    withResearch(async (db) => {
      const subject = await person(db, "Perpetua Ingleby");
      const first = await researcher(db, "r9-first");
      const second = await researcher(db, "r9-second");
      const firstSession = await sessionOf(db, first);
      const secondSession = await sessionOf(db, second);
      const filing = (client: Client, ses: string) =>
        file(db, client, { session: ses, label: ["own"], about: subject.entity, fps: [subject.nameFp] });

      for (let index = 0; index < 5; index += 1) expect((await filing(second, secondSession)).outcome).toBe("ok");
      for (let index = 0; index < 5; index += 1) expect((await filing(first, firstSession)).outcome).toBe("ok");
      const before = await counts(db);
      expect(await filing(first, firstSession)).toEqual(RATE_LIMITED);
      expect(await filing(second, secondSession)).toEqual(RATE_LIMITED);
      expect(await counts(db)).toEqual(before);
    }));

  it("a veto on the about entity changes neither the answer nor the count", () =>
    withResearch(async (db) => {
      const subject = await person(db, "Wilhelmina Torrance");
      const before = await researcher(db, "r13-before");
      const after = await researcher(db, "r13-after");
      const vetoed = async () =>
        one(
          await admin<{ vetoed: boolean }>(
            db,
            "select policy.vetoed(array['entity'], array[$1], 'research') as vetoed",
            [subject.entity],
          ),
        ).vetoed;

      const unvetoed = await file(db, before, {
        session: await sessionOf(db, before),
        label: ["own"],
        about: subject.entity,
        fps: [subject.nameFp],
      });
      expect(unvetoed.outcome).toBe("ok");
      expect(await vetoed()).toBe(false);

      const ruling = testId("rul");
      await admin(
        db,
        "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'veto', 0, '{}', '{}', now(), '{own}')",
        [ruling, testId("req")],
      );
      await admin(
        db,
        "insert into knowledge.vetoes (ruling_id, subject, value_fps, created_at, compartments) values ($1, 'person', $2, now(), '{own}')",
        [ruling, [subject.addressFp]],
      );
      // The veto is real: policy.vetoed sees it.
      expect(await vetoed()).toBe(true);

      // The answers and the count are as without the veto: five ok, the sixth rate_limited.
      const ses = await sessionOf(db, after);
      const answers: Filed[] = [];
      for (let index = 0; index < 6; index += 1)
        answers.push(
          await file(db, after, { session: ses, label: ["own"], about: subject.entity, fps: [subject.nameFp] }),
        );
      expect(answers.map((answer) => answer.outcome)).toEqual(["ok", "ok", "ok", "ok", "ok", "rate_limited"]);
    }));

  it("filing writes the request, its filed event and one research_request card, or nothing", () =>
    withResearch(async (db) => {
      const subject = await person(db, "Fenwick Oyelaran");
      const client = await researcher(db, "r10-agent");
      const ses = await sessionOf(db, client);
      const id = testId("rsq");
      const requestId = testId("req");
      const cardId = testId("crd");
      const value = JSON.stringify({ identifiers: [{ kind: "person_name", value: "Fenwick Oyelaran" }] });
      const filing: Filing = {
        session: ses,
        label: ["own"],
        id,
        requestId,
        cardId,
        template: "person_profile",
        version: 1,
        about: subject.entity,
        fps: [subject.nameFp],
        value,
      };
      const args = fileArgs(db, filing);
      const filed = await readAs(db, client.token, async (query) => one(await query<Filed>(FILE, args)));
      expect(filed).toEqual({ outcome: "ok", research_id: id });

      const author = `client:${client.id}`;
      const request = one(
        await admin<Record<string, unknown>>(db, "select * from ledger.research_requests where id = $1", [id]),
      );
      expect(request).toMatchObject({
        request_id: requestId,
        author,
        client_id: client.id,
        session_id: ses,
        kind: "search",
        template_id: "person_profile",
        template_version: 1,
        about_entity_id: subject.entity,
        message_id: null,
        card_id: cardId,
        source_item_fp: null,
        causes: [],
        tainted_at: null,
        compartments: ["own"],
      });
      expect(
        openUnder(
          db.keys,
          ["own"],
          { table: "ledger.research_requests", id, column: "body_enc" },
          request.body_enc as never,
        ),
      ).toBe(value);
      const requestEvents = await admin(
        db,
        "select event, by, session_id, compartments from ledger.record_events where row_kind = 'research_request' and row_id = $1",
        [id],
      );
      expect(requestEvents).toEqual([{ event: "filed", by: author, session_id: ses, compartments: ["own"] }]);

      const card = one(await admin<Record<string, unknown>>(db, "select * from ledger.cards where id = $1", [cardId]));
      expect(card).toMatchObject({
        created_by: author,
        kind: "research_request",
        target_kind: "research_request",
        target_id: id,
        options: ["approve", "decline"],
        expires_after_days: 14,
        body_enc: null,
        tainted_at: null,
        compartments: ["own"],
      });
      expect(
        await admin(db, "select event, by from ledger.record_events where row_kind = 'card' and row_id = $1", [cardId]),
      ).toEqual([{ event: "pending", by: author }]);

      // The same request again answers its first id and writes nothing; the same request id with
      // other values is refused.
      const before = await counts(db);
      expect(await readAs(db, client.token, async (query) => one(await query<Filed>(FILE, args)))).toEqual({
        outcome: "replayed",
        research_id: id,
      });
      expect(
        await file(db, client, {
          ...filing,
          id: testId("rsq"),
          cardId: testId("crd"),
          queryFp: fingerprint(db.keys, "research_query", "another query"),
        }),
      ).toEqual({
        outcome: "invalid_request",
        research_id: null,
      });
      expect(await counts(db)).toEqual(before);

      // Or nothing: a filing whose request row cannot be written leaves no card and no event.
      let answer: Filed | undefined;
      const failed = await refusal(async () => {
        answer = await file(db, client, {
          session: ses,
          label: ["own"],
          id: "rsq_not-a-request-id",
          about: subject.entity,
          fps: [subject.nameFp],
        });
      });
      expect(failed !== null || answer?.outcome !== "ok").toBe(true);
      expect(await counts(db)).toEqual(before);
    }));

  it("refuses 42501 with no client, a session not the client's, a label not the token's, or outside read committed", () =>
    withResearch(async (db) => {
      const subject = await person(db, "Marisol Achterberg");
      const client = await researcher(db, "refuse-agent");
      const other = await researcher(db, "refuse-other");
      const ses = await sessionOf(db, client);
      const otherSession = await sessionOf(db, other);
      const filing = (f: Partial<Filing> = {}): Filing => ({
        session: ses,
        label: ["own"],
        about: subject.entity,
        fps: [subject.nameFp],
        ...f,
      });

      const before = await counts(db);
      expect(await sqlState(() => readAs(db, null, (query) => query(FILE, fileArgs(db, filing()))))).toBe("42501");
      expect(await sqlState(() => file(db, client, filing({ session: otherSession })))).toBe("42501");
      expect(await sqlState(() => file(db, client, filing({ label: ["own", "public"] })))).toBe("42501");
      const repeatable = sqlState(() =>
        session(db.urls.reader, async (query) => {
          await query("begin isolation level repeatable read");
          try {
            await query("select set_config('pi.client_token', $1, true)", [client.token]);
            await query(FILE, fileArgs(db, filing()));
          } finally {
            await query("rollback");
          }
        }),
      );
      expect(await repeatable).toBe("42501");
      // Only pi_reader executes it.
      for (const url of [db.urls.admin, db.urls.writer, db.urls.pipeline, db.urls.work])
        expect(await sqlState(() => queryAs(url, FILE, fileArgs(db, filing()))), url).toBe("42501");
      expect(await counts(db)).toEqual(before);

      // The positive control: the client's own session, its label, read committed.
      expect((await file(db, client, filing())).outcome).toBe("ok");
    }));
});

describe("who reads requests, fetches and pages", { timeout: TIMEOUT }, () => {
  it("pi_reader reads no research_requests or research_fetches row", () =>
    withResearch(async (db) => {
      const subject = await person(db, "Hollis Varga-Penrose");
      const client = await researcher(db, "r36-agent", ["own", "public"]);
      const filed = await file(db, client, {
        session: await sessionOf(db, client),
        label: ["own", "public"],
        about: subject.entity,
        fps: [subject.nameFp],
      });
      expect(filed.outcome).toBe("ok");
      await twoPages(db);

      for (const sql of [
        "select id from ledger.research_requests",
        "select id from ledger.research_fetches",
        "select id from ledger.cards",
      ]) {
        expect(await sqlState(() => readAs(db, client.token, (query) => query(sql))), sql).toBe("42501");
      }
      // The research events are not among the events it reads.
      expect(
        await readAs(db, client.token, (query) =>
          query("select id from ledger.record_events where row_kind = 'research_request'"),
        ),
      ).toEqual([]);

      // The positive controls, as pi_admin.
      expect((await admin(db, "select id from ledger.research_requests")).length).toBe(3);
      expect((await admin(db, "select id from ledger.research_fetches")).length).toBe(2);
      expect(
        (await admin(db, "select id from ledger.record_events where row_kind = 'research_request'")).length,
      ).toBeGreaterThan(0);
      // And the reader reads the switch, and no cap.
      expect(
        await readAs(db, client.token, (query) => query("select client_link_requests from policy.research_settings")),
      ).toEqual([{ client_link_requests: false }]);
      expect(
        await sqlState(() =>
          readAs(db, client.token, (query) =>
            query("select max_requests_per_client_per_day from policy.research_settings"),
          ),
        ),
      ).toBe("42501");
    }));

  it("pi_reader reads a page only within its clearance, and never names_enc", () =>
    withResearch(async (db) => {
      const { publicPage, ownPage } = await twoPages(db);
      const publicOnly = await insertClient(db, "r35-public", ["public"]);
      const ownOnly = await insertClient(db, "r35-own", ["own"]);
      const both = await insertClient(db, "r35-both", ["own", "public"]);
      const pagesOf = async (client: TestClient) =>
        (
          await readAs(db, client.token, (query) =>
            query<{ id: string }>("select id, page_enc from knowledge.pages order by id"),
          )
        ).map((row) => row.id);

      expect(await pagesOf(publicOnly)).toEqual([publicPage]);
      expect(await pagesOf(ownOnly)).toEqual([ownPage]);
      expect(await pagesOf(both)).toEqual([publicPage, ownPage].sort());
      expect(await readAs(db, null, (query) => query("select id from knowledge.pages"))).toEqual([]);

      for (const sql of [
        "select names_enc from knowledge.pages",
        "select * from knowledge.pages",
        "select id from knowledge.pages where names_enc is not null",
      ]) {
        expect(await sqlState(() => readAs(db, both.token, (query) => query(sql))), sql).toBe("42501");
      }
      // The positive control: pi_admin reads the names.
      expect((await admin(db, "select names_enc from knowledge.pages")).length).toBe(2);
    }));

  it("pi_pipeline reads pages and no request", () =>
    withResearch(async (db) => {
      const { publicPage, ownPage } = await twoPages(db);
      const pages = await queryAs<{ id: string }>(
        db.urls.pipeline,
        "select id, names_enc from knowledge.pages order by id",
      );
      expect(pages.map((row) => row.id)).toEqual([publicPage, ownPage].sort());
      for (const sql of ["select id from ledger.research_requests", "select id from ledger.research_fetches"]) {
        expect(await sqlState(() => queryAs(db.urls.pipeline, sql)), sql).toBe("42501");
      }
      expect((await admin(db, "select id from ledger.research_requests")).length).toBe(2);
    }));
});

describe("the writer and the vetoes", { timeout: TIMEOUT }, () => {
  it("pi_writer has no select on policy.vetoed's tables", () =>
    withResearch(async (db) => {
      const held = one(
        await queryAs<{ vetoes: boolean; decisions: boolean; vetoed: boolean; vetoed_by: boolean }>(
          db.urls.admin,
          `select has_any_column_privilege('pi_writer', 'knowledge.vetoes', 'SELECT') as vetoes,
                  has_any_column_privilege('pi_writer', 'knowledge.owner_decisions', 'SELECT') as decisions,
                  has_function_privilege('pi_writer', 'policy.vetoed(text[], text[], text)', 'EXECUTE') as vetoed,
                  has_function_privilege('pi_writer', 'policy.vetoed_by(text[], text[], text)', 'EXECUTE') as vetoed_by`,
        ),
      );
      expect(held).toEqual({ vetoes: false, decisions: false, vetoed: false, vetoed_by: false });
      for (const sql of [
        "select count(*) from knowledge.vetoes",
        "select policy.vetoed(array['entity'], array['ent_x'], 'research')",
      ]) {
        expect(await sqlState(() => writer(db, sql)), sql).toBe("42501");
      }
      // The positive control: pi_admin reads the vetoes.
      expect(await admin(db, "select count(*)::int as n from knowledge.vetoes")).toEqual([{ n: 0 }]);
    }));
});

describe("ledger.taint_citing and research requests", { timeout: TIMEOUT }, () => {
  it("a request whose session read an evidence id later deleted is tainted, its body dropped and its card withdrawn", () =>
    withResearch(async (db) => {
      const subject = await person(db, "Celestine Abernathy");
      const reading = await researcher(db, "r37-reading");
      const clean = await researcher(db, "r37-clean");
      const readingSession = await sessionOf(db, reading);
      const cleanSession = await sessionOf(db, clean);
      const evidence = await session(db.urls.admin, (query) => seeder(db, query).evidence());
      await readAs(db, reading.token, (query) =>
        query("select policy.log_read($1, 'search', $2, '{}', '{}')", [readingSession, [evidence]]),
      );

      const tainted = await file(db, reading, {
        session: readingSession,
        label: ["own"],
        about: subject.entity,
        fps: [subject.nameFp],
      });
      const kept = await file(db, clean, {
        session: cleanSession,
        label: ["own"],
        about: subject.entity,
        fps: [subject.nameFp],
      });
      expect([tainted.outcome, kept.outcome]).toEqual(["ok", "ok"]);
      for (const id of [tainted.research_id, kept.research_id]) await approve(db, id ?? "", ["own"]);

      await admin(db, "select ledger.taint_citing($1, '{}', '{}')", [[evidence]]);

      type Row = { tainted: boolean; body: boolean; card: string };
      const rowOf = async (id: string | null) =>
        one(
          await admin<Row>(
            db,
            "select tainted_at is not null as tainted, body_enc is not null as body, card_id as card from ledger.research_requests where id = $1",
            [id],
          ),
        );
      const hit = await rowOf(tainted.research_id);
      expect(hit).toMatchObject({ tainted: true, body: false });
      expect(await stateOf(db, "research_request", tainted.research_id ?? "")).toBe("tainted");
      expect(
        one(
          await admin<{ tainted: boolean }>(
            db,
            "select tainted_at is not null as tainted from ledger.cards where id = $1",
            [hit.card],
          ),
        ).tainted,
      ).toBe(true);
      expect(await stateOf(db, "card", hit.card)).toBe("withdrawn");

      // The positive control: the other session's request is untouched.
      const control = await rowOf(kept.research_id);
      expect(control).toMatchObject({ tainted: false, body: true });
      expect(await stateOf(db, "research_request", kept.research_id ?? "")).toBe("approved");
      expect(await stateOf(db, "card", control.card)).toBe("pending");
    }));

  it("taint_citing still taints a hypothesis written after its session read a deleted item", () =>
    withResearch(async (db) => {
      const client = await researcher(db, "r37-work");
      const ses = await sessionOf(db, client);
      const evidence = await session(db.urls.admin, (query) => seeder(db, query).evidence());
      await readAs(db, client.token, (query) =>
        query("select policy.log_read($1, 'search', $2, '{}', '{}')", [ses, [evidence]]),
      );
      const hypothesis = testId("hyp");
      const unrelated = testId("hyp");
      // The unrelated hypothesis is another client's, from a session that read nothing: one
      // client's two open loops about the owner would be one case (ledger.cases' cases_one).
      const other = await researcher(db, "r37-other");
      const otherSession = await sessionOf(db, other);
      await asTableOwner(db, async (query) => {
        for (const [id, sessionId, author] of [
          [hypothesis, ses, `client:${client.id}`],
          [unrelated, otherSession, `client:${other.id}`],
        ] as const) {
          const caseId = testId("cas");
          await query(
            `insert into ledger.cases (id, request_id, created_by, session_id, compartments, row_kind, kind, about_kind, about_id, author)
             values ($1, $2, $3, $4, '{own}', 'hypothesis', 'open_loop', 'owner', null, $3)`,
            [caseId, testId("req"), author, sessionId],
          );
          await query(
            `insert into ledger.hypotheses (id, request_id, created_by, session_id, compartments, body_enc, case_id, kind, about_kind, about_id, about_owner)
             values ($1, $2, $3, $4, '{own}', $5, $6, 'open_loop', 'owner', null, true)`,
            [
              id,
              testId("req"),
              author,
              sessionId,
              sealUnder(db.keys, ["own"], { table: "ledger.hypotheses", id, column: "body_enc" }, "A loop to close"),
              caseId,
            ],
          );
        }
      });

      await admin(db, "select ledger.taint_citing($1, '{}', '{}')", [[evidence]]);
      const rows = await admin<{ id: string; tainted: boolean; body: boolean }>(
        db,
        "select id, tainted_at is not null as tainted, body_enc is not null as body from ledger.hypotheses where id = any ($1)",
        [[hypothesis, unrelated]],
      );
      expect(rows.find((row) => row.id === hypothesis)).toMatchObject({ tainted: true, body: false });
      expect(rows.find((row) => row.id === unrelated)).toMatchObject({ tainted: false, body: true });
    }));
});

// ---------------------------------------------------------------------------------------------
// The migration's grants, policies and functions, against the expected grants
// ---------------------------------------------------------------------------------------------

describe("the research migration's grants", { timeout: TIMEOUT }, () => {
  it("the grants, column grants and policies of the four tables are the expected table", () =>
    withResearch(async (db) => {
      const held = await queryAs<{ cell: string }>(
        db.urls.admin,
        `select r.role || ' ' || t.tab || ' ' || p.priv as cell
         from unnest($1::text[]) r (role), unnest($2::text[]) t (tab), unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p (priv)
         where case when p.priv = 'DELETE' then has_table_privilege(r.role, t.tab, p.priv) else has_any_column_privilege(r.role, t.tab, p.priv) end
         order by 1`,
        [[...RUNTIME_ROLES], TABLES],
      );
      const all = (role: string, table: string) =>
        ["SELECT", "INSERT", "UPDATE", "DELETE"].map((priv) => `${role} ${table} ${priv}`);
      const expected = [
        ...all("pi_admin", "knowledge.pages"),
        ...all("pi_admin", "policy.research_settings"),
        // The two ledger tables are append-only: the admin reads and files, and drops a fetch's sealed
        // body for the `pages` erasure hook, by a column grant.
        "pi_admin ledger.research_requests SELECT",
        "pi_admin ledger.research_requests INSERT",
        "pi_admin ledger.research_fetches SELECT",
        "pi_admin ledger.research_fetches INSERT",
        "pi_admin ledger.research_fetches UPDATE",
        "pi_writer knowledge.pages SELECT",
        "pi_writer knowledge.pages INSERT",
        "pi_writer knowledge.pages DELETE",
        "pi_reader knowledge.pages SELECT",
        "pi_reader policy.research_settings SELECT",
        "pi_pipeline knowledge.pages SELECT",
        // The restricted worker holds a copy of pi_pipeline's policy and privilege.
        "pi_restricted knowledge.pages SELECT",
      ];
      expect(held.map((row) => row.cell).sort()).toEqual([...expected].sort());

      // pi_reader: every column of a page but the names, and the switch alone.
      const readerColumns = async (table: string) =>
        (
          await queryAs<{ name: string }>(
            db.urls.admin,
            "select attname as name from pg_attribute where attrelid = $1::regclass and attnum > 0 and not attisdropped and has_column_privilege('pi_reader', $1, attname, 'SELECT') order by 1",
            [table],
          )
        ).map((row) => row.name);
      expect(await readerColumns("knowledge.pages")).toEqual([...PAGE_READER_COLUMNS].sort());
      expect(await readerColumns("policy.research_settings")).toEqual(["client_link_requests"]);
      // pi_admin updates a fetch's body_enc and nothing else of either ledger table.
      const adminUpdates = (
        await queryAs<{ name: string }>(
          db.urls.admin,
          "select attname as name from pg_attribute where attrelid = 'ledger.research_fetches'::regclass and attnum > 0 and not attisdropped and has_column_privilege('pi_admin', 'ledger.research_fetches', attname, 'UPDATE') order by 1",
        )
      ).map((row) => row.name);
      expect(adminUpdates).toEqual(["body_enc"]);

      // Row-level security enabled and forced, and one policy per cell, named <role>_<command>.
      const tables = await queryAs<{ name: string; enabled: boolean; forced: boolean }>(
        db.urls.admin,
        "select c.oid::regclass::text as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced from pg_class c where c.oid = any ($1::regclass[])",
        [TABLES],
      );
      expect(tables).toHaveLength(4);
      for (const table of tables) expect(table, table.name).toMatchObject({ enabled: true, forced: true });
      const policies = await queryAs<{ table: string; name: string; roles: string[]; command: string }>(
        db.urls.admin,
        "select schemaname || '.' || tablename as table, policyname as name, roles::text[] as roles, cmd as command from pg_policies where schemaname || '.' || tablename = any ($1)",
        [TABLES],
      );
      for (const policy of policies) {
        expect(policy.roles, policy.name).toHaveLength(1);
        expect(policy.name, policy.table).toBe(`${policy.roles[0]}_${policy.command.toLowerCase()}`);
      }
      for (const cell of expected) {
        const [role, table, priv] = cell.split(" ");
        expect(
          policies.some(
            (policy) =>
              policy.table === table &&
              policy.roles[0] === role &&
              (policy.command === priv || policy.command === "ALL"),
          ),
          `a policy for ${cell}`,
        ).toBe(true);
      }
      // No policy for a runtime role the grants leave out.
      for (const policy of policies.filter((one) =>
        (RUNTIME_ROLES as readonly string[]).includes(one.roles[0] ?? ""),
      )) {
        expect(
          expected.some((cell) => cell.startsWith(`${policy.roles[0]} ${policy.table} `)),
          policy.name,
        ).toBe(true);
      }

      // The settings row and its defaults (Q6, Q16).
      expect(
        await admin(
          db,
          "select client_link_requests, max_requests_per_client_per_day, max_searches_per_day, max_fetches_per_day, max_pages_per_request, refetch_after_days, card_expiry_days from policy.research_settings",
        ),
      ).toEqual([
        {
          client_link_requests: false,
          max_requests_per_client_per_day: 5,
          max_searches_per_day: 10,
          max_fetches_per_day: 30,
          max_pages_per_request: 5,
          refetch_after_days: 30,
          card_expiry_days: 14,
        },
      ]);
      expect(await admin(db, "select name from policy.tool_names where name = 'request_research'")).toEqual([
        { name: "request_research" },
      ]);
    }));

  it("the functions are definers owned by pi_owner with the core's search path, executed only as the table says", () =>
    withResearch(async (db) => {
      const functions = await queryAs<{
        name: string;
        definer: boolean;
        owner: string;
        config: string[] | null;
        roles: string[];
        public: boolean;
      }>(
        db.urls.admin,
        `select p.proname as name, p.prosecdef as definer, pg_get_userbyid(p.proowner) as owner, p.proconfig as config,
                array(select r from unnest($1::text[]) r where has_function_privilege(r, p.oid, 'EXECUTE') order by 1) as roles,
                has_function_privilege('public', p.oid, 'EXECUTE') as public
         from pg_proc p where p.pronamespace = 'ledger'::regnamespace and p.proname = any ($2) order by 1`,
        [[...RUNTIME_ROLES], ["file_research", "research_state", "taint_citing"]],
      );
      const core = one(
        await queryAs<{ config: string[] }>(
          db.urls.admin,
          "select proconfig as config from pg_proc where oid = 'policy.current_client()'::regprocedure",
        ),
      ).config;
      const byName = new Map(functions.map((fn) => [fn.name, fn]));
      expect([...byName.keys()].sort()).toEqual(["file_research", "research_state", "taint_citing"]);
      for (const fn of functions) {
        expect(fn.owner, fn.name).toBe("pi_owner");
        expect(fn.config, fn.name).toEqual(core);
        expect(fn.public, fn.name).toBe(false);
      }
      expect(byName.get("file_research")).toMatchObject({ definer: true, roles: ["pi_reader"] });
      expect(byName.get("research_state")).toMatchObject({ roles: [] });
      expect(byName.get("taint_citing")).toMatchObject({ definer: true, roles: ["pi_admin", "pi_writer"] });
    }));
});

// ---------------------------------------------------------------------------------------------
// P3: nothing of a request, a fetch or a page in clear
// ---------------------------------------------------------------------------------------------

describe("no canary is in any column of the research tables", { timeout: TIMEOUT }, () => {
  it("the plaintext scan finds no canary URL, query value or page text in any column", () =>
    withResearch(async (db) => {
      const canaryUrl = "https://canary-research.example/profile/kestrel-varnum-7q";
      const canaryQuery = "Kestrel Varnum-Ostrowe";
      const canaryText = "canary page text marigold ostinato vellichor";
      const canaryTitle = "Canary Title Brindlewood";

      // A client's search request whose identifier is the canary query value, held under `own`.
      const subject = await person(db, canaryQuery);
      const client = await researcher(db, "p3-agent");
      const filed = await file(db, client, {
        session: await sessionOf(db, client),
        label: ["own"],
        about: subject.entity,
        fps: [subject.nameFp],
        value: JSON.stringify({ identifiers: [{ kind: "person_name", value: canaryQuery }] }),
      });
      expect(filed.outcome).toBe("ok");

      // An owner url request for the canary URL, its fetch and its page, with the canary text.
      const request = await ownerRequest(db, { kind: "url", url: canaryUrl, about: null });
      const pageId = await page(db, {
        request,
        requestLabel: ["own"],
        compartment: "public",
        url: canaryUrl,
        title: canaryTitle,
        text: canaryText,
        names: [canaryQuery],
      });

      expect(await scanForPlaintext(db.urls.admin, [canaryUrl, canaryQuery, canaryText, canaryTitle])).toEqual([]);

      // The positive controls: each canary is stored, sealed, where the scan looked.
      const body = one(
        await admin<{ body: unknown }>(db, "select body_enc as body from ledger.research_requests where id = $1", [
          filed.research_id,
        ]),
      ).body;
      expect(
        openUnder(
          db.keys,
          ["own"],
          { table: "ledger.research_requests", id: filed.research_id ?? "", column: "body_enc" },
          body as never,
        ),
      ).toContain(canaryQuery);
      const fetch = one(
        await admin<{ id: string; body: unknown }>(
          db,
          "select id, body_enc as body from ledger.research_fetches where research_request_id = $1",
          [request],
        ),
      );
      expect(
        openUnder(
          db.keys,
          ["own"],
          { table: "ledger.research_fetches", id: fetch.id, column: "body_enc" },
          fetch.body as never,
        ),
      ).toBe(canaryUrl);
      const stored = one(
        await admin<{ page: unknown; names: unknown }>(
          db,
          "select page_enc as page, names_enc as names from knowledge.pages where id = $1",
          [pageId],
        ),
      );
      expect(
        openUnder(
          db.keys,
          ["public"],
          { table: "knowledge.pages", id: pageId, column: "page_enc" },
          stored.page as never,
        ),
      ).toContain(canaryTitle);
      expect(
        openUnder(
          db.keys,
          ["public"],
          { table: "knowledge.pages", id: pageId, column: "names_enc" },
          stored.names as never,
        ),
      ).toContain(canaryQuery);
      // And a canary written in clear is found: the scan reads these tables. body_enc is the one
      // column of a fetch the admin may update, and the scan decodes jsonb.
      await admin(db, "update ledger.research_fetches set body_enc = to_jsonb($2::text) where id = $1", [
        fetch.id,
        canaryText,
      ]);
      expect(await scanForPlaintext(db.urls.admin, [canaryText])).toEqual([
        { table: "ledger.research_fetches", column: "body_enc" },
      ]);
    }));
});
