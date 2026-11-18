// Checking a moment request's answer: each speaker's identity, each claim's attribution and credit
// by the passage it cites, the short-term rule, each dropped candidate's shape and counts, and the
// moments' tallies. Code alone decides; nothing a moment's text says changes a check.

import {
  type Claim,
  type ClaimCandidate,
  type IdentityResolver,
  type InterpreterOutput,
  type LocalEntityId,
  Mention,
  type OntologyView,
  type Timestamp,
} from "@intelligence/contracts";
import type { FiledMention, OpenedMoment, SubjectKind } from "@intelligence/contracts/personal";
import type { TextingRule } from "@intelligence/personal-beliefs";
import { type GroundingHook, normalizeAddress, phoneKey, segmentAt, strictAddress } from "@intelligence/personal-core";
import {
  type CaptureTally,
  citedAs,
  dropCode,
  recordingAnswers,
  SPEAKER,
  speakerNames,
  speakerPort,
} from "./capture-check.ts";
import { type DropDetail, type MeetingAttribution, personalGrounding, refusalWords, strip } from "./check.ts";
import { fieldsDetail } from "./fields-detail.ts";
import type { Found } from "./item-ends.ts";
import { checkClaims } from "./lane-check.ts";
import { FACT_KIND_VERSIONS, MOMENT_TYPES, OWN_LINES_VIEW, ontologyFor } from "./lane-versions.ts";
import {
  type Credit,
  type FilingOptions,
  fileable,
  type MentionKey,
  notingUnresolved,
  sameKey,
  wholeNames,
} from "./mentions.ts";
import type { MomentMember, MomentParticipant, MomentPassage, MomentPlan } from "./moments-plan.ts";
import { ownWordMoment } from "./own-word.ts";

const OWNER_LABEL = "owner";

type Who = { entity: LocalEntityId; key?: MentionKey } | { name: string } | null;

// The identity step of one moment: through the store's read-only port, which links an address held
// by exactly one entity under the moment's label and a name only through the owner's binding; the
// kinds it answered with, for the checks.
function momentIdentity(opened: OpenedMoment, people: ReadonlyMap<string, MomentParticipant>) {
  const kinds = new Map<LocalEntityId, SubjectKind>();
  // The labels whose source moment phone handle resolved nobody.
  const unbound = new Set<string>();
  const byLabel = new Map([...people.values()].map((one) => [one.label, one.mention]));
  const linked = (entity: LocalEntityId): void =>
    void kinds.set(entity, opened.kindOf(entity) ?? (entity === opened.context.ownerEntity ? "owner" : "person"));
  const resolve: IdentityResolver["resolve"] = async (mention, store, requestId, from) => {
    const resolution = await opened.context.identity.resolve(mention, store, requestId, from);
    if (resolution.outcome === "linked") linked(resolution.entity);
    return resolution;
  };
  const answers = new Map<string, Promise<Who>>();
  const speakerWho = (label: string): Promise<Who> => {
    let found = answers.get(label);
    if (found === undefined) {
      found = (async (): Promise<Who> => {
        if (label === OWNER_LABEL) {
          kinds.set(opened.context.ownerEntity, "owner");
          const [first] = opened.context.ownerAddresses.flatMap((one) => normalizeAddress(one) ?? []).sort();
          return {
            entity: opened.context.ownerEntity,
            ...(first === undefined ? {} : { key: { kind: "address", value: first } }),
          };
        }
        const mention = byLabel.get(label);
        if (mention === undefined) return null;
        const observedAt = opened.capture.observedAt;
        const requestId = `moment-speaker:${opened.context.evidenceId}:${label}` as never;
        if (mention.address !== undefined && strictAddress(mention.address)) {
          const resolution = await resolve(
            { key: { kind: "address", value: mention.address }, observedAt },
            "personal",
            requestId,
          );
          if (resolution.outcome === "linked")
            return { entity: resolution.entity, key: { kind: "address", value: mention.address } };
        }
        // A screen moment's handle names nobody.
        const key = opened.item.source === undefined || mention.handle === undefined ? null : phoneKey(mention.handle);
        if (key !== null && mention.handle !== undefined) {
          const keyed = await resolve({ key: { kind: "address", value: key }, observedAt }, "personal", requestId);
          if (keyed.outcome === "linked") return { entity: keyed.entity, key: { kind: "address", value: key } };
          const bound = await resolve(
            { key: { kind: "name", value: mention.handle }, observedAt },
            "personal",
            requestId,
          );
          if (bound.outcome === "linked") return { entity: bound.entity, key: { kind: "name", value: mention.handle } };
          unbound.add(label);
          return { name: mention.handle };
        }
        // An address that links nobody, or is no strict addr-spec, leaves the name: bound by the
        // owner it links, and otherwise it is filed for the owner to bind.
        if (mention.name !== undefined) {
          const resolution = await resolve(
            { key: { kind: "name", value: mention.name }, observedAt },
            "personal",
            requestId,
          );
          return resolution.outcome === "linked"
            ? { entity: resolution.entity, key: { kind: "name", value: mention.name } }
            : { name: mention.name };
        }
        return null;
      })();
      answers.set(label, found);
    }
    return found;
  };
  const port = speakerPort(speakerWho, resolve);
  return {
    port,
    speakerWho,
    unbound: (label: string): boolean => unbound.has(label),
    kindOf: (entity: LocalEntityId): SubjectKind | undefined => kinds.get(entity) ?? opened.kindOf(entity),
  };
}

