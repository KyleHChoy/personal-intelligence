import { describe, expect, it } from "vitest";
import { sealUnder } from "../core/seal.ts";
import { testId } from "../test-support/clients.ts";
import { one, ownerCommitted as ownerCommit, session } from "../test-support/connections.ts";
import { fingerprint, queryAs, sealRow, type TestDatabase } from "../test-support/database.ts";
import { seeder } from "../test-support/seeder.ts";
import { withDatabase } from "../test-support/store.ts";
import { interactionId } from "../test-support/values.ts";
import {
  advisoryLocks as advisory,
  settled,
  waitingForLock as waiting,
  withConnections,
} from "../test-support/waits.ts";

// Rows are written in SQL as pi_admin where it may insert, and as pi_owner, in a committed
// transaction through the bootstrap, where only the functions write. Every refusal has its positive
// control in the same test.

const TIMEOUT = 180_000;
const BOTH = { compartments: ["own", "employer:example"] };
const AT = "2026-09-01T00:00:00Z";
const TAINT_KEY = "intelligence personal ledger taint";

const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);
const address = (db: TestDatabase, value: string): string => fingerprint(db.keys, "address", value);
const domainFp = (db: TestDatabase, value: string): string => fingerprint(db.keys, "domain", value);

// ---------------------------------------------------------------------------------------------
// A small world, in SQL as pi_admin: the owner, two people, two organizations, messages and
// events that name them. Reserved domains only.
// ---------------------------------------------------------------------------------------------

const ADDRESSES = {
  owner: "owner@home-owner.test",
  pat: "pat@acme-owner.test",
  quin: "quin@other-owner.test",
  news: "news@acme-owner.test",
  work: "wren@work-owner.test",
};
const DOMAINS = {
  home: "home-owner.test",
  acme: "acme-owner.test",
  other: "other-owner.test",
  work: "work-owner.test",
};

type Message = { id: string; evidence: string };
type World = {
  owner: string;
  pat: string;
  quin: string;
  acme: string;
  other: string;
  // Only under employer:example.
  wren: string;
  // Outbound to Pat: an interaction row for Pat, the owner's own sender fingerprint.
  toPat: Message;
  // Inbound from Quin, with an interaction row for Quin.
  fromQuin: Message;
  // Inbound bulk mail from news@acme: no interaction row, no entity.
  bulkNews: Message;
  // Outbound, with news@acme's fingerprints as its sender columns, and no interaction row.
  outNews: Message;
  // Outbound bulk, inbound held, outbound system-originated, inbound answering the system.
  outBulk: Message;
  held: Message;
  systemSent: Message;
  answersSystem: Message;
  // Under employer:example.
  workMail: Message;
  // Events: Pat a participant and the owner accepted; Quin a participant, the owner only invited;
  // one the owner organized; one under employer:example.
  patMeeting: Message;
  quinInvite: Message;
  organized: Message;
  workMeeting: Message;
};

async function seedWorld(db: TestDatabase): Promise<World> {
  return session(db.urls.admin, async (query) => {
    const seed = seeder(db, query);
    const own = ["own"];
    const work = ["employer:example"];
    const account = await seed.sourceAccount(own);
    const workAccount = await seed.sourceAccount(work);

    const entity = async (kind: "owner" | "person" | "organization"): Promise<string> => {
      const id = testId("ent");
      await query("insert into knowledge.entities (id, kind) values ($1, $2)", [id, kind]);
      return id;
    };
    const addressRow = async (entityId: string, value: string, compartments = own): Promise<void> => {
      const id = testId("adr");
      await query(
        "insert into knowledge.accounts (id, entity_id, kind, value_fp, domain_fp, value_enc, compartments) values ($1, $2, 'email', $3, $4, $5, $6)",
        [
          id,
          entityId,
          address(db, value),
          domainFp(db, value.split("@")[1] ?? ""),
          sealRow(db.keys, compartments[0] ?? "own", { table: "knowledge.accounts", id, column: "value_enc" }, value),
          compartments,
        ],
      );
    };
    const domainRow = async (entityId: string, value: string, compartments = own): Promise<void> => {
      const id = testId("dom");
      await query(
        "insert into knowledge.domains (id, domain_fp, entity_id, domain_enc, compartments) values ($1, $2, $3, $4, $5)",
        [
          id,
          domainFp(db, value),
          entityId,
          sealRow(db.keys, compartments[0] ?? "own", { table: "knowledge.domains", id, column: "domain_enc" }, value),
          compartments,
        ],
      );
    };
    const message = async (options: {
      direction: "inbound" | "outbound";
      sender: string | null;
      bulk?: boolean;
      held?: boolean;
      compartments?: string[];
      marks?: { system_originated?: boolean; answers_system?: boolean };
    }): Promise<Message> => {
      const compartments = options.compartments ?? own;
      const evidence = await seed.evidence(compartments, compartments === work ? workAccount : account);
      const id = await seed.message(compartments, evidence, { held: options.held ?? false });
      const sender = options.sender;
      await query(
        "update knowledge.messages set direction = $2, bulk = $3, sender_fp = $4, sender_domain_fp = $5 where id = $1",
        [
          id,
          options.direction,
          options.bulk ?? false,
          sender === null ? null : address(db, sender),
          sender === null ? null : domainFp(db, sender.split("@")[1] ?? ""),
        ],
      );
      if (options.marks !== undefined) {
        await query("update vault.evidence_items set system_originated = $2, answers_system = $3 where id = $1", [
          evidence,
          options.marks.system_originated ?? false,
          options.marks.answers_system ?? false,
        ]);
      }
      return { id, evidence };
    };
    const interaction = async (
      evidence: string,
      entityId: string,
      role: "sender" | "recipient",
      compartments = own,
    ): Promise<void> => {
      await query(
        `insert into knowledge.interaction_log (id, evidence_id, member_id, entity_id, direction, channel, occurred_at, entity_role, compartments, readers)
         values ($1, $2, 'm-owner', $3, $4, 'email', $5, $6, $7, '{m-owner}')`,
        [
          interactionId(evidence, entityId),
          evidence,
          entityId,
          role === "sender" ? "inbound" : "outbound",
          AT,
          role,
          compartments,
        ],
      );
    };
    const meeting = async (options: {
      participants: string[];
      response: string | null;
      organizer?: boolean;
      compartments?: string[];
    }): Promise<Message> => {
      const compartments = options.compartments ?? own;
      const source = compartments === work ? workAccount : account;
      const evidence = await seed.evidence(compartments, source);
      await query("update vault.evidence_items set source_kind = 'calendar', sender_member = $2 where id = $1", [
        evidence,
        options.organizer === true ? "m-owner" : null,
      ]);
      const id = testId("evt");
      await query(
        "insert into knowledge.events (id, event_kind, occurred_at, evidence_id, compartments, readers) values ($1, 'meeting', $2, $3, $4, '{m-owner}')",
        [id, AT, evidence, compartments],
      );
      await query(
        `insert into knowledge.event_details (event_id, account_id, source_event_fp, starts_at, ends_at, all_day, cancelled, owner_response, compartments)
         values ($1, $2, $3, $4, $4, false, false, $5, $6)`,
        [id, source, fingerprint(db.keys, "source_id", `owner-tests-${id}`), AT, options.response, compartments],
      );
      for (const person of options.participants) {
        await query(
          "insert into knowledge.event_participants (event_id, entity_id, participant_role, compartments) values ($1, $2, 'participant', $3)",
          [id, person, compartments],
        );
      }
      return { id, evidence };
    };

    const owner = await entity("owner");
    await addressRow(owner, ADDRESSES.owner);
    const pat = await entity("person");
    await addressRow(pat, ADDRESSES.pat);
    const quin = await entity("person");
    await addressRow(quin, ADDRESSES.quin);
    const acme = await entity("organization");
    await domainRow(acme, DOMAINS.acme);
    const other = await entity("organization");
    await domainRow(other, DOMAINS.other);
    const wren = await entity("person");
    await addressRow(wren, ADDRESSES.work, work);

    const toPat = await message({ direction: "outbound", sender: ADDRESSES.owner });
    await interaction(toPat.evidence, pat, "recipient");
    const fromQuin = await message({ direction: "inbound", sender: ADDRESSES.quin });
    await interaction(fromQuin.evidence, quin, "sender");
    const bulkNews = await message({ direction: "inbound", sender: ADDRESSES.news, bulk: true });
    const outNews = await message({ direction: "outbound", sender: ADDRESSES.news });
    const outBulk = await message({ direction: "outbound", sender: ADDRESSES.owner, bulk: true });
    const held = await message({ direction: "inbound", sender: ADDRESSES.quin, held: true });
    const systemSent = await message({
      direction: "outbound",
      sender: ADDRESSES.owner,
      marks: { system_originated: true },
    });
    const answersSystem = await message({
      direction: "inbound",
      sender: ADDRESSES.quin,
      marks: { answers_system: true },
    });
    const workMail = await message({ direction: "inbound", sender: ADDRESSES.work, compartments: work });
    await interaction(workMail.evidence, wren, "sender", work);

    const patMeeting = await meeting({ participants: [pat], response: "accepted" });
    const quinInvite = await meeting({ participants: [quin], response: "needsAction" });
    const organized = await meeting({ participants: [], response: null, organizer: true });
    const workMeeting = await meeting({ participants: [wren], response: "accepted", compartments: work });

    return {
      owner,
      pat,
      quin,
      acme,
      other,
      wren,
      toPat,
      fromQuin,
      bulkNews,
      outNews,
      outBulk,
      held,
      systemSent,
      answersSystem,
      workMail,
      patMeeting,
      quinInvite,
      organized,
      workMeeting,
    };
  });
}

