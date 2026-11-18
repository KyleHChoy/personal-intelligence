import type { EvidenceId, ModelRequest } from "@intelligence/contracts";
import type { DueDocument } from "@intelligence/contracts/personal";
import { type DocBody, type DriveFile, documentPassages, type Passage } from "@intelligence/personal-core/items";
import { type ModelClient, ModelClientError } from "@intelligence/personal-models";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { describe, expect, it } from "vitest";
import { EXTRACT_CONFIG } from "./config.ts";
import { DOCUMENT_MAX_CALLS, DOCUMENT_SETTLE_MS, groupPassages, planDocument, processDocument } from "./documents.ts";
import { rebuildBeliefs } from "./test-support/rebuild.ts";
import { recording, type Setup, setup } from "./test-support/support.ts";

// The document lane: a document's passages, its groups and its run through the lane, on the
// in-memory store over the world, with the fake model answering each group by its evidence id and
// input hash. No real model is called.

const DOC = "application/vnd.google-apps.document";
const FOLDER = "1CanaryFolderIdK4t9w2X8Qa";
const MODIFIED = "2026-09-28T09:00:00.000Z";
const OWNER = "avery@quinn.test";
const MAREN = "maren.holt@example.com";
const SENTENCE = `${MAREN} will send ${OWNER} the venue list by 2026-10-09.`;

const file = (id: string, over: Partial<DriveFile> = {}): DriveFile => ({
  id,
  name: `Plan ${id}`,
  mimeType: DOC,
  createdTime: "2026-09-01T09:00:00.000Z",
  modifiedTime: MODIFIED,
  parent: FOLDER,
  root: FOLDER,
  ownedByMe: true,
  modifiedByMe: true,
  owner: { address: OWNER },
  canDownload: true,
  ...over,
});
const body = (...texts: string[]): DocBody => ({
  blocks: [
    { kind: "heading", level: 1, text: "Plans" },
    ...texts.map((text) => ({ kind: "paragraph" as const, text })),
  ],
});

// A document of `sections` sections of one paragraph each, every paragraph near PASSAGE_CHARS, the
// first holding SENTENCE.
const long = (sections: number): DocBody => ({
  blocks: Array.from({ length: sections }, (_, n) => [
    { kind: "heading" as const, level: 2 as const, text: `Part ${n + 1}` },
    {
      kind: "paragraph" as const,
      text: `${n === 0 ? `${SENTENCE} ` : ""}${"Notes on the harbour survey. ".repeat(125)}`.trim(),
    },
  ]).flat(),
});

const mention = (address: string) => ({ key: { kind: "address", value: address }, observedAt: MODIFIED });
const commitment = (span: string, over: Record<string, unknown> = {}) => ({
  type: "commitment",
  subject: mention(MAREN),
  fields: { counterparty: mention(OWNER), what: SENTENCE, due: "2026-10-09" },
  statementKind: "stated_fact",
  basis: "explicit_self",
  span,
  ...over,
});
const output = (...claims: unknown[]) => ({ claims, narrowing: "none" });

async function due(s: Setup, evidenceId: EvidenceId): Promise<DueDocument> {
  const found = (
    await s.store.dueDocuments(1000, 1, {
      settledBefore: new Date(Date.parse(s.w.now) - DOCUMENT_SETTLE_MS).toISOString() as never,
    })
  ).find((one) => one.evidenceId === evidenceId);
  if (found === undefined) throw new Error("not due");
  return found;
}

// The plan of a stored document: its parse, its groups and their input hashes.
async function planOf(s: Setup, evidenceId: EvidenceId) {
  const opened = await s.store.openDocument(evidenceId);
  if (opened === null) throw new Error("not stored");
  return planDocument(opened, (await due(s, evidenceId)).compartment);
}

// The model answers these outputs, keyed as fakeModelClient keys them.
function answer(s: Setup, outputs: Record<string, unknown>): void {
  s.deps.model = recording(fakeModelClient(outputs, s.calls), s.requests);
}

const statusOf = (s: Setup, id: EvidenceId) => s.store.document(id)?.status;
const claimsOf = (s: Setup, id: EvidenceId) => s.store.claims().filter((one) => one.evidenceId === id);

