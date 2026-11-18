import { Timestamp } from "@intelligence/contracts";
import {
  type CardId,
  type EntityId,
  type MacContactItem,
  type RulingId,
  SourceAccountId,
} from "@intelligence/contracts/personal";
import { PERSONAL_LIMITS } from "@intelligence/personal-core";
import { deriveItem, macContactItem } from "@intelligence/personal-core/items";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { OWNER } from "../test-support/cast.ts";
import { testId } from "../test-support/clients.ts";
import { session, sqlState } from "../test-support/connections.ts";
import { fingerprint, queryAs } from "../test-support/database.ts";
import { type IdentityWorld, inIdentityWorld, req } from "../test-support/identity-fixtures.ts";
import { mail } from "../test-support/items.ts";
import { seeder } from "../test-support/seeder.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { localPartNames } from "./identity-bases.ts";

// Same-person pairs merged by the owner's standing rule through ledger.policy_merge, off until the owner's
// switch, and the exceptions that still card a pair. Made-up values on reserved domains only.

const NOW = new Date("2026-09-15T12:00:00Z");
let tick = 0;
const later = (): Date => new Date(NOW.getTime() + (tick += 1) * 60_000);
const sweep = (world: IdentityWorld) => world.admin.identity.proposeIdentity({ now: later() });
const on = (world: IdentityWorld) => world.admin.identity.setIdentityMerges("on");

let n = 0;
// Inbound mail from an address under a display name: an interaction and an alias.
async function wrote(
  world: IdentityWorld,
  address: string,
  name: string,
  account = world.accounts.personalMail,
): Promise<void> {
  n += 1;
  const to = account === world.accounts.workMail ? OWNER.work : OWNER.personal;
  await world.mail(
    mail({
      id: `gm-ip-${n}`,
      threadId: `thread-ip-${n}`,
      at: "2026-09-02T10:00:00Z" as Timestamp,
      from: { address, name },
      to: [{ address: to }],
      subject: "Hello",
      labels: ["INBOX"],
    }),
    account,
  );
}
// Mail the owner sent to an address: the person is established under that account's label.
async function sentTo(world: IdentityWorld, address: string, account = world.accounts.personalMail): Promise<void> {
  n += 1;
  const from = account === world.accounts.workMail ? OWNER.work : OWNER.personal;
  await world.mail(
    mail({
      id: `gm-ip-${n}`,
      threadId: `thread-ip-${n}`,
      at: "2026-09-03T10:00:00Z" as Timestamp,
      from: { address: from, name: OWNER.name },
      to: [{ address }],
      subject: "Re: Hello",
      labels: ["SENT"],
    }),
    account,
  );
}
// A pair sharing a full name, each written to by the owner unless `strangers`.
async function namePair(
  world: IdentityWorld,
  a: string,
  b: string,
  name: string,
  options: { strangers?: boolean } = {},
): Promise<[EntityId, EntityId]> {
  await wrote(world, a, name);
  await wrote(world, b, name);
  if (options.strangers !== true) {
    await sentTo(world, a);
    await sentTo(world, b);
  }
  return [await world.person(a), await world.person(b)];
}

const policyRulings = (world: IdentityWorld) =>
  world.sql<{ ruling_id: string; verdict: string; basis: string; lifted: boolean }>(
    `select r.ruling_id, r.verdict, d.details ->> 'basis' as basis, r.lifted_at is not null as lifted
     from knowledge.identity_rulings r join knowledge.owner_decisions d on d.id = r.ruling_id where d.kind = 'identity_policy' order by r.created_at`,
  );
const openCards = (world: IdentityWorld) =>
  world.sql<{ id: CardId; kind: string }>(
    `select c.id, c.kind from ledger.cards c where c.created_by = 'system:identity'
       and (select r.event from ledger.record_events r where r.row_kind = 'card' and r.row_id = c.id order by r.id desc limit 1) in ('pending', 'deferred') order by c.id`,
  );
const merge = async (
  world: IdentityWorld,
  a: string,
  b: string,
  basis: string,
  nameFp: string | null,
  requestId = testId("req").slice(4),
  url = world.db.urls.writer,
) =>
  (
    await queryAs<{ code: string; ruling: string | null }>(
      url,
      "select code, ruling from ledger.policy_merge($1, $2, $3, $4, $5)",
      [a, b, basis, nameFp, requestId],
    )
  )[0];
