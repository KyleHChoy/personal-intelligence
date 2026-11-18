import { createHash } from "node:crypto";
import {
  EvidenceId,
  type IdentityResolver,
  InteractionRecord,
  LocalEntityId,
  type Mention,
  type Resolution,
} from "@intelligence/contracts";
import { describe, expect, it } from "vitest";
import { PipelineError } from "../claim-pipeline/errors.ts";
import { THE_OWNER } from "../owner.ts";
import { readEvent } from "./events.ts";
import { meetingRecord } from "./meeting.ts";
import type { CalendarEvent, ItemContext } from "./types.ts";

// Made-up values on reserved domains.
const OWNER = ["owner@example.org", "owner.alias@example.com"];
const ownerEntity = LocalEntityId.parse("ent-owner");
const observedAt = "2026-03-09T08:00:00.000Z";

type Call = { mention: Mention; store: string; requestId: string };

// A local identity port: one entity per exact address, every owner address the owner, and a
// record of what it was asked. `answers` overrides what one address resolves to.
function fakeIdentity(answers: Record<string, Resolution> = {}): IdentityResolver & { calls: Call[] } {
  const entities = new Map<string, LocalEntityId>();
  const calls: Call[] = [];
  return {
    calls,
    resolve: async (mention, store, requestId) => {
      calls.push({ mention, store, requestId });
      const address = mention.key.value;
      const fixed = answers[address];
      if (fixed !== undefined) return fixed;
      if (OWNER.includes(address)) return { outcome: "linked", entity: ownerEntity, epoch: 0 };
      const known = entities.get(address);
      if (known !== undefined) return { outcome: "linked", entity: known, epoch: 0 };
      const entity = LocalEntityId.parse(`ent-${entities.size + 1}`);
      entities.set(address, entity);
      return { outcome: "created", entity, epoch: 0 };
    },
  };
}

const context = (identity: IdentityResolver): ItemContext => ({
  evidenceId: EvidenceId.parse("ev-core-meeting-1"),
  revision: 3,
  compartment: "own",
  ownerAddresses: OWNER,
  ownerEntity,
  identity,
});

const event: CalendarEvent = {
  id: "evt-review-1",
  status: "confirmed",
  summary: "Review",
  start: { dateTime: "2026-03-12T15:00:00Z" },
  end: { dateTime: "2026-03-12T16:00:00Z" },
  organizer: { email: "alex@example.com", displayName: "Alex Example" },
  attendees: [
    { email: "owner@example.org", responseStatus: "accepted", self: true },
    { email: "casey@example.com", displayName: "Casey Example" },
    { email: "blair@example.org" },
  ],
};

