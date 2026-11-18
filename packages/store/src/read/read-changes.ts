import type { Envelope } from "@intelligence/contracts";
import {
  CHANGES_DEFAULT,
  CHANGES_MOST,
  type ChangesView,
  type ChangeView,
  type ClientName,
  type ClientView,
  GetChangesArgs,
  type MessageChange,
  type NextMove,
  RoleName,
  type SignalChange,
  type SignalKey,
  SignalKind,
  type SignalSource,
  type WorkChange,
  type WriteBackChange,
  type WriteBackState,
} from "@intelligence/contracts/personal";
import { DAY_MS, sha256 } from "@intelligence/personal-core";
import { byText, stamp } from "../core/db.ts";
import { type Ctx, type ReadSet, Unavailable } from "../core/read-ctx.ts";
import { parsed, type ReadTool } from "../core/read-tool.ts";
import { servedOrNone } from "../core/served.ts";
import { ownerTimeZone } from "../core/zone.ts";
import { nextAccess, readsFindings, recentFindings } from "./read-findings.ts";
import { groupWho } from "./read-group-who.ts";
import { loadGroups } from "./read-groups.ts";
import { MARKS_ON, nextMovesOf } from "./read-next.ts";
import { openItemsOf } from "./read-open-items.ts";

// get_changes: what changed since this client last read, as typed signals with their sources and no
// ranking, and what other agents wrote back. Every signal is computed now under the caller's token,
// so a row it cannot see moves nothing it reads (invariant 6). ledger.change_log keeps what this client
// was told, by digest, so the feed's order is one stable key per client and what it was told of and no
// longer holds can be said to have cleared. No model.

// How far back a person counts as new, and a write-back as news.
const NEW_PERSON_DAYS = 7;
const WRITE_BACK_DAYS = 30;
const GAPS_READ = 30;
const PEOPLE_READ = 20;
const MARKS_READ = 30;

// The knowledge gaps on the board this client may read, the newest first.
const OPEN_GAPS = `
  select o.id, o.gap_trigger, o.created_at, o.due_at
  from ledger.opportunities o
  where o.tier = 'task' and o.gap_trigger is not null and o.tainted_at is null
    and (select r.event from ledger.record_events r where r.row_kind = 'opportunity' and r.row_id = o.id
         order by r.id desc limit 1) = 'go'
  order by o.created_at desc, o.id
  limit $1`;

// People who first appeared lately and wrote to the owner in person, as the caller may see them.
const NEW_PEOPLE = `
  select x.id, x.first_at, x.evidence_id from (
    select distinct on (i.entity_id) i.entity_id as id, i.occurred_at as first_at, i.evidence_id
    from knowledge.interaction_log i
    join knowledge.entities e on e.id = i.entity_id and e.kind = 'person'
    join knowledge.messages m on m.evidence_id = i.evidence_id and not m.held and not m.bulk
    where i.occurred_at >= $1 and i.entity_role = 'sender' and i.direction = 'inbound'
      and not exists (select 1 from knowledge.interaction_log o where o.entity_id = i.entity_id and o.occurred_at < $1)
    order by i.entity_id, i.occurred_at, i.id
  ) x
  order by x.first_at desc, x.id
  limit $2`;

// What other agents wrote back lately, as the caller may see them.
const OTHERS_MARKS = `
  select m.id, m.client_name, m.created_at, m.compartments, m.ref_kind, m.ref_id, m.state, m.note_enc
  from ledger.signal_marks m
  where m.tainted_at is null and m.client_id <> $1 and m.created_at >= $2
  order by m.created_at desc, m.id
  limit $3`;

const digest = (text: string, length: number): string => sha256(text).slice(0, length);
const keyOf = (kind: string, source: SignalSource | { kind: string; id: string }): SignalKey =>
  `sig_${digest(`${kind}\n${source.kind}\n${source.id}`, 32)}` as SignalKey;
// A gap task's key. `pi outcomes` computes the same in SQL (admin-outcomes-seam.ts), so a task read
// here and claimed is one signal there.
export const gapSignalKey = (opportunity: string): SignalKey => keyOf("gap", { kind: "opportunity", id: opportunity });
const printOf = (signal: Omit<SignalChange, "why" | "what" | "who">): string =>
  digest(
    [signal.at, signal.state ?? "", signal.moving === true ? "moving" : "", signal.asks === true ? "asks" : ""].join(
      "\n",
    ),
    32,
  );

// A time a signal is dated by: a date alone as the start of that day, none as now.
const stampOf = (at: string | null, now: Date): string =>
  at === null ? stamp(now) : at.length === 10 ? stamp(new Date(`${at}T00:00:00Z`)) : at;

