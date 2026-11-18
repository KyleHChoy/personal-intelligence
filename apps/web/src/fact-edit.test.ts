import { kindsWhere, RULABLE_KINDS } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { correctionOf, heldWords, kindsOf, RULABLE, retirable } from "./fact-edit.tsx";

// What a fact's Edit offers and sends.
describe("a fact's Edit", () => {
  it("offers a type only among the kinds the registry lets a ruling change, never from a status or a visit", () => {
    expect([...RULABLE]).toEqual([...RULABLE_KINDS]);
    const rulable: string[] = kindsWhere("rulable");
    expect([...RULABLE].sort()).toEqual([...rulable].sort());
    for (const kind of ["status", "visited", "role", "affiliation"]) expect(kindsOf(kind)).toEqual([]);
    expect(kindsOf("preference")).toEqual(["preference", ...RULABLE]);
    expect(kindsOf("goal")[0]).toBe("goal");
    expect(retirable("visited")).toBe(false);
    expect(retirable("situation")).toBe(true);
  });

  it("sends a status's three fields together, and a role's organization only when the owner names it or it is a name", () => {
    const status = {
      what: { untrusted: "application" },
      organization_name: { untrusted: "Sample College" },
      state: { untrusted: "under review" },
    };
    const held = heldWords("status", status, "");
    expect(correctionOf("status", status, held, { ...held, state: "accepted" })).toEqual({
      value: { organization_name: "Sample College", process: "application", state: "accepted" },
      corrected: "accepted",
    });

    const linked = {
      title: { untrusted: "Head" },
      organization: { id: "ent_1", kind: "organization", name: { untrusted: "Sample Works" }, address: null },
    };
    const roleHeld = heldWords("role", linked, "");
    expect(roleHeld).toEqual({ title: "Head", organization_name: "Sample Works" });
    expect(correctionOf("role", linked, roleHeld, { ...roleHeld, title: "Chief" }).value).toEqual({ title: "Chief" });
    expect(correctionOf("role", linked, roleHeld, { ...roleHeld, organization_name: "Other Works" })).toEqual({
      value: { title: "Head", organization_name: "Other Works" },
      corrected: "Other Works",
    });
    // A name beside a link is not sent unless the owner changes it: sent, it would replace the link.
    const both = { ...linked, organization_name: { untrusted: "Sample Works Ltd" } };
    expect(
      correctionOf("role", both, heldWords("role", both, ""), { title: "Chief", organization_name: "Sample Works Ltd" })
        .value,
    ).toEqual({ title: "Chief" });
    // Emptied, an organization is no change: the store keeps the one it links.
    expect(correctionOf("role", linked, roleHeld, { ...roleHeld, organization_name: "" })).toEqual({
      value: { title: "Head" },
      corrected: "",
    });
    const named = { title: { untrusted: "Head" }, organization_name: { untrusted: "Sample Works" } };
    expect(
      correctionOf("role", named, heldWords("role", named, ""), { title: "Chief", organization_name: "Sample Works" })
        .value,
    ).toEqual({ title: "Chief", organization_name: "Sample Works" });
  });
});
