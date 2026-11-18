import type { ClaimRecord, EntityId, MirrorPage, SyncMirrorArgs } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_TOOLS } from "../admin/clients/admin-clients.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { Reader } from "../read/read.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { one, readAs, session } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { type IdentityWorld, inIdentityWorld, MAIL, req } from "../test-support/identity-fixtures.ts";
import type { MailFixture } from "../test-support/items.ts";
import { batchOf, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { registration } from "../test-support/values.ts";

// Mirror rules, one test each, on the contacts-and-identity world (identity-fixtures.ts), with a
// Lens device registered by addDevice and its mirror read through Reader.syncMirror. Made-up values
// on reserved domains only.

const TIMEOUT = 180_000;
const T1 = "lens_mirror@1";
const VIEWS = ["self", "people", "work"] as const;
const SAM = ["sam@mirror-fixes.test", "sam.orrin@mirror-fixes.example"];

type Device = { id: string; token: string };
type Row = {
  id: string;
  entry_key: string;
  section: string;
  entity_ids: string[];
  evidence_ids: string[];
  compartments: string[];
  tainted_at: Date | null;
  ended_at: Date | null;
  reason: string | null;
};

const value = <T>(outcome: { ok: boolean; value?: T }): T => {
  if (!outcome.ok || outcome.value === undefined) throw new Error(`refused: ${JSON.stringify(outcome)}`);
  return outcome.value;
};

async function device(world: IdentityWorld, name: string): Promise<Device> {
  await world.admin.lens.addDevice(name, { compartments: ["own"], views: [...VIEWS] });
  // The mirror's first token is the first rotation's.
  const tokens = { mirror: await world.admin.lens.rotateDevice(name, "mirror") };
  const [client] = await world.sql<{ id: string }>("select id from policy.clients where name = $1", [name]);
  if (client === undefined) throw new Error("no mirror client");
  return { id: client.id, token: tokens.mirror };
}

const call = async (world: IdentityWorld, token: string, cursor: string | null): Promise<MirrorPage> =>
  value(await world.store.reader.syncMirror(token, { templates: [T1], cursor: cursor as SyncMirrorArgs["cursor"] }));

// One whole pass from `cursor`, every page.
async function pass(world: IdentityWorld, token: string, cursor: string | null = null): Promise<MirrorPage[]> {
  const pages: MirrorPage[] = [];
  let next = cursor;
  // Each call makes progress, as little as one row on a slow machine: this only stops a pass that never ends.
  for (let n = 0; n < 2_000; n += 1) {
    const page = await call(world, token, next);
    pages.push(page);
    next = page.cursor;
    if (page.passComplete && !page.more) return pages;
  }
  throw new Error("the pass did not complete");
}

const mailFrom = (address: string, id: string): MailFixture => ({
  ...MAIL.solo,
  id,
  threadId: `thread-${id}`,
  messageId: `${id}@mirror-fixes.test`,
  from: { address, name: "Sam Orrin" },
  cc: [],
});

// As pi_owner, which the definer functions run as, committed.
const owner = (world: IdentityWorld, text: string, values: unknown[] = []): Promise<unknown[]> =>
  session(world.db.urls.bootstrap, async (query) => {
    await query("set role pi_owner");
    return query(text, values);
  });

const rowsOf = (world: IdentityWorld, client: string): Promise<Row[]> =>
  world.sql<Row>(
    "select id, entry_key, section, entity_ids, evidence_ids, compartments, tainted_at, ended_at, reason from ledger.mirror_entries where client_id = $1 order by id",
    [client],
  );

// Sam's two addresses on one contact, two people, joined by a same ruling: a group of two whose
// lead is the lower id. Each member also has mail of its own, so each has an alias of its own.
async function samJoined(world: IdentityWorld): Promise<{ lead: EntityId; other: EntityId; contactEvidence: string }> {
  await world.save(world.accounts.personalContacts, "sam", { names: ["Sam Orrin"], emails: SAM });
  await world.mail(mailFrom(SAM[0] ?? "", "mirror-fixes-m1"));
  await world.mail(mailFrom(SAM[1] ?? "", "mirror-fixes-m2"));
  const [a, b] = [await world.person(SAM[0] ?? ""), await world.person(SAM[1] ?? "")].sort();
  if (a === undefined || b === undefined) throw new Error("two people");
  await world.admin.identity.linkPeople(a, b, "same", { requestId: req() });
  const [contact] = await world.sql<{ evidence_id: string }>("select evidence_id from knowledge.contacts");
  if (contact === undefined) throw new Error("no contact");
  return { lead: a, other: b, contactEvidence: contact.evidence_id };
}

describe("a group's entry rests on every member and its contacts (invariant 10)", {
  timeout: TIMEOUT,
}, () => {
  it("the lead's row carries every member's id, every member's visible aliases' evidence and the group contact's evidence", () =>
    inIdentityWorld(async (world) => {
      const { lead, other, contactEvidence } = await samJoined(world);
      const mac = await device(world, "mac-groups");
      await pass(world, mac.token);
      const rows = (await rowsOf(world, mac.id)).filter((row) => row.section === "entities" && row.ended_at === null);
      // One entry for the group, keyed by its lead; none for the other member.
      expect(rows.map((row) => row.entry_key)).toContain(lead);
      expect(rows.map((row) => row.entry_key)).not.toContain(other);
      const row = rows.find((one) => one.entry_key === lead);
      expect([...(row?.entity_ids ?? [])].sort()).toEqual([lead, other].sort());
      const aliases = await world.sql<{ evidence_id: string }>(
        "select distinct evidence_id from knowledge.aliases where entity_id = any($1)",
        [[lead, other]],
      );
      for (const alias of aliases) expect(row?.evidence_ids).toContain(alias.evidence_id);
      expect(row?.evidence_ids).toContain(contactEvidence);
      expect(row?.compartments).toEqual(["own"]);
    }));

  it("erasing the member that is not the lead taints the lead's row and links it to the device (more.mirror)", () =>
    inIdentityWorld(async (world) => {
      const { lead, other } = await samJoined(world);
      const mac = await device(world, "mac-erase");
      await pass(world, mac.token);
      const before = (await rowsOf(world, mac.id)).find((row) => row.entry_key === lead && row.ended_at === null);
      expect(before).toBeDefined();
      const report = await world.admin.erasure.erasePerson(other, { requestId: req() });
      expect(report.more.mirror).toBe(1);
      const after = (await rowsOf(world, mac.id)).find((row) => row.id === before?.id);
      expect(after?.tainted_at).not.toBeNull();
      expect(after?.reason).toBe("withdrawn");
      const links = await world.sql<{ n: number }>(
        "select count(*)::int as n from ledger.erasure_exposures where erasure_id = $1 and mirror_entry_id = $2",
        [report.erasure, before?.id],
      );
      expect(one(links).n).toBe(1);
    }));

  it("deleting the group contact's item taints the lead's row, by its evidence alone", () =>
    inIdentityWorld(async (world) => {
      const { lead, contactEvidence } = await samJoined(world);
      const mac = await device(world, "mac-contact");
      const cursor = (await pass(world, mac.token)).at(-1)?.cursor ?? null;
      const before = (await rowsOf(world, mac.id)).find((row) => row.entry_key === lead && row.ended_at === null);
      expect(before?.evidence_ids).toContain(contactEvidence);
      // What a deletion does (memory-fixtures.ts' deletion): ledger.taint_citing as the writer
      // calls it, with the deleted item's evidence id, and no entity named.
      await queryAs(world.db.urls.writer, "select ledger.taint_citing($1::text[], '{}'::text[], '{}'::text[])", [
        [contactEvidence],
      ]);
      const after = (await rowsOf(world, mac.id)).find((row) => row.id === before?.id);
      expect(after?.tainted_at).not.toBeNull();
      expect(after?.ended_at).not.toBeNull();
      // The next call, between passes, sends its removal.
      const page = await call(world, mac.token, cursor);
      expect(page.removals.map((removal) => removal.projection)).toContain(before?.id);
    }));
});

describe("removals of a replacement drain before any entry", { timeout: TIMEOUT }, () => {
  it("more than 500 rows replaced give pages of removals only, the cursor kept at the pass's start, then entries", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "maren", {
        names: ["Maren Holt"],
        emails: ["maren@mirror-fixes.test"],
      });
      const mac = await device(world, "mac-replaced");
      // 501 live rows the device was served under another version: the first call ends them all
      // `replaced`, more than one page's 500 removals.
      await owner(
        world,
        `insert into ledger.mirror_entries (id, client_id, audience, template, section, entry_key, sent_state, evidence_ids, entity_ids, compartments, first_served_at, last_sent_at)
         select 'mir_' || left(encode(sha256(convert_to('fixes ' || n, 'UTF8')), 'hex'), 40), $1, '{own}', 'lens_mirror@9', 'entities', k.key, $2, '{}', '{}', '{own}', now(), now()
         from generate_series(1, 501) n cross join lateral (select $3 || lpad(n::text, 4, '0') as key) k`,
        [mac.id, sha256Hex("fixes state"), testId("ent").slice(0, 26)],
      );
      const first = await call(world, mac.token, null);
      expect(first.removals).toHaveLength(500);
      expect(first.removals.every((removal) => removal.reason === "replaced")).toBe(true);
      expect(first.entries).toEqual([]);
      expect(first.passComplete).toBe(false);
      expect(first.more).toBe(true);
      expect(first.pass).toBe(1);
      // The next call confirms them; one removal is left, which fits the page, so the scan runs
      // from the pass's start and entries follow it in the same page.
      const second = await call(world, mac.token, first.cursor);
      expect(second.removals).toHaveLength(1);
      expect(second.pass).toBe(1);
      expect(second.entries.length).toBeGreaterThan(0);
      expect(second.entries.every((entry) => entry.section === "entities")).toBe(true);
    }));
});

