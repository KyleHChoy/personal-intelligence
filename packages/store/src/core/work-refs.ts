import { createHash } from "node:crypto";
import type { Envelope } from "@intelligence/contracts";
import {
  About,
  type ClientView,
  currentDefinition,
  DECISION_POINT_PINS,
  MoveReportBody,
  OwnerRequestRef,
  type PersonalRunTool,
  type PersonalWorkArgs,
  type PersonalWorkResults,
  type PersonalWorkTool,
  type ReadOutcome,
  type SessionId,
  WorkRef,
  type WorkStateRefusal,
} from "@intelligence/contracts/personal";
import { byText } from "./db.ts";
import { type Ctx, type Run, Unavailable } from "./read-ctx.ts";
import { sealUnder } from "./seal.ts";
import { sql } from "./sql.ts";

// What every work and run tool shares: what a tool's work is given and answers, and what Work hands
// the database for a ref, an `about`, a summary and a point (every argument typed and named, no row
// as JSON), and what it makes of a stored one.

// A move `m` the calling client cleared: its own, which only it may report on.
export const OWN_CLEARED_MOVE = sql`exists (select 1 from ledger.record_events r where r.row_kind = 'move' and r.row_id = m.id and r.event = 'cleared'
                and r.by = 'client:' || (select c.id from policy.current_client() c))`;

// A request id derived from another and a word: its sha256, base64url, cut to `length`. Each
// caller keeps the input and length its stored ids were made with.
export const derivedId = (text: string, length: number): string =>
  createHash("sha256").update(text, "utf8").digest("base64url").slice(0, length);

export const refKinds = (refs: readonly { kind: string; id: string }[]): string[] => refs.map((ref) => ref.kind);
export const refIds = (refs: readonly { kind: string; id: string }[]): string[] => refs.map((ref) => ref.id);

// `about_kind` and `about_id`: the owner has no id.
export const aboutColumns = (about: About): [kind: string, id: string | null] =>
  about.kind === "owner" ? ["owner", null] : [about.kind, about.id];

// A stored ref or `about`, read back through its own schema, so a stored word that is no kind
// of ref is a fault and never served.
export function storedRef(kind: string, id: string): WorkRef {
  const ref = WorkRef.safeParse({ kind, id });
  if (!ref.success) throw new Unavailable();
  return ref.data;
}

// A stored basis ref: a WorkRef, or the owner's request (owner_request), which no tool takes.
export function storedBasisRef(kind: string, id: string): WorkRef | OwnerRequestRef {
  if (kind !== "owner_request") return storedRef(kind, id);
  const ref = OwnerRequestRef.safeParse({ kind, id });
  if (!ref.success) throw new Unavailable();
  return ref.data;
}

export function storedAbout(kind: string, id: string | null): About {
  const about = About.safeParse(kind === "owner" ? { kind } : { kind, id });
  if (!about.success) throw new Unavailable();
  return about.data;
}

// A summary sealed under the caller's clearance, sorted, each once (the label the function
// writes, `ledger.label`), and bound to the row and column it will be stored in. A compartment
// whose key the key file lacks is refused before any key is tried, and the call is unavailable.
export function sealSummary(
  ctx: Ctx,
  clearance: readonly string[],
  at: { table: string; id: string; column: string },
  text: string,
): string {
  const label = [...new Set(clearance)].sort();
  let sealed: Envelope;
  try {
    sealed = sealUnder(ctx.keys, label, at, text);
  } catch {
    throw new Unavailable();
  }
  return JSON.stringify(sealed);
}

// A refusal a function answered by raising: no current client, a tool, view, kind or session
// that is not the caller's (42501); an argument it refuses (22023); a role no active agent holds
// (PIW04).
export type Refused = "not_permitted" | "invalid_request" | "unknown_role";
const REFUSALS: Readonly<Record<string, Refused>> = {
  "42501": "not_permitted",
  "22023": "invalid_request",
  PIW04: "unknown_role",
};

// What a tool's work is given: its client, its Ctx, its session, and the one way it calls a
// function.
export type WorkCall = {
  client: ClientView;
  ctx: Ctx;
  session: () => Promise<SessionId>;
  // One statement under a savepoint: a refusal it raises is answered and the transaction goes
  // on, so the call still writes its call log row. Anything else fails the call.
  fn<Row>(text: string, values: unknown[]): Promise<Row[] | Refused>;
};

const SAVEPOINT = "savepoint work_call";
const RELEASE = "release savepoint work_call";
const ROLLBACK = "rollback to savepoint work_call";

