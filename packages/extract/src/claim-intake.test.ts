import type { EvidenceId } from "@intelligence/contracts";
import { personalFactKey } from "@intelligence/personal-beliefs";
import { ModelClientError } from "@intelligence/personal-models";
import { describe, expect, it } from "vitest";
import { checkCorrespondence, EVAL_SENT, type EvalMessage, spanOf } from "./eval/eval-correspondence.ts";
import { processItem } from "./process-item.ts";
import { QUOTED_PROPOSAL_PIPELINE } from "./proposal.ts";
import { OWNER_ENTITY } from "./test-support/memory-store.ts";
import {
  recordBody as canonical,
  claimsOf,
  processRecord as process,
  type Setup,
  setup,
  withDecideModel,
} from "./test-support/support.ts";

// The claim intake: a proposal through the one claim check every source passes, the quote's words
// in the quote's order, a role and an affiliation of the owner keyed as mail keys them, and the
// refuse-only model check on fakes, with invariant 5's half that needs no database.

function proposal(s: Setup, body: unknown): EvidenceId {
  const at = new Date(Date.parse(s.w.now) - 3_600_000).toISOString();
  return s.store.putRecord({ client: "alpha", kind: "proposal", body: canonical(body), recordedAt: at as never });
}
const unmappedOf = (s: Setup, id: EvidenceId) => s.store.unmapped().filter((one) => one.evidenceId === id);

const QUOTE = "Honestly I'd rather reach out to the founders directly than apply through the portal.";
const GOAL = {
  kind: "goal",
  fields: { domain: "career", objective: "reach out to founders directly" },
  scope: "all",
  quote: QUOTE,
};

describe("a proposal through the claim intake", () => {
  it("(B) read by claims_said, a key phrase uses the quote's words in the quote's order, and is kept as the agent wrote it", async () => {
    const s = await setup();
    const id = proposal(s, {
      ...GOAL,
      fields: { domain: "career", objective: "rather reach out to founders directly" },
    });
    withDecideModel(s);
    expect(await process(s, id)).toMatchObject({ status: "done", claims: 1 });
    expect(claimsOf(s, id)[0]?.claim.content.fields).toEqual({
      domain: "career",
      objective: "rather reach out to founders directly",
    });
    expect(claimsOf(s, id)[0]?.claim.pipelineVersion).toBe(QUOTED_PROPOSAL_PIPELINE);
  });

  it("the pipeline never grounds a stored body again: one the store took under looser rules is built, and its confirmed claim survives a re-run", async () => {
    const s = await setup();
    // Reordered: no grounding the store's check takes today, as a body stored before it.
    const id = proposal(s, { ...GOAL, fields: { domain: "career", objective: "directly reach out to founders" } });
    expect(await process(s, id)).toMatchObject({ status: "done", claims: 1 });
    s.store.confirm(id);
    const due = (await s.store.due(1000, 2)).find((one) => one.evidenceId === id);
    if (due === undefined) throw new Error("not due at the next generation");
    expect(await processItem(due, { ...s.deps, generation: 2 })).toMatchObject({ status: "done", claims: 1 });
    expect(claimsOf(s, id).map((one) => one.claim.content.fields)).toEqual([
      { domain: "career", objective: "directly reach out to founders" },
    ]);
  });

  it("(A) a body the store never checked, with a pointer word, a list or a relative time, is filed unmapped with its reason", async () => {
    const s = await setup();
    const cases = [
      [
        {
          ...GOAL,
          fields: { domain: "career", objective: "reach out to them instead of apply" },
          quote: "I'd reach out to them instead of apply.",
        },
        "not_standalone",
      ],
      [
        {
          kind: "situation",
          fields: { domain: "travel", state: "I've been to seattle new york new orleans, sf, and la" },
          scope: "all",
        },
        "multi_fact",
      ],
      [
        { kind: "situation", fields: { domain: "health", state: "at the dentist today" }, scope: "all" },
        "not_standalone",
      ],
      [
        {
          kind: "preference",
          fields: { domain: "career", object: "never em dashes", polarity: "avoids" },
          scope: "all",
        },
        "negated_object",
      ],
    ] as const;
    for (const [body, reason] of cases) {
      const id = proposal(s, body);
      expect(await process(s, id), reason).toMatchObject({ status: "done", claims: 0, unmapped: 1 });
      expect(unmappedOf(s, id).map((one) => one.reason)).toEqual([reason]);
    }
  });

  it("a preference's leading negation moves into its polarity, as a mail claim's does", async () => {
    const s = await setup();
    const id = proposal(s, {
      kind: "preference",
      fields: { domain: "career", object: "no em dashes", polarity: "prefers" },
      scope: "all",
      quote: "No em dashes, please.",
    });
    await process(s, id);
    expect(claimsOf(s, id)[0]?.claim.content.fields).toEqual({
      domain: "career",
      object: "em dashes",
      polarity: "avoids",
    });
  });
});

