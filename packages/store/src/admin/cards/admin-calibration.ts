import type { EvidenceId } from "@intelligence/contracts";
import {
  type AgentRecordId,
  CARD_OPTIONS,
  CardId,
  DECISION_POINTS,
  isCoded,
  type KeyedCallStore,
  type MessageTriageRow,
  type OpenedItem,
  type OpenedRecord,
  ownLabel,
  POINT_THRESHOLDS,
  type PointVerdict,
  type RulingId,
  type ThresholdGrant,
  type ThresholdName,
  thresholdPair,
} from "@intelligence/contracts/personal";
import { driftCase } from "../../cards/case-keys.ts";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import type { Query } from "../../core/db.ts";
import { decisionCallStore } from "../../core/decision-calls.ts";
import { fingerprint } from "../../core/fingerprint.ts";
import { newId } from "../../core/ids.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { lockRows, raiseCard } from "../../core/queue.ts";
import type { Sealed } from "../../core/seal.ts";
import { openUnder } from "../../core/seal.ts";
import { latestGrants } from "../../core/thresholds.ts";
import { bandOf, type VerdictInput, verdictAt, writeVerdict } from "../../core/verdicts.ts";
import { triageRowOf } from "../../pipeline/pipeline-due.ts";
import { openItem, openRecordItem } from "../../pipeline/pipeline-open.ts";
import { repeatedDecision } from "../admin-base.ts";
import { setRecordWaiting, tryExtractLock } from "../extraction/admin-extraction.ts";

// Calibration, the store's side, as pi_admin. Admin holds one of these as `admin.calibration`. The
// arithmetic is the ladder's (`calibrate.ts`); this reads and writes the rows. Every owner decision
// goes through the queue's writeDecision, and every method that writes a ledger row begins its
// transaction with lockRows. Nothing here returns or logs a probability to a listing: the review's
// probability is for drawing and weighting, never shown.

// Words the owner's commands take: a point version that has thresholds, and a name it has.
const boundsOf = (point: string, version: number, name: string) =>
  POINT_THRESHOLDS[`${point}@${version}`]?.[name as ThresholdName];

// Threshold decisions carry no content: they are the owner's, under their own compartment.
const OWN = ownLabel();

// A saved call drawn for review: its item, the keyed fingerprint of the input the model was
// shown, and its band and weight. `p` is for the caller's arithmetic, never for the screen.
export type ReviewCall = {
  callId: string;
  evidenceId: string;
  compartments: string[];
  inputFp: string;
  p: number;
  band: number;
  weight: number;
};

// A counted verdict, as the ladder's ScoredVerdict, with its time for the last 28 days.
type CountedVerdict = { p: number; verdict: PointVerdict; weight: number; at: Date };

export type ReportRow = {
  n: number;
  bands: unknown[];
  precision: number | null;
  recall: number | null;
  agreement: number | null;
  agreement28d: number | null;
  intervals: Record<string, unknown>;
  drift: boolean;
  insufficient: boolean;
};

type ThresholdTarget = { recall: number | null; miss: number | null; precision: number | null };

const unit = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= 1;
const num = (value: string | null): number | null => (value === null ? null : Number(value));

// -------------------------------------------------------------------------------------------
// Verdicts
// -------------------------------------------------------------------------------------------

// One verdict, its answer and the call's probability sealed under the call's compartments. A
// repeated request id writes nothing. A hurried answer is stored and never deliberate.
export function recordVerdict(admin: AdminContext, input: VerdictInput): Promise<string> {
  if (!unit(input.p) || !(input.weight >= 1) || input.band < 0 || input.band > 5 || (input.hurried && input.deliberate))
    return Promise.reject(new AdminError("invalid_argument"));
  const now = admin.now();
  return admin.transaction(async (query) => {
    await lockRows(query, []);
    return writeVerdict(query, admin.keys, input, now);
  });
}

