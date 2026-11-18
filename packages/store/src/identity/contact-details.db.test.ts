import type { DraftMessageArgs, ReadOutcome } from "@intelligence/contracts/personal";
import { PERSONAL_LIMITS } from "@intelligence/personal-core";
import { contactDeletion, deriveItem } from "@intelligence/personal-core/items";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Admin } from "../admin/admin.ts";
import { createWork } from "../agent-work/work.ts";
import { Reader } from "../read/read.ts";
import type { Sender } from "../send/sender.ts";
import { testId } from "../test-support/clients.ts";
import { one, readAs } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { contactRaw, inIdentityWorld, NOW, type SavedPerson } from "../test-support/identity-fixtures.ts";
import { eventLogger } from "../test-support/recording.ts";
import {
  connectSend,
  draftingClient,
  OWNER,
  type SendWorld,
  seedDraft,
  senderOf,
  sendWorld,
  synced,
} from "../test-support/sender-fixtures.ts";
import { outcomeValue, refusedWith, registration } from "../test-support/values.ts";
import type { WorkClient } from "../test-support/work-clients.ts";
import type { SourceAccountRow } from "../write/writer-types.ts";

// The outbound gate's contact check at phase draft and at phase send, the owner's release of a
// contact field, and the role and affiliation claims code makes from a contact. Made-up values on
// reserved domains only.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const MAREN = "maren@contact-details.test";
const OTHER = "rowan@contact-details-other.test";
const PHONE = "+1 415 555 0142";
const TITLE = "Head of Research Operations";
const ORGANIZATION = "Example Works Holdings";
const maren: SavedPerson = {
  names: ["Maren Holt"],
  emails: [MAREN],
  phone: PHONE,
  organization: ORGANIZATION,
  title: TITLE,
};

const open: { world: SendWorld; senders: Sender[] }[] = [];
afterEach(async () => {
  for (const { world, senders } of open.splice(0)) {
    for (const sender of senders) await sender.close();
    await world.close();
  }
});

async function setUp(): Promise<{ world: SendWorld; sender: Sender; contacts: SourceAccountRow }> {
  const world = await sendWorld();
  const sender = senderOf(world);
  open.push({ world, senders: [sender] });
  await connectSend(world);
  await synced(world, world.accounts.personalMail.id);
  const contacts = await world.writer.ensureSourceAccount("personal", "google_contacts", "own", OWNER.personal);
  return { world, sender, contacts };
}

async function save(world: SendWorld, account: SourceAccountRow, resource: string, person: SavedPerson): Promise<void> {
  const raw = contactRaw(account, resource, person);
  await world.writer.ingestItem(account, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS));
}

const contactId = async (world: SendWorld): Promise<string> =>
  one(await queryAs<{ id: string }>(world.db.urls.admin, "select id from knowledge.contacts order by id limit 1")).id;

// Work.draftMessage as pi mcp runs it, on the reader's URL: the draft's id.
async function draft(world: SendWorld, client: WorkClient, to: string, body: string): Promise<string> {
  const pool = new pg.Pool({ connectionString: world.db.urls.reader, max: 2, connectionTimeoutMillis: 20_000 });
  try {
    const work = createWork({
      reader: new Reader({ pool, keys: world.db.keys, log: eventLogger() }),
      log: eventLogger(),
    });
    const args: DraftMessageArgs = {
      to: [to],
      subject: "A note",
      body,
      requestId: testId("req"),
      account: "personal",
    } as DraftMessageArgs;
    const outcome = (await work.draftMessage(client.token, args)) as ReadOutcome<{ draft: string }>;
    if (!outcome.ok) throw new Error(`no draft: ${outcome.code}`);
    return outcome.value.draft;
  } finally {
    await pool.end();
  }
}

const disclosureAtDraft = async (world: SendWorld, id: string): Promise<boolean> =>
  one(
    await queryAs<{ passed: boolean }>(
      world.db.urls.admin,
      "select passed from ledger.gate_checks where draft_id = $1 and phase = 'draft' and kind = 'disclosure'",
      [id],
    ),
  ).passed;