describe("a role and an affiliation of the owner", () => {
  const ROLE_QUOTE = "I interned at Alder Labs as a research and ops intern, and left in May.";

  it("a quoted role proposal keys as the mail role claim of the same organization and title does", async () => {
    const s = await setup();
    const id = proposal(s, {
      kind: "role",
      fields: { title: "research and ops intern", organization_name: "Alder Labs" },
      scope: "all",
      quote: ROLE_QUOTE,
    });
    expect(await process(s, id)).toMatchObject({ status: "done", claims: 1 });
    const [proposed] = claimsOf(s, id);
    expect(proposed?.claim.content).toEqual({
      type: "role",
      subject: OWNER_ENTITY,
      fields: { title: "research and ops intern", organization_name: "Alder Labs" },
    });
    // The same fact from the owner's own mail, checked as the run checks it (key version 2).
    const OWNER = "sam@harbor.example";
    const sentence = "I am a research and ops intern at Alder Labs.";
    const message: EvalMessage = {
      id: "0108-role",
      from: OWNER,
      to: "lena.park@north.example",
      paragraphs: [sentence],
      expected: [],
    };
    const claim = {
      type: "role",
      subject: { key: { kind: "address", value: OWNER }, observedAt: EVAL_SENT },
      fields: { title: "research and ops intern", organization_name: "Alder Labs" },
      statementKind: "stated_fact",
      basis: "explicit_self",
      span: await spanOf(message, sentence),
    };
    const mail = await checkCorrespondence(message, { claims: [claim], narrowing: "none" } as never);
    const [fromMail] = mail.claims;
    expect(fromMail?.claim.content.fields).toEqual(proposed?.claim.content.fields);
    // One subject and one label: the keys agree, so once the owner's confirmation moves the
    // proposal's claim into `own`, it joins the mail claim's belief.
    const keyOf = (content: NonNullable<typeof proposed>["claim"]["content"]) =>
      personalFactKey({ ...content, subject: OWNER_ENTITY }, "thread", ["own"], undefined, 2);
    expect(fromMail).toBeDefined();
    expect(keyOf(proposed?.claim.content as never)).toBe(keyOf(fromMail?.claim.content as never));
  });

  it("an affiliation takes its relation from the closed list and its organization by name, with no domain; a title that does not stand alone is refused", async () => {
    const s = await setup();
    const affiliation = proposal(s, {
      kind: "affiliation",
      fields: { relation: "employee", organization_name: "Alder Labs" },
      scope: "all",
      quote: ROLE_QUOTE,
    });
    expect(await process(s, affiliation)).toMatchObject({ status: "done", claims: 1 });
    const pointer = proposal(s, {
      kind: "role",
      fields: { title: "her intern", organization_name: "Alder Labs" },
      scope: "all",
    });
    expect(await process(s, pointer)).toMatchObject({ claims: 0, unmapped: 1 });
    expect(unmappedOf(s, pointer).map((one) => one.reason)).toEqual(["not_standalone"]);
  });
});