// A veto as pi_admin: its decision row, then the veto. Returns its ruling id.
async function addVeto(
  db: TestDatabase,
  veto: {
    subject: "person" | "organization" | "any";
    fps: string[];
    workKind?: string | null;
    createdAt?: string;
    id?: string;
  },
): Promise<string> {
  const id = veto.id ?? testId("rul");
  await admin(
    db,
    "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'veto', 0, '{}', '{}', $3, '{own}')",
    [id, testId("req"), veto.createdAt ?? AT],
  );
  await admin(
    db,
    "insert into knowledge.vetoes (ruling_id, subject, value_fps, work_kind, created_at, compartments) values ($1, $2, $3, $4, $5, '{own}')",
    [id, veto.subject, veto.fps, veto.workKind ?? null, veto.createdAt ?? AT],
  );
  return id;
}

type Ref = [kind: string, id: string];

// What vetoed_by answers for these refs and this kind, after asserting that vetoed agrees with it.
async function vetoedBy(db: TestDatabase, refs: Ref[], kind: string | null = null): Promise<string | null> {
  const values = [refs.map(([refKind]) => refKind), refs.map(([, id]) => id), kind];
  const by = one(
    await admin<{ ruling: string | null }>(
      db,
      "select policy.vetoed_by($1::text[], $2::text[], $3::text) as ruling",
      values,
    ),
  ).ruling;
  const is = one(
    await admin<{ vetoed: boolean }>(db, "select policy.vetoed($1::text[], $2::text[], $3::text) as vetoed", values),
  ).vetoed;
  expect(is, `vetoed for ${JSON.stringify(refs)} ${kind}`).toBe(by !== null);
  return by;
}

// ---------------------------------------------------------------------------------------------
// Cards and their events, as pi_admin
// ---------------------------------------------------------------------------------------------

let clock = 0;
// A card with its events, oldest first; created_at and ids both increase with each call, so
// "oldest" is the same by either.
async function card(
  db: TestDatabase,
  options: {
    author?: string;
    events?: string[];
    target?: Ref | null;
    expiresAt?: string | null;
    body?: boolean;
    compartments?: string[];
  } = {},
): Promise<string> {
  clock += 1;
  const created = new Date(Date.parse("2026-09-01T00:00:00Z") + clock * 60_000).toISOString();
  await new Promise((resolve) => setTimeout(resolve, 2));
  const id = testId("crd");
  const compartments = options.compartments ?? ["own"];
  const body =
    options.body === true
      ? sealUnder(db.keys, compartments, { table: "ledger.cards", id, column: "body_enc" }, `card body ${id}`)
      : null;
  await admin(
    db,
    `insert into ledger.cards (id, request_id, created_at, created_by, kind, target_kind, target_id, options, expires_at, body_from, compartments, body_enc)
     values ($1, $2, $3, $4, 'notice', $5, $6, '{acknowledge}', $7, $8, $9, $10)`,
    [
      id,
      testId("req"),
      created,
      options.author ?? "system:test",
      options.target?.[0] ?? null,
      options.target?.[1] ?? null,
      options.expiresAt ?? null,
      body === null ? null : "code",
      compartments,
      body,
    ],
  );
  for (const event of options.events ?? ["pending"]) {
    const eventBody =
      options.body === true
        ? sealUnder(
            db.keys,
            compartments,
            { table: "ledger.record_events", id: `${id}/${event}`, column: "body_enc" },
            `event body ${id}`,
          )
        : null;
    await admin(
      db,
      "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments, body_enc) values ('card', $1, $2, $3, $4, $5, $6)",
      [id, event, created, options.author ?? "system:test", compartments, eventBody],
    );
  }
  return id;
}

// A card's latest event and who wrote it: its state.
async function latest(db: TestDatabase, id: string): Promise<{ event: string; by: string }> {
  return one(
    await admin<{ event: string; by: string }>(
      db,
      "select event, by from ledger.record_events where row_kind = 'card' and row_id = $1 order by id desc limit 1",
      [id],
    ),
  );
}

