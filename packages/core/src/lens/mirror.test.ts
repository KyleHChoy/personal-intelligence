import { MirrorEntry } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../json.ts";
import { mirrorEntryValues, mirrorValue } from "./mirror.ts";

// The mirror's normalization. Made-up values only.

const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const at = "2026-10-01T10:00:00Z";
const lee = {
  id: `ent_${ULID}`,
  kind: "person",
  name: { untrusted: "Lee Example" },
  address: { untrusted: "lee@example.com" },
};
const org = {
  ...lee,
  id: `ent_01JABCDEFGHJKMNPQRSTVWXYZ1`,
  kind: "organization",
  name: { untrusted: "Example Works" },
  address: null,
};
const meeting = {
  id: `evt_${ULID}`,
  title: { untrusted: "Review" },
  startsAt: at,
  endsAt: at,
  allDay: false,
  cancelled: false,
  participants: [lee, org],
};
const entity = {
  id: lee.id,
  kind: "person",
  names: [{ untrusted: "Lee Example" }],
  addresses: [{ untrusted: "lee@example.com" }],
  organization: org,
  people: [],
  mail: { inbound: 3, outbound: 1, firstAt: at, lastAt: at },
  lastMeeting: meeting,
  nextMeeting: null,
  details: [],
  shared: false,
};

describe("mirrorValue", () => {
  it("mirrorValue keeps only the entity id of every Who, and drops an entity's mail, lastMeeting and nextMeeting", () => {
    expect(mirrorValue(meeting)).toEqual({
      ...meeting,
      participants: [
        { ...lee, name: null, address: null },
        { ...org, name: null, address: null },
      ],
    });
    const normal = mirrorValue(entity) as Record<string, unknown>;
    expect(Object.keys(normal)).not.toContain("mail");
    expect(Object.keys(normal)).not.toContain("lastMeeting");
    expect(Object.keys(normal)).not.toContain("nextMeeting");
    expect(normal.organization).toEqual({ ...org, name: null, address: null });
    // An entity keeps its own names and addresses: they are the entity's, not a Who's.
    expect(normal.names).toEqual(entity.names);
    // Deep: a Who inside a fact's fields, and a value with no Who is unchanged.
    const fact = { subject: lee, fields: { counterparty: lee, what: { untrusted: "Send the deck." } } };
    expect(mirrorValue(fact)).toEqual({
      subject: { ...lee, name: null, address: null },
      fields: { counterparty: { ...lee, name: null, address: null }, what: { untrusted: "Send the deck." } },
    });
    expect(mirrorValue({ capture: `cap_${ULID}`, kind: "meeting" })).toEqual({
      capture: `cap_${ULID}`,
      kind: "meeting",
    });
    // It copies: the value given is not changed.
    expect(meeting.participants[0]?.name).toEqual({ untrusted: "Lee Example" });
  });

  it("mirrorEntryValues is the canonical JSON without the stamp", () => {
    const capture = {
      capture: `cap_${ULID}`,
      key: `meeting:${ULID}`,
      revision: 0,
      kind: "meeting",
      startedAt: at,
      endedAt: null,
      event: null,
    };
    const entry = MirrorEntry.parse({
      section: "captures",
      stamp: { projection: `mir_${"a".repeat(40)}`, fact: null, state: "b".repeat(64) },
      capture,
    }) as Extract<MirrorEntry, { section: "captures" }>;
    expect(mirrorEntryValues(entry)).toBe(canonicalJson({ section: "captures", capture }));
    expect(mirrorEntryValues(entry)).toBe(
      '{"capture":{"capture":"cap_01JABCDEFGHJKMNPQRSTVWXYZ0","endedAt":null,"event":null,"key":"meeting:01JABCDEFGHJKMNPQRSTVWXYZ0","kind":"meeting","revision":0,"startedAt":"2026-10-01T10:00:00Z"},"section":"captures"}',
    );
    // A new stamp changes nothing; a new value does.
    const restamped = { ...entry, stamp: { ...entry.stamp, state: "c".repeat(64) } };
    expect(mirrorEntryValues(restamped)).toBe(mirrorEntryValues(entry));
    expect(mirrorEntryValues({ ...entry, capture: { ...entry.capture, endedAt: at } } as MirrorEntry)).not.toBe(
      mirrorEntryValues(entry),
    );
  });
});
