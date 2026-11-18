import {
  EvidenceId,
  type IdentityResolver,
  LocalEntityId,
  type RawItem,
  type Resolution,
  type Timestamp,
} from "@intelligence/contracts";
import { SourceAccountId } from "@intelligence/contracts/personal";
import { describe, expect, it, vi } from "vitest";
import { PERSONAL_LIMITS } from "../limits.ts";
import { THE_OWNER } from "../owner.ts";
import { contactItem, whitelistedContact } from "./contacts.ts";
import { deriveItem } from "./derive.ts";
import type { ItemContext } from "./types.ts";

// n1.3: what code reads from a stored contact.
const pipeline = vi.hoisted(() => ({ parse: vi.fn(), interactionFor: vi.fn() }));
vi.mock("../claim-pipeline/parse.ts", async (actual) => {
  const real = await actual<typeof import("../claim-pipeline/parse.ts")>();
  return {
    ...real,
    parse: (...args: Parameters<typeof real.parse>) => {
      pipeline.parse();
      return real.parse(...args);
    },
  };
});
vi.mock("../claim-pipeline/interaction.ts", async (actual) => {
  const real = await actual<typeof import("../claim-pipeline/interaction.ts")>();
  return {
    ...real,
    interactionFor: (...args: Parameters<typeof real.interactionFor>) => {
      pipeline.interactionFor();
      return real.interactionFor(...args);
    },
  };
});

const account = SourceAccountId.parse("acc_01JABCDEFGHJKMNPQRSTVWXYZ0");
const now = "2026-03-04T10:00:00Z" as Timestamp;
const OWNER = ["avery@example.org"];
const ownerEntity = LocalEntityId.parse("ent-owner");
const own = { metadata: { source: { type: "CONTACT", id: "c1" } } };
const email = (value: string) => ({ ...own, value });

function fakeIdentity(answers: Record<string, Resolution> = {}): IdentityResolver & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    resolve: async (mention, store) => {
      if (mention.key.kind !== "address" || store !== "people") throw new Error("not an address for People");
      asked.push(mention.key.value);
      return (
        answers[mention.key.value] ?? {
          outcome: "created",
          entity: LocalEntityId.parse(`ent:${mention.key.value}`),
          epoch: 0,
        }
      );
    },
  };
}
const context = (identity: IdentityResolver = fakeIdentity()): ItemContext => ({
  evidenceId: EvidenceId.parse("ev-core-contact-1"),
  revision: 0,
  compartment: "own",
  ownerAddresses: OWNER,
  ownerEntity,
  identity,
});

const contact = (over: Record<string, unknown> = {}): RawItem => {
  const read = whitelistedContact({
    resourceName: "people/c1",
    metadata: { sources: [{ type: "CONTACT", id: "c1", updateTime: "2026-02-01T09:00:00Z" }] },
    names: [{ ...own, displayName: "Maren Holt" }],
    nicknames: [{ ...own, value: "Mare" }],
    emailAddresses: [email("maren@example.org")],
    phoneNumbers: [{ ...own, value: "555-0101", canonicalForm: "+15555550101" }],
    organizations: [{ ...own, name: "Example Works" }],
    birthdays: [{ ...own, date: { month: 3, day: 4 } }],
    ...over,
  });
  if (read === null) throw new Error("refused");
  return contactItem(read, { sourceAccount: account, changeKind: "backfill", now });
};
const derive = (raw: RawItem, ctx: ItemContext = context()) => deriveItem(raw, ctx, PERSONAL_LIMITS);
const entity = (address: string) => LocalEntityId.parse(`ent:${address}`);

