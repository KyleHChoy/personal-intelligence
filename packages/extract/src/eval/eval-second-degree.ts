import { type InterpreterOutput, LocalEntityId, type Timestamp } from "@intelligence/contracts";
import {
  type ClaimRecord,
  type EmailDueItem,
  EntityId,
  type IntroOffer,
  type MomentItem,
  type MomentTurn,
  type OpenedItem,
  type OpenedMoment,
  type RelationshipRelation,
  SourceAccountId,
} from "@intelligence/contracts/personal";
import { BELIEF_RULES, KEY_V2_GENERATION } from "@intelligence/personal-beliefs";
import { normalizeAddress } from "@intelligence/personal-core";
import { gmailItem } from "@intelligence/personal-core/items";
import type { ModelClient } from "@intelligence/personal-models";
import { ExtractFailure } from "../call-failure.ts";
import { interpret, passesThrough, readStored } from "../interpret.ts";
import { checkMessageClaims, messageCandidates } from "../lane-check.ts";
import { SECOND_DEGREE_VERSIONS } from "../lane-versions.ts";
import { messageSlot } from "../message.ts";
import { checkMoments } from "../moments-check.ts";
import { planMoments } from "../moments-plan.ts";
import { momentPromptAt, promptAt } from "../prompts.ts";
import { callsInMemory } from "./eval-calls.ts";
import { askedByLane, evalMomentEntity, openEvalMoment } from "./eval-moments.ts";
import { openedEval, ulidOf } from "./eval-open.ts";
import { EVAL_RECALL, extrasAllowed } from "./eval-rule.ts";
import { EVAL_OWNER } from "./eval-set.ts";

// The second-degree evaluation. Synthetic mail and chats on reserved domains, each with the
// relationship and intro_offer claims it should give, written by hand: an "I know", a "you should
// meet", a "happy to introduce you", a third person's report, an offer to someone else in a group
// chat, a public figure named in passing, a quoted forward, a message the owner did not receive and
// an offer someone else made. Each item goes through its lane's second-degree version
// (correspondence 5, moment 10), its lane's checks and fact keys, read and written nowhere but the
// model's port. A person known by a name alone resolves as the binding step binds them (a name to
// one person), so a claim naming them is made. Nothing here is anyone's real data.
//
// Scored by code on the two kinds it adds: an `acquaintance` relationship and an intro_offer. A found
// claim matches an expected one when its type, subject, other person and relation or offer are equal.
// It passes when each kind's precision and recall are at least the moment lane's lines (EVAL_RECALL,
// and at most EVAL_EXTRAS_PER_ITEM extras per expected claim), no mail item has an extra (the
// correspondence lane's line: nothing found it does not expect), every other relationship the set
// expects is found, and no relationship a third person reported would build a belief.

type SecondDegreeFact =
  | { type: "relationship"; subject: string; counterparty: string; relation: RelationshipRelation }
  | { type: "intro_offer"; subject: string; person: string; offer: IntroOffer };

// One claim as a model answers it, by the people it names and the line it cites (the span is the
// segment's or the passage's that holds that line). `who` is an address, or a name known alone.
type RecordedClaim = { fact: SecondDegreeFact; line: string; statementKind?: "stated_fact" | "proposal" };

type Common = { id: string; expected: SecondDegreeFact[]; recorded: RecordedClaim[] };
export type SecondDegreeMail = Common & { kind: "mail"; from: string; to: string[]; text: string };
// A chat's lines, each by an address (a participant), the owner (EVAL_OWNER) or nobody known (null).
export type SecondDegreeChat = Common & { kind: "chat"; people: string[]; lines: [string | null, string][] };
export type SecondDegreeCase = SecondDegreeMail | SecondDegreeChat;

const SD_SENT = "2026-03-02T09:00:00.000Z";
const O = EVAL_OWNER;
const LENA = "lena.park@north.example";
const OMAR = "omar.reyes@field.example";
const NINA = "nina.cole@ridge.example";
const LIST = "team@north.example";
// People known by a name alone, and the one the binding step would bind each to.
const IRIS = "Iris Vane";
const DOV = "Dov Arden";
const MARA = "Mara Quint";
const THEO = "Theo Brand";
const ZOE = "Zoe Fenn";
const NAMED = [IRIS, DOV, MARA, THEO, ZOE];
const NAMES: Record<string, string> = {
  [O]: "Sam Harbor",
  [LENA]: "Lena Park",
  [OMAR]: "Omar Reyes",
  [NINA]: "Nina Cole",
};
const boundTo = (name: string): string => `${name.toLowerCase().replace(" ", ".")}@named.example`;

