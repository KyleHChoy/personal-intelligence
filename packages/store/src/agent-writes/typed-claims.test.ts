import type { EntityId, RequestId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { checkProjectTyped, checkTyped, ownerCounterparty } from "./typed-claims.ts";

// The code checks of a typed claim, each refusal by its own code.
const base = {
  subject: { id: "ent_01J00000000000000000000000" as EntityId },
  cites: [],
  requestId: "typed-unit-1" as RequestId,
};

describe("typed claim checks", () => {
  it("refuses an unknown type and fields outside the type's, fields_invalid", () => {
    expect(checkTyped({ ...base, type: "favourite_colour", fields: { colour: "blue" } }, false)).toEqual({
      code: "fields_invalid",
    });
    expect(checkTyped({ ...base, type: "role", fields: { title: "head of research", salary: "high" } }, false)).toEqual(
      { code: "fields_invalid" },
    );
    expect(checkTyped({ ...base, type: "project.status", fields: { status: "active" } }, false)).toEqual({
      code: "fields_invalid",
    });
  });

  it("takes a project's own kinds by their fields, and refuses any other type or field", () => {
    expect(checkProjectTyped({ ...base, type: "project.status", fields: { status: "waiting" } })).toEqual({
      args: { type: "project.status" },
      fields: { status: "waiting" },
    });
    expect(
      checkProjectTyped({ ...base, type: "project.decision", fields: { what: "Fire the kiln in March." } }),
    ).toEqual({ args: { type: "project.decision" }, fields: { what: "Fire the kiln in March." } });
    // A source's word for a status is not one an agent sets, and a role is no project kind.
    expect(checkProjectTyped({ ...base, type: "project.status", fields: { status: "cancelled" } })).toEqual({
      code: "fields_invalid",
    });
    expect(checkProjectTyped({ ...base, type: "project.next_step", fields: { what: "Order the brick." } })).toEqual({
      code: "fields_invalid",
    });
    expect(checkProjectTyped({ ...base, type: "role", fields: { title: "head of research" } })).toEqual({
      code: "fields_invalid",
    });
  });

  it("passes an owner-side kind's key fields through the claim intake's check, with its own code", () => {
    expect(
      checkTyped({ ...base, type: "goal", fields: { domain: "career", objective: "raise a seed round" } }, true),
    ).toMatchObject({ fields: { domain: "career", objective: "raise a seed round" } });
    expect(
      checkTyped(
        {
          ...base,
          type: "goal",
          fields: { domain: "career", objective: "raise a seed round and hire a team and buy an office" },
        },
        true,
      ),
    ).toEqual({ code: "multi_fact" });
  });

  it("takes a person's relationship with its counterparty's id", () => {
    expect(
      checkTyped(
        {
          ...base,
          type: "relationship",
          fields: { counterparty: "ent_01J00000000000000000000001", relation: "colleague" },
        },
        false,
      ),
    ).toMatchObject({ fields: { relation: "colleague" } });
  });
});

// Who a person is to the owner is propose_person's. A finding's typed
// relationship whose counterparty is the owner is refused subject_is_owner; another's is taken.
describe("a relationship with the owner on a finding", () => {
  const OWNER = "ent_01J00000000000000000000009";
  const OTHER = "ent_01J00000000000000000000001";
  const JOINED = "ent_01J00000000000000000000008";
  it("is refused, by the owner's id or one their identity group joins; a relationship between two others, or a commitment with the owner, is not", () => {
    expect(ownerCounterparty("relationship", { counterparty: OWNER, relation: "mentor" }, [OWNER])).toBe(true);
    expect(ownerCounterparty("relationship", { counterparty: JOINED, relation: "mentor" }, [OWNER, JOINED])).toBe(true);
    expect(ownerCounterparty("relationship", { counterparty: OTHER, relation: "mentor" }, [OWNER, JOINED])).toBe(false);
    expect(ownerCounterparty("commitment", { counterparty: OWNER, what: "send the deck" }, [OWNER])).toBe(false);
    expect(ownerCounterparty("relationship", { counterparty: OWNER, relation: "mentor" }, [])).toBe(false);
  });
});
