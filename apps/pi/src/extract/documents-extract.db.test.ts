import type { DocBody, DriveFile } from "@intelligence/personal-core/items";
import { DOCUMENT_MAX_CALLS, DOCUMENT_SETTLE_MS, planDocument } from "@intelligence/personal-extract";
import { EVAL_DOCUMENTS, EVAL_MODIFIED, openEvalDocument } from "@intelligence/personal-extract/testing";
import { fakeKeyEndpoint, fakeModelClient } from "@intelligence/personal-models/testing";
import { openRow } from "@intelligence/personal-store";
import { fingerprint, queryAs } from "@intelligence/personal-store/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  answer,
  EMPTY_OUTPUT,
  events,
  fakeOpenRouter,
  pi,
  type Synced,
  statuses,
  sync,
  syncedWorld,
} from "../test-support/extract-fixtures.ts";

// No test calls Google or a model.

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const made: Synced[] = [];
afterEach(async () => {
  for (const one of made.splice(0)) await one.drop();
});
const world = async (): Promise<Synced> => {
  const s = await syncedWorld({ drive: true });
  made.push(s);
  return s;
};

const DOC = "application/vnd.google-apps.document";
const DAY = 86_400_000;
const ON = { PI_EXTRACT_DOCUMENTS: "1" };

