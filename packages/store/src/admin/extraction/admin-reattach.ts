import {
  AGENT_ATTEMPT_HOURS,
  CARD_CLAIM_TYPES,
  CARD_OPTIONS,
  type CardId,
  ClaimRecord,
  cardLineText,
  type FactId,
  type FactKeyFp,
  type FactRulingVerdict,
  type NewCard,
  OPEN_IMPROVEMENT_STATUSES,
  type PersonalCompartment,
  type RulingId,
} from "@intelligence/contracts/personal";
import { TASK_OPEN } from "../../cards/agent-attempts.ts";
import { rulingLostParts } from "../../cards/card-line.ts";
import type { AdminContext } from "../../core/admin-context.ts";
import { type Query, stamp } from "../../core/db.ts";
import { newId, requestIdOf } from "../../core/ids.ts";
import { authorWord, BELIEFS_LOCK, caseWord } from "../../core/locks.ts";
import { lockRows, raiseCard } from "../../core/queue.ts";
import type { Sealed } from "../../core/seal.ts";
import { open } from "../../core/seal.ts";
import { IMPROVEMENT_OPEN, improvementStatus, quoted } from "../../core/statements.ts";
import { openedUnder } from "../../core/tx.ts";
import { closeCause, fileCause } from "../outcomes/admin-improvements.ts";
import { CAUSE_FORM } from "../outcomes/improvement-filing.ts";
import { carryPairIn } from "../rulings/admin-fact-rulings.ts";
import { type ShownClaim, shownOf } from "../rulings/ruling-anchors.ts";
import { carryIn } from "../rulings/ruling-carry.ts";
import { carryOver } from "./admin-query-time.ts";

export type ReattachReport = {
  generation: number;
  dryRun: boolean;
  reattached: number;
  gone: number;
  tasked: number;
  asked: number;
  skipped: number;
};

// What the matching rule reads of a claim. `entities`: the entities it names, as
// knowledge.claim_entities holds them.
export type Candidate = {
  claim: string;
  type: string;
  subject: string;
  factKey: string;
  entities?: readonly string[];
  fields?: Record<string, unknown>;
};
// What a ruling was about: a type and a subject, read from a stored claim, or a type and the
// entities its claim named, read from its anchors. `shown`: the claim the owner saw, from the
// ruling's sealed snapshot: its subject and every typed field (value and polarity among them).
export type Identity = {
  type: string;
  subject?: string;
  entities?: readonly string[];
  shown?: Pick<ShownClaim, "subject" | "fields">;
};
export type Match =
  | { outcome: "reattach"; claim: string; factKey: string }
  | { outcome: "gone" }
  | { outcome: "ask"; claims: string[] };

function sameEntities(a: readonly string[], b: readonly string[]): boolean {
  const [x, y] = [[...a].sort(), [...b].sort()];
  return x.length === y.length && x.every((one, index) => one === y[index]);
}

// One JSON value in a fixed form: an object's keys in order, so two values are equal when their
// forms are.
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );

// The matching rule: the evidence's current claims of the ruling's type, about its subject where
// one is known. None is gone. Of those, where the ruling's entities are known, the claims that
// name exactly them. One fact (one fact key, whichever claims hold it) is re-attached, named by
// its first claim in id order that says what the owner was shown: the same subject and the same
// typed fields, every one. A fact of the same type about the same people that says something else
// (the opposite value, another polarity) is not the statement the owner ruled on, and a fact about
// the owner names no entity to tell it by, so type and entities alone never carry a ruling; nor is
// a ruling with no snapshot (made before snapshots, or emptied by an erasure) ever carried by
// code. Anything else is asked, naming the claims that came closest. With nothing known of the
// ruling, any claim may be the one: none is gone, and every other case is asked, never guessed.
export function matchCarry(identity: Identity | undefined, candidates: readonly Candidate[]): Match {
  const loose =
    identity === undefined
      ? candidates
      : candidates.filter(
          (one) => one.type === identity.type && (identity.subject === undefined || one.subject === identity.subject),
        );
  if (loose.length === 0) return { outcome: "gone" };
  const entities = identity?.entities;
  const same = entities === undefined ? loose : loose.filter((one) => sameEntities(one.entities ?? [], entities));
  const claims = [...new Set(same.map((one) => one.claim))].sort();
  const shown = identity?.shown;
  if (shown !== undefined && new Set(same.map((one) => one.factKey)).size === 1) {
    const first = same
      .filter((one) => one.subject === shown.subject && canonical(one.fields ?? {}) === canonical(shown.fields))
      .sort((a, b) => (a.claim < b.claim ? -1 : a.claim > b.claim ? 1 : 0))[0];
    if (first !== undefined) return { outcome: "reattach", claim: first.claim, factKey: first.factKey };
  }
  return { outcome: "ask", claims: same.length === 0 ? [...new Set(loose.map((one) => one.claim))].sort() : claims };
}