describe("pi clients set-tools on a mirror client", { timeout: TIMEOUT }, () => {
  it("a device's mirror client that holds sync_mirror keeps it beside read tools; no other client is given it", () =>
    inIdentityWorld(async (world) => {
      const mac = await device(world, "mac-tools");
      const toolsOf = async (name: string): Promise<string[]> =>
        one(await world.sql<{ tools: string[] }>("select tools from policy.clients where name = $1", [name])).tools;
      await world.admin.clients.setTools("mac-tools", ["sync_mirror", "get_entity", "find_facts"]);
      expect([...(await toolsOf("mac-tools"))].sort()).toEqual(["find_facts", "get_entity", "sync_mirror"]);
      // It still syncs.
      expect((await world.store.reader.syncMirror(mac.token, { templates: [T1], cursor: null })).ok).toBe(true);

      // An agent is refused sync_mirror, by set-tools and by registration, and is not given it by default.
      await world.admin.clients.addClient(registration("helper-tools", ["own"]));
      await expect(world.admin.clients.setTools("helper-tools", ["get_self", "sync_mirror"])).rejects.toMatchObject({
        name: "AdminError",
        code: "not_built",
      });
      await expect(
        world.admin.clients.addClient(registration("helper-two", ["own"], { tools: ["get_self", "sync_mirror"] })),
      ).rejects.toMatchObject({ name: "AdminError", code: "not_built" });
      expect(DEFAULT_AGENT_TOOLS).not.toContain("sync_mirror");

      // A mirror client that gave sync_mirror up is not given it back: it keeps what it holds only.
      await world.admin.clients.setTools("mac-tools", ["get_entity"]);
      await expect(world.admin.clients.setTools("mac-tools", ["get_entity", "sync_mirror"])).rejects.toMatchObject({
        name: "AdminError",
        code: "not_built",
      });
      expect(await toolsOf("mac-tools")).toEqual(["get_entity"]);
    }));
});