async function cardsOf(db: TestDatabase, author: string, count: number, events: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) ids.push(await card(db, { author, events }));
  return ids;
}

const addBasis = async (
  db: TestDatabase,
  row: string,
  refs: Ref[],
  clearance: string[] | null = null,
  compartments: string[] = ["own"],
): Promise<boolean> =>
  one(
    await admin<{ ok: boolean }>(
      db,
      "select ledger.add_basis('card', $1, $2::text[], $3::text[], $4::text[], $5::text[]) as ok",
      [row, compartments, refs.map(([kind]) => kind), refs.map(([, id]) => id), clearance],
    ),
  ).ok;

type BasisRow = {
  ref_kind: string;
  ref_id: string;
  evidence_id: string | null;
  source_class: string;
  owner_backed: boolean;
  compartments: string[];
  tainted: boolean;
};
const basisOf = (db: TestDatabase, row: string): Promise<BasisRow[]> =>
  admin<BasisRow>(
    db,
    "select ref_kind, ref_id, evidence_id, source_class, owner_backed, compartments, tainted_at is not null as tainted from ledger.basis where row_kind = 'card' and row_id = $1 order by id",
    [row],
  );

const taint = async (db: TestDatabase, evidenceIds: string[], refs: Ref[], url = db.urls.writer): Promise<number> =>
  one(
    await queryAs<{ n: number }>(url, "select ledger.taint_citing($1::text[], $2::text[], $3::text[]) as n", [
      evidenceIds,
      refs.map(([kind]) => kind),
      refs.map(([, id]) => id),
    ]),
  ).n;

// ---------------------------------------------------------------------------------------------
// Two connections, and the locks one of them holds or waits for
// ---------------------------------------------------------------------------------------------

const taintKey = async (db: TestDatabase): Promise<string> =>
  one(await admin<{ key: string }>(db, "select hashtext($1)::bigint::text as key", [TAINT_KEY])).key;
const rowKey = async (db: TestDatabase, id: string): Promise<string> =>
  one(await admin<{ key: string }>(db, "select hashtextextended($1, 0)::text as key", [id])).key;