// The card's author, and what a ruling's card is known by at one generation.
const CARRY_AUTHOR = "system:carry";
const caseKeyOf = (ruling: string, generation: number): string => `ruling_carry:${ruling}:${generation}`;
// The most candidate claims a card lists by id; the rest are counted.
const LISTED = 12;

type ClaimRow = {
  id: string;
  type: string;
  fact_key_fp: string;
  extractor_generation: number;
  compartments: PersonalCompartment[];
  content_enc: Sealed;
  entities: string[];
};
type Opened = { row: ClaimRow; subject: string; fields: Record<string, unknown> };

const openable = (admin: AdminContext, compartments: readonly string[]): boolean =>
  compartments.every((one) => admin.keys.compartments.has(one));

// A claim's subject, or undefined when its label holds a compartment the keys lack or its sealed
// record is no ClaimRecord.
function openClaim(admin: AdminContext, row: ClaimRow): Opened | undefined {
  if (!openable(admin, row.compartments)) return undefined;
  const record = ClaimRecord.safeParse(JSON.parse(open(admin.keys, row, "knowledge.claims.content_enc", "throw")));
  return record.success
    ? { row, subject: record.data.claim.content.subject, fields: record.data.claim.content.fields }
    : undefined;
}

const CLAIM_COLUMNS = `c.id, c.type, c.fact_key_fp, c.extractor_generation, c.compartments, c.content_enc,
  array(select n.entity_id from knowledge.claim_entities n where n.claim_id = c.id order by n.entity_id collate "C") as entities`;
// The claims of the items these evidence rows are revisions of.
const ITEM_CLAIMS = `select ${CLAIM_COLUMNS} from knowledge.claims c join vault.evidence_items e on e.id = c.evidence_id
  where exists (select 1 from vault.evidence_items a where a.id = any ($1::text[])
    and a.source_account_id = e.source_account_id and a.source_item_fp = e.source_item_fp)
  order by c.id collate "C"`;
const candidateOf = (one: Opened): Candidate => ({
  claim: one.row.id,
  type: one.row.type,
  subject: one.subject,
  factKey: one.row.fact_key_fp,
  entities: one.row.entities,
  fields: one.fields,
});

// The claims the owner was shown when the ruling was made, in its keys' order, from its sealed
// snapshot; none when it has no snapshot or the snapshot does not open.
function shownClaims(
  admin: AdminContext,
  table: "knowledge.belief_rulings" | "knowledge.fact_rulings",
  ruling: { ruling_id: string; compartments: PersonalCompartment[]; shown_enc: Sealed },
): ShownClaim[] {
  if (ruling.shown_enc === null) return [];
  try {
    const at =
      table === "knowledge.belief_rulings"
        ? ({ table: "knowledge.belief_rulings", id: ruling.ruling_id, column: "shown_enc" } as const)
        : ({ table: "knowledge.fact_rulings", id: ruling.ruling_id, column: "shown_enc" } as const);
    return shownOf(openedUnder(admin.keys, ruling.compartments, at, ruling.shown_enc))?.claims ?? [];
  } catch {
    return [];
  }
}
// The claims a fact key names, as its own key or a version 1 key, at any generation.
const BY_KEY = `select ${CLAIM_COLUMNS} from knowledge.claims c
  where c.fact_key_fp = $1 or c.legacy_fact_key_fp = $1 or c.legacy_alt_fact_key_fp = $1 order by c.id collate "C"`;

