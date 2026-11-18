import type { ClaimCandidate, IdentityResolver, InterpreterOutput, OntologyView } from "@intelligence/contracts";
import type { DueItem, MessageLane, OpenedItem, OpenedRecord } from "@intelligence/contracts/personal";
import { check, type GroundingHook, type Parsed, type ReadItem } from "@intelligence/personal-core";
import {
  type DropDetail,
  findingGrounding,
  NO_OWNER_KEYS,
  ownerSubject,
  type PersonalCheckContext,
  personalCheck,
  personalGrounding,
  strip,
} from "./check.ts";
import { EXTRACT_CONFIG } from "./config.ts";
import { nullAsAbsent } from "./fields-detail.ts";
import { agentOntology, ontologyFor } from "./lane-versions.ts";
import { ownerInFields, wholeNames } from "./mentions.ts";

// The check of a model's answer: the shared check, then the personal checks. Every lane, trial and
// evaluation goes through checkClaims, and a message or a finding through the one wrapper below it,
// so a trial or an evaluation keeps and refuses what a run does.

// A narrowing that withholds an item, and the code it ends with. Model output only narrows: this
// reads what it asked and grants nothing.
export const withheldBy = (narrowing: InterpreterOutput["narrowing"]): "quarantine" | "sensitive" | undefined =>
  narrowing === "quarantine" ? "quarantine" : narrowing === "special_category" ? "sensitive" : undefined;

type Answer = {
  parsed: Parsed;
  read: ReadItem;
  narrowing: InterpreterOutput["narrowing"];
  changeKind: OpenedItem["changeKind"];
  inputHash: string;
  document?: true;
};
type Rules = {
  generation: number;
  ontology: OntologyView;
  identity: IdentityResolver;
  grounded?: GroundingHook;
};

// `context` may be read after the shared check: a capture lane resolves its speaker there.
export async function checkClaims(
  candidates: readonly ClaimCandidate[],
  answer: Answer,
  rules: Rules,
  context: PersonalCheckContext | (() => Promise<PersonalCheckContext>),
  details?: Map<string, DropDetail>,
) {
  const checked = await check(
    candidates.map((candidate) => {
      const fields = nullAsAbsent(rules.ontology.get(candidate.type), candidate.fields);
      return fields === candidate.fields ? candidate : { ...candidate, fields };
    }),
    [answer.read],
    {
      parsed: answer.parsed,
      chain: [],
      narrowing: answer.narrowing,
      changeKind: answer.changeKind,
      inputHash: answer.inputHash,
      ...(answer.document === undefined ? {} : { document: true }),
    },
    {
      config: EXTRACT_CONFIG,
      extractorGeneration: rules.generation,
      ontology: rules.ontology,
      identity: rules.identity,
      ...(rules.grounded === undefined ? {} : { grounded: rules.grounded }),
    },
  );
  const unresolved = Math.max(0, candidates.length - checked.claims.length - checked.unmapped.length);
  const given = typeof context === "function" ? await context() : context;
  return { found: personalCheck(checked, given, details), unresolved };
}

type Asked = {
  parsed: Parsed;
  read: ReadItem;
  due: DueItem;
  promptVersion: string;
  narrowing: InterpreterOutput["narrowing"];
  inputHash: string;
  generation: number;
  repair?: boolean;
  // The port the check resolves names through, when the caller notes what it answers.
  identity?: IdentityResolver;
};

// A message's candidates: the transaction lane's subject is the owner, set by code.
export const messageCandidates = (
  lane: MessageLane,
  claims: InterpreterOutput["claims"],
  parsed: Parsed,
  opened: OpenedItem,
): ClaimCandidate[] => (lane === "transaction" ? ownerSubject(strip(claims), parsed, opened) : strip(claims));

// A message's candidates, checked under the types of the version asked.
export async function checkMessageClaims(
  candidates: readonly ClaimCandidate[],
  on: Asked & { lane: MessageLane; opened: OpenedItem },
  details?: Map<string, DropDetail>,
) {
  const { parsed, read, lane, opened, due, promptVersion, narrowing, inputHash, generation } = on;
  const ontology = ontologyFor(lane, promptVersion);
  const checked = await checkClaims(
    wholeNames(candidates, parsed),
    { parsed, read, narrowing, changeKind: opened.changeKind, inputHash },
    { generation, ontology, identity: on.identity ?? opened.context.identity, grounded: personalGrounding },
    { parsed, item: opened, due, lane, promptVersion, repair: on.repair === true },
    details,
  );
  return { ...checked, ontology };
}

// A finding's candidates, under the types of the version asked. `document`: the shared checker's word
// for a text with no author, which credits a claim to nobody and never as first-hand; without it an
// authorless segment is `author_unknown`. A domain is grounded as in a message, in the body's text,
// since a finding has no author.
export async function checkFindingClaims(
  candidates: readonly ClaimCandidate[],
  on: Asked & { record: OpenedRecord },
  details?: Map<string, DropDetail>,
) {
  const { parsed, read, record, due, promptVersion, narrowing, inputHash, generation } = on;
  const ontology = agentOntology(promptVersion);
  const keys = record.ownerKeys ?? NO_OWNER_KEYS;
  const checked = await checkClaims(
    wholeNames(ownerInFields(candidates as ClaimCandidate[], parsed, keys), parsed),
    { parsed, read, narrowing, changeKind: "live", inputHash, document: true },
    { generation, ontology, identity: on.identity ?? record.context.identity, grounded: findingGrounding(keys) },
    { parsed, record, due, lane: "agent", promptVersion, repair: on.repair === true },
    details,
  );
  return { ...checked, ontology };
}