describe("policy.vetoed_by: R9, one test for each line", { timeout: TIMEOUT }, () => {
  it("a person is covered by a person veto holding one of its address fingerprints", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const veto = await addVeto(db, { subject: "person", fps: [address(db, ADDRESSES.pat)] });
      expect(await vetoedBy(db, [["entity", w.pat]])).toBe(veto);
      // The control: another person is not covered.
      expect(await vetoedBy(db, [["entity", w.quin]])).toBeNull();
    }));

  it("a person is covered by an organization veto on the domain of one of its addresses", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const veto = await addVeto(db, { subject: "organization", fps: [domainFp(db, DOMAINS.acme)] });
      expect(await vetoedBy(db, [["entity", w.pat]])).toBe(veto);
      expect(await vetoedBy(db, [["entity", w.quin]])).toBeNull();
      // A person veto that holds the domain's fingerprint covers nobody by domain.
      const wrongSubject = await withDatabase(async (other) => {
        const v = await seedWorld(other);
        await addVeto(other, { subject: "person", fps: [domainFp(other, DOMAINS.acme)] });
        return vetoedBy(other, [["entity", v.pat]]);
      });
      expect(wrongSubject).toBeNull();
    }));

  it("an organization is covered by an organization veto holding one of its domain fingerprints", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const veto = await addVeto(db, { subject: "organization", fps: [domainFp(db, DOMAINS.acme)] });
      expect(await vetoedBy(db, [["entity", w.acme]])).toBe(veto);
      expect(await vetoedBy(db, [["entity", w.other]])).toBeNull();
    }));

  it("the owner's entity is never covered, also when a vetoed fingerprint is one of the owner's addresses", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      await addVeto(db, { subject: "person", fps: [address(db, ADDRESSES.owner)] });
      await addVeto(db, { subject: "organization", fps: [domainFp(db, DOMAINS.home)] });
      expect(await vetoedBy(db, [["entity", w.owner]])).toBeNull();
      // The positive control: in the same database a person veto covers Pat.
      const veto = await addVeto(db, { subject: "person", fps: [address(db, ADDRESSES.pat)] });
      expect(await vetoedBy(db, [["entity", w.pat]])).toBe(veto);
      expect(await vetoedBy(db, [["entity", w.owner]])).toBeNull();
    }));

  it("a message is covered through an interaction row of a covered entity", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const veto = await addVeto(db, { subject: "person", fps: [address(db, ADDRESSES.pat)] });
      // Sent by the owner to Pat: its sender columns are the owner's, so only the interaction row covers it.
      expect(await vetoedBy(db, [["message", w.toPat.id]])).toBe(veto);
      expect(await vetoedBy(db, [["message", w.fromQuin.id]])).toBeNull();
    }));

  it("an inbound bulk message is covered by its sender fingerprint, and the same fingerprint on an outbound message covers nothing", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const person = await addVeto(db, {
        subject: "person",
        fps: [address(db, ADDRESSES.news)],
        createdAt: "2026-01-01T00:00:00Z",
      });
      expect(await vetoedBy(db, [["message", w.bulkNews.id]])).toBe(person);
      expect(await vetoedBy(db, [["message", w.outNews.id]])).toBeNull();
      // The sender's domain, by an organization veto, the same way.
      const db2 = await withDatabase(async (other) => {
        const v = await seedWorld(other);
        const organization = await addVeto(other, { subject: "organization", fps: [domainFp(other, DOMAINS.acme)] });
        return {
          inbound: await vetoedBy(other, [["message", v.bulkNews.id]]),
          outbound: await vetoedBy(other, [["message", v.outNews.id]]),
          organization,
        };
      });
      expect(db2.inbound).toBe(db2.organization);
      expect(db2.outbound).toBeNull();
    }));

  it("an event is covered through a participant row of a covered entity", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const veto = await addVeto(db, { subject: "person", fps: [address(db, ADDRESSES.pat)] });
      expect(await vetoedBy(db, [["event", w.patMeeting.id]])).toBe(veto);
      expect(await vetoedBy(db, [["event", w.quinInvite.id]])).toBeNull();
    }));

  it("a veto with a kind covers only that kind", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const veto = await addVeto(db, {
        subject: "person",
        fps: [address(db, ADDRESSES.pat)],
        workKind: "introduction",
      });
      expect(await vetoedBy(db, [["entity", w.pat]], "introduction")).toBe(veto);
      expect(await vetoedBy(db, [["entity", w.pat]], "follow_up")).toBeNull();
      expect(await vetoedBy(db, [["entity", w.pat]], null)).toBeNull();
      // A veto with no kind covers every kind.
      const any = await addVeto(db, { subject: "person", fps: [address(db, ADDRESSES.quin)] });
      expect(await vetoedBy(db, [["entity", w.quin]], "follow_up")).toBe(any);
      expect(await vetoedBy(db, [["entity", w.quin]], null)).toBe(any);
    }));

  it("a veto with subject any covers every ref, for its kind", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const veto = await addVeto(db, { subject: "any", fps: [], workKind: "introduction" });
      for (const ref of [
        ["entity", w.pat],
        ["entity", w.acme],
        ["message", w.fromQuin.id],
        ["event", w.quinInvite.id],
        ["address", address(db, "nobody@nowhere-owner.test")],
        ["domain", domainFp(db, "nowhere-owner.test")],
      ] as Ref[]) {
        expect(await vetoedBy(db, [ref], "introduction"), ref.join(" ")).toBe(veto);
        expect(await vetoedBy(db, [ref], "follow_up"), ref.join(" ")).toBeNull();
      }
    }));

  it("a lifted veto covers nothing", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const veto = await addVeto(db, { subject: "person", fps: [address(db, ADDRESSES.pat)] });
      expect(await vetoedBy(db, [["entity", w.pat]])).toBe(veto);
      const lift = testId("rul");
      await admin(
        db,
        "insert into knowledge.owner_decisions (id, request_id, kind, target_kind, target_id, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'veto_lift', null, null, 0, '{}', '{}', now(), '{own}')",
        [lift, testId("req")],
      );
      await admin(db, "update knowledge.vetoes set lifted_at = now(), lift_ruling_id = $2 where ruling_id = $1", [
        veto,
        lift,
      ]);
      expect(await vetoedBy(db, [["entity", w.pat]])).toBeNull();
      expect(await vetoedBy(db, [["event", w.patMeeting.id]])).toBeNull();
    }));

  it("an address ref is covered by a person veto that holds its fingerprint and by nothing else", () =>
    withDatabase(async (db) => {
      await seedWorld(db);
      const pat = address(db, ADDRESSES.pat);
      // An organization veto on its domain, and one that holds the address fingerprint itself.
      await addVeto(db, { subject: "organization", fps: [domainFp(db, DOMAINS.acme), pat] });
      expect(await vetoedBy(db, [["address", pat]])).toBeNull();
      const veto = await addVeto(db, { subject: "person", fps: [pat] });
      expect(await vetoedBy(db, [["address", pat]])).toBe(veto);
      expect(await vetoedBy(db, [["address", address(db, ADDRESSES.quin)]])).toBeNull();
      // A ref kind the function does not know is never covered, whatever its id.
      expect(await vetoedBy(db, [["claim", pat]])).toBeNull();
      expect(await vetoedBy(db, [["widget", pat]])).toBeNull();
    }));

  it("a domain ref is covered by an organization veto that holds its fingerprint", () =>
    withDatabase(async (db) => {
      await seedWorld(db);
      const acme = domainFp(db, DOMAINS.acme);
      await addVeto(db, { subject: "person", fps: [acme] });
      expect(await vetoedBy(db, [["domain", acme]])).toBeNull();
      const veto = await addVeto(db, { subject: "organization", fps: [acme] });
      expect(await vetoedBy(db, [["domain", acme]])).toBe(veto);
      expect(await vetoedBy(db, [["domain", domainFp(db, DOMAINS.other)]])).toBeNull();
    }));

  it("vetoed_by returns the ruling id of the oldest covering veto, the same answer when two cover, and null when none does", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      expect(
        await vetoedBy(db, [
          ["entity", w.pat],
          ["message", w.bulkNews.id],
        ]),
      ).toBeNull();
      // Newer first in the table: the answer is by created_at, not by insertion.
      await addVeto(db, { subject: "person", fps: [address(db, ADDRESSES.pat)], createdAt: "2026-03-01T00:00:00Z" });
      const older = await addVeto(db, {
        subject: "person",
        fps: [address(db, ADDRESSES.news)],
        createdAt: "2026-02-01T00:00:00Z",
      });
      expect(
        await vetoedBy(db, [
          ["entity", w.pat],
          ["message", w.bulkNews.id],
        ]),
      ).toBe(older);
      expect(
        await vetoedBy(db, [
          ["message", w.bulkNews.id],
          ["entity", w.pat],
        ]),
      ).toBe(older);
      expect(
        await vetoedBy(db, [
          ["entity", w.pat],
          ["message", w.bulkNews.id],
        ]),
      ).toBe(older);
      // At one created_at, the smaller ruling id, whichever was written first.
      const [first, second] = [testId("rul"), testId("rul")].sort();
      if (first === undefined || second === undefined) throw new Error("two ids");
      const tied = "2026-01-15T00:00:00Z";
      await addVeto(db, { subject: "person", fps: [address(db, ADDRESSES.quin)], createdAt: tied, id: second });
      await addVeto(db, { subject: "organization", fps: [domainFp(db, DOMAINS.other)], createdAt: tied, id: first });
      expect(await vetoedBy(db, [["entity", w.quin]])).toBe(first);
      expect(
        await vetoedBy(db, [
          ["entity", w.pat],
          ["entity", w.quin],
        ]),
      ).toBe(first);
      // None covers the owner or the work person.
      expect(
        await vetoedBy(db, [
          ["entity", w.owner],
          ["entity", w.wren],
        ]),
      ).toBeNull();
    }));

  it("vetoed is true exactly when vetoed_by is not null, over every case above", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      await addVeto(db, { subject: "person", fps: [address(db, ADDRESSES.pat), address(db, ADDRESSES.news)] });
      await addVeto(db, { subject: "organization", fps: [domainFp(db, DOMAINS.other)] });
      await addVeto(db, { subject: "any", fps: [], workKind: "introduction" });
      const refs: Ref[] = [
        ["entity", w.owner],
        ["entity", w.pat],
        ["entity", w.quin],
        ["entity", w.acme],
        ["entity", w.other],
        ["message", w.toPat.id],
        ["message", w.fromQuin.id],
        ["message", w.bulkNews.id],
        ["message", w.outNews.id],
        ["event", w.patMeeting.id],
        ["event", w.quinInvite.id],
        ["address", address(db, ADDRESSES.pat)],
        ["domain", domainFp(db, DOMAINS.other)],
        ["widget", "x"],
      ];
      // vetoedBy asserts the agreement for each; between them both answers occur.
      const answers = new Set<boolean>();
      for (const ref of refs)
        for (const kind of [null, "introduction"]) answers.add((await vetoedBy(db, [ref], kind)) !== null);
      expect([...answers].sort()).toEqual([false, true]);
    }));

  it("a veto still holds for a person whose entity was removed and came back under a new id", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      // The veto copies the fingerprints the person's account rows hold.
      const fps = (
        await admin<{ fp: string }>(db, "select value_fp as fp from knowledge.accounts where entity_id = $1", [w.pat])
      ).map((row) => row.fp);
      expect(fps).toEqual([address(db, ADDRESSES.pat)]);
      const veto = await addVeto(db, { subject: "person", fps });
      expect(await vetoedBy(db, [["entity", w.pat]])).toBe(veto);

      await session(db.urls.admin, async (query) => {
        await query("delete from knowledge.interaction_log where entity_id = $1", [w.pat]);
        await query("delete from knowledge.event_participants where entity_id = $1", [w.pat]);
        await query("delete from knowledge.aliases where entity_id = $1", [w.pat]);
        await query("delete from knowledge.accounts where entity_id = $1", [w.pat]);
        await query("delete from knowledge.entities where id = $1", [w.pat]);
      });
      expect(await vetoedBy(db, [["entity", w.pat]])).toBeNull();
      const again = testId("ent");
      const account = testId("adr");
      await admin(db, "insert into knowledge.entities (id, kind) values ($1, 'person')", [again]);
      await admin(
        db,
        "insert into knowledge.accounts (id, entity_id, kind, value_fp, domain_fp, value_enc, compartments) values ($1, $2, 'email', $3, $4, $5, '{own}')",
        [
          account,
          again,
          address(db, ADDRESSES.pat),
          domainFp(db, DOMAINS.acme),
          sealRow(db.keys, "own", { table: "knowledge.accounts", id: account, column: "value_enc" }, ADDRESSES.pat),
        ],
      );
      expect(await vetoedBy(db, [["entity", again]])).toBe(veto);
      // The control: another person is not.
      expect(await vetoedBy(db, [["entity", w.quin]])).toBeNull();
    }));
});

