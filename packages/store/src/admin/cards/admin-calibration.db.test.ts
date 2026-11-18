import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceDeletion } from "@intelligence/contracts";
import {
  DECISION_POINTS,
  type EntityId,
  type KeyedCallRecord,
  POINT_THRESHOLDS,
  RungResumeDetails,
  ThresholdGrantDetails,
  ThresholdRevokeDetails,
  ThresholdTargetDetails,
  thresholdPair,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { openUnder } from "../../core/seal.ts";
import { statusAt } from "../../core/status-facts.ts";
import { bandOf, type VerdictInput } from "../../core/verdicts.ts";
import { createPipeline, type Pipeline } from "../../pipeline/pipeline.ts";
import { CANARY_PERSON, OWNER, QUENTIN, RHEA, SOLO, type Who } from "../../test-support/cast.ts";
import { sha256Hex, testId } from "../../test-support/clients.ts";
import { one } from "../../test-support/connections.ts";
import { fingerprint, queryAs, scanForPlaintext, type TestDatabase } from "../../test-support/database.ts";
import { ingestMail, type MailFixture, mail, mailSourceId } from "../../test-support/items.ts";
import { MAIL } from "../../test-support/items-named.ts";
import { type PipelineStore, rowsOf, stored, withAgents, withPipeline } from "../../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../../test-support/recording.ts";
import { withDatabase } from "../../test-support/store.ts";
import { type Admin, createAdmin } from "../admin.ts";
import type { ReportRow } from "./admin-calibration.ts";
import type { CalibrationAdmin } from "./cards-group.ts";

// Every refusal has its positive control in the same test.

const TIMEOUT = 240_000;
const ME: Who = { address: OWNER.personal, name: OWNER.name };
const DECIDE_MODEL = "typesafe/jev-1.13";

const REPORT: ReportRow = {
  n: 40,
  bands: [{ band: 0, n: 10, yes: 0.1, mean: 0.02 }],
  precision: 0.8,
  recall: 0.7,
  agreement: 0.9,
  agreement28d: 0.88,
  intervals: { precision: [0.6, 0.9] },
  drift: false,
  insufficient: false,
};

const rid = (): string => testId("req");
const message = (id: string, at: string, over: Partial<MailFixture> = {}): MailFixture =>
  mail({
    id,
    threadId: `thread-${id}`,
    at,
    from: { address: "ottilie@weighhouse.test", name: "Ottilie Weighhouse" },
    to: [ME],
    subject: `Scales ${id}`,
    labels: ["INBOX"],
    ...over,
  });
const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);
const addressFp = (db: TestDatabase, address: string): string => fingerprint(db.keys, "address", address);

type World = { db: TestDatabase; admin: Admin; calibration: CalibrationAdmin; pipeline: Pipeline };

// A database with an Admin (and its calibration) and a Pipeline on it.
const withCalibration = <T>(fn: (world: World) => Promise<T>): Promise<T> =>
  withDatabase(async (db) => {
    const made = createAdmin({ url: db.urls.admin, keys: db.keys, log: recordingLogger().log });
    const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: recordingLogger().log });
    try {
      return await fn({ db, admin: made, calibration: made.calibration, pipeline });
    } finally {
      await pipeline.close();
      await made.close();
    }
  });

// A store with a writer, the Pipeline, and an Admin that may erase (its own journal).
async function withOwner<T>(store: PipelineStore, fn: (owner: Admin) => Promise<T>): Promise<T> {
  const folder = await mkdtemp(join(tmpdir(), "pi-j2-calibration-"));
  const made = createAdmin({
    url: store.db.urls.admin,
    keys: store.db.keys,
    log: recordingLogger().log,
    journal: join(folder, "keys.json.erasures"),
  });
  try {
    return await fn(made);
  } finally {
    await made.close();
    await rm(folder, { recursive: true, force: true });
  }
}

const verdict = (over: Partial<VerdictInput> = {}): VerdictInput => ({
  point: "extract_recovery",
  version: 1,
  callId: testId("mcl"),
  evidenceId: null,
  source: "review",
  verdict: "yes",
  p: 0.9,
  band: bandOf(over.p ?? 0.9),
  weight: 1,
  hurried: false,
  deliberate: true,
  compartments: ["own"],
  requestId: rid(),
  ...over,
});

type DecisionRow = {
  kind: string;
  target_kind: string | null;
  target_id: string | null;
  details: unknown;
  batch: boolean;
};
const decisionOf = async (db: TestDatabase, id: string): Promise<DecisionRow> =>
  one(
    await admin<DecisionRow>(
      db,
      "select kind, target_kind, target_id, details, batch from knowledge.owner_decisions where id = $1",
      [id],
    ),
  );

// A pair call saved through the admin's store of completeKeyedWithReplay, and its id.
async function pairCall(
  db: TestDatabase,
  calibration: CalibrationAdmin,
  a: string,
  b: string,
  refs: string[],
): Promise<string> {
  const subject = `pair:${[a, b].sort().join(":")}`;
  const rawOutput = JSON.stringify({ same_person: 0.8 });
  const record: KeyedCallRecord = {
    key: {
      point: "identity_rank",
      version: 1,
      promptId: "jev_same_person",
      promptVersion: "1",
      subject,
      inputHash: sha256Hex(`input ${subject} ${refs.join(",")}`),
    },
    rawOutput,
    outputHash: sha256Hex(rawOutput),
    refs,
    compartments: ["own"],
    modelId: DECIDE_MODEL,
  };
  await calibration.decisionCalls().save(record);
  return one(
    await admin<{ id: string }>(db, "select id from vault.decision_calls where subject = $1 and input_fp = $2", [
      subject,
      fingerprint(db.keys, "model_input", record.key.inputHash),
    ]),
  ).id;
}
const callIds = async (db: TestDatabase): Promise<string[]> =>
  (await admin<{ id: string }>(db, "select id from vault.decision_calls")).map((row) => row.id).sort();

