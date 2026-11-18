import { type InterpreterOutput, LocalEntityId, type Timestamp } from "@intelligence/contracts";
import {
  type EmailDueItem,
  EntityId,
  type LifeDomain,
  type OpenedItem,
  type PersonalUnmappedReason,
  SourceAccountId,
} from "@intelligence/contracts/personal";
import type { Parsed, ReadItem } from "@intelligence/personal-core";
import { normalizeAddress } from "@intelligence/personal-core";
import { gmailItem, messageCategory, personalBulk } from "@intelligence/personal-core/items";
import type { ModelClient } from "@intelligence/personal-models";
import { ExtractFailure } from "../call-failure.ts";
import { EXTRACT_GENERATION } from "../config.ts";
import { interpret, passesThrough, readStored } from "../interpret.ts";
import { checkMessageClaims, messageCandidates, withheldBy } from "../lane-check.ts";
import { TRANSACTION_TYPES_V2 } from "../lane-versions.ts";
import { messageSlot } from "../message.ts";
import { PROMPT_VERSIONS } from "../message-prompts.ts";
import { promptAt } from "../prompts.ts";
import { routedDue, triage } from "../triage.ts";
import { callsInMemory } from "./eval-calls.ts";
import type { MeetingDetail, MeetingFactShape } from "./eval-facts.ts";
import { openedEval, ulidOf } from "./eval-open.ts";
import { countedLines, typeCounts } from "./eval-score.ts";
import { EVAL_OWNER } from "./eval-set.ts";

// The transaction lane's evaluation, `pi extract check --world --lane transaction`.
// Synthetic mail a program sent the owner, on reserved domains, each with the facts it states,
// written by hand: two status notices of a passport application, a license office's notice with an
// appointment, a shipping notice, a plain receipt that must give the receipt alone, and marketing
// that must give nothing. Each goes through triage (it must land in the transaction lane),
// personal_transaction version 2, the lane's owner subject and its check, read and written nowhere
// but the model's port, and is scored by code. Nothing here is anyone's real data.

// What one expected fact is: a situation by its life domain (any of `domains`) and the words its
// state must hold, whatever else it says; a plan by its date; a receipt by its amount and currency.
export type EvalNoticeFact =
  | { type: "situation"; domains: readonly LifeDomain[]; words: readonly string[] }
  | { type: "plan"; when: string }
  | { type: "transaction.receipt"; amount: number; currency: string };

export type EvalNotice = {
  id: string;
  from: string;
  subject: string;
  sentAt: string;
  labels: readonly string[];
  paragraphs: readonly string[];
  expected: readonly EvalNoticeFact[];
};

const UPDATES = ["INBOX", "CATEGORY_UPDATES"] as const;