// The name fingerprint a person's alias of that name carries, as the database holds it.
const fingerprintName = (world: IdentityWorld, name: string): string => fingerprint(world.db.keys, "name", name);
// A statement as the table's owner with its row-level security set aside, as a test's stand-in for
// what no runtime role can write.
async function asOwnerOf(world: IdentityWorld, tables: string[], sql: string, values: unknown[] = []): Promise<void> {
  await session(world.db.urls.bootstrap, async (query) => {
    await query("set role pi_owner");
    for (const table of tables) await query(`alter table ${table} no force row level security`);
    try {
      await query(sql, values);
    } finally {
      for (const table of tables) await query(`alter table ${table} force row level security`);
    }
  });
}

const writes = async (world: IdentityWorld) => ({
  decisions: await world.count("knowledge.owner_decisions"),
  rulings: await world.count("knowledge.identity_rulings"),
  events: await world.count("ledger.record_events"),
  cards: await world.count("ledger.cards"),
});

describe("identity merges: the switch", { timeout: DB_TEST_TIMEOUT }, () => {
  it("off at deploy: the same pairs are carded and nothing is merged, the sweep's counts as before", () =>
    inIdentityWorld(async (world) => {
      await namePair(world, "tam@ip-one.test", "rusk@ip-two.test", "Tam Rusk");
      // The sweep also reports the dream pass's merges, none here.
      expect(await sweep(world)).toMatchObject({ candidates: 1, raised: 1, skipped: 0, dream: { merged: 0 } });
      expect(await policyRulings(world)).toEqual([]);
      const [a, b] = [await world.person("tam@ip-one.test"), await world.person("rusk@ip-two.test")];
      expect((await merge(world, a, b, "name", fingerprintName(world, "Tam Rusk")))?.code).toBe("merges_off");
    }));

  it("on: each basis merges a fresh pair with no card, writing an identity_policy decision and a same ruling, and withdraws a pending card on the pair", () =>
    inIdentityWorld(async (world) => {
      // Name: carded first, while the switch is off.
      await namePair(world, "tam@ip-one.test", "rusk@ip-two.test", "Tam Rusk");
      await sweep(world);
      const [pending] = await openCards(world);
      // Local part: ilse.varro@ spells the name the other carries.
      await wrote(world, "ix@ip-name.test", "Ilse Varro");
      await wrote(world, "ilse.varro@ip-dot.test", "IV");
      await sentTo(world, "ix@ip-name.test");
      await sentTo(world, "ilse.varro@ip-dot.test");
      // Contact: one stored contact lists both addresses; neither person need be established.
      await world.save(world.accounts.personalContacts, "c-lia", {
        names: ["Lia Moss"],
        emails: ["lia@ip-home.test", "moss@ip-office.test"],
      });
      await on(world);
      const counts = await sweep(world);
      expect(counts.settled?.merged).toBe(3);
      expect((await policyRulings(world)).map((one) => [one.verdict, one.basis]).sort()).toEqual([
        ["same", "contact"],
        ["same", "local_part"],
        ["same", "name"],
      ]);
      expect(await openCards(world)).toEqual([]);
      expect(
        await world.sql(
          "select event from ledger.record_events where row_kind = 'card' and row_id = $1 order by id desc limit 1",
          [pending?.id],
        ),
      ).toEqual([{ event: "withdrawn" }]);
      // The merge is a ruling, listed as the policy's.
      const listed = await world.admin.identity.listIdentity({ policy: { lifted: false } });
      expect(listed.map((one) => one.by)).toEqual(["policy", "policy", "policy"]);
      expect(listed.every((one) => one.basis !== undefined)).toBe(true);
      // No verdict for any learner (rankVerdict reads only the owner's answers on a card).
      expect(await world.count("ledger.point_verdicts")).toBe(0);
    }));

  it("the writer's sweep merges as pi identity sweep does, through the function alone", () =>
    inIdentityWorld(async (world) => {
      await namePair(world, "tam@ip-one.test", "rusk@ip-two.test", "Tam Rusk");
      await on(world);
      const writer = world.store.writer;
      const counts = await writer.withSyncLock(() => writer.proposeIdentity(later()));
      expect(counts).toMatchObject({ candidates: 1, raised: 0 });
      expect(await policyRulings(world)).toHaveLength(1);
    }));

  it("pi identity sweep --dry-run writes nothing, whatever the switch says, and lists what would merge and be carded", () =>
    inIdentityWorld(async (world) => {
      await namePair(world, "tam@ip-one.test", "rusk@ip-two.test", "Tam Rusk");
      await namePair(world, "vex@ip-one.test", "vex@ip-two.test", "Vex Arlo", { strangers: true });
      const before = await writes(world);
      const run = await world.admin.identity.dryRunIdentity();
      expect(run.merge).toEqual({ contact: 0, phone: 0, name: 1, local_part: 0 });
      expect(run.card.unestablished).toBe(1);
      expect(run.pairs).toHaveLength(2);
      await on(world);
      expect((await world.admin.identity.dryRunIdentity()).merge.name).toBe(1);
      expect(await writes(world)).toEqual(before);
    }));
});

