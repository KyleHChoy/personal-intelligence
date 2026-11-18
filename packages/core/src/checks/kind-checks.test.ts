import { KEY_FIELDS, KIND_REGISTRY, type OwnerSideKind } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { checkKeyFields, factLine } from "./claim-intake.ts";
import { agentInstruction, datedTask, namesPerson } from "./kind-checks.ts";

// The pinned kind rules, each with its code.
const AT = "2026-10-30T12:00:00.000Z";
const situation = (state: string, extra: Record<string, unknown> = {}) => ({ domain: "admin", state, ...extra });
const kinds = { at: AT };

describe("dated_task", () => {
  it("refuses a situation holding a pinned task word, a written date or time, or an until within 14 days", () => {
    for (const state of [
      "dentist appointment",
      "electricity bill due",
      "support ticket open",
      "verification code pending",
      "deadline for the essay",
      "flight on 12 March",
      "call at 3pm",
      "meeting on Friday".replace("meeting", "lunch"),
    ]) {
      expect(checkKeyFields("situation", situation(state), { owner: true, kinds }), state).toEqual({
        reason: "dated_task",
      });
    }
    expect(
      checkKeyFields("situation", situation("staying with family", { until: "2026-11-05" }), { owner: true, kinds }),
    ).toEqual({ reason: "dated_task" });
  });

  it("exempts a circumstance lasting longer, and a situation with no task word or date", () => {
    expect(
      checkKeyFields("situation", situation("passport renewal ticket open", { until: "2027-01-20" }), {
        owner: true,
        kinds,
      }),
    ).toHaveProperty("fields");
    expect(checkKeyFields("situation", situation("on parental leave"), { owner: true, kinds })).toHaveProperty(
      "fields",
    );
    expect(datedTask("between jobs", {}, AT)).toBe(false);
  });

  it("applies to a situation only, and only with kinds: a stored record is checked as before", () => {
    expect(
      checkKeyFields(
        "goal",
        { domain: "career", objective: "meet the deadline for the thesis" },
        { owner: true, kinds },
      ),
    ).toHaveProperty("fields");
    expect(checkKeyFields("situation", situation("dentist appointment"), { owner: true })).toHaveProperty("fields");
  });
});

describe("agent_instruction", () => {
  it("refuses a preference, constraint or situation naming an agent or its tool, or a client the owner registered", () => {
    expect(
      checkKeyFields(
        "preference",
        { domain: "admin", object: "the travel site's autofill", polarity: "prefers" },
        { owner: true, kinds },
      ),
    ).toEqual({ reason: "agent_instruction" });
    expect(
      checkKeyFields("constraint", { domain: "admin", rule: "assistant drafts only" }, { owner: true, kinds }),
    ).toEqual({ reason: "agent_instruction" });
    expect(
      checkKeyFields("situation", { domain: "admin", state: "testing a new agent" }, { owner: true, kinds }),
    ).toEqual({ reason: "agent_instruction" });
    expect(agentInstruction("Juniper drafts replies", false, ["Juniper"])).toBe(true);
  });

  it("refuses an opening imperative in a preference or a constraint, never a goal", () => {
    expect(
      checkKeyFields(
        "preference",
        { domain: "admin", object: "check the order page first", polarity: "prefers" },
        { owner: true, kinds },
      ),
    ).toEqual({ reason: "agent_instruction" });
    expect(
      checkKeyFields("constraint", { domain: "admin", rule: "always draft before sending" }, { owner: true, kinds }),
    ).toEqual({ reason: "agent_instruction" });
    expect(
      checkKeyFields("goal", { domain: "career", objective: "use data to pick a market" }, { owner: true, kinds }),
    ).toHaveProperty("fields");
    expect(
      checkKeyFields(
        "preference",
        { domain: "career", object: "AI startups", polarity: "prefers" },
        { owner: true, kinds },
      ),
    ).toHaveProperty("fields");
  });
});

