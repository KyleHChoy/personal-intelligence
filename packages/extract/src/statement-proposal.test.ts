import type { EvidenceId, ModelCallRecord } from "@intelligence/contracts";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { describe, expect, it } from "vitest";
import { processItem } from "./process-item.ts";
import { PROPOSAL_PIPELINE, QUOTED_PROPOSAL_PIPELINE, STATEMENT_OWNER, statementText } from "./proposal.ts";
import { OWNER_ENTITY } from "./test-support/memory-store.ts";
import { claimsOf, processRecord as process, recording, type Setup, setup } from "./test-support/support.ts";

// Agents state, the classifier types. A statement proposal is shown to the agent lane's model as a
// finding; code builds each claim of an owner's kind from the kind and fields it gave, with the
// owner as subject and never the model's subject.

const STATEMENT = "The owner prefers meetings before 10am";
const QUOTE = "I like to meet before ten";

function statement(s: Setup, body: Record<string, unknown>, claims: unknown[], narrowing = "none"): EvidenceId {
  const at = new Date(Date.parse(s.w.now) - 3_600_000).toISOString();
  const id = s.store.putRecord({
    client: "alpha",
    kind: "proposal",
    body: JSON.stringify(body),
    recordedAt: at as never,
    cites: [],
  });
  s.store.outputs[id] = { claims, narrowing };
  s.deps.model = recording(fakeModelClient(s.store.outputs, s.calls), s.requests);
  return id;
}
const candidate = (type: string, fields: Record<string, unknown>) => ({
  type,
  subject: { key: { kind: "address", value: "someone@example.org" }, observedAt: "2026-10-01T00:00:00Z" },
  fields,
  statementKind: "stated_fact",
  basis: "third_party",
  span: "chars:0-10",
});
const PREFERS = candidate("preference", { domain: "career", object: "meetings before 10am", polarity: "prefers" });