// The type and subject of a fact key, from the first claim it still names that the keys open.
// `unopenable` when every claim it names is under a compartment the keys lack.
async function identityOf(
  admin: AdminContext,
  query: Query,
  factKey: string,
): Promise<Identity | undefined | "unopenable"> {
  const rows = await query<ClaimRow>(BY_KEY, [factKey]);
  for (const row of rows) {
    const one = openClaim(admin, row);
    if (one !== undefined) return { type: row.type, subject: one.subject };
  }
  return rows.length === 0 ? undefined : "unopenable";
}

// What one ruling comes to: a re-attachment, gone, a question, or skipped.
type CarriedVerdict = "reject" | "veto" | "retire" | "domain" | "kind";
type Plan =
  | {
      outcome: "reattach";
      claim: FactId;
      ruling: { id: RulingId; verdict: CarriedVerdict; createdAt: Date };
    }
  | {
      outcome: "reattach_pair";
      a: FactKeyFp;
      b: FactKeyFp;
      claim: FactId;
      ruling: { id: RulingId; verdict: FactRulingVerdict; createdAt: Date };
    }
  | { outcome: "gone" }
  | { outcome: "ask"; verdict: string; claims: string[]; compartments: string[] }
  | { outcome: "skip" };

const SKIP: Plan = { outcome: "skip" };

type BeliefRuling = {
  ruling_id: RulingId;
  verdict: string;
  source_account_id: string | null;
  source_item_fp: string | null;
  fact_key_fp: string;
  created_at: Date;
  compartments: PersonalCompartment[];
  item_account_ids: string[] | null;
  item_fps: string[] | null;
  claim_type: string | null;
  evidence_ids: string[] | null;
  entity_ids: string[] | null;
  shown_enc: Sealed;
};

// A ruling's anchors, when it has them.
const anchorOf = (ruling: { claim_type: string | null; entity_ids: string[] | null }): Identity | undefined =>
  ruling.claim_type === null || ruling.entity_ids === null
    ? undefined
    : { type: ruling.claim_type, entities: ruling.entity_ids };

// A ruling on one fact key: the claims of its items. A reject's item is its own; a veto's or a
// retire's are the items recorded with it, and the items of its anchored evidence when it recorded
// none; a domain's or a kind's, which records no item, are those of its anchored evidence.
async function planBelief(admin: AdminContext, query: Query, ruling: BeliefRuling, generation: number): Promise<Plan> {
  const verdict = ruling.verdict as CarriedVerdict;
  const anchor = anchorOf(ruling);
  if ((verdict === "domain" || verdict === "kind") && anchor === undefined) return SKIP;
  const stored = await identityOf(admin, query, ruling.fact_key_fp);
  if (stored === "unopenable") return SKIP;
  // A stored claim says the type and the subject; the anchor adds the entities, so a claim of the
  // same subject about someone else is never the one.
  const identity: Identity | undefined =
    stored === undefined || anchor?.entities === undefined
      ? (stored ?? anchor)
      : { ...stored, entities: anchor.entities };
  // What the owner saw. An erasure that reached the ruling removed it with the ids that went
  // (knowledge.forget_ruling_anchors), so a ruling on a reduced set of entities is never carried.
  const [shown] = shownClaims(admin, "knowledge.belief_rulings", ruling);
  if (identity !== undefined && shown !== undefined) identity.shown = shown;
  const accounts = verdict === "reject" ? [ruling.source_account_id as string] : (ruling.item_account_ids ?? []);
  const fps = verdict === "reject" ? [ruling.source_item_fp as string] : (ruling.item_fps ?? []);
  const rows =
    accounts.length > 0
      ? await query<ClaimRow>(
          `select ${CLAIM_COLUMNS} from knowledge.claims c join vault.evidence_items e on e.id = c.evidence_id
           join unnest($1::text[], $2::text[]) as i (account_id, item_fp) on i.account_id = e.source_account_id and i.item_fp = e.source_item_fp
           order by c.id collate "C"`,
          [accounts, fps],
        )
      : await query<ClaimRow>(ITEM_CLAIMS, [ruling.evidence_ids ?? []]);
  // An item not yet raised still holds claims of an earlier generation: judged after its raise.
  if (rows.some((row) => row.extractor_generation < generation)) return SKIP;
  const current = rows.filter((row) => CARD_CLAIM_TYPES.includes(row.type));
  const candidates = current.map((row) => openClaim(admin, row));
  if (candidates.some((one) => one === undefined)) return SKIP;
  const match = matchCarry(identity, (candidates as Opened[]).map(candidateOf));
  if (match.outcome === "gone") return match;
  if (match.outcome === "reattach")
    return {
      outcome: "reattach",
      claim: match.claim as FactId,
      ruling: { id: ruling.ruling_id, verdict, createdAt: ruling.created_at },
    };
  const listed = current.filter((row) => match.claims.includes(row.id));
  return {
    outcome: "ask",
    verdict: ruling.verdict,
    claims: match.claims,
    compartments: [...ruling.compartments, ...listed.flatMap((row) => row.compartments)],
  };
}