const knows = (
  subject: string,
  counterparty: string,
  relation: RelationshipRelation = "acquaintance",
): SecondDegreeFact => ({ type: "relationship", subject, counterparty, relation });
const offers = (subject: string, person: string, offer: IntroOffer): SecondDegreeFact => ({
  type: "intro_offer",
  subject,
  person,
  offer,
});
const said = (fact: SecondDegreeFact, line: string): RecordedClaim => ({
  fact,
  line,
  ...(fact.type === "intro_offer" ? { statementKind: "proposal" as const } : {}),
});
const mail = (
  id: string,
  from: string,
  to: string[],
  lines: string[],
  expected: SecondDegreeFact[],
  recorded: RecordedClaim[] = expected.map((fact, n) => said(fact, lines[n + 1] ?? "")),
): SecondDegreeMail => ({
  id,
  kind: "mail",
  from,
  to,
  text: lines.join("\n\n"),
  expected,
  recorded,
});
// Lines of no fact, so a chat is long enough for the lane to ask it (MOMENT_MIN_CHARS).
const FILLER =
  "anyway the rest of the week looks busy but manageable and the weather is meant to stay dry until sunday";
const FILLER_TOO = "same here, the trains were a mess this morning but it all worked out in the end";

const KNOW_IRIS = "I know Iris Vane from the climate fund.";
const MEET_DOV = "You should meet Dov Arden.";
const INTRO_MARA = "Happy to introduce you to Mara Quint.";
const COLLEAGUE = "My colleague Theo Brand works with Zoe Fenn.";
const LIST_OFFER = "Happy to introduce you to Iris Vane.";
const FIGURE = "I watched Senator Hale Orrin's speech on the harbour plan last night.";
const QUOTED_OFFER = "Happy to introduce you to Dov Arden.";
const LENA_SAID = "Lena Park said she would be happy to introduce you to Mara Quint.";

export const SECOND_DEGREE_SET: readonly SecondDegreeCase[] = Object.freeze([
  // "I know": an acquaintance, the speaker its subject.
  mail("sd-01", LENA, [O], ["Hi Sam,", KNOW_IRIS, "Lena"], [knows(LENA, IRIS)]),
  // "you should meet": a suggestion to the owner.
  mail("sd-02", OMAR, [O], ["Sam,", MEET_DOV, "Omar"], [offers(OMAR, DOV, "suggested")]),
  // "happy to introduce you": an offer to the owner, who is in Cc.
  mail("sd-03", NINA, [LENA, O], ["Hi both,", INTRO_MARA, "Nina"], [offers(NINA, MARA, "offered")]),
  // A third person's report: Lena's own colleague is Lena's, first-hand; Theo's tie to Zoe is Lena's
  // report of two others, a relationship claim that builds no belief.
  mail(
    "sd-04",
    LENA,
    [O],
    ["Sam,", COLLEAGUE, "Lena"],
    [knows(LENA, THEO, "colleague"), knows(THEO, ZOE, "colleague")],
    [said(knows(LENA, THEO, "colleague"), COLLEAGUE), said(knows(THEO, ZOE, "colleague"), COLLEAGUE)],
  ),
  // A message the owner did not receive (a list's): a model that takes the offer is refused by code.
  mail("sd-05", LENA, [LIST], ["Hi team,", LIST_OFFER, "Lena"], [], [said(offers(LENA, IRIS, "offered"), LIST_OFFER)]),
  // A public figure named in passing: nothing.
  mail("sd-06", OMAR, [O], ["Sam,", FIGURE, "Omar"], []),
  // A quoted forward: the offer is in an earlier message, not this author's words; refused by code.
  mail(
    "sd-07",
    NINA,
    [O],
    ["Passing this along.", `On Mon, Mar 2, 2026 at 8:00 AM Lena Park <${LENA}> wrote:\n> ${QUOTED_OFFER}`],
    [],
    [said(offers(LENA, DOV, "offered"), QUOTED_OFFER)],
  ),
  // Someone else's offer reported: its speaker is not its subject; refused by code.
  mail("sd-08", OMAR, [O], ["Sam,", LENA_SAID, "Omar"], [], [said(offers(LENA, MARA, "offered"), LENA_SAID)]),
  // A chat: "we've met".
  {
    id: "sd-09",
    kind: "chat",
    people: [LENA],
    lines: [
      [LENA, "we've met, Mara Quint and I were on the same residency"],
      [O, FILLER],
      [LENA, FILLER_TOO],
    ],
    expected: [knows(LENA, MARA)],
    recorded: [said(knows(LENA, MARA), "we've met, Mara Quint and I were on the same residency")],
  },
  // A group chat: an offer made to someone else. Nothing.
  {
    id: "sd-10",
    kind: "chat",
    people: [LENA, OMAR],
    lines: [
      [LENA, "Omar, happy to introduce you to Dov Arden for the robotics thing"],
      [OMAR, "oh amazing, thank you"],
      [O, FILLER],
      [OMAR, FILLER_TOO],
    ],
    expected: [],
    recorded: [],
  },
  // A chat: "you should meet", then "happy to introduce you".
  {
    id: "sd-11",
    kind: "chat",
    people: [OMAR],
    lines: [
      [OMAR, "you should meet Zoe Fenn, she is building the same thing"],
      [O, "oh interesting"],
      [OMAR, "happy to introduce you to Theo Brand too"],
      [O, FILLER],
    ],
    expected: [offers(OMAR, ZOE, "suggested"), offers(OMAR, THEO, "offered")],
    recorded: [
      said(offers(OMAR, ZOE, "suggested"), "you should meet Zoe Fenn, she is building the same thing"),
      said(offers(OMAR, THEO, "offered"), "happy to introduce you to Theo Brand too"),
    ],
  },
]);

