import { randomBytes } from "node:crypto";
import {
  type DecisionPointId,
  isCoded,
  POINT_THRESHOLDS,
  type PointVerdict,
  type ThresholdName,
} from "@intelligence/contracts/personal";
import { DAY_MS, systemNow } from "@intelligence/personal-core";
import {
  DECIDE_RECORD,
  DECIDE_RECOVERY,
  DECIDE_SCREEN,
  decideInputHash,
  fitRecordSlot,
  fitScreenSlot,
  readStored,
} from "@intelligence/personal-extract";
import { effectiveThreshold, findDrift, proposeThreshold, REGISTRY, report } from "@intelligence/personal-ladder";
import type { Admin, ReviewCall } from "@intelligence/personal-store";
import type { CommandContext } from "../command-types.ts";
import { refusal } from "../env.ts";
import { escapeForTerminal } from "../terminal-text.ts";
import { print, printJson, withAdmin, yesNoSkip } from "./owner-kit.ts";

// The calibration commands, as pi_admin: the blind review, the weekly report with its proposals and
// drift, and the owner's resume of a suspended rung. Nothing here prints a probability of an item.

// The rung 1 points the review asks about: the prompt their calls were saved under, the question
// it asked (its output key), and the threshold their decision is read at. identity_rank's labels
// are its cards' answers, and draft_disclosure's are the harness send's.
const REVIEWED = Object.freeze({
  extract_triage: { prompt: DECIDE_SCREEN, question: "human_written", threshold: "lane" },
  extract_injection: { prompt: DECIDE_SCREEN, question: "quarantine", threshold: "hold" },
  extract_sensitivity: { prompt: DECIDE_SCREEN, question: "special_category", threshold: "hold" },
  extract_recovery: { prompt: DECIDE_RECOVERY, question: "account_recovery", threshold: "hold" },
  record_injection: { prompt: DECIDE_RECORD, question: "quarantine", threshold: "hold" },
} as const);
type Reviewed = keyof typeof REVIEWED;

const isReviewed = (point: string): point is Reviewed => Object.hasOwn(REVIEWED, point);

// A point by its id, at its current version: there is no lookup by id alone.
const registered = (point: unknown): point is DecisionPointId =>
  typeof point === "string" && REGISTRY.ids().includes(point as DecisionPointId);
export function versionOf(point: string): number {
  if (!registered(point)) throw refusal("usage");
  return REGISTRY.current(point).definition.version;
}

// An answer given sooner than this after the item was shown is stored `hurried`, not counted.
const HURRIED_MS = 2_000;
const requestId = (): string => `rv_${randomBytes(12).toString("base64url")}`;

// One ledger.owner_views row, target kind `call`, the saved
// call's id, when an item is shown and before its answer is read, so its review time counts. The
// hurried rule above still applies.
// False when the saved call is gone (`pi extract retry` or an erasure removed it since the
// sample was drawn): the item is then skipped unasked, as one whose input changed is.
const recordView = async (admin: Admin, call: ReviewCall): Promise<boolean> => {
  try {
    await admin.learning.markViewed({ kind: "call", id: call.callId }, "cli");
    return true;
  } catch (error) {
    if (isCoded(error, "not_found")) return false;
    throw error;
  }
};

// What the model was shown, re-rendered from the stored item, and the hash of that input; null
// when the item can no longer be opened or read.
async function shownOf(
  admin: Admin,
  call: ReviewCall,
  point: Reviewed,
): Promise<{ slot: unknown; inputHash: string } | null> {
  const opened = await admin.calibration.openForReview(call.evidenceId);
  if (opened === null) return null;
  const { prompt } = REVIEWED[point];
  try {
    if (opened.kind === "record") {
      if (prompt !== DECIDE_RECORD) return null;
      const slot = fitRecordSlot(opened.record.body);
      return { slot, inputHash: decideInputHash(prompt, { record: JSON.stringify(slot) }) };
    }
    if (prompt === DECIDE_RECORD) return null;
    const { parsed } = await readStored(opened.item, call.compartments);
    const slot = fitScreenSlot(parsed, opened.triage);
    return { slot, inputHash: decideInputHash(prompt, { message: JSON.stringify(slot) }) };
  } catch {
    return null;
  }
}

// The question word for word: its instructions and criteria, from the prompt's own text.
const questionOf = (point: Reviewed): { instructions: string; criteria: { true: string; false: string } } => {
  const { prompt, question } = REVIEWED[point];
  return (
    JSON.parse(prompt.instructions) as Record<
      string,
      { instructions: string; criteria: { true: string; false: string } }
    >
  )[question] as never;
};