type PairRuling = {
  ruling_id: RulingId;
  verdict: FactRulingVerdict;
  a_fp: FactKeyFp;
  b_fp: FactKeyFp;
  created_at: Date;
  compartments: PersonalCompartment[];
  claim_type: string | null;
  a_evidence_ids: string[] | null;
  b_evidence_ids: string[] | null;
  entity_ids: string[] | null;
  shown_enc: Sealed;
};

// A side of a join or a split whose key moved, by its anchors: the one fact its evidence now holds
// of the ruling's type naming the ruling's entities. Undefined when there is not exactly one, or
// its evidence is not yet raised or cannot be opened.
async function movedSide(
  admin: AdminContext,
  query: Query,
  identity: Identity,
  evidenceIds: readonly string[],
  generation: number,
): Promise<{ key: FactKeyFp; claim: FactId } | undefined> {
  if (evidenceIds.length === 0) return undefined;
  const rows = await query<ClaimRow>(ITEM_CLAIMS, [evidenceIds]);
  if (rows.some((row) => row.extractor_generation < generation)) return undefined;
  const opened = rows.filter((row) => CARD_CLAIM_TYPES.includes(row.type)).map((row) => openClaim(admin, row));
  if (opened.some((one) => one === undefined)) return undefined;
  const match = matchCarry(identity, (opened as Opened[]).map(candidateOf));
  return match.outcome === "reattach" ? { key: match.factKey as FactKeyFp, claim: match.claim as FactId } : undefined;
}

// A join or a split: a side whose key no claim of the generation names is re-keyed. It records no
// item, so it is never re-attached: its candidates are the current claims of the other side's type
// and subject (a join's two keys are of one subject, type and domain), and with none it is gone.
// Both sides re-keyed leave nothing to know them by: asked, with no candidate.
// With anchors, each side whose key moved is first looked for in its own evidence: when every such
// side is found as exactly one fact, the ruling is re-attached to the two keys its sides now are.
async function planPair(admin: AdminContext, query: Query, ruling: PairRuling, generation: number): Promise<Plan> {
  const sides = await Promise.all(
    [ruling.a_fp, ruling.b_fp].map(async (key) => {
      const rows = await query<ClaimRow>(BY_KEY, [key]);
      return {
        key,
        current: rows.filter((row) => row.extractor_generation >= generation),
        earlier: rows.some((row) => row.extractor_generation < generation),
      };
    }),
  );
  if (sides.some((side) => side.current.length === 0 && side.earlier)) return SKIP;
  const held = sides.filter((side) => side.current.length > 0);
  if (held.length === 2) return SKIP;
  const anchor = anchorOf(ruling);
  if (anchor !== undefined) {
    const evidence = [ruling.a_evidence_ids ?? [], ruling.b_evidence_ids ?? []];
    // Each side is matched against the claim the owner saw for it: with no snapshot, never.
    const shown = shownClaims(admin, "knowledge.fact_rulings", ruling);
    const moved = await Promise.all(
      sides.map((side, index) =>
        side.current.length > 0 || shown[index] === undefined
          ? undefined
          : movedSide(admin, query, { ...anchor, shown: shown[index] }, evidence[index] as string[], generation),
      ),
    );
    const [a, b] = sides.map((side, index) => (side.current.length > 0 ? (side.key as FactKeyFp) : moved[index]?.key));
    const claim = moved.find((one) => one !== undefined)?.claim;
    if (a !== undefined && b !== undefined && a !== b && claim !== undefined)
      return {
        outcome: "reattach_pair",
        a,
        b,
        claim,
        ruling: { id: ruling.ruling_id, verdict: ruling.verdict, createdAt: ruling.created_at },
      };
  }
  const ask = (claims: string[], compartments: string[]): Plan => ({
    outcome: "ask",
    verdict: ruling.verdict,
    claims,
    compartments: [...ruling.compartments, ...compartments],
  });
  if (held.length === 0) return ask([], []);
  const known = (held[0] as (typeof held)[number]).current
    .map((row) => openClaim(admin, row))
    .find((one) => one !== undefined);
  if (known === undefined) return SKIP;
  const rows = await query<ClaimRow>(
    `select ${CLAIM_COLUMNS} from knowledge.claims c where c.type = $1 and c.extractor_generation >= $2 and c.fact_key_fp <> $3 order by c.id collate "C"`,
    [known.row.type, generation, known.row.fact_key_fp],
  );
  const others = rows
    .map((row) => openClaim(admin, row))
    .filter((one): one is Opened => one !== undefined && one.subject === known.subject);
  if (others.length === 0) return { outcome: "gone" };
  return ask(
    others.map((one) => one.row.id),
    others.flatMap((one) => one.row.compartments),
  );
}

