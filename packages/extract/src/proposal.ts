import { createHash } from "node:crypto";
import { type ClaimContent, ClaimId, type FieldKind } from "@intelligence/contracts";
import {
  AboutYouKind,
  ANSWER_PIPELINE,
  type ClaimRecord,
  type DueItem,
  isLegacy,
  isStatement,
  KEY_FIELDS,
  LIFE_DOMAINS,
  type OpenedRecord,
  PROPOSAL_PIPELINE,
  parseOwnerAnswerBody,
  parsePersonProposalBody,
  parseProposalBody,
  QUOTED_PROPOSAL_PIPELINE,
  RELEASED_LABEL,
  type RulingId,
  releasableLabel,
  type StatementProposalBody,
  StoredAboutYouKind,
} from "@intelligence/contracts/personal";
import {
  groundText,
  keyVersionOf,
  legacyKeysOf,
  type PersonalType,
  personalFactKey,
  personalType,
  releasedFactKey,
} from "@intelligence/personal-beliefs";
import type { ReadItem } from "@intelligence/personal-core";
import { checkKeyFields, sliceGrounded } from "@intelligence/personal-core/checks";
import { endOfDay, inWindow, type PersonalUnmapped } from "./check.ts";
import { codeClaim } from "./code-claim.ts";
import { personProposalClaim } from "./person-proposal.ts";

// A proposal about the owner is never sent to a model. Code builds its one claim: type the kind, subject the
// owner's entity, the fields as given, valid from the record's time, origin agent_record, basis third_party.
// A body takes the kind's life domain and key fields, each key phrase a slice of the quote when one is given,
// and its claim's pipeline version says what the owner did, so its tier is read from the claim: a quoted
// proposal's, an answer's, or an unquoted proposal's. A legacy body, with `what`, is built as it was, with
// its pipeline version, claim id and fact key unchanged.

// A claim this module built, not the shared checker: its pipeline version says so, and rebuildBeliefs reads
// it to set provenance `owner`. Code sets it; no body can. The names are the contract's, which the store's
// reads share.
export { ANSWER_PIPELINE, PROPOSAL_PIPELINE, QUOTED_PROPOSAL_PIPELINE };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Or the claim refused by the claim checks, filed unmapped with its reason.
type ProposalOutcome =
  | { record: ClaimRecord }
  | { code: "bad_proposal" | "client_scoped" }
  | { unmapped: PersonalUnmapped };

type AgentDue = Extract<DueItem, { source: "agent_record" }>;
// What one claim about the owner is built from: its kind and fields, the passage its text values
// must be slices of (none: each value is its own), its basis, the pipeline version code sets on
// it, and its place among its record's.
type OwnerFact = {
  kind: StoredAboutYouKind;
  fields: Readonly<Record<string, unknown>>;
  passage: string | undefined;
  basis: "third_party" | "explicit_self";
  pipeline: string;
  index: number;
};

// `read` is the record's verified read (interpret.ts readRecord), whose label the claim carries.
export function proposalClaim(
  record: OpenedRecord,
  due: AgentDue,
  read: ReadItem,
  generation: number,
): ProposalOutcome {
  // A propose_person body, a proposal about a person, is built by its own code.
  const person = parsePersonProposalBody(record.body);
  if (person !== null) return personProposalClaim(record, due, read, generation, person);
  const proposal = parseProposalBody(record.body);
  // A statement proposal is typed by the model (statementClaims), never here.
  if (proposal === null || isStatement(proposal)) return { code: "bad_proposal" };
  if (proposal.scope === "this_client") return { code: "client_scoped" };
  // So is an interpretation, with their quotes beside it; its fields are the agent's words, kept as
  // written (its passage is the quotes, never grounded again).
  const quotes = !isLegacy(proposal) && "quotes" in proposal ? proposal.quotes : undefined;
  const passage = quotes === undefined ? proposal.quote : quotes.join("\n\n");
  const pipeline = isLegacy(proposal) || passage === undefined ? PROPOSAL_PIPELINE : QUOTED_PROPOSAL_PIPELINE;
  return ownerClaim(record, due, read, generation, {
    kind: proposal.kind,
    fields: proposal.fields,
    passage,
    basis: "third_party",
    pipeline,
    index: 0,
  });
}

// What the agent lane's model is shown of a statement proposal, as a
// finding: the agent's statement and the owner's quote, about an address that stands for the owner. The
// model's subject is never read: every claim of a statement proposal is about the owner.
export const STATEMENT_OWNER = "owner@owner.invalid";
export function statementText(body: StatementProposalBody): string {
  return [
    `An agent's statement of one fact about the owner (${STATEMENT_OWNER}): ${body.statement}`,
    ...(body.quote === undefined
      ? []
      : [`What the owner (${STATEMENT_OWNER}) told the agent, their exact words: ${body.quote}`]),
  ].join("\n");
}