describe("identity merges: the owner's exceptions stand (invariant 11)", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a pair touching a different ruling is carded, not merged, and a pair whose same the owner lifted is carded too", () =>
    inIdentityWorld(async (world) => {
      const [a, b] = await namePair(world, "tam@ip-one.test", "rusk@ip-two.test", "Tam Rusk");
      await wrote(world, "zed@ip-three.test", "Zed Other");
      const z = await world.person("zed@ip-three.test");
      await world.admin.identity.linkPeople(a, z, "different", { requestId: req() });
      const [c, d] = await namePair(world, "ora@ip-one.test", "lund@ip-two.test", "Ora Lund");
      // A pair no exception holds, so the sweep asks the function and reports its counts.
      await namePair(world, "kit@ip-one.test", "kit@ip-two.test", "Kit Vane");
      const same = await world.admin.identity.linkPeople(c, d, "same", { requestId: req() });
      await world.admin.identity.liftIdentity(same, { requestId: req() });
      await on(world);
      const counts = await sweep(world);
      expect(counts.settled?.carded).toMatchObject({ ruled_different: 1, lifted_before: 1 });
      expect((await policyRulings(world)).map((one) => one.basis)).toEqual(["name"]);
      expect((await merge(world, a, b, "name", fingerprintName(world, "Tam Rusk")))?.code).toBe("excepted");
      expect((await merge(world, c, d, "name", fingerprintName(world, "Ora Lund")))?.code).toBe("excepted");
    }));

  it("pi identity lift splits a policy merge, and the next sweep cards the pair", () =>
    inIdentityWorld(async (world) => {
      await namePair(world, "tam@ip-one.test", "rusk@ip-two.test", "Tam Rusk");
      await on(world);
      await sweep(world);
      const [merged] = await policyRulings(world);
      expect(await world.admin.identity.liftIdentity(merged?.ruling_id as RulingId, { requestId: req() })).toBe(true);
      const counts = await sweep(world);
      expect(counts).toMatchObject({ raised: 1 });
      expect(counts.settled === undefined || counts.settled.merged === 0).toBe(true);
      expect((await policyRulings(world)).map((one) => one.lifted)).toEqual([true]);
      expect((await openCards(world)).map((one) => one.kind)).toEqual(["same_person"]);
    }));

  it("an owner different committed while a merge waits on identity:rulings makes the function refuse and write nothing", () =>
    inIdentityWorld(async (world) => {
      const [a, b] = await namePair(world, "tam@ip-one.test", "rusk@ip-two.test", "Tam Rusk");
      await on(world);
      const [fa, fb] = [world.fp("tam@ip-one.test"), world.fp("rusk@ip-two.test")].sort();
      const client = new pg.Client({ connectionString: world.db.urls.admin });
      await client.connect();
      try {
        await client.query("begin");
        await client.query("select ledger.lock_rows($1)", [["identity:rulings"]]);
        const id = testId("rul");
        await client.query(
          "insert into knowledge.owner_decisions (id, request_id, kind, answer, queue_depth, decided_at, compartments) values ($1, $2, 'identity', 'different', 0, now(), '{own}')",
          [id, `req-${id.slice(4)}`],
        );
        await client.query(
          "insert into knowledge.identity_rulings (ruling_id, verdict, a_fp, b_fp, created_at) values ($1, 'different', $2, $3, now())",
          [id, fa, fb],
        );
        const waiting = merge(world, a, b, "name", fingerprintName(world, "Tam Rusk"));
        await new Promise((resolve) => setTimeout(resolve, 300));
        await client.query("commit");
        expect((await waiting)?.code).toBe("excepted");
      } finally {
        await client.end();
      }
      expect(await policyRulings(world)).toEqual([]);
    }));

  it("a role mark committed while a merge waits makes it refuse not_a_person", () =>
    inIdentityWorld(async (world) => {
      const [a, b] = await namePair(world, "tam@ip-one.test", "rusk@ip-two.test", "Tam Rusk");
      await on(world);
      const client = new pg.Client({ connectionString: world.db.urls.admin });
      await client.connect();
      try {
        await client.query("begin");
        await client.query("select ledger.lock_rows($1)", [["identity:rulings"]]);
        const id = testId("rul");
        await client.query(
          "insert into knowledge.owner_decisions (id, request_id, kind, answer, queue_depth, decided_at, compartments) values ($1, $2, 'identity', 'role', 0, now(), '{own}')",
          [id, `req-${id.slice(4)}`],
        );
        await client.query(
          "insert into knowledge.identity_rulings (ruling_id, verdict, a_fp, created_at) values ($1, 'role', $2, now())",
          [id, world.fp("tam@ip-one.test")],
        );
        const waiting = merge(world, a, b, "name", fingerprintName(world, "Tam Rusk"));
        await new Promise((resolve) => setTimeout(resolve, 300));
        await client.query("commit");
        expect((await waiting)?.code).toBe("not_a_person");
      } finally {
        await client.end();
      }
    }));
});

