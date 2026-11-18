import type { MeetingCaptureFacts } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { attendeeAddress, attendeeAddresses } from "./meeting-owner.ts";

// Made-up people on reserved domains.

const facts = (over: Partial<MeetingCaptureFacts> = {}): MeetingCaptureFacts => ({
  kind: "meeting",
  title: null,
  consent: true,
  mode: "call",
  calendar: null,
  speakers: [],
  linked: null,
  ...over,
});
const calendar = (attendees: { name?: string; address?: string }[]): Partial<MeetingCaptureFacts> => ({
  calendar: { title: null, uid: null, organizer: null, attendees },
});

describe("attendeeAddress", () => {
  it("the one calendar attendee of a whole name, in any case or spacing, gives their email", () => {
    const one = facts(calendar([{ name: "Robin  Vale", address: "robin.vale@example.org" }]));
    expect(attendeeAddress(one, " robin vale")).toBe("robin.vale@example.org");
    expect(attendeeAddress(one, "Robin")).toBeNull();
  });

  it("the same email listed by the calendar and typed by the owner is one person; two emails of a name are namesakes and give none", () => {
    const twice = facts({
      ...calendar([{ name: "Robin Vale", address: "Robin.Vale@example.org" }]),
      attendees: [{ name: "Robin Vale", address: "robin.vale@example.org" }, { name: "Robin Vale" }],
    });
    expect(attendeeAddress(twice, "Robin Vale")).toBe("Robin.Vale@example.org");
    const namesakes = facts({
      ...calendar([{ name: "Rowan Hale", address: "rowan.hale@example.org" }]),
      attendees: [{ name: "rowan hale", address: "r.hale@example.net" }],
    });
    expect(attendeeAddresses(namesakes, "Rowan Hale")).toHaveLength(2);
    expect(attendeeAddress(namesakes, "Rowan Hale")).toBeNull();
    expect(attendeeAddress(facts(), "Rowan Hale")).toBeNull();
  });
});
