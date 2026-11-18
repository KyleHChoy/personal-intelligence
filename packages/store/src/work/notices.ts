import { randomBytes } from "node:crypto";
import {
  AgentMessageNotice,
  type ClientId,
  CodedError,
  GapBatchNotice,
  HealthNotice,
  type PersonalLogger,
  type RulingId,
  WorkNotice,
  type WorkNoticeCode,
  type WorkNoticeId,
  type WorkNoticeState,
} from "@intelligence/contracts/personal";
import { type Query, stamp, stampOrNull } from "../core/db.ts";
import { newId } from "../core/ids.ts";
import { createDb } from "../core/job-db.ts";
import { writeDecision } from "../core/queue.ts";
import { KILL_SWITCH_STATE } from "../core/statements.ts";
import { type AgentWriteListener, listenChannel } from "./wake.ts";

// Work notices by webhook. The owner's side, as pi_admin in the caller's transaction: an agent's address,
// set and removed, each the owner's decision. The sender's side, as pi_notify: the notices due, a notice's
// delivery written back, whether one still stands, and the kill switch. Ids, codes, counts, times and the
// addresses only: a notice's body is built from its row alone, and nothing here reads a label's content.

// The channel the notice function notifies on commit, with an empty payload.
const NOTICE_CHANNEL = "pi_work_notice";

// Owner side.

const decide = (query: Query, kind: "webhook_set" | "webhook_removed", client: string, now: Date): Promise<RulingId> =>
  writeDecision(
    query,
    {
      id: newId("rul") as RulingId,
      requestId: randomBytes(16).toString("base64url"),
      kind,
      target: { kind: "client", id: client },
      answer: null,
      card: null,
      supersedes: null,
      batch: false,
      labels: [],
      details: {},
      compartments: ["own"],
    },
    { now },
  );

// An active agent's address, set or replaced. The address is checked by the caller (pi's
// checkAddress) before this runs; the table's check holds its outline. Throws not_found for a name
// that is no active agent. Answers the client's id, for the wrapper's secret step.
export async function setWebhook(query: Query, name: string, address: string, now: Date): Promise<ClientId> {
  const [client] = await query<{ id: ClientId }>(
    "select id from policy.clients where name = $1 and status = 'active' and kind = 'agent' for update",
    [name],
  );
  if (client === undefined) throw new CodedError("not_found");
  const ruling = await decide(query, "webhook_set", client.id, now);
  await query(
    `insert into policy.client_webhooks (client_id, address, set_at, ruling_id) values ($1, $2, $3, $4)
     on conflict (client_id) do update set address = excluded.address, set_at = excluded.set_at, ruling_id = excluded.ruling_id`,
    [client.id, address, stamp(now), ruling],
  );
  return client.id;
}

// The address removed, the owner's decision written; false when the client had none. Throws
// not_found for a name that is no client. `revoke` removes it too, in its own transaction.
export async function removeWebhook(
  query: Query,
  name: string,
  now: Date,
  options: { revoked?: boolean } = {},
): Promise<{ client: ClientId; removed: boolean }> {
  // `pia clients webhook rm` names an active client; `revoke` removes the address of the one it
  // just revoked.
  const [client] = await query<{ id: ClientId }>(
    `select id from policy.clients where name = $1 and status = $2 for update`,
    [name, options.revoked === true ? "revoked" : "active"],
  );
  if (client === undefined) throw new CodedError("not_found");
  const deleted = await query("delete from policy.client_webhooks where client_id = $1 returning client_id", [
    client.id,
  ]);
  if (deleted.length > 0) await decide(query, "webhook_removed", client.id, now);
  return { client: client.id, removed: deleted.length > 0 };
}