describe("the gate's contact check", () => {
  it("contact_candidates returns a contact that does not list every recipient, and not one that lists them all", async () => {
    const { world, contacts } = await setUp();
    await save(world, contacts, "maren", maren);
    const client = await draftingClient(world, "jev");
    const toOther = await seedDraft(world, client, { to: [OTHER] });
    const toMaren = await seedDraft(world, client, { to: [MAREN] });
    const ids = async (id: string) =>
      (
        await queryAs<{ contact_id: string }>(
          world.db.urls.proxy,
          "select contact_id from ledger.contact_candidates($1)",
          [id],
        )
      ).map((row) => row.contact_id);
    expect(await ids(toOther.id)).toEqual([await contactId(world)]);
    expect(await ids(toMaren.id)).toEqual([]);
  });

  it("as pi_reader it refuses another client's draft", async () => {
    const { world, contacts } = await setUp();
    await save(world, contacts, "maren", maren);
    const drafter = await draftingClient(world, "jev");
    const other = await draftingClient(world, "luna");
    const seeded = await seedDraft(world, drafter, { to: [OTHER] });
    await expect(
      readAs(world.db, other.token, (query) =>
        query("select contact_id from ledger.contact_candidates($1)", [seeded.id]),
      ),
    ).rejects.toThrow();
    const own = await readAs(world.db, drafter.token, (query) =>
      query<{ contact_id: string }>("select contact_id from ledger.contact_candidates($1)", [seeded.id]),
    );
    expect(own).toHaveLength(1);
  });

  it("a draft carrying a contact's phone number to an address the contact does not list is held at phase draft; the same draft to the contact is not", async () => {
    const { world, contacts } = await setUp();
    await save(world, contacts, "maren", maren);
    const client = await draftingClient(world, "jev");
    expect(await disclosureAtDraft(world, await draft(world, client, OTHER, `Call her on ${PHONE}.`))).toBe(false);
    expect(await disclosureAtDraft(world, await draft(world, client, MAREN, `I have you as ${PHONE}.`))).toBe(true);
  });

  it("a contact's title ties only beside its name: the role claim made from it does not hold a draft alone", async () => {
    const { world, contacts } = await setUp();
    await save(world, contacts, "maren", maren);
    const client = await draftingClient(world, "jev");
    expect(await disclosureAtDraft(world, await draft(world, client, OTHER, `We are hiring a ${TITLE}.`))).toBe(true);
    expect(await disclosureAtDraft(world, await draft(world, client, OTHER, `Maren is our ${TITLE}.`))).toBe(false);
  });

  it("show names the held field with no value; gate with the reveal code releases it, and the send decision records it by contact, field and index", async () => {
    const { world, sender, contacts } = await setUp();
    await save(world, contacts, "maren", maren);
    const id = await contactId(world);
    const client = await draftingClient(world, "jev");
    const seeded = await seedDraft(world, client, { to: [OTHER], body: `Call her on ${PHONE}.`, disclosure: "held" });
    const view = await sender.show(seeded.id);
    expect(view.heldFields).toEqual([{ id, field: "phone", index: 0 }]);
    expect(view.held).toEqual([]);
    expect(JSON.stringify(view.heldFields)).not.toContain("555");
    const code = view.revealCode ?? "";
    expect(code).toMatch(/^[0-9a-f]{8}$/);
    const without = await sender.gate(seeded.id, seeded.values.payloadFp, { firstContact: true, newThread: true });
    expect(without.cleared).toBe(false);
    expect(without.outcome.causes).toEqual(expect.arrayContaining(["use_only_revealed"]));
    const answer = await sender.gate(seeded.id, seeded.values.payloadFp, {
      reveal: code,
      firstContact: true,
      newThread: true,
    });
    expect(answer).toMatchObject({ cleared: true, released: [`${id}:phone:0`] });
    if (!answer.cleared) return;
    const send = await sender.begin({
      draft: seeded.id,
      decision: answer.decision,
      fp: seeded.values.payloadFp,
      firstContact: answer.firstContact,
      newThread: answer.newThread,
      released: answer.released,
    });
    expect(send).not.toBeNull();
    const details = one(
      await queryAs<{ details: unknown }>(
        world.db.urls.admin,
        "select details from knowledge.owner_decisions where kind = 'send'",
      ),
    ).details;
    expect(details).toEqual({
      firstContact: true,
      newThread: true,
      released: [],
      releasedContacts: [{ contact: id, field: "phone", index: 0 }],
    });
  });

  it("a field that comes to hold the draft after show gives reveal_mismatch", async () => {
    const { world, sender, contacts } = await setUp();
    await save(world, contacts, "maren", maren);
    const client = await draftingClient(world, "jev");
    const seeded = await seedDraft(world, client, {
      to: [OTHER],
      body: `Call her on ${PHONE} or 415 555 0199.`,
      disclosure: "held",
    });
    const code = (await sender.show(seeded.id)).revealCode ?? "";
    await save(world, contacts, "ines", {
      names: ["Ines Varga"],
      emails: ["ines@contact-details.test"],
      phone: "415 555 0199",
    });
    expect(
      (
        await refusedWith(() =>
          sender.gate(seeded.id, seeded.values.payloadFp, { reveal: code, firstContact: true, newThread: true }),
        )
      ).code,
    ).toBe("reveal_mismatch");
  });

  it("begin_send refuses a released element of neither pattern, and a send that releases no field writes no releasedContacts", async () => {
    const { world, sender } = await setUp();
    const client = await draftingClient(world, "jev");
    const seeded = await seedDraft(world, client, { to: [OTHER] });
    const answer = await sender.gate(seeded.id, seeded.values.payloadFp, { firstContact: true, newThread: true });
    if (!answer.cleared) throw new Error("not cleared");
    const args = {
      draft: seeded.id,
      decision: answer.decision,
      fp: seeded.values.payloadFp,
      firstContact: true,
      newThread: true,
    };
    await expect(sender.begin({ ...args, released: ["con_bad:phone:0"] })).rejects.toThrow();
    await expect(sender.begin({ ...args, released: [`con_${"0".repeat(26)}:email:0`] })).rejects.toThrow();
    expect(await sender.begin({ ...args, released: [] })).not.toBeNull();
    const details = one(
      await queryAs<{ details: Record<string, unknown> }>(
        world.db.urls.admin,
        "select details from knowledge.owner_decisions where kind = 'send'",
      ),
    ).details;
    expect(details).toEqual({ firstContact: true, newThread: true, released: [] });
  });
});

