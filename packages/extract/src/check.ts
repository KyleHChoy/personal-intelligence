import type { BasisType, Claim, ClaimCandidate, FieldKind, LocalEntityId, Timestamp } from "@intelligence/contracts";
import {
  type ClaimRecord,
  type DisclosureClass,
  type DueCapture,
  type DueDocument,
  type DueItem,
  KEY_FIELDS,
  LIFE_DOMAINS,
  type MessageLane,
  noticeTypesFor,
  type OpenedItem,
  type OpenedRecord,
  type OwnerSideKind,
  type PersonalUnmappedReason,
  RefusalWord,
  type SubjectKind,
} from "@intelligence/contracts/personal";
import {
  cutFromNegation,
  groundDurable,
  groundName,
  groundNumber,
  groundText,
  groundTexting,
  isStopword,
  keyVersionOf,
  legacyKeysOf,
  noticeFactKey,
  noticeSource,
  personalFactKey,
  personalType,
  type RepairRule,
  repairText,
  type TextingRule,
} from "@intelligence/personal-beliefs";
import {
  type Checked,
  DAY_MS,
  type GroundingHook,
  mentionDomain,
  normalizeAddress,
  type Parsed,
  segmentAt,
} from "@intelligence/personal-core";
import { checkKeyFields } from "@intelligence/personal-core/checks";
import { isFullName } from "@intelligence/personal-core/items";
import { commitmentRefusal } from "./commitment-bar.ts";
import { ATOMIC_VERSIONS, commitmentBarVersions, FACT_KIND_HISTORY } from "./lane-versions.ts";

// The personal checks. Code sets every field of a claim record; nothing here reads a model's words
// but the values it grounds in the passage.

// A message's item, or an agent record's, whose lane is `agent`, or a document's, whose `passages`
// are the spans its request listed: a claim cites exactly one of them. A meeting's, whose
// `passages` are its request's listed spans and whose `attribute` is the lane's attribution of one
// claim, by code: who is credited, its basis and its valid_from, or `bad_speaker`. A moment's, the
// same, its `startedAt` the moment's observed time and its `captureKey` the moment's.
export type MeetingAttribution = { basis: BasisType; assertedBy?: LocalEntityId; validFrom: Timestamp } | "bad_speaker";
type CaptureSource = {
  ownerEntity: LocalEntityId;
  kindOf(entity: LocalEntityId): SubjectKind | undefined;
  startedAt: Timestamp;
  captureKey: string;
  // A meeting asked with version 3 grounds its text values durably.
  durable?: boolean;
  texting?: (rule: TextingRule | "none") => void;
  // Whether the owner took part, read by the lane from the item's participants; an intro_offer is
  // kept only when the owner did. Absent is no.
  ownerPresent?: boolean;
  // The owner's time zone, null while unset: the day a line was said on the owner's clock.
  ownerZone?: string | null;
  attribute(claim: Claim): MeetingAttribution;
};
// `promptVersion`: the version the item's call asked, when the lane's grounding depends on it
// (ATOMIC_PHRASE below).
// `repair`: PI_EXTRACT_REPAIR is on, and a text value the match refused is tried once by repairText.
export type PersonalCheckContext = { repair?: boolean } & (
  | { parsed: Parsed; item: OpenedItem; due: DueItem; lane: MessageLane; promptVersion?: string }
  | { parsed: Parsed; record: OpenedRecord; due: DueItem; lane: "agent"; promptVersion?: string }
  | { parsed: Parsed; item: OpenedItem; due: DueDocument; lane: "document"; passages: ReadonlySet<string> }
  | {
      parsed: Parsed;
      capture: CaptureSource;
      due: DueCapture;
      lane: "meeting" | "moment";
      passages: ReadonlySet<string>;
      promptVersion?: string;
    }
);

