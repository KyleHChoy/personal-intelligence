import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CardId, OpportunityId } from "@intelligence/contracts/personal";
import pg from "pg";
import { type Admin, createAdmin } from "../admin/admin.ts";
import { setTaskTier } from "../admin/admin-tasks.ts";
import type { Query } from "../core/db.ts";
import { createWriter, type Writer } from "../write/writer.ts";
import { testId } from "./clients.ts";
import { queryAs } from "./database.ts";
import { asOwner } from "./pipeline-fixtures.ts";
import { type WorkWorld, withWorkWorld } from "./work-test-world.ts";

// For the tests of a card or a question worked through an agent's task: a work world with the
// owner's Admin (an erasure journal of its own), a writer, the task tier on and the owner's
// entity; and the rows the tick writes for a card: the waiting card, its gap and its task.

export type OwnerWorld = WorkWorld & { owner: Admin; writer: Writer };

const OWN = ["own"];

// `keys`: the key file's compartments. `name`: the journal folder's prefix.
export async function withOwnerWorld(
  keys: string[],
  name: string,
  fn: (w: OwnerWorld) => Promise<void>,
): Promise<void> {
  await withWorkWorld(async (base) => {
    const writer = createWriter({ url: base.db.urls.writer, keys: base.db.keys, log: base.log });
    const journal = join(await mkdtemp(join(tmpdir(), `${name}-`)), "keys.json.erasures");
    const owner = createAdmin({ url: base.db.urls.admin, keys: base.db.keys, log: base.log, journal });
    try {
      await setTaskTier(base.admin, true, new Date());
      const me = testId("ent");
      await base.admin("insert into knowledge.entities (id, kind) values ($1, 'owner')", [me]);
      await base.seed.account(OWN, me);
      await fn({ ...base, owner, writer });
    } finally {
      await writer.close();
      await owner.close();
    }
  }, keys);
}

// One transaction as a role, by its connection string.
export async function asRole<T>(url: string, fn: (query: Query) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("begin");
    const made = await fn(async (text, values) => (await client.query(text, values as unknown[])).rows as never);
    await client.query("commit");
    return made;
  } finally {
    await client.end();
  }
}

// A transaction as the tick's role.
export const asWork = <T>(w: WorkWorld, fn: (query: Query) => Promise<T>): Promise<T> => asRole(w.db.urls.work, fn);

// A waiting card as the tick writes one: its row and its `pending` event, with no body. `days`: its
// expiry.
export async function waitingCard(
  w: WorkWorld,
  kind: string,
  options: string[],
  more: { label?: string[]; author?: string; days?: number; target?: { kind: string; id: string } | null } = {},
): Promise<CardId> {
  const id = testId("crd") as CardId;
  const label = more.label ?? OWN;
  const author = more.author ?? "system:work";
  await asWork(w, async (query) => {
    await query(
      `insert into ledger.cards (id, request_id, created_at, created_by, kind, options, expires_after_days, compartments, target_kind, target_id)
       values ($1, $2, now(), $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        testId("req").slice(4),
        author,
        kind,
        options,
        more.days ?? 30,
        label,
        more.target?.kind ?? null,
        more.target?.id ?? null,
      ],
    );
    await query(
      "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'pending', now(), $2, $3)",
      [id, author, label],
    );
  });
  return id;
}

// The tick's scan for the cards that wait on an agent, as pi_work.
export const cardGaps = (w: WorkWorld, scan: "card_gaps" | "card_relay_gaps", hours: number, at = new Date()) =>
  queryAs<{ subject: string; label: string[]; about_kind: string; source_kind: string }>(
    w.db.urls.work,
    `select subject, label, about_kind, source_kind from ledger.${scan}($1, $2)`,
    [at.toISOString(), hours],
  );

// A card's task raised as the tick raises it: the row the raise answers, its id null when no task
// is raised.
export const raiseCardFlag = (w: WorkWorld, trigger: "card_question" | "card_relay", id: CardId) =>
  queryAs<{ id: string | null }>(
    w.db.urls.work,
    "select ledger.raise_gap_flag($1, $2, $3, 'owner', null, 'card', $3, null, null, true) as id",
    [testId("opp"), trigger, id],
  );

// The same, when a task must be raised.
export async function cardFlag(
  w: WorkWorld,
  trigger: "card_question" | "card_relay",
  id: CardId,
): Promise<OpportunityId> {
  const [row] = await raiseCardFlag(w, trigger, id);
  if (row?.id == null) throw new Error("no flag");
  return row.id as OpportunityId;
}

// A card raised this many minutes ago. As pi_owner: no runtime role may change when a card was
// raised.
export const aged = (w: WorkWorld, id: string, minutes: number): Promise<unknown> =>
  asOwner(w.db, "update ledger.cards set created_at = now() - make_interval(mins => $2) where id = $1", [id, minutes]);