// The kinds a statement proposal may be typed as: the about-you kinds of the registry, never
// `goal`, which an agent proposes with propose_goal.
const STATEMENT_KINDS: readonly AboutYouKind[] = AboutYouKind.options;
// The fields whose values are a closed list's, never words of the statement.
const CLOSED_FIELDS: readonly string[] = ["domain", "polarity", "relation"];

// A statement proposal's claims, from the kinds and fields the model gave
// each candidate of an owner's kind, built as a proposal's are (ownerClaim): the passage its quote,
// the pipeline the quoted one when the owner was quoted. A candidate of any other type is not the
// owner's fact and is left out; one whose fields fail is filed unmapped or dropped. Code, never the
// model, sets the subject, the basis, the pipeline and the label.
export function statementClaims(
  record: OpenedRecord,
  due: AgentDue,
  read: ReadItem,
  generation: number,
  candidates: readonly Candidate[],
): TypedOutcome {
  const body = parseProposalBody(record.body);
  if (body === null || !isStatement(body)) return { code: "bad_proposal" };
  // The model chooses the kind and fields, never words of its own. Each text field but
  // the closed lists' and the dates must use the statement's or the owner's words (the phrase match).
  const grounding = body.quote === undefined ? body.statement : `${body.statement}\n${body.quote}`;
  const pipeline = body.quote === undefined ? PROPOSAL_PIPELINE : QUOTED_PROPOSAL_PIPELINE;
  const grounded = (value: string): boolean => groundText(value, grounding, "phrase") !== null;
  return typedOwnerClaims(record, due, read, generation, candidates, {
    kinds: STATEMENT_KINDS,
    grounded,
    passage: body.quote,
    basis: "third_party",
    pipeline,
  });
}

// What the agent lane's model is shown of an answer stored with no facts:
// the question the owner was asked, when the store could open it, and their exact words, about an address
// that stands for the owner. The agent's words are in neither.
export function answerText(answer: { question: string | null; quote: string }): string {
  return [
    ...(answer.question === null ? [] : [`A question the owner (${STATEMENT_OWNER}) was asked: ${answer.question}`]),
    `The owner's (${STATEMENT_OWNER}) answer, their exact words: ${answer.quote}`,
  ].join("\n");
}

// An answer's claims, from the kinds and fields the model gave, built as a statement proposal's
// are, basis explicit_self, of the answer pipeline: the owner's word relayed, owner_relayed. Every
// about-you kind, a goal among them: the words are the owner's, and only agents' own proposals of a goal
// are routed to propose_goal. An answer becomes a belief with no card, so each text field is one
// unbroken, unnegated run of the owner's quote's words (sliceGrounded), never of the question, which a
// model wrote.
export function answerStatementClaims(
  record: OpenedRecord,
  due: AgentDue,
  read: ReadItem,
  generation: number,
  candidates: readonly Candidate[],
): TypedOutcome {
  const answer = parseOwnerAnswerBody(record.body);
  if (answer === null || answer.typed !== true) return { code: "bad_proposal" };
  const grounded = (value: string): boolean => sliceGrounded(value, answer.quote);
  return typedOwnerClaims(record, due, read, generation, candidates, {
    kinds: StoredAboutYouKind.options,
    grounded,
    passage: answer.quote,
    basis: "explicit_self",
    pipeline: ANSWER_PIPELINE,
  });
}

type Candidate = { type: string; fields: Readonly<Record<string, unknown>> };
type TypedOutcome = { records: ClaimRecord[]; unmapped: PersonalUnmapped[] } | { code: "bad_proposal" };
type Typing = {
  kinds: readonly string[];
  grounded: (value: string) => boolean;
  passage: string | undefined;
  basis: OwnerFact["basis"];
  pipeline: string;
};

// The one construction of claims a model typed about the owner: each candidate of a kind allowed,
// whose every text field but the closed lists' and the dates is grounded in the words it rests on,
// built by ownerClaim; the rest are left out.
function typedOwnerClaims(
  record: OpenedRecord,
  due: AgentDue,
  read: ReadItem,
  generation: number,
  candidates: readonly Candidate[],
  typing: Typing,
): TypedOutcome {
  const records: ClaimRecord[] = [];
  const unmapped: PersonalUnmapped[] = [];
  const grounded = (fields: Readonly<Record<string, unknown>>): boolean =>
    Object.entries(fields).every(
      ([name, value]) =>
        typeof value !== "string" || CLOSED_FIELDS.includes(name) || DATE.test(value) || typing.grounded(value),
    );
  const kept = candidates.filter((candidate) => typing.kinds.includes(candidate.type) && grounded(candidate.fields));
  for (const [index, one] of kept.entries()) {
    const built = ownerClaim(record, due, read, generation, {
      kind: one.type as StoredAboutYouKind,
      fields: one.fields,
      passage: typing.passage,
      basis: typing.basis,
      pipeline: typing.pipeline,
      index,
    });
    if ("record" in built) records.push(built.record);
    else if ("unmapped" in built) unmapped.push(built.unmapped);
  }
  return records.length === 0 && unmapped.length === 0 ? { code: "bad_proposal" } : { records, unmapped };
}