// One saved model call of a stored item, through the Pipeline, and its id.
async function saveCall(
  store: PipelineStore,
  evidenceId: string,
  prompt: string,
  output: Record<string, unknown>,
  inputHash: string,
): Promise<string> {
  const rawOutput = JSON.stringify(output);
  await store.pipeline.calls(DECIDE_MODEL).save({
    key: { evidenceId, revision: 0, extractorGeneration: 0, promptId: prompt, promptVersion: "1", inputHash },
    keys: [{ evidenceId, keyRef: "personal-unsealed" }],
    renderedInput: "",
    rawOutput,
    outputHash: sha256Hex(rawOutput),
    label: { compartments: ["own"], readers: ["m-owner"] },
    origin: "live",
  } as never);
  return one(
    await admin<{ id: string }>(store.db, "select id from vault.model_calls where evidence_id = $1 and input_fp = $2", [
      evidenceId,
      fingerprint(store.db.keys, "model_input", inputHash),
    ]),
  ).id;
}

describe("thresholds", { timeout: TIMEOUT }, () => {
  it("a grant outside its point version's floor and ceiling is refused out_of_bounds, by writeProposal, grantProposal and setThreshold, and writes nothing", () =>
    withCalibration(async ({ db, calibration }) => {
      const report = await calibration.writeReport("extract_recovery", 1, REPORT);
      const outOfBounds = { code: "out_of_bounds" };
      // extract_recovery@1's hold: default 0.7, floor 0.3, ceiling 0.95.
      for (const value of [0.29, 0.951, 1.5, -0.1, Number.NaN]) {
        await expect(
          calibration.writeProposal("extract_recovery", 1, "hold", value, report),
          String(value),
        ).rejects.toMatchObject(outOfBounds);
        await expect(
          calibration.setThreshold("extract_recovery", 1, "hold", value, { requestId: rid() }),
          String(value),
        ).rejects.toMatchObject(outOfBounds);
      }
      // A name the point version has not, a version that does not exist, and a point with no threshold.
      for (const [point, version, name] of [
        ["extract_recovery", 1, "lane"],
        ["extract_recovery", 2, "hold"],
        ["identity_rank", 1, "hold"],
      ] as const) {
        await expect(
          calibration.writeProposal(point, version, name, 0.5, report),
          `${point}@${version} ${name}`,
        ).rejects.toMatchObject(outOfBounds);
        await expect(
          calibration.setThreshold(point, version, name, 0.5, { requestId: rid() }),
          `${point}@${version} ${name}`,
        ).rejects.toMatchObject(outOfBounds);
      }
      // A proposal row outside the bounds (the table takes 0 to 1) is refused at its grant.
      const outside = testId("tpr");
      await admin(
        db,
        "insert into ledger.threshold_proposals (id, point, version, name, value, report_id) values ($1, 'extract_recovery', 1, 'hold', 0.99, $2)",
        [outside, report],
      );
      await expect(calibration.grantProposal(outside, { requestId: rid() })).rejects.toMatchObject(outOfBounds);
      await expect(calibration.grantProposal(testId("tpr"), { requestId: rid() })).rejects.toMatchObject({
        code: "not_found",
      });
      expect(await rowsOf(db, "select id from policy.thresholds")).toEqual([]);
      expect(await rowsOf(db, "select id from knowledge.owner_decisions")).toEqual([]);
      expect(
        (await rowsOf<{ id: string }>(db, "select id from ledger.threshold_proposals")).map((row) => row.id),
      ).toEqual([outside]);

      // The positive controls: the floor and the ceiling are taken.
      const floor = await calibration.writeProposal("extract_recovery", 1, "hold", 0.3, report);
      expect(await calibration.grantProposal(floor, { requestId: rid() })).toMatch(/^thr_/);
      expect(await calibration.setThreshold("extract_recovery", 1, "hold", 0.95, { requestId: rid() })).toMatch(
        /^thr_/,
      );
      expect((await rowsOf(db, "select id from policy.thresholds")).length).toBe(2);
    }));

  // D4: a point version's accept stays above its reject, as its rung 1 entry names them. It runs from
  // the first registered point version whose pair's bounds overlap (LR4 or LR5 onward); where they do
  // not, the floor and ceiling alone keep the order. LR1 has none.
  const paired = DECISION_POINTS.flatMap((definition) => {
    const entry = definition.models?.find((one) => one.rung === 1);
    const names = POINT_THRESHOLDS[`${definition.id}@${definition.version}`];
    if (entry?.rung !== 1 || names === undefined) return [];
    const reject = thresholdPair(definition, entry.thresholds.accept)?.other;
    const [high, low] = [names[entry.thresholds.accept], reject === undefined ? undefined : names[reject]];
    if (reject === undefined || high === undefined || low === undefined || low.ceiling < high.floor) return [];
    return [{ point: definition.id, version: definition.version, accept: entry.thresholds.accept, reject, high, low }];
  })[0];
  it.skipIf(paired === undefined)(
    "a grant or revoke that puts reject at or above accept is refused out_of_bounds and writes nothing; a repeated grant is its first",
    () =>
      withCalibration(async ({ db, calibration }) => {
        const { point, version, accept, reject, high, low } = paired as NonNullable<typeof paired>;
        const overlap = high.floor;
        const granted = await calibration.setThreshold(point, version, accept, overlap, { requestId: rid() });
        await expect(
          calibration.setThreshold(point, version, reject, overlap, { requestId: rid() }),
        ).rejects.toMatchObject({ code: "out_of_bounds" });
        expect((await rowsOf(db, "select id from policy.thresholds")).length).toBe(1);
        expect((await rowsOf(db, "select id from knowledge.owner_decisions")).length).toBe(1);
        // The positive control: a reject below the granted accept is taken; an accept at it is then refused.
        const below = Math.max(low.floor, overlap - 0.01);
        const requestId = rid();
        const rejectId = await calibration.setThreshold(point, version, reject, below, { requestId });
        await expect(
          calibration.setThreshold(point, version, accept, below, { requestId: rid() }),
        ).rejects.toMatchObject({ code: "out_of_bounds" });
        // Revoking the granted accept would put it back at its default; refused when that is not above the reject.
        if (high.default <= below)
          await expect(calibration.revokeThreshold(granted, { requestId: rid() })).rejects.toMatchObject({
            code: "out_of_bounds",
          });
        else expect(await calibration.revokeThreshold(granted, { requestId: rid() })).toMatch(/^rul_/);
        // A repeated request returns its first grant, whatever was granted since.
        expect(await calibration.setThreshold(point, version, reject, below, { requestId })).toBe(rejectId);
      }),
  );

  it("a grant writes a threshold_grant decision whose details parse, and a policy.thresholds row of source proposal (grantProposal) or set (setThreshold)", () =>
    withCalibration(async ({ db, calibration }) => {
      const report = await calibration.writeReport("extract_triage", 3, REPORT);
      const proposal = await calibration.writeProposal("extract_triage", 3, "lane", 0.55, report);
      // A proposal applies nothing.
      expect(await rowsOf(db, "select id from policy.thresholds")).toEqual([]);
      const requestId = rid();
      const granted = await calibration.grantProposal(proposal, { requestId });
      type Threshold = {
        id: string;
        point: string;
        version: number;
        name: string;
        value: string;
        decision_id: string;
        source: string;
        proposal_id: string | null;
        revoked_at: Date | null;
      };
      const thresholdOf = async (id: string): Promise<Threshold> =>
        one(
          await rowsOf<Threshold>(
            db,
            "select id, point, version, name, value::text as value, decision_id, source, proposal_id, revoked_at from policy.thresholds where id = $1",
            [id],
          ),
        );
      const row = await thresholdOf(granted);
      expect(row).toMatchObject({
        point: "extract_triage",
        version: 3,
        name: "lane",
        value: "0.55",
        source: "proposal",
        proposal_id: proposal,
        revoked_at: null,
      });
      const decision = await decisionOf(db, row.decision_id);
      expect(decision).toMatchObject({
        kind: "threshold_grant",
        target_kind: "threshold",
        target_id: granted,
        batch: false,
      });
      expect(ThresholdGrantDetails.parse(decision.details)).toEqual({
        point: "extract_triage",
        version: 3,
        name: "lane",
        value: 0.55,
        source: "proposal",
        threshold: granted,
        proposal,
      });
      // The same request again: the first grant's threshold, and no second row.
      expect(await calibration.grantProposal(proposal, { requestId })).toBe(granted);
      expect((await rowsOf(db, "select id from policy.thresholds")).length).toBe(1);

      const set = await calibration.setThreshold("extract_recovery", 1, "hold", 0.6, { requestId: rid() });
      const setRow = await thresholdOf(set);
      expect(setRow).toMatchObject({
        point: "extract_recovery",
        version: 1,
        name: "hold",
        value: "0.6",
        source: "set",
        proposal_id: null,
      });
      const setDecision = await decisionOf(db, setRow.decision_id);
      expect(setDecision).toMatchObject({ kind: "threshold_grant", target_kind: "threshold", target_id: set });
      expect(ThresholdGrantDetails.parse(setDecision.details)).toEqual({
        point: "extract_recovery",
        version: 1,
        name: "hold",
        value: 0.6,
        source: "set",
        threshold: set,
        proposal: null,
      });
    }));

  it("pipeline.thresholds() returns the latest unrevoked grant of each point version and name, and after its revoke none, so the default applies", () =>
    withCalibration(async ({ db, calibration, pipeline }) => {
      expect(await pipeline.thresholds()).toEqual([]);
      const earlier = await calibration.setThreshold("extract_triage", 3, "lane", 0.4, { requestId: rid() });
      const later = await calibration.setThreshold("extract_triage", 3, "lane", 0.45, { requestId: rid() });
      expect(await pipeline.thresholds()).toEqual([
        { id: later, point: "extract_triage", version: 3, name: "lane", value: 0.45, source: "set" },
      ]);
      expect(await calibration.grants()).toEqual(await pipeline.thresholds());
      await calibration.revokeThreshold(earlier, { requestId: rid() });

      const recovery = await calibration.setThreshold("extract_recovery", 1, "hold", 0.6, { requestId: rid() });
      expect(await pipeline.thresholds()).toEqual([
        { id: recovery, point: "extract_recovery", version: 1, name: "hold", value: 0.6, source: "set" },
        { id: later, point: "extract_triage", version: 3, name: "lane", value: 0.45, source: "set" },
      ]);
      const ruling = await calibration.revokeThreshold(recovery, { requestId: rid() });
      const decision = await decisionOf(db, ruling);
      expect(decision).toMatchObject({ kind: "threshold_revoke", target_kind: "threshold", target_id: recovery });
      expect(ThresholdRevokeDetails.parse(decision.details)).toEqual({ threshold: recovery });
      expect(
        one(
          await rowsOf<{ revoked: boolean }>(
            db,
            "select revoked_at is not null as revoked from policy.thresholds where id = $1",
            [recovery],
          ),
        ).revoked,
      ).toBe(true);
      // extract_recovery@1 has no grant left: the default in code applies.
      expect(await pipeline.thresholds()).toEqual([
        { id: later, point: "extract_triage", version: 3, name: "lane", value: 0.45, source: "set" },
      ]);
      // A revoked grant, and an id that names none, are not_found.
      await expect(calibration.revokeThreshold(recovery, { requestId: rid() })).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(calibration.revokeThreshold(testId("thr"), { requestId: rid() })).rejects.toMatchObject({
        code: "not_found",
      });
    }));

  it("setTarget writes a threshold_target decision whose details parse, and targetOf reads the latest; a target for no threshold, or of no value, is invalid_argument", () =>
    withCalibration(async ({ db, calibration }) => {
      expect(await calibration.targetOf("extract_recovery", 1)).toBeNull();
      const ruling = await calibration.setTarget(
        "extract_recovery",
        1,
        { recall: 0.9, miss: null, precision: null },
        { requestId: rid() },
      );
      const decision = await decisionOf(db, ruling);
      expect(decision.kind).toBe("threshold_target");
      expect(ThresholdTargetDetails.parse(decision.details)).toEqual({
        point: "extract_recovery",
        version: 1,
        recall: 0.9,
        miss: null,
        precision: null,
      });
      expect(await calibration.targetOf("extract_recovery", 1)).toEqual({ recall: 0.9, miss: null, precision: null });
      await calibration.setTarget(
        "extract_recovery",
        1,
        { recall: 0.95, miss: null, precision: null },
        { requestId: rid() },
      );
      expect(await calibration.targetOf("extract_recovery", 1)).toEqual({ recall: 0.95, miss: null, precision: null });
      // Another point version has its own.
      expect(await calibration.targetOf("extract_injection", 1)).toBeNull();

      const invalid = { code: "invalid_argument" };
      await expect(
        calibration.setTarget(
          "extract_recovery",
          9,
          { recall: 0.9, miss: null, precision: null },
          { requestId: rid() },
        ),
      ).rejects.toMatchObject(invalid);
      await expect(
        calibration.setTarget(
          "extract_recovery",
          1,
          { recall: null, miss: null, precision: null },
          { requestId: rid() },
        ),
      ).rejects.toMatchObject(invalid);
      await expect(
        calibration.setTarget(
          "extract_recovery",
          1,
          { recall: 1.2, miss: null, precision: null },
          { requestId: rid() },
        ),
      ).rejects.toMatchObject(invalid);
      expect((await rowsOf(db, "select decision_id from policy.threshold_targets")).length).toBe(2);
    }));
});

