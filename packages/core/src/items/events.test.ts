import { describe, expect, it } from "vitest";
import { PipelineError } from "../claim-pipeline/errors.ts";
import { eventOf, readEvent } from "./events.ts";
import type { CalendarEvent, CalendarPerson } from "./types.ts";

// Made-up values on reserved domains, but for Google's three calendar system domains.
const OWNER = ["owner@example.org", "owner.alias@example.com"];

const event: CalendarEvent = {
  id: "evt-review-1",
  status: "confirmed",
  etag: '"etag-1"',
  updated: "2026-03-09T08:00:00.000Z",
  summary: "Review",
  start: { dateTime: "2026-03-12T10:00:00-05:00" },
  end: { dateTime: "2026-03-12T16:00:00Z" },
  organizer: { email: "Alex@Example.com", displayName: "Alex Example" },
  attendees: [
    { email: "owner@example.org", responseStatus: "accepted", self: true },
    { email: "casey@example.com", displayName: "Casey Example", responseStatus: "tentative" },
  ],
};
const withAttendees = (...attendees: CalendarPerson[]): CalendarEvent => ({ ...event, attendees });
const addresses = (read: ReturnType<typeof readEvent>): string[] => read.participants.map((one) => one.person.address);

describe("readEvent's participants", () => {
  it("a room is not a participant", () => {
    const read = readEvent(
      withAttendees(
        { email: "casey@example.com" },
        { email: "room-4@example.org", resource: true, displayName: "Room 4" },
      ),
      OWNER,
    );
    expect(addresses(read)).toEqual(["alex@example.com", "casey@example.com"]);
    // The control: the same address that is no resource is a participant.
    expect(
      addresses(readEvent(withAttendees({ email: "casey@example.com" }, { email: "room-4@example.org" }), OWNER)),
    ).toContain("room-4@example.org");
  });

  it("a group calendar is not a participant", () => {
    const read = readEvent(
      withAttendees(
        { email: "casey@example.com" },
        { email: "c_synthetic1@group.calendar.google.com", displayName: "Team calendar" },
      ),
      OWNER,
    );
    expect(addresses(read)).toEqual(["alex@example.com", "casey@example.com"]);
    // An organizer on one is left out too.
    const organized = readEvent({ ...event, organizer: { email: "c_synthetic1@group.calendar.google.com" } }, OWNER);
    expect(addresses(organized)).toEqual(["owner@example.org", "casey@example.com"]);
    expect(organized.participants.every((one) => one.role === "attendee")).toBe(true);
  });

  it("import and resource calendars are not participants", () => {
    const read = readEvent(
      withAttendees(
        { email: "synthetic2@import.calendar.google.com" },
        { email: "Synthetic3@Resource.Calendar.Google.com" },
        { email: "not an address" },
        { email: "casey@example.com" },
      ),
      OWNER,
    );
    expect(addresses(read)).toEqual(["alex@example.com", "casey@example.com"]);
  });

  it("an organizer missing from attendees is added once", () => {
    const missing = readEvent(event, OWNER);
    expect(missing.participants).toEqual([
      { person: { address: "alex@example.com", name: "Alex Example" }, role: "organizer", owner: false },
      { person: { address: "owner@example.org" }, role: "attendee", owner: true },
      { person: { address: "casey@example.com", name: "Casey Example" }, role: "attendee", owner: false },
    ]);
    // An organizer who is also an attendee is kept once, as the organizer, and each address once.
    const listed = readEvent(
      withAttendees(
        { email: "casey@example.com" },
        { email: "alex@example.com", organizer: true },
        { email: "Casey@Example.com", displayName: "Casey Example" },
      ),
      OWNER,
    );
    expect(listed.participants).toEqual([
      { person: { address: "alex@example.com", name: "Alex Example" }, role: "organizer", owner: false },
      { person: { address: "casey@example.com", name: "Casey Example" }, role: "attendee", owner: false },
    ]);
    // No organizer and no attendees is nobody.
    const { organizer: _organizer, attendees: _attendees, ...alone } = event;
    expect(readEvent(alone, OWNER).participants).toEqual([]);
  });

  it("the owner is marked by self and by address", () => {
    const bySelf = readEvent(
      withAttendees(
        { email: "someone.else@example.com", self: true, responseStatus: "declined" },
        { email: "casey@example.com" },
      ),
      [],
    );
    expect(bySelf.participants.map((one) => one.owner)).toEqual([false, true, false]);
    expect(bySelf.ownerResponse).toBe("declined");
    const byAddress = readEvent(
      withAttendees(
        { email: "casey@example.com", responseStatus: "accepted" },
        { email: "Owner.Alias@Example.com", responseStatus: "tentative" },
      ),
      OWNER,
    );
    expect(byAddress.participants.map((one) => one.owner)).toEqual([false, false, true]);
    // The owner's own response, not the first attendee's.
    expect(byAddress.ownerResponse).toBe("tentative");
    // The owner as organizer, and no response when the owner is no attendee.
    const organized = readEvent(
      {
        ...event,
        organizer: { email: "owner@example.org", self: true },
        attendees: [{ email: "casey@example.com", responseStatus: "accepted" }],
      },
      OWNER,
    );
    expect(organized.participants[0]).toEqual({
      person: { address: "owner@example.org" },
      role: "organizer",
      owner: true,
    });
    expect("ownerResponse" in organized).toBe(false);
  });
});

