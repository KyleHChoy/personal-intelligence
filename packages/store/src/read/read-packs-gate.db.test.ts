import type { RawItem } from "@intelligence/contracts";
import {
  type AgentRecordArgs,
  type AttendeeBrief,
  type ClientId,
  type ContextPack,
  EventId,
  type PackItem,
} from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { session } from "../test-support/connections.ts";
import { fingerprint, queryAs, scanForPlaintext } from "../test-support/database.ts";
import { mail, mailFacts, mailItem } from "../test-support/items.ts";
import { recordingPool } from "../test-support/recording.ts";
import { eventIdOf, openStore, type TestStore } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { daysFrom, hoursFrom, iso, outcomeValue } from "../test-support/values.ts";
import { type StoreSeeder, storeSeeder } from "../test-support/world.ts";
import type { SourceAccountRow } from "../write/writer-types.ts";
import { Reader } from "./read.ts";

// The pack's gate tests K1, K3, K5 to K9, and K10's pack side in read-packs.db.test.ts, on
// synthetic data with the production roles. Each store is seeded through the writer; clients are
// inserted in SQL as pi_admin, each with its own `agent:` compartment.

const NOW = new Date("2026-03-10T12:00:00.000Z");
const AGENTS = Array.from({ length: 20 }, (_, index) => `g${index + 1}`);
const COMPARTMENTS = ["own", "employer:example", ...AGENTS.map((name) => `agent:${name}`)];
const BOTH = ["own", "employer:example"];
const TOOLS = ["get_self", "record", "build_context_pack"];
const LOG_PACK = /^select policy\.log_pack\(\$1, \$2, \$3, \$4, \$5, \$6\)$/;

const owner = { address: "owner@gate.example.com" };
const ownerWork = { address: "owner@gate-work.example.org" };
const blake = { address: "blake@gate.example.com", name: "Blake Gatefield" };
const casey = { address: "casey@gate.example.com", name: "Casey Gatefield" };
const wren = { address: "wren@gate-work.example.org", name: "Wren Gatework" };

type Client = { id: ClientId; name: string; token: string; compartments: string[] };

async function newClient(store: TestStore, name: string, clearance: string[]): Promise<Client> {
  const compartments = [...new Set([...clearance, `agent:${name}`])];
  const client = { id: testId("cli") as ClientId, name, token: `pit_test-${name}-${testId("x")}`, compartments };
  await queryAs(
    store.db.urls.admin,
    `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools)
     values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6)`,
    [client.id, name, sha256Hex(client.token), compartments, ["self", "people"], TOOLS],
  );
  return client;
}

function freshReader(store: TestStore, options?: { rejectWhen?: (text: string) => boolean }): Reader {
  return new Reader({
    pool: recordingPool(store.readerPool, options).pool,
    keys: store.db.keys,
    log: store.log,
    now: () => store.now,
  });
}

let requests = 0;
const recordArgs = (kind: AgentRecordArgs["kind"], body?: string): AgentRecordArgs => {
  requests += 1;
  return {
    kind,
    body: body ?? `a gate ${kind} ${requests}`,
    requestId: `gate-request-${requests.toString().padStart(6, "0")}`,
  };
};
const write = async (reader: Reader, client: Client, kind: AgentRecordArgs["kind"], body?: string): Promise<string> =>
  outcomeValue(await reader.record(client.token, recordArgs(kind, body))).recordId;
const bootstrap = (reader: Reader, client: Client) =>
  reader.buildContextPack(client.token, { purpose: "agent_bootstrap" });
const prep = (reader: Reader, client: Client, event: string) =>
  reader.buildContextPack(client.token, { purpose: "meeting_prep", event: EventId.parse(event) });
const records = (pack: ContextPack, section: string) =>
  pack.items.filter(
    (item): item is Extract<PackItem, { kind: "record" }> => item.kind === "record" && item.section === section,
  );

