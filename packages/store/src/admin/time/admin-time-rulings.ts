import type { Timestamp } from "@intelligence/contracts";
import {
  CaptureWork,
  dayAfter,
  dayIn,
  type EntityId,
  HOST_FORM,
  ownLabel,
  type RulingId,
  sortedLabel,
  startOfDay,
  TIME_PASS_DAYS,
  type TimeProposalId,
  type TimeProposals,
  type TimeProposalView,
  type Who,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { byText, type Query, stamp } from "../../core/db.ts";
import { fingerprint, scopeNormal } from "../../core/fingerprint.ts";
import { newId, requestIdOf } from "../../core/ids.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { lockRows } from "../../core/queue.ts";
import { open, type Sealed, sealUnder } from "../../core/seal.ts";
import { openedUnder } from "../../core/tx.ts";
import { ownerZoneOf } from "../../core/zone.ts";
import { proposalText } from "../../lens/time-group-text.ts";
import { ownerWho } from "../admin-owner.ts";
import { REPEATABLE, unrestrictedOf } from "../admin-time-base.ts";
import { RULING_LOCKS } from "../rulings/owner-ruling.ts";

// The owner's time rulings and the owner's answers to what the daily pass proposed: `pi time assign`,
// `unassign`, `veto` and `except`. Each ruling, lift and veto is one owner decision, written in one
// transaction with its rows. A read of time follows at once: no total is stored. Ids, counts and codes in
// logs.

const insertRuling = (
  query: Query,
  ruling: RulingId,
  project: string | null,
  from: string,
  to: string,
  compartments: readonly string[],
  now: Date,
): Promise<unknown> =>
  query(
    `insert into knowledge.time_rulings (id, project_id, from_at, to_at, source, ruling_id, created_at, compartments)
     values ($1, $2, $3, $4, 'owner', $5, $6, $7)`,
    [newId("tru"), project, from, to, ruling, stamp(now), [...compartments].sort(byText)],
  );

// An active project's compartments, or not_found.
async function activeProject(query: Query, project: string, within: readonly string[]): Promise<string[]> {
  const [row] = await query<{ compartments: string[] }>(
    "select compartments from knowledge.projects where id = $1 and status = 'active' and compartments <@ $2::text[]",
    [project, [...within]],
  );
  if (row === undefined) throw new AdminError("not_found");
  return row.compartments;
}

// Whether a stored block in the stretch holds the label: a ruling reaches a block only within its
// label, so one of none reaching nothing would say done and change nothing.
async function blockHolds(
  admin: Pick<AdminContext, "keys">,
  query: Query,
  label: readonly string[],
  from: number,
  to: number,
): Promise<boolean> {
  const rows = await query<{ id: string; compartments: string[]; work_enc: Sealed }>(
    `select id, compartments, work_enc from knowledge.captures
     where kind = 'block' and work_enc is not null and compartments @> $1::text[] and started_at < $3 and ended_at > $2`,
    [[...label], new Date(from).toISOString(), new Date(to).toISOString()],
  );
  return rows.some((row) => {
    const work = CaptureWork.safeParse(JSON.parse(open(admin.keys, row, "knowledge.captures.work_enc", "throw")));
    return (
      work.success &&
      work.data.kind === "block" &&
      work.data.blocks.some((one) => Date.parse(one.start) < to && Date.parse(one.end) > from)
    );
  });
}

// `pi time assign FROM TO PROJECT`, or `--none [--compartment C]`: a stretch of at most a day, under
// the project's compartments or C, `own` by default. Refused bad_range, not_found for a project
// that is not active, unknown_compartment, and no_block for none where no block of C lies in the
// stretch. A repeated request id writes nothing.
export function assignTime(
  admin: AdminContext,
  args: { from: string; to: string; project: EntityId | null; compartment?: string; requestId: string },
): Promise<void> {
  const [from, to] = [Date.parse(args.from), Date.parse(args.to)];
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > DAY_MS)
    return Promise.reject(new AdminError("bad_range"));
  const compartment = args.compartment ?? "own";
  if (args.project === null && !admin.keys.compartments.has(compartment))
    return Promise.reject(new AdminError("unknown_compartment"));
  const now = admin.now();
  return admin.transaction(async (query) => {
    await lockRows(query, [RULING_LOCKS.time]);
    const label =
      args.project === null ? [compartment] : await activeProject(query, args.project, unrestrictedOf(admin.keys));
    if (args.project === null && !(await blockHolds(admin, query, label, from, to))) throw new AdminError("no_block");
    const id = newId("rul") as RulingId;
    const ruling = await ownerDecision(
      query,
      {
        id,
        requestId: args.requestId,
        kind: "time_ruling",
        compartments: [...label].sort(byText),
      },
      now,
    );
    if (ruling !== id) return;
    await insertRuling(
      query,
      ruling,
      args.project,
      new Date(from).toISOString(),
      new Date(to).toISOString(),
      label,
      now,
    );
  });
}