// What the checks read of the item, whichever it is. An agent record has no direction, no thread
// and no system mark: its thread-scoped fact key is its own evidence id's, and its origin is set by
// code from its source kind. A document has no direction and no author, so it is never inbound, and
// a claim from it is dated by its modified time where a message's is by its sent time.
type Source = {
  ownerEntity: LocalEntityId;
  kindOf(entity: LocalEntityId): SubjectKind | undefined;
  observedAt: string;
  datedAt: Timestamp;
  thread: string;
  inbound: boolean;
  answersSystem: boolean;
  agent: boolean;
};
const sourceOf = (context: PersonalCheckContext): Source => {
  // A meeting is never inbound and has no system mark; its thread is its capture key, so a
  // statement keeps its fact key across revisions.
  if ("capture" in context) {
    const { capture } = context;
    return {
      ownerEntity: capture.ownerEntity,
      kindOf: capture.kindOf,
      observedAt: capture.startedAt,
      datedAt: capture.startedAt,
      thread: capture.captureKey,
      inbound: false,
      answersSystem: false,
      agent: false,
    };
  }
  if ("record" in context) {
    const { record, due } = context;
    return {
      ownerEntity: record.context.ownerEntity,
      kindOf: record.kindOf,
      observedAt: record.item.recordedAt,
      datedAt: due.sentAt,
      thread: record.context.evidenceId,
      inbound: false,
      answersSystem: false,
      agent: true,
    };
  }
  const { item } = context;
  const common = {
    ownerEntity: item.context.ownerEntity,
    kindOf: item.kindOf,
    observedAt: item.raw.observedAt,
    thread: item.raw.threadId ?? item.context.evidenceId,
    answersSystem: item.answersSystem,
    agent: false,
  };
  if (context.lane === "document") return { ...common, datedAt: context.due.modifiedAt, inbound: false };
  const { due } = context;
  return { ...common, datedAt: due.sentAt, inbound: due.source === "email" && due.triage.direction === "inbound" };
};
export type PersonalUnmapped = {
  id: string;
  proposedType: string;
  reason: PersonalUnmappedReason;
  field?: string;
  issue?: string;
};

// What the owner was observed doing is code's to state (the activity step), never a model's.
const REFUSED_BASIS_FIELD = "basis:system_observed";
export function strip(candidates: ClaimCandidate[]): ClaimCandidate[] {
  return candidates.map(({ validFrom: _from, validTo: _to, context: _context, assertedBy: _by, ...rest }) =>
    rest.basis === "system_observed" ? { ...rest, fields: { ...rest.fields, [REFUSED_BASIS_FIELD]: true } } : rest,
  );
}

// A compartment with no owner address gives the empty address, which no header holds, so it is
// refused the same way and the model's own subject is never kept.
export function ownerSubject(candidates: ClaimCandidate[], parsed: Parsed, item: OpenedItem): ClaimCandidate[] {
  const owners = item.context.ownerAddresses.map((address) => address.toLowerCase());
  const headers = ["to", "cc", "bcc", "from"]
    .flatMap((name) => parsed.headers[name] ?? [])
    .map((address) => address.toLowerCase());
  const address = headers.find((one) => owners.includes(one)) ?? owners[0] ?? "";
  return candidates.map((candidate) => ({
    ...candidate,
    subject: { key: { kind: "address", value: address }, observedAt: item.raw.observedAt },
  }));
}

// `project:this` is grounded, since code sets the project. So a model cannot attach a fact to an
// organization the passage does not name, even one the store knows. Asked only about a mention the
// shared rule refused.
export const personalGrounding: GroundingHook = (mention, segment) => {
  if (mention.key.kind !== "source_id") return false;
  if (mention.key.value === "project:this") return true;
  const domain = mentionDomain(mention.key.value);
  if (domain === null) return false;
  const author =
    segment.author?.key.kind === "address" ? normalizeAddress(segment.author.key.value)?.split("@")[1] : undefined;
  return author === domain || groundText(domain, segment.text, "phrase") !== null;
};

// Who a finding names when it names the owner.
export type OwnerKeys = { names: readonly string[]; addresses: readonly string[] };
export const NO_OWNER_KEYS: OwnerKeys = { names: [], addresses: [] };
const firstWord = (name: string): string => name.trim().split(/\s+/u)[0] ?? "";
const bare = (word: string): string => word.toLowerCase().replace(/\.$/u, "");
const HONORIFICS = new Set("mr mrs ms mx dr prof professor sir madam miss rev hon lord lady".split(" "));
// First names that are also everyday words, which a sentence's first word can be: the whole name, then.
const WORD_NAMES = new Set("will may might can shall must mark grant hope bill".split(" "));
export const ownerNamedWhole = (owner: OwnerKeys, text: string): boolean =>
  owner.addresses.some((address) => groundText(address, text, "phrase") !== null) ||
  owner.names.some(
    (name) => isFullName(name) && !HONORIFICS.has(bare(firstWord(name))) && groundName(name, text) !== null,
  );

