import { describe, expect, it } from "vitest";
import { canaryPlant } from "./plant.ts";

// A day's items carry that day's values, so a read that passes on one day's data proves nothing of
// another's, and only the contact names the contact's person.
describe("canaryPlant", () => {
  const one = canaryPlant("2026-11-04");
  const next = canaryPlant("2026-11-05");

  it("is the same for one day", () => {
    expect(canaryPlant("2026-11-04")).toEqual(one);
  });

  it("keeps the preferred object understandable and uses fresh proposal request IDs", () => {
    const object = `work updates titled "${one.word} status report"`;
    expect(one.proposal.statement).toContain(object);
    expect(one.proposal.quote).toContain(object);
    const previous = ["canary-20261104-propose", "canary-20261104-propose-v2", "canary-20261104-propose-v3"];
    expect(previous).not.toContain(one.proposal.requestId);
    expect(one.proposalAgain.requestId).not.toBe(one.proposal.requestId);
  });

  it("gives the contact's person a name and an address of the day", () => {
    expect(one.people.contact.name).not.toBe(next.people.contact.name);
    expect(one.people.contact.address).not.toBe(next.people.contact.address);
    expect(one.people.contact.address).not.toBe(one.people.mail.address);
  });

  it("a past event gives the contact's person an interaction, and only the contact gives the name", () => {
    const attendee = one.pastEvent.attendees?.find((person) => person.email === one.people.contact.address);
    expect(attendee).toBeDefined();
    expect(attendee?.displayName).toBeUndefined();
    expect(Date.parse(one.pastEvent.start?.dateTime ?? "")).toBeLessThan(Date.parse("2026-11-04T00:00:00Z"));
  });
});
