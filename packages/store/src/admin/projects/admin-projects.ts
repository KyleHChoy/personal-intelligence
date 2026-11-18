import type { Timestamp } from "@intelligence/contracts";
import {
  ACTIVITY_TYPES,
  type CaptureId,
  CaptureWork,
  type DeviceAnchorKind,
  type EntityId,
  type MessageId,
  type PersonalCompartment,
  type RulingId,
} from "@intelligence/contracts/personal";
import { codePoints, THE_OWNER } from "@intelligence/personal-core";
import { type CaptureFacts, deviceAnchorKey } from "@intelligence/personal-core/lens";
import { strongKeysOf } from "../../core/activity-keys.ts";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, stamp } from "../../core/db.ts";
import { fingerprint } from "../../core/fingerprint.ts";
import { newId } from "../../core/ids.ts";
import { LINK_TYPES } from "../../core/link-types.ts";
import { ANCHOR_LOCK } from "../../core/locks.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { waitToReplay } from "../../core/replay.ts";
import type { Sealed } from "../../core/seal.ts";
import { open, openUnder, sealUnder } from "../../core/seal.ts";
import { openStatus } from "../../core/status-facts.ts";
import type { Tx } from "../../core/tx.ts";
import { removeClaims } from "../../write/writer-removal.ts";
import { tryExtractLock } from "../extraction/admin-extraction.ts";
import { PROJECT_CLOSED, recordEvent } from "../record-event.ts";

// The owner's project commands, as pi_admin. Only the owner makes a project or an anchor: a model
// never does, and not every thread makes one. Each command writes one owner decision. Anchoring and
// unanchoring take the extract lock first and refuse with extract_running while a run holds it;
// then, under the beliefs lock, they remove every claim of the thread's items with what rests on
// it, and set those items waiting with their saved calls kept, so the next run makes the claims
// again by replay, with the project subject or without it, at no cost. Merge and undo are not
// built. The device anchors bind no claim; setting or lifting one takes the extract lock too and
// re-checks the meetings and moments it matches. A window title anchor, which no extraction reads,
// takes no extract lock and re-checks nothing.

type ProjectRowStatus = "active" | "merged" | "closed";
// A series is never given as a value.
export type DeviceAnchorInput =
  | { kind: Exclude<DeviceAnchorKind, "meeting_series">; value: string }
  | { seriesOf: CaptureId };
// `value` is a device anchor's normal form, opened; null for a thread, for a window title (its
// title is never stored), and where the key file lacks its compartment.
type ProjectAnchorView = {
  id: string;
  kind: "email_thread" | DeviceAnchorKind;
  value: string | null;
  createdAt: Timestamp;
};
// The name opened; null where the key file lacks its compartment.
type ProjectView = {
  id: EntityId;
  name: string | null;
  status: ProjectRowStatus;
  compartments: string[];
  anchors: ProjectAnchorView[];
};

const NAME_MOST = 200;
const nameAt = (id: string) => ({ table: "knowledge.projects", id, column: "name_enc" });
const valueAt = (id: string) => ({ table: "knowledge.project_anchors", id, column: "value_enc" });

type ProjectRow = { id: EntityId; status: ProjectRowStatus; compartments: PersonalCompartment[] };

// Claims stay immutable: they are removed and made again from the same evidence, never edited
// (invariant 3). The items wait as a mention binding's do (waitToReplay: status waiting, attempts
// 0, not screened).
async function replay(tx: Tx, items: string[]): Promise<void> {
  if (items.length === 0) return;
  await tx.query(
    "select count(*) from (select 1 from knowledge.messages where evidence_id = any($1) order by id for update) as locked",
    [items],
  );
  await tx.query(
    "select count(*) from (select 1 from vault.evidence_items where id = any($1) order by id for no key update) as locked",
    [items],
  );
  const claims = (
    await tx.query<{ id: string }>("select id from knowledge.claims where evidence_id = any($1) order by id", [items])
  ).map((row) => row.id);
  await removeClaims(tx.query, claims);
  // Only an item a saved call can replay, and never a withheld one: the replay buys no call, and
  // a withheld item waits for the owner's retry, as it did.
  const replayed = await tx.query<{ evidence_id: string }>(
    `select p.evidence_id from vault.pipeline_items p
     where p.evidence_id = any($1) and not p.withheld
       and exists (select 1 from vault.model_calls m where m.evidence_id = p.evidence_id and m.superseded_at is null)`,
    [items],
  );
  await waitToReplay(
    tx,
    replayed.map((row) => row.evidence_id),
  );
}