// Any other is as dropCode says.
const heldCode = (
  code: string,
  subject: Mention | undefined,
  identity: Pick<ReturnType<typeof momentIdentity>, "unbound">,
): string =>
  code === "unresolved_subject" &&
  subject?.key.kind === "source_id" &&
  subject.key.value.startsWith(SPEAKER) &&
  identity.unbound(subject.key.value.slice(SPEAKER.length))
    ? "held"
    : code;

const momentGrounding =
  (labels: ReadonlySet<string>): GroundingHook =>
  (mention, segment) =>
    mention.key.kind === "source_id" && mention.key.value.startsWith(SPEAKER)
      ? labels.has(mention.key.value.slice(SPEAKER.length))
      : personalGrounding(mention, segment);

// The model's `explicit_self` must have the passage's speaker, by its label, as subject; an agent's
// or an unknown passage takes only third_party; an agent's line outside an agent app is
// bad_speaker. The owner's line is the owner's under the owner's word, explicit_self when about the
// owner; a participant's is that participant's, explicit_self when the model said so of them; every
// other line is nobody's. Dated by the moment's observed time; a passage of a source moment by its
// first message's own time.
const passageTime = (passage: Pick<MomentPassage, "opened" | "range">): Timestamp => {
  const { item, capture } = passage.opened;
  // The message the passage starts in: the last turn starting at or before it.
  const at =
    item.source === undefined ? undefined : item.turns?.filter((turn) => turn.from <= passage.range.from).at(-1)?.at;
  // In UTC, as the store writes every other time: a turn's `at` is Lens's, with the Mac's offset,
  // and claims' times are compared as strings (pipeline-restatement.ts, grouping.ts).
  return (at === undefined ? capture.observedAt : new Date(Date.parse(at)).toISOString()) as Timestamp;
};
function attributeMoment(
  passage: MomentPassage,
  candidate: ClaimCandidate,
  claim: Claim,
  who: Who,
  ownWord: boolean,
): MeetingAttribution {
  const subject = candidate.subject.key;
  const label = passage.speaker;
  const saidBy =
    label !== null && label !== "agent" && subject.kind === "source_id" && subject.value === `${SPEAKER}${label}`;
  if (candidate.basis === "explicit_self" && !saidBy) return "bad_speaker";
  if (label === "agent" && !passage.opened.capture.agentApp) return "bad_speaker";
  const validFrom = passageTime(passage);
  const nobody: MeetingAttribution = { basis: "third_party", validFrom };
  const owner = passage.opened.context.ownerEntity;
  if (label === OWNER_LABEL)
    return ownWord
      ? { basis: claim.content.subject === owner ? "explicit_self" : "third_party", assertedBy: owner, validFrom }
      : nobody;
  if (label === null || label === "agent" || who === null || !("entity" in who) || who.entity === owner) return nobody;
  return {
    basis:
      candidate.basis === "explicit_self" && claim.content.subject === who.entity ? "explicit_self" : "third_party",
    assertedBy: who.entity,
    validFrom,
  };
}