const ACCOUNT = SourceAccountId.parse(`acc_${ulidOf("second degree evaluation account")}`);
const mailEntity = (address: string): LocalEntityId =>
  LocalEntityId.parse(EntityId.parse(`ent_${ulidOf(`second degree evaluation person ${address}`)}`));
const ADDRESSED = new Set([O, LENA, OMAR, NINA]);

// A person's address, or a name known alone as the address its binding stands for.
const addressOf = (who: string): string => (NAMED.includes(who) ? boundTo(who) : who);
// The person the binding step binds a name to: one known alone, or an addressed person by name.
const nameTo = (name: string): string | null =>
  NAMED.includes(name) ? boundTo(name) : (Object.entries(NAMES).find(([, full]) => full === name)?.[0] ?? null);

// One evaluation message as the pipeline opens a stored one, under `own`, with an identity port
// that answers the set's addressed people and binds each name known alone to one person.
export function openSecondDegreeMail(message: SecondDegreeMail): OpenedItem {
  const raw = gmailItem(
    {
      id: `sdeval${message.id.replace("-", "")}`,
      threadId: `sdthread${message.id.replace("-", "")}`,
      internalDate: Date.parse(SD_SENT),
      labelIds: ["INBOX"],
      headers: [
        { name: "From", value: message.from },
        { name: "To", value: message.to.join(", ") },
        { name: "Subject", value: "Catching up" },
        { name: "Date", value: new Date(SD_SENT).toUTCString() },
      ],
      text: message.text,
    },
    { sourceAccount: ACCOUNT, changeKind: "backfill" },
  );
  return openedEval(raw, ACCOUNT, { address: O, entity: mailEntity(O) }, (mention) => {
    const address =
      mention.key.kind === "address"
        ? normalizeAddress(mention.key.value)
        : mention.key.kind === "name"
          ? nameTo(mention.key.value)
          : null;
    if (address === null || (mention.key.kind === "address" && !ADDRESSED.has(address))) return null;
    return { address, entity: mailEntity(address) };
  });
}

// One evaluation chat as Lens sends it: a chat read ax with a turn for each line.
function secondDegreeMoment(chat: SecondDegreeChat): MomentItem {
  let at = 0;
  const turns = chat.lines.flatMap(([by, text]): MomentTurn[] => {
    const from = at;
    at += text.length + 1;
    if (by === null) return [];
    if (by === O) return [{ from, to: from + text.length, speaker: "owner" as const }];
    return [{ from, to: from + text.length, speaker: "participant" as const, participant: chat.people.indexOf(by) }];
  });
  const seen = "2026-03-02T10:00:00-05:00";
  return {
    kind: "moment",
    key: `moment:${ulidOf(`second degree evaluation chat ${chat.id}`)}`,
    revision: 0,
    observedAt: seen,
    endedAt: seen,
    app: { bundle: "test.example.chat", name: "Chat" },
    entity: "chat",
    thread: `sd thread ${chat.id}`,
    participants: chat.people.map((address) => ({ name: NAMES[address] ?? "Guest", address })),
    text: chat.lines.map(([, text]) => text).join("\n"),
    read: "ax",
    turns,
  } as MomentItem;
}
const BOUND: Readonly<Record<string, string>> = Object.fromEntries(NAMED.map((name) => [name, boundTo(name)]));
export const openSecondDegreeChat = (chat: SecondDegreeChat): OpenedMoment =>
  openEvalMoment(secondDegreeMoment(chat), false, BOUND);
