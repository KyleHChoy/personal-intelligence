import type { EvidenceId } from "@intelligence/contracts";
import type { ClaimRecord } from "@intelligence/contracts/personal";
import { personalFactKey } from "@intelligence/personal-beliefs";
import { describe, expect, it } from "vitest";
import { ANSWER_PIPELINE, PROPOSAL_PIPELINE, QUOTED_PROPOSAL_PIPELINE } from "./proposal.ts";
import { OWNER_ENTITY } from "./test-support/memory-store.ts";
import {
  recordBody as canonical,
  claimsOf,
  processRecord as process,
  type Setup,
  setup,
} from "./test-support/support.ts";

// No model is ever asked.

const PREFERENCE = {
  kind: "preference",
  fields: { what: "window seats on long flights", polarity: "prefers" },
  scope: "all",
};

function proposal(s: Setup, body: unknown, cites: EvidenceId[] = []): EvidenceId {
  const at = new Date(Date.parse(s.w.now) - 3_600_000).toISOString();
  return s.store.putRecord({
    client: "alpha",
    kind: "proposal",
    body: typeof body === "string" ? body : canonical(body),
    recordedAt: at as never,
    cites,
  });
}

describe("a proposal in the agent lane", () => {
  it("a proposal makes no model request", async () => {
    const s = await setup();
    const id = proposal(s, PREFERENCE);
    expect(await process(s, id)).toMatchObject({ status: "done", claims: 1, live: false });
    expect(s.calls).toEqual([]);
    expect(s.requests).toEqual([]);
  });

  it("the claim's subject is the owner, its origin agent_record, its basis third_party", async () => {
    const s = await setup();
    const id = proposal(s, PREFERENCE);
    await process(s, id);
    const [record] = claimsOf(s, id);
    expect(record).toMatchObject({
      origin: "agent_record",
      lane: "agent",
      subjectKind: "owner",
      disclosure: [],
      entities: [],
      answersSystem: false,
    });
    expect(record?.claim.content).toEqual({
      type: "preference",
      subject: OWNER_ENTITY,
      fields: { what: "window seats on long flights", polarity: "prefers" },
    });
    expect(record?.claim.basis).toBe("third_party");
    expect(record?.claim.assertedBy).toBeUndefined();
    expect(record?.claim.validFrom).toBe(s.store.record(id)?.recordedAt);
    expect(record?.claim.pipelineVersion).toBe(PROPOSAL_PIPELINE);
    expect(record?.claim.label.compartments).toEqual(["agent:alpha", "own"]);
    expect(s.store.record(id)?.status).toMatchObject({ lane: "agent", status: "done" });
    expect(s.store.record(id)?.restatements).toEqual([
      { claimId: record?.claim.id, answer: "new", reached: null, matchedFactKeyFp: null },
    ]);
  });

  it("a field holding a quote mark, a backslash or a line break is a slice of the body as written, though the JSON escapes it", async () => {
    const s = await setup();
    const what = 'a "deep work" block\\mornings\nbefore ten';
    const id = proposal(s, { ...PREFERENCE, fields: { what, polarity: "prefers" } });
    expect(await process(s, id)).toMatchObject({ status: "done", claims: 1 });
    expect(claimsOf(s, id)[0]?.claim.content.fields).toEqual({ what, polarity: "prefers" });
  });

  it("at intake: with a quote, a text field that is not a slice of it is bad_proposal", async () => {
    const s = await setup();
    const id = proposal(s, { ...PREFERENCE, quote: "I like aisle seats." });
    expect(await process(s, id)).toMatchObject({ status: "skipped", code: "bad_proposal", claims: 0 });
    const kept = proposal(s, { ...PREFERENCE, quote: "Always WINDOW seats on long flights, please." });
    expect(await process(s, kept)).toMatchObject({ status: "done", claims: 1 });
    expect(claimsOf(s, kept)[0]?.claim.content.fields).toEqual({
      what: "WINDOW seats on long flights",
      polarity: "prefers",
    });
  });

  it("a polarity outside the closed list is bad_proposal", async () => {
    const s = await setup();
    const id = proposal(s, { ...PREFERENCE, fields: { what: "window seats", polarity: "adores" } });
    expect(await process(s, id)).toMatchObject({ status: "skipped", code: "bad_proposal", claims: 0, live: false });
    expect(claimsOf(s, id)).toEqual([]);
  });

  it("a body that is not the arguments, a date out of the window or another kind's fields is bad_proposal", async () => {
    const s = await setup();
    for (const body of [
      "not json",
      canonical({ ...PREFERENCE, requestId: "abcdefgh" }),
      canonical({ ...PREFERENCE, subject: "someone" }),
      canonical({ kind: "goal", fields: { what: "run a marathon", by: "2031-01-01" }, scope: "all" }),
      canonical({ kind: "capability", fields: { what: "speaks Portuguese", polarity: "likes" }, scope: "all" }),
    ]) {
      const id = proposal(s, body);
      expect(await process(s, id)).toMatchObject({ status: "skipped", code: "bad_proposal" });
      expect(claimsOf(s, id)).toEqual([]);
    }
  });

  it("a situation's until ends its claim at the end of that day", async () => {
    const s = await setup();
    const id = proposal(s, {
      kind: "situation",
      fields: { what: "on parental leave", until: "2026-12-01" },
      scope: "all",
    });
    expect(await process(s, id)).toMatchObject({ status: "done", claims: 1 });
    expect(claimsOf(s, id)[0]?.claim.validTo).toBe("2026-12-01T23:59:59.999Z");
  });

  it("two situations of one client have two fact keys, each its own record's, as a finding's", async () => {
    const s = await setup();
    const first = proposal(s, { kind: "situation", fields: { what: "between two jobs" }, scope: "all" });
    const second = proposal(s, { kind: "situation", fields: { what: "moving house" }, scope: "all" });
    for (const id of [first, second]) await process(s, id);
    const [a, b] = [claimsOf(s, first)[0], claimsOf(s, second)[0]];
    if (a === undefined || b === undefined) throw new Error("no claim");
    expect(a.factKey).not.toBe(b.factKey);
    expect(a.factKey).toBe(personalFactKey(a.claim.content, a.claim.primaryEvidenceId, [], a.claim.primaryEvidenceId));
  });

  it("a this_client preference builds no claim and is skipped client_scoped", async () => {
    const s = await setup();
    const id = proposal(s, { ...PREFERENCE, scope: "this_client" });
    expect(await process(s, id)).toMatchObject({ status: "skipped", code: "client_scoped", claims: 0, live: false });
    expect(claimsOf(s, id)).toEqual([]);
    expect(s.calls).toEqual([]);
  });

  it("a proposal restating an owner preference from the owner's own mail that it read is marked echo", async () => {
    const s = await setup();
    // The owner's own preference, from a message of the owner's compartment, put as a commit would.
    const mail = (await s.store.due(1000, 1)).find((one) => one.source === "email");
    if (mail === undefined) throw new Error("no message");
    const first = proposal(s, PREFERENCE);
    await process(s, first);
    const [built] = claimsOf(s, first) as ClaimRecord[];
    if (built === undefined) throw new Error("no claim");
    const own: ClaimRecord = {
      ...built,
      claim: {
        ...built.claim,
        id: `${"a".repeat(63)}1` as never,
        basis: "explicit_self",
        evidence: [{ evidenceId: mail.evidenceId, span: "chars:0-10" }],
        primaryEvidenceId: mail.evidenceId,
        label: { ...built.claim.label, compartments: ["own"] },
        pipelineVersion: "1",
      },
      origin: "source",
      lane: "correspondence",
      factKey: `${built.factKey}:mail`,
    };
    s.store.putClaims(mail.evidenceId, [own]);
    const restating = proposal(s, PREFERENCE, [mail.evidenceId]);
    expect(await process(s, restating)).toMatchObject({ status: "done", claims: 1 });
    expect(s.store.record(restating)?.restatements?.map((one) => [one.answer, one.reached])).toEqual([
      ["echo", "read"],
    ]);
  });
});