describe("identity merges: names and strangers", { timeout: DB_TEST_TIMEOUT }, () => {
  // Records are not people. One person held at three addresses merges; a name is
  // shared only once the owner's different (or a same the owner lifted) sets two of its holders apart.
  it("one person's three records under one full name merge, with no card; the function merges each pair", () =>
    inIdentityWorld(async (world) => {
      await namePair(world, "pia@ip-one.test", "lund@ip-two.test", "Pia Lund");
      await wrote(world, "pia@ip-three.test", "Pia Lund");
      await sentTo(world, "pia@ip-three.test");
      await on(world);
      const counts = await sweep(world);
      expect(counts.settled?.carded.common_name ?? 0).toBe(0);
      expect((await policyRulings(world)).map((one) => one.basis)).toEqual(["name", "name"]);
      expect(await openCards(world)).toEqual([]);
    }));

  it("a name two of whose holders the owner ruled different is carded for its other pairs, and the function refuses them", () =>
    inIdentityWorld(async (world) => {
      const [x, y] = await namePair(world, "pia@ip-one.test", "lund@ip-two.test", "Pia Lund");
      await world.admin.identity.linkPeople(x, y, "different", { requestId: req() });
      const [a, b] = await namePair(world, "pia@ip-three.test", "pl@ip-four.test", "Pia Lund");
      // A pair no exception holds, so the sweep asks the function and reports its counts.
      await namePair(world, "kit@ip-one.test", "kit@ip-two.test", "Kit Vane");
      await on(world);
      expect((await merge(world, a, b, "name", fingerprintName(world, "Pia Lund")))?.code).toBe("excepted");
      expect((await sweep(world)).settled?.carded.common_name).toBeGreaterThan(0);
      expect((await policyRulings(world)).map((one) => one.basis)).toEqual(["name"]);
    }));

  it("a same the owner lifted between two holders of a name sets them apart: its other pairs are carded, and the function refuses them", () =>
    inIdentityWorld(async (world) => {
      const [x, y] = await namePair(world, "pia@ip-one.test", "lund@ip-two.test", "Pia Lund");
      const same = await world.admin.identity.linkPeople(x, y, "same", { requestId: req() });
      await world.admin.identity.liftIdentity(same, { requestId: req() });
      const [a, b] = await namePair(world, "pia@ip-three.test", "pl@ip-four.test", "Pia Lund");
      await on(world);
      expect((await merge(world, a, b, "name", fingerprintName(world, "Pia Lund")))?.code).toBe("excepted");
    }));

  it("invariant 6: a namesake whose alias is under a compartment outside the pair's labels changes nothing the pair's viewers see", () =>
    inIdentityWorld(async (world) => {
      const [a, b] = await namePair(world, "pia@ip-one.test", "lund@ip-two.test", "Pia Lund");
      await wrote(world, "pia@ip-work.test", "Pia Lund", world.accounts.workMail);
      await on(world);
      expect((await merge(world, a, b, "name", fingerprintName(world, "Pia Lund")))?.code).toBe("merged");
    }));

  it("invariant 6: a sent mail outside the pair's labels neither establishes a person nor stops a merge", () =>
    inIdentityWorld(async (world) => {
      const [a, b] = await namePair(world, "pia@ip-one.test", "lund@ip-two.test", "Pia Lund", { strangers: true });
      await on(world);
      const asked = () => merge(world, a, b, "name", fingerprintName(world, "Pia Lund"));
      expect((await asked())?.code).toBe("not_established");
      await sentTo(world, "pia@ip-one.test", world.accounts.workMail);
      await sentTo(world, "lund@ip-two.test", world.accounts.workMail);
      expect((await asked())?.code).toBe("not_established");
    }));

  it("a stranger whose display name or local part copies a stored contact's name, never written to, is carded, not merged; the contact basis merges whatever the history", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "c-vera", {
        names: ["Vera Holt"],
        emails: ["vera@ip-home.test"],
      });
      await wrote(world, "vh@ip-stranger.test", "Vera Holt");
      await wrote(world, "vera.holt@ip-stranger2.test", "VH");
      await on(world);
      const counts = await sweep(world);
      expect(counts.settled?.merged ?? 0).toBe(0);
      expect(counts.settled?.carded.unestablished ?? counts.raised).toBeGreaterThan(0);
      expect(await policyRulings(world)).toEqual([]);
    }));

  it("a shared address is carded as shared_address, never merged", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "c-ana", {
        names: ["Ana Bell"],
        emails: ["desk@ip-shared.test"],
      });
      await world.save(world.accounts.personalContacts, "c-ben", {
        names: ["Ben Cole"],
        emails: ["desk@ip-shared.test"],
      });
      await on(world);
      await sweep(world);
      expect((await openCards(world)).map((one) => one.kind)).toEqual(["shared_address"]);
      expect(await policyRulings(world)).toEqual([]);
    }));
});