// `pi ladder review --point P [--sample N]`: to a terminal only, which `run` has checked. Each
// item is the input the model was shown, escaped for the terminal, and the question word for
// word; never the probability, the effect or whether the item is held. One answer a line: y, n,
// or s to skip, which stores nothing. An item whose input is no longer the one the model saw is
// skipped unasked.
export async function ladderReview(context: CommandContext): Promise<0> {
  const point = context.values.point;
  if (typeof point !== "string" || !isReviewed(point)) throw refusal("usage");
  const sample = typeof context.values.sample === "string" ? Number(context.values.sample) : 30;
  const now = context.deps.now ?? systemNow;
  const version = versionOf(point);
  const { prompt, question } = REVIEWED[point];
  const asked = questionOf(point);
  return withAdmin(context, async (admin) => {
    const calls = await admin.calibration.reviewSample(
      point,
      version,
      { id: prompt.id, version: prompt.version },
      question,
      sample,
    );
    const answers = yesNoSkip<PointVerdict>(context, { y: "yes", n: "no" });
    let answered = 0;
    let skipped = 0;
    try {
      for (const call of calls) {
        const shown = await shownOf(admin, call, point);
        if (
          shown === null ||
          !admin.calibration.sameInput(call.inputFp, shown.inputHash) ||
          !(await recordView(admin, call))
        ) {
          skipped += 1;
          continue;
        }
        print(context, escapeForTerminal(JSON.stringify(shown.slot, null, 2)));
        print(context, `question: ${escapeForTerminal(asked.instructions)}`);
        print(context, `yes: ${escapeForTerminal(asked.criteria.true)}`);
        print(context, `no: ${escapeForTerminal(asked.criteria.false)}`);
        const shownAt = now().getTime();
        const answer = await answers.ask("y, n or s: ");
        if (answer === null) return printJson(context, { answered, skipped });
        if (answer === "skip") {
          skipped += 1;
          continue;
        }
        const hurried = now().getTime() - shownAt < HURRIED_MS;
        await admin.calibration.recordVerdict({
          point,
          version,
          callId: call.callId,
          evidenceId: call.evidenceId,
          source: "review",
          verdict: answer,
          p: call.p,
          band: call.band,
          weight: call.weight,
          hurried,
          deliberate: !hurried,
          compartments: call.compartments,
          requestId: requestId(),
        });
        answered += 1;
      }
      printJson(context, { answered, skipped });
    } finally {
      answers.close();
    }
  });
}

// The threshold a point version's report is read at: its effective lane or hold; none for a
// point with no threshold (identity_rank).
function thresholdOf(
  point: string,
  version: number,
  grants: Parameters<typeof effectiveThreshold>[0],
): { name: ThresholdName; value: number } | null {
  const names = Object.keys(POINT_THRESHOLDS[`${point}@${version}`] ?? {}) as ThresholdName[];
  const name = names.includes("lane") ? "lane" : names.includes("hold") ? "hold" : undefined;
  if (name === undefined) return null;
  const effective = effectiveThreshold(grants, point, version, name);
  return effective === null ? null : { name, value: effective.value };
}

// `pi ladder calibrate [--point P]`: one report for each point version with a verdict, written
// and printed; a proposal where the owner set a target (none for a hold with no target); and on
// drift, the suspension where it narrows and the card either way. Counts, shares and intervals,
// and a proposal's id and value: no item and no probability of one.
export async function ladderCalibrate(context: CommandContext): Promise<0> {
  const only = context.values.point;
  if (only !== undefined && !registered(only)) throw refusal("usage");
  const now = context.deps.now ?? systemNow;
  return withAdmin(context, async (admin) => {
    const { calibration } = admin;
    const grants = await calibration.grants();
    const points = (await calibration.pointsWithVerdicts()).filter((one) => only === undefined || one.point === only);
    for (const { point, version } of points) {
      const counted = await calibration.countedVerdicts(point, version);
      const since = now().getTime() - 28 * DAY_MS;
      const scored = counted.map(({ p, verdict, weight }) => ({ p, verdict, weight }));
      const recent = counted
        .filter((one) => one.at.getTime() >= since)
        .map(({ p, verdict, weight }) => ({ p, verdict, weight }));
      const threshold = thresholdOf(point, version, grants);
      const made = report(scored, threshold, recent);
      const drift = findDrift({
        point,
        version,
        recent,
        threshold,
        grantedDisagreement: threshold === null ? null : await calibration.grantedDisagreement(point, version),
      });
      const reportId = await calibration.writeReport(point, version, {
        n: made.n,
        bands: made.bands,
        precision: made.precision,
        recall: made.recall,
        agreement: made.agreement,
        agreement28d: made.agreement28d,
        intervals: made.intervals,
        drift: drift.drift,
        insufficient: made.insufficient,
      });
      let proposal: { id: string; value: number } | string | null = null;
      const bounds = threshold === null ? undefined : POINT_THRESHOLDS[`${point}@${version}`]?.[threshold.name];
      if (threshold !== null && bounds !== undefined) {
        const target = await calibration.targetOf(point, version);
        const asked =
          threshold.name === "lane"
            ? {}
            : target === null
              ? null
              : {
                  ...(target.recall === null ? {} : { recall: target.recall }),
                  ...(target.miss === null ? {} : { miss: target.miss }),
                  ...(target.precision === null ? {} : { precision: target.precision }),
                };
        const proposed = proposeThreshold(scored, asked, bounds, threshold.name, { current: threshold.value });
        proposal =
          typeof proposed === "string"
            ? proposed
            : {
                id: await calibration.writeProposal(point, version, threshold.name, proposed.value, reportId),
                value: proposed.value,
              };
      }
      if (drift.drift) {
        if (drift.suspend) await calibration.suspend(point, version, reportId);
        await calibration.raiseDrift(point, version, reportId);
      }
      printJson(context, {
        point,
        version,
        report: reportId,
        ...made,
        drift: drift.drift,
        suspended: drift.drift && drift.suspend,
        proposal,
      });
    }
  });
}

// `pi ladder resume POINT`: the suspension lifted, as the owner's decision.
export async function ladderResume(context: CommandContext): Promise<0> {
  const point = context.positionals[0] ?? "";
  const version = versionOf(point);
  return withAdmin(context, async (admin) => {
    printJson(context, {
      resumed: point,
      version,
      decision: await admin.calibration.resume(point, version, { requestId: requestId() }),
    });
  });
}