// A call's `fn` over its transaction's `run`: Work's for every tool, and the project_brief pack's,
// which reads as get_project does.
export function functionCall(run: Run): WorkCall["fn"] {
  return async <Row>(text: string, values: unknown[]): Promise<Row[] | Refused> => {
    await run(SAVEPOINT, []);
    try {
      const rows = await run<Row>(text, values);
      await run(RELEASE, []);
      return rows;
    } catch (error) {
      // Only a work function's own `raise`: the server refusing the statement itself (a grant
      // that is missing) is a fault, and fails the call.
      const code =
        error instanceof Unavailable && error.raised && error.sqlstate !== undefined
          ? REFUSALS[error.sqlstate]
          : undefined;
      if (code === undefined) throw error;
      await run(ROLLBACK, []);
      return code;
    }
  };
}

// A tool's answer, the rows the call log counts for it, the evidence and agent record ids it
// returned and the goal ids, which the read log records so taint and audit follow everything an
// agent saw. `refused` is an answer that records nothing, whose call row says invalid_request.
// `unlogged` is a first step whose call a second transaction logs: next_run's take.
export type Done<T> = {
  outcome: ReadOutcome<T>;
  rows: number;
  shown?: string[];
  // Evidence a later write is bound to, as a read tool binds a contact's links.
  bound?: string[];
  goals?: string[];
  refused?: true;
  unlogged?: true;
};

export const refused = <T>(code: "not_found" | Refused): Done<T> => ({ outcome: { ok: false, code }, rows: 0 });
// A not_found on work the caller sees, naming the step it is missing.
export const refusedAs = <T>(refusal: WorkStateRefusal): Done<T> => ({
  outcome: { ok: false, code: "not_found", refusal },
  rows: 0,
});
// An invalid_request on work the caller holds or sees, naming which argument is at fault.
export const invalidAs = <T>(refusal: WorkStateRefusal): Done<T> => ({
  outcome: { ok: false, code: "invalid_request", refusal },
  rows: 0,
});
export const answered = <T>(value: T, shown: string[] = [], goals: string[] = []): Done<T> => ({
  outcome: { ok: true, value },
  rows: 1,
  shown,
  goals,
});

export type WorkTool = PersonalWorkTool | PersonalRunTool;
// A tool's parsed arguments and its result, as its schemas give them. The store names no schema
// library.
export type Args<T extends WorkTool> = NonNullable<ReturnType<(typeof PersonalWorkArgs)[T]["safeParse"]>["data"]>;
export type Result<T extends WorkTool> = NonNullable<ReturnType<(typeof PersonalWorkResults)[T]["safeParse"]>["data"]>;
// A tool's work, and the lesson ids its briefs served, which its read log row records.
export type Briefed<R> = Done<R> & { lessons?: string[] };

export const isRefused = (value: unknown): value is Refused =>
  value === "not_permitted" || value === "invalid_request" || value === "unknown_role";

export const value = <Row, K extends keyof Row>(rows: Row[], key: K): Row[K] | null => rows[0]?.[key] ?? null;

// The goal ids among refs a tool returns, each once; a handle is none.
export const goalIds = (refs: readonly ({ kind: string; id?: unknown } | null | undefined)[]): string[] =>
  [
    ...new Set(
      refs.flatMap((ref) =>
        ref?.kind === "goal" && typeof ref.id === "string" && ref.id.startsWith("gol_") ? [ref.id] : [],
      ),
    ),
  ].sort(byText);

// A point's version and its pinned hash, from the contracts: the function writes them on the
// call row it makes.
export function pinned(point: "move_clear" | "run_outcome" | "draft_disclosure" | "task_go"): {
  version: number;
  hash: string;
} {
  return pinnedAt(point, currentDefinition(point).version);
}

// A point's pinned hash at one version: a run is recorded under the definition it was queued with.
export function pinnedAt(
  point: "move_clear" | "run_outcome" | "draft_disclosure" | "task_go",
  version: number,
): { version: number; hash: string } {
  const hash = DECISION_POINT_PINS[`${point}@${version}`];
  if (hash === undefined) throw new Error(`no pinned definition for ${point}@${version}`);
  return { version, hash };
}

// A move report's opened text as a reader shows it: MoveReportBody when it is one, else a summary,
// as older reports were sealed.
export function openedReport(text: string): MoveReportBody {
  try {
    const parsed = MoveReportBody.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
  } catch {
    // Not JSON: a summary.
  }
  return { v: 1, summary: text, marks: [] };
}