describe("suspensions and the drift card", { timeout: TIMEOUT }, () => {
  it("suspend then resume writes a rung_resume decision and lifts the suspension; a resume with nothing open is not_suspended", () =>
    withCalibration(async ({ db, calibration, pipeline }) => {
      const report = await calibration.writeReport("extract_triage", 3, { ...REPORT, drift: true });
      await expect(calibration.resume("extract_triage", 3, { requestId: rid() })).rejects.toMatchObject({
        code: "not_suspended",
      });
      expect(await pipeline.suspensions()).toEqual([]);

      const suspension = await calibration.suspend("extract_triage", 3, report);
      // One open suspension for a point version: a second run's suspend returns it.
      expect(await calibration.suspend("extract_triage", 3, report)).toBe(suspension);
      expect(await pipeline.suspensions()).toEqual([{ point: "extract_triage", version: 3 }]);
      expect(await calibration.suspensions()).toEqual([{ id: suspension, point: "extract_triage", version: 3 }]);

      const ruling = await calibration.resume("extract_triage", 3, { requestId: rid() });
      const decision = await decisionOf(db, ruling);
      expect(decision).toMatchObject({ kind: "rung_resume", target_kind: "suspension", target_id: suspension });
      expect(RungResumeDetails.parse(decision.details)).toEqual({ point: "extract_triage", version: 3, suspension });
      expect(
        one(
          await rowsOf<{ lifted: boolean; lift: string }>(
            db,
            "select lifted_at is not null as lifted, lift_decision_id as lift from policy.rung_suspensions where id = $1",
            [suspension],
          ),
        ),
      ).toEqual({
        lifted: true,
        lift: ruling,
      });
      expect(await pipeline.suspensions()).toEqual([]);
      await expect(calibration.resume("extract_triage", 3, { requestId: rid() })).rejects.toMatchObject({
        code: "not_suspended",
      });
      // A later drift suspends it again, as a new row.
      expect(await calibration.suspend("extract_triage", 3, report)).not.toBe(suspension);
      expect(await pipeline.suspensions()).toEqual([{ point: "extract_triage", version: 3 }]);
    }));

  it("raiseDrift raises one calibration_drift card for a point version: a second run with one pending raises none", () =>
    withCalibration(async ({ db, calibration }) => {
      const first = await calibration.writeReport("extract_recovery", 1, { ...REPORT, drift: true });
      const second = await calibration.writeReport("extract_recovery", 1, { ...REPORT, drift: true });
      expect(await calibration.raiseDrift("extract_recovery", 1, first)).toEqual({ raised: true });
      expect(await calibration.raiseDrift("extract_recovery", 1, second)).toEqual({ raised: false });
      const cards = await rowsOf<{
        kind: string;
        created_by: string;
        options: string[];
        target_kind: string;
        target_id: string;
        case_key: string;
        body: boolean;
      }>(
        db,
        "select kind, created_by, options, target_kind, target_id, case_key, body_enc is not null as body from ledger.cards where kind = 'calibration_drift'",
      );
      expect(cards).toEqual([
        {
          kind: "calibration_drift",
          created_by: "system:calibration",
          options: ["seen"],
          target_kind: "report",
          target_id: first,
          case_key: "drift:extract_recovery@1",
          body: false,
        },
      ]);
      // The control: another point version raises its own.
      const triage = await calibration.writeReport("extract_triage", 3, { ...REPORT, drift: true });
      expect(await calibration.raiseDrift("extract_triage", 3, triage)).toEqual({ raised: true });
      expect((await rowsOf(db, "select id from ledger.cards where kind = 'calibration_drift'")).length).toBe(2);
    }));
});

