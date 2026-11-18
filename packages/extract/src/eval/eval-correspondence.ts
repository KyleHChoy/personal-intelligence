import { type InterpreterOutput, LocalEntityId, type Timestamp } from "@intelligence/contracts";
import {
  type EmailDueItem,
  EntityId,
  KEY_FIELDS,
  type LifeDomain,
  type OpenedItem,
  type OwnerSideKind,
  type PersonalUnmappedReason,
  SourceAccountId,
} from "@intelligence/contracts/personal";
import { KEY_V2_GENERATION, personalFactKey } from "@intelligence/personal-beliefs";
import { normalizeAddress } from "@intelligence/personal-core";
import { gmailItem } from "@intelligence/personal-core/items";
import type { ModelClient } from "@intelligence/personal-models";
import { ExtractFailure } from "../call-failure.ts";
import { EXTRACT_GENERATION } from "../config.ts";
import { interpret, passesThrough, readStored } from "../interpret.ts";
import { checkMessageClaims, messageCandidates, withheldBy } from "../lane-check.ts";
import { CORRESPONDENCE_V4_TYPES } from "../lane-versions.ts";
import { messageSlot } from "../message.ts";
import { PROMPT_VERSIONS } from "../message-prompts.ts";
import { promptFor } from "../prompts.ts";
import { callsInMemory } from "./eval-calls.ts";
import type { EvalTypeLine } from "./eval-documents.ts";
import { type MeetingDetail, shapeOf } from "./eval-facts.ts";
import { openedEval, ulidOf } from "./eval-open.ts";
import { countedLines, typeCounts } from "./eval-score.ts";
import { EVAL_OWNER } from "./eval-set.ts";

// The correspondence evaluation of the atomic version. Synthetic messages on reserved domains, each
// with the atomic facts it states, written by hand: a sentence that states two facts is two
// expected facts. A message goes through personal_correspondence version 4, its check and fact key
// version 2, read and written nowhere but the model's port, and is scored by code: a found fact
// matches an expected one when their type and fact key are equal. Nothing here is anyone's real
// data.

export type EvalAtomicFact = {
  type: OwnerSideKind;
  // An address: the owner's is EVAL_OWNER.
  subject: string;
  domain: LifeDomain;
  // The key phrase as the message writes it, a slice of `sentence`.
  phrase: string;
  sentence: string;
  polarity?: "prefers" | "avoids";
  momentary?: true;
  // The date a relative time word in the phrase needs, as a model must give it.
  until?: string;
};

export type EvalMessage = { id: string; from: string; to: string; paragraphs: string[]; expected: EvalAtomicFact[] };

// Every evaluation message was sent at this time.
export const EVAL_SENT = "2026-03-02T09:00:00.000Z";
const LENA = "lena.park@north.example";
const OMAR = "omar.reyes@field.example";

const fact = (
  type: OwnerSideKind,
  subject: string,
  domain: LifeDomain,
  sentence: string,
  phrase: string,
  extra: Partial<EvalAtomicFact> = {},
): EvalAtomicFact => ({ type, subject, domain, phrase, sentence, ...extra });

const RAISE = "We hope to raise a seed round by June and hire two engineers this summer.";
const DASHES = "Please, no em dashes in anything you send me.";
const PORTLAND = "I moved to Portland last month and I am training for a marathon.";
const DESIGNER = "I am looking for a designer for the launch.";
const MARCH = "I cannot travel before March 10.";
const DENTIST = "I am at the dentist today, so replies will be slow.";
const TERMS = "I can review term sheets for your fund.";

export const EVAL_CORRESPONDENCE: readonly EvalMessage[] = Object.freeze([
  {
    id: "corr-01",
    from: EVAL_OWNER,
    to: LENA,
    paragraphs: ["Hi Lena,", RAISE, "Sam"],
    expected: [
      fact("goal", EVAL_OWNER, "ventures", RAISE, "raise a seed round"),
      fact("goal", EVAL_OWNER, "ventures", RAISE, "hire two engineers"),
    ],
  },
  {
    id: "corr-02",
    from: EVAL_OWNER,
    to: OMAR,
    paragraphs: ["Omar,", DASHES, "Sam"],
    expected: [fact("preference", EVAL_OWNER, "career", DASHES, "em dashes", { polarity: "avoids" })],
  },
  {
    id: "corr-03",
    from: EVAL_OWNER,
    to: LENA,
    paragraphs: [PORTLAND],
    expected: [
      fact("situation", EVAL_OWNER, "home", PORTLAND, "moved to Portland"),
      fact("situation", EVAL_OWNER, "health", PORTLAND, "training for a marathon"),
    ],
  },
  {
    id: "corr-04",
    from: LENA,
    to: EVAL_OWNER,
    paragraphs: ["Hi Sam,", DESIGNER, "Lena"],
    expected: [fact("need", LENA, "ventures", DESIGNER, "a designer for the launch")],
  },
  {
    id: "corr-05",
    from: EVAL_OWNER,
    to: OMAR,
    paragraphs: [MARCH],
    expected: [fact("constraint", EVAL_OWNER, "travel", MARCH, "cannot travel before March 10")],
  },
  {
    id: "corr-06",
    from: EVAL_OWNER,
    to: LENA,
    paragraphs: [DENTIST],
    expected: [
      fact("situation", EVAL_OWNER, "health", DENTIST, "at the dentist today", {
        momentary: true,
        until: "2026-03-02",
      }),
    ],
  },
  {
    id: "corr-07",
    from: EVAL_OWNER,
    to: OMAR,
    paragraphs: [TERMS],
    expected: [fact("capability", EVAL_OWNER, "ventures", TERMS, "review term sheets")],
  },
  { id: "corr-08", from: OMAR, to: EVAL_OWNER, paragraphs: ["Thanks for the call, talk soon."], expected: [] },
]);