describe("the last completed pass holds while the next one runs", {
  timeout: TIMEOUT,
}, () => {
  it("every cursor carries last_completed_at, and lastPassAt reads it mid-pass", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "maren", {
        names: ["Maren Holt"],
        emails: ["maren@mirror-fixes.test"],
      });
      const mac = await device(world, "mac-status");
      // A reader whose clock the test moves past PI_MIRROR_PASS_SECONDS, so the next pass starts.
      let shift = 0;
      const reader = new Reader({
        pool: world.store.readerPool,
        keys: world.db.keys,
        log: world.store.log,
        now: () => new Date(Date.now() + shift),
      });
      const read = async (cursor: string | null): Promise<MirrorPage> =>
        value(await reader.syncMirror(mac.token, { templates: [T1], cursor: cursor as SyncMirrorArgs["cursor"] }));
      let page = await read(null);
      for (let n = 0; n < 20 && !page.passComplete; n += 1) page = await read(page.cursor);
      expect(page.passComplete).toBe(true);
      const [done] = await world.sql<{ completed_at: Date }>(
        "select completed_at from ledger.mirror_cursors where client_id = $1 and completed_at is not null order by issued_at desc limit 1",
        [mac.id],
      );
      expect(done).toBeDefined();
      const status = async () =>
        (await world.admin.lens.devices()).find((one) => one.name === "mac-status")?.lastPassAt ?? null;
      expect(await status()).toBe(done?.completed_at.toISOString());

      // The next pass's first call: its cursor is mid-pass, with no completed_at, and still carries
      // the last completion, so lastPassAt still answers the last completed pass.
      shift = 2 * 3_600_000;
      const next = await read(page.cursor);
      expect(next.pass).toBe(page.pass + 1);
      expect(next.passComplete).toBe(false);
      const cursors = await world.sql<{ completed_at: Date | null; last_completed_at: Date | null }>(
        "select completed_at, last_completed_at from ledger.mirror_cursors where client_id = $1",
        [mac.id],
      );
      expect(cursors.every((one) => one.last_completed_at?.toISOString() === done?.completed_at.toISOString())).toBe(
        true,
      );
      expect(await status()).toBe(done?.completed_at.toISOString());
    }));
});

