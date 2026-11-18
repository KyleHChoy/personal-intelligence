import type { EntityId, PersonalTool } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import type { Query } from "../core/db.ts";
import { statementId, statementTimer } from "../core/statement-timer.ts";
import { type IdentityWorld, inIdentityWorld, req } from "../test-support/identity-fixtures.ts";
import type { MailFixture } from "../test-support/items.ts";
import { MAIL } from "../test-support/items-named.ts";
import { registration } from "../test-support/values.ts";
import { groupWho } from "./read-group-who.ts";
import { loadGroups, RULINGS } from "./read-groups.ts";
import { search } from "./read-tools.ts";
import { entityOf } from "./read-tools-entity.ts";
import { getSelf } from "./read-tools-self.ts";

// The read tools answer for a group, the people a client can see joined by rulings it can read.

const TIMEOUT = 180_000;
const TOOLS = [
  "get_self",
  "search",
  "get_entity",
  "get_timeline",
  "find_messages",
  "read_message",
  "find_facts",
] as PersonalTool[];
const SAM = ["sam@reader-groups.test", "sam.orrin@reader-groups.example"];

async function client(world: IdentityWorld, name: string, compartments: string[]): Promise<string> {
  const { token } = await world.admin.clients.addClient(
    registration(name, compartments, { views: ["self", "people", "work"], tools: TOOLS }),
  );
  return token;
}

async function samBoth(world: IdentityWorld): Promise<{ sam: EntityId; orrin: EntityId }> {
  await world.save(world.accounts.personalContacts, "sam", { names: ["Sam Orrin"], emails: SAM });
  return { sam: await world.person(SAM[0] ?? ""), orrin: await world.person(SAM[1] ?? "") };
}

const join = async (world: IdentityWorld, a: EntityId, b: EntityId) =>
  world.admin.identity.linkPeople(a, b, "same", { requestId: req() });

const value = <T>(outcome: { ok: boolean; value?: T }): T => {
  if (!outcome.ok || outcome.value === undefined) throw new Error(`refused: ${JSON.stringify(outcome)}`);
  return outcome.value;
};

const mailFrom = (address: string, id: string): MailFixture => ({
  ...MAIL.solo,
  id,
  threadId: `thread-${id}`,
  messageId: `${id}@reader-groups.test`,
  from: { address, name: "Sam Orrin" },
  cc: [],
});

