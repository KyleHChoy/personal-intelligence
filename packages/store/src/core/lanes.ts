import { CaptureKind, type RetentionClass } from "@intelligence/contracts/personal";
import { type Fixed, type Sql, sql, sqlWords } from "./sql.ts";

// The lanes items arrive and are extracted by, stated once: each Lens capture kind's source kind,
// device account and retention class, and each extraction lane's source kind and due count. Every
// list of kinds or lanes in the store reads these tables.

// A piece the type checker has already held to a literal, as a fragment.
const piece = (text: string): Sql => text as Sql;

// Each Lens capture kind: the source kind its evidence is stored under, the connector of the
// device's source account for it, and the retention class that ages it, with whether that class's
// expiry is built: a task is kept until the owner sets a rule. `scoped`: whether a scope rule may
// name the kind; a task is admitted by the device's task switch.
export const CAPTURE_LANES = {
  meeting: {
    source: "transcript",
    connector: "lens_meetings",
    retention: "capture_transcript",
    expires: true,
    scoped: true,
  },
  moment: {
    source: "screen_activity",
    connector: "lens_activity",
    retention: "capture_moment",
    expires: true,
    scoped: true,
  },
  block: { source: "time_block", connector: "lens_blocks", retention: "capture_block", expires: true, scoped: true },
  task: { source: "owner_task", connector: "lens_tasks", retention: "capture_task", expires: false, scoped: false },
} as const satisfies Record<
  CaptureKind,
  { source: string; connector: string; retention: RetentionClass; expires: boolean; scoped: boolean }
>;
type Lanes = typeof CAPTURE_LANES;

// Every capture kind, in the table's order.
export const CAPTURE_KINDS = CaptureKind.options;
export const isCaptureKind = (value: string): value is CaptureKind => CaptureKind.safeParse(value).success;
// The capture kinds a scope rule may name.
export const SCOPED_KINDS = CAPTURE_KINDS.filter((kind) => CAPTURE_LANES[kind].scoped);
// The source kinds of Lens captures: none is a RawItem.
export const CAPTURE_SOURCE_KINDS = CAPTURE_KINDS.map((kind) => CAPTURE_LANES[kind].source);
// Every capture kind as SQL text literals, for `in (...)`.
export const CAPTURE_KINDS_SQL = sqlWords(CAPTURE_KINDS);
// The connectors of a Lens device's source accounts.
export const LENS_CONNECTORS = CAPTURE_KINDS.map((kind) => CAPTURE_LANES[kind].connector);

// A retention class whose expiry is built, and the capture kind it ages.
export type CaptureClass = {
  [K in CaptureKind]: Lanes[K] extends { expires: true } ? Lanes[K]["retention"] : never;
}[CaptureKind];
export const isBuiltClass = (value: RetentionClass): value is CaptureClass =>
  CAPTURE_KINDS.some((kind) => CAPTURE_LANES[kind].expires && CAPTURE_LANES[kind].retention === value);
export function captureKindOf(value: CaptureClass): CaptureKind {
  const kind = CAPTURE_KINDS.find((one) => CAPTURE_LANES[one].retention === value);
  if (kind === undefined) throw new Error("every built class is a capture kind's");
  return kind;
}
// A capture row's retention class, on a row of knowledge.captures aliased `c`.
export const CAPTURE_RETENTION_CLASS = piece(
  `case c.kind ${CAPTURE_KINDS.map((kind) => `when '${kind}' then '${CAPTURE_LANES[kind].retention}'`).join(" ")} end`,
);

// When a status row leaves its item due at `generation` (a SQL parameter): no row, waiting, or
// another generation unless withheld. On a status row aliased `p`.
export const dueWhen = <G extends string>(generation: Fixed<G>): Sql =>
  sql`(p.evidence_id is null or p.waiting or (p.extractor_generation <> ${piece(generation)} and not p.withheld))`;

// The extraction lanes, each by the source kind of its items, with the count of its items due at
// generation $1, from clear columns alone. Coverage and `pi extract status` count with these.
export const EXTRACTION_LANES = {
  mail: {
    kind: "email",
    due: sql`select count(*) from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id left join vault.pipeline_items p on p.evidence_id = e.id
          where e.source_kind = 'email' and not m.held and ${dueWhen("$1")}`,
  },
  agent: {
    kind: "agent_record",
    due: sql`select count(*) from vault.evidence_items e left join vault.pipeline_items p on p.evidence_id = e.id where e.source_kind = 'agent_record' and not e.typed and ${dueWhen("$1")}`,
  },
  document: {
    kind: "document",
    due: sql`select count(*) from knowledge.documents d left join vault.pipeline_items p on p.evidence_id = d.evidence_id where not d.held and ${dueWhen("$1")}`,
  },
  meeting: {
    kind: CAPTURE_LANES.meeting.source,
    due: sql`select count(*) from knowledge.captures c join vault.evidence_items e on e.id = c.evidence_id left join vault.pipeline_items p on p.evidence_id = e.id
          where c.kind = 'meeting' and e.source_kind = 'transcript' and ${dueWhen("$1")}`,
  },
  moment: {
    kind: CAPTURE_LANES.moment.source,
    due: sql`select count(*) from knowledge.captures c join vault.evidence_items e on e.id = c.evidence_id left join vault.pipeline_items p on p.evidence_id = e.id
          where c.kind = 'moment' and e.source_kind = 'screen_activity' and e.blob_ref is not null and ${dueWhen("$1")}`,
  },
} as const;