// First-hand when the subject is that speaker, by label or by key.
function momentCredit(
  passage: MomentPassage,
  candidate: ClaimCandidate,
  who: Who,
  ownWord: boolean,
  listed: boolean,
): Credit | null {
  const label = passage.speaker;
  if (!listed || label === null || label === "agent" || who === null || !("entity" in who) || who.key === undefined)
    return null;
  if (label === OWNER_LABEL ? !ownWord : who.entity === passage.opened.context.ownerEntity) return null;
  const subject = candidate.subject.key;
  return {
    speaker: who.key,
    firstHand: (subject.kind === "source_id" && subject.value === `${SPEAKER}${label}`) || sameKey(subject, who.key),
  };
}

// The candidate's span as the shared checker reads it: a listed `mom:` span becomes its passage's
// `chars:` form; any other span is marked unlisted, which no segment holds, so the check refuses it
// (`bad_span`) and records it against the request's first moment.
const passageOf = (
  candidate: ClaimCandidate,
  plan: MomentPlan,
): { passage: MomentPassage; listed: boolean; candidate: ClaimCandidate } => {
  const passage = plan.passages.find((one) => one.span === candidate.span);
  const first = plan.passages[0] as MomentPassage;
  return passage === undefined
    ? { passage: first, listed: false, candidate: { ...candidate, span: `unlisted:${candidate.span}` } }
    : { passage, listed: true, candidate: { ...candidate, span: passage.chars } };
};

// One dropped candidate's shape, for `moment_dropped`: its drop code and, as
// counts, its type, the field that failed and the issue (each a name of code's: a type of the lane,
// a field its type lists, an issue code), the turns its passage spans, the moment's read, its
// passage's speaker, and its statement kind and basis (the schema's own values). Never a value.
type MomentDrop = { evidence: MomentMember["evidenceId"]; code: string; counts: Record<string, number> };