export const EVAL_NOTICES: readonly EvalNotice[] = Object.freeze([
  // (a) A passport application in process: a travel situation about the owner.
  {
    id: "tx-01",
    from: "DoNotReply@passports.example",
    subject: "Passport Application Status",
    sentAt: "2026-10-11T14:00:00.000Z",
    labels: UPDATES,
    paragraphs: [
      "Dear Applicant,",
      "Your passport application is In Process.",
      "Please do not reply to this message. This mailbox is not monitored.",
    ],
    expected: [{ type: "situation", domains: ["travel"], words: ["passport", "process"] }],
  },
  // (b) The same office's later notice: its supporting documents mailed back.
  {
    id: "tx-02",
    from: "DoNotReply@passports.example",
    subject: "Passport Application Status",
    sentAt: "2026-10-18T14:00:00.000Z",
    labels: UPDATES,
    paragraphs: [
      "Dear Applicant,",
      "Your supporting documents were mailed back to you.",
      "Please do not reply to this message. This mailbox is not monitored.",
    ],
    expected: [{ type: "situation", domains: ["travel", "admin"], words: ["documents", "mailed"] }],
  },
  // (c) A license office: a renewal approved, and an appointment on a stated date.
  {
    id: "tx-03",
    from: "no-reply@motor-vehicles.example",
    subject: "Driver license renewal",
    sentAt: "2026-10-14T16:30:00.000Z",
    labels: UPDATES,
    paragraphs: [
      "Your driver license renewal has been approved.",
      "Your vision test appointment is scheduled for November 4, 2026 at the Elm Street office.",
      "Bring this notice with you.",
    ],
    expected: [
      { type: "situation", domains: ["admin", "travel"], words: ["license", "renewal", "approved"] },
      { type: "plan", when: "2026-11-04" },
    ],
  },
  // (d) A shipping notice with no amount: a situation, and no receipt.
  {
    id: "tx-04",
    from: "shipment-tracking@parcels.example",
    subject: "Your package has shipped",
    sentAt: "2026-10-20T08:15:00.000Z",
    labels: UPDATES,
    paragraphs: ["Good news!", "Your package has shipped.", "Track it any time with tracking number PX0042117."],
    expected: [{ type: "situation", domains: ["admin", "money", "home"], words: ["package", "shipped"] }],
  },
  // (e) A plain receipt, which says its order shipped too: the receipt and nothing else.
  {
    id: "tx-05",
    from: "receipts@alder-books.example",
    subject: "Your receipt from Alder Books",
    sentAt: "2026-10-20T19:05:00.000Z",
    labels: UPDATES,
    paragraphs: [
      "Thank you for your order from Alder Books.",
      "Order AB-2291. Total paid: 38.40 USD.",
      "Your order has shipped.",
    ],
    expected: [{ type: "transaction.receipt", amount: 38.4, currency: "USD" }],
  },
  // (f) Marketing: nothing.
  {
    id: "tx-06",
    from: "deals@cedar-outfitters.example",
    subject: "48 hours only: 30% off",
    sentAt: "2026-10-19T12:00:00.000Z",
    labels: ["INBOX", "CATEGORY_UPDATES"],
    paragraphs: [
      "Our fall sale ends Sunday.",
      "Take 30% off jackets and boots with code FALL30.",
      "Shop now. Unsubscribe at any time.",
    ],
    expected: [],
  },
] as const);

const EVAL_ACCOUNT = SourceAccountId.parse(`acc_${ulidOf("transaction evaluation account")}`);
export const EVAL_NOTICE_OWNER = LocalEntityId.parse(EntityId.parse(`ent_${ulidOf("transaction evaluation owner")}`));
const textOf = (notice: EvalNotice): string => notice.paragraphs.join("\n\n");

// One evaluation notice as the pipeline opens a stored one: built by core's builder, under `own`,
// with an identity port that answers for the owner alone: a program's address is no person.
export function openEvalNotice(notice: EvalNotice): OpenedItem {
  const raw = gmailItem(
    {
      id: `eval${notice.id.replace("-", "")}`,
      threadId: `thread${notice.id.replace("-", "")}`,
      internalDate: Date.parse(notice.sentAt),
      labelIds: [...notice.labels],
      headers: [
        { name: "From", value: notice.from },
        { name: "To", value: EVAL_OWNER },
        { name: "Subject", value: notice.subject },
        { name: "Date", value: new Date(notice.sentAt).toUTCString() },
      ],
      text: textOf(notice),
    },
    { sourceAccount: EVAL_ACCOUNT, changeKind: "backfill" },
  );
  const owner = { address: EVAL_OWNER, entity: EVAL_NOTICE_OWNER };
  return openedEval(raw, EVAL_ACCOUNT, owner, (mention) =>
    mention.key.kind === "address" && normalizeAddress(mention.key.value) === EVAL_OWNER ? owner : null,
  );
}

// The notice's due item, its triage row as the store derives it: bulk by core's rule, filed by its
// labels' category.
function dueOfNotice(opened: OpenedItem, notice: EvalNotice): EmailDueItem {
  return {
    source: "email",
    evidenceId: opened.context.evidenceId as EmailDueItem["evidenceId"],
    compartments: ["own"],
    sentAt: notice.sentAt as Timestamp,
    attempts: 0,
    override: false,
    triage: {
      direction: "inbound",
      bulk: personalBulk(opened.raw),
      category: messageCategory(opened.raw.markers),
      unreadable: false,
      chars: textOf(notice).length,
    },
  };
}

