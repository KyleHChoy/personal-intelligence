import { createHmac, timingSafeEqual } from "node:crypto";
import { createInterface } from "node:readline";
import {
  type FactType,
  type PipelineStatus,
  type ReviewExport,
  ReviewImport,
  type TriageLane,
} from "@intelligence/contracts/personal";
import {
  EXTRACT_GENERATION,
  FACT_KIND_LANES,
  keptVersions,
  REPLAYED_VERSIONS,
  runThresholds,
  triageBy,
} from "@intelligence/personal-extract";
import { effectiveThresholds } from "@intelligence/personal-ladder";
import {
  AdminError,
  type Keys,
  type RetryKind,
  type RetryLane,
  type RetrySelection,
  type ReviewItem,
  type ReviewState,
  type ReviewVerdict,
  type Verdict,
} from "@intelligence/personal-store";
import type { CommandContext } from "../command-types.ts";
import { found, refusal } from "../env.ts";
import { print, printJson, withAdmin } from "../owner/owner-kit.ts";

// The owner's side of extraction, as pi_admin: the status, the review and the retry. `run` has checked each
// command's arguments before any connection.

export async function extractStatus(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.extraction.status({ generation: EXTRACT_GENERATION }));
  });
}

// `pia extract value-fp-backfill`, counts only.
export async function extractValueFpBackfill(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.extraction.valueFpBackfill());
  });
}

// `pia extract carry-over --generation N`: the rulings and owner-judged relations that find no
// claim of generation N or later, ids only. With `--reattach`, those rulings
// re-attached, found gone, asked about or skipped, counts only; with `--dry-run` as well, counted
// and not written. With `--anchor`, the rulings in force given their anchors; with `--gate`, the
// carry-over gate's report for the generation.
export async function extractCarryOver(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    const generation = Number(context.values.generation);
    if (context.values.reattach === true)
      printJson(
        context,
        await admin.extraction.reattachRulings({ generation, dryRun: context.values["dry-run"] === true }),
      );
    else if (context.values.anchor === true) printJson(context, await admin.extraction.anchorRulings());
    else if (context.values.gate === true) printJson(context, await admin.extraction.carryGate(generation));
    else printJson(context, await admin.extraction.carryOver({ generation }));
  });
}

// The owner's answers, one line each, read from the command's input: the tests script it. The
// interface is closed when the review ends, so a terminal's input does not keep the process up.
function answers(context: CommandContext): { next: () => Promise<string | null>; close: () => void } {
  const reader = createInterface({ input: context.io.stdin, crlfDelay: Infinity });
  const lines = reader[Symbol.asyncIterator]();
  return {
    next: async () => {
      const next = await lines.next();
      return next.done === true ? null : next.value.trim().toLowerCase();
    },
    close: () => reader.close(),
  };
}

const CLAIM_VERDICTS: Record<string, Verdict> = {
  r: "right",
  right: "right",
  w: "wrong",
  wrong: "wrong",
  d: "wrong_date",
  wrong_date: "wrong_date",
};
const ITEM_VERDICTS: Record<string, Verdict | null> = { "": null, m: "missed", missed: "missed" };

// Asks until an answer is one the table knows. Null when the input has ended.
async function ask<T>(
  context: CommandContext,
  next: () => Promise<string | null>,
  question: string,
  table: Record<string, T>,
): Promise<{ answer: T } | null> {
  for (;;) {
    context.io.stdout.write(question);
    const line = await next();
    if (line === null) return null;
    if (Object.hasOwn(table, line)) return { answer: table[line] as T };
  }
}

// The passage a span cites in the message's text, where its offsets fall inside it.
function passage(item: ReviewItem, span: string): string {
  const match = /^chars:(\d+)-(\d+)$/.exec(span);
  const text = (item.message.text ?? "").replaceAll("\r\n", "\n");
  if (match === null || Number(match[2]) > text.length) return span;
  return text.slice(Number(match[1]), Number(match[2]));
}

function show(context: CommandContext, item: ReviewItem, index: number, total: number): void {
  const { message } = item;
  print(context, `item ${index + 1} of ${total}: ${message.at}`);
  print(context, `subject: ${message.subject ?? ""}`);
  print(context, `sender: ${message.sender ?? ""}`);
  print(context, `lane: ${item.lane}`);
  print(context, `text:\n${message.text ?? ""}`);
  item.claims.forEach((claim, n) => {
    print(context, `claim ${n + 1}: ${claim.type} ${JSON.stringify(claim.fields)}`);
    print(context, `  passage: ${passage(item, claim.span)}`);
  });
}