const asEvalGroup = (chat: SecondDegreeChat) => ({ id: chat.id, moments: [secondDegreeMoment(chat)], expected: [] });

// The recorded claims of one case as the model's answer: each claim in the lane's own mentions and
// spans. A mail claim cites the segment holding its line; a chat claim the passage that does.
const mention = (key: { kind: string; value: string }, at: string) => ({ key, observedAt: at });
export async function recordedOutput(one: SecondDegreeCase): Promise<InterpreterOutput> {
  if (one.kind === "mail") {
    const { parsed } = await readStored(openSecondDegreeMail(one), ["own"]);
    // A person on the message's headers by address; anyone else by the name the text writes.
    const headed = new Set([one.from, ...one.to]);
    const person = (who: string) =>
      mention(headed.has(who) ? { kind: "address", value: who } : { kind: "name", value: NAMES[who] ?? who }, SD_SENT);
    const spanOf = (line: string): string =>
      parsed.segments.find((segment) => segment.text.includes(line))?.span ?? "chars:0-0";
    return {
      claims: one.recorded.map((claim) => claimOf(claim, person, spanOf(claim.line))),
      narrowing: "none",
    } as InterpreterOutput;
  }
  const plan = planMoments(
    [{ opened: openSecondDegreeChat(one), member: memberOf(openSecondDegreeChat(one)) }],
    true,
    momentPromptAt(SECOND_DEGREE_VERSIONS.moment),
  );
  const seen = new Date(Date.parse(secondDegreeMoment(one).observedAt)).toISOString();
  const person = (who: string) => {
    const index = one.people.indexOf(who);
    return mention(
      who === O
        ? { kind: "source_id", value: "speaker:owner" }
        : index >= 0
          ? { kind: "source_id", value: `speaker:P${index + 1}` }
          : { kind: "name", value: who },
      seen,
    );
  };
  const spanOf = (line: string): string =>
    plan?.passages.find((passage) =>
      passage.opened.item.text.slice(passage.range.from, passage.range.to).includes(line),
    )?.span ?? "mom:0:0-0";
  return {
    claims: one.recorded.map((claim) => claimOf(claim, person, spanOf(claim.line))),
    narrowing: "none",
  } as InterpreterOutput;
}
const claimOf = (claim: RecordedClaim, person: (who: string) => unknown, span: string) => {
  const { fact } = claim;
  const fields =
    fact.type === "relationship"
      ? { counterparty: person(fact.counterparty), relation: fact.relation }
      : { person: person(fact.person), offer: fact.offer };
  return {
    type: fact.type,
    subject: person(fact.subject),
    fields,
    statementKind: claim.statementKind ?? "stated_fact",
    basis: "explicit_self",
    span,
  };
};
const memberOf = (opened: OpenedMoment) => ({
  evidenceId: opened.context.evidenceId as never,
  compartments: ["own"],
  observedAt: opened.capture.observedAt,
  attempts: 0,
  override: false,
});

const dueOf = (opened: OpenedItem, message: SecondDegreeMail): EmailDueItem => ({
  source: "email",
  evidenceId: opened.context.evidenceId as EmailDueItem["evidenceId"],
  compartments: ["own"],
  sentAt: SD_SENT as Timestamp,
  attempts: 0,
  override: false,
  triage: { direction: "inbound", bulk: false, category: "primary", unreadable: false, chars: message.text.length },
});

// One message's answer through the shared check under the second-degree version's types and the
// personal check, at the generation of fact key version 2: what a run makes of it.
export async function checkSecondDegreeMail(message: SecondDegreeMail, output: InterpreterOutput) {
  const opened = openSecondDegreeMail(message);
  const { parsed, read } = await readStored(opened, ["own"]);
  const { found } = await checkMessageClaims(messageCandidates("correspondence", output.claims, parsed, opened), {
    parsed,
    read,
    opened,
    due: dueOf(opened, message),
    lane: "correspondence",
    promptVersion: SECOND_DEGREE_VERSIONS.correspondence,
    narrowing: output.narrowing,
    inputHash: "eval",
    generation: KEY_V2_GENERATION,
  });
  return found;
}