describe("a document's groups", () => {
  const passages = (sizes: number[]): Passage[] =>
    sizes.map((_, n) => ({ span: `chars:${n * 10}-${n * 10 + 10}`, section: n, heading: `H${n}` }));

  it("passages are grouped greedily in order under the bound, at most the most calls, and the rest counted as left out", () => {
    const sizes = [30, 30, 30, 50, 10, 90, 20, 20];
    const size = (group: Passage[]) => 5 + group.reduce((sum, one) => sum + (sizes[one.section] ?? 0), 0);
    const { groups, leftOut } = groupPassages(passages(sizes), size, 100, 3);
    expect(groups.map((group) => group.map((one) => one.section))).toEqual([[0, 1, 2], [3, 4], [5]]);
    expect(leftOut).toBe(2);
    for (const group of groups) expect(size(group)).toBeLessThanOrEqual(100);
    // With room for every group, nothing is left out.
    expect(groupPassages(passages(sizes), size, 100, 8)).toMatchObject({ leftOut: 0 });
    expect(groupPassages([], size, 100, 8)).toEqual({ groups: [], leftOut: 0 });
  });

  it("a passage that alone is over the bound ends the groups there, and what follows is left out", () => {
    const sizes = [30, 200, 30];
    const size = (group: Passage[]) => group.reduce((sum, one) => sum + (sizes[one.section] ?? 0), 0);
    expect(groupPassages(passages(sizes), size, 100, 8)).toEqual({ groups: [[passages(sizes)[0]]], leftOut: 2 });
  });

  it("a long document's passages are grouped under the prompt bound, at most eight groups, and the rest counted as left out", async () => {
    const s = await setup();
    const id = await s.store.putDocument("personal", file("1LongDocAbc0001"), long(150));
    const plan = await planOf(s, id);
    const all = documentPassages(
      plan.parsed.segments.map((segment) => {
        const [start, end] = segment.span.slice("chars:".length).split("-").map(Number);
        return { heading: "", start: start ?? 0, end: end ?? 0 };
      }),
      plan.parsed.texts[""] ?? "",
    );
    expect(plan.groups).toHaveLength(DOCUMENT_MAX_CALLS);
    const sent = plan.groups.flatMap((group) => group.passages.map((one) => one.span));
    expect(sent).toEqual(all.slice(0, sent.length).map((one) => one.span));
    expect(plan.leftOut).toBe(all.length - sent.length);
    expect(plan.leftOut).toBeGreaterThan(0);
    for (const group of plan.groups) expect(group.text.length).toBeLessThanOrEqual(EXTRACT_CONFIG.limits.promptChars);
    expect(new Set(plan.groups.map((group) => group.inputHash)).size).toBe(DOCUMENT_MAX_CALLS);
  });
});