// The saved calls of one prompt with no verdict for this point version, drawn in the six bands
// as near equally as the bands allow, at most `sample`. `field` is the question's output key.
// A call whose output is a rejection is not drawn. Each drawn call carries its band's weight:
// the number of the version's calls in its band, reviewed or not, over the number drawn from it.
export function reviewSample(
  admin: AdminContext,
  point: string,
  version: number,
  prompt: { id: string; version: string },
  field: string,
  sample: number,
): Promise<ReviewCall[]> {
  if (!Number.isSafeInteger(sample) || sample < 1 || sample > 500)
    return Promise.reject(new AdminError("invalid_argument"));
  return admin.transaction(async (query) => {
    const rows = await query<{
      id: string;
      evidence_id: string;
      compartments: string[];
      input_fp: string;
      output_enc: Sealed;
      reviewed: boolean;
    }>(
      `select c.id, c.evidence_id, c.compartments, c.input_fp, c.output_enc,
         exists (select 1 from ledger.point_verdicts v where v.call_id = c.id and v.point = $3 and v.version = $4) as reviewed
       from vault.model_calls c
       where c.prompt_id = $1 and c.prompt_version = $2
       order by c.id collate "C"`,
      [prompt.id, prompt.version, point, version],
    );
    const population = [0, 0, 0, 0, 0, 0];
    const bands: ReviewCall[][] = [[], [], [], [], [], []];
    for (const row of rows) {
      let p: unknown;
      try {
        p = (
          JSON.parse(
            openUnder(
              admin.keys,
              row.compartments,
              { table: "vault.model_calls", id: row.id, column: "output_enc" },
              row.output_enc,
            ),
          ) as Record<string, unknown>
        )[field];
      } catch {
        continue;
      }
      if (typeof p !== "number" || !unit(p)) continue;
      const band = bandOf(p);
      population[band] = (population[band] ?? 0) + 1;
      if (row.reviewed) continue;
      bands[band]?.push({
        callId: row.id,
        evidenceId: row.evidence_id,
        compartments: row.compartments,
        inputFp: row.input_fp,
        p,
        band,
        weight: 1,
      });
    }
    const shuffled = bands.map((list) =>
      list
        .map((value) => ({ value, key: Math.random() }))
        .sort((a, b) => a.key - b.key)
        .map(({ value }) => value),
    );
    const drawn: ReviewCall[][] = [[], [], [], [], [], []];
    let left = sample;
    while (left > 0 && shuffled.some((list, band) => list.length > (drawn[band]?.length ?? 0))) {
      for (let band = 0; band < 6 && left > 0; band += 1) {
        const next = shuffled[band]?.[drawn[band]?.length ?? 0];
        if (next === undefined) continue;
        drawn[band]?.push(next);
        left -= 1;
      }
    }
    return drawn.flatMap((list, band) =>
      list.map((one) => ({ ...one, weight: (population[band] ?? 0) / list.length })),
    );
  });
}

// Whether a re-rendered input is the one the call was shown: its hash's keyed fingerprint.
export function sameInput(admin: AdminContext, inputFp: string, inputHash: string): boolean {
  return fingerprint(admin.keys, "model_input", inputHash) === inputFp;
}

// The stored item a call was about, opened for the review, with what triage reads of it; a
// finding opened as an agent record. Null when it can no longer be opened.
export function openForReview(
  admin: AdminContext,
  evidenceId: string,
): Promise<
  { kind: "message"; item: OpenedItem; triage: MessageTriageRow } | { kind: "record"; record: OpenedRecord } | null
> {
  return admin.transaction(async (query) => {
    const tx = { query, keys: admin.keys };
    try {
      const opened = await openItem(tx, evidenceId as EvidenceId);
      if (opened !== null) {
        const triage = await triageRowOf(tx, evidenceId);
        return triage === null ? null : { kind: "message" as const, item: opened.item, triage };
      }
      const record = await openRecordItem(tx, evidenceId as EvidenceId);
      return record === null ? null : { kind: "record" as const, record: record.record };
    } catch (error) {
      // A compartment the key file lacks, or an erased payload: not opened.
      if (isCoded(error, "unknown_compartment") || isCoded(error, "open_failed")) return null;
      throw error;
    }
  });
}

// The point versions with a verdict, for `pi ladder calibrate`.
export function pointsWithVerdicts(admin: AdminContext): Promise<{ point: string; version: number }[]> {
  return admin.transaction((query) =>
    query<{ point: string; version: number }>(
      "select distinct point, version from ledger.point_verdicts order by point, version",
    ),
  );
}

