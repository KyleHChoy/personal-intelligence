// agent_bootstrap's my_work section and the handoffs of held work: the work the caller holds under
// a live lease, the work a check-back of its own holds to a date and the work that is its alone to
// claim again, each with its state, its latest progress and the caller's own waiting check-back;
// and the latest handoff note each piece rests on, so an agent that took work over reads what its
// last holder left.

import type { PackItem } from "@intelligence/contracts/personal";
import type { Ctx } from "../core/read-ctx.ts";
import { heldByCaller } from "../core/work-held.ts";
import { progressOf } from "../core/work-progress.ts";
import { opportunityViews } from "../core/work-views.ts";

// The latest handoff note among each piece of work's basis, whoever wrote it, as the record's own
// row policy returns it (its label, its writer's views, no flagged one): hand_off and
// release_opportunity put it there.
export const WORK_HANDOFFS = `
  select distinct on (b.row_id) w.id, w.kind, w.client_name, w.created_at, w.compartments, w.body_enc
  from ledger.basis b
  join ledger.agent_writes w on w.id = b.ref_id
  where b.row_kind = 'opportunity' and b.row_id = any($1) and b.ref_kind = 'agent_record' and w.kind = 'handoff'
  order by b.row_id, w.created_at desc, w.id`;

export type HeldWork = {
  items: PackItem[];
  // The ids of the work held, for its handoffs.
  ids: string[];
  // What each item shows, for the read log: the evidence of the message and event refs of its
  // view and the agent records among them; and the goal ids its view returns.
  shownOf: Map<string, string[]>;
  goalsOf: Map<string, string[]>;
};

export async function heldWork(ctx: Ctx, section: { cap: number; required: boolean }, asOf: string): Promise<HeldWork> {
  // What the caller holds under a live lease, what a check-back of its own holds to a date, and
  // what is its alone to claim again, each with its state.
  const own = await heldByCaller(ctx, null, section.cap);
  const ids = [...own.keys()];
  const held: HeldWork = { items: [], ids, shownOf: new Map(), goalsOf: new Map() };
  if (ids.length === 0) return held;
  const views = await opportunityViews(ctx, ids);
  const progress = await progressOf(ctx, ids);
  for (const id of ids) {
    const built = views.get(id);
    const mine = own.get(id);
    if (built === undefined || mine === undefined) continue;
    const reported = progress.get(id);
    held.items.push({
      id: built.view.id,
      section: "my_work",
      required: section.required,
      provenance: "source",
      asOf,
      kind: "held_work",
      opportunity: reported === undefined ? built.view : { ...built.view, progress: reported },
      // The check-back that waits: one that came due is the brief's to say, at the claim.
      checkBack: mine.checkBack?.waiting === true ? { dueAt: mine.checkBack.dueAt, note: mine.checkBack.note } : null,
      state: mine.state,
    });
    held.shownOf.set(id, built.shown);
    held.goalsOf.set(id, built.goals);
  }
  return held;
}