export async function recheckDeviceAnchor(
  tx: Tx,
  anchor: { anchorFp: string; compartments: PersonalCompartment[] },
): Promise<number> {
  return (await recheckBlockDays(tx, anchor)) + (await recheckLinkedItems(tx, anchor));
}

const BLOCK_ACTIVITY_TYPES: readonly string[] = [ACTIVITY_TYPES.workedOn, ACTIVITY_TYPES.researched];
async function recheckBlockDays(
  tx: Tx,
  anchor: { anchorFp: string; compartments: PersonalCompartment[] },
): Promise<number> {
  const rows = await tx.query<{ evidence_id: string; id: string; compartments: string[]; work_enc: Sealed }>(
    `select c.evidence_id, c.id, c.compartments, c.work_enc from knowledge.captures c
     where c.kind = 'block' and c.compartments @> $1::text[] and c.work_enc is not null and not policy.is_restricted(c.compartments)
     order by c.evidence_id collate "C"`,
    [anchor.compartments],
  );
  const matched = rows
    .filter((row) => {
      const work = CaptureWork.parse(
        JSON.parse(
          openUnder(
            tx.keys,
            row.compartments,
            { table: "knowledge.captures", id: row.id, column: "work_enc" },
            row.work_enc,
          ),
        ),
      );
      return (
        work.kind === "block" &&
        work.blocks.some((block) => strongKeysOf(tx.keys, block).some((one) => one.keyFps.includes(anchor.anchorFp)))
      );
    })
    .map((row) => row.evidence_id);
  if (matched.length === 0) return 0;
  await tx.query(
    "select count(*) from (select 1 from vault.evidence_items where id = any($1) order by id for no key update) as locked",
    [matched],
  );
  const claims = (
    await tx.query<{ id: string }>(
      "select id from knowledge.claims where evidence_id = any($1) and type = any($2::text[]) order by id",
      [matched, BLOCK_ACTIVITY_TYPES],
    )
  ).map((row) => row.id);
  await removeClaims(tx.query, claims);
  return waitToReplay(tx, matched);
}

// The skips a moment is given for what it lacks, which no re-check changes.
const OUT_OF_LANE: ReadonlySet<string> = new Set(["no_turns", "not_chat", "agent_app"]);

async function recheckLinkedItems(
  tx: Tx,
  anchor: { anchorFp: string; compartments: PersonalCompartment[] },
): Promise<number> {
  const matched = (
    await tx.query<{ evidence_id: string }>(
      `select c.evidence_id from knowledge.captures c
       where c.match_fps @> array[$1]::text[] and c.compartments @> $2::text[] and c.kind in ('meeting', 'moment')
         and not policy.is_restricted(c.compartments)
       order by c.evidence_id collate "C"`,
      [anchor.anchorFp, anchor.compartments],
    )
  ).map((row) => row.evidence_id);
  if (matched.length === 0) return 0;
  return replayMoments(tx, matched, async () => {
    const links = (
      await tx.query<{ id: string }>(
        "select id from knowledge.claims where evidence_id = any($1) and type = any($2::text[]) order by id",
        [matched, [...LINK_TYPES]],
      )
    ).map((row) => row.id);
    await removeClaims(tx.query, links);
  });
}

