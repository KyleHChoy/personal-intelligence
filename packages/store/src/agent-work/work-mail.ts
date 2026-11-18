import type {
  AgentMessageView,
  AgentRecipient,
  HealthView,
  ImprovementEventView,
  ImprovementView,
  ListImprovementsArgs,
  ListImprovementsResult,
  PostAgentMessageArgs,
  PostAgentMessageResult,
  ReadAgentInboxArgs,
  ReadAgentInboxResult,
  SubmitImprovementArgs,
  SubmitImprovementResult,
  UpdateImprovementArgs,
  UpdateImprovementResult,
} from "@intelligence/contracts/personal";
import { HEALTH_PARTS_MOST, HealthPartKey, OPEN_IMPROVEMENT_STATUSES } from "@intelligence/contracts/personal";
import { leverUnread } from "@intelligence/personal-core/planner";
import { stamp, stampOrNull } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { newId } from "../core/ids.ts";
import { OUTCOME_THRESHOLDS } from "../core/outcome-thresholds.ts";
import { answered, type Done, isRefused, refused, refusedAs, sealSummary, type WorkCall } from "../core/work-refs.ts";
import { servedOrNull, Unavailable } from "../read/read-ctx.ts";

// Agent messages and the improvement store, as pi_reader inside `pi mcp`. Here ids are made, texts
// sealed under the caller's clearance and opened under each row's label; one definer function per
// call decides the caller, the label, who a message is for and what the caller may see.

const SQL = {
  send: `select message_id, thread_id from ledger.post_agent_message($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, $9::jsonb, $10::jsonb)`,
  inbox: `select id, thread_id, reply_to, from_name, to_kind, to_name, to_role, kind, created_at, compartments, body_enc, subject_id, subject_compartments, subject_enc, mine, read
          from ledger.agent_inbox($1::text, $2::text, $3::integer, $4::boolean)`,
  submit: `select improvement_id, merged from ledger.submit_improvement($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb)`,
  list: `select id, kind, area, severity, status, duplicate_of, by_name, created_at, updated_at, reports, compartments, title_enc, detail_enc, evidence_enc,
                assignee_role, cause, cause_state, held_by, held_at, fix_ref, sort_at
         from ledger.list_improvements($1::text[], $2::text, $3::text, $4::integer, $5::boolean, $6::integer, $7::text, $8::text)`,
  events:
    "select id, created_at, by_name, event, status, compartments, note_enc, evidence_enc from ledger.improvement_events_of($1::text)",
  health: "select section, key, code, value, sample, at, extra, parts from ledger.health_read()",
  label: "select ledger.improvement_label($1::text) as label",
  update:
    "select ledger.update_improvement($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::jsonb, $8::text) as status",
} as const;

const seal = (call: WorkCall, table: string, id: string, column: string, text: string | undefined): string | null =>
  text === undefined ? null : sealSummary(call.ctx, call.client.compartments, { table, id, column }, text);

export async function postAgentMessage(
  call: WorkCall,
  valid: PostAgentMessageArgs,
): Promise<Done<PostAgentMessageResult>> {
  const id = newId("amg");
  const to = valid.to;
  const [toKind, toClient, toRole] =
    to === undefined
      ? [null, null, null]
      : "client" in to
        ? ["client", to.client, null]
        : "role" in to
          ? ["role", null, to.role]
          : ["all", null, null];
  const rows = await call.fn<{ message_id: AgentMessageView["id"]; thread_id: AgentMessageView["thread"] }>(SQL.send, [
    id,
    valid.requestId,
    await call.session(),
    toKind,
    toClient,
    toRole,
    valid.replyTo ?? null,
    valid.kind,
    seal(call, "ledger.agent_messages", id, "subject_enc", valid.subject),
    seal(call, "ledger.agent_messages", id, "body_enc", valid.body),
  ]);
  if (isRefused(rows)) return refused(rows);
  const [row] = rows;
  return row === undefined ? refused("not_found") : answered({ message: row.message_id, thread: row.thread_id });
}

type InboxRow = {
  id: AgentMessageView["id"];
  thread_id: AgentMessageView["thread"];
  reply_to: AgentMessageView["replyTo"];
  from_name: string;
  to_kind: "client" | "role" | "all";
  to_name: string | null;
  to_role: string | null;
  kind: AgentMessageView["kind"];
  created_at: Date;
  compartments: string[];
  body_enc: unknown;
  subject_id: string | null;
  subject_compartments: string[] | null;
  subject_enc: unknown;
  mine: boolean;
  read: boolean;
};