// One notice's output through the lane's owner subject, the shared check under version 2's types
// at the run's generation, and the personal check: what a run commits of it. `stored` is the notice
// already opened and read, so the evaluation opens and parses each notice once. `dueOf` (tests
// only) changes the due item, as an owner's lane would, and `humanWritten` (tests only) is the decide model's
// answer; the due item carries triage's decision as a run's does (routedDue).
export async function checkNotice(
  notice: EvalNotice,
  output: InterpreterOutput,
  stored?: { opened: OpenedItem; parsed: Parsed; read: ReadItem },
  dueOf: (due: EmailDueItem) => EmailDueItem = (due) => due,
  humanWritten?: number,
  version: string = PROMPT_VERSIONS.transaction,
) {
  const opened = stored?.opened ?? openEvalNotice(notice);
  const { parsed, read } = stored ?? (await readStored(opened, ["own"]));
  const due = dueOf(dueOfNotice(opened, notice));
  const { found } = await checkMessageClaims(messageCandidates("transaction", output.claims, parsed, opened), {
    parsed,
    read,
    opened,
    due: routedDue(due, triage(due.triage, due.lane, humanWritten).lane),
    lane: "transaction",
    promptVersion: version,
    narrowing: output.narrowing,
    inputHash: "eval",
    generation: EXTRACT_GENERATION,
  });
  return found;
}

type Found = { type: string; subject: unknown; basis: string; fields: Readonly<Record<string, unknown>> };

// Whether a found claim is the expected fact: about the owner, as a third party's, and as below.
function matches(expected: EvalNoticeFact, found: Found): boolean {
  if (found.type !== expected.type || found.subject !== EVAL_NOTICE_OWNER || found.basis !== "third_party")
    return false;
  if (expected.type === "situation") {
    const state = typeof found.fields.state === "string" ? found.fields.state.toLowerCase() : "";
    return (
      expected.domains.includes(found.fields.domain as LifeDomain) &&
      expected.words.every((word) => state.includes(word))
    );
  }
  if (expected.type === "plan") return found.fields.when === expected.when;
  return found.fields.amount === expected.amount && found.fields.currency === expected.currency;
}

type TypeCounts = { type: string; expected: number; found: number; extra: number };

type TransactionEvalReport = {
  types: TypeCounts[];
  notices: number;
  expected: number;
  found: number;
  extra: number;
  // Notices triage did not send to the transaction lane: none, when the set is right.
  misrouted: string[];
  unmapped: Partial<Record<PersonalUnmappedReason, number>>;
  failed: string[];
  withheld: string[];
  passed: boolean;
  detail: MeetingDetail[];
};

const shapeOf = (fact: { type: string; subject: unknown; when?: unknown }): MeetingFactShape => ({
  type: fact.type,
  subject: fact.subject === EVAL_NOTICE_OWNER ? "owner" : fact.subject === undefined ? "none" : "unknown",
  counterparty: "none",
  due: null,
  when: typeof fact.when === "string" ? fact.when : null,
});

