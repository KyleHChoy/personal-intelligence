import { createHash } from "node:crypto";
import { type ClaimContent, ClaimId, type FieldKind, LocalEntityId } from "@intelligence/contracts";
import {
  type ClaimRecord,
  CONNECTION_TYPE,
  type DueItem,
  KNOWN_PERSON_TYPE,
  type OpenedRecord,
  OWNER_TIE_TYPE,
  PERSON_PROPOSAL_PIPELINE,
  type PersonProposalBody,
  type PersonProposalFields,
  RELEASED_LABEL,
  SYMMETRIC_CONNECTIONS,
} from "@intelligence/contracts/personal";
import { keyVersionOf, legacyKeysOf, personalFactKey, releasedFactKey } from "@intelligence/personal-beliefs";
import type { ReadItem } from "@intelligence/personal-core";
import { codeClaim } from "./code-claim.ts";

// The one claim of an agent's propose_person record, built by code, never by a model: a known
// person (about the owner, naming no entity until the owner confirms it), a person's tie to the owner, or
// a typed link. Origin agent_record, basis third_party, disclosure third_party (use-only: the
// outbound gate holds it from anyone not on its source), the record's label, and pipeline version
// PERSON_PROPOSAL_PIPELINE, so a confirmed one is `owner_confirmed`. The store's write-time intake
// is the one authority: the pipeline never checks a stored body's text again, so a rule made
// stricter later never drops a fact the owner confirmed (invariant 11). It checks only the
// entities, as they stand now, and refuses (bad_proposal) a body that names one that is gone or of
// another kind.
//
// A tie's or a connection's alternate key (`legacyAltFactKey`) is the key its released claim
// takes, the one `own` fact of the person's tie or of the pair and kind, so a veto or retire the
// owner made on that fact reaches every later proposal of it: the card says so, and the owner's confirm of
// one releases nothing (vetoedRecord, policy.released_records()).
type AgentDue = Extract<DueItem, { source: "agent_record" }>;
type PersonOutcome = { record: ClaimRecord } | { code: "bad_proposal" };

export function personProposalClaim(
  record: OpenedRecord,
  due: AgentDue,
  read: ReadItem,
  generation: number,
  body: PersonProposalBody,
): PersonOutcome {
  const built = contentOf(record, body);
  if (built === null) return { code: "bad_proposal" };
  const { content, fieldKinds, entities, subjectKind } = built;
  const evidenceId = record.context.evidenceId;
  const span = `chars:0-${record.body.length}`;
  const id = ClaimId.parse(
    createHash("sha256")
      .update(
        JSON.stringify([
          evidenceId,
          0,
          span,
          PERSON_PROPOSAL_PIPELINE,
          content.type,
          content.subject,
          Object.entries(content.fields).sort(([a], [b]) => (a < b ? -1 : 1)),
          generation,
        ]),
        "utf8",
      )
      .digest("hex"),
  );
  const claim = codeClaim({
    id,
    content,
    basis: "third_party",
    validFrom: record.item.recordedAt,
    evidenceId,
    span,
    label: read.label,
    pipelineVersion: PERSON_PROPOSAL_PIPELINE,
    generation,
  });
  const keyed = [content, evidenceId, due.compartments, evidenceId] as const;
  const keyVersion = keyVersionOf(generation);
  return {
    record: {
      claim,
      subjectKind,
      disclosure: ["third_party"],
      factKey: personalFactKey(...keyed, keyVersion),
      ...(keyVersion === 2 ? legacyKeysOf(...keyed) : {}),
      ...(content.type === KNOWN_PERSON_TYPE
        ? {}
        : {
            legacyFactKey: personalFactKey(...keyed, 1),
            legacyAltFactKey: releasedFactKey(content, evidenceId, RELEASED_LABEL, keyVersion),
          }),
      lane: "agent",
      fieldKinds,
      entities,
      origin: "agent_record",
      answersSystem: false,
    },
  };
}

type Built = {
  content: ClaimContent;
  fieldKinds: Record<string, FieldKind>;
  entities: ClaimRecord["entities"];
  subjectKind: ClaimRecord["subjectKind"];
};

function contentOf(record: OpenedRecord, body: PersonProposalBody): Built | null {
  if (body.kind === "person") {
    const fields = body.fields as PersonProposalFields["person"];
    const kept: Record<string, unknown> = Object.fromEntries(
      Object.entries(fields).map(([name, value]) => [name, (value as string).trim()]),
    );
    return {
      content: { type: KNOWN_PERSON_TYPE, subject: record.context.ownerEntity, fields: kept },
      fieldKinds: Object.fromEntries(Object.keys(kept).map((name) => [name, "text" as const])),
      entities: [],
      subjectKind: "owner",
    };
  }
  if (body.kind === "relationship") {
    const { person, relation, closeness } = body.fields as PersonProposalFields["relationship"];
    if (record.kindOf(person as never) !== "person") return null;
    return {
      content: { type: OWNER_TIE_TYPE, subject: LocalEntityId.parse(person), fields: { relation, closeness } },
      fieldKinds: { relation: "enum", closeness: "enum" },
      entities: [LocalEntityId.parse(person)],
      subjectKind: "person",
    };
  }
  const { from, kind, to, inferred } = body.fields as PersonProposalFields["link"];
  const toKind = record.kindOf(to as never);
  if (record.kindOf(from as never) !== "person" || (toKind !== "person" && toKind !== "organization")) return null;
  // One fact for a pair of a symmetric kind, whichever way it was given: the lower id first.
  const [subject, other] =
    SYMMETRIC_CONNECTIONS.includes(kind) && toKind === "person" && to < from ? [to, from] : [from, to];
  return {
    content: { type: CONNECTION_TYPE, subject: LocalEntityId.parse(subject), fields: { kind, other, inferred } },
    fieldKinds: { kind: "enum", other: "entity", inferred: "boolean" },
    entities: [LocalEntityId.parse(subject), LocalEntityId.parse(other)],
    subjectKind: "person",
  };
}