const recipient = (row: InboxRow): AgentRecipient =>
  row.to_kind === "client"
    ? { client: row.to_name ?? "" }
    : row.to_kind === "role"
      ? { role: row.to_role ?? "" }
      : { all: true };

export async function readAgentInbox(call: WorkCall, valid: ReadAgentInboxArgs): Promise<Done<ReadAgentInboxResult>> {
  const limit = valid.limit ?? 20;
  const rows = await call.fn<InboxRow>(SQL.inbox, [
    valid.scope ?? "unread",
    valid.thread ?? null,
    limit,
    valid.markRead ?? true,
  ]);
  if (isRefused(rows)) return refused(rows);
  const page = rows.slice(0, limit);
  const messages = page.map(
    (row): AgentMessageView => ({
      id: row.id,
      thread: row.thread_id,
      replyTo: row.reply_to,
      from: row.from_name,
      to: recipient(row),
      kind: row.kind,
      subject:
        row.subject_id === null
          ? null
          : servedOrNull(
              call.ctx.keys,
              row.subject_compartments,
              { table: "ledger.agent_messages", id: row.subject_id, column: "subject_enc" },
              row.subject_enc,
            ),
      body: servedOrNull(
        call.ctx.keys,
        row.compartments,
        { table: "ledger.agent_messages", id: row.id, column: "body_enc" },
        row.body_enc,
      ),
      sentAt: stamp(row.created_at),
      mine: row.mine,
      read: row.read,
    }),
  );
  return { outcome: { ok: true, value: { messages, more: rows.length > limit } }, rows: page.length };
}

export async function submitImprovement(
  call: WorkCall,
  valid: SubmitImprovementArgs,
): Promise<Done<SubmitImprovementResult>> {
  const id = newId("imp");
  const event = newId("ime");
  const at = (column: string) => ({ table: "ledger.improvements", id, column });
  const eventAt = (column: string) => ({ table: "ledger.improvement_events", id: event, column });
  const sealed = (where: { table: string; id: string; column: string }, text: string | undefined) =>
    text === undefined ? null : sealSummary(call.ctx, call.client.compartments, where, text);
  // Both forms are sealed: the database decides whether this is a new improvement or one more
  // report of an open one, and keeps the form it writes.
  const rows = await call.fn<{ improvement_id: SubmitImprovementResult["improvement"]; merged: boolean }>(SQL.submit, [
    id,
    event,
    valid.requestId,
    await call.session(),
    valid.kind,
    valid.area,
    valid.severity,
    fingerprint(call.ctx.keys, "improvement_title", valid.title),
    sealed(at("title_enc"), valid.title),
    sealed(at("detail_enc"), valid.detail),
    sealed(at("evidence_enc"), valid.evidence),
    sealed(eventAt("note_enc"), valid.detail),
    sealed(eventAt("evidence_enc"), valid.evidence),
  ]);
  if (isRefused(rows)) return refused(rows);
  const [row] = rows;
  if (row === undefined) throw new Unavailable();
  return answered(row.merged ? { improvement: row.improvement_id, merged: true } : { improvement: row.improvement_id });
}

type ImprovementRow = {
  id: string;
  kind: ImprovementView["kind"];
  area: ImprovementView["area"];
  severity: ImprovementView["severity"];
  status: ImprovementView["status"];
  duplicate_of: string | null;
  by_name: string;
  created_at: Date;
  updated_at: Date;
  reports: number;
  compartments: string[];
  title_enc: unknown;
  detail_enc: unknown;
  evidence_enc: unknown;
  assignee_role: string | null;
  cause: string | null;
  cause_state: string | null;
  held_by: string | null;
  held_at: Date | null;
  fix_ref: string | null;
  sort_at: string;
};
type EventRow = {
  id: string;
  created_at: Date;
  by_name: string;
  event: "reported" | "status";
  status: ImprovementView["status"] | null;
  compartments: string[];
  note_enc: unknown;
  evidence_enc: unknown;
};