// `pia work report`'s counts: notices by event and state, the notice function's failures, and
// declines in force and expired.
export type NoticeCounts = {
  notices: Record<string, number>;
  errors: number;
  declines: { inForce: number; expired: number };
  // What agents' messages cost in pings: a reply loop shows here as many messages and few pings.
  messages: { posted: number; pinged: number };
};
export async function noticeCounts(query: Query, since: Date): Promise<NoticeCounts> {
  const rows = await query<{ event: string | null; state: string; n: number }>(
    `select event, state, count(*)::int as n from ledger.work_notices where created_at >= $1 group by event, state
     union all select event, state, count(*)::int from ledger.batch_notices where created_at >= $1 group by event, state
     order by 1, 2`,
    [stamp(since)],
  );
  const [declines] = await query<{ in_force: number; expired: number }>(
    "select count(*) filter (where expires_at > now())::int as in_force, count(*) filter (where expires_at <= now())::int as expired from ledger.work_declines",
  );
  const [messages] = await query<{ posted: number; pinged: number }>(
    `select (select count(*)::int from ledger.agent_messages m where m.created_at >= $1 and not policy.is_restricted(m.compartments)) as posted,
       (select count(*)::int from ledger.batch_notices b where b.event = 'agent_message' and b.created_at >= $1) as pinged`,
    [stamp(since)],
  );
  return {
    messages: { posted: messages?.posted ?? 0, pinged: messages?.pinged ?? 0 },
    notices: Object.fromEntries(
      rows.filter((row) => row.event !== null).map((row) => [`${row.event}_${row.state}`, row.n]),
    ),
    errors: rows.filter((row) => row.event === null).reduce((sum, row) => sum + row.n, 0),
    declines: { inForce: declines?.in_force ?? 0, expired: declines?.expired ?? 0 },
  };
}

// Sender side.

// One notice due: its body, its client, the client's address when one is set, and how many times it
// was tried. A box health card's notice, from ledger.health_notices, is sent the same way.
type DueNotice = {
  notice: WorkNotice | HealthNotice | GapBatchNotice | AgentMessageNotice;
  client: ClientId;
  address: string | null;
  attempts: number;
};
type NoticeChange = {
  state: WorkNoticeState;
  attempts: number;
  lastCode: WorkNoticeCode | null;
  nextTryAt: Date;
  deliveredAt: Date | null;
};

type DueRow = {
  id: WorkNoticeId;
  client_id: ClientId;
  opportunity_id: string;
  event: string;
  tier: string;
  kind: string;
  role: string | null;
  created_at: Date;
  due_at: Date | null;
  attempts: number;
  address: string | null;
  // An outcome notice's link, its kind and the item it rests on.
  outcome_kind: string | null;
  outcome_link_id: string | null;
  outcome_ref_kind: string | null;
  outcome_ref_id: string | null;
};

export type Notices = {
  // The pending notices whose next try is due, oldest first, each client's in order. A row with no
  // client is never selected.
  due(now: Date, busy?: readonly ClientId[], limit?: number): Promise<DueNotice[]>;
  // ledger.notice_current: whether the notice's item is still the client's to take.
  current(id: WorkNoticeId): Promise<boolean>;
  mark(id: WorkNoticeId, change: NoticeChange): Promise<void>;
  killSwitch(): Promise<boolean>;
  ping(): Promise<void>;
  close(): Promise<void>;
};

// A due row as the notice to send, or none when it is off the schema: the schema is the egress check.
function dueOf(
  log: PersonalLogger,
  row: { id: WorkNoticeId; client_id: ClientId; address: string | null; attempts: number },
  notice: { success: true; data: DueNotice["notice"] } | { success: false },
): DueNotice[] {
  if (!notice.success) {
    log.warn({ event: "notify_failed", code: "bad_notice", ids: { notice: row.id } });
    return [];
  }
  return [{ notice: notice.data, client: row.client_id, address: row.address, attempts: row.attempts }];
}