const EVAL_ACCOUNT = SourceAccountId.parse(`acc_${ulidOf("correspondence evaluation account")}`);
const entityOf = (address: string): LocalEntityId =>
  LocalEntityId.parse(EntityId.parse(`ent_${ulidOf(`correspondence evaluation person ${address}`)}`));
const PEOPLE = new Set([EVAL_OWNER, LENA, OMAR]);

// One evaluation message as the pipeline opens a stored one: built by core's builder, under
// `own`, with an identity port that answers for the set's people alone. Nothing is stored.
export function openEvalMessage(message: EvalMessage): OpenedItem {
  const raw = gmailItem(
    {
      id: `eval${message.id.replace("-", "")}`,
      threadId: `thread${message.id.replace("-", "")}`,
      internalDate: Date.parse(EVAL_SENT),
      labelIds: message.from === EVAL_OWNER ? ["SENT"] : ["INBOX"],
      headers: [
        { name: "From", value: message.from },
        { name: "To", value: message.to },
        { name: "Subject", value: "Catching up" },
        { name: "Date", value: new Date(EVAL_SENT).toUTCString() },
      ],
      text: message.paragraphs.join("\n\n"),
    },
    { sourceAccount: EVAL_ACCOUNT, changeKind: "backfill" },
  );
  return openedEval(raw, EVAL_ACCOUNT, { address: EVAL_OWNER, entity: entityOf(EVAL_OWNER) }, (mention) => {
    const address = mention.key.kind === "address" ? normalizeAddress(mention.key.value) : null;
    return address === null || !PEOPLE.has(address) ? null : { address, entity: entityOf(address) };
  });
}

const dueOf = (opened: OpenedItem, message: EvalMessage): EmailDueItem => ({
  source: "email",
  evidenceId: opened.context.evidenceId as EmailDueItem["evidenceId"],
  compartments: ["own"],
  sentAt: EVAL_SENT as Timestamp,
  attempts: 0,
  override: false,
  triage: {
    direction: message.from === EVAL_OWNER ? "outbound" : "inbound",
    bulk: false,
    category: "primary",
    unreadable: false,
    chars: message.paragraphs.join("\n\n").length,
  },
});

// The span of the message's plain text that holds a sentence.
export async function spanOf(message: EvalMessage, sentence: string): Promise<string> {
  const { parsed } = await readStored(openEvalMessage(message), ["own"]);
  const at = (parsed.texts[""] ?? "").indexOf(sentence);
  return `chars:${at}-${at + sentence.length}`;
}

// One message's output through the shared check, under version 4's types, and the personal
// check at the generation of fact key version 2: the atomic version's check. Version 3 checks at
// the run's current generation; version 6, the fact-kind version, checks as the run checks it.
export async function checkCorrespondence(
  message: EvalMessage,
  output: InterpreterOutput,
  version: string = PROMPT_VERSIONS.correspondence,
  generation?: number,
) {
  const opened = openEvalMessage(message);
  const { parsed, read } = await readStored(opened, ["own"]);
  const { found } = await checkMessageClaims(messageCandidates("correspondence", output.claims, parsed, opened), {
    parsed,
    read,
    opened,
    due: dueOf(opened, message),
    lane: "correspondence",
    promptVersion: version,
    narrowing: output.narrowing,
    inputHash: "eval",
    generation: generation ?? (version === "3" ? EXTRACT_GENERATION : KEY_V2_GENERATION),
  });
  return found;
}

// The fact key an expected fact has: version 2, under `own`.
function expectedKey(message: EvalMessage, expected: EvalAtomicFact): string {
  const fields = {
    [KEY_FIELDS[expected.type].phrase]: expected.phrase,
    domain: expected.domain,
    ...(expected.polarity === undefined ? {} : { polarity: expected.polarity }),
  };
  return personalFactKey(
    { type: expected.type, subject: entityOf(expected.subject), fields },
    openEvalMessage(message).raw.threadId ?? "",
    ["own"],
    undefined,
    2,
  );
}