// A Mac contact counts as any saved contact for merging: a contact basis, a name basis's alias, and
// it establishes the person it lists.
describe("identity merges: Mac contacts count as contacts", { timeout: DB_TEST_TIMEOUT }, () => {
  async function macSaved(
    world: IdentityWorld,
    item: Omit<MacContactItem, "kind" | "revision" | "phones"> & { phones?: string[] },
  ): Promise<void> {
    const [found] = await world.sql<{ id: string }>(
      "select id from vault.source_accounts where connector = 'lens_contacts'",
    );
    let id = found?.id;
    if (id === undefined) {
      id = testId("acc");
      await queryAs(
        world.db.urls.admin,
        "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, 'device:mac', 'lens_contacts', 'crm', '{own}')",
        [id],
      );
    }
    const account = {
      id: SourceAccountId.parse(id),
      label: "device:mac",
      connector: "lens_contacts" as const,
      sourceKind: "crm" as const,
      compartment: "own",
    };
    const raw = macContactItem(
      { kind: "contact", revision: 0, phones: [], ...item },
      { sourceAccount: account.id, now: Timestamp.parse(NOW.toISOString()) },
    );
    expect(await world.store.writer.ingestItem(account, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS))).toBe(
      "stored",
    );
  }

  it("a Mac contact listing two people's addresses merges on the contact basis; two people sharing a full name only through Mac contacts, never written to, merge on the name basis", () =>
    inIdentityWorld(async (world) => {
      await wrote(world, "noa@ip-mac-one.test", "N");
      await wrote(world, "noa.b@ip-mac-two.test", "NB");
      await macSaved(world, {
        key: "contact:01JMACCZDENT00000000000001",
        name: "Noa Bright",
        emails: ["noa.b@ip-mac-two.test", "noa@ip-mac-one.test"],
      });
      // Established by the Mac contacts alone: the owner never wrote to either.
      await wrote(world, "kai@ip-mac-three.test", "K");
      await wrote(world, "dune@ip-mac-four.test", "D");
      await macSaved(world, {
        key: "contact:01JMACCZDENT00000000000002",
        name: "Kai Dune",
        emails: ["kai@ip-mac-three.test"],
      });
      await macSaved(world, {
        key: "contact:01JMACCZDENT00000000000003",
        name: "Kai Dune",
        emails: ["dune@ip-mac-four.test"],
      });
      await on(world);
      // The function itself, asked directly before the sweep: both bases merge.
      const [noa, noaB] = [await world.person("noa@ip-mac-one.test"), await world.person("noa.b@ip-mac-two.test")];
      expect((await merge(world, noa, noaB, "contact", null))?.code).toBe("merged");
      const [kai, dune] = [await world.person("kai@ip-mac-three.test"), await world.person("dune@ip-mac-four.test")];
      expect((await merge(world, kai, dune, "name", fingerprintName(world, "Kai Dune")))?.code).toBe("merged");
      expect((await policyRulings(world)).map((one) => one.basis)).toEqual(["contact", "name"]);
      expect(await openCards(world)).toEqual([]);
    }));

  it("the sweep merges a Mac-contact pair it would once have carded", () =>
    inIdentityWorld(async (world) => {
      await wrote(world, "kai@ip-mac-three.test", "K");
      await wrote(world, "dune@ip-mac-four.test", "D");
      await macSaved(world, {
        key: "contact:01JMACCZDENT00000000000002",
        name: "Kai Dune",
        emails: ["kai@ip-mac-three.test"],
      });
      await macSaved(world, {
        key: "contact:01JMACCZDENT00000000000003",
        name: "Kai Dune",
        emails: ["dune@ip-mac-four.test"],
      });
      await on(world);
      expect((await sweep(world)).settled).toMatchObject({ merged: 1 });
      expect(await openCards(world)).toEqual([]);
    }));
});