// `pi time unassign RULING`: lifts one of the owner's own. not_found for a ruling that is not the owner's or is
// already lifted.
export function unassignTime(admin: AdminContext, ruling: string, requestId: string): Promise<void> {
  const now = admin.now();
  return admin.transaction(async (query) => {
    await lockRows(query, [RULING_LOCKS.time]);
    const [row] = await query<{ compartments: string[] }>(
      "select compartments from knowledge.time_rulings where id = $1 and source = 'owner' and lifted_at is null",
      [ruling],
    );
    if (row === undefined) throw new AdminError("not_found");
    const lift = await ownerDecision(
      query,
      { kind: "time_unruling", requestId: requestId, compartments: sortedLabel(row.compartments) },
      now,
    );
    await query("update knowledge.time_rulings set lifted_at = $2, lift_ruling_id = $3 where id = $1", [
      ruling,
      stamp(now),
      lift,
    ]);
  });
}

// `pi time veto PROPOSAL [--to PROJECT]`: every stretch of one proposal stops crediting, and stays,
// so the pass never proposes that time again (invariant 11). With `to`, the same stretches are the
// owner's ruling for that project: within the stretch's label, or compartment_mismatch, since a
// ruling outside a block's label would credit nothing. not_found for a proposal with nothing live,
// and a repeated request id changes nothing.
export function vetoProposal(
  admin: AdminContext,
  args: { proposal: TimeProposalId; to?: EntityId; requestId: string },
): Promise<void> {
  const now = admin.now();
  return admin.transaction(async (query) => {
    await lockRows(query, [RULING_LOCKS.time]);
    const stretches = await query<{
      id: string;
      project_id: string | null;
      from_at: Date;
      to_at: Date;
      compartments: string[];
    }>(
      `select id, project_id, from_at, to_at, compartments from knowledge.time_rulings
       where proposal_id = $1 and source = 'system' and lifted_at is null and pending_card is null order by id`,
      [args.proposal],
    );
    const first = stretches[0];
    if (first === undefined) {
      const [replay] = await query("select 1 from knowledge.owner_decisions where request_id = $1", [args.requestId]);
      if (replay !== undefined) return;
      throw new AdminError("not_found");
    }
    const label = first.compartments;
    const to = args.to === undefined ? null : await activeProject(query, args.to, unrestrictedOf(admin.keys));
    if (to !== null && !to.every((one) => label.includes(one))) throw new AdminError("compartment_mismatch");
    const lift = await ownerDecision(
      query,
      { kind: "time_veto", requestId: args.requestId, compartments: sortedLabel(label) },
      now,
    );
    await query(
      "update knowledge.time_rulings set lifted_at = $2, lift_ruling_id = $3 where proposal_id = $1 and lifted_at is null",
      [args.proposal, stamp(now), lift],
    );
    // The owner's veto stands over what agents set there too (invariant 11): every live agent ruling
    // judged from the proposal, and every one of the proposal's project over a vetoed stretch.
    await query(
      `update knowledge.agent_time_rulings set lifted_at = $2, lifted_by = 'owner'
       where lifted_at is null and (proposal_id = $1 or (project_id = $3 and exists (
         select 1 from unnest($4::timestamptz[], $5::timestamptz[]) as v (f, t) where to_at > v.f and from_at < v.t)))`,
      [
        args.proposal,
        stamp(now),
        first.project_id,
        stretches.map((one) => stamp(one.from_at)),
        stretches.map((one) => stamp(one.to_at)),
      ],
    );
    if (args.to === undefined || to === null) return;
    const second = requestIdOf(`${args.requestId}\nto`);
    const ruling = await ownerDecision(
      query,
      { kind: "time_ruling", requestId: second, compartments: sortedLabel(to) },
      now,
    );
    for (const stretch of stretches)
      await insertRuling(query, ruling, args.to, stamp(stretch.from_at), stamp(stretch.to_at), to, now);
  });
}