// The claims of an answer the owner gave to a question the system asked, one for each fact it lists, each built
// as a proposal's is but with the quote as its passage and the basis `explicit_self`: the answer is the owner's
// own statement. One fact that fails fails the record, `bad_proposal`. An answer stored `typed` is the model's
// to type (answerStatementClaims); an untyped one with no facts builds no claim. An answer becomes a belief
// with no card, so its phrases stay slices of the quote, never reordered.
export function answerClaims(
  record: OpenedRecord,
  due: AgentDue,
  read: ReadItem,
  generation: number,
): { records: ClaimRecord[] } | { code: "bad_proposal" } {
  const answer = parseOwnerAnswerBody(record.body);
  if (answer === null) return { code: "bad_proposal" };
  const records: ClaimRecord[] = [];
  for (const [index, fact] of (answer.facts ?? []).entries()) {
    const pipeline = isLegacy(fact) ? PROPOSAL_PIPELINE : ANSWER_PIPELINE;
    const built = ownerClaim(record, due, read, generation, {
      kind: fact.kind,
      fields: fact.fields,
      passage: answer.quote,
      basis: "explicit_self",
      pipeline,
      index,
    });
    if (!("record" in built)) return { code: "bad_proposal" };
    records.push(built.record);
  }
  return { records };
}

type FieldRule = { name: string; kind: FieldKind; required: boolean; values?: readonly string[] | undefined };

// The fields a body may hold. A legacy body's are its type's. A typed body's are the kind's life
// domain, from the closed list, its key phrase (KEY_FIELDS), and the type's other fields but `what`
// (a situation's `momentary`; a view's topic, a status's organization, state and date, and a
// visit's date, each of its declared kind). A role's or an affiliation's are its type's but the
// organization entity, so the organization is by name, and an affiliation's name is required.
function rulesOf(type: PersonalType, kind: StoredAboutYouKind, legacy: boolean): readonly FieldRule[] {
  if (legacy) return type.fields;
  if (kind === "role" || kind === "affiliation")
    return type.fields
      .filter((spec) => spec.name !== "organization")
      .map((spec) =>
        kind === "affiliation" && spec.name === "organization_name" ? { ...spec, required: true } : spec,
      );
  const key = KEY_FIELDS[kind];
  const own: FieldRule[] = [
    { name: "domain", kind: "enum", required: true, values: LIFE_DOMAINS },
    { name: key.phrase, kind: "text", required: true },
  ];
  const named = new Set(own.map((rule) => rule.name));
  return [...own, ...type.fields.filter((spec) => spec.name !== "what" && !named.has(spec.name))];
}

type Built = { record: ClaimRecord } | { code: "bad_proposal" } | { unmapped: PersonalUnmapped };