describe("two locks order every ledger write", { timeout: TIMEOUT }, () => {
  it("a row written while its ref is being deleted is tainted or refused, never left whole", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const whole = async (message: string, row: string): Promise<number> =>
        one(
          await admin<{ n: number }>(
            db,
            `select count(*)::int as n from ledger.basis b join ledger.cards c on c.id = b.row_id
             where b.row_kind = 'card' and b.row_id = $2 and b.ref_id = $1 and b.tainted_at is null and c.tainted_at is null`,
            [message, row],
          ),
        ).n;

      // The deletion first: it holds the taint lock; add_basis waits, then finds the ref gone.
      const first = await card(db);
      await withConnections([db.urls.writer, db.urls.admin], async ([deleting, writing]) => {
        if (deleting === undefined || writing === undefined) throw new Error("two connections");
        await deleting.query("begin");
        await deleting.query("delete from knowledge.messages where id = $1", [w.fromQuin.id]);
        await deleting.query("select ledger.taint_citing($1::text[], '{message}', $2::text[])", [
          [w.fromQuin.evidence],
          [w.fromQuin.id],
        ]);
        await writing.query("begin");
        const write = writing.query<{ ok: boolean }>(
          "select ledger.add_basis('card', $1, '{own}', '{message}', $2::text[], null) as ok",
          [first, [w.fromQuin.id]],
        );
        expect(await waiting(db, writing.pid)).toBe(true);
        expect(await settled(write)).toBe(false);
        await deleting.query("commit");
        expect(one(await write).ok).toBe(false);
        await writing.query("commit");
      });
      expect(await whole(w.fromQuin.id, first)).toBe(0);
      expect(
        one(
          await admin<{ n: number }>(db, "select count(*)::int as n from ledger.basis where ref_id = $1", [
            w.fromQuin.id,
          ]),
        ).n,
      ).toBe(0);

      // The write first: it holds the shared lock; the taint waits, then sees its row.
      const second = await card(db);
      await withConnections([db.urls.writer, db.urls.admin], async ([deleting, writing]) => {
        if (deleting === undefined || writing === undefined) throw new Error("two connections");
        await writing.query("begin");
        expect(
          one(
            await writing.query<{ ok: boolean }>(
              "select ledger.add_basis('card', $1, '{own}', '{message}', $2::text[], null) as ok",
              [second, [w.toPat.id]],
            ),
          ).ok,
        ).toBe(true);
        await deleting.query("begin");
        const deletion = (async () => {
          await deleting.query("delete from knowledge.messages where id = $1", [w.toPat.id]);
          return one(
            await deleting.query<{ n: number }>(
              "select ledger.taint_citing($1::text[], '{message}', $2::text[]) as n",
              [[w.toPat.evidence], [w.toPat.id]],
            ),
          ).n;
        })();
        expect(await waiting(db, deleting.pid)).toBe(true);
        expect(await settled(deletion)).toBe(false);
        await writing.query("commit");
        expect(await deletion).toBeGreaterThan(0);
        await deleting.query("commit");
      });
      expect(await whole(w.toPat.id, second)).toBe(0);
      expect(await basisOf(db, second)).toMatchObject([{ ref_id: w.toPat.id, evidence_id: null, tainted: true }]);
      expect(
        one(
          await admin<{ tainted: boolean }>(
            db,
            "select tainted_at is not null as tainted from ledger.cards where id = $1",
            [second],
          ),
        ).tainted,
      ).toBe(true);
    }));

  it("lock_rows takes the shared taint lock and then its row locks in ascending order whatever order it is handed, and a second connection that asks for one of the rows waits until the first commits", () =>
    withDatabase(async (db) => {
      const [low, high] = [testId("crd"), testId("crd")].sort();
      if (low === undefined || high === undefined) throw new Error("two ids");
      const [taintAt, lowAt, highAt] = [await taintKey(db), await rowKey(db, low), await rowKey(db, high)];
      await withConnections([db.urls.admin, db.urls.admin, db.urls.admin], async ([first, holder, second]) => {
        if (first === undefined || holder === undefined || second === undefined) throw new Error("three connections");
        // Another transaction holds the higher row's lock.
        await holder.query("begin");
        await holder.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [high]);

        await first.query("begin");
        const locking = first.query("select ledger.lock_rows($1::text[])", [[high, low, high]]);
        expect(await waiting(db, first.pid)).toBe(true);
        // Handed the higher id first, it took the taint lock shared and the lower row, and waits
        // for the higher: ascending order.
        expect(await advisory(db, first.pid)).toEqual(
          [`${taintAt} ShareLock granted`, `${lowAt} ExclusiveLock granted`, `${highAt} ExclusiveLock waiting`].sort(),
        );
        await holder.query("commit");
        await locking;
        expect(await advisory(db, first.pid)).toEqual(
          [`${taintAt} ShareLock granted`, `${lowAt} ExclusiveLock granted`, `${highAt} ExclusiveLock granted`].sort(),
        );

        // A second connection that asks for one of the rows waits until the first commits.
        await second.query("begin");
        const asking = second.query("select ledger.lock_rows($1::text[])", [[low]]);
        expect(await waiting(db, second.pid)).toBe(true);
        expect(await settled(asking)).toBe(false);
        await first.query("commit");
        await asking;
        expect(await advisory(db, second.pid)).toEqual(
          [`${taintAt} ShareLock granted`, `${lowAt} ExclusiveLock granted`].sort(),
        );
        await second.query("commit");

        // An empty list takes the shared taint lock alone.
        await first.query("begin");
        await first.query("select ledger.lock_rows('{}'::text[])");
        expect(await advisory(db, first.pid)).toEqual([`${taintAt} ShareLock granted`]);
        await first.query("commit");
      });
    }));

  it("taint_citing waits for a transaction that holds the shared lock, and holds no row lock when it runs", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const cited = await card(db);
      expect(await addBasis(db, cited, [["message", w.fromQuin.id]])).toBe(true);
      const taintAt = await taintKey(db);
      await withConnections([db.urls.admin, db.urls.writer], async ([writing, deleting]) => {
        if (writing === undefined || deleting === undefined) throw new Error("two connections");
        await writing.query("begin");
        await writing.query("select ledger.lock_rows($1::text[])", [[cited]]);
        await deleting.query("begin");
        const tainting = deleting.query<{ n: number }>(
          "select ledger.taint_citing($1::text[], '{message}', $2::text[]) as n",
          [[w.fromQuin.evidence], [w.fromQuin.id]],
        );
        expect(await waiting(db, deleting.pid)).toBe(true);
        expect(await settled(tainting)).toBe(false);
        await writing.query("commit");
        expect(one(await tainting).n).toBe(1);
        // It tainted a card and withdrew it, and holds the taint lock alone: no row lock. The
        // admission it calls for the card's author takes the same key shared, which the holder of
        // the exclusive lock already has.
        const held = await advisory(db, deleting.pid);
        expect(held).toContain(`${taintAt} ExclusiveLock granted`);
        expect(held.filter((line) => !line.startsWith(`${taintAt} `))).toEqual([]);
        await deleting.query("commit");
      });
      expect(await latest(db, cited)).toEqual({ event: "withdrawn", by: "system:taint" });
    }));
});