export function countedVerdicts(admin: AdminContext, point: string, version: number): Promise<CountedVerdict[]> {
  return admin.transaction(async (query) => {
    const rows = await query<{
      id: string;
      compartments: string[];
      body_enc: Sealed;
      weight: string;
      created_at: Date;
    }>(
      `select v.id, v.compartments, v.body_enc, v.weight::text as weight, v.created_at from ledger.point_verdicts v
       where v.point = $1 and v.version = $2 and v.deliberate and v.tainted_at is null and v.body_enc is not null
         and (v.evidence_id is null or exists (select 1 from vault.evidence_items e where e.id = v.evidence_id))
       order by v.created_at, v.id collate "C"`,
      [point, version],
    );
    return rows.map((row) => {
      const body = JSON.parse(openUnder(admin.keys, row.compartments, verdictAt(row.id), row.body_enc)) as {
        verdict: PointVerdict;
        p: number;
      };
      return { p: body.p, verdict: body.verdict, weight: Number(row.weight), at: row.created_at };
    });
  });
}

// -------------------------------------------------------------------------------------------
// Reports, proposals, suspensions and the drift card
// -------------------------------------------------------------------------------------------

export function writeReport(admin: AdminContext, point: string, version: number, report: ReportRow): Promise<string> {
  return admin.transaction(async (query) => {
    await lockRows(query, []);
    const id = newId("cal");
    await query(
      `insert into ledger.calibration_reports (id, point, version, n, bands, precision, recall, agreement, agreement_28d, intervals, drift, insufficient)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        point,
        version,
        report.n,
        JSON.stringify(report.bands),
        report.precision,
        report.recall,
        report.agreement,
        report.agreement28d,
        JSON.stringify(report.intervals),
        report.drift,
        report.insufficient,
      ],
    );
    return id;
  });
}

// A proposal applies nothing. A value outside its point version's bounds is refused.
export function writeProposal(
  admin: AdminContext,
  point: string,
  version: number,
  name: string,
  value: number,
  reportId: string,
): Promise<string> {
  const bounds = boundsOf(point, version, name);
  if (bounds === undefined || !unit(value) || value < bounds.floor || value > bounds.ceiling)
    return Promise.reject(new AdminError("out_of_bounds"));
  return admin.transaction(async (query) => {
    await lockRows(query, []);
    const id = newId("tpr");
    await query(
      "insert into ledger.threshold_proposals (id, point, version, name, value, report_id) values ($1, $2, $3, $4, $5, $6)",
      [id, point, version, name, value, reportId],
    );
    return id;
  });
}

// The disagreement of the report the owner's latest grant from a proposal for this point
// version was made from, or null when there is none (a `set` grant has no report).
export function grantedDisagreement(admin: AdminContext, point: string, version: number): Promise<number | null> {
  return admin.transaction(async (query) => {
    const [row] = await query<{ agreement: string | null }>(
      `select r.agreement::text as agreement from policy.thresholds t
       join ledger.threshold_proposals p on p.id = t.proposal_id
       join ledger.calibration_reports r on r.id = p.report_id
       where t.point = $1 and t.version = $2 and t.revoked_at is null and t.source = 'proposal'
       order by t.granted_at desc, t.id collate "C" desc limit 1`,
      [point, version],
    );
    const agreement = num(row?.agreement ?? null);
    return agreement === null ? null : 1 - agreement;
  });
}

export function suspend(admin: AdminContext, point: string, version: number, reportId: string): Promise<string> {
  return admin.transaction(async (query) => {
    const [open] = await query<{ id: string }>(
      "select id from policy.rung_suspensions where point = $1 and version = $2 and lifted_at is null",
      [point, version],
    );
    if (open !== undefined) return open.id;
    const id = newId("rsp");
    await query(
      "insert into policy.rung_suspensions (id, point, version, rung, report_id) values ($1, $2, $3, 1, $4)",
      [id, point, version, reportId],
    );
    return id;
  });
}

// `pi ladder resume`: the owner's decision of kind rung_resume, and the suspension lifted.
// Throws AdminError "not_suspended" when none is open.
export function resume(
  admin: AdminContext,
  point: string,
  version: number,
  options: { requestId: string },
): Promise<RulingId> {
  return admin.transaction(async (query) => {
    await lockRows(query, []);
    const [open] = await query<{ id: string }>(
      "select id from policy.rung_suspensions where point = $1 and version = $2 and lifted_at is null for update",
      [point, version],
    );
    if (open === undefined) throw new AdminError("not_suspended");
    const id = newId("rul") as RulingId;
    const ruling = await ownerDecision(
      query,
      {
        ...decision(id, options.requestId, "rung_resume"),
        target: { kind: "suspension", id: open.id },
        details: { point, version, suspension: open.id },
      },
      admin.now(),
    );
    await query("update policy.rung_suspensions set lifted_at = now(), lift_decision_id = $2 where id = $1", [
      open.id,
      ruling,
    ]);
    return ruling;
  });
}

// The drift card (author system:calibration, no body, options `seen`): one undecided card per
// point version, by its case key, so a later run raises no other while one is pending.
export function raiseDrift(
  admin: AdminContext,
  point: string,
  version: number,
  reportId: string,
): Promise<{ raised: boolean }> {
  return admin.transaction(async (query) => {
    const card = await raiseCard(
      query,
      {
        id: CardId.parse(newId("crd")),
        requestId: `drift_${reportId}`,
        kind: "calibration_drift",
        author: "system:calibration",
        options: [...CARD_OPTIONS.calibration_drift],
        target: { kind: "report", id: reportId },
        refs: [],
        compartments: OWN,
        expiresAt: null,
        expiresAfterDays: null,
        caseKey: driftCase(point, version),
        run: null,
        body: null,
        bodyFrom: null,
      },
      { now: admin.now(), log: admin.log },
    );
    return { raised: !card.replayed };
  });
}

// -------------------------------------------------------------------------------------------
// Thresholds and targets
// -------------------------------------------------------------------------------------------

// The latest unrevoked grant of each point, version and name, as a run reads them.
export function grants(admin: AdminContext): Promise<ThresholdGrant[]> {
  return admin.transaction((query) => latestGrants(query));
}

// `pi thresholds grant`: the owner's grant of a proposal, as a decision of kind
// threshold_grant and a row of source `proposal`. Throws "not_found" for no such proposal and
// "out_of_bounds" for a value outside its bounds.
export function grantProposal(
  admin: AdminContext,
  proposalId: string,
  options: { requestId: string },
): Promise<string> {
  return admin.transaction(async (query) => {
    await lockRows(query, []);
    const [proposal] = await query<{ point: string; version: number; name: string; value: string }>(
      "select point, version, name, value::text as value from ledger.threshold_proposals where id = $1",
      [proposalId],
    );
    if (proposal === undefined) throw new AdminError("not_found");
    return grant(query, admin.now(), {
      ...proposal,
      value: Number(proposal.value),
      source: "proposal",
      proposalId,
      requestId: options.requestId,
    });
  });
}

// `pi thresholds set`: the owner's own value, an override, stored with source `set`.
export function setThreshold(
  admin: AdminContext,
  point: string,
  version: number,
  name: string,
  value: number,
  options: { requestId: string },
): Promise<string> {
  return admin.transaction(async (query) => {
    await lockRows(query, []);
    return grant(query, admin.now(), {
      point,
      version,
      name,
      value,
      source: "set",
      proposalId: null,
      requestId: options.requestId,
    });
  });
}

// `pi thresholds revoke`: the point returns to its default. "not_found" for no such unrevoked grant.
export function revokeThreshold(
  admin: AdminContext,
  thresholdId: string,
  options: { requestId: string },
): Promise<RulingId> {
  return admin.transaction(async (query) => {
    await lockRows(query, []);
    const [row] = await query<{ id: string; point: string; version: number; name: string }>(
      "select id, point, version, name from policy.thresholds where id = $1 and revoked_at is null for update",
      [thresholdId],
    );
    if (row === undefined) throw new AdminError("not_found");
    const after = await effectiveOf(query, row.point, row.version, row.name, thresholdId);
    if (after !== undefined && (await outOfOrder(query, row.point, row.version, row.name, after)))
      throw new AdminError("out_of_bounds");
    const id = newId("rul") as RulingId;
    const ruling = await ownerDecision(
      query,
      {
        ...decision(id, options.requestId, "threshold_revoke"),
        target: { kind: "threshold", id: thresholdId },
        details: { threshold: thresholdId },
      },
      admin.now(),
    );
    await query("update policy.thresholds set revoked_at = now() where id = $1", [thresholdId]);
    return ruling;
  });
}

// `pi thresholds target`: the owner's target for a point version, before any proposal.
export function setTarget(
  admin: AdminContext,
  point: string,
  version: number,
  target: ThresholdTarget,
  options: { requestId: string },
): Promise<RulingId> {
  const given = [target.recall, target.miss, target.precision].filter((value) => value !== null);
  if (
    POINT_THRESHOLDS[`${point}@${version}`] === undefined ||
    given.length === 0 ||
    !given.every((value) => value !== null && unit(value))
  ) {
    return Promise.reject(new AdminError("invalid_argument"));
  }
  return admin.transaction(async (query) => {
    await lockRows(query, []);
    const id = newId("rul") as RulingId;
    const ruling = await ownerDecision(
      query,
      { ...decision(id, options.requestId, "threshold_target"), details: { point, version, ...target } },
      admin.now(),
    );
    if (ruling !== id) return ruling;
    await query(
      "insert into policy.threshold_targets (decision_id, point, version, recall, miss, precision) values ($1, $2, $3, $4, $5, $6)",
      [ruling, point, version, target.recall, target.miss, target.precision],
    );
    return ruling;
  });
}

export function targetOf(admin: AdminContext, point: string, version: number): Promise<ThresholdTarget | null> {
  return admin.transaction(async (query) => {
    const [row] = await query<{ recall: string | null; miss: string | null; precision: string | null }>(
      `select recall::text as recall, miss::text as miss, precision::text as precision from policy.threshold_targets
       where point = $1 and version = $2 order by set_at desc, decision_id collate "C" desc limit 1`,
      [point, version],
    );
    return row === undefined ? null : { recall: num(row.recall), miss: num(row.miss), precision: num(row.precision) };
  });
}

export function suspensions(admin: AdminContext): Promise<{ id: string; point: string; version: number }[]> {
  return admin.transaction((query) =>
    query("select id, point, version from policy.rung_suspensions where lifted_at is null order by point, version"),
  );
}

// -------------------------------------------------------------------------------------------
// The record screen's release
// -------------------------------------------------------------------------------------------

// `pi agent-records release ID`: the owner's decision of kind record_release, the flag cleared,
// and the item's release set as `pi extract retry --override` sets a message's, so neither
// the decide model's nor the extract model's narrowing is applied to it again. A replay of the request id returns its
// first ruling. Throws "not_found" for an id that names no flagged finding, and
// "extract_running" while a run holds the extract lock.
export function releaseRecord(
  admin: AdminContext,
  recordId: string,
  options: { requestId: string },
): Promise<RulingId> {
  return admin.transaction(async (query) => {
    const tx = { query, keys: admin.keys };
    await tryExtractLock(tx);
    await lockRows(query, [recordId]);
    // A replay of the request id returns the first ruling, before the flag (which it cleared) is read.
    const repeated = await repeatedDecision(query, options.requestId);
    if (repeated !== undefined) return repeated;
    const [row] = await query<{ evidence_id: string | null; compartments: string[] }>(
      "select evidence_id, compartments from ledger.agent_writes where id = $1 and flagged_at is not null for update",
      [recordId],
    );
    if (row === undefined || row.evidence_id === null) throw new AdminError("not_found");
    const id = newId("rul") as RulingId;
    const ruling = await ownerDecision(
      query,
      {
        ...decision(id, options.requestId, "record_release"),
        target: { kind: "agent_record", id: recordId as AgentRecordId },
        compartments: row.compartments,
      },
      admin.now(),
    );
    await query("update ledger.agent_writes set flagged_at = null where id = $1", [recordId]);
    // The release as `pi extract retry --override` sets a message's: waiting, with the release.
    await setRecordWaiting(tx, row.evidence_id, row.compartments, { override: true });
    return ruling;
  });
}

// -------------------------------------------------------------------------------------------
// The identity sweep's saved calls
// -------------------------------------------------------------------------------------------

// The store of completeKeyedWithReplay over vault.decision_calls, in one transaction per call.
export function decisionCalls(admin: AdminContext): KeyedCallStore {
  const { keys } = admin;
  return {
    find: (key) => admin.transaction((query) => decisionCallStore(query, keys).find(key)),
    save: (record) => admin.transaction((query) => decisionCallStore(query, keys).save(record)),
  };
}

// D4: a point version's accept stays above its reject, whatever the names its rung 1 entry gives them
// (`thresholdPair`). Neither carries to a later version, so a threshold's effective value is its latest
// unrevoked grant for this version, else its default; `without` leaves one grant out, as a revoke would.
async function effectiveOf(
  query: Query,
  point: string,
  version: number,
  name: string,
  without: string | null = null,
): Promise<number | undefined> {
  const bounds = boundsOf(point, version, name);
  if (bounds === undefined) return undefined;
  const [row] = await query<{ value: string }>(
    `select value::text as value from policy.thresholds where point = $1 and version = $2 and name = $3 and revoked_at is null and ($4::text is null or id <> $4)
     order by granted_at desc, id collate "C" desc limit 1`,
    [point, version, name, without],
  );
  return row === undefined ? bounds.default : Number(row.value);
}

async function outOfOrder(query: Query, point: string, version: number, name: string, value: number): Promise<boolean> {
  const definition = DECISION_POINTS.find((one) => one.id === point && one.version === version);
  const pair = definition === undefined ? null : thresholdPair(definition, name);
  const held = pair === null ? undefined : await effectiveOf(query, point, version, pair.other);
  if (pair === null || held === undefined) return false;
  return pair.side === "reject" ? value >= held : value <= held;
}

// A threshold decision with no target and no card, under the owner's compartment.
function decision(
  id: RulingId,
  requestId: string,
  kind: "threshold_grant" | "threshold_revoke" | "threshold_target" | "rung_resume" | "record_release",
) {
  return {
    id,
    requestId,
    kind,
    target: null,
    answer: null,
    card: null,
    supersedes: null,
    batch: false,
    labels: [],
    details: {},
    compartments: OWN,
  };
}

async function grant(
  query: Query,
  now: Date,
  given: {
    point: string;
    version: number;
    name: string;
    value: number;
    source: "proposal" | "set";
    proposalId: string | null;
    requestId: string;
  },
): Promise<string> {
  const bounds = boundsOf(given.point, given.version, given.name);
  if (bounds === undefined || !unit(given.value) || given.value < bounds.floor || given.value > bounds.ceiling)
    throw new AdminError("out_of_bounds");
  const thresholdId = newId("thr");
  const id = newId("rul") as RulingId;
  const ruling = await ownerDecision(
    query,
    {
      ...decision(id, given.requestId, "threshold_grant"),
      target: { kind: "threshold", id: thresholdId },
      details: {
        point: given.point,
        version: given.version,
        name: given.name,
        value: given.value,
        source: given.source,
        threshold: thresholdId,
        proposal: given.proposalId,
      },
    },
    now,
  );
  // A repeated request id: the first grant's threshold.
  if (ruling !== id) {
    const [first] = await query<{ target_id: string }>(
      "select target_id from knowledge.owner_decisions where id = $1",
      [ruling],
    );
    return first?.target_id ?? thresholdId;
  }
  // After the replay, so a repeated request returns its first grant whatever was granted since;
  // a refusal here rolls the decision back with the transaction.
  if (await outOfOrder(query, given.point, given.version, given.name, given.value))
    throw new AdminError("out_of_bounds");
  await query(
    "insert into policy.thresholds (id, point, version, name, value, decision_id, source, proposal_id) values ($1, $2, $3, $4, $5, $6, $7, $8)",
    [thresholdId, given.point, given.version, given.name, given.value, ruling, given.source, given.proposalId],
  );
  return thresholdId;
}