describe("the source tokens hold what the values read", { timeout: TIMEOUT }, () => {
  it("a shared mark, which changes no account or alias, re-sends the person's entry in the next pass that reads tokens", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "family", {
        names: ["Family Inbox"],
        emails: ["family@mirror-fixes.test"],
      });
      const family = await world.person("family@mirror-fixes.test");
      const mac = await device(world, "mac-tokens");
      let shift = 0;
      const reader = new Reader({
        pool: world.store.readerPool,
        keys: world.db.keys,
        log: world.store.log,
        now: () => new Date(Date.now() + shift),
      });
      const read = async (cursor: string | null): Promise<MirrorPage> =>
        value(await reader.syncMirror(mac.token, { templates: [T1], cursor: cursor as SyncMirrorArgs["cursor"] }));
      const wholePass = async (cursor: string | null): Promise<MirrorPage[]> => {
        const pages = [await read(cursor)];
        for (let n = 0; n < 20 && !(pages.at(-1)?.passComplete ?? false); n += 1)
          pages.push(await read(pages.at(-1)?.cursor ?? null));
        return pages;
      };
      const sharedOf = (pages: MirrorPage[]): boolean | undefined => {
        for (const entry of pages.flatMap((page) => page.entries))
          if (entry.section === "entities" && entry.entity.id === family) return entry.entity.shared;
        return undefined;
      };
      const first = await wholePass(null);
      expect(sharedOf(first)).toBe(false);
      await world.admin.identity.markShared(family, { requestId: req() });
      // Two hours on: a pass that reads tokens (the last that ignored them is under a day old).
      shift = 2 * 3_600_000;
      const second = await wholePass(first.at(-1)?.cursor ?? null);
      expect(sharedOf(second)).toBe(true);
    }));
});

