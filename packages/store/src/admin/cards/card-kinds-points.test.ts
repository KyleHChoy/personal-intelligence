import { currentDefinition, DECISION_POINTS } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { CARD_KINDS } from "./card-kinds.ts";

describe("the identity cards and their points", () => {
  it("a same_person card's options equal identity_ruling's outputs, and its kind is the point's queue", () => {
    const ruling = currentDefinition("identity_ruling");
    expect(ruling?.queue).toBe("same_person");
    expect([...(CARD_KINDS.same_person?.options ?? [])].sort()).toEqual(Object.keys(ruling?.outputs ?? {}).sort());
    // The shared address card is a kind of its own, and no point's queue.
    expect(DECISION_POINTS.some((point) => point.queue === "shared_address")).toBe(false);
    expect(CARD_KINDS.shared_address?.options).toEqual(["shared", "one_person"]);
  });
});