// Flags a finding as the pipeline would: as the table's owner, with row-level security lifted
// for the one statement.
async function flag(store: TestStore, id: string): Promise<void> {
  await session(store.db.urls.bootstrap, async (query) => {
    await query("set role pi_owner");
    await query("alter table ledger.agent_writes no force row level security");
    try {
      await query("update ledger.agent_writes set flagged_at = now() where id = $1", [id]);
    } finally {
      await query("alter table ledger.agent_writes force row level security");
    }
  });
}

describe("the pack's gate tests", { timeout: DB_TEST_TIMEOUT }, () => {
  it("in one database, at one clock, rows of employer:example written after the first packs change no byte of a pack for a client cleared for own", async () => {
    const store = await openStore({ now: NOW, compartments: COMPARTMENTS });
    try {
      const seed = storeSeeder(store.writer, NOW);
      // The employer account is connected first, so no re-derive runs between the two packs.
      const workMail = await store.writer.ensureSourceAccount(
        "work",
        "google_mail",
        "employer:example",
        ownerWork.address,
      );
      const workCalendar = await store.writer.ensureSourceAccount(
        "work",
        "google_calendar",
        "employer:example",
        ownerWork.address,
      );
      const ownMail = await store.writer.ensureSourceAccount("personal", "google_mail", "own", owner.address);
      const ownCalendar = await store.writer.ensureSourceAccount("personal", "google_calendar", "own", owner.address);
      await seed.mail(ownMail, {
        id: "k1-own-1",
        from: blake,
        to: [owner],
        at: daysFrom(NOW, -2),
        subject: "k1-own-1",
      });
      await seed.mail(ownMail, {
        id: "k1-own-2",
        from: owner,
        to: [blake, casey],
        at: daysFrom(NOW, -1),
        subject: "k1-own-2",
        sent: true,
      });
      await seed.event(ownCalendar, {
        id: "k1-own-meeting",
        title: "k1-own-meeting",
        start: daysFrom(NOW, 1),
        end: hoursFrom(daysFrom(NOW, 1), 1),
        organizer: owner,
        attendees: [blake, casey],
      });
      const own = await newClient(store, "g1", ["own"]);
      const both = await newClient(store, "g2", BOTH);
      const reader = freshReader(store);
      await write(reader, own, "handoff");
      await write(reader, own, "note");
      const event = await eventIdOf(store, "k1-own-meeting");
      const first = {
        bootstrap: JSON.stringify(outcomeValue(await bootstrap(reader, own))),
        prep: JSON.stringify(outcomeValue(await prep(reader, own, event))),
      };
      const bothFirst = JSON.stringify(outcomeValue(await bootstrap(reader, both)));

      // Messages, an event, a person known only there, and an agent record by the client cleared for both.
      await seed.mail(workMail, {
        id: "k1-work-1",
        from: blake,
        to: [ownerWork],
        at: daysFrom(NOW, -1.5),
        subject: "k1-work-1",
      });
      await seed.mail(workMail, {
        id: "k1-work-2",
        from: wren,
        to: [ownerWork],
        cc: [blake],
        at: hoursFrom(NOW, -3),
        subject: "k1-work-2",
      });
      await seed.mail(workMail, {
        id: "k1-work-3",
        from: ownerWork,
        to: [blake, wren],
        at: hoursFrom(NOW, -2),
        subject: "k1-work-3",
        sent: true,
      });
      await seed.event(workCalendar, {
        id: "k1-work-meeting",
        title: "k1-work-meeting",
        start: hoursFrom(NOW, 5),
        end: hoursFrom(NOW, 6),
        organizer: ownerWork,
        attendees: [blake, wren],
      });
      await seed.event(workCalendar, {
        id: "k1-work-past",
        title: "k1-work-past",
        start: hoursFrom(NOW, -30),
        end: hoursFrom(NOW, -29),
        organizer: ownerWork,
        attendees: [blake, casey],
      });
      await write(reader, both, "note");
      await write(reader, both, "handoff");

      expect(JSON.stringify(outcomeValue(await bootstrap(reader, own)))).toBe(first.bootstrap);
      expect(JSON.stringify(outcomeValue(await prep(reader, own, event)))).toBe(first.prep);
      // The positive control: the client cleared for both gets a different pack.
      expect(JSON.stringify(outcomeValue(await bootstrap(reader, both)))).not.toBe(bothFirst);
      const whole = outcomeValue(await prep(reader, both, event));
      expect(JSON.stringify(whole)).not.toBe(first.prep);
    } finally {
      await store.close();
    }
  });

  describe("on one store", () => {
    let store: TestStore;
    let seed: StoreSeeder;
    let ownMail: SourceAccountRow;
    let event: string;
    let reader: Reader;
    let next = 2;
    const name = (): string => {
      const one = AGENTS[next++];
      if (one === undefined) throw new Error("out of agent compartments");
      return one;
    };

    beforeAll(async () => {
      store = await openStore({ now: NOW, compartments: COMPARTMENTS });
      seed = storeSeeder(store.writer, NOW);
      ownMail = await store.writer.ensureSourceAccount("personal", "google_mail", "own", owner.address);
      const ownCalendar = await store.writer.ensureSourceAccount("personal", "google_calendar", "own", owner.address);
      await seed.mail(ownMail, {
        id: "gate-blake-1",
        from: blake,
        to: [owner],
        at: daysFrom(NOW, -2),
        subject: "gate-blake-1",
      });
      await seed.mail(ownMail, {
        id: "gate-blake-2",
        from: blake,
        to: [owner],
        at: daysFrom(NOW, -1),
        subject: "gate-blake-2",
      });
      await seed.mail(ownMail, {
        id: "gate-casey-1",
        from: casey,
        to: [owner],
        at: daysFrom(NOW, -4),
        subject: "gate-casey-1",
      });
      await seed.event(ownCalendar, {
        id: "gate-meeting",
        title: "gate-meeting",
        start: daysFrom(NOW, 1),
        end: hoursFrom(daysFrom(NOW, 1), 1),
        organizer: owner,
        attendees: [blake],
      });
      event = await eventIdOf(store, "gate-meeting");
      reader = freshReader(store);
    }, DB_TEST_TIMEOUT);

    afterAll(async () => {
      await store.close();
    });

    it("meeting_prep holds the event and every visible attendee; a hidden event and an absent one answer the same bytes", async () => {
      const own = await newClient(store, name(), ["own"]);
      const pack = outcomeValue(await prep(reader, own, event));
      expect(pack.items.filter((item) => item.section === "event").map((item) => item.id)).toEqual([event]);
      const participants = pack.items.find((item) => item.kind === "meeting");
      const attendees = pack.items.filter((item) => item.section === "attendees").map((item) => item.id);
      expect(attendees).toEqual(
        participants?.kind === "meeting" ? participants.meeting.participants.map((who) => who.id) : null,
      );
      expect(attendees.length).toBe(1);
      for (const item of pack.items.filter((one) => one.section === "event" || one.section === "attendees"))
        expect(item.required).toBe(true);
      // A hidden event: one under a compartment the client lacks.
      const workCalendar = await store.writer.ensureSourceAccount(
        "work",
        "google_calendar",
        "employer:example",
        ownerWork.address,
      );
      await seed.event(workCalendar, {
        id: "gate-hidden",
        title: "gate-hidden",
        start: daysFrom(NOW, 2),
        end: hoursFrom(daysFrom(NOW, 2), 1),
        organizer: ownerWork,
        attendees: [blake],
      });
      const hidden = await prep(reader, own, await eventIdOf(store, "gate-hidden"));
      const absent = await prep(reader, own, `evt_${"0".repeat(26)}`);
      expect(JSON.stringify(hidden)).toBe(JSON.stringify(absent));
      expect(hidden).toEqual({ ok: false, code: "not_found" });
    });

    it("the ledger.context_packs row's pack_fp is the keyed fingerprint of the returned hash, the plain hash is in no column, and a failed log returns no pack", async () => {
      const own = await newClient(store, name(), ["own"]);
      const pack = outcomeValue(await bootstrap(reader, own));
      const rows = await queryAs<{ pack_fp: string }>(
        store.db.urls.admin,
        "select pack_fp from ledger.context_packs where client_id = $1",
        [own.id],
      );
      expect(rows).toEqual([{ pack_fp: fingerprint(store.db.keys, "content_hash", pack.hash) }]);
      expect(rows[0]?.pack_fp).not.toBe(pack.hash);
      expect(await scanForPlaintext(store.db.urls.admin, [pack.hash])).toEqual([]);
      // A failed log: unavailable, and nothing of the pack anywhere.
      const failing = freshReader(store, { rejectWhen: (text) => LOG_PACK.test(text) });
      expect(await bootstrap(failing, own)).toEqual({ ok: false, code: "unavailable" });
      expect(
        await queryAs(store.db.urls.admin, "select id from ledger.context_packs where client_id = $1", [own.id]),
      ).toHaveLength(1);
    });

    it("the handoff section never shows another client's handoff, even one the caller is cleared for", async () => {
      const other = await newClient(store, name(), ["own"]);
      const caller = await newClient(store, name(), ["own", `agent:${other.name}`]);
      const theirs = await write(reader, other, "handoff");
      const theirNote = await write(reader, other, "note");
      const pack = outcomeValue(await bootstrap(reader, caller));
      expect(records(pack, "handoff")).toEqual([]);
      expect(pack.items.map((item) => item.id)).not.toContain(theirs);
      // The control: the caller may see the other's records, and sees its note; and its own handoff is shown.
      expect(records(pack, "notes").map((item) => item.id)).toEqual([theirNote]);
      const mine = await write(reader, caller, "handoff");
      expect(records(outcomeValue(await bootstrap(reader, caller)), "handoff").map((item) => item.id)).toEqual([mine]);
    });

    it("a handoff that was removed is shown as removed, with no body, and the handoff before it is not shown", async () => {
      const own = await newClient(store, name(), ["own"]);
      const older = await write(reader, own, "handoff");
      const latest = await write(reader, own, "handoff");
      expect(records(outcomeValue(await bootstrap(reader, own)), "handoff").map((item) => item.id)).toEqual([latest]);
      // Removed as the admin removes one: its body gone.
      await queryAs(store.db.urls.admin, "update ledger.agent_writes set body_enc = null where id = $1", [latest]);
      const [shown, ...rest] = records(outcomeValue(await bootstrap(reader, own)), "handoff");
      expect(rest).toEqual([]);
      expect(shown).toMatchObject({
        id: latest,
        required: true,
        provenance: "agent_reported",
        record: { id: latest, kind: "handoff", client: own.name, body: null, chars: 0, cut: false, removed: true },
      });
      expect(JSON.stringify(outcomeValue(await bootstrap(reader, own)))).not.toContain(older);
    });

    it("a finding with flagged_at set is in no pack of any client, and the pack is the same bytes as in a store without it", async () => {
      const writer = await newClient(store, name(), ["own"]);
      const caller = await newClient(store, name(), ["own", `agent:${writer.name}`]);
      await write(reader, writer, "note");
      const before = {
        writer: JSON.stringify(outcomeValue(await bootstrap(reader, writer))),
        caller: JSON.stringify(outcomeValue(await bootstrap(reader, caller))),
      };
      const finding = await write(reader, writer, "finding");
      // The positive control: before it is flagged, both see it.
      expect(JSON.stringify(outcomeValue(await bootstrap(reader, writer)))).toContain(finding);
      expect(JSON.stringify(outcomeValue(await bootstrap(reader, caller)))).toContain(finding);
      await flag(store, finding);
      expect(JSON.stringify(outcomeValue(await bootstrap(reader, writer)))).toBe(before.writer);
      expect(JSON.stringify(outcomeValue(await bootstrap(reader, caller)))).toBe(before.caller);
    });

    it("a held message is in no pack: with a held message stored that an attendee is on, meeting_prep is the same bytes, hash included; after Admin.releaseHeld it is there", async () => {
      const own = await newClient(store, name(), ["own"]);
      const before = JSON.stringify(outcomeValue(await prep(reader, own, event)));
      // From Casey, who is no attendee, to the owner with Blake, who is, on copy: so it has an
      // interaction row for Blake, and Blake's counts and last time do not move (a co-recipient
      // row is counted in neither direction, and it is older than Blake's latest).
      const fixture = mail({
        id: "gate-held",
        threadId: "thread-gate-held",
        at: iso(hoursFrom(NOW, -36)),
        from: casey,
        to: [owner],
        cc: [blake],
        subject: "Your one-time code",
        labels: ["INBOX"],
        held: true,
        text: "Your code is 000000.",
      });
      const raw: RawItem = mailItem(fixture, ownMail);
      expect(await store.writer.ingestItem(ownMail, raw, mailFacts(fixture))).toBe("stored");
      const [row] = await queryAs<{ id: string; held: boolean }>(
        store.db.urls.admin,
        "select m.id, m.held from knowledge.messages m join knowledge.interaction_log i on i.evidence_id = m.evidence_id where m.held order by m.id",
      );
      expect(row?.held).toBe(true);
      expect(JSON.stringify(outcomeValue(await prep(reader, own, event)))).toBe(before);
      // The positive control: released, it is among the recent messages.
      expect(await store.admin.held.releaseHeld({ id: row?.id as never })).toEqual({ released: 1 });
      const after = outcomeValue(await prep(reader, own, event));
      expect(after.items.filter((item) => item.kind === "message").map((item) => item.id)).toContain(row?.id);
    });

    it("a held message from an attendee moves that attendee's inbound and lastAt as get_entity's do, and is no item and no read log entry; after release it is an item", async () => {
      const own = await newClient(store, name(), ["own"]);
      const unheld = outcomeValue(await prep(reader, own, event));
      const fixture = mail({
        id: "gate-held-attendee",
        threadId: "thread-gate-held-attendee",
        at: iso(hoursFrom(NOW, -1)),
        from: blake,
        to: [owner],
        subject: "Your one-time code",
        labels: ["INBOX"],
        held: true,
        text: "Your code is 111111.",
      });
      expect(await store.writer.ingestItem(ownMail, mailItem(fixture, ownMail), mailFacts(fixture))).toBe("stored");
      const [row] = await queryAs<{ id: string }>(
        store.db.urls.admin,
        "select m.id from knowledge.messages m where m.held order by m.id",
      );
      expect(row?.id).toBeDefined();
      const held = outcomeValue(await prep(reader, own, event));
      const attendeeOf = (pack: ContextPack): AttendeeBrief => {
        const found = pack.items.find(
          (item): item is Extract<PackItem, { kind: "attendee" }> =>
            item.kind === "attendee" && item.attendee.who.name?.untrusted === blake.name,
        );
        if (found === undefined) throw new Error("no attendee item for the held sender");
        return found.attendee;
      };
      const [was, is] = [attendeeOf(unheld), attendeeOf(held)];
      expect(is.inbound).toBe(was.inbound + 1);
      expect(is.lastAt).not.toBe(was.lastAt);
      // The packs differ in that attendee's two fields and nothing else but the hash.
      const strip = (pack: ContextPack): unknown => ({
        ...pack,
        hash: null,
        items: pack.items.map((item) =>
          item.kind === "attendee" && item.attendee.who.name?.untrusted === blake.name
            ? { ...item, attendee: { ...item.attendee, inbound: 0, lastAt: null } }
            : item,
        ),
      });
      expect(strip(held)).toEqual(strip(unheld));
      expect(held.items.some((item) => item.id === row?.id)).toBe(false);
      const logged = await queryAs<{ id: string }>(
        store.db.urls.admin,
        "select unnest(shown) as id from ledger.read_log where client_id = $1",
        [own.id],
      );
      expect(logged.map((one) => one.id)).not.toContain(row?.id);
      // Released, it is an item.
      expect(await store.admin.held.releaseHeld({ id: row?.id as never })).toEqual({ released: 1 });
      expect(
        outcomeValue(await prep(reader, own, event))
          .items.filter((item) => item.kind === "message")
          .map((item) => item.id),
      ).toContain(row?.id);
    });
  });
});
