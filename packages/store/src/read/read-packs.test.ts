import type { DataKey } from "@intelligence/contracts";
import type { PersonalLogEvent, PersonalLogger } from "@intelligence/contracts/personal";
import { AgentRecordId, EntityView, type MeetingView, PackEntity } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import type { Ctx } from "../core/read-ctx.ts";
import { packEntity, type RecordRow, recordItem } from "./read-pack-items.ts";

// What the pack does with an agent record whose body does not open, with no database.

const REC = "rec_01HZZZZZZZZZZZZZZZZZZZZZZZ";
const row: RecordRow = {
  id: AgentRecordId.parse(REC),
  kind: "note",
  client_name: "alpha",
  created_at: new Date("2026-03-10T12:00:00.000Z"),
  compartments: ["own"],
  body_enc: { v: 1, nonce: "", ciphertext: "", tag: "" },
};

function ctxWith(compartments: Map<string, DataKey>): { ctx: Ctx; events: PersonalLogEvent[] } {
  const events: PersonalLogEvent[] = [];
  const log: PersonalLogger = {
    info: (e) => events.push(e),
    warn: (e) => events.push(e),
    error: (e) => events.push(e),
  };
  return {
    ctx: {
      run: () => Promise.reject(new Error("no query")),
      keys: { compartments, fingerprintKey: Buffer.alloc(32) },
      session: () => Promise.reject(new Error("no session")),
      log,
    },
    events,
  };
}

describe("recordItem", () => {
  it("a body that does not open is left out, and logs pack_record_skipped with the record and the client", () => {
    const { ctx, events } = ctxWith(new Map());
    expect(recordItem(ctx, row, "notes", false, undefined)).toBeNull();
    expect(events).toEqual([{ event: "pack_record_skipped", ids: { record: REC, client: "alpha" } }]);
  });

  it("any other error is thrown, and logs nothing", () => {
    const { ctx, events } = ctxWith(new Map([["own", "not a key" as DataKey]]));
    expect(() => recordItem(ctx, row, "notes", false, undefined)).toThrow();
    expect(events).toEqual([]);
  });
});

describe("packEntity (person_brief's person item)", () => {
  const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
  const who = (n: number) => ({
    id: `ent_${ULID.slice(0, 22)}${n.toString().padStart(4, "0")}`,
    kind: "person",
    name: null,
    address: { untrusted: `p${n}@example.com` },
  });
  const meeting = (count: number): MeetingView =>
    ({
      id: `evt_${ULID}`,
      title: { untrusted: "Review" },
      startsAt: "2026-03-11T10:00:00Z",
      endsAt: "2026-03-11T11:00:00Z",
      allDay: false,
      cancelled: false,
      participants: Array.from({ length: count }, (_, n) => who(n)),
    }) as MeetingView;
  const view = (last: MeetingView | null, next: MeetingView | null): EntityView =>
    EntityView.parse({
      id: `ent_${ULID}`,
      kind: "person",
      names: [{ untrusted: "Alex Example" }],
      addresses: [{ untrusted: "alex@example.com" }],
      organization: null,
      people: [],
      mail: { inbound: 1, outbound: 0, firstAt: null, lastAt: null },
      lastMeeting: last,
      nextMeeting: next,
      details: [],
      shared: false,
      facts: { beliefs: [], claims: [], more: false },
    });

  it("is get_entity's view without its facts, each meeting's participants cut to 25 as a pack's meetings are", () => {
    const entity = packEntity(view(meeting(30), meeting(3)));
    expect(PackEntity.parse(entity)).toEqual(entity);
    expect("facts" in entity).toBe(false);
    expect(entity.lastMeeting?.participants).toHaveLength(25);
    expect(entity.lastMeeting?.participants.map((one) => one.id)).toEqual(
      meeting(30)
        .participants.slice(0, 25)
        .map((one) => one.id),
    );
    expect(entity.nextMeeting?.participants).toHaveLength(3);
    expect(packEntity(view(null, null))).toMatchObject({ lastMeeting: null, nextMeeting: null });
  });
});