export async function listImprovements(
  call: WorkCall,
  valid: ListImprovementsArgs,
): Promise<Done<ListImprovementsResult>> {
  const limit = valid.limit ?? 20;
  const after = valid.after === undefined ? null : placeOf(valid.after);
  if (after === undefined) return refused("invalid_request");
  const rows = await call.fn<ImprovementRow>(SQL.list, [
    // Left out, what stands open; one improvement by its id is served whatever its status.
    valid.status ?? (valid.improvement === undefined ? [...OPEN_IMPROVEMENT_STATUSES] : null),
    valid.area ?? null,
    valid.improvement ?? null,
    limit,
    valid.mine ?? false,
    after?.rank ?? null,
    after?.at ?? null,
    after?.id ?? null,
  ]);
  if (isRefused(rows)) return refused(rows);
  const page = rows.slice(0, limit);
  const one = valid.improvement !== undefined && page.length === 1;
  const events = one ? await call.fn<EventRow>(SQL.events, [valid.improvement]) : [];
  if (isRefused(events)) return refused(events);
  const improvements = page.map((row) => {
    const at = (column: string) => ({ table: "ledger.improvements", id: row.id, column });
    const view = {
      id: row.id,
      kind: row.kind,
      area: row.area,
      severity: row.severity,
      status: row.status,
      title: servedOrNull(call.ctx.keys, row.compartments, at("title_enc"), row.title_enc),
      detail: servedOrNull(call.ctx.keys, row.compartments, at("detail_enc"), row.detail_enc),
      evidence: servedOrNull(call.ctx.keys, row.compartments, at("evidence_enc"), row.evidence_enc),
      by: row.by_name,
      reportedAt: stamp(row.created_at),
      updatedAt: stamp(row.updated_at),
      reports: row.reports,
      duplicateOf: row.duplicate_of,
      assigneeRole: row.assignee_role,
      cause: row.cause,
      causeState: row.cause_state,
      heldBy: row.held_by,
      heldAt: stampOrNull(row.held_at),
      fixRef: row.fix_ref,
    } as ImprovementView;
    if (!one) return view;
    const history = events.map((event) => {
      const where = (column: string) => ({ table: "ledger.improvement_events", id: event.id, column });
      return {
        at: stamp(event.created_at),
        by: event.by_name,
        event: event.event,
        status: event.status,
        note: servedOrNull(call.ctx.keys, event.compartments, where("note_enc"), event.note_enc),
        evidence: servedOrNull(call.ctx.keys, event.compartments, where("evidence_enc"), event.evidence_enc),
      } as ImprovementEventView;
    });
    return { ...view, events: history };
  });
  const more = rows.length > limit;
  const last = page.at(-1);
  return {
    outcome: {
      ok: true,
      value: { improvements, more, ...(more && last !== undefined ? { next: placeAfter(last) } : {}) },
    },
    rows: page.length,
  };
}