const KIND_OF_MOVE: Partial<Record<NextMove["kind"], SignalChange["kind"]>> = {
  overdue: "overdue",
  due_soon: "due_soon",
  reply: "reply_waiting",
};

// A signal's role, when the owner's settings give its kind one.
const roleOf = (role: string | undefined): { role?: NonNullable<SignalChange["role"]> } =>
  role === undefined ? {} : { role: role as NonNullable<SignalChange["role"]> };

function signalOfMove(move: NextMove, now: Date, roles: ReadonlyMap<string, string>): SignalChange | null {
  const kind = move.kind === "meeting" ? (move.moving === true ? "meeting_moved" : null) : KIND_OF_MOVE[move.kind];
  if (kind === null || kind === undefined || move.source.kind === "goal") return null;
  const source = move.source as SignalSource;
  return {
    change: "signal",
    key: keyOf(kind, source),
    kind,
    at: stampOf(move.at, now) as SignalChange["at"],
    what: move.what,
    why: move.why,
    source,
    ...(move.who === undefined ? {} : { who: move.who }),
    ...(move.moving === true ? { moving: true as const } : {}),
    ...(move.asks === true ? { asks: true as const } : {}),
    ...(move.state === undefined ? {} : { state: move.state }),
    ...roleOf(roles.get(kind)),
  };
}

// The cursor: where the feed read to, opaque to a client.
const cursorOf = (at: string, key: string): string => Buffer.from(`${at}\n${key}`, "utf8").toString("base64url");
function readCursor(text: string | undefined): { at: string; key: string } | null | "bad" {
  if (text === undefined) return null;
  const [at, key, ...rest] = Buffer.from(text, "base64url").toString("utf8").split("\n");
  return at === undefined ||
    key === undefined ||
    rest.length > 0 ||
    Number.isNaN(Date.parse(at)) ||
    !/^sig_[0-9a-f]{32}$/.test(key)
    ? "bad"
    : { at, key };
}

type GapRow = { id: string; gap_trigger: string; created_at: Date; due_at: Date | null };
type PersonRow = { id: string; first_at: Date; evidence_id: string };
type MarkRow = {
  id: string;
  client_name: ClientName;
  created_at: Date;
  compartments: string[];
  ref_kind: SignalSource["kind"];
  ref_id: string;
  state: WriteBackState;
  note_enc: Envelope | null;
};
type FeedRow = {
  signal_key: SignalKey;
  kind: string;
  print: string;
  signal_at: Date;
  logged_at: string;
  ref_id: string | null;
};

const FEED = `select signal_key, kind, print, signal_at, logged_at, ref_id
  from ledger.change_feed($1::text[], $2::text[], $3::text[], $4::timestamptz[], $5, $6::timestamptz, $7::text, $8, $9)`;

// The feed past `after`, at most `limit`: with `computed`, the signals this read computed are logged
// first, and what a complete read no longer holds is cleared.
const feedOf = (
  ctx: Ctx,
  after: { at: string; key: string } | null,
  limit: number,
  computed: { entries: readonly FeedEntry[]; complete: boolean } | null,
): Promise<FeedRow[]> =>
  ctx.run<FeedRow>(FEED, [
    computed?.entries.map((one) => one.key) ?? [],
    computed?.entries.map((one) => one.kind) ?? [],
    computed?.entries.map((one) => one.print) ?? [],
    computed?.entries.map((one) => one.at) ?? [],
    computed?.complete ?? false,
    after?.at ?? null,
    after?.key ?? null,
    limit,
    computed !== null,
  ]);

const QUICK = "select ledger.changes_quick($1::timestamptz, $2::text) as full";
// The count's cheap step: it is rolled back, so it never moves the client's `polled_at`, and
// without a bound each board read of a client that seldom polls would look over days of messages
// and work again. It looks back this long, and counts what the log already holds beside.
const WAITING_LOOK_BACK = "24 hours";
const QUICK_BOUNDED = "select ledger.changes_quick($1::timestamptz, $2::text, $3::interval) as full";

// How many changes wait in this client's feed past where it last read, for the board and the
// inbox to say: what get_changes' cheap step would serve it now, by that
// step's own two functions under the caller's token, so the count is over the caller's own feed
// and nothing else: the messages and the work newly the caller's in the last day, and whatever its
// log already held; no typed signal is computed, so it is a floor. Both run inside a savepoint that is rolled back: nothing is logged, no poll
// is recorded and the cursor does not move, so counting marks nothing read. CHANGES_MOST stands
// for that many or more. Null for a client with no feed; and, under a snapshot, when a poll of
// this client's own committed since, which makes the log's upsert a serialization failure: the
// count is left out that once.
export async function changesWaiting(ctx: Ctx, client: ClientView): Promise<number | null> {
  if (!client.tools.includes("get_changes")) return null;
  await ctx.run("savepoint changes_waiting", []);
  try {
    await ctx.run(QUICK_BOUNDED, [null, null, WAITING_LOOK_BACK]);
    const rows = await feedOf(ctx, null, CHANGES_MOST, null);
    return Math.min(rows.length, CHANGES_MOST);
  } catch (error) {
    if (!(error instanceof Unavailable) || error.sqlstate !== "40001") throw error;
    return null;
  } finally {
    await ctx.run("rollback to savepoint changes_waiting", []);
    await ctx.run("release savepoint changes_waiting", []);
  }
}