describe("the owner's verdicts", { timeout: TIMEOUT }, () => {
  it("recordVerdict seals the verdict and the probability under the call's compartments, and keeps the rest in clear", () =>
    withCalibration(async ({ db, calibration }) => {
      const p = 0.734261;
      const callId = testId("mcl");
      const id = await calibration.recordVerdict(
        verdict({ p, band: bandOf(p), weight: 2.5, callId, verdict: "no", compartments: ["own"] }),
      );
      const row = one(
        await rowsOf<Record<string, unknown>>(
          db,
          "select created_by, compartments, point, version, call_id, evidence_id, source, band, weight::text as weight, deliberate, hurried, tainted_at, body_enc from ledger.point_verdicts where id = $1",
          [id],
        ),
      );
      expect(row).toMatchObject({
        created_by: "owner",
        compartments: ["own"],
        point: "extract_recovery",
        version: 1,
        call_id: callId,
        evidence_id: null,
        source: "review",
        band: 3,
        weight: "2.5",
        deliberate: true,
        hurried: false,
        tainted_at: null,
      });
      expect(
        JSON.parse(
          openUnder(
            db.keys,
            ["own"],
            { table: "ledger.point_verdicts", id, column: "body_enc" },
            row.body_enc as never,
          ),
        ),
      ).toEqual({ verdict: "no", p });
      // No column of the row holds the probability's digits in clear.
      const text = one(
        await rowsOf<{ text: string }>(
          db,
          "select to_jsonb(v)::text as text from ledger.point_verdicts v where id = $1",
          [id],
        ),
      ).text;
      expect(text).not.toContain("734261");
      // A repeated request id writes nothing and answers the first.
      const requestId = rid();
      const once = await calibration.recordVerdict(verdict({ requestId }));
      expect(await calibration.recordVerdict(verdict({ requestId, verdict: "no" }))).toBe(once);
      expect((await rowsOf(db, "select id from ledger.point_verdicts")).length).toBe(2);
    }));

  it("no probability or verdict body is in clear in any column: the plaintext scan finds none", () =>
    withCalibration(async ({ db, calibration }) => {
      const p = 0.734261;
      await calibration.recordVerdict(verdict({ p, band: bandOf(p) }));
      const a = sha256Hex("scan a");
      const b = sha256Hex("scan b");
      const rawOutput = JSON.stringify({ same_person: 0.618033, note: "Wilhelmina Saltmarsh-Canary" });
      await calibration.decisionCalls().save({
        key: {
          point: "identity_rank",
          version: 1,
          promptId: "jev_same_person",
          promptVersion: "1",
          subject: `pair:${[a, b].sort().join(":")}`,
          inputHash: sha256Hex("scan input"),
        },
        rawOutput,
        outputHash: sha256Hex(rawOutput),
        refs: [a, b],
        compartments: ["own"],
        modelId: DECIDE_MODEL,
      });
      expect(await scanForPlaintext(db.urls.admin, ["734261", "618033", "Wilhelmina Saltmarsh-Canary"])).toEqual([]);
      // The positive control: a report's bands are clear, and a word in them is found.
      await calibration.writeReport("extract_recovery", 1, { ...REPORT, bands: ["618033"] });
      expect(await scanForPlaintext(db.urls.admin, ["618033"])).toEqual([
        { table: "ledger.calibration_reports", column: "bands" },
      ]);
    }));

  it("only deliberate verdicts are counted: a hurried review answer and a batch card answer are stored and not counted", () =>
    withCalibration(async ({ db, calibration }) => {
      await calibration.recordVerdict(verdict({ p: 0.91, band: bandOf(0.91), verdict: "yes", weight: 3 }));
      const hurried = await calibration.recordVerdict(
        verdict({ p: 0.2, band: bandOf(0.2), verdict: "no", hurried: true, deliberate: false }),
      );
      const batch = await calibration.recordVerdict(
        verdict({ p: 0.4, band: bandOf(0.4), verdict: "no", source: "card", deliberate: false }),
      );
      // A verdict on an item no longer stored is not counted either.
      const gone = await calibration.recordVerdict(verdict({ p: 0.6, band: bandOf(0.6), evidenceId: "f".repeat(64) }));
      expect(
        (
          await rowsOf<{ id: string; deliberate: boolean; hurried: boolean }>(
            db,
            "select id, deliberate, hurried from ledger.point_verdicts where id = any($1) order by id",
            [[hurried, batch, gone]],
          )
        ).map((row) => [row.id, row.deliberate, row.hurried]),
      ).toEqual(
        [
          [hurried, false, true],
          [batch, false, false],
          [gone, true, false],
        ].sort((x, y) => ((x[0] as string) < (y[0] as string) ? -1 : 1)),
      );

      const counted = await calibration.countedVerdicts("extract_recovery", 1);
      expect(counted.map(({ p, verdict: answer, weight }) => ({ p, verdict: answer, weight }))).toEqual([
        { p: 0.91, verdict: "yes", weight: 3 },
      ]);
      expect(counted[0]?.at).toBeInstanceOf(Date);
      expect(await calibration.countedVerdicts("extract_recovery", 2)).toEqual([]);

      // Hurried and deliberate at once, a probability outside 0 to 1, and a weight below 1 are refused.
      const invalid = { code: "invalid_argument" };
      await expect(calibration.recordVerdict(verdict({ hurried: true, deliberate: true }))).rejects.toMatchObject(
        invalid,
      );
      await expect(calibration.recordVerdict(verdict({ p: 1.5 }))).rejects.toMatchObject(invalid);
      await expect(calibration.recordVerdict(verdict({ weight: 0.5 }))).rejects.toMatchObject(invalid);
    }));
});