describe("a client's groups", { timeout: TIMEOUT }, () => {
  it("a group answers as one person from get_entity, under any member's id, and is named by its lowest id", () =>
    inIdentityWorld(async (world) => {
      const { sam, orrin } = await samBoth(world);
      await join(world, sam, orrin);
      const token = await client(world, "groups-own", ["own"]);
      const one = value(await world.store.reader.getEntity(token, { id: sam }));
      const other = value(await world.store.reader.getEntity(token, { id: orrin }));
      expect(one).toEqual(other);
      expect(one.id).toBe([sam, orrin].sort()[0]);
      expect(one.addresses.map((address) => address.untrusted).sort()).toEqual([...SAM].sort());
      expect(one.names).toEqual([{ untrusted: "Sam Orrin" }]);
    }));

  it("a two-address contact names neither person before a same ruling, and the group after it", () =>
    inIdentityWorld(async (world) => {
      const { sam, orrin } = await samBoth(world);
      const token = await client(world, "groups-before", ["own"]);
      expect(value(await world.store.reader.getEntity(token, { id: sam })).names).toEqual([]);
      expect(value(await world.store.reader.search(token, { query: "sam orrin" })).results).toEqual([]);
      await join(world, sam, orrin);
      const found = value(await world.store.reader.search(token, { query: "sam orrin" })).results;
      expect(found.map((one) => one.id)).toEqual([[sam, orrin].sort()[0]]);
    }));

  it("a ruling one of whose sides is hidden joins nothing for that client; a client that sees both sides sees one person", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "kit", {
        names: ["Kit Arden"],
        emails: ["kit@reader-groups.test"],
      });
      await world.save(world.accounts.workContacts, "kit-work", {
        names: ["Kit Arden"],
        emails: ["kit.arden@reader-groups.example"],
      });
      const [own, work] = [
        await world.person("kit@reader-groups.test"),
        await world.person("kit.arden@reader-groups.example"),
      ];
      const ownToken = await client(world, "groups-hidden-own", ["own"]);
      const before = value(await world.store.reader.getEntity(ownToken, { id: own }));
      await join(world, own, work);
      expect(value(await world.store.reader.getEntity(ownToken, { id: own }))).toEqual(before);
      const both = await client(world, "groups-hidden-both", ["own", "employer:example"]);
      const seen = value(await world.store.reader.getEntity(both, { id: work }));
      expect(seen.id).toBe([own, work].sort()[0]);
      expect(seen.addresses).toHaveLength(2);
    }));

  it("a lifted ruling joins nothing", () =>
    inIdentityWorld(async (world) => {
      const { sam, orrin } = await samBoth(world);
      const ruling = await join(world, sam, orrin);
      await world.admin.identity.liftIdentity(ruling, { requestId: req() });
      const token = await client(world, "groups-lifted", ["own"]);
      expect(value(await world.store.reader.getEntity(token, { id: sam })).id).toBe(sam);
      expect(value(await world.store.reader.getEntity(token, { id: orrin })).id).toBe(orrin);
    }));

  it("a message two members share is counted once, and find_messages by one member returns both members' messages", () =>
    inIdentityWorld(async (world) => {
      const { sam, orrin } = await samBoth(world);
      await world.mail(mailFrom(SAM[0] ?? "", "groups-m1"));
      await world.mail(mailFrom(SAM[1] ?? "", "groups-m2"));
      await join(world, sam, orrin);
      const token = await client(world, "groups-mail", ["own"]);
      const view = value(await world.store.reader.getEntity(token, { id: sam }));
      expect(view.mail.inbound).toBe(2);
      const found = value(await world.store.reader.findMessages(token, { entity: orrin }));
      expect(found.messages).toHaveLength(2);
      const timeline = value(await world.store.reader.getTimeline(token, { id: orrin }));
      expect(timeline.entries).toHaveLength(2);
    }));

  it("person_brief by any member's id reads every member's latest messages, as get_timeline does", () =>
    inIdentityWorld(async (world) => {
      const { sam, orrin } = await samBoth(world);
      await world.mail(mailFrom(SAM[0] ?? "", "groups-b1"));
      await world.mail(mailFrom(SAM[1] ?? "", "groups-b2"));
      await join(world, sam, orrin);
      const { token } = await world.admin.clients.addClient(
        registration("groups-brief", ["own"], {
          views: ["self", "people", "work"],
          tools: [...TOOLS, "build_context_pack"],
        }),
      );
      const higher = [sam, orrin].sort()[1] as EntityId;
      const pack = value(await world.store.reader.buildContextPack(token, { purpose: "person_brief", entity: higher }));
      expect(pack.items.filter((item) => item.section === "recent_messages")).toHaveLength(2);
    }));

  it("shared is true exactly for an address with a readable shared ruling", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "family", {
        names: ["Family Inbox"],
        emails: ["family@reader-groups.test"],
      });
      await world.save(world.accounts.personalContacts, "solo", {
        names: ["Solo Person"],
        emails: ["solo@reader-groups.test"],
      });
      const [family, solo] = [
        await world.person("family@reader-groups.test"),
        await world.person("solo@reader-groups.test"),
      ];
      await world.admin.identity.markShared(family, { requestId: req() });
      const token = await client(world, "groups-shared", ["own"]);
      expect(value(await world.store.reader.getEntity(token, { id: family })).shared).toBe(true);
      expect(value(await world.store.reader.getEntity(token, { id: solo })).shared).toBe(false);
    }));

  it("an own contact's details are served marked use-only, each value wrapped; an employer contact's are not served", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "maren", {
        names: ["Maren Holt"],
        emails: ["maren@reader-groups.test"],
        phone: "555-0101",
        organization: "Example Works",
        title: "Archivist",
        birthday: { month: 3, day: 4 },
      });
      await world.save(world.accounts.workContacts, "ines", {
        names: ["Ines Varga"],
        emails: ["ines@reader-groups.test"],
        phone: "555-0102",
      });
      const token = await client(world, "groups-details", ["own", "employer:example"]);
      const details = value(
        await world.store.reader.getEntity(token, { id: await world.person("maren@reader-groups.test") }),
      ).details;
      expect(details).toEqual([
        {
          disclosure: "use_only",
          names: [{ untrusted: "Maren Holt" }],
          phones: [{ value: { untrusted: "555-0101" }, type: null }],
          organizations: [{ name: { untrusted: "Example Works" }, title: { untrusted: "Archivist" } }],
          birthday: { month: 3, day: 4 },
        },
      ]);
      expect(
        value(await world.store.reader.getEntity(token, { id: await world.person("ines@reader-groups.test") })).details,
      ).toEqual([]);
      // A client not cleared for own sees no own contact.
      const work = await client(world, "groups-details-work", ["employer:example"]);
      const outcome = await world.store.reader.getEntity(work, { id: await world.person("maren@reader-groups.test") });
      expect(outcome.ok ? outcome.value?.details : []).toEqual([]);
    }));

  it("a person saved as a contact and never mailed is found by the contact's name", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "maren", {
        names: ["Maren Holt"],
        emails: ["maren@reader-groups.test"],
      });
      const token = await client(world, "groups-found", ["own"]);
      const found = value(await world.store.reader.search(token, { query: "maren holt" })).results;
      expect(found.map((one) => one.name)).toEqual([{ untrusted: "Maren Holt" }]);
    }));

  it("12 matches over 6 groups with limit 5 give 5 results", () =>
    inIdentityWorld(async (world) => {
      for (let i = 0; i < 6; i += 1) {
        const pair = [`twin${i}@reader-groups.test`, `twin${i}@reader-groups.example`];
        await world.save(world.accounts.personalContacts, `twin${i}a`, {
          names: [`Twin Example${i}`],
          emails: [pair[0] ?? ""],
        });
        await world.save(world.accounts.personalContacts, `twin${i}b`, {
          names: [`Twin Other${i}`],
          emails: [pair[1] ?? ""],
        });
        await join(world, await world.person(pair[0] ?? ""), await world.person(pair[1] ?? ""));
      }
      const token = await client(world, "groups-limit", ["own"]);
      const found = value(await world.store.reader.search(token, { query: "twin", limit: 5 })).results;
      expect(found).toHaveLength(5);
      expect(new Set(found.map((one) => one.id)).size).toBe(5);
    }));

  it("a group of two organizations shows none, and of one shows it", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.personalContacts, "x", { names: ["Xia One"], emails: ["xia@alpha-org.test"] });
      await world.save(world.accounts.personalContacts, "y", { names: ["Xia Two"], emails: ["xia@beta-org.test"] });
      const [x, y] = [await world.person("xia@alpha-org.test"), await world.person("xia@beta-org.test")];
      await join(world, x, y);
      const token = await client(world, "groups-orgs", ["own"]);
      expect(value(await world.store.reader.getEntity(token, { id: x })).organization).toBeNull();
    }));

  it("an id that is hidden, and one that does not exist, answer not_found alike", () =>
    inIdentityWorld(async (world) => {
      await world.save(world.accounts.workContacts, "devon", {
        names: ["Devon Marsh"],
        emails: ["devon@reader-groups.test"],
      });
      const token = await client(world, "groups-not-found", ["own"]);
      const hidden = await world.store.reader.getEntity(token, { id: await world.person("devon@reader-groups.test") });
      const missing = await world.store.reader.getEntity(token, { id: "ent_00000000000000000000000000" as EntityId });
      expect(hidden).toEqual(missing);
    }));

  it("a link gives the other address no sent mail", () =>
    inIdentityWorld(async (world) => {
      const { sam, orrin } = await samBoth(world);
      await join(world, sam, orrin);
      const wrote = await world.store.writer.ownerWrote(world.accounts.personalMail, { sender: SAM[1] ?? "" });
      expect(wrote.sender).toBe(false);
    }));

  it("no tool result holds a ruling, a card or a time of one", () =>
    inIdentityWorld(async (world) => {
      const { sam, orrin } = await samBoth(world);
      const ruling = await join(world, sam, orrin);
      const token = await client(world, "groups-no-ruling", ["own"]);
      const text = JSON.stringify([
        await world.store.reader.getSelf(token),
        await world.store.reader.getEntity(token, { id: sam }),
        await world.store.reader.search(token, { query: "sam" }),
        await world.store.reader.getTimeline(token, { id: sam }),
      ]);
      expect(text).not.toContain(ruling);
      expect(text).not.toContain("same_person");
      expect(text).not.toContain("identity");
    }));

  it("groupWho over several groups names each by its own contacts alone: not by one spanning two groups, one of 20 addresses, or one with an address outside every group", () =>
    inIdentityWorld(async (world) => {
      const KIT = ["kit@reader-groups.test", "kit.lee@reader-groups.example"];
      const BIG = Array.from({ length: 20 }, (_, i) => `big${i}@reader-groups.test`);
      const { sam, orrin } = await samBoth(world);
      await world.save(world.accounts.personalContacts, "kit", { names: ["Kit Lee"], emails: KIT });
      await world.save(world.accounts.personalContacts, "big", { names: ["Big Twenty"], emails: BIG });
      await world.save(world.accounts.personalContacts, "lone", {
        names: ["Lone Other"],
        emails: ["lone@reader-groups.test"],
      });
      const [kit, lee, lone] = [
        await world.person(KIT[0] ?? ""),
        await world.person(KIT[1] ?? ""),
        await world.person("lone@reader-groups.test"),
      ];
      const big = await Promise.all(BIG.map((address) => world.person(address)));
      // Saved after the groups' own contacts, and named first, so either would win if it counted.
      await world.save(world.accounts.personalContacts, "span", {
        names: ["Ash Span"],
        emails: [SAM[0] ?? "", KIT[0] ?? ""],
      });
      await world.save(world.accounts.personalContacts, "outside", {
        names: ["Abe Outside"],
        emails: [SAM[1] ?? "", "lone@reader-groups.test"],
      });
      await join(world, sam, orrin);
      await join(world, kit, lee);
      for (const one of big.slice(1)) await join(world, big[0] as EntityId, one);
      const token = await client(world, "groups-who", ["own"]);
      const asked = [sam, kit, big[0] as EntityId, lone];
      const who = await world.store.reader.withClient(
        token,
        { isolation: "repeatable read" },
        async ({ client: found, ctx }) => {
          const one = ctx(found ?? (undefined as never));
          return groupWho(one, await loadGroups(one), asked);
        },
      );
      expect(asked.map((id) => who.get(id)?.name ?? null)).toEqual([
        { untrusted: "Sam Orrin" },
        { untrusted: "Kit Lee" },
        null,
        { untrusted: "Lone Other" },
      ]);
      expect(value(await world.store.reader.getEntity(token, { id: orrin })).names).toEqual([
        { untrusted: "Sam Orrin" },
      ]);
      expect(value(await world.store.reader.getEntity(token, { id: lee })).names).toEqual([{ untrusted: "Kit Lee" }]);
      expect(value(await world.store.reader.getEntity(token, { id: big[3] as EntityId })).names).toEqual([]);
      expect(value(await world.store.reader.search(token, { query: "ash span" })).results).toEqual([]);
      expect(value(await world.store.reader.search(token, { query: "big twenty" })).results).toEqual([]);
      expect(value(await world.store.reader.search(token, { query: "kit lee" })).results.map((one) => one.id)).toEqual([
        [kit, lee].sort()[0],
      ]);
    }));

  it("a call reads the rulings once: get_self, get_entity and search each send the rulings statement one time, and a new call sends it again", () =>
    inIdentityWorld(async (world) => {
      const { sam, orrin } = await samBoth(world);
      await join(world, sam, orrin);
      const token = await client(world, "groups-once", ["own"]);
      const counts = await world.store.reader.withClient(
        token,
        { isolation: "repeatable read" },
        async ({ client: found, ctx }) => {
          const one = found ?? (undefined as never);
          const sent: number[] = [];
          const now = new Date();
          const calls = [
            (c: typeof base) => getSelf(c, now, {}, one.views),
            (c: typeof base) =>
              entityOf(c, { id: orrin }, now, { brief: false, views: ["self", "people", "work"], card: true }),
            (c: typeof base) => search(c, { query: "sam orrin" }, ["self", "people", "work"]),
            (c: typeof base) => getSelf(c, now, {}, one.views),
          ];
          const base = ctx(one);
          for (const call of calls) {
            const timer = statementTimer(base.run as Query);
            await call({ ...ctx(one), run: timer.run as typeof base.run });
            sent.push(timer.statements.get(statementId(RULINGS).id)?.ms.length ?? 0);
          }
          return sent;
        },
      );
      expect(counts).toEqual([1, 1, 1, 1]);
    }));
});