// A short-term chat claim, by code, before the shared checker, so the owner's rule
// that chat claims are mid to long term does not rest on the prompt alone (`short_term`):
// - a situation whose end falls within 7 days of the passage's time (a past end too), or that the
//   model marked momentary;
// - a situation's state, a need's object or a constraint's rule that holds a texting word for
//   today or this week (tmrw, rn, tonite, wknd), which claim intake's relative-time check
//   does not know;
// - a commitment or a plan whose what holds no word beyond an acknowledgment's, an emoji or a mark
//   alone included. A commitment or a dated plan with something to do is kept however soon it falls.
// It runs before identity, so a short-term claim about an unbound handle is dropped, never held.
const SHORT_UNTIL_MS = 7 * 86_400_000;
const ACKNOWLEDGMENT_WORDS = new Set(
  "ok okay k kk yes yeah yea ya yep yup yess sure thing will do ill i im it that thats the a plan like sounds sound good great fine cool bet fs for np no problem on my way omw coming soon got gotcha alright right thanks thank thx you ty sg see then there please def definitely absolutely perfect awesome nice lol haha".split(
    " ",
  ),
);
// Texting abbreviations alone: plain words such as today or this week also sit in lasting states
// ("starting the new job today"), and claim intake already judges those.
const NOW_WORDS = ["tmrw", "tmr", "tmw", "tmrrw", "tn", "tonite", "rn", "atm", "wknd"];
const textedWords = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[\u2019']/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
export function shortTermOf(candidate: Pick<ClaimCandidate, "type" | "fields">, at: Timestamp): boolean {
  const fields = candidate.fields as Record<string, unknown>;
  if (candidate.type === "situation") {
    if (fields.momentary === true) return true;
    if (typeof fields.until === "string") {
      const end = Date.parse(fields.until.length === 10 ? `${fields.until}T23:59:59Z` : fields.until);
      if (Number.isFinite(end) && end - Date.parse(at) <= SHORT_UNTIL_MS) return true;
    }
  }
  const phrase =
    candidate.type === "situation"
      ? fields.state
      : candidate.type === "need"
        ? fields.object
        : candidate.type === "constraint"
          ? fields.rule
          : undefined;
  if (typeof phrase === "string") {
    const words = ` ${textedWords(phrase).join(" ")} `;
    if (NOW_WORDS.some((word) => words.includes(` ${word} `))) return true;
  }
  if ((candidate.type === "commitment" || candidate.type === "plan") && typeof fields.what === "string")
    return textedWords(fields.what).every((word) => ACKNOWLEDGMENT_WORDS.has(word));
  return false;
}

// What the shared check refused, the personal checks' own detail aside: its fields, its span, or
// the first mention no grounding rule takes (a partial name is wholeNames' mark).
function sharedDetail(
  reason: string,
  candidate: ClaimCandidate,
  ontology: OntologyView,
  passage: MomentPassage,
  grounded: GroundingHook,
): DropDetail {
  if (reason === "bad_fields") return fieldsDetail(ontology.get(candidate.type), candidate.fields);
  if (reason === "bad_span") return { issue: "unlisted" };
  if (reason !== "ungrounded_mention") return {};
  const segment = segmentAt(passage.parsed, candidate.span);
  const text = passage.opened.item.text.toLowerCase();
  const entities = (ontology.get(candidate.type)?.fields ?? [])
    .filter((spec) => spec.kind === "entity")
    .map((spec) => [spec.name, candidate.fields[spec.name]] as const);
  for (const [field, value] of [["subject", candidate.subject] as const, ...entities]) {
    const mention = Mention.safeParse(value);
    if (!mention.success || mention.data.key.kind === "name") continue;
    const { kind, value: key } = mention.data.key;
    if (kind === "source_id" && key === "partial-name") return { field, issue: "partial_name" };
    if (
      kind === "address" ? !text.includes(key.toLowerCase()) : segment === undefined || !grounded(mention.data, segment)
    )
      return { field, issue: `mention_${kind}` };
  }
  return {};
}

// A log name of code's, or `other` should one ever not be snake case (the logger refuses the line).
const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const named = (name: string): string => (SNAKE.test(name) ? name : "other");

// The shape's counts. A type or a field the lane does not list is `other`.
function dropCounts(
  raw: ClaimCandidate,
  passage: MomentPassage,
  listed: boolean,
  detail: DropDetail,
): Record<string, number> {
  const known = (MOMENT_TYPES as readonly string[]).includes(raw.type);
  const { item } = passage.opened;
  const turns = item.turns?.filter((turn) => turn.from < passage.range.to && turn.to > passage.range.from).length ?? 0;
  const speaker =
    passage.speaker === null
      ? "none"
      : passage.speaker === OWNER_LABEL || passage.speaker === "agent"
        ? passage.speaker
        : "participant";
  return {
    [`type_${known ? raw.type : "other"}`]: 1,
    ...(detail.field === undefined ? {} : { [`field_${named(detail.field)}`]: 1 }),
    ...(detail.issue === undefined ? {} : { [`issue_${named(detail.issue)}`]: 1 }),
    turns,
    [`read_${item.read}`]: 1,
    [`speaker_${speaker}`]: 1,
    [`statement_${raw.statementKind}`]: 1,
    [`basis_${raw.basis}`]: 1,
    ...(listed ? {} : { unlisted: 1 }),
  };
}

// A request, a guess and a question to an agent build nothing, and no reversal, which could close a
// belief of the owner's.
const OWN_LINE_STATEMENTS: readonly string[] = ["stated_fact", "decision"];
// And the model's own words on it: its hedge is kept, so code never raises a third party's to the
// owner's word, and a subject that only resolves to the owner is not the speaker naming themselves.
const ownLineClaim = (raw: ClaimCandidate): boolean =>
  raw.basis === "explicit_self" &&
  raw.subject.key.kind === "source_id" &&
  raw.subject.key.value === `${SPEAKER}${OWNER_LABEL}`;

// The third party rule is the shared check's. Name mentions no one resolved are filed, a
// participant known by a name alone among them. The result is each moment's own, by its evidence
// id, and each moment's tally: one outcome a candidate, as the meeting lane counts, a candidate
// counted under the moment its span names (an unlisted span, under the first). A moment the owner
// released reads as narrowing none; the others were withheld before this. `outcomes`, when given,
// takes each candidate's outcome in order (kept, duplicate or its drop code), for the check's
// `--detail`. `drops`: each dropped candidate's shape, in order.
export async function checkMoments(
  output: InterpreterOutput,
  plan: MomentPlan,
  generation: number,
  outcomes?: string[],
  fingerprint?: FilingOptions["fingerprint"],
  repair?: boolean,
): Promise<{
  found: Map<string, Found & { mentions: FiledMention[] }>;
  tallies: Map<string, CaptureTally>;
  drops: MomentDrop[];
}> {
  const found = new Map<string, Found & { mentions: FiledMention[] }>();
  const tallies = new Map<string, CaptureTally>();
  const drops: MomentDrop[] = [];
  const own = plan.ownLines === true;
  const ontology = own ? OWN_LINES_VIEW : ontologyFor("moment", plan.prompt.version);
  const labels = new Set([OWNER_LABEL, ...[...plan.people.values()].map((one) => one.label)]);
  const grounded = momentGrounding(labels);
  const moments = momentsOf(plan);
  for (const id of moments.keys()) found.set(id, { claims: [], unmapped: [], unresolved: 0, mentions: [] });
  const seen = new Set<string>();
  for (const raw of strip(output.claims)) {
    const { passage, listed, candidate } = passageOf(raw, plan);
    const tally = tallies.get(passage.member.evidenceId) ?? {};
    tallies.set(passage.member.evidenceId, tally);
    const count = (code: string): void => void (tally[code] = (tally[code] ?? 0) + 1);
    count("candidates");
    const one = moments.get(passage.member.evidenceId);
    const into = found.get(passage.member.evidenceId);
    if (one === undefined || into === undefined) {
      outcomes?.push("none");
      continue;
    }
    // A short-term fact, and a project's state on anyone's word but the owner's own (nobody else's
    // line sets it, no card), are dropped before any check.
    const early = shortTermOf(raw, passageTime(passage))
      ? "short_term"
      : raw.type.startsWith("project.") && !(listed && passage.speaker === OWNER_LABEL && one.ownWord)
        ? "not_owners_word"
        : null;
    if (early !== null) {
      count(early);
      outcomes?.push(early);
      drops.push({ evidence: passage.member.evidenceId, code: early, counts: dropCounts(raw, passage, listed, {}) });
      continue;
    }
    one.asked.push(candidate);
    const narrowing = passage.member.override ? "none" : output.narrowing;
    const recorded = recordingAnswers(one.names.identity);
    const whole = wholeNames([candidate], passage.parsed);
    const details = new Map<string, DropDetail>();
    // The rule a source moment's key phrase needed, counted in moment_checked
    // and, when the candidate is dropped, in its moment_dropped line.
    let texting: TextingRule | "none" | undefined;
    const { found: result, unresolved } = await checkClaims(
      whole,
      // `document`: a passage has no author for the shared checker; the lane credits a claim itself.
      {
        parsed: passage.parsed,
        read: passage.read,
        narrowing,
        changeKind: "live",
        inputHash: plan.inputHash,
        document: true,
      },
      { generation, ontology, identity: recorded.identity, grounded },
      async () => {
        const who =
          listed && passage.speaker !== null && passage.speaker !== "agent"
            ? await one.identity.speakerWho(passage.speaker)
            : null;
        one.credits.set(candidate, momentCredit(passage, raw, who, one.ownWord, listed));
        return {
          parsed: passage.parsed,
          due: { ...passage.member },
          lane: "moment",
          passages: new Set([passage.chars]),
          promptVersion: own ? FACT_KIND_VERSIONS.moment : plan.prompt.version,
          repair: repair === true,
          capture: {
            ownerEntity: passage.opened.context.ownerEntity,
            kindOf: one.identity.kindOf,
            startedAt: passage.opened.capture.observedAt,
            captureKey: passage.opened.capture.key,
            ownerPresent: passage.opened.capture.facts.entity === "chat",
            ownerZone: passage.opened.context.ownerZone ?? null,
            ...(passage.opened.item.source === undefined
              ? {}
              : { texting: (rule: TextingRule | "none") => void (texting = rule) }),
            attribute: (claim) =>
              listed &&
              !(
                own &&
                (!ownLineClaim(raw) ||
                  claim.content.subject !== passage.opened.context.ownerEntity ||
                  !OWN_LINE_STATEMENTS.includes(claim.statementKind))
              )
                ? attributeMoment(passage, raw, claim, who, one.ownWord)
                : "bad_speaker",
          },
        };
      },
      details,
    );
    into.unresolved += unresolved;
    if (texting !== undefined) count(`texting_${texting}`);
    for (const rule of result.repairs ?? []) count(`repair_${rule}`);
    if (result.repairs !== undefined) into.repaired = (into.repaired ?? 0) + result.repairs.length;
    const [record] = result.claims;
    const [refused] = result.unmapped;
    if (record !== undefined) {
      if (seen.has(record.claim.id)) {
        count("duplicate");
        outcomes?.push("duplicate");
      } else {
        seen.add(record.claim.id);
        into.claims.push(citedAs(record, passage.stored));
        count("kept");
        outcomes?.push("kept");
      }
    } else {
      const code = heldCode(
        dropCode(refused, raw.type, whole[0]?.subject ?? raw.subject, recorded.answered),
        refused === undefined ? (whole[0]?.subject ?? raw.subject) : undefined,
        one.identity,
      );
      count(code);
      outcomes?.push(code);
      // The shape is a log line's: should reading it fail, the drop is logged without it, and the
      // check goes on.
      let counts: Record<string, number>;
      try {
        counts = {
          ...dropCounts(
            raw,
            passage,
            listed,
            refused === undefined
              ? {}
              : (details.get(refused.id) ??
                  sharedDetail(refused.reason, whole[0] ?? candidate, ontology, passage, grounded)),
          ),
          ...(texting === undefined ? {} : { [`texting_${texting}`]: 1 }),
        };
      } catch {
        counts = { shape_failed: 1 };
      }
      drops.push({ evidence: passage.member.evidenceId, code, counts });
    }
    for (const unmapped of result.unmapped)
      if (!into.unmapped.some((other) => other.id === unmapped.id))
        into.unmapped.push(
          unmapped.field === undefined && unmapped.issue === undefined
            ? {
                ...unmapped,
                ...refusalWords(sharedDetail(unmapped.reason, whole[0] ?? candidate, ontology, passage, grounded)),
              }
            : unmapped,
        );
  }
  for (const [id, one] of moments) {
    const into = found.get(id);
    if (into === undefined) continue;
    // Nobody is filed from an own line: the lane reads what the owner says of themselves alone.
    const filed = own
      ? []
      : [
          ...fileable(one.asked, one.passage.parsed, one.names.unresolved, {
            document: true,
            fingerprint,
            credit: (candidate) => one.credits.get(candidate) ?? null,
          }),
          ...(await speakerNames(one.asked, one.identity)),
        ];
    into.mentions = filed.slice(0, 200);
  }
  return { found, tallies, drops };
}

// What the check keeps of each moment of the plan, by its evidence id: its identity port, the
// candidates asked of it and whom each was credited to, its unresolved names, its first passage and
// whether its lines carry the owner's word.
type MomentChecking = {
  identity: ReturnType<typeof momentIdentity>;
  asked: ClaimCandidate[];
  credits: Map<ClaimCandidate, Credit | null>;
  names: ReturnType<typeof notingUnresolved>;
  passage: MomentPassage;
  ownWord: boolean;
};
function momentsOf(plan: MomentPlan): Map<string, MomentChecking> {
  const moments = new Map<string, MomentChecking>();
  for (const passage of plan.passages) {
    const id = passage.member.evidenceId as string;
    if (moments.has(id)) continue;
    const identity = momentIdentity(passage.opened, plan.people);
    moments.set(id, {
      identity,
      asked: [],
      credits: new Map(),
      names: notingUnresolved(identity.port),
      passage,
      ownWord: ownWordMoment(passage.opened),
    });
  }
  return moments;
}

export function sumTallies(tallies: ReadonlyMap<string, CaptureTally>, ids: readonly string[]): CaptureTally {
  const sum: CaptureTally = {};
  for (const id of ids) for (const [code, n] of Object.entries(tallies.get(id) ?? {})) sum[code] = (sum[code] ?? 0) + n;
  return sum;
}