describe("the review's sample and its inputs", { timeout: TIMEOUT }, () => {
  it("reviewSample skips calls with a verdict for the point version and draws across the bands, each weighted by its band's whole population, reviewed calls included, over the number drawn", () =>
    withPipeline(async (store) => {
      const owner = createAdmin({ url: store.db.urls.admin, keys: store.db.keys, log: recordingLogger().log });
      try {
        const calibration = owner.calibration;
        const id = await stored(
          store.writer,
          store.accounts.personalMail,
          message("gm-j2-review", "2026-09-05T09:00:00Z"),
        );
        const hashOf = new Map<string, string>();
        const save = async (p: unknown, n: number, prompt = "jev_recovery"): Promise<string> => {
          const hash = sha256Hex(`review input ${n}`);
          const call = await saveCall(store, id, prompt, { account_recovery: p }, hash);
          hashOf.set(call, hash);
          return call;
        };
        // Band 0 three, band 1 one, band 2 one, band 3 two, band 5 one.
        for (const [n, p] of [0.01, 0.02, 0.03, 0.1, 0.3, 0.6, 0.7, 0.99].entries()) await save(p, n);
        // Band 4's one call has a verdict for this point version: it is not drawn. A verdict for
        // another version does not skip a call (the 0.3 above has one).
        const answered = await save(0.9, 20);
        await calibration.recordVerdict(verdict({ callId: answered, evidenceId: id, p: 0.9, band: 4 }));
        // Band 0's fourth call has one too: it is not drawn, and it counts in its band's population.
        const reviewed = await save(0.04, 21);
        await calibration.recordVerdict(verdict({ callId: reviewed, evidenceId: id, p: 0.04, band: 0 }));
        const third = [...hashOf].find(([, hash]) => hash === sha256Hex("review input 4"))?.[0] ?? "";
        await calibration.recordVerdict(verdict({ callId: third, evidenceId: id, version: 2, p: 0.3, band: 2 }));
        // A rejection and another prompt's call are not drawn.
        await save("rejected", 30);
        await save(0.5, 31, "jev_record");

        const five = await calibration.reviewSample(
          "extract_recovery",
          1,
          { id: "jev_recovery", version: "1" },
          "account_recovery",
          5,
        );
        expect(five.map((call) => [call.band, call.weight]).sort()).toEqual([
          [0, 4],
          [1, 1],
          [2, 1],
          [3, 2],
          [5, 1],
        ]);
        expect(five.map((call) => call.callId)).not.toContain(answered);
        expect(five.map((call) => call.callId)).not.toContain(reviewed);
        for (const call of five)
          expect(call).toMatchObject({ evidenceId: id, compartments: ["own"], band: bandOf(call.p) });

        const all = await calibration.reviewSample(
          "extract_recovery",
          1,
          { id: "jev_recovery", version: "1" },
          "account_recovery",
          30,
        );
        expect(all).toHaveLength(8);
        expect(new Set(all.map((call) => call.callId)).size).toBe(8);
        for (const call of all) expect(call.weight, call.callId).toBe(call.band === 0 ? 4 / 3 : 1);
        expect(all.map((call) => call.callId)).not.toContain(answered);
        expect(all.map((call) => call.callId)).not.toContain(reviewed);

        // "Review, inputs": the fingerprint a call was saved under is that of its input's hash, and
        // of no other.
        for (const call of all) {
          expect(calibration.sameInput(call.inputFp, hashOf.get(call.callId) ?? ""), call.callId).toBe(true);
          expect(calibration.sameInput(call.inputFp, sha256Hex("a later revision's input")), call.callId).toBe(false);
        }
        await expect(
          calibration.reviewSample("extract_recovery", 1, { id: "jev_recovery", version: "1" }, "account_recovery", 0),
        ).rejects.toMatchObject({ code: "invalid_argument" });
      } finally {
        await owner.close();
      }
    }));
});

