import { LocalEntityId, type Timestamp } from "@intelligence/contracts";
import { type DueDocument, EntityId, type OpenedItem, SourceAccountId } from "@intelligence/contracts/personal";
import { personalFactKey } from "@intelligence/personal-beliefs";
import { normalizeAddress } from "@intelligence/personal-core";
import { driveItem } from "@intelligence/personal-core/items";
import type { ModelClient } from "@intelligence/personal-models";
import { ExtractFailure } from "../call-failure.ts";
import { EXTRACT_GENERATION } from "../config.ts";
import { askGroups, checkGroups, planDocument } from "../documents.ts";
import { passesThrough } from "../interpret.ts";
import { DOCUMENT_TYPES } from "../lane-versions.ts";
import { callsInMemory } from "./eval-calls.ts";
import { openedEval, ulidOf } from "./eval-open.ts";
import { extrasAllowed } from "./eval-rule.ts";
import { type EvalTypeLine, extrasOf, gatedLines, setLineText, typeCounts, typeLineText } from "./eval-score.ts";
import { EVAL_DOCUMENTS, EVAL_MODIFIED, EVAL_OWNER, type EvalDocument, type EvalFact } from "./eval-set.ts";

// The document evaluation: the evaluation documents sent through the document lane to the
// configured model, read and written nowhere but the model's port, and scored by code. A found fact
// matches an expected one when their type and fact key are equal; an extra is a found fact of a
// document type that matches no expected fact of its document. Changed only by a commit, so the
// pass that admitted the owner's documents to a model is on record.

export { EVAL_GATED_FROM, type EvalTypeLine } from "./eval-score.ts";
export type EvalReport = {
  types: EvalTypeLine[];
  documents: number;
  extras: number;
  extrasAllowed: number;
  failed: string[];
  passed: boolean;
};

const EVAL_ACCOUNT = SourceAccountId.parse(`acc_${ulidOf("evaluation account")}`);
const OWNER_ENTITY = LocalEntityId.parse(EntityId.parse(`ent_${ulidOf(`evaluation person ${EVAL_OWNER}`)}`));
// Everyone the set names is a person the identity port knows, and the owner is the owner.
const entityOf = (address: string): LocalEntityId =>
  address === EVAL_OWNER
    ? OWNER_ENTITY
    : LocalEntityId.parse(EntityId.parse(`ent_${ulidOf(`evaluation person ${address}`)}`));
const PEOPLE = new Set(
  EVAL_DOCUMENTS.flatMap((doc) => doc.expected.flatMap((fact) => [fact.subject, fact.counterparty])),
);

// One evaluation document as the pipeline opens a stored one: built by core's builder, under
// `own`, with an identity port that answers for the set's people alone. Nothing is stored.
export function openEvalDocument(doc: EvalDocument): OpenedItem {
  const raw = driveItem(
    {
      id: doc.fileId,
      name: doc.title,
      mimeType: "application/vnd.google-apps.document",
      createdTime: EVAL_MODIFIED as Timestamp,
      modifiedTime: EVAL_MODIFIED as Timestamp,
      root: "my-drive",
      ownedByMe: true,
      modifiedByMe: true,
      owner: { address: EVAL_OWNER },
      canDownload: true,
    },
    {
      blocks: [
        { kind: "heading", level: 1, text: doc.title },
        ...doc.paragraphs.map((text) => ({ kind: "paragraph" as const, text })),
      ],
    },
    null,
    { sourceAccount: EVAL_ACCOUNT, changeKind: "backfill", ownerAddress: EVAL_OWNER },
  );
  return openedEval(raw, EVAL_ACCOUNT, { address: EVAL_OWNER, entity: OWNER_ENTITY }, (mention) => {
    const address = mention.key.kind === "address" ? normalizeAddress(mention.key.value) : null;
    return address === null || !(address === EVAL_OWNER || PEOPLE.has(address))
      ? null
      : { address, entity: entityOf(address) };
  });
}

// The fact key an expected fact has: its type, subject, typed fields and the document's thread.
const expectedKey = (opened: OpenedItem, fact: EvalFact): string =>
  personalFactKey(
    {
      type: fact.type,
      subject: entityOf(fact.subject),
      fields: {
        counterparty: entityOf(fact.counterparty),
        what: fact.what,
        ...(fact.due === undefined ? {} : { due: fact.due }),
        ...(fact.when === undefined ? {} : { when: fact.when }),
      },
    },
    opened.raw.threadId ?? opened.context.evidenceId,
    [opened.context.compartment],
  );

// The set, each document through the lane. A document the model withholds or answers in a way
// the lane refuses is failed and finds nothing; the model away, refused or over a budget ends
// the check by its error.
export async function evaluateDocuments(
  port: { model: ModelClient },
  set: readonly EvalDocument[] = EVAL_DOCUMENTS,
): Promise<EvalReport> {
  const calls = callsInMemory();
  const { counts, line } = typeCounts(DOCUMENT_TYPES);
  const failed: string[] = [];
  for (const doc of set) {
    const opened = openEvalDocument(doc);
    const expected = doc.expected.map((fact) => ({ type: fact.type, key: expectedKey(opened, fact) }));
    for (const fact of expected) line(fact.type).expected += 1;
    const plan = await planDocument(opened, "own");
    const due: DueDocument = {
      evidenceId: opened.context.evidenceId as DueDocument["evidenceId"],
      compartment: "own",
      modifiedAt: EVAL_MODIFIED as Timestamp,
      attempts: 0,
      override: false,
      triage: {
        reference: false,
        kind: "doc",
        mine: true,
        editedByMe: true,
        unreadable: false,
        chars: (plan.parsed.texts[""] ?? "").length,
        modifiedAt: EVAL_MODIFIED as Timestamp,
      },
    };
    let found: { type: string; key: string }[] = [];
    let answered = true;
    try {
      const asked = await askGroups(plan, { model: port.model, calls }, false);
      if ("withheld" in asked) answered = false;
      else {
        const checked = await checkGroups(asked.answers, plan, opened, due, EXTRACT_GENERATION);
        found = checked.claims
          .filter((record) => (DOCUMENT_TYPES as readonly string[]).includes(record.claim.content.type))
          .map((record) => ({ type: record.claim.content.type, key: record.factKey }));
      }
    } catch (error) {
      if (passesThrough(error) || !(error instanceof ExtractFailure)) throw error;
      answered = false;
    }
    const matched = expected.filter((fact) => found.some((one) => one.type === fact.type && one.key === fact.key));
    const extras = found.filter((one) => !expected.some((fact) => fact.type === one.type && fact.key === one.key));
    for (const fact of matched) line(fact.type).found += 1;
    for (const one of extras) line(one.type).extra += 1;
    if (!answered || matched.length < expected.length || extras.length > 0) failed.push(doc.id);
  }
  const extras = extrasOf(counts);
  const extrasLimit = extrasAllowed(set.length);
  const lines = gatedLines(counts);
  return {
    types: lines,
    documents: set.length,
    extras,
    extrasAllowed: extrasLimit,
    failed,
    passed: lines.every((one) => one.passed) && extras <= extrasLimit,
  };
}

// What `pi extract check --world --lane document` prints: counts, codes and the set's own
// document ids, and no text.
export function reportLines(report: EvalReport): string[] {
  return [
    ...report.types.map(typeLineText),
    setLineText("documents", report.documents, report),
    `result: ${report.passed ? "ok" : "failed"}`,
  ];
}