async function planOf(admin: AdminContext, query: Query, ruling: string, generation: number): Promise<Plan> {
  const [carried] = await query(
    "select 1 from knowledge.owner_decisions where kind = 'ruling_carry' and details ->> 'from' = $1",
    [ruling],
  );
  // A question a deletion tainted was withdrawn with a candidate it listed: it is asked again.
  const [asked] = await query(
    "select 1 from ledger.cards where kind = 'ruling_carry' and case_key = $1 and tainted_at is null",
    [caseKeyOf(ruling, generation)],
  );
  if (carried !== undefined || asked !== undefined) return SKIP;
  const [belief] = await query<BeliefRuling>(
    `select ruling_id, verdict, source_account_id, source_item_fp, fact_key_fp, created_at, compartments, item_account_ids, item_fps,
       claim_type, evidence_ids, entity_ids, shown_enc
     from knowledge.belief_rulings where ruling_id = $1 and lifted_at is null`,
    [ruling],
  );
  if (belief !== undefined)
    return openable(admin, belief.compartments) ? planBelief(admin, query, belief, generation) : SKIP;
  const [pair] = await query<PairRuling>(
    `select ruling_id, verdict, a_fp, b_fp, created_at, compartments, claim_type, a_evidence_ids, b_evidence_ids, entity_ids, shown_enc
     from knowledge.fact_rulings where ruling_id = $1 and lifted_at is null`,
    [ruling],
  );
  if (pair !== undefined) return openable(admin, pair.compartments) ? planPair(admin, query, pair, generation) : SKIP;
  return SKIP;
}

// The question for one ruling: ids and words only, in a body of one line code wrote, which the
// card's view shows as a code line.
export function questionBody(ruling: string, verdict: string, generation: number, claims: readonly string[]): string {
  return cardLineText(
    "ruling_lost",
    rulingLostParts(ruling, verdict, generation, claims.slice(0, LISTED), Math.max(0, claims.length - LISTED)),
  );
}

// `again`: how many questions on this ruling at this generation a deletion tainted, so the one asked
// after them is a new card and not the tainted one's repeat.
function questionOf(
  ruling: string,
  generation: number,
  plan: Extract<Plan, { outcome: "ask" }>,
  compartments: PersonalCompartment[],
  again: number,
): NewCard {
  return {
    id: newId("crd") as CardId,
    requestId: requestIdOf(again === 0 ? caseKeyOf(ruling, generation) : `${caseKeyOf(ruling, generation)}:${again}`),
    kind: "ruling_carry",
    author: CARRY_AUTHOR,
    options: [...CARD_OPTIONS.ruling_carry],
    target: null,
    refs: [],
    compartments,
    expiresAt: null,
    expiresAfterDays: null,
    caseKey: caseKeyOf(ruling, generation),
    run: null,
    body: questionBody(ruling, plan.verdict, generation, plan.claims),
    bodyFrom: "code",
  };
}

// The defect the sweep files for a ruling it cannot carry at one generation: ids and codes only.
export const detachedCause = (ruling: string, generation: number): string =>
  `ruling_detached:${ruling.toLowerCase()}:${generation}`;