describe("a statement proposal in the agent lane", () => {
  it("supplies only the program's owner alias to the fact-kind classifier", async () => {
    const s = await setup({ factKinds: ["agent"] });
    const id = s.store.putRecord({
      client: "alpha",
      kind: "proposal",
      body: JSON.stringify({ statement: STATEMENT }),
      ownerKeys: { names: ["Rowan Vale"], addresses: ["rowan@example.invalid"] },
    });
    const fallback = fakeModelClient({});
    s.deps.model = recording(
      {
        ...fallback,
        complete: async (request) => {
          const message = JSON.parse(request.data.message ?? "{}");
          const claims = message.owner?.addresses?.includes(STATEMENT_OWNER) ? [PREFERS] : [];
          return fakeModelClient({ [id]: { claims, narrowing: "none" } }, s.calls).complete(request);
        },
      },
      s.requests,
    );
    expect(await process(s, id)).toMatchObject({ status: "done", claims: 1 });
    const request = s.requests[0];
    expect(request?.promptVersion).toBe("9");
    expect(JSON.parse(request?.data.message ?? "{}").owner).toEqual({ names: [], addresses: [STATEMENT_OWNER] });
    expect(JSON.stringify(request)).not.toContain("rowan@example.invalid");
    expect(claimsOf(s, id)[0]?.claim.content.subject).toBe(OWNER_ENTITY);
  });

  it("keeps a saved legacy statement call when the fact-kind lane turns on", async () => {
    const s = await setup();
    const saved = new Map<string, ModelCallRecord>();
    const keyOf = (key: ModelCallRecord["key"]) => JSON.stringify(Object.entries(key).sort());
    s.store.calls = () => ({
      find: async (key) => saved.get(keyOf(key)) ?? null,
      save: async (record) => {
        saved.set(keyOf(record.key), record);
      },
    });
    const id = statement(s, { statement: STATEMENT }, [PREFERS]);
    const due = (await s.store.due(1000, 1)).find((item) => item.evidenceId === id);
    if (due === undefined) throw new Error("not due");
    await processItem(due, s.deps);
    expect(s.requests[0]?.promptVersion).toBe("3");
    expect(JSON.parse(s.requests[0]?.data.message ?? "{}").owner).toBeUndefined();
    s.deps.factKinds = ["agent"];
    await processItem(due, s.deps);
    expect(s.requests).toHaveLength(1);
  });

  it("asks the model once, with the statement and the owner's words, and builds the owner's claim from the kind and fields it gave", async () => {
    const s = await setup();
    const id = statement(s, { statement: STATEMENT, quote: QUOTE, kind: "need" }, [PREFERS]);
    expect(await process(s, id)).toMatchObject({ status: "done", claims: 1 });
    expect(s.requests).toHaveLength(1);
    const asked = JSON.stringify(s.requests[0]);
    expect(asked).toContain(STATEMENT);
    expect(asked).toContain(QUOTE);
    expect(asked).toContain(STATEMENT_OWNER);
    const [record] = claimsOf(s, id);
    // The model's kind, not the agent's hint; the owner, not the model's subject.
    expect(record).toMatchObject({ origin: "agent_record", subjectKind: "owner" });
    expect(record?.claim.content).toMatchObject({ type: "preference", subject: OWNER_ENTITY });
    expect(record?.claim.content.fields).toMatchObject({
      domain: "career",
      object: "meetings before 10am",
      polarity: "prefers",
    });
    expect(record?.claim.basis).toBe("third_party");
    expect(record?.claim.pipelineVersion).toBe(QUOTED_PROPOSAL_PIPELINE);
  });

  it("without the owner's words the claim is an unquoted proposal's", async () => {
    const s = await setup();
    const id = statement(s, { statement: STATEMENT }, [PREFERS]);
    await process(s, id);
    expect(claimsOf(s, id)[0]?.claim.pipelineVersion).toBe(PROPOSAL_PIPELINE);
  });

  it("a goal, a commitment or any type not the owner's kinds builds nothing; with none left it is bad_proposal", async () => {
    const s = await setup();
    const id = statement(s, { statement: "The owner wants to raise a seed round" }, [
      candidate("goal", { domain: "ventures", objective: "raise a seed round" }),
      candidate("commitment", { counterparty: "x", what: "send the deck" }),
    ]);
    expect(await process(s, id)).toMatchObject({ status: "skipped", code: "bad_proposal", claims: 0 });
    expect(claimsOf(s, id)).toEqual([]);
  });

  it("a field in words of the model's own, in neither the statement nor the owner's words, builds nothing", async () => {
    const s = await setup();
    const id = statement(s, { statement: STATEMENT }, [
      candidate("preference", { domain: "career", object: "late dinners with friends", polarity: "prefers" }),
    ]);
    expect(await process(s, id)).toMatchObject({ status: "skipped", code: "bad_proposal", claims: 0 });
  });

  it("a statement the model withholds is withheld, and builds nothing", async () => {
    const s = await setup();
    const id = statement(s, { statement: STATEMENT }, [PREFERS], "quarantine");
    expect(await process(s, id)).toMatchObject({ status: "withheld", code: "quarantine", claims: 0 });
  });

  // The classifier's verdict, per agent client, ids, counts and a code only.
  it("logs the classifier's verdict for the agent client: candidates, typed, refused and dropped, and a code", async () => {
    const s = await setup();
    const id = statement(s, { statement: STATEMENT, quote: QUOTE }, [
      PREFERS,
      candidate("commitment", { counterparty: "x", what: "send the deck" }),
    ]);
    await process(s, id);
    const verdicts = () =>
      s.log.lines.filter((one) => one.event.event === "statement_classified").map((one) => one.event);
    expect(verdicts()).toEqual([
      {
        event: "statement_classified",
        ids: { client: "agent", record: expect.stringMatching(/^rec_/), evidence: id },
        counts: { candidates: 2, typed: 1, refused: 0, dropped: 1 },
        code: "typed",
      },
    ]);
    await process(
      s,
      statement(s, { statement: STATEMENT }, [
        candidate("goal", { domain: "ventures", objective: "raise a seed round" }),
      ]),
    );
    expect(verdicts().at(-1)).toMatchObject({
      counts: { candidates: 1, typed: 0, refused: 0, dropped: 1 },
      code: "untyped",
    });
    await process(s, statement(s, { statement: STATEMENT }, [PREFERS], "quarantine"));
    expect(verdicts().at(-1)).toMatchObject({
      counts: { candidates: 1, typed: 0, refused: 0, dropped: 1 },
      code: "withheld",
    });
    expect(JSON.stringify(s.log.lines)).not.toContain(STATEMENT);
  });

  it("the text the model is shown names the owner by a reserved address and keeps the owner's words apart", () => {
    expect(statementText({ statement: STATEMENT })).toBe(
      `An agent's statement of one fact about the owner (${STATEMENT_OWNER}): ${STATEMENT}`,
    );
    expect(statementText({ statement: STATEMENT, quote: QUOTE }).split("\n")[1]).toContain(QUOTE);
    expect(STATEMENT_OWNER.endsWith(".invalid")).toBe(true);
  });
});