describe("readEvent's times", () => {
  it("an all-day event is midnight UTC", () => {
    const read = readEvent({ ...event, start: { date: "2026-03-12" }, end: { date: "2026-03-14" } }, OWNER);
    expect([read.allDay, read.startsAt, read.endsAt]).toEqual([
      true,
      "2026-03-12T00:00:00.000Z",
      "2026-03-14T00:00:00.000Z",
    ]);
    // A timed event keeps its instant, written in UTC.
    const timed = readEvent(event, OWNER);
    expect([timed.allDay, timed.startsAt, timed.endsAt]).toEqual([
      false,
      "2026-03-12T15:00:00.000Z",
      "2026-03-12T16:00:00.000Z",
    ]);
  });

  it("an unparseable time is null", () => {
    const read = readEvent({ ...event, start: { dateTime: "next Thursday" }, end: { date: "2026-02-30" } }, OWNER);
    expect([read.startsAt, read.endsAt]).toEqual([null, null]);
    // A missing time is null too.
    const { end: _end, ...open } = event;
    const missing = readEvent({ ...open, start: {} }, OWNER);
    expect([missing.allDay, missing.startsAt, missing.endsAt]).toEqual([false, null, null]);
  });

  it("a time that is not a timestamp once written in UTC is null", () => {
    // Each is a timestamp as given. Written in UTC it falls in a year a timestamp cannot hold.
    for (const dateTime of [
      "9999-12-31T23:59:59-05:00",
      "9999-12-31T20:00:00-23:59",
      "0100-01-01T00:00:00+05:00",
      "0100-01-01T00:00:00+00:01",
    ]) {
      const read = readEvent({ ...event, start: { dateTime } }, OWNER);
      expect(read.startsAt, dateTime).toBeNull();
      // The control: the other time is read.
      expect(read.endsAt, dateTime).toBe("2026-03-12T16:00:00.000Z");
    }
    // The controls: the first and the last instants a timestamp holds are kept.
    const edges = readEvent(
      { ...event, start: { dateTime: "0100-01-01T05:00:00+05:00" }, end: { dateTime: "9999-12-31T18:59:59-05:00" } },
      OWNER,
    );
    expect([edges.startsAt, edges.endsAt]).toEqual(["0100-01-01T00:00:00.000Z", "9999-12-31T23:59:59.000Z"]);
    // A day in a year a timestamp cannot hold is null, and the first and last days are kept.
    const days = readEvent({ ...event, start: { date: "0050-01-01" }, end: { date: "10000-01-01" } }, OWNER);
    expect([days.allDay, days.startsAt, days.endsAt]).toEqual([true, null, null]);
    const kept = readEvent({ ...event, start: { date: "0100-01-01" }, end: { date: "9999-12-31" } }, OWNER);
    expect([kept.startsAt, kept.endsAt]).toEqual(["0100-01-01T00:00:00.000Z", "9999-12-31T00:00:00.000Z"]);
  });

  it("a dateTime without an offset is null", () => {
    const read = readEvent({ ...event, start: { dateTime: "2026-03-12T15:00:00" } }, OWNER);
    expect(read.startsAt).toBeNull();
    // The control: the other time, which has one, is read.
    expect(read.endsAt).toBe("2026-03-12T16:00:00.000Z");
  });
});

describe("readEvent and cancellation", () => {
  it("a cancelled event keeps its participants", () => {
    const read = readEvent({ ...event, status: "cancelled" }, OWNER);
    expect(read.cancelled).toBe(true);
    expect(read.participants).toEqual(readEvent(event, OWNER).participants);
    expect(readEvent(event, OWNER).cancelled).toBe(false);
  });

  it("readEvent refuses a bare cancellation", () => {
    let refused: unknown;
    try {
      readEvent({ id: "evt-gone-1", status: "cancelled" }, OWNER);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(PipelineError);
    expect((refused as PipelineError).code).toBe("parse_failed");
    // The control: the same event with a start is read.
    expect(readEvent({ id: "evt-gone-1", status: "cancelled", start: { date: "2026-03-12" } }, OWNER).sourceId).toBe(
      "evt-gone-1",
    );
  });
});

describe("readEvent's own fields", () => {
  it("revision is the etag, else updated, else null", () => {
    const { etag: _etag, ...untagged } = event;
    const { updated: _updated, ...bare } = untagged;
    expect(readEvent(event, OWNER).revision).toBe('"etag-1"');
    expect(readEvent(untagged, OWNER).revision).toBe("2026-03-09T08:00:00.000Z");
    expect(readEvent(bare, OWNER).revision).toBeNull();
  });

  it("the title is the summary, unchanged, else null", () => {
    const { summary: _summary, ...untitled } = event;
    expect(readEvent(event, OWNER).title).toBe("Review");
    expect(readEvent(untitled, OWNER).title).toBeNull();
    expect(readEvent(event, OWNER).sourceId).toBe("evt-review-1");
  });

  it("a stored payload's call and calendar links come through to the facts, and none is none", () => {
    const linked: CalendarEvent = {
      ...event,
      callLink: "https://meet.google.com/aaa-bbbb-ccc",
      inviteLink: "https://calendar.google.com/calendar/event?eid=fake",
    };
    const stored = eventOf(new TextEncoder().encode(JSON.stringify(linked)));
    expect(readEvent(stored, OWNER)).toMatchObject({
      callLink: "https://meet.google.com/aaa-bbbb-ccc",
      inviteLink: "https://calendar.google.com/calendar/event?eid=fake",
    });
    expect(readEvent(event, OWNER)).not.toHaveProperty("callLink");
    expect(readEvent(event, OWNER)).not.toHaveProperty("inviteLink");
    // A stored link that is not https is no link.
    const plain = eventOf(
      new TextEncoder().encode(JSON.stringify({ ...event, callLink: "http://meet.example.test/x" })),
    );
    expect(plain).not.toHaveProperty("callLink");
  });

  it("the same event gives deep-equal facts and is left unchanged", () => {
    const before = structuredClone(event);
    expect(readEvent(event, OWNER)).toEqual(readEvent(event, OWNER));
    expect(event).toEqual(before);
  });
});