type CorrespondenceEvalReport = {
  // The lane's types, in its order, each with no gate of its own: the set's gate is `passed`.
  types: TypeCounts[];
  messages: number;
  expected: number;
  found: number;
  extra: number;
  // Owner-side claims kept with no domain: none, when the check holds.
  missingDomain: number;
  unmapped: Partial<Record<PersonalUnmappedReason, number>>;
  failed: string[];
  // Messages the model withheld (quarantine, special_category): the lane would keep nothing of
  // them, but they are scored on their claims, as before. Shown, so a comparison sees it.
  withheld: string[];
  passed: boolean;
  // `--detail`'s per-message shapes, as the meeting evaluation gives them.
  detail: MeetingDetail[];
};

type TypeCounts = Omit<EvalTypeLine, "gated" | "passed">;

const shape = shapeOf(entityOf(EVAL_OWNER), new Set([LENA, OMAR].map(entityOf)));

// The set, each message asked under personal_correspondence version 4. A message the model
// answers in a way the lane refuses finds nothing; the model away, refused or over a budget ends
// the evaluation by its error. It passes when every expected fact is found, nothing else is, and
// every owner-side claim kept has a domain.
export async function evaluateCorrespondence(
  port: { model: ModelClient },
  set: readonly EvalMessage[] = EVAL_CORRESPONDENCE,
): Promise<CorrespondenceEvalReport> {
  const calls = callsInMemory();
  // A type off the lane's list gets a line of its own at the end, rather than ending a paid run.
  const { counts: types, line } = typeCounts(
    CORRESPONDENCE_V4_TYPES.map(({ id }) => id),
    true,
  );
  const report: CorrespondenceEvalReport = {
    types,
    messages: set.length,
    expected: 0,
    found: 0,
    extra: 0,
    missingDomain: 0,
    unmapped: {},
    failed: [],
    withheld: [],
    passed: false,
    detail: [],
  };
  for (const message of set) {
    const expected = message.expected.map((one) => ({
      type: one.type,
      key: expectedKey(message, one),
      shape: shape({ type: one.type, subject: entityOf(one.subject), counterparty: undefined }),
    }));
    report.expected += expected.length;
    for (const one of expected) line(one.type).expected += 1;
    const opened = openEvalMessage(message);
    let found: { type: string; key: string; subject: unknown; counterparty: unknown; due: unknown; when: unknown }[] =
      [];
    let answered = true;
    try {
      const { parsed, read } = await readStored(opened, ["own"]);
      const { output } = await interpret(
        promptFor("correspondence"),
        { message: JSON.stringify(messageSlot(parsed, EVAL_SENT as Timestamp)) },
        parsed,
        read,
        { model: port.model, calls },
      );
      if (withheldBy(output.narrowing) !== undefined) report.withheld.push(message.id);
      const checked = await checkCorrespondence(message, output);
      for (const one of checked.unmapped) report.unmapped[one.reason] = (report.unmapped[one.reason] ?? 0) + 1;
      report.missingDomain += checked.claims.filter(
        (record) =>
          Object.hasOwn(KEY_FIELDS, record.claim.content.type) && record.claim.content.fields.domain === undefined,
      ).length;
      found = checked.claims.map(({ claim: { content }, factKey }) => ({
        type: content.type,
        key: factKey,
        subject: content.subject,
        counterparty: content.fields.counterparty,
        due: content.fields.due,
        when: content.fields.when,
      }));
    } catch (error) {
      if (passesThrough(error) || !(error instanceof ExtractFailure)) throw error;
      answered = false;
    }
    const matched = expected.filter((one) => found.some((it) => it.type === one.type && it.key === one.key));
    const extras = found.filter((it) => !expected.some((one) => one.type === it.type && one.key === it.key));
    report.found += matched.length;
    report.extra += extras.length;
    for (const one of matched) line(one.type).found += 1;
    for (const one of extras) line(one.type).extra += 1;
    if (!answered || matched.length < expected.length || extras.length > 0) report.failed.push(message.id);
    report.detail.push({
      id: message.id,
      evidenceId: opened.context.evidenceId,
      answered,
      expected: expected.length,
      matched: matched.length,
      missed: expected.filter((one) => !matched.includes(one)).map((one) => one.shape),
      extra: extras.map(shape),
    });
  }
  report.passed = report.failed.length === 0 && report.missingDomain === 0;
  return report;
}

// What `pi extract check --world --lane correspondence` prints: counts and the set's own message
// ids, and no text. A type's line is printed when the set expects it or a fact of it was found.
export function correspondenceReportLines(report: CorrespondenceEvalReport): string[] {
  const unmapped = Object.entries(report.unmapped).map(([reason, count]) => `${reason} ${count}`);
  return [
    ...countedLines(report.types),
    `messages: ${report.messages} expected ${report.expected} found ${report.found} extra ${report.extra} missing_domain ${report.missingDomain}`,
    `unmapped: ${unmapped.length === 0 ? "none" : unmapped.join(", ")}`,
    `failed: ${report.failed.length === 0 ? "none" : report.failed.join(",")}`,
    `withheld: ${report.withheld.length === 0 ? "none" : report.withheld.join(",")}`,
    `result: ${report.passed ? "ok" : "failed"}`,
  ];
}