// The re-check's widening, shared with the backfill vouch (lens-admin.ts): stored moments set
// waiting to be replayed with their saved calls kept, widened to each saved call's other members
// and, for a moment with no saved call, its group (local day, bundle, thread, label), so the next
// run asks the same request again and its replay hits. No restricted moment and no withheld item;
// a moment only widened in waits only while it could enter the lane; one that failed with no saved
// call does not wait, so nothing is asked anew. `before` runs once the widened rows are locked.
export async function replayMoments(tx: Tx, matched: readonly string[], before?: () => Promise<void>): Promise<number> {
  // Each saved call's members that include a matched moment, as stored moments the role may read.
  // The collation is in the select list: with DISTINCT, an ORDER BY expression must be one of its
  // columns, and `o.evidence_id collate "C"` is not `o.evidence_id` (42P10).
  const members = await tx.query<{ evidence_id: string }>(
    `select distinct o.evidence_id collate "C" as evidence_id from vault.model_call_members m
     join vault.model_call_members o on o.call_id = m.call_id
     join knowledge.captures c on c.evidence_id = o.evidence_id
     where m.evidence_id = any($1) and c.kind = 'moment' and not policy.is_restricted(c.compartments)
     order by 1`,
    [matched],
  );
  // The groups of the matched moments with no saved call: every moment of the same local day,
  // bundle, thread and compartment set.
  const grouped = await tx.query<{ evidence_id: string }>(
    `select distinct o.evidence_id collate "C" as evidence_id from knowledge.captures m
     join knowledge.captures o on o.kind = 'moment' and o.local_day = m.local_day
       and o.bundle_fp is not distinct from m.bundle_fp and o.thread_fp is not distinct from m.thread_fp
       and o.compartments @> m.compartments and o.compartments <@ m.compartments
     where m.evidence_id = any($1) and m.kind = 'moment' and not policy.is_restricted(o.compartments)
       and not exists (select 1 from vault.model_call_members k where k.evidence_id = m.evidence_id)
       and not exists (select 1 from vault.model_calls k where k.evidence_id = m.evidence_id and k.superseded_at is null)
     order by 1`,
    [matched],
  );
  const widened = [
    ...new Set([...matched, ...members.map((row) => row.evidence_id), ...grouped.map((row) => row.evidence_id)]),
  ].sort();
  await tx.query(
    "select count(*) from (select 1 from vault.evidence_items where id = any($1) order by id for no key update) as locked",
    [widened],
  );
  if (before !== undefined) await before();
  const statuses = await tx.query<{ evidence_id: string; compartments: string[]; facts_enc: Sealed; called: boolean }>(
    `select p.evidence_id, p.compartments, p.facts_enc,
       exists (select 1 from vault.model_calls k where k.evidence_id = p.evidence_id and k.superseded_at is null)
         or exists (select 1 from vault.model_call_members k where k.evidence_id = p.evidence_id) as called
     from vault.pipeline_items p where p.evidence_id = any($1) and not p.withheld order by p.evidence_id`,
    [widened],
  );
  // A moment only widened in waits only when it could still enter the moment
  // lane, since a moment triage skips is never part of its group's request. Read without its
  // evidence: its sealed facts' entity, its agent_app mark, and a skip it already has for what it
  // lacks. A matched moment always waits: its link is made again.
  const only = widened.filter((id) => !matched.includes(id));
  const sealed = await tx.query<{
    evidence_id: string;
    id: string;
    compartments: string[];
    facts_enc: Sealed;
    agent_app: boolean;
  }>(
    "select evidence_id, id, compartments, facts_enc, agent_app from knowledge.captures where evidence_id = any($1) and kind = 'moment'",
    [only],
  );
  const chat = (row: (typeof sealed)[number]): boolean => {
    const facts = JSON.parse(
      openUnder(
        tx.keys,
        row.compartments,
        { table: "knowledge.captures", id: row.id, column: "facts_enc" },
        row.facts_enc,
      ),
    ) as CaptureFacts;
    return facts.kind === "moment" && facts.entity === "chat";
  };
  const outOfLane = new Set(sealed.filter((row) => row.agent_app || !chat(row)).map((row) => row.evidence_id));
  const waiting = statuses.filter((row) => {
    if (outOfLane.has(row.evidence_id)) return false;
    const facts = openStatus(tx, row.compartments, row.evidence_id, row.facts_enc);
    if (
      only.includes(row.evidence_id) &&
      facts.status === "skipped" &&
      facts.code !== undefined &&
      OUT_OF_LANE.has(facts.code)
    )
      return false;
    return row.called || facts.status !== "failed";
  });
  return waitToReplay(
    tx,
    waiting.map((row) => row.evidence_id),
  );
}

// Every stored item of the thread under the compartments, every revision.
const threadItems = async (query: Query, threadFp: string, compartments: string[]): Promise<string[]> =>
  (
    await query<{ id: string }>(
      "select id from vault.evidence_items where thread_fp = $1 and compartments = $2 order by id",
      [threadFp, compartments],
    )
  ).map((row) => row.id);