const RANK: Readonly<Record<string, number>> = { critical: 0, high: 1, medium: 2 };
const PLACE = /^([0-3])\|(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|(imp_[0-9A-HJKMNP-TV-Z]{26})$/;

// A page's `next`: the place of its last row in the list's order (severity, latest change, id), as
// one opaque word. Made of that row alone, which the caller was served.
const placeAfter = (row: ImprovementRow): string =>
  Buffer.from(`${RANK[row.severity] ?? 3}|${row.sort_at}|${row.id}`, "utf8").toString("base64url");

// `after`, read back; undefined for a word that is no place.
function placeOf(after: string): { rank: number; at: string; id: string } | undefined {
  const [, rank, at, id] = PLACE.exec(Buffer.from(after, "base64url").toString("utf8")) ?? [];
  return rank === undefined || at === undefined || id === undefined ? undefined : { rank: Number(rank), at, id };
}

// What the process serving the agent API sees of the box: the holds that stand and the switches it
// can read, as codes, and the commit it was deployed at. Files and a constant: no row, no label.
export type BoxFacts = {
  holds: string[];
  switches: { key: string; value: string }[];
  commit: string;
};

// A stored reading's parts, as served: codes with finite numbers, nothing else.
function servedParts(parts: unknown): Record<string, number> | undefined {
  if (parts === null || typeof parts !== "object") return undefined;
  const kept = Object.entries(parts as Record<string, unknown>).filter(
    (entry): entry is [string, number] =>
      HealthPartKey.safeParse(entry[0]).success && typeof entry[1] === "number" && Number.isFinite(entry[1]),
  );
  return kept.length === 0 ? undefined : Object.fromEntries(kept.slice(0, HEALTH_PARTS_MOST));
}

type HealthRow = {
  section: "reading" | "check" | "job" | "card" | "defects" | "box";
  key: string;
  code: string;
  value: number | null;
  sample: number | null;
  at: Date | null;
  extra: string | null;
  parts: unknown;
};

// get_health: what one definer serves of the system's health, shaped. The healthy line is the
// code's own for the metric, never a stored one. Nothing here is sealed, so nothing is opened.
// `box`: the serving process's own facts, joined to what the definer serves of the box (the
// switches the database holds and the newest migration) only for a caller the definer served a
// reading: the rule the jobs and the checks go by, so a caller cleared for nothing is told nothing.
export async function getHealth(call: WorkCall, box?: () => BoxFacts): Promise<Done<HealthView>> {
  const rows = await call.fn<HealthRow>(SQL.health, []);
  if (isRefused(rows)) return refused(rows);
  const of = (section: HealthRow["section"]) => rows.filter((row) => row.section === section);
  const at = (row: HealthRow) => stamp(row.at as Date);
  const value = {
    measures: of("reading").map((row) => {
      const line = (OUTCOME_THRESHOLDS as Record<string, { test: string; healthy: number }>)[row.key];
      const parts = servedParts(row.parts);
      return {
        metric: row.key,
        state: row.code,
        value: row.value,
        sample: row.sample ?? 0,
        readAt: at(row),
        healthy: line === undefined ? null : { test: line.test, value: line.healthy },
        stale: row.extra === "stale",
        ...(parts === undefined ? {} : { parts }),
      };
    }),
    checks: of("check").map((row) => ({ source: row.key, code: row.code, at: at(row) })),
    jobs: of("job").map((row) => ({ job: row.key, code: row.code, at: at(row), failing: row.sample === 3 })),
    cards: of("card").map((row) => ({ card: row.key, kind: row.code, about: row.extra ?? "", since: at(row) })),
    defects: of("defects").map((row) => ({
      role: row.key === "" ? null : row.key,
      severity: row.code,
      open: row.sample ?? 0,
    })),
    ...(of("reading").length === 0 ? {} : { box: boxOf(of("box"), box?.()) }),
  } as HealthView;
  return { outcome: { ok: true, value }, rows: rows.length };
}

// The box as get_health serves it: the database's switches and migration, then the process's own.
function boxOf(rows: readonly HealthRow[], facts: BoxFacts | undefined): HealthView["box"] {
  const stored = rows.filter((row) => row.key !== "migration").map((row) => ({ key: row.key, value: row.code }));
  return {
    holds: facts?.holds ?? [],
    switches: [...stored, ...(facts?.switches ?? [])],
    commit: facts?.commit ?? "unknown",
    migration: rows.find((row) => row.key === "migration")?.code ?? null,
  } as HealthView["box"];
}

export async function updateImprovement(
  call: WorkCall,
  valid: UpdateImprovementArgs,
): Promise<Done<UpdateImprovementResult>> {
  // A lever no rule reads fixes nothing, so a move of it is never credited as a defect's fix. Decided
  // by the reference alone, before any defect is read.
  if (valid.fixRef?.startsWith("lever:") === true && leverUnread(valid.fixRef.slice("lever:".length)))
    return refusedAs("fix_ref_refused");
  const event = newId("ime");
  // The status event takes the defect's label, so its note is sealed under that label and every
  // reader of the defect opens it. Read first; a defect the caller cannot see has none, and the
  // function below answers for it. A label the call's keys cannot seal under leaves the note out.
  let note: string | null = null;
  let noteDropped = false;
  if (valid.note !== undefined) {
    const labels = await call.fn<{ label: string[] | null }>(SQL.label, [valid.improvement]);
    if (isRefused(labels)) return refused(labels);
    const label = labels[0]?.label ?? null;
    if (label !== null) {
      try {
        note = sealSummary(
          call.ctx,
          label,
          { table: "ledger.improvement_events", id: event, column: "note_enc" },
          valid.note,
        );
      } catch (error) {
        if (!(error instanceof Unavailable)) throw error;
        noteDropped = true;
      }
    }
  }
  const rows = await call.fn<{
    status: ImprovementView["status"] | "closes_by_measure" | "needs_fix_ref" | "fix_ref_refused" | null;
  }>(SQL.update, [
    event,
    valid.improvement,
    valid.requestId,
    await call.session(),
    valid.status,
    valid.duplicateOf ?? null,
    note,
    valid.fixRef ?? null,
  ]);
  if (isRefused(rows)) return refused(rows);
  const status = rows[0]?.status ?? null;
  // A defect the system filed closes when its measure recovers, and is taken with the fix named.
  // And a reference that does not stand: a lever the caller did not move, an operation, a `none:`
  // with any status but triaged.
  if (status === "closes_by_measure" || status === "needs_fix_ref" || status === "fix_ref_refused")
    return refusedAs(status);
  return status === null
    ? refused("not_found")
    : answered({
        improvement: valid.improvement,
        status,
        ...(noteDropped ? { noteDropped: true } : {}),
      } as UpdateImprovementResult);
}