// The shared check's hook for a finding: `owner:this` is grounded when the segment names the owner
// whole, or holds a name's first word as a whole name written as the name writes it, never an
// honorific, a stopword or a word that is also a first name. A longer name beginning with it is
// someone else. Only names and addresses code holds count (the store's ownerKeys), never the word
// "owner". An entity field takes the whole name alone (mentions.ts, ownerInFields), since no card
// follows it. Every other mention is personalGrounding's.
export const OWNER_THIS = "owner:this";
export const findingGrounding =
  (owner: OwnerKeys): GroundingHook =>
  (mention, segment) => {
    if (mention.key.kind !== "source_id" || mention.key.value !== OWNER_THIS)
      return personalGrounding(mention, segment);
    const first = (name: string): boolean => {
      const word = firstWord(name);
      const plain = bare(word);
      return (
        word !== "" &&
        !HONORIFICS.has(plain) &&
        !WORD_NAMES.has(plain) &&
        !isStopword(plain) &&
        groundName(word, segment.text) === word
      );
    };
    return ownerNamedWhole(owner, segment.text) || owner.names.some(first);
  };

export const endOfDay = (value: string): string =>
  `${new Date(Date.parse(value.length === 10 ? `${value}T00:00:00.000Z` : value)).toISOString().slice(0, 10)}T23:59:59.999Z`;

export const inWindow = (value: string, observedAt: string): boolean => {
  const at = Date.parse(value);
  const seen = Date.parse(observedAt);
  return Number.isFinite(at) && at >= seen - 400 * DAY_MS && at <= seen + 800 * DAY_MS;
};

// What failed, for a drop's log line: the field of the type (a name the type lists, else none) and
// an issue code, both code's own words. Never a value.
export type DropDetail = { field?: string; issue?: string };
type Verdict = { claim: Claim; repairs: RepairRule[] } | ({ reason: PersonalUnmappedReason } & DropDetail);

// A drop's detail as a refusal row holds it: only what is code's words by shape.
export const refusalWords = ({ field, issue }: DropDetail): DropDetail => ({
  ...(RefusalWord.safeParse(field).success ? { field: field as string } : {}),
  ...(RefusalWord.safeParse(issue).success ? { issue: issue as string } : {}),
});

// Which typed key field the claim intake refused, and why, for the log alone.
function keyFieldsDetail(kind: string, fields: Readonly<Record<string, unknown>>, reason: string): DropDetail {
  // checkNamed: a role with no title, a title or an organization name over the bounds, or a title
  // that does not stand alone.
  if (kind === "role" || kind === "affiliation")
    return reason === "not_standalone"
      ? { field: "title", issue: reason }
      : kind === "role" && typeof fields.title !== "string"
        ? { field: "title", issue: "missing" }
        : { issue: "over_bounds" };
  const phrase = KEY_FIELDS[kind as OwnerSideKind].phrase;
  if (reason === "bad_fields")
    return (LIFE_DOMAINS as readonly unknown[]).includes(fields.domain)
      ? { field: phrase, issue: "over_bounds" }
      : { field: "domain", issue: "not_a_domain" };
  return { field: phrase, issue: reason };
}

// The atomic versions (correspondence version 4, an agent record's version 3) ask one fact per
// claim, so they split a sentence that holds two; a commitment's and a plan's `what` is then
// grounded as a phrase of the passage, as the owner-side kinds already are under them, not as a
// whole statement. Every other lane and version unchanged. The second-degree and fact-kind versions
// are built on them, so they are atomic too (ATOMIC_VERSIONS, personal-beliefs;
// fact-kind-prompts.test.ts holds it to the prompts' text).
const ATOMIC_PHRASE: Readonly<Record<string, readonly string[]>> = { commitment: ["what"], plan: ["what"] };
export function atomicPhrase(
  context: { lane: PersonalCheckContext["lane"]; promptVersion?: string | undefined },
  type: string,
  field: string,
): boolean {
  const versions = context.lane === "correspondence" || context.lane === "agent" ? ATOMIC_VERSIONS[context.lane] : [];
  const atomic = context.promptVersion !== undefined && versions.includes(context.promptVersion);
  return atomic && (ATOMIC_PHRASE[type]?.includes(field) ?? false);
}