// `pi project add`: a project_add decision, the project's entity and its row, its name sealed
// under its compartment (`own` unless the owner names another), in one transaction. A repeated
// request id returns the first project and adds none.
export async function add(
  admin: AdminContext,
  name: string,
  options: { compartment?: string; requestId: string },
): Promise<EntityId> {
  const compartment = options.compartment ?? "own";
  if (codePoints(name.trim()) === 0 || codePoints(name) > NAME_MOST) throw new AdminError("invalid_argument");
  const { keys } = admin;
  if (!keys.compartments.has(compartment)) throw new AdminError("unknown_compartment");
  const now = admin.now();
  return admin.transaction(async (query) => {
    const project = newId("ent") as EntityId;
    const id = newId("rul") as RulingId;
    const ruling = await ownerDecision(
      query,
      {
        id,
        requestId: options.requestId,
        kind: "project_add",
        target: { kind: "entity", id: project },
        compartments: [compartment],
      },
      now,
    );
    if (ruling !== id) {
      const [first] = await query<{ kind: string; target_id: EntityId }>(
        "select kind, target_id from knowledge.owner_decisions where id = $1",
        [ruling],
      );
      if (first?.kind !== "project_add") throw new AdminError("invalid_argument");
      return first.target_id;
    }
    await query("insert into knowledge.entities (id, kind) values ($1, 'project')", [project]);
    await query(
      "insert into knowledge.projects (id, status, name_enc, compartments, readers) values ($1, 'active', $2, $3, $4)",
      [project, sealUnder(keys, [compartment], nameAt(project), name), [compartment], [THE_OWNER]],
    );
    return project;
  });
}

// An anchor already there is returned and nothing is written.
//
// `pi project anchor PROJECT --app | --host | --url | --repo | --document | --series-of`: a device
// anchor, refused bad_anchor, generic_anchor, anchor_taken, no_series, compartment_mismatch, or
// not_found for a project not active. `--title`: a window title anchor, its title from stdin.
export async function anchor(
  admin: AdminContext,
  project: EntityId,
  target: MessageId | DeviceAnchorInput,
  options: { requestId: string },
): Promise<string> {
  if (typeof target !== "string") return anchorDevice(admin, project, target, options);
  const message = target;
  const now = admin.now();
  return admin.transaction(async (query) => {
    await tryExtractLock({ query, keys: admin.keys });
    const target = await projectRow(query, project);
    if (target?.status !== "active") throw new AdminError("not_found");
    const [row] = await query<{ thread_fp: string | null; compartments: string[] }>(
      "select thread_fp, compartments from knowledge.messages where id = $1",
      [message],
    );
    if (row === undefined) throw new AdminError("not_found");
    if (row.thread_fp === null) throw new AdminError("invalid_argument");
    // Equal as the anchor's joins compare them (THREAD_ANCHORS and threadItems use `=`).
    if (
      row.compartments.length !== target.compartments.length ||
      row.compartments.some((one, index) => one !== target.compartments[index])
    )
      throw new AdminError("compartment_mismatch");
    const [live] = await query<{ id: string }>(
      "select id from knowledge.project_anchors where project_id = $1 and kind = 'email_thread' and anchor_fp = $2 and lifted_at is null",
      [project, row.thread_fp],
    );
    if (live !== undefined) return live.id;
    const ruling = await decide(query, "project_anchor", project, target.compartments, options.requestId, now);
    const anchor = newId("pan");
    await query(
      `insert into knowledge.project_anchors (id, project_id, kind, anchor_fp, ruling_id, created_at, compartments)
       values ($1, $2, 'email_thread', $3, $4, $5, $6)`,
      [anchor, project, row.thread_fp, ruling, stamp(now), target.compartments],
    );
    await replay({ query, keys: admin.keys }, await threadItems(query, row.thread_fp, target.compartments));
    return anchor;
  });
}