// The review's arguments, as `run` has checked them. The export takes the same.
const reviewOptions = ({ values }: CommandContext): { type: string | undefined; sample: number } => ({
  type: typeof values.type === "string" ? values.type : undefined,
  sample: typeof values.sample === "string" ? Number(values.sample) : 50,
});

// To a terminal only: `run` has refused any other output. Each item's verdicts are stored once
// they are all given, so an input that ends part way keeps the items finished before it.
export async function extractReview(context: CommandContext): Promise<0> {
  const { type, sample } = reviewOptions(context);
  return withAdmin(context, async (admin) => {
    const items = await admin.extraction.reviewSample({ sample, ...(type === undefined ? {} : { type }) });
    const input = answers(context);
    let reviewed = 0;
    try {
      for (const [index, item] of items.entries()) {
        show(context, item, index, items.length);
        const verdicts: ReviewVerdict[] = [];
        for (const [n, claim] of item.claims.entries()) {
          const given = await ask(context, input.next, `claim ${n + 1} (right, wrong, wrong_date): `, CLAIM_VERDICTS);
          if (given === null) return printJson(context, { reviewed });
          verdicts.push({ evidenceId: item.evidenceId, claimId: claim.id, type: claim.type, verdict: given.answer });
        }
        const missed = await ask(
          context,
          input.next,
          "anything missed (missed, or enter for nothing): ",
          ITEM_VERDICTS,
        );
        if (missed === null) return printJson(context, { reviewed });
        // A missed fact is counted under the type the review asked about, or `any`. An item with no
        // claim and nothing missed is stored as `nothing`, so it counts as reviewed.
        if (missed.answer !== null)
          verdicts.push({ evidenceId: item.evidenceId, type: type ?? "any", verdict: missed.answer });
        else if (verdicts.length === 0)
          verdicts.push({ evidenceId: item.evidenceId, type: type ?? "any", verdict: "nothing" });
        await admin.extraction.recordReview(verdicts);
        reviewed += 1;
      }
      printJson(context, { reviewed });
    } finally {
      input.close();
    }
  });
}

// The review as one document: `review-export` prints the sample the terminal
// review would show, as one document, and `review-import` reads the verdicts back.
// The export holds decrypted mail from every compartment, so it is printed to a terminal only:
// `run` refuses `not_a_terminal` before any connection when stdout is not one.

// A sample: the generation it was drawn under, its type, and each item's id with its claims' ids.
export type Sample = { generation: number; type: string | null; items: [string, string[]][] };
// What the store holds now for each item a verdict names.
export type SampleState = ReviewState;

// The sample id carries the sample, under a MAC of the key file's fingerprint key, so the import
// checks each id against what the export produced with no table to keep it in.
const SAMPLE_VERSION = "rs1";
const sampleMac = (keys: Keys, payload: string): Buffer =>
  createHmac("sha256", keys.fingerprintKey).update(`review_sample\0${payload}`, "utf8").digest();

export function sealSample(keys: Keys, sample: Sample): string {
  const payload = Buffer.from(JSON.stringify(sample), "utf8").toString("base64url");
  return `${SAMPLE_VERSION}.${payload}.${sampleMac(keys, payload).toString("base64url")}`;
}

export function openSample(keys: Keys, sampleId: string): Sample {
  const [version, payload, mac, ...rest] = sampleId.split(".");
  if (version !== SAMPLE_VERSION || payload === undefined || mac === undefined || rest.length > 0)
    throw refusal("review_unknown_id");
  const given = Buffer.from(mac, "base64url");
  const expected = sampleMac(keys, payload);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw refusal("review_unknown_id");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Sample;
}

export async function extractReviewExport(context: CommandContext): Promise<0> {
  const { type, sample } = reviewOptions(context);
  return withAdmin(context, async (admin, keys) => {
    const items = await admin.extraction.reviewSample({ sample, ...(type === undefined ? {} : { type }) });
    const sealed = sealSample(keys, {
      generation: EXTRACT_GENERATION,
      type: type ?? null,
      items: items.map((item) => [item.evidenceId, item.claims.map((claim) => claim.id)]),
    });
    const document: ReviewExport = {
      sample_id: sealed,
      generation: EXTRACT_GENERATION,
      type: (type ?? null) as FactType | null,
      items: items.map((item) => ({
        item_id: item.evidenceId as ReviewExport["items"][number]["item_id"],
        message_id: item.message.id,
        lane: item.lane,
        date: item.message.at,
        subject: item.message.subject,
        sender: item.message.sender,
        text: item.message.text,
        claims: item.claims.map((claim) => ({
          claim_id: claim.id,
          type: claim.type,
          fields: claim.fields,
          passage: passage(item, claim.span),
        })),
      })),
    };
    printJson(context, document);
  });
}