// The prompt versions, by lane, whose claims pass the pinned kind rules (personal-core's
// checkKeyFields `kinds`: dated_task, agent_instruction, not_about_owner): the fact-kind versions of
// each lane, which offer the view, status and visited kinds, and no earlier one, so a claim of an
// earlier version, kept before, is checked as it was at every rebuild and never dropped by a rule
// made later.
export const KIND_RULE_VERSIONS: Readonly<Partial<Record<PersonalCheckContext["lane"], readonly string[]>>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(FACT_KIND_HISTORY).map(([lane, versions]) => [lane, Object.freeze([...versions])]),
    ),
  );
export const kindRules = (context: {
  lane: PersonalCheckContext["lane"];
  promptVersion?: string | undefined;
}): boolean =>
  context.promptVersion !== undefined && (KIND_RULE_VERSIONS[context.lane] ?? []).includes(context.promptVersion);

// The prompt versions whose commitments pass the bar, by their rows: each mail and chat lane's fifth wording and any
// after it, which tell the model what it refuses. A claim of an earlier version keeps passing as it
// did at every rebuild, as the kind rules do, so nothing stored is dropped by this rule. An agent's
// findings hold to it from the prompt that files them under a project, the version agents run,
// so its findings raise no weaker a card than mail does.
export const COMMITMENT_BAR_VERSIONS: Readonly<Partial<Record<PersonalCheckContext["lane"], readonly string[]>>> =
  Object.freeze({
    correspondence: commitmentBarVersions("correspondence"),
    moment: commitmentBarVersions("moment"),
    agent: commitmentBarVersions("agent"),
  });
const commitmentBar = (
  claim: Claim,
  fields: Readonly<Record<string, unknown>>,
  speaker: LocalEntityId | undefined,
  passage: string,
  context: PersonalCheckContext,
  said: string,
): Verdict | null => {
  if (claim.content.type !== "commitment" || typeof fields.what !== "string") return null;
  const version = "promptVersion" in context ? context.promptVersion : undefined;
  if (version === undefined || !(COMMITMENT_BAR_VERSIONS[context.lane] ?? []).includes(version)) return null;
  const refused = commitmentRefusal({
    what: fields.what,
    subject: claim.content.subject,
    counterparty: fields.counterparty,
    // An agent reports what others said: its "I will" in a finding's words is no promise of its own.
    speaker: context.lane === "agent" ? undefined : speaker,
    due: fields.due,
    before: passage.slice(0, Math.max(0, passage.indexOf(fields.what))),
    said,
    zone: "capture" in context ? context.capture.ownerZone : "item" in context ? context.item.context.ownerZone : null,
  });
  return refused === null ? null : { reason: refused.reason, field: "what", issue: refused.issue };
};

// The generation that holds the rule below. A check that changes what an item yields is raised with
// its generation, so the rule waits for that raise: below it every candidate passes as it did, and
// no stored claim moves.
export const NEGATION_CUT_GENERATION = 6;

// An owner-side claim's key phrase cut from after a negation of its clause says the reverse of its
// source. A preference that says `avoids` carried the negation itself, as its polarity. A status's
// process is a label whose outcome is in its state.
function cutUnderNegation(claim: Claim, type: string, field: string, slice: string, passage: string): boolean {
  if (claim.extractorGeneration < NEGATION_CUT_GENERATION || !Object.hasOwn(KEY_FIELDS, type)) return false;
  if (KEY_FIELDS[type as OwnerSideKind].phrase !== field) return false;
  if (type === "status" || (type === "preference" && claim.content.fields.polarity === "avoids")) return false;
  return cutFromNegation(slice, passage);
}