describe("a lane retry on an item Jev laned", { timeout: TIMEOUT }, () => {
  it("retry --lane writes one deliberate lane_retry verdict: correspondence yes, transaction and skip no; none with no saved jev_screen call, none without a lane, none when the owner had set the lane, none for an outbound message or one with no text", () =>
    withPipeline(async (store) => {
      const owner = createAdmin({ url: store.db.urls.admin, keys: store.db.keys, log: recordingLogger().log });
      try {
        const { personalMail } = store.accounts;
        const text = { text: "The scales were checked this morning and read true." };
        const fixtures = {
          yes: message("gm-j2-lane-yes", "2026-09-05T09:00:00Z", text),
          transaction: message("gm-j2-lane-transaction", "2026-09-05T09:10:00Z", text),
          skip: message("gm-j2-lane-skip", "2026-09-05T09:20:00Z", text),
          none: message("gm-j2-lane-none", "2026-09-05T09:30:00Z", text),
          noLane: message("gm-j2-lane-no-lane", "2026-09-05T09:40:00Z", text),
          owned: message("gm-j2-lane-owned", "2026-09-05T09:50:00Z", text),
          // No text: triage has nothing for the decide model to have read.
          empty: message("gm-j2-lane-empty", "2026-09-05T10:00:00Z"),
          // Sent by the owner.
          outbound: mail({
            id: "gm-j2-lane-outbound",
            threadId: "thread-j2-lane-outbound",
            at: "2026-09-05T10:10:00Z",
            from: ME,
            to: [RHEA],
            subject: "Scales",
            labels: ["SENT"],
            ...text,
          }),
        };
        const ids: Record<string, string> = {};
        const messages: Record<string, string> = {};
        for (const [name, fixture] of Object.entries(fixtures)) {
          ids[name] = await stored(store.writer, personalMail, fixture);
          messages[name] = one(
            await rowsOf<{ id: string }>(store.db, "select id from knowledge.messages where evidence_id = $1", [
              ids[name],
            ]),
          ).id;
        }
        const screen = (name: string, p: number): Promise<string> =>
          saveCall(
            store,
            ids[name] ?? "",
            "jev_screen",
            { human_written: p, injection: 0.01, sensitivity: 0.01 },
            sha256Hex(`screen ${name}`),
          );
        const calls = {
          yes: await screen("yes", 0.31),
          transaction: await screen("transaction", 0.12),
          skip: await screen("skip", 0.04),
        };
        for (const name of ["noLane", "empty", "outbound"]) await screen(name, 0.6);
        // The owner set this one's lane before any call was saved; then the decide model's call was saved.
        await owner.extraction.retry({ messageId: messages.owned ?? "" } as never, { lane: "skip" });
        await screen("owned", 0.2);

        const verdicts = async () =>
          rowsOf<{
            id: string;
            call_id: string;
            evidence_id: string;
            point: string;
            version: number;
            source: string;
            band: number;
            weight: string;
            deliberate: boolean;
            hurried: boolean;
            compartments: string[];
            body_enc: unknown;
          }>(
            store.db,
            "select id, call_id, evidence_id, point, version, source, band, weight::text as weight, deliberate, hurried, compartments, body_enc from ledger.point_verdicts",
          );
        expect(await verdicts()).toEqual([]);

        const retry = (name: string, lane?: "correspondence" | "transaction" | "skip") =>
          owner.extraction.retry({ messageId: messages[name] ?? "" } as never, lane === undefined ? {} : { lane });
        await retry("yes", "correspondence");
        await retry("transaction", "transaction");
        await retry("skip", "skip");
        await retry("none", "correspondence");
        await retry("noLane");
        await retry("owned", "correspondence");
        await retry("empty", "correspondence");
        await retry("outbound", "transaction");

        const written = await verdicts();
        const expected = [
          { name: "yes", p: 0.31, answer: "yes" },
          { name: "transaction", p: 0.12, answer: "no" },
          { name: "skip", p: 0.04, answer: "no" },
        ];
        expect(written.map((row) => row.evidence_id).sort()).toEqual(expected.map(({ name }) => ids[name]).sort());
        for (const { name, p, answer } of expected) {
          const row = written.find((one) => one.evidence_id === ids[name]);
          expect(row, name).toMatchObject({
            call_id: calls[name as keyof typeof calls],
            point: "extract_triage",
            // The current definition's version of extract_triage.
            version: 5,
            source: "lane_retry",
            band: bandOf(p),
            weight: "1",
            deliberate: true,
            hurried: false,
            compartments: ["own"],
          });
          expect(
            JSON.parse(
              openUnder(
                store.db.keys,
                ["own"],
                { table: "ledger.point_verdicts", id: row?.id ?? "", column: "body_enc" },
                row?.body_enc as never,
              ),
            ),
            name,
          ).toEqual({ verdict: answer, p });
        }
        // Each is counted, though the retry superseded the call it names: kept, and no longer
        // replayed.
        expect((await owner.calibration.countedVerdicts("extract_triage", 5)).map((one) => one.verdict).sort()).toEqual(
          ["no", "no", "yes"],
        );
        expect(
          await rowsOf(
            store.db,
            "select superseded_at is not null as superseded from vault.model_calls where id = any($1)",
            [Object.values(calls)],
          ),
        ).toEqual(Object.values(calls).map(() => ({ superseded: true })));
      } finally {
        await owner.close();
      }
    }));

  it("while extract_triage@5's rung 1 is suspended, a lane retry writes no verdict", () =>
    withPipeline(async (store) => {
      const owner = createAdmin({ url: store.db.urls.admin, keys: store.db.keys, log: recordingLogger().log });
      try {
        const { personalMail } = store.accounts;
        const text = { text: "The scales were checked this morning and read true." };
        const first = message("gm-j2-lane-suspended", "2026-09-05T09:00:00Z", text);
        const second = message("gm-j2-lane-resumed", "2026-09-05T09:10:00Z", text);
        const messageOf = async (fixture: MailFixture): Promise<{ evidence: string; id: string }> => {
          const evidence = await stored(store.writer, personalMail, fixture);
          return {
            evidence,
            id: one(
              await rowsOf<{ id: string }>(store.db, "select id from knowledge.messages where evidence_id = $1", [
                evidence,
              ]),
            ).id,
          };
        };
        const suspended = await messageOf(first);
        const resumed = await messageOf(second);
        for (const { evidence } of [suspended, resumed])
          await saveCall(
            store,
            evidence,
            "jev_screen",
            { human_written: 0.3, injection: 0.01, sensitivity: 0.01 },
            sha256Hex(`screen ${evidence}`),
          );
        const report = await owner.calibration.writeReport("extract_triage", 5, { ...REPORT, drift: true });
        await owner.calibration.suspend("extract_triage", 5, report);

        await owner.extraction.retry({ messageId: suspended.id } as never, { lane: "correspondence" });
        expect(await rowsOf(store.db, "select id from ledger.point_verdicts")).toEqual([]);
        // The positive control: once the owner resumes it, the same retry writes its verdict.
        await owner.calibration.resume("extract_triage", 5, { requestId: rid() });
        await owner.extraction.retry({ messageId: resumed.id } as never, { lane: "correspondence" });
        expect(
          (await rowsOf<{ evidence_id: string }>(store.db, "select evidence_id from ledger.point_verdicts")).map(
            (row) => row.evidence_id,
          ),
        ).toEqual([resumed.evidence]);
      } finally {
        await owner.close();
      }
    }));
});

