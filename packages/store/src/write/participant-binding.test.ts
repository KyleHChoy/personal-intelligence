import type { EntityId, EventId, MeetingCaptureFacts, MomentCaptureFacts } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { momentParticipantsOf, momentPhonesOf, participantsOf } from "./participant-binding.ts";

// Which participants of a meeting's sealed facts the sync's step settles, by
// code alone. Made-up people on reserved domains.

const facts = (over: Partial<MeetingCaptureFacts> = {}): MeetingCaptureFacts => ({
  kind: "meeting",
  title: null,
  consent: true,
  mode: "room",
  calendar: null,
  speakers: [],
  linked: null,
  ...over,
});

const none = (): boolean => false;
const OWNER_ADDRESS = "sam.owner@example.org";
const own = (address: string): boolean => address === OWNER_ADDRESS;

describe("participantsOf", () => {
  it("a speaker with a name and no address is settled by name; the owner, a sealed speaker and one an attendee lends an email are not", () => {
    const got = participantsOf(
      facts({
        speakers: [
          { label: "S1", owner: true, mention: { name: "Sam Owner" } },
          { label: "S2", owner: false, mention: { name: "Ivo Brandt" } },
          { label: "S3", owner: false, mention: { name: "Nell Park" } },
          { label: "S4", owner: false, mention: { name: "Tova Lind" } },
          { label: "S5", owner: false, mention: null },
        ],
        linked: {
          event: "evt_01JRPARTBD0000000000000001" as EventId,
          ownerBacked: true,
          speakers: { S3: "ent_01JRPARTBD0000000000000001" as EntityId },
        },
        attendees: [{ name: "tova lind", address: "tova.lind@example.org" }, { name: "Kai Dunn" }],
      }),
      none,
    );
    expect(got.names).toEqual(["Ivo Brandt", "Kai Dunn"]);
    expect(got.addresses).toEqual(["tova.lind@example.org"]);
  });

  it("a name said twice, in another case or spacing, is one; a name the meeting's lists give two emails is namesakes, settled by no name; only strict addresses are read", () => {
    const got = participantsOf(
      facts({
        speakers: [
          { label: "S1", owner: false, mention: { name: "Ivo Brandt" } },
          { label: "S2", owner: false, mention: { name: "Rowan Hale" } },
          { label: "S3", owner: false, mention: { name: "Bea Lowe", address: "Bea Lowe <bea@example.org>" } },
        ],
        attendees: [
          { name: " ivo brandt " },
          { name: " rowan hale " },
          { name: "Rowan Hale", address: "a@example.org" },
        ],
        calendar: {
          title: null,
          uid: null,
          organizer: { address: "org@example.org" },
          attendees: [{ address: "not an address" }, { name: "rowan hale", address: "b@example.org" }],
        },
      }),
      none,
    );
    // Rowan Hale is a@ or b@, and code never chooses: neither the speaker nor the typed name is
    // bound or made a person; the lane files the name.
    expect(got.names).toEqual(["Ivo Brandt"]);
    expect(got.addresses.sort()).toEqual(["a@example.org", "b@example.org", "org@example.org"]);
  });

  it("a speaker the calendar entry's one attendee of the name lends an email is not settled by name", () => {
    const got = participantsOf(
      facts({
        speakers: [{ label: "S2", owner: false, mention: { name: "Tova Lind" } }],
        calendar: {
          title: null,
          uid: null,
          organizer: null,
          attendees: [{ name: "Tova  Lind", address: "tova.lind@example.org" }],
        },
      }),
      none,
    );
    expect(got.names).toEqual([]);
    expect(got.addresses).toEqual(["tova.lind@example.org"]);
  });

  // The owner is decided first. The owner's name, from the speaker the meeting marks as
  // the owner or from any mention of their address, is no participant, in any case or spacing, though a
  // namesake may hold it; nor is their address, typed or heard.
  it("the owner typed or heard by their name or their address is never a participant", () => {
    const got = participantsOf(
      facts({
        speakers: [
          { label: "S1", owner: true, mention: { name: "Sam Owner", address: OWNER_ADDRESS } },
          { label: "S2", owner: false, mention: { name: "sam  owner" } },
          { label: "S3", owner: false, mention: { name: "Ivo Brandt" } },
        ],
        attendees: [{ name: "Sam Owner" }, { name: "Me", address: OWNER_ADDRESS }, { name: "Kai Dunn" }],
      }),
      own,
    );
    expect(got.names).toEqual(["Ivo Brandt", "Kai Dunn"]);
    expect(got.addresses).toEqual([]);
    // Known only by a calendar mention of the owner's address: the same.
    const byCalendar = participantsOf(
      facts({
        attendees: [{ name: "Sam Owner" }],
        calendar: { title: null, uid: null, organizer: { name: "Sam Owner", address: OWNER_ADDRESS }, attendees: [] },
      }),
      own,
    );
    expect(byCalendar).toEqual({ names: [], addresses: [] });
    // The control: with nothing in the meeting naming the owner, the name is a participant's.
    expect(participantsOf(facts({ attendees: [{ name: "Sam Owner" }] }), own).names).toEqual(["Sam Owner"]);
  });
});

// A chat moment's sealed participants, settled as a meeting's are.
const chat = (
  participants: MomentCaptureFacts["participants"],
  entity: MomentCaptureFacts["entity"] = "chat",
): MomentCaptureFacts => ({
  kind: "moment",
  app: { bundle: "test.example.chat", name: "Chat" },
  entity,
  window: null,
  url: null,
  account: null,
  thread: null,
  document: null,
  repository: null,
  participants,
  counts: { chars: 0 },
});

describe("momentParticipantsOf", () => {
  it("a chat's participant with a name and no address is settled by name, a handle naming nobody; its strict addresses are made people; the owner's never", () => {
    const got = momentParticipantsOf(
      chat([
        { name: "Tess Quill", handle: "+15550100" },
        { name: "Arlo Venn" },
        { name: "tess quill" },
        { name: "Bea Lowe", address: "bea@example.org" },
        { handle: "+15550101" },
        { name: "Me", address: OWNER_ADDRESS },
        { name: "Me" },
      ]),
      own,
    );
    expect(got.names).toEqual(["Tess Quill", "Arlo Venn"]);
    expect(got.addresses).toEqual(["bea@example.org"]);
  });

  it("a moment that is no chat names nobody", () => {
    for (const entity of ["doc", "mail", "page"] as const)
      expect(momentParticipantsOf(chat([{ name: "Tess Quill" }], entity), none)).toEqual({ names: [], addresses: [] });
  });
});

describe("momentPhonesOf", () => {
  it("a source moment gives each E.164 handle once, and no address, short code or screen moment's handle", () => {
    const source = (participants: MomentCaptureFacts["participants"]): MomentCaptureFacts => ({
      ...chat(participants),
      app: { bundle: "com.apple.MobileSMS", name: "Messages" },
      source: "imessage",
    });
    expect(
      momentPhonesOf(
        source([
          { handle: "+15555550101" },
          { address: "bea@example.org" },
          { handle: "+15555550102" },
          { handle: "+15555550101" },
          { handle: "55512" },
        ]),
      ),
    ).toEqual(["+15555550101", "+15555550102"]);
    expect(momentPhonesOf(chat([{ handle: "+15555550101" }]))).toEqual([]);
    expect(momentPhonesOf({ ...source([{ handle: "+15555550101" }]), entity: "doc" })).toEqual([]);
  });
});