// Each answered item's verdicts, as the terminal review stores them, or a refusal: an id the
// sample does not hold, a verdict given twice or already stored, an item whose claims are not
// all judged, a sample from another generation or an item changed since, or `nothing` beside a
// claim or a miss. A refusal is thrown before anything is stored.
export function importVerdicts(
  document: ReviewImport,
  sample: Sample,
  state: SampleState,
  generation: number,
): ReviewVerdict[][] {
  if (sample.generation !== generation) throw refusal("review_stale");
  const sampled = new Map(sample.items);
  const seen = new Set<string>();
  return document.verdicts.map((answer) => {
    const claimIds = sampled.get(answer.item_id);
    if (claimIds === undefined) throw refusal("review_unknown_id");
    if (seen.has(answer.item_id)) throw refusal("review_duplicate");
    seen.add(answer.item_id);
    const judged = new Set<string>();
    for (const { claim_id } of answer.claims) {
      if (!claimIds.includes(claim_id)) throw refusal("review_unknown_id");
      if (judged.has(claim_id)) throw refusal("review_duplicate");
      judged.add(claim_id);
    }
    const now = state.get(answer.item_id);
    const same =
      now !== undefined &&
      now.claims.length === claimIds.length &&
      now.claims.every((claim) => claimIds.includes(claim.id));
    if (now === undefined || !now.done || !same) throw refusal("review_stale");
    if (now.reviewed) throw refusal("review_duplicate");
    if (judged.size !== claimIds.length) throw refusal("review_incomplete");
    if (answer.nothing === true && (claimIds.length > 0 || answer.missed)) throw refusal("review_invalid");
    const typeOf = new Map(now.claims.map((claim) => [claim.id, claim.type]));
    const verdicts: ReviewVerdict[] = answer.claims.map(({ claim_id, verdict }) => ({
      evidenceId: answer.item_id,
      claimId: claim_id,
      type: typeOf.get(claim_id) ?? "",
      verdict,
    }));
    if (answer.missed) verdicts.push({ evidenceId: answer.item_id, type: sample.type ?? "any", verdict: "missed" });
    else if (verdicts.length === 0)
      verdicts.push({ evidenceId: answer.item_id, type: sample.type ?? "any", verdict: "nothing" });
    return verdicts;
  });
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

// The document is checked before any connection. The verdicts are checked against the store and
// stored in one transaction, so a refusal writes nothing and nothing checked moves before the write.
export async function extractReviewImport(context: CommandContext): Promise<0> {
  let document: ReviewImport;
  try {
    document = ReviewImport.parse(JSON.parse(await readAll(context.io.stdin)));
  } catch {
    throw refusal("review_invalid");
  }
  return withAdmin(context, async (admin, keys) => {
    const sample = openSample(keys, document.sample_id);
    let reviewed = 0;
    const stored = await admin.extraction.importReview(
      document.verdicts.map((answer) => answer.item_id),
      (state) => {
        const items = importVerdicts(document, sample, state, EXTRACT_GENERATION);
        reviewed = items.length;
        return items.flat();
      },
    );
    printJson(context, { reviewed, stored });
  });
}

const confirmHint = (selected: number): string =>
  `add --yes to set aside ${selected} saved answers; each costs one live call`;
// `--fact-kinds`, the lanes switched on (PI_EXTRACT_FACT_KINDS's value), which this process's variables do not hold.
const keptFor = (given: unknown) => {
  const on = typeof given === "string" ? given.split(",") : [];
  if (on.some((lane) => !(FACT_KIND_LANES as readonly string[]).includes(lane))) throw refusal("usage");
  const of = (lane: "correspondence" | "transaction" | "agent") => keptVersions(lane, on.includes(lane));
  return { correspondence: of("correspondence"), transaction: of("transaction"), agent: of("agent") };
};
const keepHint = (selected: number, asked: number): string =>
  `add --yes to set ${selected} waiting: ${asked} ask the model, one live call each, and the rest replay at no cost`;

// A release keeps the saved answer; a retry deletes the selected items' saved calls. `--document ID`
// selects one document, as `--message ID` one message.
export async function extractRetry(context: CommandContext): Promise<0> {
  const { values } = context;
  const message = typeof values.message === "string" ? values.message : undefined;
  return withAdmin(context, async (admin) => {
    if (values.override === true && message !== undefined) {
      await admin.extraction.release(message);
      printJson(context, { released: 1 });
      return;
    }
    const status =
      typeof values.status === "string" ? (values.status as Exclude<PipelineStatus, "waiting">) : undefined;
    const selection: RetrySelection =
      message !== undefined
        ? { messageId: message }
        : typeof values.document === "string"
          ? { documentId: values.document }
          : typeof values.capture === "string"
            ? { capture: values.capture }
            : typeof values.kind === "string"
              ? { kind: values.kind as RetryKind, ...(status === undefined ? {} : { status }) }
              : typeof values["in-lane"] === "string"
                ? { inLane: values["in-lane"] as RetryLane, ...(status === undefined ? {} : { status }) }
                : status !== undefined
                  ? { status }
                  : { all: true };
    const lane = typeof values.lane === "string" ? (values.lane as TriageLane) : undefined;
    try {
      printJson(
        context,
        await admin.extraction.retry(selection, {
          ...(lane === undefined ? {} : { lane }),
          confirmed: values.yes === true,
          ...(values["keep-answers"] === true ? { keepAnswers: keptFor(values["fact-kinds"]) } : {}),
        }),
      );
    } catch (error) {
      if (!(error instanceof AdminError) || error.code !== "confirm_needed") throw error;
      const selected = error.selected ?? 0;
      const { cost } = error;
      printJson(context, { selected, ...cost });
      throw refusal("confirm_needed", cost === undefined ? confirmHint(selected) : keepHint(selected, cost.asked));
    }
  });
}

// `pia extract reroute [--dry-run]`, the done transaction-lane items triage's known
// correspondent line now sends to correspondence, set waiting for the next runs. Counts only: the
// items and their text's code points, so the owner can price the re-read before it runs.
export async function extractReroute(context: CommandContext): Promise<0> {
  const dryRun = context.values["dry-run"] === true;
  return withAdmin(context, async (admin) => {
    const { selected, chars, rerouted } = await admin.extraction.reroute({ generation: EXTRACT_GENERATION, dryRun });
    printJson(context, dryRun ? { dry_run: true, selected, chars } : { selected, chars, rerouted });
  });
}

// `pia extract replay-refused [--yes]`: the items with a candidate refused for its fields, set
// waiting to replay their saved answers under today's check. With PI_EXTRACT_REPAIR set their next
// commit keeps what the repair finds, at no cost; with PI_EXTRACT_REASK set too, each still refused
// wholly for its wording is asked again under the day's budget. Counts only.
export async function extractReplayRefused(context: CommandContext): Promise<0> {
  const confirmed = context.values.yes === true;
  return withAdmin(context, async (admin) => {
    printJson(
      context,
      await admin.extraction.replayRefused({ generation: EXTRACT_GENERATION, confirmed, saved: REPLAYED_VERSIONS }),
    );
  });
}

// `pia extract item --message ID`, ids, codes and counts. `triage` is what the
// rule gives the message now, at the run's lane line, and which line decided (`by`); `status` is
// what its last run committed, so the two differ for an item due again.
export async function extractItem(context: CommandContext): Promise<0> {
  const message = context.values.message as string;
  return withAdmin(context, async (admin) => {
    const item = found(await admin.extraction.extractItem(message));
    const [grants, suspended] = await Promise.all([admin.calibration.grants(), admin.calibration.suspensions()]);
    const lines = runThresholds(
      effectiveThresholds(grants),
      suspended.map((one) => `${one.point}@${one.version}`),
    );
    const override = item.status?.laneOverride ?? undefined;
    const now = triageBy(
      item.triage,
      override,
      lines.laneSuspended ? undefined : (item.humanWritten ?? undefined),
      lines.lane,
    );
    printJson(context, {
      message: item.message,
      evidence: item.evidence,
      lane: item.status?.lane ?? null,
      status: item.status?.status ?? null,
      code: item.status?.code ?? null,
      generation: item.status?.generation ?? null,
      waiting: item.status?.waiting ?? null,
      attempts: item.status?.attempts ?? null,
      lane_override: item.status?.laneOverride ?? null,
      released: item.status?.override ?? false,
      triage: {
        lane: now.lane,
        by: now.by,
        ...(now.code === undefined ? {} : { code: now.code }),
        direction: item.triage.direction,
        bulk: item.triage.bulk,
        category: item.triage.category,
        no_text: item.triage.unreadable || item.triage.chars === 0,
        known_correspondent: item.triage.knownCorrespondent === true,
        lane_line: lines.lane,
        lane_suspended: lines.laneSuspended,
      },
      human_written: item.humanWritten,
      claims: item.claims,
      unmapped: item.unmapped,
    });
  });
}