const admin = <Row = Record<string, unknown>>(s: Synced, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(s.db.urls.admin, text, values);
const count = async (s: Synced, text: string, values?: unknown[]): Promise<number> =>
  (await admin<{ n: number }>(s, `select count(*)::int as n from ${text}`, values))[0]?.n ?? 0;

// A document's row by its Drive file id: its id and the evidence id of its latest revision.
const documentOf = async (
  s: Synced,
  fileId: string,
): Promise<{ id: string; evidence_id: string; compartments: string[]; body_enc: unknown } | undefined> =>
  (
    await admin<{ id: string; evidence_id: string; compartments: string[]; body_enc: unknown }>(
      s,
      "select id, evidence_id, compartments, body_enc from knowledge.documents where file_fp = $1",
      [fingerprint(s.db.keys, "source_id", fileId)],
    )
  )[0];
const documentEvidence = async (s: Synced): Promise<Set<string>> =>
  new Set(
    (await admin<{ evidence_id: string }>(s, "select evidence_id from knowledge.documents")).map(
      (row) => row.evidence_id,
    ),
  );

// The personal label's fake Drive, and a file of it under the plans root, owned and last edited
// by the owner three days ago.
const driveOf = (s: Synced) => {
  const drive = s.sources.find((one) => one.label === "personal")?.drive;
  if (drive === undefined) throw new Error("the personal label has no Drive");
  return drive;
};
const file = (s: Synced, id: string): Omit<DriveFile, "root"> => ({
  id,
  name: `Plan ${id}`,
  mimeType: DOC,
  createdTime: new Date(Math.floor(s.now.getTime() / 1000) * 1000 - 30 * DAY).toISOString(),
  modifiedTime: new Date(Math.floor(s.now.getTime() / 1000) * 1000 - 3 * DAY).toISOString(),
  parent: s.w.documentCanaries.folderId,
  ownedByMe: true,
  modifiedByMe: true,
  owner: { address: s.w.accounts[0]?.address ?? "" },
  canDownload: true,
});
const body = (...texts: string[]): DocBody => ({
  blocks: [
    { kind: "heading", level: 1, text: "Plans" },
    ...texts.map((text) => ({ kind: "paragraph" as const, text })),
  ],
});
// A document of `sections` sections near PASSAGE_CHARS each: more than eight groups' worth.
const long = (sections: number): DocBody => ({
  blocks: Array.from({ length: sections }, (_, n) => [
    { kind: "heading" as const, level: 2 as const, text: `Part ${n + 1}` },
    { kind: "paragraph" as const, text: "Notes on the harbour survey. ".repeat(125).trim() },
  ]).flat(),
});

// The world's outputs for its messages, and `documents` for each document evidence id given.
const withDocuments = (s: Synced, documents: Record<string, unknown>): Record<string, unknown> => ({
  ...s.outputs,
  ...documents,
});
const emptyFor = (ids: Iterable<string>): Record<string, unknown> =>
  Object.fromEntries([...ids].map((id) => [id, EMPTY_OUTPUT]));

describe("pi extract on documents", () => {
  it("with PI_EXTRACT_DOCUMENTS unset no document is due: the run makes no call for one and writes no status row for one", async () => {
    const s = await world();
    const docs = await documentEvidence(s);
    expect(docs.size).toBe(s.w.expected.documents.filter((one) => one.stored).length);
    const calls: string[] = [];
    const result = await pi(["extract"], s.pipeline, {
      deps: { model: fakeModelClient(withDocuments(s, emptyFor(docs)), calls) },
    });
    expect(result.exit).toBe(0);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((id) => docs.has(id))).toEqual([]);
    const rows = await statuses(s.db);
    for (const id of docs) expect(rows.has(id)).toBe(false);
  });

  it("documents are taken only when no message is due, each once", async () => {
    const s = await world();
    const docs = await documentEvidence(s);
    const calls: string[] = [];
    const result = await pi(
      ["extract"],
      { ...s.pipeline, ...ON },
      { deps: { model: fakeModelClient(withDocuments(s, emptyFor(docs)), calls) } },
    );
    expect(result.exit).toBe(0);
    expect(events(result.stderr).find((event) => event.event === "extract_run")?.code).toBe("ok");
    const first = calls.findIndex((id) => docs.has(id));
    expect(first).toBeGreaterThan(0);
    expect(calls.slice(first).every((id) => docs.has(id))).toBe(true);
    expect(new Set(calls.slice(first)).size).toBe(calls.length - first);
    // A second run takes nothing more.
    const again: string[] = [];
    await pi(
      ["extract"],
      { ...s.pipeline, ...ON },
      { deps: { model: fakeModelClient(withDocuments(s, emptyFor(docs)), again) } },
    );
    expect(again).toEqual([]);
  });

  it("G9: a reference document, a file of another kind and a document that is not the owner's cause no model call; a document in the lane causes at most eight", async () => {
    const s = await world();
    driveOf(s).put(file(s, "1LongPlanDoc0001"), long(150));
    await sync(s.db, s.w, s.now, s.sources);
    const docs = await documentEvidence(s);
    const calls: string[] = [];
    const result = await pi(
      ["extract"],
      { ...s.pipeline, ...ON },
      { deps: { model: fakeModelClient(withDocuments(s, emptyFor(docs)), calls) } },
    );
    expect(result.exit).toBe(0);
    const skipped = s.w.expected.documents.filter(
      (one) => one.stored && (one.reference || one.kind !== "doc" || one.fileId === s.w.handles.sharedDocumentId),
    );
    expect(skipped.length).toBeGreaterThanOrEqual(6);
    for (const one of skipped) expect(calls, one.fileId).not.toContain((await documentOf(s, one.fileId))?.evidence_id);
    // The positive control: the owner's own documents were sent, the long one in eight calls.
    expect(calls).toContain((await documentOf(s, s.w.documentCanaries.fileId))?.evidence_id);
    const longOne = (await documentOf(s, "1LongPlanDoc0001"))?.evidence_id ?? "";
    expect(calls.filter((id) => id === longOne)).toHaveLength(DOCUMENT_MAX_CALLS);
    for (const id of docs) expect(calls.filter((one) => one === id).length).toBeLessThanOrEqual(DOCUMENT_MAX_CALLS);
    const rows = await statuses(s.db);
    expect(rows.get(longOne)).toMatchObject({ status: "done", lane: "document", groups: DOCUMENT_MAX_CALLS });
    expect((rows.get(longOne) as unknown as { leftOut: number }).leftOut).toBeGreaterThan(0);
    for (const one of skipped)
      expect(rows.get((await documentOf(s, one.fileId))?.evidence_id ?? ""), one.fileId).toMatchObject({
        status: "skipped",
        lane: "skip",
      });
  });

  it("G6: after an edit and a sync, the document keeps its id and shows the new text, one blob is stored for it, and the earlier revision's claims are gone", async () => {
    const s = await world();
    const owner = s.w.accounts[0]?.address ?? "";
    const maren = s.w.handles.topContactAddress;
    const first = `${maren} will send ${owner} the venue list by ${new Date(s.now.getTime() + 7 * DAY).toISOString().slice(0, 10)}.`;
    const second = `${maren} will send ${owner} the seating plan by ${new Date(s.now.getTime() + 9 * DAY).toISOString().slice(0, 10)}.`;
    const fileId = "1EditedPlanDoc01";
    driveOf(s).put(file(s, fileId), body(first));
    await sync(s.db, s.w, s.now, s.sources);
    const before = await documentOf(s, fileId);
    if (before === undefined) throw new Error("not stored");
    const at = new Date(Math.floor(s.now.getTime() / 1000) * 1000 - 3 * DAY).toISOString();
    const mention = (address: string) => ({ key: { kind: "address", value: address }, observedAt: at });
    const claim = (what: string) => ({
      claims: [
        {
          type: "commitment",
          subject: mention(maren),
          fields: { counterparty: mention(owner), what, due: what.slice(-11, -1) },
          statementKind: "stated_fact",
          basis: "third_party",
          span: `chars:0-${`Plans\n\n${what}`.length}`,
        },
      ],
      narrowing: "none",
    });
    await pi(
      ["extract"],
      { ...s.pipeline, ...ON },
      {
        deps: {
          model: fakeModelClient(
            withDocuments(s, { ...emptyFor(await documentEvidence(s)), [before.evidence_id]: claim(first) }),
          ),
        },
      },
    );
    expect(await count(s, "knowledge.claims where evidence_id = $1", [before.evidence_id])).toBe(1);

    driveOf(s).edit(fileId, { body: body(second) });
    await sync(s.db, s.w, s.now, s.sources);
    const after = await documentOf(s, fileId);
    expect(after?.id).toBe(before.id);
    expect(after?.evidence_id).not.toBe(before.evidence_id);
    const text = openRow(
      s.db.keys,
      after?.compartments[0] ?? "",
      { table: "knowledge.documents", id: after?.id ?? "", column: "body_enc" },
      after?.body_enc as never,
    );
    expect(text).toContain(second);
    expect(text).not.toContain(first);
    const itemFp = fingerprint(s.db.keys, "source_id", `drive-file:${fileId}`);
    expect(await count(s, "vault.evidence_items where source_item_fp = $1 and blob_ref is not null", [itemFp])).toBe(1);
    expect(await count(s, "vault.evidence_items where source_item_fp = $1", [itemFp])).toBe(2);
    expect(await count(s, "knowledge.claims where evidence_id = $1", [before.evidence_id])).toBe(0);
    expect(await count(s, "vault.model_calls where evidence_id = $1", [before.evidence_id])).toBe(0);
    // The new revision is read anew once due: the edit is dated now, so a run past the settle time.
    const settled = () => new Date(s.now.getTime() + DOCUMENT_SETTLE_MS + 10 * 60_000);
    await pi(
      ["extract"],
      { ...s.pipeline, ...ON },
      {
        deps: {
          model: fakeModelClient(
            withDocuments(s, { ...emptyFor(await documentEvidence(s)), [after?.evidence_id ?? ""]: claim(second) }),
          ),
          now: settled,
        },
      },
    );
    expect(await count(s, "knowledge.claims where evidence_id = $1", [after?.evidence_id])).toBe(1);
  });

  it("retry --document sets one document waiting and deletes its saved calls, and pi extract status counts the document lane", async () => {
    const s = await world();
    const docs = await documentEvidence(s);
    await pi(
      ["extract"],
      { ...s.pipeline, ...ON },
      { deps: { model: fakeModelClient(withDocuments(s, emptyFor(docs))) } },
    );
    const canary = await documentOf(s, s.w.documentCanaries.fileId);
    expect(await count(s, "vault.model_calls where evidence_id = $1", [canary?.evidence_id])).toBe(1);
    const status = await pi(["extract", "status"], s.admin);
    expect(status.exit).toBe(0);
    const view = JSON.parse(status.stdout) as {
      items: { lane: string; status: string; code: string | null; count: number }[];
    };
    expect(view.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lane: "document", status: "done" }),
        expect.objectContaining({ lane: "skip", status: "skipped", code: "reference" }),
      ]),
    );

    const retried = await pi(["extract", "retry", "--document", canary?.id ?? ""], s.admin);
    expect(retried).toMatchObject({ exit: 0, stdout: `${JSON.stringify({ selected: 1 })}\n` });
    expect((await statuses(s.db)).get(canary?.evidence_id ?? "")).toMatchObject({ status: "waiting", attempts: 0 });
    expect(
      await count(s, "vault.model_calls where evidence_id = $1 and superseded_at is null", [canary?.evidence_id]),
    ).toBe(0);
    // The positive control: another document keeps its saved call.
    const nested = await documentOf(
      s,
      [...s.w.expected.documents].find(
        (one) =>
          one.stored &&
          one.kind === "doc" &&
          !one.reference &&
          !one.held &&
          one.fileId !== s.w.documentCanaries.fileId &&
          one.fileId !== s.w.handles.sharedDocumentId &&
          one.label === "personal",
      )?.fileId ?? "",
    );
    expect(await count(s, "vault.model_calls where evidence_id = $1", [nested?.evidence_id])).toBe(1);
  });
});