describe("the identity sweep's saved calls", { timeout: TIMEOUT }, () => {
  it("decisionCalls().save then find round-trips a pair call, and its stored input_fp is the keyed fingerprint, never the raw hash", () =>
    withCalibration(async ({ db, calibration }) => {
      const a = sha256Hex("round a");
      const b = sha256Hex("round b");
      const rawOutput = JSON.stringify({ same_person: 0.42 });
      const record: KeyedCallRecord = {
        key: {
          point: "identity_rank",
          version: 1,
          promptId: "jev_same_person",
          promptVersion: "1",
          subject: `pair:${[a, b].sort().join(":")}`,
          inputHash: sha256Hex("round input"),
        },
        rawOutput,
        outputHash: sha256Hex(rawOutput),
        refs: [b, a],
        compartments: ["own"],
        modelId: DECIDE_MODEL,
      };
      const store = calibration.decisionCalls();
      expect(await store.find(record.key)).toBeNull();
      await store.save(record);
      expect(await store.find(record.key)).toEqual({ ...record, refs: [a, b].sort() });
      const row = one(
        await rowsOf<{ input_fp: string; refs: string[] }>(db, "select input_fp, refs from vault.decision_calls"),
      );
      expect(row.input_fp).toBe(fingerprint(db.keys, "model_input", record.key.inputHash));
      expect(row.input_fp).not.toBe(record.key.inputHash);
      // A key whose input changed is a miss; a second save of the same key writes nothing.
      expect(await store.find({ ...record.key, inputHash: sha256Hex("another input") })).toBeNull();
      await store.save(record);
      expect((await rowsOf(db, "select id from vault.decision_calls")).length).toBe(1);
    }));
});

describe("pi agent-records release", { timeout: TIMEOUT }, () => {
  it("releaseRecord on a flagged finding writes record_release, clears flagged_at and sets the item's release, waiting; an unflagged or unknown one is not_found", () =>
    withAgents(async (world) => {
      const { record, evidence } = await world.record("alpha");
      const { record: unflagged } = await world.record("alpha");
      // The record screen's quarantine, as the pipeline sets it.
      await queryAs(world.db.urls.pipeline, "update ledger.agent_writes set flagged_at = now() where id = $1", [
        record,
      ]);
      const calibration = world.admin.calibration;
      await expect(calibration.releaseRecord(unflagged, { requestId: rid() })).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(calibration.releaseRecord(testId("rec"), { requestId: rid() })).rejects.toMatchObject({
        code: "not_found",
      });
      expect(await rowsOf(world.db, "select id from knowledge.owner_decisions where kind = 'record_release'")).toEqual(
        [],
      );

      const requestId = rid();
      const ruling = await calibration.releaseRecord(record, { requestId });
      const decision = await decisionOf(world.db, ruling);
      expect(decision).toMatchObject({
        kind: "record_release",
        target_kind: "agent_record",
        target_id: record,
        details: {},
      });
      expect(
        one(
          await rowsOf<{ flagged: boolean }>(
            world.db,
            "select flagged_at is not null as flagged from ledger.agent_writes where id = $1",
            [record],
          ),
        ).flagged,
      ).toBe(false);
      const status = one(
        await rowsOf<{ waiting: boolean; withheld: boolean; compartments: string[]; facts_enc: unknown }>(
          world.db,
          "select waiting, withheld, compartments, facts_enc from vault.pipeline_items where evidence_id = $1",
          [evidence],
        ),
      );
      expect(status).toMatchObject({ waiting: true, withheld: false });
      expect(
        JSON.parse(openUnder(world.db.keys, status.compartments, statusAt(evidence), status.facts_enc as never)),
      ).toMatchObject({ override: true, status: "waiting", lane: "agent" });
      // A replay of the same request id comes back with the first ruling and writes nothing more.
      expect(await calibration.releaseRecord(record, { requestId })).toBe(ruling);
      expect(
        (await rowsOf(world.db, "select id from knowledge.owner_decisions where kind = 'record_release'")).length,
      ).toBe(1);
      // Released once: the flag is gone, so a second release under a new request id finds nothing.
      await expect(calibration.releaseRecord(record, { requestId: rid() })).rejects.toMatchObject({
        code: "not_found",
      });
    }));
});