describe("ledger.admit_deferred", { timeout: TIMEOUT }, () => {
  const admit = async (db: TestDatabase, author: string): Promise<number> =>
    one(await admin<{ n: number }>(db, "select ledger.admit_deferred($1) as n", [author])).n;
  const events = async (db: TestDatabase): Promise<number> =>
    one(await admin<{ n: number }>(db, "select count(*)::int as n from ledger.record_events")).n;

  it("admit_deferred admits every deferred card of an author, oldest first, however many are pending", () =>
    withDatabase(async (db) => {
      await cardsOf(db, "system:ten", 10, ["pending"]);
      // Decided cards count for nothing.
      await cardsOf(db, "system:ten", 2, ["pending", "decided"]);
      const [older, newer] = await cardsOf(db, "system:ten", 2, ["deferred"]);
      if (older === undefined || newer === undefined) throw new Error("two cards");
      expect(await admit(db, "system:ten")).toBe(2);
      expect(await latest(db, older)).toEqual({ event: "pending", by: "system:queue" });
      expect(await latest(db, newer)).toEqual({ event: "pending", by: "system:queue" });
      // Nothing more.
      const before = await events(db);
      expect(await admit(db, "system:ten")).toBe(0);
      expect(await events(db)).toBe(before);
      // Another author's cards are not this one's.
      expect(await admit(db, "system:nobody")).toBe(0);
    }));

  it("it skips a tainted card and one past its fixed expiry", () =>
    withDatabase(async (db) => {
      await cardsOf(db, "system:skips", 9, ["pending"]);
      const tainted = await card(db, { author: "system:skips", events: ["deferred"] });
      const expired = await card(db, {
        author: "system:skips",
        events: ["deferred"],
        expiresAt: "2020-01-01T00:00:00Z",
      });
      const admissible = await card(db, {
        author: "system:skips",
        events: ["deferred"],
        expiresAt: "2099-01-01T00:00:00Z",
      });
      await ownerCommit(db, (query) => query("update ledger.cards set tainted_at = now() where id = $1", [tainted]));
      expect(await admit(db, "system:skips")).toBe(1);
      expect(await latest(db, admissible)).toEqual({ event: "pending", by: "system:queue" });
      expect((await latest(db, tainted)).event).not.toBe("pending");
      expect((await latest(db, expired)).event).not.toBe("pending");
    }));
});

// ---------------------------------------------------------------------------------------------
// ledger.add_basis and ledger.owner_backed
// ---------------------------------------------------------------------------------------------

