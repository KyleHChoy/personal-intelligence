import type { Query } from "../core/db.ts";

// The events the owner's commands append to ledger.record_events, each declared once by its row
// kind, its event, who it is by and its code, and written by one function. A declaration that
// leaves its event or its row kind out takes it from the call. `normalise` passes the label through
// ledger.label, which sorts it and keeps each compartment once, where the row's label is not
// already in that form.

export type EventShape = {
  readonly kind?: string;
  readonly event?: string;
  readonly by: string;
  readonly code?: string;
  readonly normalise?: true;
};

const OWNER = "owner";

export const CARD_PENDING: EventShape = { kind: "card", event: "pending", by: OWNER, normalise: true };
export const CARD_DECIDED: EventShape = { kind: "card", event: "decided", by: OWNER, normalise: true };
export const CARD_REOPENED: EventShape = { kind: "card", by: OWNER, normalise: true };
export const CARD_HELD: EventShape = { kind: "card", event: "deferred", by: "system:names" };
// A card withdrawn by one of the owner's passes, which names itself.
export const CARD_WITHDRAWN: EventShape = { kind: "card", event: "withdrawn", by: OWNER, normalise: true };
export const CANARY_WITHDRAWN: EventShape = { kind: "card", event: "withdrawn", by: "system:canary" };
export const RUN_QUEUED: EventShape = { kind: "run", event: "queued", by: OWNER, normalise: true };
export const PROJECT_AREA: EventShape = { kind: "project", event: "updated", by: OWNER, code: "area" };
export const PROJECT_CLOSED: EventShape = { kind: "project", event: "closed", by: OWNER };
export const TASK_NO_GO: EventShape = { kind: "opportunity", event: "no_go", by: OWNER };
export const TASK_GO: EventShape = { kind: "opportunity", event: "go", by: OWNER };
export const TASK_WITHDRAWN: EventShape = {
  kind: "opportunity",
  event: "withdrawn",
  by: OWNER,
  code: "owner_withdrew",
};
export const RESEARCH_WITHDRAWN: EventShape = { kind: "research_request", event: "withdrawn", by: OWNER };
export const HYPOTHESIS_EVENT: EventShape = { kind: "hypothesis", by: OWNER };

// What a call adds to its declaration: the event or row kind the declaration leaves out, who it is
// by where that is a constant of the caller's, a code, and a sealed body.
export type EventExtra = { kind?: string; event?: string; by?: string; code?: string; body?: unknown };

// One event row, in the caller's transaction.
export async function recordEvent(
  query: Query,
  shape: EventShape,
  id: string,
  at: string,
  compartments: readonly string[],
  extra: EventExtra = {},
): Promise<void> {
  const kind = extra.kind ?? shape.kind;
  const event = extra.event ?? shape.event;
  const code = extra.code ?? shape.code;
  if (kind === undefined || event === undefined) throw new Error("recordEvent: no row kind or event");
  const columns = ["row_kind", "row_id", "event", "at", "by", "compartments"];
  const values: unknown[] = [kind, id, event, at, extra.by ?? shape.by, compartments];
  if (code !== undefined) {
    columns.push("code");
    values.push(code);
  }
  if (extra.body !== undefined) {
    columns.push("body_enc");
    values.push(extra.body);
  }
  const params = values.map((_, index) =>
    index === 5 && shape.normalise === true ? `ledger.label($${index + 1})` : `$${index + 1}`,
  );
  await query(`insert into ledger.record_events (${columns.join(", ")}) values (${params.join(", ")})`, values);
}