describe("a contact's organization and title as claims (knowledge model R23)", () => {
  const claimsOf = (world: { sql: <Row>(text: string, values?: unknown[]) => Promise<Row[]> }) =>
    world.sql<{ type: string; compartments: string[]; current: boolean }>(
      `select c.type, c.compartments, exists (select 1 from knowledge.contacts k where k.evidence_id = c.evidence_id) as current
       from knowledge.claims c join vault.evidence_items e on e.id = c.evidence_id where e.source_kind = 'crm' order by c.type, c.compartments`,
    );

  it("a contact's title becomes a role claim and its organization an affiliation claim, under the contact's compartment, about its person", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "maren", {
        names: ["Maren Holt"],
        emails: [MAREN],
        organization: ORGANIZATION,
        title: TITLE,
      });
      await world.save(world.accounts.workContacts, "ines", {
        names: ["Ines Varga"],
        emails: ["ines@contact-details.test"],
        organization: ORGANIZATION,
      });
      expect(await claimsOf(world)).toEqual([
        { type: "affiliation", compartments: ["employer:example"], current: true },
        { type: "affiliation", compartments: ["own"], current: true },
        { type: "role", compartments: ["own"], current: true },
      ]);
      const person = await world.person(MAREN);
      expect(await world.count("knowledge.claim_entities", "entity_id = $1", [person])).toBe(2);
    }));

  it("a new revision of the contact replaces its claims, and deleting the contact removes them", () =>
    inIdentityWorld(async (world) => {
      const account = world.accounts.personalContacts;
      await world.save(account, "maren", {
        names: ["Maren Holt"],
        emails: [MAREN],
        organization: ORGANIZATION,
        title: TITLE,
      });
      const later = contactRaw(
        account,
        "maren",
        { names: ["Maren Holt"], emails: [MAREN], organization: ORGANIZATION },
        "2026-09-05T09:00:00Z",
      );
      await world.store.writer.ingestItem(account, later, (ctx) => deriveItem(later, ctx, PERSONAL_LIMITS));
      expect(await claimsOf(world)).toEqual([{ type: "affiliation", compartments: ["own"], current: true }]);
      await world.store.writer.applyDeletion(
        account,
        contactDeletion("people/maren", { sourceAccount: account.id, now: NOW }),
      );
      expect(await claimsOf(world)).toEqual([]);
    }));

  // The claims made from the owner's own contacts reach a reader
  // as find_facts serves any fact; an employer contact's reach none.
  it("find_facts serves a role claim made from an own contact, with no message, and none made from an employer contact", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "maren", {
        names: ["Maren Holt"],
        emails: [MAREN],
        organization: ORGANIZATION,
        title: TITLE,
      });
      await world.save(world.accounts.workContacts, "ines", {
        names: ["Ines Varga"],
        emails: ["ines@contact-details.test"],
        organization: ORGANIZATION,
      });
      const { token } = await world.admin.clients.addClient(
        registration("k1-crm-facts", ["own", "employer:example"], {
          tools: ["find_facts"] as never,
          views: ["self", "people", "work"] as never,
        }),
      );
      const facts = outcomeValue(await world.store.reader.findFacts(token, {})).facts;
      expect(facts.map((one) => [one.type, one.message, one.document]).sort()).toEqual([
        ["affiliation", null, null],
        ["role", null, null],
      ]);
      const role = facts.find((one) => one.type === "role");
      expect(role?.subject.id).toBe(await world.person(MAREN));
      expect(JSON.stringify(role?.fields)).toContain(TITLE);
    }));

  // find_facts binds a contact's fact to the contact's evidence, as a message's fact binds its
  // message, so deleting the contact reaches what was written after reading it.
  it("find_facts binds a contact's fact to the contact: deleting the contact empties a record written after the read", () =>
    inIdentityWorld(
      async (world) => {
        const account = world.accounts.personalContacts;
        await world.save(account, "maren", {
          names: ["Maren Holt"],
          emails: [MAREN],
          organization: ORGANIZATION,
          title: TITLE,
        });
        const admin = new Admin({
          pool: world.store.adminPool,
          keys: world.db.keys,
          log: world.store.log,
          recordEnabled: true,
        });
        const { token } = await admin.clients.addClient(
          registration("k1-crm-bound", ["own"], {
            tools: ["find_facts", "record"] as never,
            views: ["self", "people", "work"] as never,
          }),
        );
        const reader = world.store.reader;
        expect(
          outcomeValue(await reader.findFacts(token, {}))
            .facts.map((one) => one.type)
            .sort(),
        ).toEqual(["affiliation", "role"]);
        const contact = one(
          await world.sql<{ evidence_id: string }>("select evidence_id from knowledge.contacts"),
        ).evidence_id;
        expect(
          one(await world.sql<{ bound: string[] }>("select bound from ledger.read_log where tool = 'find_facts'"))
            .bound,
        ).toEqual([contact]);
        const recordId = outcomeValue(
          await reader.record(token, { kind: "note", body: "where Maren works", requestId: "request-k1-crm-0001" }),
        ).recordId;
        await world.store.writer.applyDeletion(
          account,
          contactDeletion("people/maren", { sourceAccount: account.id, now: NOW }),
        );
        expect(
          await world.sql(
            "select body_enc is not null as body, tainted_at is not null as tainted from ledger.agent_writes where id = $1",
            [recordId],
          ),
        ).toEqual([{ body: false, tainted: true }]);
      },
      ["agent:k1-crm-bound"],
    ));

  // A belief that cites a contact's claim binds the contact's
  // evidence, as find_facts binds it, so deleting the contact reaches what was written after the read.
  it("a compiled belief citing a contact's claim opens it and binds the contact: deleting the contact empties a record written after get_entity", () =>
    inIdentityWorld(
      async (world) => {
        const account = world.accounts.personalContacts;
        await world.save(account, "maren", {
          names: ["Maren Holt"],
          emails: [MAREN],
          organization: ORGANIZATION,
          title: TITLE,
        });
        const person = await world.person(MAREN);
        const claim = one(
          await world.sql<{ id: string; fact_key_fp: string; valid_from: Date }>(
            "select id, fact_key_fp, valid_from from knowledge.claims where type = 'role'",
          ),
        );
        const admin = new Admin({
          pool: world.store.adminPool,
          keys: world.db.keys,
          log: world.store.log,
          recordEnabled: true,
        });
        const { token } = await admin.clients.addClient(
          registration("k1-crm-belief", ["own"], {
            tools: ["get_entity", "record"] as never,
            views: ["self", "people", "work"] as never,
          }),
        );
        const reader = world.store.reader;
        // The card's line of the role, rendered from the contact's claim.
        const [role] = outcomeValue(await reader.getEntity(token, { id: person })).lines!;
        expect(role).toMatchObject({ fact: claim.fact_key_fp, kind: "role", cites: 1 });
        const contact = one(
          await world.sql<{ evidence_id: string }>("select evidence_id from knowledge.contacts"),
        ).evidence_id;
        expect(
          one(await world.sql<{ bound: string[] }>("select bound from ledger.read_log where tool = 'get_entity'"))
            .bound,
        ).toContain(contact);
        const recordId = outcomeValue(
          await reader.record(token, { kind: "note", body: "what Maren does", requestId: "request-k1-crm-0002" }),
        ).recordId;
        await world.store.writer.applyDeletion(
          account,
          contactDeletion("people/maren", { sourceAccount: account.id, now: NOW }),
        );
        expect(
          await world.sql(
            "select body_enc is not null as body, tainted_at is not null as tainted from ledger.agent_writes where id = $1",
            [recordId],
          ),
        ).toEqual([{ body: false, tainted: true }]);
      },
      ["agent:k1-crm-belief"],
    ));

  it("a contact with no organization and no title makes no claim", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "solo", {
        names: ["Solo Person"],
        emails: ["solo@contact-details.test"],
        phone: PHONE,
      });
      expect(await claimsOf(world)).toEqual([]);
    }));
});
