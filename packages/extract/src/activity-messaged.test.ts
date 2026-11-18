import { LocalEntityId } from "@intelligence/contracts";
import { EntityId, type OpenedMoment } from "@intelligence/contracts/personal";
import { describe, expect, it, vi } from "vitest";
import { messagedPeople } from "./activity.ts";

const LENA = LocalEntityId.parse(EntityId.parse("ent_01JACTVTYP0000000000000011"));
const HANDLE = "+15550100123";
const END = "2026-10-20T12:00:00.000Z";

const opened = (
  resolve: (request: { key: { kind: string; value: string } }) => { outcome: string; entity?: LocalEntityId },
  source: "imessage" | null = "imessage",
): OpenedMoment =>
  ({
    item: {
      entity: "chat",
      read: source === null ? "ax" : "db",
      ...(source === null ? {} : { source }),
      turns: [{ from: 0, to: 4, speaker: "owner" }],
    },
    capture: {
      agentApp: false,
      endedAt: END,
      observedAt: END,
      facts: { participants: [{ handle: HANDLE }], pushedAt: END, ...(source === null ? {} : { source }) },
    },
    context: {
      evidenceId: "a".repeat(64),
      revision: 0,
      ownerEntity: "ent_owner",
      identity: { resolve: vi.fn(async (request) => resolve(request)) },
    },
    kindOf: () => "person",
  }) as unknown as OpenedMoment;

describe("whom the owner messaged, by a phone handle", () => {
  it("a source moment's handle counts by its phone key", async () => {
    const moment = opened(({ key }) =>
      key.kind === "address" && key.value.includes("5550100123")
        ? { outcome: "linked", entity: LENA }
        : { outcome: "none" },
    );
    expect(await messagedPeople(moment)).toEqual([LENA]);
  });

  it("and by the participant step's binding of it", async () => {
    const moment = opened(({ key }) =>
      key.kind === "name" && key.value === HANDLE ? { outcome: "linked", entity: LENA } : { outcome: "none" },
    );
    expect(await messagedPeople(moment)).toEqual([LENA]);
  });

  it("an unbound handle makes none, and a screen moment's handle names nobody", async () => {
    expect(await messagedPeople(opened(() => ({ outcome: "none" })))).toEqual([]);
    const screen = opened(() => ({ outcome: "linked", entity: LENA }), null);
    expect(await messagedPeople(screen)).toEqual([]);
  });
});