// One page of the log: a row with an id stands alone, and a signal is served as computed in this read.
function served(
  rows: readonly FeedRow[],
  limit: number,
  since: string | undefined,
  found: ReadonlyMap<string, SignalChange | WriteBackChange>,
): { value: ChangesView; rows: number; read: ReadSet } {
  const page = rows.slice(0, limit);
  const changes: ChangeView[] = page.flatMap((row): ChangeView[] => {
    const at = stamp(row.signal_at);
    if (row.print === "cleared") return [{ change: "cleared", key: row.signal_key, at }];
    if (row.ref_id !== null && row.kind === "message")
      return [{ change: "message", key: row.signal_key, at, id: row.ref_id as MessageChange["id"] }];
    if (row.ref_id !== null && row.kind === "work")
      return [{ change: "work", key: row.signal_key, at, id: row.ref_id as WorkChange["id"] }];
    const one = found.get(row.signal_key);
    // Past the cursor, and not in what this read computed: said, never lost. It may hold still, cut from the read.
    return [one ?? { change: "cleared", key: row.signal_key, at, unsure: true as const }];
  });
  const last = page.at(-1);
  return {
    value: {
      changes,
      cursor: last === undefined ? (since ?? null) : cursorOf(last.logged_at, last.signal_key),
      more: rows.length > limit,
    },
    // An empty poll counts nothing against the client's rows.
    rows: changes.length,
    read: { bound: [], shown: [], factKeyFps: [] },
  };
}

// The kinds the owner gave a role to, each a signal kind and a role name.
async function signalRolesOf(ctx: Ctx): Promise<Map<string, string>> {
  const [configured] = await ctx.run<{ roles: Record<string, unknown> }>("select ledger.signal_roles() as roles", []);
  return new Map(
    Object.entries(configured?.roles ?? {}).filter(
      ([kind, role]) => SignalKind.safeParse(kind).success && RoleName.safeParse(role).success,
    ) as [string, string][],
  );
}

// What other agents wrote back lately, by signal key.
async function writeBacksOf(ctx: Ctx, client: string, now: Date): Promise<Map<string, WriteBackChange>> {
  const marks = await ctx.run<MarkRow>(OTHERS_MARKS, [
    client,
    new Date(now.getTime() - WRITE_BACK_DAYS * DAY_MS).toISOString(),
    MARKS_READ,
  ]);
  const wrote = new Map<string, WriteBackChange>();
  for (const row of marks) {
    const key = keyOf("write_back", { kind: row.ref_kind, id: row.id });
    const note = servedOrNone(ctx, row, "ledger.signal_marks.note_enc");
    wrote.set(key, {
      change: "write_back",
      key,
      at: stamp(row.created_at),
      by: row.client_name,
      state: row.state,
      note,
      source: { kind: row.ref_kind, id: row.ref_id } as SignalSource,
    });
  }
  return wrote;
}

// Each computed signal and write-back as the feed logs it: its key, kind, print and time.
type FeedEntry = { key: string; kind: string; print: string; at: string };
const feedEntries = (
  signals: ReadonlyMap<string, SignalChange>,
  wrote: ReadonlyMap<string, WriteBackChange>,
): FeedEntry[] => [
  ...[...signals.values()].map((signal) => ({
    key: signal.key,
    kind: signal.kind,
    print: printOf(signal),
    at: signal.at,
  })),
  ...[...wrote.values()].map((one) => ({
    key: one.key,
    kind: "write_back",
    print: digest(`${one.at}\n${one.state}`, 32),
    at: one.at,
  })),
];