describe("erasure and deletion at the source remove the pair calls that rested on them", {
  timeout: TIMEOUT,
}, () => {
  it("after erasePerson no pair call holds the person's fingerprint, and the verdicts naming a removed call or a removed item are tainted", () =>
    withPipeline(async (store) =>
      withOwner(store, async (owner) => {
        const { db } = store;
        expect(await ingestMail(store.writer, store.accounts.personalMail, MAIL.solo)).toBe("stored");
        const soloEvidence = one(
          await rowsOf<{ evidence_id: string }>(db, "select evidence_id from knowledge.messages"),
        ).evidence_id;
        const solo = addressFp(db, SOLO.address);
        const rhea = addressFp(db, RHEA.address);
        const canary = addressFp(db, CANARY_PERSON.address);
        const person = one(
          await rowsOf<{ entity_id: string }>(db, "select entity_id from knowledge.accounts where value_fp = $1", [
            solo,
          ]),
        ).entity_id;
        const onSolo = await pairCall(db, owner.calibration, solo, rhea, [solo, rhea]);
        const other = await pairCall(db, owner.calibration, rhea, canary, [rhea, canary]);
        const onSoloVerdict = await owner.calibration.recordVerdict(
          verdict({ point: "identity_rank", callId: onSolo, source: "card" }),
        );
        const otherVerdict = await owner.calibration.recordVerdict(
          verdict({ point: "identity_rank", callId: other, source: "card" }),
        );
        const itemVerdict = await owner.calibration.recordVerdict(
          verdict({ callId: testId("mcl"), evidenceId: soloEvidence }),
        );

        expect((await owner.erasure.erasePerson(person as EntityId, { requestId: rid() })).items).toBe(1);
        expect(await rowsOf(db, "select id from vault.decision_calls where refs @> array[$1]", [solo])).toEqual([]);
        expect(await callIds(db)).toEqual([other]);
        const tainted = await rowsOf<{ id: string; tainted: boolean; body: boolean }>(
          db,
          "select id, tainted_at is not null as tainted, body_enc is not null as body from ledger.point_verdicts order by id",
        );
        expect(Object.fromEntries(tainted.map((row) => [row.id, { tainted: row.tainted, body: row.body }]))).toEqual({
          [onSoloVerdict]: { tainted: true, body: false },
          [itemVerdict]: { tainted: true, body: false },
          [otherVerdict]: { tainted: false, body: true },
        });
        expect(await owner.calibration.countedVerdicts("identity_rank", 1)).toHaveLength(1);
        expect(await owner.calibration.countedVerdicts("extract_recovery", 1)).toEqual([]);
      }),
    ));

  it("after a deletion at the source that removes a person, no pair call names that person, nor the removed item's alias", () =>
    withPipeline(async (store) =>
      withOwner(store, async (owner) => {
        const { db } = store;
        const { personalMail } = store.accounts;
        expect(await ingestMail(store.writer, personalMail, MAIL.solo)).toBe("stored");
        const soloEvidence = one(
          await rowsOf<{ evidence_id: string }>(db, "select evidence_id from knowledge.messages"),
        ).evidence_id;
        // The evidence id of Solo's alias: the one message that named Solo.
        expect(
          one(await rowsOf<{ evidence_id: string }>(db, "select distinct evidence_id from knowledge.aliases"))
            .evidence_id,
        ).toBe(soloEvidence);
        const solo = addressFp(db, SOLO.address);
        const rhea = addressFp(db, RHEA.address);
        const canary = addressFp(db, CANARY_PERSON.address);
        await pairCall(db, owner.calibration, solo, rhea, [solo, rhea]);
        await pairCall(db, owner.calibration, rhea, canary, [rhea, canary, soloEvidence]);
        const other = await pairCall(db, owner.calibration, canary, rhea, [canary, rhea]);
        expect(await callIds(db)).toHaveLength(3);

        expect(
          await store.writer.applyDeletion(personalMail, {
            sourceAccount: personalMail.id,
            sourceItemId: mailSourceId(MAIL.solo),
          } as SourceDeletion),
        ).toEqual({ recordsRemoved: 0 });
        // Solo is gone, and so is every pair call that rested on Solo or on Solo's message.
        expect(await rowsOf(db, "select entity_id from knowledge.accounts where value_fp = $1", [solo])).toEqual([]);
        expect(await callIds(db)).toEqual([other]);
      }),
    ));

  it("after the deletion of one message whose sender survives through another, no pair call that rested on it is left", () =>
    withPipeline(async (store) =>
      withOwner(store, async (owner) => {
        const { db } = store;
        const { personalMail } = store.accounts;
        const again = mail({
          id: "gm-j2-quentin-again",
          threadId: "thread-j2-quentin-again",
          at: "2026-09-04T08:15:00Z",
          from: QUENTIN,
          to: [ME],
          subject: "The rota, again",
          labels: ["INBOX"],
        });
        expect(await ingestMail(store.writer, personalMail, MAIL.fromQuentin)).toBe("stored");
        expect(await ingestMail(store.writer, personalMail, again)).toBe("stored");
        const quentin = addressFp(db, QUENTIN.address);
        const rhea = addressFp(db, RHEA.address);
        const canary = addressFp(db, CANARY_PERSON.address);
        await pairCall(db, owner.calibration, quentin, rhea, [quentin, rhea]);
        const other = await pairCall(db, owner.calibration, rhea, canary, [rhea, canary]);

        await store.writer.applyDeletion(personalMail, {
          sourceAccount: personalMail.id,
          sourceItemId: mailSourceId(MAIL.fromQuentin),
        } as SourceDeletion);
        // Quentin survives through the other message.
        expect(
          (await rowsOf(db, "select entity_id from knowledge.accounts where value_fp = $1", [quentin])).length,
        ).toBeGreaterThan(0);
        expect((await rowsOf(db, "select id from knowledge.messages where sender_fp = $1", [quentin])).length).toBe(1);
        // The pair call whose counts rested on the deleted message is gone; the other is kept.
        expect(await callIds(db)).toEqual([other]);
      }),
    ));
});