// One kind's counts over the set: `found` the claims of the kind code kept, `matched` those the set
// expects; precision is matched over found (1 when none was found), recall matched over expected.
type SecondDegreeKindLine = {
  kind: "acquaintance" | "intro_offer";
  expected: number;
  found: number;
  matched: number;
  precision: number;
  recall: number;
  passed: boolean;
};
type SecondDegreeReport = {
  cases: number;
  kinds: SecondDegreeKindLine[];
  // Every other relationship the set expects (the third person's report and its first-hand half).
  relationships: { expected: number; found: number };
  // Relationship claims a third person reported that a belief would count: none, when it holds.
  reportedCounted: number;
  // Extra claims of the two kinds in mail, which the correspondence lane allows none of.
  mailExtras: number;
  // Each refusal by its code: the check's unmapped reason, or the moment lane's drop code.
  unmapped: Record<string, number>;
  failed: string[];
  passed: boolean;
};

type Found = { fact: SecondDegreeFact; record: ClaimRecord };

const kindOf = (fact: SecondDegreeFact): "acquaintance" | "intro_offer" | "relationship" =>
  fact.type === "intro_offer" ? "intro_offer" : fact.relation === "acquaintance" ? "acquaintance" : "relationship";
const sameFact = (a: SecondDegreeFact, b: SecondDegreeFact): boolean => JSON.stringify(a) === JSON.stringify(b);

// Each kept claim of the two types, read back to the people it names.
function readBack(records: readonly ClaimRecord[], whoOf: (entity: unknown) => string | undefined): Found[] {
  return records.flatMap((record): Found[] => {
    const { type, subject, fields } = record.claim.content;
    const who = whoOf(subject);
    if (type === "relationship") {
      const other = whoOf(fields.counterparty);
      return who === undefined || other === undefined
        ? []
        : [
            {
              fact: { type, subject: who, counterparty: other, relation: fields.relation as RelationshipRelation },
              record,
            },
          ];
    }
    if (type === "intro_offer") {
      const other = whoOf(fields.person);
      return who === undefined || other === undefined
        ? []
        : [{ fact: { type, subject: who, person: other, offer: fields.offer as IntroOffer }, record }];
    }
    return [];
  });
}

const PEOPLE_REFS = [O, LENA, OMAR, NINA, ...NAMED];
const mailWho = new Map(PEOPLE_REFS.map((ref) => [mailEntity(addressOf(ref)) as string, ref]));
const chatWho = new Map(PEOPLE_REFS.map((ref) => [evalMomentEntity(addressOf(ref)) as string, ref]));