describe("an entry larger than any page is dropped, not stalled on", {
  timeout: TIMEOUT,
}, () => {
  // The reader marks such an entry `drop` (mirror-fill.test.ts tests that half); this is
  // serve_mirror's: called as the reader calls it, under the mirror client's token.
  const SERVE =
    "select kind, projection_id, reason from policy.serve_mirror($1, $2, $3, $4::text[], $5, $6, $7, $8::text[], $9::jsonb, $10, $11, $12)";

  it("serve_mirror ends the row of an entry marked drop `dropped`, sends its removal, and sends no entry for it", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "maren", {
        names: ["Maren Holt"],
        emails: ["maren@mirror-fixes.test"],
      });
      const maren = await world.person("maren@mirror-fixes.test");
      const mac = await device(world, "mac-drop");
      await pass(world, mac.token);
      const live = (await rowsOf(world, mac.id)).filter((row) => row.section === "entities" && row.ended_at === null);
      const row = live.find((one) => one.entry_key === maren);
      if (row === undefined) throw new Error("no row for the person");
      const [latest] = await world.sql<{ id: string }>(
        "select c.id from ledger.mirror_cursors c where c.client_id = $1 and not exists (select 1 from ledger.mirror_cursors d where d.prior_id = c.id)",
        [mac.id],
      );
      const sessionId = testId("ses");
      await owner(world, "insert into ledger.sessions (id, client_id, compartments) values ($1, $2, $3)", [
        sessionId,
        mac.id,
        ["own"],
      ]);
      const entry = {
        id: row.id,
        key: row.entry_key,
        fact_key_fp: null,
        evidence_ids: row.evidence_ids,
        entity_ids: row.entity_ids,
        anchor_ids: [],
        compartments: row.compartments,
        state: sha256Hex("fixes oversize state"),
        token: sha256Hex("fixes oversize token"),
        drop: true,
      };
      // A new pass's first scan of entities, finding every live key, the oversize one among them.
      const answer = await readAs(world.db, mac.token, (query) =>
        query<{ kind: string; projection_id: string | null; reason: string | null }>(SERVE, [
          sessionId,
          T1,
          latest?.id,
          [],
          "entities",
          null,
          null,
          live.map((one) => one.entry_key),
          JSON.stringify([entry]),
          false,
          500,
          20_000,
        ]),
      );
      expect(answer.filter((one) => one.kind === "entry")).toEqual([]);
      expect(answer.filter((one) => one.kind === "removal").map((one) => [one.projection_id, one.reason])).toEqual([
        [row.id, "dropped"],
      ]);
      const after = (await rowsOf(world, mac.id)).find((one) => one.id === row.id);
      expect({ reason: after?.reason, ended: after?.ended_at !== null, tainted: after?.tainted_at }).toEqual({
        reason: "dropped",
        ended: true,
        tainted: null,
      });
      // The other live rows were found, so none was ended.
      const others = (await rowsOf(world, mac.id)).filter((one) => one.section === "entities" && one.id !== row.id);
      expect(others.every((one) => one.ended_at === null)).toBe(true);
    }));
});

// Invariant 10: what get_entity serves from a contact, a single person's details and an
// organization's use-only name, is in the read log and in the mirror's entry, so a deleted contact
// is withdrawn from both.
describe("a contact behind get_entity's details", { timeout: TIMEOUT }, () => {
  const MAREN = "maren@k1-details.test";
  const COLLEAGUE = "rowan@k1-details.test";
  async function saved(
    world: IdentityWorld,
  ): Promise<{ maren: EntityId; organization: EntityId; contact: string; work: string }> {
    await world.mail(mailFrom(MAREN, "k1-details-1"));
    await world.mail(mailFrom(COLLEAGUE, "k1-details-2"));
    await world.save(world.accounts.personalContacts, "maren", {
      names: ["Maren Holt"],
      emails: [MAREN],
      phone: "+1 415 555 0142",
      organization: "Holt Ceramics Works",
    });
    await world.save(world.accounts.workContacts, "rowan", {
      names: ["Rowan Ash"],
      emails: [COLLEAGUE],
      organization: "Employer Side Name",
    });
    const maren = await world.person(MAREN);
    const [org] = await world.sql<{ entity_id: string }>(
      "select distinct d.entity_id from knowledge.accounts a join knowledge.domains d on d.domain_fp = a.domain_fp where a.entity_id = $1",
      [maren],
    );
    const contact = (compartment: string) =>
      world.sql<{ evidence_id: string }>("select evidence_id from knowledge.contacts where compartments = $1::text[]", [
        [compartment],
      ]);
    return {
      maren,
      organization: org?.entity_id as EntityId,
      contact: one(await contact("own")).evidence_id,
      work: one(await contact("employer:example")).evidence_id,
    };
  }

  it("get_entity logs a person's own contact and an organization's contact and claims as shown; an employer contact names nothing", () =>
    inIdentityWorld(async (world) => {
      const { maren, organization, contact, work } = await saved(world);
      const { token } = await world.admin.clients.addClient(registration("k1-details", ["own", "employer:example"]));
      const id = one(await world.sql<{ id: string }>("select id from policy.clients where name = 'k1-details'")).id;
      const person = value(await world.store.reader.getEntity(token, { id: maren }));
      expect(person.details).toMatchObject([
        { disclosure: "use_only", phones: [{ value: { untrusted: "+1 415 555 0142" } }] },
      ]);
      const org = value(await world.store.reader.getEntity(token, { id: organization }));
      // The contact's organization is a use-only detail, never one of the names; the employer
      // contact's is in neither.
      expect(org.names.map((one) => one.untrusted)).not.toContain("Holt Ceramics Works");
      expect(org.details).toEqual([
        {
          disclosure: "use_only",
          names: [],
          phones: [],
          organizations: [{ name: { untrusted: "Holt Ceramics Works" }, title: null }],
          birthday: null,
        },
      ]);
      expect(JSON.stringify(org)).not.toContain("Employer Side Name");
      const logged = await world.sql<{ shown: string[] }>(
        "select shown from ledger.read_log where client_id = $1 and tool = 'get_entity' order by id",
        [id],
      );
      expect(logged[0]?.shown).toContain(contact);
      expect(logged[1]?.shown).toContain(contact);
      for (const row of logged) expect(row.shown).not.toContain(work);
    }));

  it("a single person's entry rests on its own contact: deleting the contact taints it and the next call removes it", () =>
    inIdentityWorld(async (world) => {
      const { maren, contact } = await saved(world);
      const mac = await device(world, "mac-details");
      const cursor = (await pass(world, mac.token)).at(-1)?.cursor ?? null;
      const before = (await rowsOf(world, mac.id)).find((row) => row.entry_key === maren && row.ended_at === null);
      expect(before?.evidence_ids).toContain(contact);
      await queryAs(world.db.urls.writer, "select ledger.taint_citing($1::text[], '{}'::text[], '{}'::text[])", [
        [contact],
      ]);
      const after = (await rowsOf(world, mac.id)).find((row) => row.id === before?.id);
      expect(after?.tainted_at).not.toBeNull();
      const page = await call(world, mac.token, cursor);
      expect(page.removals.map((removal) => removal.projection)).toContain(before?.id);
    }));
});