describe("ledger.add_basis", { timeout: TIMEOUT }, () => {
  it("a ref that does not exist writes nothing and answers false", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const row = await card(db);
      for (const missing of [
        ["message", testId("msg")],
        ["event", testId("evt")],
        ["entity", testId("ent")],
        ["widget", testId("wid")],
      ] as Ref[]) {
        expect(await addBasis(db, row, [["message", w.fromQuin.id], missing]), missing.join(" ")).toBe(false);
        expect(await basisOf(db, row), missing.join(" ")).toEqual([]);
      }
      // The positive control: the ref that exists, alone.
      expect(await addBasis(db, row, [["message", w.fromQuin.id]])).toBe(true);
      expect(await basisOf(db, row)).toHaveLength(1);
    }));

  it("with a clearance, a ref outside it answers false exactly as one that does not exist", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const row = await card(db);
      const answers: boolean[] = [];
      for (const [name, ref] of [
        ["work message", ["message", w.workMail.id]],
        ["work event", ["event", w.workMeeting.id]],
        ["work person", ["entity", w.wren]],
        ["missing message", ["message", testId("msg")]],
        ["missing entity", ["entity", testId("ent")]],
      ] as [string, Ref][]) {
        // Each answers, with no error, and writes nothing.
        answers.push(await addBasis(db, row, [ref], ["own"]));
        expect(await basisOf(db, row), name).toEqual([]);
      }
      // Not told apart: the same answer for the hidden refs as for the missing ones.
      expect(answers).toEqual([false, false, false, false, false]);
      // The positive controls: within a clearance that covers them, each resolves.
      for (const ref of [
        ["message", w.workMail.id],
        ["event", w.workMeeting.id],
        ["entity", w.wren],
      ] as Ref[]) {
        expect(await addBasis(db, await card(db), [ref], ["own", "employer:example"]), ref.join(" ")).toBe(true);
      }
      expect(
        await addBasis(
          db,
          await card(db),
          [
            ["entity", w.pat],
            ["message", w.fromQuin.id],
          ],
          ["own"],
        ),
      ).toBe(true);
    }, BOTH));

  it("a message ref carries its evidence id and the class source, and an event ref its event's", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const row = await card(db);
      expect(
        await addBasis(
          db,
          row,
          [
            ["message", w.fromQuin.id],
            ["event", w.quinInvite.id],
          ],
          null,
          ["own", "employer:example", "own"],
        ),
      ).toBe(true);
      expect(await basisOf(db, row)).toEqual([
        {
          ref_kind: "message",
          ref_id: w.fromQuin.id,
          evidence_id: w.fromQuin.evidence,
          source_class: "source",
          owner_backed: false,
          compartments: ["employer:example", "own"],
          tainted: false,
        },
        {
          ref_kind: "event",
          ref_id: w.quinInvite.id,
          evidence_id: w.quinInvite.evidence,
          source_class: "source",
          owner_backed: false,
          compartments: ["employer:example", "own"],
          tainted: false,
        },
      ]);
    }, BOTH));

  it("an entity ref has the class derived", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const row = await card(db);
      expect(
        await addBasis(db, row, [
          ["entity", w.pat],
          ["entity", w.acme],
        ]),
      ).toBe(true);
      expect(await basisOf(db, row)).toEqual([
        {
          ref_kind: "entity",
          ref_id: w.pat,
          evidence_id: null,
          source_class: "derived",
          owner_backed: false,
          compartments: ["own"],
          tainted: false,
        },
        {
          ref_kind: "entity",
          ref_id: w.acme,
          evidence_id: null,
          source_class: "derived",
          owner_backed: false,
          compartments: ["own"],
          tainted: false,
        },
      ]);
    }));

  it("with a clearance, a held message answers false exactly as one that does not exist, and the same ref with a null clearance resolves", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const row = await card(db);
      expect(await addBasis(db, row, [["message", w.held.id]], ["own"])).toBe(false);
      expect(await addBasis(db, row, [["message", testId("msg")]], ["own"])).toBe(false);
      expect(await basisOf(db, row)).toEqual([]);
      // The control: an unheld message under the same clearance.
      expect(await addBasis(db, row, [["message", w.fromQuin.id]], ["own"])).toBe(true);
      const unrestricted = await card(db);
      expect(await addBasis(db, unrestricted, [["message", w.held.id]], null)).toBe(true);
      expect(await basisOf(db, unrestricted)).toMatchObject([
        { ref_id: w.held.id, evidence_id: w.held.evidence, source_class: "source" },
      ]);
    }));

  it("a message whose evidence row is marked system_originated, and one marked answers_system, has the class system and is not owner-backed, though the first is outbound", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const row = await card(db);
      expect(
        await addBasis(db, row, [
          ["message", w.systemSent.id],
          ["message", w.answersSystem.id],
        ]),
      ).toBe(true);
      expect(await basisOf(db, row)).toMatchObject([
        { ref_id: w.systemSent.id, evidence_id: w.systemSent.evidence, source_class: "system", owner_backed: false },
        {
          ref_id: w.answersSystem.id,
          evidence_id: w.answersSystem.evidence,
          source_class: "system",
          owner_backed: false,
        },
      ]);
      // The control: the same outbound message without the mark is owner-backed, class source.
      const control = await card(db);
      expect(await addBasis(db, control, [["message", w.toPat.id]])).toBe(true);
      expect(await basisOf(db, control)).toMatchObject([{ source_class: "source", owner_backed: true }]);
    }));

  it("an outbound message, an accepted event and an event the owner organized are owner-backed, and an inbound message and an unanswered invitation are not", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const row = await card(db);
      const refs: Ref[] = [
        ["message", w.toPat.id],
        ["event", w.patMeeting.id],
        ["event", w.organized.id],
        ["message", w.fromQuin.id],
        ["event", w.quinInvite.id],
      ];
      expect(await addBasis(db, row, refs)).toBe(true);
      expect((await basisOf(db, row)).map((one) => one.owner_backed)).toEqual([true, true, true, false, false]);
    }));

  it("an outbound bulk message is not owner-backed", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const row = await card(db);
      expect(
        await addBasis(db, row, [
          ["message", w.outBulk.id],
          ["message", w.toPat.id],
        ]),
      ).toBe(true);
      expect((await basisOf(db, row)).map((one) => [one.ref_id, one.owner_backed])).toEqual([
        [w.outBulk.id, false],
        [w.toPat.id, true],
      ]);
      expect(
        one(await admin<{ backed: boolean }>(db, "select ledger.owner_backed('message', $1) as backed", [w.outBulk.id]))
          .backed,
      ).toBe(false);
    }));

  it("owner_backed agrees with the basis rows add_basis writes", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const row = await card(db);
      const refs: Ref[] = [
        ["message", w.toPat.id],
        ["message", w.fromQuin.id],
        ["message", w.bulkNews.id],
        ["message", w.outNews.id],
        ["message", w.outBulk.id],
        ["message", w.held.id],
        ["message", w.systemSent.id],
        ["message", w.answersSystem.id],
        ["event", w.patMeeting.id],
        ["event", w.quinInvite.id],
        ["event", w.organized.id],
        ["entity", w.pat],
        ["entity", w.owner],
      ];
      expect(await addBasis(db, row, refs)).toBe(true);
      const rows = await basisOf(db, row);
      expect(rows).toHaveLength(refs.length);
      const seen = new Set<boolean>();
      for (const basis of rows) {
        const backed = one(
          await admin<{ backed: boolean }>(db, "select ledger.owner_backed($1, $2) as backed", [
            basis.ref_kind,
            basis.ref_id,
          ]),
        ).backed;
        expect(backed, `${basis.ref_kind} ${basis.ref_id}`).toBe(basis.owner_backed);
        seen.add(backed);
      }
      expect([...seen].sort()).toEqual([false, true]);
      // An id that names no row, and a kind it does not know, are not owner-backed.
      for (const [kind, id] of [
        ["message", testId("msg")],
        ["event", testId("evt")],
        ["widget", w.toPat.id],
      ] as Ref[]) {
        expect(
          one(await admin<{ backed: boolean }>(db, "select ledger.owner_backed($1, $2) as backed", [kind, id])).backed,
          `${kind} ${id}`,
        ).toBe(false);
      }
    }));
});

