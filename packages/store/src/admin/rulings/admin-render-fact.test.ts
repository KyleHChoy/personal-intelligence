import { ClaimRecord, type FactId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import type { AdminContext } from "../../core/admin-context.ts";
import { type ClaimRow, renderFact } from "./admin-rulings.ts";

// `pi facts show` on an owner-side claim with a key phrase, such as the moment lane's capability
// from a source moment: the phrase (`object`, `objective`, `rule` or `state`) cannot go into
// FactView as it is stored, which FactView's strict fields refuse, so it is served as `what`, as
// find_facts serves it (read-facts.ts). Synthetic values only; no database:
// every statement answers no row, so the owner is known by the record's subject kind alone.

const OWNER = "ent_01JMMNTSAA0000000000000001";
const LENA = "ent_01JMMNTSAA0000000000000002";
const EVIDENCE = "e".repeat(64);
const admin = {
  keys: {},
  log: { info: () => undefined, warn: () => undefined, error: () => undefined },
} as unknown as AdminContext;
const none = async (): Promise<never[]> => [];

// A claim as the moment lane writes one for an owner's line of a source moment: the owner's word,
// dated by the message's own time, citing its passage's `seg:` span.
const record = (
  type: string,
  fields: Record<string, unknown>,
  fieldKinds: Record<string, string>,
  subjectKind = "owner",
): ClaimRecord =>
  ClaimRecord.parse({
    claim: {
      id: "c".repeat(64),
      content: { type, subject: subjectKind === "owner" ? OWNER : LENA, fields },
      statementKind: "stated_fact",
      basis: "explicit_self",
      assertedBy: OWNER,
      validFrom: "2026-10-20T15:00:00.000Z",
      evidence: [{ evidenceId: EVIDENCE, span: "seg:0-85" }],
      primaryEvidenceId: EVIDENCE,
      label: { compartments: ["own"], readers: ["m-owner"] },
      destination: "personal",
      pipelineVersion: "1",
      extractorGeneration: 5,
      changeKind: "live",
      systemOriginated: false,
      origin: "source",
      identityEpoch: 0,
    },
    subjectKind,
    disclosure: [],
    factKey: "fact-bowls",
    lane: "moment",
    fieldKinds,
    entities: [],
    origin: "source",
    answersSystem: false,
  });
const row = (type: string): ClaimRow =>
  ({
    id: "c".repeat(64) as FactId,
    type,
    valid_from: new Date("2026-10-20T15:00:00.000Z"),
    fact_key_fp: "f".repeat(64),
    content_enc: null,
    compartments: ["own"],
    source_account_id: "acc",
    source_item_fp: "i",
    message_id: null,
    document_id: null,
    agent_app: false,
  }) as ClaimRow;

describe("renderFact", () => {
  it("marks the owner's own line in a chat with an agent, on the owner's pages as on find_facts", async () => {
    const query = (async (text: string) =>
      text === "select id from knowledge.entities where kind = 'owner'"
        ? [{ id: OWNER }]
        : []) as unknown as Parameters<typeof renderFact>[1];
    const said = record(
      "goal",
      { objective: "open a studio", domain: "ventures" },
      { objective: "text", domain: "enum" },
    );
    const line = await renderFact(admin, query, { ...row("goal"), agent_app: true }, said);
    expect(line).toMatchObject({ sourceMark: "agent_chat", agentReported: false });
    // Any other chat's line has none, and an agent's line in that chat stays an agent's.
    expect((await renderFact(admin, query, row("goal"), said)).sourceMark).toBeUndefined();
    const { assertedBy: _said, ...unsaid } = said.claim;
    const nobody = { ...said, claim: unsaid } as typeof said;
    const agents = await renderFact(admin, query, { ...row("goal"), agent_app: true }, nobody);
    expect(agents.sourceMark).toBeUndefined();
    expect(agents.agentReported).toBe(true);
  });

  it("serves an owner-side claim's key phrase as what, beside its domain, for every typed owner-side kind", async () => {
    const capability = await renderFact(
      admin,
      none,
      row("capability"),
      record(
        "capability",
        { object: "throw pretty big bowls", domain: "interests" },
        { object: "text", domain: "enum" },
      ),
    );
    expect(capability.fields).toEqual({ what: { untrusted: "throw pretty big bowls" }, domain: "interests" });
    expect(capability).toMatchObject({
      type: "capability",
      subject: { kind: "owner" },
      basis: "explicit_self",
      at: "2026-10-20T15:00:00.000Z",
    });
    const goal = await renderFact(
      admin,
      none,
      row("goal"),
      record(
        "goal",
        { objective: "open a studio", domain: "ventures", by: "2027-01-01" },
        { objective: "text", domain: "enum", by: "date" },
      ),
    );
    expect(goal.fields).toEqual({ what: { untrusted: "open a studio" }, domain: "ventures", by: "2027-01-01" });
    const situation = await renderFact(
      admin,
      none,
      row("situation"),
      record(
        "situation",
        { state: "moving to Denver", domain: "home", momentary: false },
        { state: "text", domain: "enum", momentary: "boolean" },
      ),
    );
    expect(situation.fields).toEqual({ what: { untrusted: "moving to Denver" }, domain: "home", momentary: false });
  });

  it("the control: a plan's what, and a legacy owner-side claim's what, are served as they are", async () => {
    const legacy = await renderFact(
      admin,
      none,
      row("capability"),
      record("capability", { what: "I design kitchens." }, { what: "text" }),
    );
    expect(legacy.fields).toEqual({ what: { untrusted: "I design kitchens." } });
    const plan = await renderFact(
      admin,
      none,
      row("plan"),
      record("plan", { what: "Dinner at Marlow on Friday.", when: "2026-10-23" }, { what: "text", when: "date" }),
    );
    expect(plan.fields).toEqual({ what: { untrusted: "Dinner at Marlow on Friday." }, when: "2026-10-23" });
  });
});