export const GET_CHANGES_TOOL: ReadTool<GetChangesArgs, ChangesView> = {
  tool: "get_changes",
  // Read committed: two reads by one client wait on its lock, and each statement then sees what the other wrote,
  // where a repeatable-read snapshot would be taken before the lock was granted.
  isolation: "committed",
  parse: (args) => parsed(GetChangesArgs.safeParse(args)),
  work: async (ctx: Ctx, valid, client: ClientView, env) => {
    const after = readCursor(valid.since);
    if (after === "bad") return "invalid_request";
    const limit = valid.limit ?? CHANGES_DEFAULT;
    // The cheap step: messages and work by id, nothing opened. An empty poll ends here, within five minutes
    // of the signals last being computed.
    const [quick] = await ctx.run<{ full: boolean }>(QUICK, [after?.at ?? null, after?.key ?? null]);
    if (quick?.full !== true) return served(await feedOf(ctx, after, limit, null), limit, valid.since, new Map());
    const now = env.now();
    const mail = client.views.includes("people");
    const work = client.views.includes("work") && client.tools.includes("list_opportunities");
    const zone = await ownerTimeZone(ctx);
    const open = await openItemsOf(ctx, client.views, now, "fresh");
    const next = await nextMovesOf(ctx, now, {
      ...nextAccess(client.views, client.tools),
      open,
      findings: readsFindings(client.views, client.tools) ? await recentFindings(ctx, now) : [],
      zone,
      whole: true,
      marks: true,
      feed: true,
    });
    const roles = await signalRolesOf(ctx);

    const signals = new Map<string, SignalChange>();
    const moveOf = new Map<string, NextMove>();
    for (const move of next.value.moves) {
      const signal = signalOfMove(move, now, roles);
      if (signal === null) continue;
      signals.set(signal.key, signal);
      moveOf.set(signal.key, move);
    }
    const shownOf = new Map<string, string>();

    const gaps = work ? await ctx.run<GapRow>(OPEN_GAPS, [GAPS_READ + 1]) : [];
    const people = mail
      ? await ctx.run<PersonRow>(NEW_PEOPLE, [
          new Date(now.getTime() - NEW_PERSON_DAYS * DAY_MS).toISOString(),
          PEOPLE_READ + 1,
        ])
      : [];
    const groups = people.length === 0 ? null : await loadGroups(ctx);
    const markIds = [
      ...gaps.map((row) => row.id),
      ...(groups === null ? [] : people.map((row) => groups.idOf(row.id))),
    ];
    const marksOn = new Map(
      markIds.length === 0
        ? []
        : (await ctx.run<{ ref_id: string; state: WriteBackState }>(MARKS_ON, [markIds])).map(
            (row) => [row.ref_id, row.state] as const,
          ),
    );
    for (const row of gaps.slice(0, GAPS_READ)) {
      const state = marksOn.get(row.id);
      if (state === "handled") continue;
      const key = gapSignalKey(row.id);
      signals.set(key, {
        change: "signal",
        key,
        kind: "gap",
        at: stamp(row.created_at),
        what: null,
        why: `A gap in what is known: ${row.gap_trigger}.`,
        source: { kind: "opportunity", id: row.id } as SignalSource,
        ...(state === undefined ? {} : { state }),
        ...roleOf(roles.get("gap")),
      });
    }

    if (groups !== null) {
      const kept = people.slice(0, PEOPLE_READ);
      const who = await groupWho(ctx, groups, [...new Set(kept.map((row) => groups.idOf(row.id)))]);
      for (const row of kept) {
        const id = groups.idOf(row.id);
        const one = who.get(id);
        const state = marksOn.get(id);
        if (one === undefined || state === "handled") continue;
        const source = { kind: "entity", id } as SignalSource;
        const key = keyOf("new_person", source);
        signals.set(key, {
          change: "signal",
          key,
          kind: "new_person",
          at: stamp(row.first_at),
          what: null,
          why: "A person who first wrote to the owner in the last week.",
          source,
          who: one,
          ...(state === undefined ? {} : { state }),
          ...roleOf(roles.get("new_person")),
        });
        shownOf.set(key, row.evidence_id);
      }
    }

    const wrote = await writeBacksOf(ctx, client.id, now);
    // What it read in full is what it may call cleared: a read that was cut says nothing of what it cut.
    const complete = !next.value.more && gaps.length <= GAPS_READ && people.length <= PEOPLE_READ;
    const rows = await feedOf(ctx, after, limit, { entries: feedEntries(signals, wrote), complete });
    const found = new Map<string, SignalChange | WriteBackChange>([...signals, ...wrote]);
    const answer = served(rows, limit, valid.since, found);
    if (!complete) answer.value = { ...answer.value, cut: true };
    // Only what is served is logged as read.
    const keys = answer.value.changes.flatMap((one) => (one.change === "signal" ? [one.key] : []));
    const read: ReadSet = next.readOf(keys.flatMap((key) => moveOf.get(key) ?? []));
    return {
      ...answer,
      read: {
        ...read,
        // A gap serves an id and a code, and its text only once claimed: nothing to log as shown.
        shown: [...new Set([...read.shown, ...keys.flatMap((key) => shownOf.get(key) ?? [])])].sort(byText),
      },
    };
  },
};