// Invariant 10: an organization's names served from its role and affiliation claims are in its
// mirror entry's token and evidence, so deleting the message a name came from withdraws the entry.
describe("an organization's entry rests on the claims its names came from", {
  timeout: TIMEOUT,
}, () => {
  it("deleting the message behind an organization's role claim taints its entry, and the next call removes it", () =>
    inIdentityWorld(async (world) => {
      const ADDRESS = "fen@k1-org-claims.test";
      await world.mail(mailFrom(ADDRESS, "k1-org-claims-1"));
      const fen = await world.person(ADDRESS);
      const organization = one(
        await world.sql<{ entity_id: string }>(
          "select distinct d.entity_id from knowledge.accounts a join knowledge.domains d on d.domain_fp = a.domain_fp where a.entity_id = $1",
          [fen],
        ),
      ).entity_id;
      const evidence = one(
        await world.sql<{ evidence_id: string }>("select evidence_id from knowledge.messages"),
      ).evidence_id;
      const base = claimRecord(evidence, "own", fen, {
        type: "role",
        factKey: "k1-org-claims-role",
        entities: [fen, organization],
      });
      const role = {
        ...base,
        subjectKind: "person",
        claim: {
          ...base.claim,
          content: {
            type: "role",
            subject: fen,
            fields: { title: "treasurer", organization, organization_name: "Fen Cooperative" },
          },
        },
        fieldKinds: { title: "text", organization: "entity", organization_name: "text" },
      } as unknown as ClaimRecord;
      const pipeline = createPipeline({ url: world.db.urls.pipeline, keys: world.db.keys, log: recordingLogger().log });
      try {
        expect(await pipeline.commit(batchOf(evidence, [role]))).toBe("committed");
      } finally {
        await pipeline.close();
      }
      const mac = await device(world, "mac-org-claims");
      const pages = await pass(world, mac.token);
      const served = pages
        .flatMap((page) => page.entries)
        .find((entry) => entry.section === "entities" && entry.entity.id === organization);
      expect(served?.section === "entities" ? served.entity.names : null).toEqual([{ untrusted: "Fen Cooperative" }]);
      const before = (await rowsOf(world, mac.id)).find(
        (row) => row.entry_key === organization && row.ended_at === null,
      );
      expect(before?.evidence_ids).toContain(evidence);
      await queryAs(world.db.urls.writer, "select ledger.taint_citing($1::text[], '{}'::text[], '{}'::text[])", [
        [evidence],
      ]);
      const after = (await rowsOf(world, mac.id)).find((row) => row.id === before?.id);
      expect(after?.tainted_at).not.toBeNull();
      const page = await call(world, mac.token, pages.at(-1)?.cursor ?? null);
      expect(page.removals.map((removal) => removal.projection)).toContain(before?.id);
    }));
});