// The set, each notice asked under personal_transaction version 2. A notice the model answers in a
// way the lane refuses finds nothing; the model away, refused or over a budget ends the evaluation
// by its error. It passes when every notice lands in the transaction lane, none is withheld, every
// expected fact is found, and nothing else is: so a receipt gives the receipt alone, a notice one
// situation at most (its key is its sender and subject, whatever the domain), and marketing gives
// nothing.
export async function evaluateTransactions(
  port: { model: ModelClient },
  set: readonly EvalNotice[] = EVAL_NOTICES,
  // The version asked, and types it may add beside what a notice expects without failing it.
  { version = PROMPT_VERSIONS.transaction, allowed = [] }: { version?: string; allowed?: readonly string[] } = {},
): Promise<TransactionEvalReport> {
  const calls = callsInMemory();
  const prompt = promptAt("transaction", version);
  // A type off the lane's list gets a line of its own at the end, rather than ending a paid run.
  const { counts: types, line } = typeCounts(TRANSACTION_TYPES_V2, true);
  const report: TransactionEvalReport = {
    types,
    notices: set.length,
    expected: 0,
    found: 0,
    extra: 0,
    misrouted: [],
    unmapped: {},
    failed: [],
    withheld: [],
    passed: false,
    detail: [],
  };
  for (const notice of set) {
    report.expected += notice.expected.length;
    for (const one of notice.expected) line(one.type).expected += 1;
    const opened = openEvalNotice(notice);
    if (triage(dueOfNotice(opened, notice).triage).lane !== "transaction") report.misrouted.push(notice.id);
    let found: (Found & { when?: unknown })[] = [];
    let answered = true;
    try {
      const { parsed, read } = await readStored(opened, ["own"]);
      const { output } = await interpret(
        prompt,
        { message: JSON.stringify(messageSlot(parsed, notice.sentAt as Timestamp)) },
        parsed,
        read,
        { model: port.model, calls },
      );
      // A withheld notice commits nothing in a real run (withhold_item), so it finds nothing here and fails.
      if (withheldBy(output.narrowing) !== undefined) report.withheld.push(notice.id);
      else {
        const checked = await checkNotice(notice, output, { opened, parsed, read }, undefined, undefined, version);
        for (const one of checked.unmapped) report.unmapped[one.reason] = (report.unmapped[one.reason] ?? 0) + 1;
        found = checked.claims.map(({ claim }) => ({
          type: claim.content.type,
          subject: claim.content.subject,
          basis: claim.basis,
          fields: claim.content.fields,
          when: claim.content.fields.when,
        }));
      }
    } catch (error) {
      if (passesThrough(error) || !(error instanceof ExtractFailure)) throw error;
      answered = false;
    }
    // Each expected fact takes one found claim, at most once.
    const left = found.filter((one) => !allowed.includes(one.type));
    const matched = notice.expected.filter((one) => {
      const at = left.findIndex((it) => matches(one, it));
      if (at === -1) return false;
      left.splice(at, 1);
      return true;
    });
    report.found += matched.length;
    report.extra += left.length;
    for (const one of matched) line(one.type).found += 1;
    for (const one of left) line(one.type).extra += 1;
    if (!answered || matched.length < notice.expected.length || left.length > 0) report.failed.push(notice.id);
    report.detail.push({
      id: notice.id,
      evidenceId: opened.context.evidenceId,
      answered,
      expected: notice.expected.length,
      matched: matched.length,
      missed: notice.expected
        .filter((one) => !matched.includes(one))
        .map((one) =>
          shapeOf({ type: one.type, subject: EVAL_NOTICE_OWNER, ...(one.type === "plan" ? { when: one.when } : {}) }),
        ),
      extra: left.map(shapeOf),
    });
  }
  report.passed = report.failed.length === 0 && report.misrouted.length === 0 && report.withheld.length === 0;
  return report;
}

// What `pi extract check --world --lane transaction` prints: counts and the set's own notice ids,
// and no text. A type's line is printed when the set expects it or a fact of it was found.
export function transactionReportLines(report: TransactionEvalReport): string[] {
  const unmapped = Object.entries(report.unmapped).map(([reason, count]) => `${reason} ${count}`);
  return [
    ...countedLines(report.types),
    `notices: ${report.notices} expected ${report.expected} found ${report.found} extra ${report.extra}`,
    `misrouted: ${report.misrouted.length === 0 ? "none" : report.misrouted.join(",")}`,
    `unmapped: ${unmapped.length === 0 ? "none" : unmapped.join(", ")}`,
    `failed: ${report.failed.length === 0 ? "none" : report.failed.join(",")}`,
    `withheld: ${report.withheld.length === 0 ? "none" : report.withheld.join(",")}`,
    `result: ${report.passed ? "ok" : "failed"}`,
  ];
}