describe("ledger.taint_citing", { timeout: TIMEOUT }, () => {
  type CardState = { tainted: boolean; body: boolean };
  const cardState = async (db: TestDatabase, id: string): Promise<CardState> =>
    one(
      await admin<CardState>(
        db,
        "select tainted_at is not null as tainted, body_enc is not null as body from ledger.cards where id = $1",
        [id],
      ),
    );
  const eventsOf = (db: TestDatabase, id: string) =>
    admin<{ event: string; tainted: boolean; body: boolean }>(
      db,
      "select event, tainted_at is not null as tainted, body_enc is not null as body from ledger.record_events where row_kind = 'card' and row_id = $1 order by id",
      [id],
    );

  it("taint marks the basis, clears its evidence id, taints the card and clears its body and its events' bodies", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const cited = await card(db, { body: true, events: ["pending"] });
      expect(
        await addBasis(db, cited, [
          ["message", w.fromQuin.id],
          ["entity", w.quin],
        ]),
      ).toBe(true);
      // The control: a card that cites another message keeps everything.
      const other = await card(db, { body: true, events: ["pending"] });
      expect(await addBasis(db, other, [["message", w.toPat.id]])).toBe(true);

      expect(await taint(db, [w.fromQuin.evidence], [["message", w.fromQuin.id]])).toBe(1);
      expect(await basisOf(db, cited)).toMatchObject([
        { ref_id: w.fromQuin.id, evidence_id: null, tainted: true },
        // A basis row of the card that cites what is still there keeps its ref.
        { ref_id: w.quin, tainted: false },
      ]);
      expect(await cardState(db, cited)).toEqual({ tainted: true, body: false });
      expect((await eventsOf(db, cited))[0]).toEqual({ event: "pending", tainted: true, body: false });

      expect(await basisOf(db, other)).toMatchObject([
        { ref_id: w.toPat.id, evidence_id: w.toPat.evidence, tainted: false },
      ]);
      expect(await cardState(db, other)).toEqual({ tainted: false, body: true });
      expect(await eventsOf(db, other)).toEqual([{ event: "pending", tainted: false, body: true }]);

      // By evidence id alone, with no ref: a basis row that cites that revision.
      const byEvidence = await card(db, { body: true });
      expect(await addBasis(db, byEvidence, [["event", w.quinInvite.id]])).toBe(true);
      expect(await taint(db, [w.quinInvite.evidence], [])).toBe(1);
      expect(await basisOf(db, byEvidence)).toMatchObject([
        { ref_id: w.quinInvite.id, evidence_id: null, tainted: true },
      ]);
      expect(await cardState(db, byEvidence)).toEqual({ tainted: true, body: false });
    }));

  it("a pending card that is tainted is withdrawn, and its author's deferred cards are admitted in the same call", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const author = "system:tainting";
      const cited = await card(db, { author });
      expect(await addBasis(db, cited, [["message", w.fromQuin.id]])).toBe(true);
      await cardsOf(db, author, 9, ["pending"]);
      const [oldest, younger] = await cardsOf(db, author, 2, ["deferred"]);
      if (oldest === undefined || younger === undefined) throw new Error("two cards");
      // A tainted card that was already decided is tainted and not withdrawn.
      const decided = await card(db, { author: "system:decided", events: ["pending", "decided"] });
      expect(await addBasis(db, decided, [["message", w.fromQuin.id]])).toBe(true);

      expect(await taint(db, [w.fromQuin.evidence], [["message", w.fromQuin.id]])).toBe(2);
      expect(await latest(db, cited)).toEqual({ event: "withdrawn", by: "system:taint" });
      expect(await latest(db, oldest)).toEqual({ event: "pending", by: "system:queue" });
      expect(await latest(db, younger)).toEqual({ event: "pending", by: "system:queue" });
      expect(await latest(db, decided)).toEqual({ event: "decided", by: "system:decided" });
      expect(await cardState(db, decided)).toMatchObject({ tainted: true });
    }));

  it("a card whose target is one of the refs is tainted", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const aboutMessage = await card(db, { target: ["message", w.fromQuin.id], body: true });
      const aboutPerson = await card(db, { target: ["entity", w.quin], body: true });
      const aboutOther = await card(db, { target: ["message", w.toPat.id], body: true });
      expect(
        await taint(
          db,
          [w.fromQuin.evidence],
          [
            ["message", w.fromQuin.id],
            ["entity", w.quin],
          ],
        ),
      ).toBe(2);
      for (const id of [aboutMessage, aboutPerson]) {
        expect(await cardState(db, id)).toEqual({ tainted: true, body: false });
        expect(await latest(db, id)).toEqual({ event: "withdrawn", by: "system:taint" });
      }
      expect(await cardState(db, aboutOther)).toEqual({ tainted: false, body: true });
      expect(await latest(db, aboutOther)).toEqual({ event: "pending", by: "system:test" });
    }));

  it("a decision whose target is one of the refs is tainted and keeps its answer", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const decision = async (target: Ref): Promise<string> => {
        const id = testId("rul");
        await admin(
          db,
          `insert into knowledge.owner_decisions (id, request_id, kind, target_kind, target_id, answer, queue_depth, labels, details, decided_at, compartments, body_enc)
           values ($1, $2, 'answer', $3, $4, 'acknowledge', 3, '{correct}', '{}', $5, '{own}', $6)`,
          [
            id,
            testId("req"),
            target[0],
            target[1],
            AT,
            sealUnder(
              db.keys,
              ["own"],
              { table: "knowledge.owner_decisions", id, column: "body_enc" },
              "the owner's note",
            ),
          ],
        );
        return id;
      };
      const tainted = await decision(["message", w.fromQuin.id]);
      const kept = await decision(["message", w.toPat.id]);
      expect(await taint(db, [w.fromQuin.evidence], [["message", w.fromQuin.id]])).toBe(1);
      const row = (id: string) =>
        admin(
          db,
          "select kind, answer, queue_depth, labels, target_id, tainted_at is not null as tainted, body_enc is not null as body from knowledge.owner_decisions where id = $1",
          [id],
        );
      expect(await row(tainted)).toEqual([
        {
          kind: "answer",
          answer: "acknowledge",
          queue_depth: 3,
          labels: ["correct"],
          target_id: w.fromQuin.id,
          tainted: true,
          body: false,
        },
      ]);
      expect(await row(kept)).toEqual([
        {
          kind: "answer",
          answer: "acknowledge",
          queue_depth: 3,
          labels: ["correct"],
          target_id: w.toPat.id,
          tainted: false,
          body: true,
        },
      ]);
    }));

  it("a second taint changes nothing", () =>
    withDatabase(async (db) => {
      const w = await seedWorld(db);
      const cited = await card(db, { body: true });
      expect(await addBasis(db, cited, [["message", w.fromQuin.id]])).toBe(true);
      await card(db, { target: ["message", w.fromQuin.id] });
      await admin(
        db,
        "insert into knowledge.owner_decisions (id, request_id, kind, target_kind, target_id, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'answer', 'message', $3, 0, '{}', '{}', $4, '{own}')",
        [testId("rul"), testId("req"), w.fromQuin.id, AT],
      );
      const args: [string[], Ref[]] = [[w.fromQuin.evidence], [["message", w.fromQuin.id]]];
      // Two cards and one decision.
      expect(await taint(db, ...args)).toBe(3);
      const rows = async (): Promise<string[]> => {
        const lines: string[] = [];
        for (const [table, key] of [
          ["knowledge.owner_decisions", "id"],
          ["knowledge.vetoes", "ruling_id"],
          ["ledger.cards", "id"],
          ["ledger.record_events", "id::text"],
          ["ledger.basis", "id::text"],
        ]) {
          for (const row of await admin<{ line: string }>(
            db,
            `select '${table} ' || (${key})::text || ' ' || xmin::text as line from ${table}`,
          ))
            lines.push(row.line);
        }
        return lines.sort();
      };
      const before = await rows();
      expect(await taint(db, ...args)).toBe(0);
      expect(await taint(db, ...args, db.urls.admin)).toBe(0);
      expect(await rows()).toEqual(before);
      // And a call with nothing names nothing.
      expect(await taint(db, [], [])).toBe(0);
      expect(await rows()).toEqual(before);
    }));
});
