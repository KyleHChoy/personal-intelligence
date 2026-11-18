import { createHash } from "node:crypto";
import { type ClaimContent, ClaimId, type FieldKind, LocalEntityId } from "@intelligence/contracts";
import {
  type ClaimRecord,
  CONNECTION_TYPE,
  ConnectionKind,
  type Fill,
  type OpenedRecord,
  parseFillBody,
  RELEASED_LABEL,
  SYMMETRIC_CONNECTIONS,
} from "@intelligence/contracts/personal";
import { keyVersionOf, legacyKeysOf, personalFactKey } from "@intelligence/personal-beliefs";
import { THE_OWNER } from "@intelligence/personal-core";
import { linkFactKey, personLink } from "@intelligence/personal-core/items";
import { codeClaim } from "./code-claim.ts";

// The claims code builds from an explore task's fill, with no model. Each is about the node the store
// set on the record (never one the agent named), origin `agent_research`, tier `researched`, basis
// third_party, labelled `own`, the node's label, under the owner's standing release (the database
// admits it only for a fill record whose label is `own` and agent compartments), and keyed as the
// same fact from mail is. A relation is an edge the paths loader walks at `reportedWeight`, never a
// belief; a role, an affiliation and a link are facts that count in the node's beliefs below every
// source claim. The identity and the domain build no claim: the writer's research step lands them. A
// field naming someone not resolved yet (a name the binding step has not bound, a domain no
// organization holds) builds nothing until it is.

export const RESEARCH_PIPELINE = "personal_research@1";

type FillOutcome = { records: ClaimRecord[]; unresolved: number } | { code: "bad_fill" };

type Built = { content: ClaimContent; fieldKinds: Record<string, FieldKind>; entities: string[] };

export function fillClaims(record: OpenedRecord, generation: number): FillOutcome {
  const parsed = parseFillBody(record.body);
  const research = record.research;
  if (parsed === null || research === undefined) return { code: "bad_fill" };
  const node = parsed.node;
  const evidenceId = record.context.evidenceId;
  const built: Built[] = [];
  let unresolved = 0;
  const person = research.node === "person";
  const organizationOf = (
    given: NonNullable<Fill["role"]>["organization"],
  ): { organization: string } | { organization_name: string } | null => {
    if (given.entity !== undefined)
      return record.kindOf(given.entity as unknown as LocalEntityId) === "organization"
        ? { organization: given.entity }
        : null;
    if (given.domain !== undefined) {
      const held = research.domains[given.domain];
      return held === undefined ? null : { organization: held };
    }
    return given.name === undefined ? null : { organization_name: given.name.trim() };
  };
  const withOrganization = (
    type: "role" | "affiliation",
    organization: ReturnType<typeof organizationOf>,
    rest: Record<string, string>,
    restKinds: Record<string, FieldKind>,
  ): void => {
    if (organization === null) {
      unresolved += 1;
      return;
    }
    const entity = "organization" in organization ? organization.organization : undefined;
    built.push({
      content: { type, subject: LocalEntityId.parse(node), fields: { ...rest, ...organization } },
      fieldKinds: {
        ...restKinds,
        ...(entity === undefined ? { organization_name: "text" } : { organization: "entity" }),
      },
      entities: [node, ...(entity === undefined ? [] : [entity])],
    });
  };
  const { fill } = parsed;
  if (person && fill.role !== undefined)
    withOrganization(
      "role",
      organizationOf(fill.role.organization),
      { title: fill.role.title.trim() },
      { title: "text" },
    );
  if (person && fill.affiliation !== undefined)
    withOrganization(
      "affiliation",
      organizationOf(fill.affiliation.organization),
      { relation: fill.affiliation.relation },
      { relation: "enum" },
    );
  for (const url of fill.links?.urls ?? []) {
    const link = personLink(url);
    if (link === null) continue;
    built.push({
      content: { type: "link", subject: LocalEntityId.parse(node), fields: { url: link.url, kind: link.kind } },
      fieldKinds: { url: "text", kind: "enum" },
      entities: [node],
    });
  }
  for (const relation of fill.relations ?? []) {
    const other =
      relation.other.entity ?? (relation.other.name === undefined ? undefined : research.names[relation.other.name]);
    if (other === undefined) {
      unresolved += 1;
      continue;
    }
    const otherKind = record.kindOf(other as LocalEntityId);
    if (other === node || (otherKind !== "person" && otherKind !== "organization")) continue;
    const connection = ConnectionKind.safeParse(relation.relation);
    if (connection.success) {
      const [subject, to] =
        SYMMETRIC_CONNECTIONS.includes(connection.data) && otherKind === "person" && other < node
          ? [other, node]
          : [node, other];
      built.push({
        content: {
          type: CONNECTION_TYPE,
          subject: LocalEntityId.parse(subject),
          fields: { kind: connection.data, other: to, inferred: false },
        },
        fieldKinds: { kind: "enum", other: "entity", inferred: "boolean" },
        entities: [subject, to],
      });
    } else if (person && otherKind === "person") {
      built.push({
        content: {
          type: "relationship",
          subject: LocalEntityId.parse(node),
          fields: { counterparty: other, relation: relation.relation },
        },
        fieldKinds: { counterparty: "entity", relation: "enum" },
        entities: [node, other],
      });
    }
  }
  const keyVersion = keyVersionOf(generation);
  const span = `chars:0-${record.body.length}`;
  const records = built.map(({ content, fieldKinds, entities }): ClaimRecord => {
    const id = ClaimId.parse(
      createHash("sha256")
        .update(
          JSON.stringify([
            "research",
            evidenceId,
            RESEARCH_PIPELINE,
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
      label: { compartments: [...RELEASED_LABEL], readers: [THE_OWNER] },
      pipelineVersion: RESEARCH_PIPELINE,
      generation,
    });
    const link =
      content.type === "link" ? linkFactKey(content.subject, String(content.fields.url), RELEASED_LABEL) : undefined;
    return {
      claim,
      subjectKind: record.kindOf(content.subject) === "organization" ? "organization" : "person",
      disclosure: ["third_party"],
      // The key a source's statement of the fact under `own` has: no finding, so not the record's own.
      factKey: link ?? personalFactKey(content, evidenceId, RELEASED_LABEL, undefined, keyVersion),
      ...(link === undefined && keyVersion === 2 ? legacyKeysOf(content, evidenceId, RELEASED_LABEL) : {}),
      lane: "agent",
      fieldKinds,
      entities: [...new Set(entities)].map((one) => LocalEntityId.parse(one)),
      origin: "agent_research",
      answersSystem: false,
    };
  });
  return { records, unresolved };
}