// Each text value is replaced in `fields` by its slice; a repair used is pushed on `repairs`. The
// refusal of the first value that is not, or null.
function groundFields(
  claim: Claim,
  context: PersonalCheckContext,
  type: NonNullable<ReturnType<typeof personalType>>,
  passage: string,
  fields: Record<string, unknown>,
  repairs: RepairRule[],
): Verdict | null {
  const source = sourceOf(context);
  for (const spec of type.fields) {
    const value = fields[spec.name];
    if (value === undefined) continue;
    if (spec.kind === "text") {
      const grounding = atomicPhrase(context, type.id, spec.name) ? "phrase" : (type.grounding[spec.name] ?? "phrase");
      let slice = ("capture" in context && context.capture.durable === true ? groundDurable : groundText)(
        value as string,
        passage,
        grounding,
      );
      // Still the passage's own slice, never the model's words.
      const texting = "capture" in context ? context.capture.texting : undefined;
      if (
        slice === null &&
        texting !== undefined &&
        grounding === "phrase" &&
        Object.hasOwn(KEY_FIELDS, type.id) &&
        KEY_FIELDS[type.id as OwnerSideKind].phrase === spec.name
      ) {
        const tolerant = groundTexting(value as string, passage);
        texting(tolerant?.rule ?? "none");
        slice = tolerant?.slice ?? null;
      }
      // Still the passage's own slice: repairText keeps only what the match above takes.
      if (slice === null && context.repair === true) {
        const repaired = repairText(value as string, passage, grounding, {
          firstPerson: source.kindOf(claim.content.subject) === "owner" && claim.assertedBy === claim.content.subject,
        });
        if (repaired !== null) {
          slice = repaired.slice;
          repairs.push(repaired.rule);
        }
      }
      // A statement whose words are in the passage but not as a whole sentence or line is
      // `part_of_line`; anything else is not in it.
      if (slice === null)
        return {
          reason: "bad_fields",
          field: spec.name,
          issue:
            grounding === "statement" && groundText(value as string, passage, "phrase") !== null
              ? "part_of_line"
              : "not_in_passage",
        };
      if (cutUnderNegation(claim, type.id, spec.name, slice, passage))
        return { reason: "negation_cut", field: spec.name };
      fields[spec.name] = slice;
    }
    if (spec.kind === "number" && !groundNumber(value as number, passage))
      return { reason: "bad_fields", field: spec.name, issue: "not_in_passage" };
  }
  return null;
}

function judge(claim: Claim, context: PersonalCheckContext): Verdict {
  const { parsed, lane } = context;
  const source = sourceOf(context);
  const type = personalType(claim.content.type);
  const span = claim.evidence[0]?.span ?? "";
  const segment = segmentAt(parsed, span);
  if (type === undefined || segment === undefined) return { reason: "unknown_type" };
  if (Object.hasOwn(claim.content.fields, REFUSED_BASIS_FIELD))
    return { reason: "bad_fields", field: "basis", issue: "system_observed" };
  if (segment.quoted) return { reason: "bad_span", issue: "quoted" };
  if ("passages" in context && !context.passages.has(span)) return { reason: "bad_span", issue: "unlisted" };
  // A document is never inbound: the check is not run for one.
  if (source.inbound && claim.assertedBy === source.ownerEntity)
    return { reason: "bad_speaker", issue: "inbound_owner" };
  if (lane === "correspondence" && span.startsWith("subject:")) return { reason: "bad_span", issue: "subject_line" };

  if (
    type.id === "affiliation" &&
    claim.content.fields.organization === undefined &&
    claim.content.fields.organization_name === undefined
  )
    return { reason: "bad_fields", field: "organization", issue: "missing" };

  const fields: Record<string, unknown> = { ...claim.content.fields };
  const repairs: RepairRule[] = [];
  const ungrounded = groundFields(claim, context, type, segment.text, fields, repairs);
  if (ungrounded !== null) return ungrounded;

  // A refused claim is filed unmapped and counted; only the switched repair and re-ask go further. A role or an affiliation passes it too, from the generation of fact key
  // version 2, as a proposed one does.
  const ownerSide = Object.hasOwn(KEY_FIELDS, type.id) ? (type.id as OwnerSideKind) : undefined;
  const named =
    (type.id === "role" || type.id === "affiliation") && keyVersionOf(claim.extractorGeneration) === 2
      ? type.id
      : undefined;
  const checked =
    ownerSide !== undefined && typeof fields[KEY_FIELDS[ownerSide].phrase] === "string" ? ownerSide : named;
  if (checked !== undefined) {
    const owner = source.kindOf(claim.content.subject) === "owner";
    const verdict = checkKeyFields(
      checked,
      fields,
      kindRules(context) ? { owner, kinds: { at: source.observedAt } } : { owner },
    );
    if ("reason" in verdict) return { reason: verdict.reason, ...keyFieldsDetail(checked, fields, verdict.reason) };
    Object.assign(fields, verdict.fields);
  }

  for (const spec of type.fields) {
    const value = fields[spec.name];
    if (spec.kind === "date" && value !== undefined && !inWindow(value as string, source.observedAt))
      return { reason: "bad_times", field: spec.name, issue: "out_of_window" };
  }
  if (type.id === "transaction.receipt" && fields.date === undefined)
    fields.date = new Date(source.datedAt).toISOString().slice(0, 10);

  const kind = source.kindOf(claim.content.subject);
  if (kind === undefined || !type.subjectKinds.includes(kind))
    return { reason: "ungrounded_mention", field: "subject", issue: `kind_${kind ?? "unknown"}` };
  for (const spec of type.fields) {
    const value = fields[spec.name];
    if (spec.kind !== "entity" || value === undefined) continue;
    const entityKind = source.kindOf(value as LocalEntityId);
    if (entityKind === undefined || !(type.entityKinds[spec.name] ?? []).includes(entityKind))
      return { reason: "ungrounded_mention", field: spec.name, issue: `kind_${entityKind ?? "unknown"}` };
  }

  const until = fields.until;
  const ends =
    type.fields.some((spec) => spec.name === "until" && spec.kind === "date") && typeof until === "string"
      ? { validTo: endOfDay(until) }
      : {};
  const { subjectAliases: _aliases, validTo: _validTo, ...rest } = claim;
  if ("capture" in context) {
    const { assertedBy: _by, ...unsaid } = rest;
    const attributed = context.capture.attribute(claim);
    if (attributed === "bad_speaker") return { reason: "bad_speaker", issue: "attribution" };
    const barred = commitmentBar(claim, fields, attributed.assertedBy, segment.text, context, attributed.validFrom);
    if (barred !== null) return barred;
    if (type.id === "intro_offer" && !firstHand(claim, attributed.assertedBy, context))
      return { reason: "not_first_hand" };
    return {
      repairs,
      claim: {
        ...unsaid,
        content: { ...claim.content, fields },
        ...ends,
        basis: attributed.basis,
        validFrom: attributed.validFrom,
        ...(attributed.assertedBy === undefined ? {} : { assertedBy: attributed.assertedBy }),
      },
    };
  }
  // So is every claim of a notice, mail a program wrote that triage sent to the transaction lane by
  // its own rule: a notice about the owner is never the owner's own words. A message the owner sent
  // to the lane by hand keeps the lane's basis rule as it was.
  if (type.id === "intro_offer" && !firstHand(claim, claim.assertedBy, context)) return { reason: "not_first_hand" };
  const barred = commitmentBar(claim, fields, claim.assertedBy, segment.text, context, source.datedAt);
  if (barred !== null) return barred;
  return {
    repairs,
    claim: {
      ...rest,
      content: { ...claim.content, fields },
      validFrom: source.datedAt,
      ...ends,
      ...(source.agent || noticeOf(context) !== undefined ? { basis: "third_party" as const } : {}),
    },
  };
}