// False for an anchor not there or already lifted. A device anchor's lift re-checks the items it
// matched instead.
export async function unanchor(admin: AdminContext, anchor: string, options: { requestId: string }): Promise<boolean> {
  const now = admin.now();
  return admin.transaction(async (query) => {
    // An anchor's kind never changes, so it is read before the thread's lock order begins.
    const [kind] = await query<{ kind: string }>("select kind from knowledge.project_anchors where id = $1", [anchor]);
    if (kind !== undefined && kind.kind !== "email_thread") {
      // Not for a window title anchor, which no extraction reads and which matched no item.
      if (kind.kind !== "window_title") await tryExtractLock({ query, keys: admin.keys });
      const [row] = await query<{ project_id: EntityId; anchor_fp: string; compartments: PersonalCompartment[] }>(
        "select project_id, anchor_fp, compartments from knowledge.project_anchors where id = $1 and lifted_at is null for update",
        [anchor],
      );
      if (row === undefined) return false;
      await decide(query, "project_unanchor", row.project_id, row.compartments, options.requestId, now);
      await query("update knowledge.project_anchors set lifted_at = $2 where id = $1", [anchor, stamp(now)]);
      // The owner's unanchor stands over what agents set there too (invariant 11): their anchors of the
      // place to the project are lifted, and ledger.set_anchor refuses them again.
      await query(
        `update knowledge.agent_anchors set lifted_at = $3, lifted_by = 'owner'
         where anchor_fp = $1 and project_id = $2 and lifted_at is null`,
        [row.anchor_fp, row.project_id, stamp(now)],
      );
      // A window title anchor matched no item's link or activity claim.
      if (kind.kind !== "window_title")
        await recheckDeviceAnchor(
          { query, keys: admin.keys },
          { anchorFp: row.anchor_fp, compartments: row.compartments },
        );
      return true;
    }
    await tryExtractLock({ query, keys: admin.keys });
    const [row] = await query<{ project_id: EntityId; anchor_fp: string; compartments: PersonalCompartment[] }>(
      "select project_id, anchor_fp, compartments from knowledge.project_anchors where id = $1 and lifted_at is null for update",
      [anchor],
    );
    if (row === undefined) return false;
    await decide(query, "project_unanchor", row.project_id, row.compartments, options.requestId, now);
    await query("update knowledge.project_anchors set lifted_at = $2 where id = $1", [anchor, stamp(now)]);
    await replay({ query, keys: admin.keys }, await threadItems(query, row.anchor_fp, row.compartments));
    return true;
  });
}

// `pi project close PROJECT`: a project_close decision and the status. Its anchors stay; the
// port resolves an item to an active project only. False for a project not there.
export async function close(admin: AdminContext, project: EntityId, options: { requestId: string }): Promise<boolean> {
  const now = admin.now();
  return admin.transaction(async (query) => {
    // A run that resolved an item to this project must not commit after it closes, unbound.
    await tryExtractLock({ query, keys: admin.keys });
    const target = await projectRow(query, project);
    if (target === undefined) return false;
    if (target.status === "closed") return true;
    await decide(query, "project_close", project, target.compartments, options.requestId, now);
    await query("update knowledge.projects set status = 'closed', updated_at = $2 where id = $1", [
      project,
      stamp(now),
    ]);
    // The project's own event, under its label: where it stands is read from it.
    await recordEvent(query, PROJECT_CLOSED, project, stamp(now), target.compartments);
    return true;
  });
}

// `pi project list`: every project, its name opened, with its live anchors.
export async function list(admin: AdminContext): Promise<ProjectView[]> {
  const { rows, anchors } = await admin.transaction(async (query) => ({
    rows: await query<ProjectRow & { name_enc: Sealed }>(
      'select id, status, name_enc, compartments from knowledge.projects order by id collate "C"',
    ),
    anchors: await query<{
      id: string;
      project_id: string;
      kind: ProjectAnchorView["kind"];
      value_enc: Sealed;
      compartments: string[];
      created_at: Date;
    }>(
      'select id, project_id, kind, value_enc, compartments, created_at from knowledge.project_anchors where lifted_at is null order by created_at, id collate "C"',
    ),
  }));
  return rows.map((row) => ({
    id: row.id,
    name: open(admin.keys, row, "knowledge.projects.name_enc", "null"),
    status: row.status,
    compartments: row.compartments,
    anchors: anchors
      .filter((one) => one.project_id === row.id)
      .map((one) => ({
        id: one.id,
        kind: one.kind,
        value: open(admin.keys, one, "knowledge.project_anchors.value_enc", "null"),
        createdAt: stamp(one.created_at),
      })),
  }));
}