export function createNotices(url: string, log: PersonalLogger): Notices {
  const db = createDb(url, log);
  return {
    async due(now, busy = [], limit = 200) {
      // The knowledge gaps whose hour has come fold into each client's one ping, then go as any notice does.
      await db.query("select ledger.roll_ping_batches($1)", [stamp(now)]);
      const rows = await db.query<DueRow>(
        `select n.id, n.client_id, n.opportunity_id, n.event, n.tier, n.kind, n.role, n.created_at, n.due_at, n.attempts, w.address,
           n.outcome_kind, n.outcome_link_id::text, n.outcome_ref_kind, n.outcome_ref_id
         from ledger.work_notices n left join policy.client_webhooks w on w.client_id = n.client_id
         where n.client_id is not null and n.state = 'pending' and not n.batched and n.next_try_at <= $1 and not (n.client_id = any ($3::text[]))
         order by n.created_at, n.id collate "C" limit $2`,
        [stamp(now), limit, busy],
      );
      const work: DueNotice[] = rows.flatMap((row) => {
        const notice = WorkNotice.safeParse({
          notice: row.id,
          event: row.event,
          opportunity: row.opportunity_id,
          tier: row.tier,
          kind: row.kind,
          role: row.role,
          at: stamp(row.created_at),
          deadline: stampOrNull(row.due_at),
          ...(row.outcome_kind === null
            ? {}
            : {
                outcome: {
                  kind: row.outcome_kind,
                  link: Number(row.outcome_link_id),
                  evidence:
                    row.outcome_ref_kind === null ? null : { kind: row.outcome_ref_kind, id: row.outcome_ref_id },
                },
              }),
        });
        return dueOf(log, row, notice);
      });
      // The box health notices due, after the work notices of this page, in the same room the limit
      // leaves.
      const health = await db.query<{
        id: WorkNoticeId;
        client_id: ClientId;
        card_id: string;
        kind: string;
        about: string;
        created_at: Date;
        attempts: number;
        address: string | null;
      }>(
        `select n.id, n.client_id, n.card_id, n.kind, n.about, n.created_at, n.attempts, w.address
         from ledger.health_notices n left join policy.client_webhooks w on w.client_id = n.client_id
         where n.state = 'pending' and n.next_try_at <= $1 and not (n.client_id = any ($3::text[]))
         order by n.created_at, n.id collate "C" limit $2`,
        [stamp(now), Math.max(0, limit - rows.length), busy],
      );
      const healthDue = health.flatMap((row) => {
        const notice = HealthNotice.safeParse({
          notice: row.id,
          event: "box_health",
          card: row.card_id,
          kind: row.kind,
          about: row.about,
          at: stamp(row.created_at),
        });
        return dueOf(log, row, notice);
      });
      const batches = await db.query<{
        id: WorkNoticeId;
        client_id: ClientId;
        event: string;
        count: number;
        created_at: Date;
        attempts: number;
        address: string | null;
      }>(
        `select n.id, n.client_id, n.event, n.count, n.created_at, n.attempts, w.address
         from ledger.batch_notices n left join policy.client_webhooks w on w.client_id = n.client_id
         where n.state = 'pending' and n.next_try_at <= $1 and not (n.client_id = any ($2::text[]))
         order by n.created_at, n.id collate "C"`,
        [stamp(now), busy],
      );
      const batchDue = batches.flatMap((row) => {
        const notice =
          row.event === "agent_message"
            ? AgentMessageNotice.safeParse({ notice: row.id, event: "agent_message", at: stamp(row.created_at) })
            : GapBatchNotice.safeParse({
                notice: row.id,
                event: "gap_batch",
                count: row.count,
                at: stamp(row.created_at),
              });
        return dueOf(log, row, notice);
      });
      return [...work, ...healthDue, ...batchDue];
    },
    async current(id) {
      // An id is in one table alone; each function answers false for one it does not hold.
      const [row] = await db.query<{ current: boolean }>(
        "select ledger.notice_current($1) or ledger.health_notice_current($1) or ledger.batch_notice_current($1) as current",
        [id],
      );
      return row?.current === true;
    },
    async mark(id, change) {
      // Only a pending notice moves: one a taint made stale, or another sweep settled, stays.
      const values = [
        id,
        change.state,
        change.attempts,
        change.lastCode,
        stamp(change.nextTryAt),
        change.deliveredAt === null ? null : stamp(change.deliveredAt),
      ];
      for (const table of ["ledger.work_notices", "ledger.health_notices", "ledger.batch_notices"])
        await db.query(
          `update ${table} set state = $2, attempts = $3, last_code = $4, next_try_at = $5, delivered_at = $6 where id = $1 and state = 'pending'`,
          values,
        );
    },
    async killSwitch() {
      const [row] = await db.query<{ state: string }>(KILL_SWITCH_STATE);
      return row?.state === "on";
    },
    async ping() {
      await db.query("select 1");
    },
    close: () => db.close(),
  };
}

// The sender's wake: one connection of its own listening on NOTICE_CHANNEL.
export const listenNotices = (
  url: string,
  log: PersonalLogger,
  handlers: { onNotice(): void; onLost(): void },
): Promise<AgentWriteListener> => listenChannel(NOTICE_CHANNEL, url, log, handlers);
