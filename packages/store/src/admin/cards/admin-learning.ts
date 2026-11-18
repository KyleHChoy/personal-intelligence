import {
  CardId,
  CardLabel,
  JUDGMENT_SILENCES,
  type LedgerRef,
  type PersonalCompartment,
  type RequestId,
  type RulingId,
  SilenceVerdict,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import { weekDayOf } from "../../cards/asked-less.ts";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { byText, type Query, stamp } from "../../core/db.ts";
import { fingerprint } from "../../core/fingerprint.ts";
import { newId } from "../../core/ids.ts";
import type { Keys } from "../../core/keys.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { lockRows } from "../../core/queue.ts";
import { CARD_STATE } from "../../core/statements.ts";
import { repeatedDecision } from "../admin-base.ts";

// The owner's commands and reads of learning and evaluation, as pi_admin. Admin holds one of these
// as `admin.learning`. The views, the labels and the silence sample are built; the harm marks and
// the reads are designed, not built. Every decision written here sets no card id, so no process
// that reads a card's latest decision ever reads one.

// Where the owner saw a target.
export type ViewSurface = "cli" | "web";

// One silence of the owner's weekly sample, as `pi learn silences` shows it: its reason, its wake
// and what it was about (the run's anchors). Ids, words and codes only.
export type SilenceSampleView = {
  sample: string;
  silence: string;
  reason: string;
  wakeSource: string;
  wakeKey: string;
  run: string | null;
  refs: { kind: string; id: string }[];
};

const SAMPLE_DAYS = 28;
const SAMPLE_MOST = 20;
const HURRIED_MS = 2_000;

// The tables a viewed target's label is read from, by its kind. A kind added later is one entry
// here; the column checks form only.
const VIEWED: Readonly<Record<string, string>> = {
  card: "ledger.cards",
  silence_sample: "ledger.silence_samples",
  call: "vault.model_calls",
  // A finished task's result, opened by the owner on the page (admin-results.ts openResult).
  move: "ledger.moves",
};

// Returns the time it was shown.
export async function writeView(query: Query, target: LedgerRef, surface: ViewSurface, now: Date): Promise<Date> {
  const table = Object.hasOwn(VIEWED, target.kind) ? VIEWED[target.kind] : undefined;
  if (table === undefined || (surface !== "cli" && surface !== "web")) throw new AdminError("invalid_argument");
  const [row] = await query<{ compartments: string[] }>(`select compartments from ${table} where id = $1`, [target.id]);
  if (row === undefined) throw new AdminError("not_found");
  await query(
    "insert into ledger.owner_views (target_kind, target_id, surface, shown_at, compartments) values ($1, $2, $3, $4, ledger.label($5))",
    [target.kind, target.id, surface, stamp(now), row.compartments],
  );
  return now;
}

// The same within a week, fresh the next.
export function drawOrder(keys: Keys, silences: string[], week: string): string[] {
  return silences
    .map((id) => ({ id, fp: fingerprint(keys, "sample", `${id}\n${week}`) }))
    .sort((a, b) => byText(a.fp, b.fp))
    .map((one) => one.id);
}

// The samples named, oldest first, with their silences and the run's anchors.
async function samplesOf(query: Query, ids: string[]): Promise<SilenceSampleView[]> {
  const rows = await query<{
    id: string;
    silence: string;
    reason: string;
    wake_source: string;
    wake_key: string;
    run_id: string | null;
  }>(
    `select x.id, s.id::text as silence, s.reason, s.wake_source, s.wake_key, s.run_id
     from ledger.silence_samples x join ledger.silences s on s.id = x.silence_id
     where x.id = any ($1) order by x.created_at, x.id collate "C"`,
    [ids],
  );
  const runs = rows.flatMap((row) => (row.run_id === null ? [] : [row.run_id]));
  const basis = await query<{ row_id: string; ref_kind: string; ref_id: string }>(
    "select row_id, ref_kind, ref_id from ledger.basis where row_kind = 'run' and row_id = any ($1) order by id",
    [runs],
  );
  return rows.map((row) => ({
    sample: row.id,
    silence: row.silence,
    reason: row.reason,
    wakeSource: row.wake_source,
    wakeKey: row.wake_key,
    run: row.run_id,
    refs: basis.filter((one) => one.row_id === row.run_id).map((one) => ({ kind: one.ref_kind, id: one.ref_id })),
  }));
}

// Returns the time it was shown.
export async function markViewed(admin: AdminContext, target: LedgerRef, surface: ViewSurface): Promise<Date> {
  const now = admin.now();
  return admin.transaction((query) => writeView(query, target, surface, now));
}

// An empty list clears the card's labels. A repeated request id returns the first ruling.
export async function labelCard(
  admin: AdminContext,
  args: { card: CardId; labels: CardLabel[]; requestId: RequestId },
): Promise<RulingId> {
  if (!CardId.safeParse(args.card).success || !args.labels.every((label) => CardLabel.safeParse(label).success))
    throw new AdminError("invalid_argument");
  const now = admin.now();
  return admin.transaction(async (query) => {
    await lockRows(query, [args.card]);
    const [card] = await query<{ compartments: PersonalCompartment[]; state: string | null }>(
      `select c.compartments, ${CARD_STATE} as state from ledger.cards c where c.id = $1`,
      [args.card],
    );
    if (card === undefined) throw new AdminError("not_found");
    if (card.state !== "decided") throw new AdminError("not_decided");
    const [last] = await query<{ id: RulingId }>(
      `select id from knowledge.owner_decisions where kind = 'card_label' and target_kind = 'card' and target_id = $1
       order by decided_at desc, id collate "C" desc limit 1`,
      [args.card],
    );
    return ownerDecision(
      query,
      {
        requestId: args.requestId,
        kind: "card_label",
        target: { kind: "card", id: args.card },
        supersedes: last?.id ?? null,
        labels: args.labels,
        compartments: card.compartments,
      },
      now,
    );
  });
}

export async function drawSilences(
  admin: AdminContext,
  args: { sample: number; requestId: RequestId },
): Promise<SilenceSampleView[]> {
  if (!Number.isSafeInteger(args.sample) || args.sample < 1 || args.sample > SAMPLE_MOST)
    throw new AdminError("invalid_argument");
  const now = admin.now();
  const week = weekDayOf(now);
  return admin.transaction(async (query) => {
    await lockRows(query, []);
    const candidates = await query<{ id: string }>(
      `select s.id::text as id from ledger.silences s
       where s.reason = any ($1) and s.created_at > $2 and s.created_at <= $3 and s.tainted_at is null
         and not exists (select 1 from ledger.silence_samples x where x.silence_id = s.id)`,
      [[...JUDGMENT_SILENCES], stamp(new Date(now.getTime() - SAMPLE_DAYS * DAY_MS)), stamp(now)],
    );
    const drawn = drawOrder(
      admin.keys,
      candidates.map((row) => row.id),
      week,
    ).slice(0, args.sample);
    // Ids in the draw's order, so the samples list, here and when open, in the order drawn.
    const ids = drawn.map(() => newId("sls")).sort();
    for (const [n, silence] of drawn.entries()) {
      const id = ids[n] as string;
      await query(
        `insert into ledger.silence_samples (id, request_id, created_at, created_by, silence_id, week, compartments)
         select $1, $2, $3, 'owner', s.id, $4::date, ledger.label(s.compartments) from ledger.silences s where s.id = $5::bigint`,
        [id, args.requestId, stamp(now), week, silence],
      );
    }
    return samplesOf(query, ids);
  });
}

export async function pendingSilences(admin: AdminContext): Promise<SilenceSampleView[]> {
  return admin.transaction(async (query) => {
    const open = await query<{ id: string }>(
      `select x.id from ledger.silence_samples x
       where x.tainted_at is null
         and not exists (select 1 from knowledge.owner_decisions d where d.kind = 'silence_verdict' and d.target_kind = 'silence_sample' and d.target_id = x.id)`,
    );
    return samplesOf(
      query,
      open.map((row) => row.id),
    );
  });
}

// A sample already judged or tainted is not_pending; a repeated request returns its ruling.
export async function recordSilenceVerdict(
  admin: AdminContext,
  args: {
    sample: string;
    verdict: SilenceVerdict;
    requestId: RequestId;
  },
): Promise<RulingId> {
  if (!SilenceVerdict.safeParse(args.verdict).success) throw new AdminError("invalid_argument");
  const now = admin.now();
  return admin.transaction(async (query) => {
    await lockRows(query, [args.sample]);
    const [sample] = await query<{ compartments: PersonalCompartment[]; tainted: boolean; shown_at: Date | null }>(
      `select x.compartments, x.tainted_at is not null as tainted,
         (select max(w.shown_at) from ledger.owner_views w where w.target_kind = 'silence_sample' and w.target_id = x.id) as shown_at
       from ledger.silence_samples x where x.id = $1`,
      [args.sample],
    );
    if (sample === undefined) throw new AdminError("not_found");
    const repeat = await repeatedDecision(query, args.requestId);
    if (repeat !== undefined) return repeat;
    const judged = await query(
      "select 1 from knowledge.owner_decisions where kind = 'silence_verdict' and target_kind = 'silence_sample' and target_id = $1",
      [args.sample],
    );
    if (sample.tainted || judged.length > 0) throw new AdminError("not_pending");
    return ownerDecision(
      query,
      {
        requestId: args.requestId,
        kind: "silence_verdict",
        target: { kind: "silence_sample", id: args.sample },
        answer: args.verdict,
        details: { hurried: sample.shown_at === null || now.getTime() - sample.shown_at.getTime() < HURRIED_MS },
        compartments: sample.compartments,
      },
      now,
    );
  });
}