describe("the model check (C), on fakes", () => {
  it("below the standalone line the claim is unmapped not_standalone; below the said line not_what_was_said; neither changes anything", async () => {
    for (const [answers, reason] of [
      [{ standalone: 0.1 }, "not_standalone"],
      [{ said: 0.2 }, "not_what_was_said"],
    ] as const) {
      const s = await setup();
      const id = proposal(s, GOAL);
      withDecideModel(s, {
        ...("standalone" in answers ? { [`jev_standalone:${id}`]: answers } : { [`jev_said:${id}`]: answers }),
      });
      expect(await process(s, id)).toMatchObject({ status: "done", claims: 0, unmapped: 1 });
      expect(unmappedOf(s, id).map((one) => one.reason)).toEqual([reason]);
    }
  });

  it("asks the line alone first and the quote only second, both about the claim's own rendered line", async () => {
    const s = await setup();
    const id = proposal(s, GOAL);
    withDecideModel(s);
    expect(await process(s, id)).toMatchObject({ status: "done", claims: 1 });
    expect(s.otherDecideCalls).toEqual([`jev_standalone:${id}`, `jev_said:${id}`]);
    const [alone, said] = s.decideRequests;
    // Each slot is JSON, as the real decide-model client parses every slot and refuses one that is not;
    // plain text would fail every check.
    expect(alone?.data).toEqual({ line: JSON.stringify("Goal: reach out to founders directly") });
    expect(said?.data).toEqual({
      line: JSON.stringify("Goal: reach out to founders directly"),
      quote: JSON.stringify(QUOTE),
    });
    for (const request of [alone, said])
      for (const slot of Object.values(request?.data ?? {})) expect(() => JSON.parse(slot)).not.toThrow();
  });

  it("hotfix: a check that fails waits for a retry and removes nothing the record already has", async () => {
    const s = await setup();
    const id = proposal(s, GOAL);
    withDecideModel(s);
    expect(await process(s, id)).toMatchObject({ status: "done", claims: 1 });
    const decideModel = s.deps.decideModel;
    if (decideModel === undefined) throw new Error("no jev");
    s.deps.decideModel = {
      ...decideModel,
      model: { ...decideModel.model, complete: async () => Promise.reject(new ModelClientError("bad_request")) },
    };
    const due = (await s.store.due(1000, 2)).find((one) => one.evidenceId === id);
    if (due === undefined) throw new Error("not due at the next generation");
    expect(await processItem(due, { ...s.deps, generation: 2 })).toMatchObject({
      status: "waiting",
      code: "interpret_failed",
    });
    expect(claimsOf(s, id)).toHaveLength(1);
  });

  it("hotfix (invariant 11, the owner's choice): a record the owner confirmed and released is not asked again", async () => {
    const s = await setup();
    const id = proposal(s, GOAL);
    withDecideModel(s);
    expect(await process(s, id)).toMatchObject({ status: "done", claims: 1 });
    s.store.confirm(id);
    s.store.ownerRelease(id, "rul_01JABCDEFGHJKMNPQRSTVWXY01");
    withDecideModel(s, { [`jev_said:${id}`]: { said: 0.01 } });
    const asked = s.otherDecideCalls.length;
    const due = (await s.store.due(1000, 2)).find((one) => one.evidenceId === id);
    if (due === undefined) throw new Error("not due at the next generation");
    // The record's claim and its released claim, both built.
    expect(await processItem(due, { ...s.deps, generation: 2 })).toMatchObject({
      status: "done",
      claims: 2,
      unmapped: 0,
    });
    expect(s.otherDecideCalls.length).toBe(asked);
    expect(unmappedOf(s, id)).toEqual([]);
  });

  // The skip keys on the confirm in force, so a record whose release was refused (its label cannot
  // narrow to `own`) keeps its claim too.
  it("a record the owner confirmed but that holds no release is not asked again, and keeps its claim", async () => {
    const s = await setup();
    const id = proposal(s, GOAL);
    withDecideModel(s);
    expect(await process(s, id)).toMatchObject({ status: "done", claims: 1 });
    s.store.confirm(id);
    withDecideModel(s, { [`jev_said:${id}`]: { said: 0.01 }, [`jev_standalone:${id}`]: { standalone: 0.01 } });
    const asked = s.otherDecideCalls.length;
    const due = (await s.store.due(1000, 2)).find((one) => one.evidenceId === id);
    if (due === undefined) throw new Error("not due at the next generation");
    expect(await processItem(due, { ...s.deps, generation: 2 })).toMatchObject({
      status: "done",
      claims: 1,
      unmapped: 0,
    });
    expect(s.otherDecideCalls.length).toBe(asked);
    expect(claimsOf(s, id)).toHaveLength(1);
    expect(unmappedOf(s, id)).toEqual([]);
  });

  it("an unquoted proposal is never asked", async () => {
    const s = await setup();
    const { quote: _quote, ...plain } = GOAL;
    const id = proposal(s, plain);
    withDecideModel(s);
    expect(await process(s, id)).toMatchObject({ status: "done", claims: 1 });
    expect(s.otherDecideCalls).toEqual([]);
  });

  it("with Jev away the item waits, model_unavailable, and nothing is committed", async () => {
    const s = await setup();
    const id = proposal(s, GOAL);
    withDecideModel(s, {}, null);
    expect(await process(s, id)).toMatchObject({ status: "waiting", code: "model_unavailable" });
    expect(claimsOf(s, id)).toEqual([]);
  });

  it("invariant 5: whatever Jev answers, the claim committed is the one code built, or none", async () => {
    const plain = await setup();
    const reference = proposal(plain, GOAL);
    withDecideModel(plain);
    await process(plain, reference);
    const built = claimsOf(plain, reference)[0];
    const answers: unknown[] = [
      { standalone: 1 },
      {
        standalone: 1,
        objective: "apply through the portal",
        compartments: ["employer:example"],
        tier: "owner",
        factKey: "f".repeat(64),
      },
      "not json",
      { standalone: 0.5 },
    ];
    for (const answer of answers) {
      const s = await setup();
      const id = proposal(s, GOAL);
      withDecideModel(s, {
        [`jev_standalone:${id}`]: answer,
        [`jev_said:${id}`]: answer === "not json" ? answer : { said: 1 },
      });
      await process(s, id);
      const [record] = claimsOf(s, id);
      if (record === undefined) {
        expect(
          unmappedOf(s, id).map((one) => one.reason),
          JSON.stringify(answer),
        ).toEqual(["not_standalone"]);
        continue;
      }
      const { evidenceId: _a, ...rest } = record;
      const { evidenceId: _b, ...expected } = built as NonNullable<typeof built>;
      expect({ ...rest, claim: { ...rest.claim, id: "", evidence: [] } }, JSON.stringify(answer)).toEqual({
        ...expected,
        claim: { ...expected.claim, id: "", evidence: [] },
      });
      expect(record.claim.label).toEqual(expected.claim.label);
    }
  });
});