describe("identity merges: the cap", { timeout: DB_TEST_TIMEOUT }, () => {
  it("with ten same_person cards open, a pair no exception holds still merges, and an excepted pair is not carded", () =>
    inIdentityWorld(async (world) => {
      for (let i = 0; i < 11; i += 1)
        await namePair(
          world,
          `x${i}@ip-left.test`,
          `y${i}@ip-right.test`,
          `Pair ${"abcdefghijk"[i]}${"abcdefghijk"[i]}son`,
          { strangers: true },
        );
      await namePair(world, "tam@ip-one.test", "rusk@ip-two.test", "Tam Rusk");
      await on(world);
      const counts = await sweep(world);
      expect(counts.raised).toBe(10);
      expect(counts.settled?.merged).toBe(1);
      expect(counts.settled?.carded.unestablished).toBe(11);
      expect((await openCards(world)).length).toBe(10);
    }));
});

describe("ledger.policy_merge: the compromised writer", { timeout: DB_TEST_TIMEOUT }, () => {
  it("refuses, writing nothing and returning its code, every forged pair; replays a committed merge; and the writer gains no other right", () =>
    inIdentityWorld(async (world) => {
      const [a, b] = await namePair(world, "tam@ip-one.test", "rusk@ip-two.test", "Tam Rusk");
      const [s1, s2] = await namePair(world, "sam@ip-one.test", "sam@ip-two.test", "Sam Quill", { strangers: true });
      await wrote(world, "lone@ip-one.test", "Lone Wolf");
      await wrote(world, "other@ip-two.test", "Other Person");
      const [l, o] = [await world.person("lone@ip-one.test"), await world.person("other@ip-two.test")];
      const tam = fingerprintName(world, "Tam Rusk");
      expect((await merge(world, a, b, "name", tam))?.code).toBe("merges_off");
      await on(world);
      const before = await writes(world);
      expect((await merge(world, l, o, "contact", null))?.code).toBe("basis_absent");
      expect((await merge(world, l, o, "name", tam))?.code).toBe("basis_absent");
      expect((await merge(world, l, o, "local_part", tam))?.code).toBe("basis_absent");
      expect((await merge(world, s1, s2, "name", fingerprintName(world, "Sam Quill")))?.code).toBe("not_established");
      expect((await merge(world, a, b, "guess", tam))?.code).toBe("basis_absent");
      expect(await writes(world)).toEqual(before);

      // The owner's address, and a suppressed one, as the database holds them.
      const [owner] = await world.sql<{ id: string }>("select id from knowledge.entities where kind = 'owner'");
      const owned = testId("adr");
      await asOwnerOf(
        world,
        ["knowledge.accounts"],
        `insert into knowledge.accounts (id, entity_id, kind, value_fp, domain_fp, value_enc, compartments)
         select $1, $2, 'email', value_fp, domain_fp, value_enc, '{employer:example}' from knowledge.accounts where entity_id = $3 limit 1`,
        [owned, owner?.id, a],
      );
      expect((await merge(world, a, b, "name", tam))?.code).toBe("owner_address");
      await asOwnerOf(world, ["knowledge.accounts"], "delete from knowledge.accounts where id = $1", [owned]);
      const ruling = testId("rul");
      const erasure = testId("ers");
      const suppression = testId("sup");
      await queryAs(
        world.db.urls.admin,
        "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, decided_at, compartments) values ($1, $2, 'erase', 0, now(), '{own}')",
        [ruling, `req-${ruling.slice(4)}`],
      );
      await asOwnerOf(
        world,
        ["knowledge.erasures"],
        "insert into knowledge.erasures (id, ruling_id, kind, journal_seq, erased_at, items, suppressed, tainted_rows, compartments) values ($1, $2, 'person', 999, now(), 0, 1, 0, '{own}')",
        [erasure, ruling],
      );
      await asOwnerOf(
        world,
        ["knowledge.suppressions"],
        "insert into knowledge.suppressions (id, erasure_id, kind, value_fp, added_at, compartments) values ($1, $2, 'address', $3, now(), '{own}')",
        [suppression, erasure, world.fp("rusk@ip-two.test")],
      );
      expect((await merge(world, a, b, "name", tam))?.code).toBe("suppressed");
      await asOwnerOf(world, ["knowledge.suppressions"], "delete from knowledge.suppressions where id = $1", [
        suppression,
      ]);

      // A merge, then its replay, then the same pair again under another request id.
      const request = testId("req").slice(4);
      const first = await merge(world, a, b, "name", tam, request);
      expect(first?.code).toBe("merged");
      const count = await writes(world);
      expect(await merge(world, a, b, "name", tam, request)).toEqual(first);
      expect((await merge(world, a, b, "name", tam))?.code).toBe("already_settled");
      expect(await writes(world)).toEqual(count);

      // The writer holds no insert on decisions or rulings, and no event but a card's first.
      const as = (sql: string, values: unknown[] = []) => sqlState(() => queryAs(world.db.urls.writer, sql, values));
      const id = testId("rul");
      expect(
        await as(
          "insert into knowledge.owner_decisions (id, request_id, kind, answer, queue_depth, decided_at, compartments) values ($1, $2, 'identity_policy', 'same', 0, now(), '{own}')",
          [id, `req-${id.slice(4)}`],
        ),
      ).toBe("42501");
      expect(
        await as(
          "insert into knowledge.identity_rulings (ruling_id, verdict, a_fp, b_fp, created_at) values ($1, 'same', $2, $3, now())",
          [first?.ruling, "a".repeat(64), "b".repeat(64)],
        ),
      ).toBe("42501");
      const card = await session(world.db.urls.admin, (query) => seeder(world.db, query).into("ledger.cards")(["own"]));
      expect(
        await as(
          "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'withdrawn', now(), 'system:identity', '{own}')",
          [card],
        ),
      ).toBe("42501");
    }));

  it("pi identity local-names-backfill fills local_name_fps only where null, and a second run changes nothing", () =>
    inIdentityWorld(async (world) => {
      await wrote(world, "ilse.varro@ip-dot.test", "IV");
      await queryAs(world.db.urls.writer, "update knowledge.accounts set local_name_fps = null");
      const writer = world.store.writer;
      const first = await writer.withSyncLock(() => writer.backfillLocalNames());
      expect(first).not.toBe("already_running");
      expect((first as { filled: number }).filled).toBeGreaterThan(0);
      const [row] = await world.sql<{ local_name_fps: string[] }>(
        "select local_name_fps from knowledge.accounts where value_fp = $1",
        [world.fp("ilse.varro@ip-dot.test")],
      );
      expect(row?.local_name_fps).toEqual(
        localPartNames("ilse.varro@ip-dot.test")
          .map((name) => fingerprintName(world, name))
          .sort(),
      );
      expect(await writer.withSyncLock(() => writer.backfillLocalNames())).toEqual({ filled: 0 });
    }));
});