// Never the model's word: a finding and a document have no speaker, so theirs never are.
function firstHand(claim: Claim, speaker: LocalEntityId | undefined, context: PersonalCheckContext): boolean {
  if (speaker === undefined || speaker !== claim.content.subject) return false;
  if ("capture" in context) return context.capture.ownerPresent === true;
  if (!("item" in context) || context.lane === "document") return false;
  const owners = new Set(
    context.item.context.ownerAddresses.map((address) => normalizeAddress(address) ?? address.toLowerCase()),
  );
  const recipients = ["to", "cc", "bcc"].flatMap((name) => context.parsed.headers[name] ?? []);
  return recipients.some((address) => owners.has(normalizeAddress(address) ?? address.toLowerCase()));
}

// The sender and subject of a message that is a system notice, which triage routed to the
// transaction lane by its own rule. The check reads triage's decision from the due item (`routed`,
// set by the run), never a copy of its rule. The message also carries a machine's mail markers,
// bulk or Gmail's Updates category, so non-bulk Updates mail the decide model's line 5 sends to the lane is a
// notice, and a person's non-bulk Primary mail the decide model under-scores is not. The message is inbound and
// its sender has a parseable address. Undefined for anything else: a message the owner sent to the
// lane by hand, a person's or the owner's own mail, or a sender with no address, keeps the lane's rules as
// they were.
function noticeOf(
  context: PersonalCheckContext,
): { source: string; subject: string; message: string; compartments: readonly string[] } | undefined {
  if (context.lane !== "transaction" || !("item" in context) || context.due.source !== "email") return undefined;
  const { due, parsed } = context;
  if (due.routed !== "transaction" || due.lane !== undefined || due.triage.direction !== "inbound") return undefined;
  if (!due.triage.bulk && due.triage.category !== "updates") return undefined;
  const source = noticeSource(parsed.headers.from?.[0]);
  return source === undefined
    ? undefined
    : {
        source,
        subject: parsed.texts["subject:"] ?? "",
        message: context.item.context.evidenceId,
        compartments: due.compartments,
      };
}