describe("not_about_owner", () => {
  it("refuses an owner's fact naming a person the store resolved, written with its capitals", () => {
    expect(
      checkKeyFields(
        "situation",
        { domain: "ventures", state: "waiting on Dana Reyes for the term sheet" },
        { owner: true, kinds: { at: AT, people: ["Dana Reyes"] } },
      ),
    ).toEqual({ reason: "not_about_owner" });
    expect(namesPerson("will the market turn", ["Will"])).toBe(false);
    expect(namesPerson("lunch with Al", ["Al"])).toBe(false);
  });

  it("never refuses a person's own fact, and a pronoun stays not_standalone", () => {
    expect(
      checkKeyFields(
        "situation",
        { domain: "ventures", state: "waiting on Dana Reyes" },
        { owner: false, kinds: { at: AT, people: ["Dana Reyes"] } },
      ),
    ).toHaveProperty("fields");
    expect(
      checkKeyFields("situation", { domain: "ventures", state: "waiting on her reply" }, { owner: true, kinds }),
    ).toEqual({ reason: "not_standalone" });
  });
});

describe("the view, status and visited kinds' fields", () => {
  it("a status names its organization and state within the bounds; a view's topic is bounded", () => {
    expect(
      checkKeyFields(
        "status",
        { domain: "travel", organization_name: "Consulate", process: "visa application", state: "in review" },
        { owner: true, kinds },
      ),
    ).toHaveProperty("fields");
    expect(
      checkKeyFields("status", { domain: "travel", process: "visa application", state: "in review" }, { owner: true }),
    ).toEqual({ reason: "bad_fields" });
    expect(
      checkKeyFields(
        "view",
        { domain: "career", view: "remote teams ship faster", topic: "x ".repeat(40) },
        { owner: true },
      ),
    ).toEqual({ reason: "bad_fields" });
    expect(
      checkKeyFields("visited", { domain: "travel", place: "Lisbon", when: "2026-03-10" }, { owner: true, kinds }),
    ).toHaveProperty("fields");
  });

  it("each renders as a line", () => {
    expect(factLine("view", { view: "remote teams ship faster", topic: "remote work" })).toBe(
      "View on remote work: remote teams ship faster",
    );
    expect(
      factLine("status", { organization_name: "Consulate", process: "visa application", state: "in review" }),
    ).toBe("Consulate, visa application: in review");
    expect(factLine("visited", { place: "Lisbon", when: "2026-03-10" })).toBe("Visited: Lisbon, in 2026-03-10");
  });
});

// The kind registry's examples, held to the checks: each good example of a
// kind with a key phrase passes as that kind; each bad one with a refusal code is refused by it.
describe("the kind registry's examples", () => {
  const guide = KIND_REGISTRY;
  const fieldsOf = (kind: OwnerSideKind, text: string): Record<string, unknown> => ({
    domain: "admin",
    [KEY_FIELDS[kind].phrase]: text,
    ...(kind === "preference" ? { polarity: "prefers" } : {}),
    ...(kind === "status" ? { organization_name: "Example Co", state: "open" } : {}),
  });
  const phrased = (kind: string): kind is OwnerSideKind => Object.hasOwn(KEY_FIELDS, kind) && kind !== "status";

  it("each good example passes as its kind", () => {
    for (const [kind, entry] of Object.entries(guide.kinds)) {
      if (!phrased(kind)) continue;
      for (const text of entry.good)
        expect(checkKeyFields(kind, fieldsOf(kind, text), { owner: true, kinds }), `${kind}: ${text}`).toHaveProperty(
          "fields",
        );
    }
  });

  it("each bad example with a refusal is refused with that code", () => {
    for (const [kind, entry] of Object.entries(guide.kinds)) {
      for (const bad of entry.bad) {
        if (bad.refusal === undefined || !phrased(kind)) continue;
        expect(checkKeyFields(kind, fieldsOf(kind, bad.text), { owner: true, kinds }), `${kind}: ${bad.text}`).toEqual({
          reason: bad.refusal,
        });
      }
    }
  });
});