describe("meetingRecord", () => {
  it("a meeting record is a calendar meeting at the start time", async () => {
    const identity = fakeIdentity();
    const ctx = context(identity);
    const meeting = await meetingRecord(readEvent(event, OWNER), ctx, observedAt);
    const [alex, casey, blair] = ["ent-1", "ent-2", "ent-3"].map((id) => LocalEntityId.parse(id));
    expect(meeting.record).toEqual({
      evidenceId: ctx.evidenceId,
      occurredAt: "2026-03-12T15:00:00.000Z",
      channel: "calendar",
      direction: "meeting",
      teamRecipients: [THE_OWNER],
      participants: [alex, casey, blair],
    });
    expect(InteractionRecord.safeParse(meeting.record).success).toBe(true);
    expect("sent" in meeting.record).toBe(false);
    expect(meeting.participants).toEqual([
      { entity: alex, role: "organizer" },
      { entity: casey, role: "participant" },
      { entity: blair, role: "participant" },
    ]);
    expect(meeting.names).toEqual([
      { entity: alex, name: "Alex Example" },
      { entity: casey, name: "Casey Example" },
    ]);
    // Each is asked as an address mention for the People store, under a request id that names
    // where the address stood among the event's participants, never what it was.
    const requestId = (index: number): string =>
      createHash("sha256")
        .update(JSON.stringify([ctx.evidenceId, 3, 0, "participant", index]), "utf8")
        .digest("hex");
    expect(identity.calls).toEqual([
      {
        mention: { key: { kind: "address", value: "alex@example.com" }, observedAt },
        store: "people",
        requestId: requestId(0),
      },
      {
        mention: { key: { kind: "address", value: "casey@example.com" }, observedAt },
        store: "people",
        requestId: requestId(2),
      },
      {
        mention: { key: { kind: "address", value: "blair@example.org" }, observedAt },
        store: "people",
        requestId: requestId(3),
      },
    ]);
    // With no start it happened when it was observed.
    const { start: _start, ...unplaced } = { ...event, status: "tentative" as const };
    expect(
      (await meetingRecord(readEvent(unplaced, OWNER), context(fakeIdentity()), observedAt)).record.occurredAt,
    ).toBe(observedAt);
  });

  it("the owner organizing is the sender, the owner attending is the team recipient", async () => {
    const organizing = await meetingRecord(
      readEvent(
        {
          ...event,
          organizer: { email: "owner@example.org", self: true },
          attendees: [{ email: "casey@example.com" }],
        },
        OWNER,
      ),
      context(fakeIdentity()),
      observedAt,
    );
    expect(organizing.record.sender).toBe(THE_OWNER);
    expect(organizing.record.teamRecipients).toEqual([THE_OWNER]);
    const attending = await meetingRecord(readEvent(event, OWNER), context(fakeIdentity()), observedAt);
    expect("sender" in attending.record).toBe(false);
    expect(attending.record.teamRecipients).toEqual([THE_OWNER]);
    // An event the owner is not on names no member.
    const absent = await meetingRecord(
      readEvent({ ...event, attendees: [{ email: "casey@example.com" }] }, OWNER),
      context(fakeIdentity()),
      observedAt,
    );
    expect("sender" in absent.record).toBe(false);
    expect(absent.record.teamRecipients).toEqual([]);
  });

  it("the owner is never a meeting participant", async () => {
    // The owner by `self`, by address, and as an address the identity port alone knows as the owner's.
    const read = readEvent(
      {
        ...event,
        attendees: [
          { email: "someone.else@example.com", self: true },
          { email: "owner.alias@example.com" },
          { email: "casey@example.com" },
          { email: "third.alias@example.com" },
        ],
      },
      OWNER,
    );
    const identityWithThird = fakeIdentity({
      "third.alias@example.com": { outcome: "linked", entity: ownerEntity, epoch: 0 },
    });
    const meeting = await meetingRecord(read, context(identityWithThird), observedAt);
    expect(meeting.record.participants).toEqual([LocalEntityId.parse("ent-1"), LocalEntityId.parse("ent-2")]);
    expect(meeting.participants.map((one) => one.entity)).not.toContain(ownerEntity);
    expect(meeting.names.map((one) => one.entity)).not.toContain(ownerEntity);
    // The addresses marked as the owner's are not asked about at all.
    expect(identityWithThird.calls.map((call) => call.mention.key.value)).toEqual([
      "alex@example.com",
      "casey@example.com",
      "third.alias@example.com",
    ]);
    // The control: read with no owner, the same address is asked about and is a participant.
    const stranger = LocalEntityId.parse("ent-9");
    const identity = fakeIdentity({ "owner.alias@example.com": { outcome: "created", entity: stranger, epoch: 0 } });
    const open = await meetingRecord(
      readEvent({ ...event, attendees: [{ email: "owner.alias@example.com" }, { email: "casey@example.com" }] }, []),
      { ...context(identity), ownerAddresses: [] },
      observedAt,
    );
    expect(identity.calls.map((call) => call.mention.key.value)).toContain("owner.alias@example.com");
    expect(open.record.participants).toEqual([LocalEntityId.parse("ent-1"), stranger, LocalEntityId.parse("ent-2")]);
  });

  it("an identity failure is control_unavailable", async () => {
    const failing: IdentityResolver = {
      resolve: async () => {
        throw new Error("connection lost to alex@example.com");
      },
    };
    let refused: unknown;
    try {
      await meetingRecord(readEvent(event, OWNER), context(failing), observedAt);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(PipelineError);
    expect((refused as PipelineError).code).toBe("control_unavailable");
    expect((refused as PipelineError).message).toBe("control_unavailable");
    // An address the port will not link is left out, and is no failure.
    const partial = fakeIdentity({
      "casey@example.com": { outcome: "not_a_person" },
      "blair@example.org": { outcome: "suppressed" },
    });
    const meeting = await meetingRecord(readEvent(event, OWNER), context(partial), observedAt);
    expect(meeting.participants).toEqual([{ entity: LocalEntityId.parse("ent-1"), role: "organizer" }]);
  });
});