// The set, each case asked under its lane's second-degree version through `port`; a case the model
// answers in a way the lane refuses finds nothing, and the model away, refused or over a budget ends
// the evaluation by its error.
export async function evaluateSecondDegree(
  port: { model: ModelClient },
  set: readonly SecondDegreeCase[] = SECOND_DEGREE_SET,
): Promise<SecondDegreeReport> {
  const calls = callsInMemory();
  const counts = {
    acquaintance: { expected: 0, found: 0, matched: 0 },
    intro_offer: { expected: 0, found: 0, matched: 0 },
  };
  const relationships = { expected: 0, found: 0 };
  const report: SecondDegreeReport = {
    cases: set.length,
    kinds: [],
    relationships,
    reportedCounted: 0,
    mailExtras: 0,
    unmapped: {},
    failed: [],
    passed: false,
  };
  for (const one of set) {
    let records: ClaimRecord[] = [];
    let whoOf: (entity: unknown) => string | undefined = () => undefined;
    try {
      if (one.kind === "mail") {
        const { parsed, read } = await readStored(openSecondDegreeMail(one), ["own"]);
        const { output } = await interpret(
          promptAt("correspondence", SECOND_DEGREE_VERSIONS.correspondence),
          { message: JSON.stringify(messageSlot(parsed, SD_SENT as Timestamp)) },
          parsed,
          read,
          { model: port.model, calls },
        );
        const result = await checkSecondDegreeMail(one, output);
        for (const refused of result.unmapped)
          report.unmapped[refused.reason] = (report.unmapped[refused.reason] ?? 0) + 1;
        records = result.claims;
        whoOf = (entity) => mailWho.get(String(entity));
      } else {
        const opened = openSecondDegreeChat(one);
        if (!askedByLane(asEvalGroup(one))) throw new ExtractFailure("no_text");
        const plan = planMoments(
          [{ opened, member: memberOf(opened) }],
          true,
          momentPromptAt(SECOND_DEGREE_VERSIONS.moment),
        );
        const first = plan?.passages[0];
        if (plan === null || first === undefined) throw new ExtractFailure("no_text");
        const { output } = await interpret(plan.prompt, plan.data, first.parsed, first.read, {
          model: port.model,
          calls,
        });
        const outcomes: string[] = [];
        const checked = await checkMoments(output, plan, KEY_V2_GENERATION, outcomes);
        for (const outcome of outcomes)
          if (outcome !== "kept" && outcome !== "none" && outcome !== "duplicate")
            report.unmapped[outcome] = (report.unmapped[outcome] ?? 0) + 1;
        records = [...checked.found.values()].flatMap((each) => each.claims);
        whoOf = (entity) => chatWho.get(String(entity));
      }
    } catch (error) {
      if (passesThrough(error) || !(error instanceof ExtractFailure)) throw error;
      report.failed.push(one.id);
      records = [];
    }
    const found = readBack(records, whoOf);
    const used = new Set<number>();
    let missed = 0;
    for (const fact of one.expected) {
      const kind = kindOf(fact);
      const at = found.findIndex((each, n) => !used.has(n) && sameFact(each.fact, fact));
      if (kind === "relationship") relationships.expected += 1;
      else counts[kind].expected += 1;
      if (at < 0) {
        missed += 1;
        continue;
      }
      used.add(at);
      if (kind === "relationship") relationships.found += 1;
      else counts[kind].matched += 1;
    }
    let extras = 0;
    for (const [n, each] of found.entries()) {
      const kind = kindOf(each.fact);
      if (kind !== "relationship") counts[kind].found += 1;
      if (!used.has(n) && kind !== "relationship") extras += 1;
      const reported =
        each.fact.type === "relationship" &&
        each.record.claim.assertedBy !== each.record.claim.content.subject &&
        each.record.claim.assertedBy !== each.record.claim.content.fields.counterparty;
      const rule = BELIEF_RULES.relationship;
      if (
        reported &&
        rule?.counts({ claim: each.record.claim, origin: "source", subjectKind: each.record.subjectKind })
      )
        report.reportedCounted += 1;
    }
    if (one.kind === "mail") report.mailExtras += extras;
    if ((missed > 0 || extras > 0) && !report.failed.includes(one.id)) report.failed.push(one.id);
  }
  report.kinds = (["acquaintance", "intro_offer"] as const).map((kind) => {
    const { expected, found, matched } = counts[kind];
    const precision = found === 0 ? 1 : matched / found;
    const recall = expected === 0 ? 1 : matched / expected;
    // The moment lane's lines: recall of at least EVAL_RECALL, and extras at most
    // EVAL_EXTRAS_PER_ITEM of what is expected.
    const passed = recall >= EVAL_RECALL && found - matched <= extrasAllowed(expected);
    return { kind, expected, found, matched, precision, recall, passed };
  });
  report.passed =
    report.kinds.every((line) => line.passed) &&
    report.mailExtras === 0 &&
    relationships.found === relationships.expected &&
    report.reportedCounted === 0;
  return report;
}

// What `pi extract check --world --lane second-degree` prints: counts and the set's own ids, no text.
export function secondDegreeReportLines(report: SecondDegreeReport): string[] {
  const unmapped = Object.entries(report.unmapped).map(([reason, count]) => `${reason} ${count}`);
  const ratio = (value: number): string => value.toFixed(2);
  return [
    ...report.kinds.map(
      (line) =>
        `${line.kind}: expected ${line.expected} found ${line.found} matched ${line.matched} precision ${ratio(line.precision)} recall ${ratio(line.recall)} ${line.passed ? "ok" : "failed"}`,
    ),
    `relationships: expected ${report.relationships.expected} found ${report.relationships.found} reported_counted ${report.reportedCounted}`,
    `cases: ${report.cases} mail_extras ${report.mailExtras}`,
    `unmapped: ${unmapped.length === 0 ? "none" : unmapped.join(", ")}`,
    `failed: ${report.failed.length === 0 ? "none" : report.failed.join(",")}`,
    `result: ${report.passed ? "ok" : "failed"}`,
  ];
}