function ownerClaim(record: OpenedRecord, due: AgentDue, read: ReadItem, generation: number, fact: OwnerFact): Built {
  const type = personalType(fact.kind);
  const owner = record.context.ownerEntity;
  // Check 6: the subject is the owner, set by code; the type must list the owner.
  if (type === undefined || !type.subjectKinds.includes("owner")) return { code: "bad_proposal" };

  const given: Record<string, unknown> = { ...fact.fields };
  const legacy = isLegacy(fact);
  const rules = rulesOf(type, fact.kind, legacy);
  const declared = new Set(rules.map((rule) => rule.name));
  if (Object.keys(given).some((name) => !declared.has(name))) return { code: "bad_proposal" };
  const fields: Record<string, unknown> = {};
  const fieldKinds: Record<string, FieldKind> = {};
  for (const rule of rules) {
    const value = given[rule.name];
    if (value === undefined) {
      if (rule.required) return { code: "bad_proposal" };
      continue;
    }
    switch (rule.kind) {
      // Check 4: every text value is a slice of the passage. The body is JSON, which escapes a quote mark,
      // a backslash and a line break, so the passage is its text as the agent wrote it: the quote when it
      // gave one, else the value itself. The phrase match is used. A typed body's quoted value was grounded
      // in its quote when the store took it (propose.ts and answer.ts, the one authority); the pipeline
      // never grounds a stored body again, so a rule made stricter later never skips a body the owner may
      // have confirmed. It is kept as the agent wrote it. A legacy body keeps its slice.
      case "text": {
        if (typeof value !== "string") return { code: "bad_proposal" };
        if (!legacy && fact.passage !== undefined) {
          fields[rule.name] = value.trim();
          break;
        }
        const slice = groundText(value, fact.passage ?? value, "phrase");
        if (slice === null) return { code: "bad_proposal" };
        fields[rule.name] = slice;
        break;
      }
      // The field rule: an enum's value is one of its closed list.
      case "enum":
        if (typeof value !== "string" || !(rule.values ?? []).includes(value)) return { code: "bad_proposal" };
        fields[rule.name] = value;
        break;
      // Check 5: a date lies in the window.
      case "date":
        if (typeof value !== "string" || !DATE.test(value) || !inWindow(value, record.item.recordedAt))
          return { code: "bad_proposal" };
        fields[rule.name] = value;
        break;
      // A situation's `momentary`.
      case "boolean":
        if (typeof value !== "boolean") return { code: "bad_proposal" };
        fields[rule.name] = value;
        break;
      // No owner kind has an entity or a number field; a proposal names none.
      default:
        return { code: "bad_proposal" };
    }
    fieldKinds[rule.name] = rule.kind;
  }

  const evidenceId = record.context.evidenceId;
  const span = `chars:0-${record.body.length}`;
  const idOf = (values: Record<string, unknown>): ClaimId =>
    ClaimId.parse(
      createHash("sha256")
        .update(
          JSON.stringify([
            evidenceId,
            fact.index,
            span,
            fact.pipeline,
            type.id,
            Object.entries(values).sort(([a], [b]) => (a < b ? -1 : 1)),
            generation,
          ]),
          "utf8",
        )
        .digest("hex"),
    );
  // A typed body's fields pass the one check mail's do (personal-core's checkKeyFields); a refusal
  // is the claim's, filed unmapped with its reason. A legacy body is built as it was.
  if (!legacy) {
    const verdict = checkKeyFields(fact.kind, fields, { owner: true });
    if ("reason" in verdict) return { unmapped: { id: idOf(fields), proposedType: type.id, reason: verdict.reason } };
    Object.assign(fields, verdict.fields);
  }
  const content: ClaimContent = { type: type.id, subject: owner, fields };
  const id = idOf(fields);
  const until = fields.until;
  const claim = codeClaim({
    id,
    content,
    basis: fact.basis,
    validFrom: record.item.recordedAt,
    validTo: typeof until === "string" ? endOfDay(until) : undefined,
    evidenceId,
    span,
    label: read.label,
    pipelineVersion: fact.pipeline,
    generation,
  });
  // The key version of the claim's generation, as check.ts takes it. A body of the legacy shape has
  // no key phrase, so it keeps its version 1 key at every version, and a version 2 key has its
  // version 1 beside it.
  const keyed = [content, evidenceId, due.compartments, evidenceId] as const;
  const keyVersion = keyVersionOf(generation);
  return {
    record: {
      claim,
      subjectKind: "owner",
      disclosure: [],
      // A finding's key: its own evidence id, `agent:` before it for a global type, so each
      // proposal is its own fact and its own belief.
      factKey: personalFactKey(...keyed, keyVersion),
      ...(keyVersion === 2 ? legacyKeysOf(...keyed) : {}),
      lane: "agent",
      fieldKinds,
      entities: [],
      origin: "agent_record",
      answersSystem: false,
    },
  };
}

// The owner's release of a confirmed proposal's claim, or of one of their answers'
// claims. A new claim, made by code from the one built above and the store's release row alone:
// the same content, the same evidence (the agent record) and the same pipeline version, so the
// same tier; its own id; the released label, `own`, in place of the record's; and its fact key
// under that label (releasedFactKey), so at version 2 it joins the belief of the same fact from
// the owner's mail. `released` names the owner decision behind it. Nothing in the body, and no
// model, reaches the label: a record whose label is not releasable gives none.
export function releasedClaim(
  original: ClaimRecord,
  released: { ruling: RulingId },
  compartments: readonly string[],
  generation: number,
): ClaimRecord | null {
  if (!releasableLabel(compartments)) return null;
  const { claim } = original;
  const evidenceId = claim.primaryEvidenceId;
  const id = ClaimId.parse(
    createHash("sha256")
      .update(JSON.stringify(["released", claim.id, released.ruling]), "utf8")
      .digest("hex"),
  );
  const keyVersion = keyVersionOf(generation);
  const { legacyFactKey: _key, legacyAltFactKey: _alt, ...rest } = original;
  return {
    ...rest,
    claim: { ...claim, id, label: { compartments: [...RELEASED_LABEL], readers: claim.label.readers } },
    factKey: releasedFactKey(claim.content, evidenceId, RELEASED_LABEL, keyVersion),
    ...(keyVersion === 2 ? legacyKeysOf(claim.content, evidenceId, RELEASED_LABEL, evidenceId) : {}),
    released,
  };
}