// A series is the calendar UID of a stored meeting the project's label covers. One project_anchor
// decision; the value sealed under the project's compartments at its normal form, the key
// fingerprinted under the anchor kind. A device anchor binds no mail claim; under the extract lock,
// a new one re-checks the items it matches. One already live is returned and re-checks nothing. A
// window title anchor keeps its fingerprint alone, no value, and re-checks nothing: it is read by
// work time alone, at read, so it takes no extract lock. A closed project's live title anchor keeps
// its key taken, since work time credits a closed project's anchors as an active one's
// (work-time-read's ANCHORS), and two projects on one key would give that step none; the owner
// lifts it first to anchor the key elsewhere. Every other kind is taken by an active project's
// anchor alone.
async function anchorDevice(
  admin: AdminContext,
  project: EntityId,
  input: DeviceAnchorInput,
  options: { requestId: string },
): Promise<string> {
  const { keys } = admin;
  const now = admin.now();
  return admin.transaction(async (query) => {
    const kind: DeviceAnchorKind = "seriesOf" in input ? "meeting_series" : input.kind;
    const titled = kind === "window_title";
    if (!titled) await tryExtractLock({ query, keys });
    const target = await projectRow(query, project);
    if (target?.status !== "active") throw new AdminError("not_found");
    const answer = deviceAnchorKey(
      kind,
      "seriesOf" in input ? await seriesOf(admin, query, input.seriesOf, target.compartments) : input.value,
    );
    if ("refused" in answer) throw new AdminError(answer.refused);
    const anchorFp = fingerprint(keys, "anchor", answer.key);
    // Two anchors of one key at once serialize here, so the check below sees the other.
    await query(ANCHOR_LOCK, [anchorFp]);
    const live = await query<{ id: string; project_id: string }>(
      `select a.id, a.project_id from knowledge.project_anchors a join knowledge.projects p on p.id = a.project_id
       where a.anchor_fp = $1 and a.kind <> 'email_thread' and a.lifted_at is null and (p.status = 'active' or a.kind = 'window_title') order by a.id`,
      [anchorFp],
    );
    const own = live.find((one) => one.project_id === project);
    if (own !== undefined) return own.id;
    if (live.length > 0) throw new AdminError("anchor_taken");
    const ruling = await decide(query, "project_anchor", project, target.compartments, options.requestId, now);
    const anchor = newId("pan");
    const value = answer.key.slice(answer.key.indexOf(":") + 1);
    await query(
      `insert into knowledge.project_anchors (id, project_id, kind, anchor_fp, value_enc, ruling_id, created_at, compartments)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        anchor,
        project,
        kind,
        anchorFp,
        titled ? null : sealUnder(keys, target.compartments, valueAt(anchor), value),
        ruling,
        stamp(now),
        target.compartments,
      ],
    );
    if (!titled) await recheckDeviceAnchor({ query, keys }, { anchorFp, compartments: target.compartments });
    return anchor;
  });
}

// A meeting the project's label does not cover is compartment_mismatch, so no anchor's value comes
// from evidence its label does not cover (invariant 4); anything else with no UID is no_series.
async function seriesOf(
  admin: AdminContext,
  query: Query,
  capture: CaptureId,
  compartments: PersonalCompartment[],
): Promise<string> {
  const [row] = await query<{ id: string; kind: string; compartments: string[]; facts_enc: Sealed }>(
    "select id, kind, compartments, facts_enc from knowledge.captures where id = $1",
    [capture],
  );
  if (row?.kind !== "meeting") throw new AdminError("no_series");
  if (!row.compartments.every((one) => (compartments as string[]).includes(one)))
    throw new AdminError("compartment_mismatch");
  const opened = open(admin.keys, row, "knowledge.captures.facts_enc", "null");
  const facts = opened === null ? null : (JSON.parse(opened) as CaptureFacts);
  const uid = facts?.kind === "meeting" ? facts.calendar?.uid : null;
  if (uid === null || uid === undefined) throw new AdminError("no_series");
  return uid;
}

async function projectRow(query: Query, project: EntityId): Promise<ProjectRow | undefined> {
  return (
    await query<ProjectRow>("select id, status, compartments from knowledge.projects where id = $1 for update", [
      project,
    ])
  )[0];
}

async function decide(
  query: Query,
  kind: "project_anchor" | "project_unanchor" | "project_close",
  project: EntityId,
  compartments: PersonalCompartment[],
  requestId: string,
  now: Date,
): Promise<RulingId> {
  return ownerDecision(query, { requestId, kind, target: { kind: "entity", id: project }, compartments }, now);
}