describe("processDocument", () => {
  it("a document in the lane is sent in one call for its one group, and commits its claims with its groups and nothing left out", async () => {
    const s = await setup();
    const id = await s.store.putDocument("personal", file("1OneGroupDoc001"), body(SENTENCE));
    const [group] = (await planOf(s, id)).groups;
    answer(s, { [id]: output(commitment(group?.passages[0]?.span ?? "")) });
    expect(await processDocument(await due(s, id), s.deps)).toMatchObject({
      status: "done",
      claims: 1,
      unmapped: 0,
      live: true,
    });
    expect(s.calls).toEqual([id]);
    expect(s.requests[0]).toMatchObject({ promptId: "personal_document", promptVersion: "1" });
    expect(Object.keys(s.requests[0]?.data ?? {})).toEqual(["document"]);
    expect(statusOf(s, id)).toMatchObject({ lane: "document", status: "done", groups: 1, leftOut: 0 });
  });

  it("a span that is no listed passage is bad_span; the passage's own span is the positive control", async () => {
    const s = await setup();
    const id = await s.store.putDocument("personal", file("1BadSpanDoc0001"), body(SENTENCE));
    const span = (await planOf(s, id)).groups[0]?.passages[0]?.span ?? "";
    const [, start, end] = /^chars:(\d+)-(\d+)$/.exec(span) ?? [];
    // Inside the passage's section, and no listed passage.
    const inside = `chars:${Number(start) + 1}-${Number(end)}`;
    answer(s, { [id]: output(commitment(inside), commitment(span)) });
    expect(await processDocument(await due(s, id), s.deps)).toMatchObject({ status: "done", claims: 1, unmapped: 1 });
    expect(
      s.store
        .unmapped()
        .filter((one) => one.evidenceId === id)
        .map((one) => one.reason),
    ).toEqual(["bad_span"]);
    expect(claimsOf(s, id)[0]?.claim.evidence[0]?.span).toBe(span);
  });

  it("bad_speaker is not run for a document, and R55: a claim from a document has no author and is never explicit_self, and builds no belief", async () => {
    const s = await setup();
    const id = await s.store.putDocument("personal", file("1NoAuthorDoc001"), body(SENTENCE));
    const span = (await planOf(s, id)).groups[0]?.passages[0]?.span ?? "";
    // The owner as subject, which in an inbound message would be bad_speaker were the owner its speaker.
    const own = commitment(span, {
      subject: mention(OWNER),
      fields: { counterparty: mention(MAREN), what: SENTENCE, due: "2026-10-09" },
    });
    answer(s, { [id]: output(commitment(span), own) });
    expect(await processDocument(await due(s, id), s.deps)).toMatchObject({ status: "done", claims: 2, unmapped: 0 });
    for (const { claim, lane } of claimsOf(s, id)) {
      expect(claim.assertedBy).toBeUndefined();
      expect(claim.basis).toBe("third_party");
      expect(lane).toBe("document");
    }
    const rebuilt = await rebuildBeliefs(s.deps);
    expect(rebuilt.beliefs).toBe(0);
    expect(s.store.beliefs(["own"])).toEqual([]);
  });

  it("a quarantine on one group commits no claim of any group", async () => {
    const s = await setup();
    const id = await s.store.putDocument("personal", file("1QuarantineDoc1"), long(30));
    const plan = await planOf(s, id);
    expect(plan.groups.length).toBeGreaterThanOrEqual(2);
    const [first, second] = plan.groups;
    answer(s, {
      [`${id}/${first?.inputHash}`]: output(commitment(first?.passages[0]?.span ?? "")),
      [`${id}/${second?.inputHash}`]: { claims: [], narrowing: "quarantine" },
      [id]: output(),
    });
    expect(await processDocument(await due(s, id), s.deps)).toMatchObject({
      status: "withheld",
      code: "quarantine",
      claims: 0,
    });
    expect(claimsOf(s, id)).toEqual([]);
    expect(statusOf(s, id)).toMatchObject({ status: "withheld", withheld: true });
    // The positive control: the first group alone would have committed its claim.
    const t = await setup();
    const again = await t.store.putDocument("personal", file("1QuarantineDoc1"), long(30));
    t.deps.model = recording(
      fakeModelClient(
        { [`${again}/${first?.inputHash}`]: output(commitment(first?.passages[0]?.span ?? "")), [again]: output() },
        t.calls,
      ),
      t.requests,
    );
    expect(await processDocument(await due(t, again), t.deps)).toMatchObject({ status: "done", claims: 1 });
  });

  it("a reference document, a PDF and another person's document cause no model call", async () => {
    const s = await setup();
    const { referenceDocumentId, sharedDocumentId } = s.w.handles;
    const pdf = s.w.expected.documents.find((one) => one.kind === "pdf")?.fileId ?? "";
    const cases: [string, string][] = [
      [referenceDocumentId, "reference"],
      [pdf, "no_text"],
      [sharedDocumentId, "not_owners"],
    ];
    for (const [fileId, code] of cases) {
      const id = s.store.documentEvidenceIdOf(fileId);
      expect(await processDocument(await due(s, id), s.deps), fileId).toMatchObject({
        status: "skipped",
        code,
        live: false,
      });
      expect(statusOf(s, id)).toMatchObject({ lane: "skip", status: "skipped", code });
    }
    expect(s.calls).toEqual([]);
    // The positive control: one of the owner's own documents in the lane is sent.
    const canary = s.store.documentEvidenceIdOf(s.w.documentCanaries.fileId);
    answer(s, { [canary]: output() });
    expect(await processDocument(await due(s, canary), s.deps)).toMatchObject({ status: "done" });
    expect(s.calls).toEqual([canary]);
  });

  it("an old document is skipped as old, unless the owner gives it the lane; a reference one is skipped whatever lane is given", async () => {
    const s = await setup();
    const id = await s.store.putDocument(
      "personal",
      file("1OldDocument001", { modifiedTime: "2026-05-01T09:00:00.000Z" }),
      body(SENTENCE),
    );
    expect(await processDocument(await due(s, id), s.deps)).toMatchObject({ status: "skipped", code: "old" });
    s.store.retry(id, "document");
    answer(s, { [id]: output() });
    expect(await processDocument(await due(s, id), s.deps)).toMatchObject({ status: "done" });
    const reference = s.store.documentEvidenceIdOf(s.w.handles.referenceDocumentId);
    s.store.retry(reference, "document");
    expect(await processDocument(await due(s, reference), s.deps)).toMatchObject({
      status: "skipped",
      code: "reference",
    });
    expect(s.calls).toEqual([id]);
  });

  it("the same statement in two revisions has one fact key, and a document claim's valid_from is the document's modified time", async () => {
    const s = await setup();
    const first = await s.store.putDocument("personal", file("1RevisedDoc0001"), body(SENTENCE));
    const span = (await planOf(s, first)).groups[0]?.passages[0]?.span ?? "";
    answer(s, { [first]: output(commitment(span)) });
    await processDocument(await due(s, first), s.deps);
    const [before] = claimsOf(s, first);
    expect(before?.claim.validFrom).toBe(MODIFIED);
    const later = "2026-09-29T15:30:00.000Z";
    const second = await s.store.putDocument(
      "personal",
      file("1RevisedDoc0001", { modifiedTime: later }),
      body(SENTENCE),
    );
    expect(claimsOf(s, first)).toEqual([]);
    answer(s, { [second]: output(commitment(span, { subject: { ...mention(MAREN), observedAt: later } })) });
    await processDocument(await due(s, second), s.deps);
    const [after] = claimsOf(s, second);
    expect(after?.claim.validFrom).toBe(later);
    expect(after?.factKey).toBe(before?.factKey);
    expect(after?.claim.id).not.toBe(before?.claim.id);
  });

  it("two groups of one document have two call keys", async () => {
    const s = await setup();
    const id = await s.store.putDocument("personal", file("1TwoGroupsDoc01"), long(30));
    const plan = await planOf(s, id);
    answer(s, { [id]: output() });
    expect(await processDocument(await due(s, id), s.deps)).toMatchObject({ status: "done" });
    expect(s.requests).toHaveLength(plan.groups.length);
    const keys = s.requests.map((request) => request.callKey);
    expect(new Set(keys.map((key) => key?.inputHash)).size).toBe(plan.groups.length);
    for (const key of keys)
      expect(key).toMatchObject({ evidenceId: id, promptId: "personal_document", promptVersion: "1" });
    expect(statusOf(s, id)).toMatchObject({ groups: plan.groups.length, leftOut: 0 });
  });

  it("a budget reached between two groups commits nothing for the document and leaves it due, and the next run replays the first group free", async () => {
    const s = await setup();
    const id = await s.store.putDocument("personal", file("1BudgetDoc00001"), long(30));
    const groups = (await planOf(s, id)).groups.length;
    expect(groups).toBeGreaterThanOrEqual(2);
    let calls = 0;
    const inner = fakeModelClient({ [id]: output() });
    const budgeted: ModelClient = {
      complete: (request: ModelRequest) => {
        calls += 1;
        if (calls === 2)
          return Promise.reject(
            Object.assign(new Error("budget_reached:run"), { code: "budget_reached", reason: "run" }),
          );
        return inner.complete(request);
      },
      embed: (request) => inner.embed(request),
    };
    s.deps.model = budgeted;
    await expect(processDocument(await due(s, id), s.deps)).rejects.toMatchObject({ code: "budget_reached" });
    expect(statusOf(s, id)).toBeUndefined();
    expect(claimsOf(s, id)).toEqual([]);
    expect(s.store.savedCalls()).toHaveLength(1);
    // The next run: the first group is replayed, the rest are live.
    answer(s, { [id]: output() });
    expect(await processDocument(await due(s, id), s.deps)).toMatchObject({ status: "done" });
    expect(s.calls.length).toBe(groups - 1);
  });

  it("a model away on a group leaves the document waiting, with no attempt counted", async () => {
    const s = await setup();
    const id = await s.store.putDocument("personal", file("1AwayDocument01"), body(SENTENCE));
    s.deps.model = {
      complete: () => Promise.reject(new ModelClientError("unavailable")),
      embed: () => Promise.reject(new ModelClientError("bad_purpose")),
    };
    expect(await processDocument(await due(s, id), s.deps)).toMatchObject({
      status: "waiting",
      code: "model_unavailable",
    });
    expect(statusOf(s, id)).toMatchObject({ status: "waiting", attempts: 0, lane: "document" });
  });
});