// A typed body: typed fields grounded in the quote, with the pipeline version that says what the
// owner did.
describe("a quoted proposal or answer", () => {
  const GOAL = {
    kind: "goal",
    fields: { domain: "health", objective: "run a half marathon", by: "2026-12-31" },
    scope: "all",
  };
  const QUOTE = "This year I want to run a half marathon, and I avoid early meetings.";

  it("builds its typed claim: the domain, the key phrase and the value fields, and no what", async () => {
    const s = await setup();
    const id = proposal(s, { ...GOAL, quote: QUOTE });
    expect(await process(s, id)).toMatchObject({ status: "done", claims: 1, live: false });
    const [record] = claimsOf(s, id);
    expect(record?.claim.content).toEqual({
      type: "goal",
      subject: OWNER_ENTITY,
      fields: { domain: "health", objective: "run a half marathon", by: "2026-12-31" },
    });
    expect(record?.fieldKinds).toEqual({ domain: "enum", objective: "text", by: "date" });
    expect(record?.claim.basis).toBe("third_party");
  });

  it("a quoted proposal is personal-proposal-quoted-1; an unquoted one keeps personal-proposal-1", async () => {
    const s = await setup();
    const quoted = proposal(s, { ...GOAL, quote: QUOTE });
    const plain = proposal(s, { ...GOAL, fields: { ...GOAL.fields, objective: "learn to sail" } });
    for (const id of [quoted, plain]) await process(s, id);
    expect(claimsOf(s, quoted)[0]?.claim.pipelineVersion).toBe(QUOTED_PROPOSAL_PIPELINE);
    expect(claimsOf(s, plain)[0]?.claim.pipelineVersion).toBe(PROPOSAL_PIPELINE);
  });

  // A quote's grounding is the store's check alone, so a body whose
  // phrase the quote does not hold is built as it was taken.
  it("a domain off the list or a wrong value is bad_proposal; a stored body is not grounded again", async () => {
    const s = await setup();
    expect(await process(s, proposal(s, { ...GOAL, quote: "I want to swim." }))).toMatchObject({
      status: "done",
      claims: 1,
    });
    for (const body of [
      { ...GOAL, fields: { ...GOAL.fields, domain: "hobbies" } },
      { ...GOAL, fields: { domain: "health", by: "2026-12-31" } },
      { kind: "situation", fields: { domain: "home", state: "moving house", momentary: "yes" }, scope: "all" },
      { ...GOAL, fields: { ...GOAL.fields, what: "run a half marathon" } },
    ]) {
      const id = proposal(s, body);
      expect(await process(s, id), JSON.stringify(body)).toMatchObject({
        status: "skipped",
        code: "bad_proposal",
        claims: 0,
      });
    }
  });

  it("a situation's momentary is kept as a boolean", async () => {
    const s = await setup();
    const id = proposal(s, {
      kind: "situation",
      fields: { domain: "travel", state: "lost the passport", momentary: true },
      scope: "all",
    });
    expect(await process(s, id)).toMatchObject({ status: "done", claims: 1 });
    expect(claimsOf(s, id)[0]?.claim.content.fields).toEqual({
      domain: "travel",
      state: "lost the passport",
      momentary: true,
    });
  });

  it("an answer's facts are personal-answer-1, explicit_self, grounded in its quote", async () => {
    const s = await setup();
    const at = new Date(Date.parse(s.w.now) - 3_600_000).toISOString();
    const body = {
      opportunity: "opp_01JABCDEFGHJKMNPQRSTVWXYZ0",
      question: "What are you training for?",
      quote: QUOTE,
      facts: [
        { kind: "goal", fields: { domain: "health", objective: "run a half marathon" } },
        // A slice may not leave out the "avoid" before it; the negation moves into the polarity.
        { kind: "preference", fields: { domain: "career", object: "avoid early meetings", polarity: "prefers" } },
      ],
      about: "supports",
    };
    const id = s.store.putRecord({ client: "alpha", kind: "answer", body: canonical(body), recordedAt: at as never });
    expect(await process(s, id)).toMatchObject({ status: "done", claims: 2 });
    for (const record of claimsOf(s, id)) {
      expect(record.claim.pipelineVersion).toBe(ANSWER_PIPELINE);
      expect(record.claim.basis).toBe("explicit_self");
    }
  });
});