describe("an owner's answer through the claim intake", () => {
  const FLY = "I'd rather fly than drive.";
  const answer = (s: Setup, object: string): EvidenceId => {
    const at = new Date(Date.parse(s.w.now) - 3_600_000).toISOString();
    const body = {
      about: "supports",
      facts: [{ fields: { domain: "travel", object, polarity: "prefers" }, kind: "preference" }],
      opportunity: "opp_01JABCDEFGHJKMNPQRSTVWXYZ0",
      question: "How do you travel?",
      quote: FLY,
    };
    return s.store.putRecord({ client: "alpha", kind: "answer", body: canonical(body), recordedAt: at as never });
  };

  it("its slice is the store's check alone; the pipeline builds a stored answer as it was taken", async () => {
    const s = await setup();
    expect(await process(s, answer(s, "rather fly than drive"))).toMatchObject({ status: "done", claims: 1 });
  });

  it("asks claims_said of each fact's line beside the quote, never claims_standalone, and a refusal files the fact unmapped", async () => {
    const s = await setup();
    const id = answer(s, "rather fly than drive");
    withDecideModel(s, { [`jev_said:${id}`]: { said: 0.1 } });
    expect(await process(s, id)).toMatchObject({ status: "done", claims: 0, unmapped: 1 });
    expect(unmappedOf(s, id).map((one) => one.reason)).toEqual(["not_what_was_said"]);
    expect(s.otherDecideCalls).toEqual([`jev_said:${id}`]);
  });
});
