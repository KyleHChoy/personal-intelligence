import type { OwnCheckBack, WorkHold } from "@intelligence/contracts/personal";
import { stamp } from "./db.ts";
import { type Ctx, servedOrNull } from "./read-ctx.ts";
import { latestEvent } from "./statements.ts";

// How the caller has each piece of work it holds or held, from its own rows alone: the lease policy
// returns a client its own lease rows, and the intention policy its own check-backs. No other
// client's row is read, so nothing here says what another holds.
//
// This is the one copy of the held rule kept in a statement, on purpose. Every other statement
// asks ledger.work_held; the reader role may not, since the function answers for any client's
// lease, so the caller's own hold is read here from the rows its policies return, by the same
// rule: a live lease, its lapse's 24 hours, a return's preference, or a waiting check-back of its
// own that holds the work. heldState below names the state each of those is.

// The work the caller's own lease row is on, still claimed or back on the board, with that lease's
// times and the caller's own check-back on it: the one that waits (one that holds the work before
// a reminder, then the soonest), else the latest that came due. Only while the caller's hold runs.
const OWN = (where: string): string => `
  select o.id, (${latestEvent("opportunity", "o.id")}) as status,
    l.lease_until >= now() as live,
    l.lease_until >= now() - interval '24 hours' as recent,
    coalesce(l.preferred_until > now(), false) as preferred,
    cb.id as intention, cb.due_at, cb.hold, cb.state as check_back, cb.compartments, cb.body_enc
  from ledger.opportunities o
  join queue.leases l on l.resource_kind = 'opportunity' and l.resource_id = o.id
  left join lateral (
    select i.id, i.due_at, i.hold, i.compartments, i.body_enc, (${latestEvent("intention", "i.id")}) as state
    from ledger.intentions i
    where i.opportunity_id = o.id and i.kind = 'check_back' and i.tainted_at is null
      and i.client_id = (select c.id from policy.current_client() c)
      and (${latestEvent("intention", "i.id")}) in ('set', 'fired')
    order by ((${latestEvent("intention", "i.id")}) = 'set') desc,
      ((${latestEvent("intention", "i.id")}) = 'set' and i.hold) desc,
      case when (${latestEvent("intention", "i.id")}) = 'set' then i.due_at end, i.created_at desc, i.id collate "C" desc
    limit 1) cb on true
  where o.tainted_at is null and ${where}
    and (${latestEvent("opportunity", "o.id")}) in ('claimed', 'go')
    -- The caller's hold still runs (heldState), decided here, before any limit: a lease row whose
    -- hold is over is never read, so stale rows never crowd out the work the caller has.
    and (l.lease_until >= now() - interval '24 hours' or coalesce(l.preferred_until > now(), false)
         or coalesce(cb.state = 'set' and cb.hold, false))
  order by o.id collate "C", l.resource_id collate "C", cb.id collate "C"`;
const OWN_AMONG = OWN("o.id = any($1)");
const OWN_OF_KINDS = `${OWN("o.kind = any($1)")} limit $2`;

type Row = {
  id: string;
  status: "claimed" | "go";
  live: boolean;
  recent: boolean;
  preferred: boolean;
  intention: string | null;
  due_at: Date | null;
  hold: boolean | null;
  check_back: "set" | "fired" | null;
  compartments: string[] | null;
  body_enc: unknown;
};

export type Held = { state: WorkHold; checkBack: OwnCheckBack | null };

// The state of one row, or null where the caller's hold is over: a lease that lapsed over 24 hours
// ago, with no check-back holding the work and no return preferring the caller.
function heldState(
  row: Pick<Row, "status" | "live" | "recent" | "preferred" | "hold" | "check_back">,
): WorkHold | null {
  const holds = row.check_back === "set" && row.hold === true;
  if (row.status === "claimed" && row.live) return holds ? "held_until" : "held";
  if (holds) return "held_until";
  // A check-back of the caller's came due, and its 24 hours still run.
  if (row.status === "go" && row.preferred && row.check_back === "fired") return "returned";
  return row.recent || row.preferred ? "lapsed" : null;
}

function heldOf(ctx: Ctx, rows: readonly Row[]): Map<string, Held> {
  const found = new Map<string, Held>();
  for (const row of rows) {
    const state = heldState(row);
    if (state === null) continue;
    found.set(row.id, {
      state,
      checkBack:
        row.intention === null || row.due_at === null || row.compartments === null
          ? null
          : {
              dueAt: stamp(row.due_at),
              note:
                row.body_enc === null
                  ? null
                  : servedOrNull(
                      ctx.keys,
                      row.compartments,
                      { table: "ledger.intentions", id: row.intention, column: "body_enc" },
                      row.body_enc,
                    ),
              waiting: row.check_back === "set",
              holds: row.check_back === "set" && row.hold === true,
            },
    });
  }
  return found;
}

// Of the work named, what the caller holds or held, by the work's id.
export async function heldAmong(ctx: Ctx, ids: readonly string[]): Promise<Map<string, Held>> {
  return ids.length === 0 ? new Map() : heldOf(ctx, await ctx.run<Row>(OWN_AMONG, [ids]));
}

// All the caller holds or held, of the kinds given (null for any), at most `most` rows read.
export async function heldByCaller(
  ctx: Ctx,
  kinds: readonly string[] | null,
  most: number,
): Promise<Map<string, Held>> {
  const rows =
    kinds === null
      ? await ctx.run<Row>(`${OWN("true")} limit $1`, [most])
      : await ctx.run<Row>(OWN_OF_KINDS, [kinds, most]);
  return heldOf(ctx, rows);
}