describe("a proposal's beliefs", () => {
  const rebuild = async (s: Setup) => {
    const { rebuildBeliefs } = await import("./test-support/rebuild.ts");
    await rebuildBeliefs(s.deps);
    return s.store.beliefs(await s.store.ownerAudience());
  };

  // An interpretation in the agent's words, beside the owner's quotes.
  it("an interpretation builds the quoted pipeline's claim from its fields as written, no belief until the owner confirms, then the owner's word", async () => {
    const s = await setup();
    const id = proposal(s, {
      kind: "goal",
      fields: { domain: "career", objective: "found a company within two years" },
      scope: "all",
      interpretation: true,
      statement:
        "You want to found a company of your own within about two years, and would trade salary for ownership.",
      quotes: ["two years, tops, before I start my own thing", "I'd rather own a small piece of something I built"],
    });
    expect(await process(s, id)).toMatchObject({ status: "done", claims: 1 });
    const [record] = claimsOf(s, id);
    expect(record?.claim.pipelineVersion).toBe(QUOTED_PROPOSAL_PIPELINE);
    expect(record?.claim.content.fields).toEqual({ domain: "career", objective: "found a company within two years" });
    // Until the owner confirms, no agent sees it as theirs: it builds no belief.
    expect((await rebuild(s)).filter((row) => row.belief.subject === OWNER_ENTITY)).toEqual([]);
    s.store.confirm(id);
    const rows = (await rebuild(s)).filter((row) => row.belief.subject === OWNER_ENTITY);
    expect(rows.map((row) => [row.belief.kind, row.provenance])).toEqual([["goal", "owner"]]);
  });

  it("an unconfirmed proposal builds no belief about the owner; confirmed, one with provenance owner", async () => {
    const s = await setup();
    const id = proposal(s, PREFERENCE);
    await process(s, id);
    expect((await rebuild(s)).filter((row) => row.belief.subject === OWNER_ENTITY)).toEqual([]);
    s.store.confirm(id);
    const rows = (await rebuild(s)).filter((row) => row.belief.subject === OWNER_ENTITY);
    expect(rows.map((row) => [row.belief.kind, row.provenance])).toEqual([["preference", "owner"]]);
  });

  it("BELIEF_RULES keeps a confirmed proposal's claim about the owner whatever its basis, and a message's third-party claim about the owner never", async () => {
    const { BELIEF_RULES } = await import("@intelligence/personal-beliefs");
    const s = await setup();
    const id = proposal(s, PREFERENCE);
    await process(s, id);
    const [record] = claimsOf(s, id);
    if (record === undefined) throw new Error("no claim");
    for (const kind of ["goal", "preference", "constraint", "situation", "need", "capability"] as const) {
      const rule = BELIEF_RULES[kind];
      expect(rule?.counts({ claim: record.claim, origin: "agent_record", subjectKind: "owner" })).toBe(true);
      expect(rule?.counts({ claim: record.claim, origin: "source", subjectKind: "owner" })).toBe(false);
    }
  });

  it("no code path of this step writes projections.goal_state", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const here = import.meta.dirname;
    const files = [
      join(here, "proposal.ts"),
      join(here, "process-item.ts"),
      join(here, "run.ts"),
      join(here, "../../beliefs/src/belief-rules.ts"),
      join(here, "../../store/src/write/writer-records.ts"),
      join(here, "../../store/src/pipeline/pipeline-write.ts"),
      join(here, "../../store/src/pipeline/pipeline-cards.ts"),
      join(here, "../../store/src/pipeline/pipeline-calls.ts"),
      join(here, "../../store/src/pipeline/pipeline-beliefs.ts"),
      join(here, "../../store/src/admin/cards/card-kinds.ts"),
      join(here, "../../store/src/admin/cards/card-kinds-work.ts"),
      join(here, "../../store/src/cards/card-kinds-claims.ts"),
    ];
    // A comment may name it; no statement may write it.
    for (const file of files)
      expect(await readFile(file, "utf8"), file).not.toMatch(
        /(insert\s+into|update|delete\s+from)\s+projections\.goal_state/i,
      );
  });
});