describe("pi extract check --world --lane document", () => {
  // What a model that finds every expected fact answers, by each document's title.
  async function expectedAnswers(): Promise<Map<string, unknown>> {
    const byTitle = new Map<string, unknown>();
    for (const doc of EVAL_DOCUMENTS) {
      const plan = await planDocument(openEvalDocument(doc), "own");
      const text = plan.parsed.texts[""] ?? "";
      const spans = plan.groups.flatMap((group) => group.passages.map((one) => one.span));
      const mention = (address: string) => ({ key: { kind: "address", value: address }, observedAt: EVAL_MODIFIED });
      const claims = doc.expected.map((fact) => ({
        type: fact.type,
        subject: mention(fact.subject),
        fields: {
          counterparty: mention(fact.counterparty),
          what: fact.what,
          ...(fact.due === undefined ? {} : { due: fact.due }),
          ...(fact.when === undefined ? {} : { when: fact.when }),
        },
        statementKind: "stated_fact",
        basis: "third_party",
        span: spans.find((span) => {
          const [start, end] = span.slice("chars:".length).split("-").map(Number);
          return text.slice(start, end).includes(fact.what);
        }),
      }));
      byTitle.set(doc.title, { claims, narrowing: "none" });
    }
    return byTitle;
  }
  const titleOf = (body: Record<string, unknown>, titles: Iterable<string>): string | undefined => {
    const content = JSON.stringify(body.messages ?? []);
    return [...titles].find((title) => content.includes(JSON.stringify(`"title":"${title}"`).slice(1, -1)));
  };

  it("the check sends each evaluation document once, stores no evidence and writes one usage row for each call, prints counts, and passes on a model that finds the expected facts", async () => {
    const s = await world();
    const answers = await expectedAnswers();
    const router = fakeOpenRouter((body) => answer(answers.get(titleOf(body, answers.keys()) ?? "") ?? EMPTY_OUTPUT));
    const evidence = await count(s, "vault.evidence_items");
    const calls = await count(s, "vault.model_calls");
    const result = await pi(["extract", "check", "--world", "--lane", "document"], s.pipeline, {
      deps: { modelFetch: router.fetch },
    });
    expect(result.exit).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines.at(-1)).toBe("result: ok");
    expect(lines.slice(0, 2).map((line) => line.split(":")[0])).toEqual(["commitment", "plan"]);
    expect(router.bodies).toHaveLength(EVAL_DOCUMENTS.length);
    expect(await count(s, "vault.evidence_items")).toBe(evidence);
    expect(await count(s, "vault.model_calls")).toBe(calls);
    expect(await count(s, "vault.model_usage where outcome = 'check'")).toBe(EVAL_DOCUMENTS.length);
    for (const doc of EVAL_DOCUMENTS)
      for (const paragraph of doc.paragraphs) expect(result.stdout).not.toContain(paragraph);
  });

  it("the check fails on a model that finds nothing, and exits 1 with check_failed", async () => {
    const s = await world();
    const router = fakeOpenRouter(() => answer(EMPTY_OUTPUT));
    const result = await pi(["extract", "check", "--world", "--lane", "document"], s.pipeline, {
      deps: { modelFetch: router.fetch },
    });
    expect(result.exit).toBe(1);
    expect(result.stdout.trimEnd().split("\n").at(-1)).toBe("result: failed");
    expect(events(result.stderr).at(-1)).toMatchObject({ event: "command_failed", code: "check_failed" });
  });

  it("the check reads the key's limit before any call: a key with no limit, or one over the ceiling, ends it with that code and no call (HO5, R34, R35)", async () => {
    const s = await world();
    for (const [answered, code] of [
      [{ limit: null }, "spend_cap_missing"],
      [{ limit: 20.000001 }, "spend_cap_too_high"],
    ] as const) {
      const router = fakeOpenRouter(() => answer(EMPTY_OUTPUT));
      const key = fakeKeyEndpoint(answered);
      const result = await pi(["extract", "check", "--world", "--lane", "document"], s.pipeline, {
        deps: { modelFetch: router.fetch, keyFetch: key.fetch },
      });
      expect(result.exit, code).toBe(1);
      expect(key.calls(), code).toBe(1);
      expect(router.bodies, code).toHaveLength(0);
      expect(result.stdout, code).toBe("");
      expect(events(result.stderr).filter((line) => line.event === "spend_cap")).toHaveLength(1);
      expect(events(result.stderr).at(-1)).toMatchObject({ event: "command_failed", code });
    }
  });
});