const DETACHED = "ruling_detached:";

export type DetachedDefect = { open: boolean; dismissed: boolean; taskEnded: boolean; ageHours: number };
export function ladderStep(state: {
  tasksOn: boolean;
  restricted: boolean;
  defect: DetachedDefect | undefined;
}): "ask" | "wait" | "file" | "skip" {
  if (!state.tasksOn || state.restricted) return "ask";
  const { defect } = state;
  if (defect === undefined) return "file";
  if (defect.dismissed) return "skip";
  if (!defect.open) return "file";
  return defect.taskEnded || defect.ageHours >= AGENT_ATTEMPT_HOURS ? "ask" : "wait";
}

const DEFECT = `
  select s.status in (${quoted(OPEN_IMPROVEMENT_STATUSES)}) as open,
    s.status in ('wont_do', 'duplicate') and s.closed_by = 'owner' as dismissed,
    exists (select 1 from ledger.opportunities o
            where o.gap_trigger = 'defect' and o.gap_source = i.id
              and (select r.event from ledger.record_events r where r.row_kind = 'opportunity' and r.row_id = o.id
                   order by r.id desc limit 1) not in (${quoted(TASK_OPEN)})) as task_ended,
    (extract(epoch from ($2::timestamptz - i.created_at)) / 3600)::float8 as age_hours, i.compartments
  from ledger.improvements i
  cross join lateral (
    select coalesce(max(e.status), 'open') as status, max(e.created_by) as closed_by from (
      ${improvementStatus("e.status, e.created_by")}) e) s
  where i.cause = $1`;
// A defect raises a task only while the owner has set the role defects go to: with none set no
// agent can be given the question, and the owner is asked now.
const TASKS_ON = `select exists (select 1 from policy.intents i where i.for_tasks and i.confirmed_at is not null and i.revoked_at is null)
    and exists (select 1 from policy.work_settings s where s.defect_role is not null) as tasks_on,
  policy.is_restricted($1::text[]) as restricted`;

// The step for one ruling's question under `label`, and the write it takes: the defect filed, or
// closed as the question passes to the owner. A dry run reads the step and writes nothing; `file`
// and `wait` are both an agent's turn.
async function agentFirst(
  admin: AdminContext,
  query: Query,
  cause: string,
  state: string,
  label: PersonalCompartment[],
  dryRun: boolean,
): Promise<"task" | "ask" | "skip"> {
  if (!CAUSE_FORM.test(cause)) return "ask";
  const [switches] = await query<{ tasks_on: boolean; restricted: boolean }>(TASKS_ON, [label]);
  const [row] = await query<{
    open: boolean;
    dismissed: boolean | null;
    task_ended: boolean;
    age_hours: number;
    compartments: PersonalCompartment[];
  }>(DEFECT, [cause, stamp(admin.now())]);
  const step = ladderStep({
    tasksOn: switches?.tasks_on === true,
    restricted: switches?.restricted !== false,
    defect:
      row === undefined
        ? undefined
        : { open: row.open, dismissed: row.dismissed === true, taskEnded: row.task_ended, ageHours: row.age_hours },
  });
  if (step === "skip") return "skip";
  if (step === "ask") {
    // Closed under the defect's own label, as every close of a defect is: the question's label now
    // may not be the one the defect was filed under.
    if (!dryRun && row?.open === true && openable(admin, row.compartments))
      await closeCause(admin, query, cause, row.compartments);
    return "ask";
  }
  if (step === "file" && !dryRun) {
    const action = await fileCause(admin, query, label, {
      cause,
      kind: "ruling_detached",
      area: "knowledge",
      severity: "medium",
      state,
      label,
    });
    if (action === "vetoed") return "skip";
  }
  return "task";
}

