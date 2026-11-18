import { EvidenceId, type IdentityResolver, LocalEntityId, type RawItem, Timestamp } from "@intelligence/contracts";
import { SourceAccountId } from "@intelligence/contracts/personal";
import { PERSONAL_LIMITS } from "@intelligence/personal-core";
import {
  calendarItem,
  deriveItem,
  gmailItem,
  type ItemContext,
  type ItemFacts,
} from "@intelligence/personal-core/items";
import { describe, expect, it } from "vitest";
import { checkFacts } from "./writer-derived.ts";

// Made-up values on reserved domains; no database.

const at = { sourceAccount: SourceAccountId.parse("acc_01JABCDEFGHJKMNPQRSTVWXYZ0"), changeKind: "backfill" } as const;
const OWNER = "owner@example.org";
const owner = LocalEntityId.parse("ent-owner");
const identity: IdentityResolver = {
  resolve: async (mention) => ({
    outcome: "linked",
    entity: mention.key.value === OWNER ? owner : LocalEntityId.parse(`ent:${mention.key.value}`),
    epoch: 0,
  }),
};
const ctx: ItemContext = {
  evidenceId: EvidenceId.parse("ev-store-owner-names"),
  revision: 0,
  compartment: "own",
  ownerAddresses: [OWNER],
  ownerEntity: owner,
  identity,
};

const mail = (from: string, labelIds: string[]): RawItem =>
  gmailItem(
    {
      id: "18c0ffee31",
      threadId: "18c0ffee31",
      internalDate: Date.UTC(2026, 2, 4, 10, 5, 0),
      labelIds,
      headers: [
        { name: "From", value: from },
        { name: "To", value: "Casey Example <casey@example.com>" },
        { name: "Date", value: "Wed, 04 Mar 2026 10:00:00 +0000" },
        { name: "Subject", value: "Notes" },
      ],
    },
    at,
  );
const derive = (raw: RawItem): Promise<ItemFacts> => deriveItem(raw, ctx, PERSONAL_LIMITS);
const withNames = (facts: ItemFacts, ownerNames: unknown): ItemFacts => ({ ...facts, ownerNames }) as ItemFacts;
const refused = (facts: ItemFacts, raw: RawItem): unknown => {
  try {
    checkFacts(facts, raw, ctx);
    return null;
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
};

describe("checkFacts and the owner's own names", () => {
  it("accepts the owner's two-word name on mail they sent, as derive gives it", async () => {
    const raw = mail(`Avery Example <${OWNER}>`, ["SENT"]);
    const facts = await derive(raw);
    expect(facts).toMatchObject({ kind: "email", bulk: false, ownerNames: ["Avery Example"] });
    expect(refused(facts, raw)).toBeNull();
  });

  it("refuses them on mail the owner did not send, with a one-word or empty name, a name other than the one written with their address, or not a list of one string", async () => {
    const inbound = mail(`Avery Example <${OWNER}>`, ["INBOX"]);
    expect(refused(withNames(await derive(inbound), ["Avery Example"]), inbound)).toBe("invalid_facts");
    const sent = mail(`Avery Example <${OWNER}>`, ["SENT"]);
    const facts = await derive(sent);
    for (const bad of [
      ["Avery"],
      [" Avery "],
      [],
      "Avery Example",
      [7],
      ["Casey Example"],
      ["Avery Example", "Avery Example"],
    ])
      expect(refused(withNames(facts, bad), sent), JSON.stringify(bad)).toBe("invalid_facts");
  });

  it("refuses them on an event, even one the owner organizes", async () => {
    const raw = calendarItem(
      {
        id: "evt-owner-names-1",
        status: "confirmed",
        etag: '"etag-1"',
        updated: "2026-03-01T09:00:00.000Z",
        summary: "Review",
        start: { dateTime: "2026-03-12T15:00:00Z" },
        end: { dateTime: "2026-03-12T16:00:00Z" },
        organizer: { email: OWNER, displayName: "Avery Example", self: true },
        attendees: [{ email: "casey@example.com" }],
      },
      { ...at, now: Timestamp.parse("2026-03-10T12:00:00.000Z") },
    ) as RawItem;
    const facts = await derive(raw);
    expect(facts.kind).toBe("event");
    expect(refused(facts, raw)).toBeNull();
    expect(refused(withNames(facts, ["Avery Example"]), raw)).toBe("invalid_facts");
  });
});