describe("deriveContact", () => {
  it("each address is resolved alone", async () => {
    const identity = fakeIdentity();
    const facts = await derive(
      contact({ emailAddresses: [email("b@example.org"), email("a@example.org")] }),
      context(identity),
    );
    expect(identity.asked).toEqual(["b@example.org", "a@example.org"]);
    expect(facts.kind === "contact" && facts.people).toEqual([
      { entity: entity("b@example.org"), address: "b@example.org" },
      { entity: entity("a@example.org"), address: "a@example.org" },
    ]);
  });

  it("a one-address contact's names and nicknames are names of its person", async () => {
    const facts = await derive(contact());
    expect(facts).toEqual({
      kind: "contact",
      members: { participantMembers: [THE_OWNER] },
      contact: {
        sourceId: "contact:people/c1",
        updatedAt: "2026-02-01T09:00:00Z",
        names: ["Maren Holt", "Mare"],
        phones: [{ value: "555-0101", canonical: "+15555550101", type: null }],
        organizations: [{ name: "Example Works", title: null }],
        birthday: { month: 3, day: 4 },
      },
      people: [{ entity: entity("maren@example.org"), address: "maren@example.org" }],
      names: [
        { entity: entity("maren@example.org"), name: "Maren Holt" },
        { entity: entity("maren@example.org"), name: "Mare" },
      ],
    });
  });

  // A phone-only contact's person is resolved by its phone key, as a profile-only imported row's is
  // by its profile, and its names are that person's.
  it("a phone-only contact resolves its tel: key alone, and its names are names of its person", async () => {
    const identity = fakeIdentity();
    const facts = await derive(contact({ emailAddresses: [] }), context(identity));
    expect(identity.asked).toEqual(["tel:+15555550101"]);
    if (facts.kind !== "contact") throw new Error(facts.kind);
    expect(facts.people).toEqual([{ entity: entity("tel:+15555550101"), address: "tel:+15555550101" }]);
    expect(facts.names).toEqual([
      { entity: entity("tel:+15555550101"), name: "Maren Holt" },
      { entity: entity("tel:+15555550101"), name: "Mare" },
    ]);
    // A contact with an address resolves its address alone: its phone stays sealed data.
    const other = fakeIdentity();
    await derive(contact(), context(other));
    expect(other.asked).toEqual(["maren@example.org"]);
  });

  it("a two-address contact gives no names entry and keeps its names in the facts", async () => {
    const facts = await derive(contact({ emailAddresses: [email("sam@example.org"), email("sam.orrin@example.net")] }));
    if (facts.kind !== "contact") throw new Error(facts.kind);
    expect(facts.names).toEqual([]);
    expect(facts.contact.names).toEqual(["Maren Holt", "Mare"]);
    expect(facts.people).toHaveLength(2);
  });

  it("an address the port refuses is left out and the rest stay", async () => {
    const identity = fakeIdentity({ "a@example.org": { outcome: "not_a_person" } });
    const facts = await derive(
      contact({ emailAddresses: [email("a@example.org"), email("b@example.org")] }),
      context(identity),
    );
    expect(facts.kind === "contact" && facts.people).toEqual([
      { entity: entity("b@example.org"), address: "b@example.org" },
    ]);
    // Two addresses listed: still no alias, though one resolved.
    expect(facts.kind === "contact" && facts.names).toEqual([]);
  });

  it("a phone number reaches the facts and no mention", async () => {
    const identity = fakeIdentity();
    const facts = await derive(contact(), context(identity));
    expect(identity.asked).toEqual(["maren@example.org"]);
    expect(facts.kind === "contact" && facts.contact.phones[0]?.value).toBe("555-0101");
  });

  it("deriveContact calls no part of the claim pipeline", async () => {
    pipeline.parse.mockClear();
    pipeline.interactionFor.mockClear();
    await derive(contact());
    expect(pipeline.parse).not.toHaveBeenCalled();
    expect(pipeline.interactionFor).not.toHaveBeenCalled();
  });

  it("a contact that does not read is unread", async () => {
    const raw = { ...contact(), payload: Buffer.from(JSON.stringify({ resourceName: 7 })).toString("base64") };
    expect(await derive(raw)).toEqual({ kind: "unread", members: { participantMembers: [THE_OWNER] } });
    expect(await derive({ ...contact(), payload: Buffer.from("not json").toString("base64") })).toEqual({
      kind: "unread",
      members: { participantMembers: [THE_OWNER] },
    });
  });

  it("a contact that lists an owner address derives nothing", async () => {
    const identity = fakeIdentity();
    const raw = contact({ emailAddresses: [email("maren@example.org"), email("Avery@Example.org")] });
    expect(await derive(raw, context(identity))).toEqual({
      kind: "unread",
      members: { participantMembers: [THE_OWNER] },
    });
    expect(identity.asked).toEqual([]);
  });
});