// The live proposals with a stretch starting in a window, in `pi time day` and on the dashboard,
// each with what its evidence says now. Within the compartments the owner's reads take.
export async function dayProposals(
  admin: Pick<AdminContext, "keys">,
  query: Query,
  day: string,
  zone: string | null,
  days = 1,
): Promise<TimeProposalView[]> {
  const rows = await query<{
    proposal_id: TimeProposalId;
    project_id: EntityId;
    from_at: Date;
    to_at: Date;
    evidence_ids: string[];
  }>(
    `select proposal_id, project_id, from_at, to_at, evidence_ids from knowledge.time_rulings
     where source = 'system' and lifted_at is null and pending_card is null and compartments <@ $1::text[]
       and from_at >= $2 and from_at < $3
     order by from_at, id`,
    [
      unrestrictedOf(admin.keys),
      new Date(startOfDay(day, zone)).toISOString(),
      new Date(startOfDay(dayAfter(day, days), zone)).toISOString(),
    ],
  );
  const proposals = new Map<string, typeof rows>();
  for (const row of rows) proposals.set(row.proposal_id, [...(proposals.get(row.proposal_id) ?? []), row]);
  const who = await ownerWho({ query, keys: admin.keys }, [...new Set(rows.map((row) => row.project_id))]);
  const views: TimeProposalView[] = [];
  for (const [id, stretches] of proposals) {
    const first = stretches[0] as (typeof rows)[number];
    const project = (who.get(first.project_id) ?? {
      id: first.project_id,
      kind: "project",
      name: null,
      address: null,
    }) as Who;
    const text = await proposalText(query, admin.keys, first.evidence_ids, first.from_at.getTime());
    views.push({
      id: id as TimeProposalId,
      project,
      from: stamp(first.from_at) as Timestamp,
      to: stamp(new Date(Math.max(...stretches.map((one) => one.to_at.getTime())))) as Timestamp,
      minutes: stretches.reduce((sum, one) => sum + (one.to_at.getTime() - one.from_at.getTime()) / 60_000, 0),
      stretches: stretches.length,
      what: { untrusted: text ?? "" },
    });
  }
  return views;
}

// The owner's named exceptions: a bundle or host never proposed, held as a capture scope value is: its normal form
// fingerprinted under `capture_scope` and sealed under `own`.
const BUNDLE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/;
const at = (id: string) => ({ table: "policy.time_exceptions", id, column: "value_enc" });

type TimeException = { id: string; match: "bundle" | "host"; value: string };

export function addException(admin: AdminContext, match: "bundle" | "host", value: string): Promise<string> {
  if (!(match === "bundle" ? BUNDLE.test(value) : value.length <= 253 && HOST_FORM.test(value)))
    return Promise.reject(new AdminError("invalid_argument"));
  const normal = scopeNormal(value);
  const id = newId("tex");
  return admin.transaction(async (query) => {
    const [made] = await query<{ id: string }>(
      `insert into policy.time_exceptions (id, match, value_fp, value_enc, created_at)
       values ($1, $2, $3, $4, $5) on conflict on constraint time_exceptions_value do nothing returning id`,
      [
        id,
        match,
        fingerprint(admin.keys, "capture_scope", normal),
        sealUnder(admin.keys, ownLabel(), at(id), normal),
        stamp(admin.now()),
      ],
    );
    if (made === undefined) throw new AdminError("duplicate_name");
    return made.id;
  });
}

export function removeException(admin: AdminContext, id: string): Promise<void> {
  return admin.transaction(async (query) => {
    const gone = await query("delete from policy.time_exceptions where id = $1 returning id", [id]);
    if (gone.length === 0) throw new AdminError("not_found");
  });
}

export function listExceptions(admin: AdminContext): Promise<TimeException[]> {
  return admin.transaction(async (query) => {
    const rows = await query<{ id: string; match: "bundle" | "host"; value_enc: Sealed }>(
      "select id, match, value_enc from policy.time_exceptions order by id",
    );
    return rows.map((row) => ({
      id: row.id,
      match: row.match,
      value: openedUnder(admin.keys, ownLabel(), at(row.id), row.value_enc),
    }));
  });
}

// The dashboard's list: every live proposal the pass can have made, today's window of complete days,
// newest first, and the active
// projects a correction may name. A project outside a proposal's label refuses at the veto.
export function recentProposals(admin: AdminContext): Promise<TimeProposals> {
  return admin.transaction(async (query) => {
    await query(REPEATABLE);
    const zone = await ownerZoneOf(query);
    const today = dayIn(admin.now(), zone);
    const proposals = await dayProposals(admin, query, dayAfter(today, -TIME_PASS_DAYS), zone, TIME_PASS_DAYS);
    const projects = await query<{ id: EntityId }>(
      "select id from knowledge.projects where status = 'active' and compartments <@ $1::text[] order by id",
      [unrestrictedOf(admin.keys)],
    );
    const who = await ownerWho(
      { query, keys: admin.keys },
      projects.map((one) => one.id),
    );
    return {
      proposals: proposals.reverse(),
      projects: projects.flatMap((one) => {
        const named = who.get(one.id);
        return named === undefined ? [] : [named as Who];
      }),
    };
  });
}