function recordOf(claim: Claim, context: PersonalCheckContext): ClaimRecord {
  const { lane } = context;
  const source = sourceOf(context);
  const type = personalType(claim.content.type);
  const owner = source.ownerEntity;
  const fieldKinds: Record<string, FieldKind> = {};
  const named: LocalEntityId[] = [claim.content.subject, ...(claim.assertedBy === undefined ? [] : [claim.assertedBy])];
  for (const spec of type?.fields ?? []) {
    if (!Object.hasOwn(claim.content.fields, spec.name)) continue;
    fieldKinds[spec.name] = spec.kind;
    if (spec.kind === "entity") named.push(claim.content.fields[spec.name] as LocalEntityId);
  }
  const disclosure: DisclosureClass[] = named.some((entity) => entity !== owner) ? ["third_party"] : [];
  // The key version is the claim's generation's, and a version 2 key has its version 1 beside it.
  const keyed = [
    claim.content,
    source.thread,
    context.lane === "document" ? [context.due.compartment] : context.due.compartments,
    source.agent ? source.thread : undefined,
  ] as const;
  const keyVersion = keyVersionOf(claim.extractorGeneration);
  const subjectKind = source.kindOf(claim.content.subject) as SubjectKind;
  // A claim is a system notice's only when its message is one (noticeOf), it is a statement of a
  // notice type about the owner, no word of the owner's, and no mail the system sent; the record says so
  // (`notice`), and isSystemNotice reads it.
  const message = noticeOf(context);
  const notice =
    message !== undefined &&
    subjectKind === "owner" &&
    noticeTypesFor("promptVersion" in context ? context.promptVersion : undefined).includes(claim.content.type) &&
    claim.statementKind === "stated_fact" &&
    claim.assertedBy !== owner &&
    !claim.systemOriginated;
  // A notice's situation keys by its sender and its subject line (noticeFactKey), at every version
  // and with no legacy key, so it never takes the slot of the owner's own situation and one sender's later
  // notice of a subject supersedes its earlier one.
  return {
    claim,
    subjectKind,
    disclosure,
    ...(notice && claim.content.type === "situation"
      ? {
          factKey: noticeFactKey(claim.content, message.compartments, message.source, message.subject, message.message),
        }
      : { factKey: personalFactKey(...keyed, keyVersion), ...(keyVersion === 2 ? legacyKeysOf(...keyed) : {}) }),
    lane,
    fieldKinds,
    entities: [...new Set(named.filter((entity) => entity !== owner))],
    origin: source.agent || claim.systemOriginated ? "agent_record" : "source",
    answersSystem: source.answersSystem,
    ...(notice ? { notice: true as const } : {}),
  };
}

// For each claim the shared check returned, the checks run in a fixed order and the first failure
// decides the reason. The shared checker's unmapped claims are carried as they are.
// `details`, when given, takes by claim id what failed of each claim these checks refused, for a
// log line alone; the result is what a commit carries, so it holds nothing more.
export function personalCheck(
  checked: Checked,
  context: PersonalCheckContext,
  details?: Map<string, DropDetail>,
): { claims: ClaimRecord[]; unmapped: PersonalUnmapped[]; repairs?: RepairRule[] } {
  const claims: ClaimRecord[] = [];
  const repairs: RepairRule[] = [];
  const unmapped: PersonalUnmapped[] = checked.unmapped.map(({ id, proposedType, reason }) => ({
    id,
    proposedType,
    reason,
  }));
  for (const claim of checked.claims) {
    const verdict = judge(claim, context);
    if ("reason" in verdict) {
      const { reason, ...detail } = verdict;
      unmapped.push({ id: claim.id, proposedType: claim.content.type, reason, ...refusalWords(detail) });
      details?.set(claim.id, detail);
    } else {
      claims.push(recordOf(verdict.claim, context));
      repairs.push(...verdict.repairs);
    }
  }
  return { claims, unmapped, ...(repairs.length === 0 ? {} : { repairs }) };
}