// One ruling, in its own transaction. A real run takes the beliefs lock, then the shared taint lock
// with the card's words, before it reads anything; a dry run takes neither and writes nothing.
async function reattachOne(
  admin: AdminContext,
  ruling: string,
  generation: number,
  dryRun: boolean,
): Promise<"reattach" | "gone" | "task" | "ask" | "skip"> {
  return admin.transaction(async (query) => {
    if (!dryRun) {
      await query(BELIEFS_LOCK);
      await lockRows(query, [authorWord(CARRY_AUTHOR), caseWord(caseKeyOf(ruling, generation))]);
    }
    const plan = await planOf(admin, query, ruling, generation);
    if (plan.outcome === "gone" || plan.outcome === "skip") return plan.outcome;
    if (plan.outcome === "reattach") {
      if (dryRun) return "reattach";
      return (await carryIn(admin, query, plan.ruling, plan.claim)) === "carried" ? "reattach" : "skip";
    }
    if (plan.outcome === "reattach_pair") {
      if (dryRun) return "reattach";
      return (await carryPairIn(admin, query, plan.ruling, plan)) === "carried" ? "reattach" : "skip";
    }
    const [label] = await query<{ compartments: PersonalCompartment[] }>(
      "select ledger.label($1::text[]) as compartments",
      [plan.compartments],
    );
    const compartments = label?.compartments ?? [];
    // An agent first, as a task on the board; the owner only after that.
    const step = await agentFirst(
      admin,
      query,
      detachedCause(ruling, generation),
      `verdict=${plan.verdict} generation=${generation} candidates=${plan.claims.length}`,
      compartments,
      dryRun,
    );
    if (step !== "ask" || dryRun) return step;
    const [tainted] = await query<{ n: number }>(
      "select count(*)::int as n from ledger.cards where kind = 'ruling_carry' and case_key = $1 and tainted_at is not null",
      [caseKeyOf(ruling, generation)],
    );
    const card = await raiseCard(query, questionOf(ruling, generation, plan, compartments, tainted?.n ?? 0), {
      now: admin.now(),
      keys: admin.keys,
      log: admin.log,
    });
    // The candidates the card lists are its basis, so a deletion of one taints the card.
    if (!card.replayed)
      await query("select ledger.cite_claims($1, $2::text[])", [card.id, plan.claims.slice(0, LISTED)]);
    return "ask";
  });
}

// The defects of rulings the sweep no longer holds a question on at `generation`: carried, gone,
// lifted, ruled again by the owner, or filed for an earlier generation. Each is closed, and the tick
// withdraws its task. One whose ruling was skipped this run stays: what held it back may pass.
async function closeSettled(
  admin: AdminContext,
  generation: number,
  settled: ReadonlySet<string>,
  unfound: readonly string[],
): Promise<void> {
  const listed = new Set(unfound.map((ruling) => ruling.toLowerCase()));
  await admin.transaction(async (query) => {
    const open = await query<{ cause: string; compartments: PersonalCompartment[] }>(
      `select i.cause, i.compartments from ledger.improvements i
       where starts_with(i.cause, $1) and ${IMPROVEMENT_OPEN}
       order by i.cause`,
      [DETACHED],
    );
    for (const { cause, compartments } of open) {
      const [ruling, at] = cause.slice(DETACHED.length).split(":") as [string, string | undefined];
      const over = settled.has(ruling) || !listed.has(ruling) || Number(at) < generation;
      if (over && openable(admin, compartments)) await closeCause(admin, query, cause, compartments);
    }
  });
}

export async function reattach(
  admin: AdminContext,
  options: { generation: number; dryRun: boolean },
): Promise<ReattachReport> {
  const { generation } = options;
  const report = await admin.transaction((query) => carryOver(query, { generation }));
  const counts = { reattach: 0, gone: 0, task: 0, ask: 0, skip: 0 };
  const settled = new Set<string>();
  for (const ruling of report.rulings.unfound) {
    const outcome = await reattachOne(admin, ruling, generation, options.dryRun);
    counts[outcome] += 1;
    if (outcome === "reattach" || outcome === "gone") settled.add(ruling.toLowerCase());
  }
  if (!options.dryRun) await closeSettled(admin, generation, settled, report.rulings.unfound);
  admin.log.info({
    event: "rulings_reattached",
    counts: {
      generation,
      reattached: counts.reattach,
      gone: counts.gone,
      tasked: counts.task,
      asked: counts.ask,
      skipped: counts.skip,
    },
  });
  return {
    generation,
    dryRun: options.dryRun,
    reattached: counts.reattach,
    gone: counts.gone,
    tasked: counts.task,
    asked: counts.ask,
    skipped: counts.skip,
  };
}
