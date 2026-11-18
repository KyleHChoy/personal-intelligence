import { PipelineCode, PipelineStatus } from "@intelligence/contracts/personal";
import type { Query } from "../../core/db.ts";
import { type OutcomeMetric, type OutcomeWindow, outcomeMetric, shareOf } from "../../core/outcome-thresholds.ts";
import type { Sealed } from "../../core/seal.ts";
import { openStatus } from "../../core/status-facts.ts";
import type { Tx } from "../../core/tx.ts";
import { ownerWarmthRows } from "../people/admin-warmth.ts";

// `pi outcomes` on the moment lane. Most moments are never for a model: a page, an agent's
// conversation, a chat with no speakers. So the share is taken over the moments the lane asked, and
// what became of every moment received is told beside it. A moment's status is sealed and opened
// here for its status and code alone.

// A fact a model read from the item. Code makes `capture.` and `activity.` claims at every commit,
// whether or not there was anything to read, so they say nothing of what a lane found. Its time is
// `first_known_at`, which a re-derive keeps, so a raised generation does not reset the day.
export const MODEL_FACT = `c.type not like 'capture.%' and c.type not like 'activity.%'`;

// The window's primary mail, a person's and not a mailing, and how much gave a plan or a commitment.
export const MAIL_OBLIGATIONS = `
  select count(*)::int as sample,
    count(*) filter (where exists (
      select 1 from knowledge.claims c
      where c.evidence_id = e.id and c.compartments <@ $3::text[] and c.type in ('plan', 'commitment')))::int as hits
  from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id
  where e.source_kind = 'email' and e.ingested_at >= $1 and e.ingested_at < $2 and m.compartments <@ $3::text[]
    and not e.system_originated and not m.held and not m.bulk and m.category = 'primary'`;

// The same of a program's mail: a plan is what a notice's deadline becomes.
export const NOTICE_OBLIGATIONS = `
  select count(*)::int as sample,
    count(*) filter (where exists (
      select 1 from knowledge.claims c
      where c.evidence_id = e.id and c.compartments <@ $3::text[] and c.type = 'plan'))::int as hits
  from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id
  where e.source_kind = 'email' and e.ingested_at >= $1 and e.ingested_at < $2 and m.compartments <@ $3::text[]
    and not e.system_originated and not m.held and m.bulk and m.category in ('updates', 'primary')`;

type Range = [from: string, to: string, within: string[]];

const MOMENTS = `
  select e.id as evidence_id, p.compartments, p.facts_enc,
    exists (select 1 from knowledge.claims c where c.evidence_id = e.id and c.compartments <@ $3::text[] and ${MODEL_FACT}
      and c.first_known_at <= e.ingested_at + interval '24 hours') as hit
  from knowledge.captures k join vault.evidence_items e on e.id = k.evidence_id
  left join vault.pipeline_items p on p.evidence_id = e.id
  where k.kind = 'moment' and e.ingested_at >= $1 and e.ingested_at < $2 and k.compartments <@ $3::text[]`;

type MomentRow = {
  evidence_id: string;
  compartments: string[] | null;
  facts_enc: Sealed;
  hit: boolean;
};

// What became of a moment: `waiting` for one no run has committed, `asked` for one a model read, and
// otherwise its code, the reason it was sent to none or what ended it. A moment set due again keeps
// what its last commit said. `read`: a model was asked, so it counts in the share though the call
// failed or its answer was withheld, and a lane whose calls all fail reads low, never untried.
const partOfCode = (code: string): string => (PipelineCode.safeParse(code).success ? code : "other");
const partOfStatus = (status: string): string => (PipelineStatus.safeParse(status).success ? status : "other");
const outcomeOf = (tx: Tx, row: MomentRow): { part: string; read: boolean } => {
  if (row.facts_enc === null || row.compartments === null) return { part: "waiting", read: false };
  try {
    const status = openStatus(tx, row.compartments, row.evidence_id, row.facts_enc);
    if (status.status === "done") return { part: "asked", read: true };
    return {
      // A code of the pipeline's own list, or the status: what a stored envelope holds beyond those
      // is counted as `other`, so a part's key is always one of a closed set.
      part: status.code === undefined ? partOfStatus(status.status) : partOfCode(status.code),
      read: status.status === "withheld" || status.status === "failed",
    };
  } catch {
    return { part: "unreadable", read: false };
  }
};

export async function momentsToClaims(tx: Tx, range: Range, window: OutcomeWindow): Promise<OutcomeMetric> {
  const rows = await tx.query<MomentRow>(MOMENTS, range);
  const parts: Record<string, number> = {};
  let hits = 0;
  let sample = 0;
  for (const row of rows) {
    const { part, read } = outcomeOf(tx, row);
    parts[part] = (parts[part] ?? 0) + 1;
    if (!read) continue;
    sample += 1;
    if (row.hit) hits += 1;
  }
  return outcomeMetric("capture_to_claim_24h_moments", {
    value: shareOf(hits, sample),
    sample,
    window,
    ...(sample === 0 ? { code: "none_asked" } : {}),
    parts,
  });
}

// Of the people the owner ruled inner, the share whose warmth line holds a chat, under the owner's
// audience. Low says their chats are out of scope, not captured or not bound: `get_entity` then says
// `channel_unseen` of them.

export async function innerTiesWithChat(
  tx: Tx,
  within: readonly string[],
  window: OutcomeWindow,
  now: Date,
): Promise<OutcomeMetric> {
  const inner = (await ownerWarmthRows(tx, now)).filter(
    (w) => w.compartments.every((one) => within.includes(one)) && w.tier === "inner" && w.tier_source === "owner",
  );
  const sample = inner.length;
  const hits = inner.filter((w) => w.channels.includes("chat")).length;
  return outcomeMetric("inner_ties_with_chat", { value: shareOf(hits, sample), sample, window });
}

// Whether what the lane found is read: moments with a fact from a model, served to any client within
// a week of the fact's writing, by that fact's key in a read log, or the fact in a pack. The key and
// not the moment's evidence, which a read of code's claims from it binds too. The mirror's own sync
// logs what it copies, which no one asked for, so it is no read. A log row's label is the reader's
// clearance, so only the fact's own label decides.
const MOMENT_READ_BACK = `
  select count(*)::int as sample, count(*) filter (where
      exists (select 1 from ledger.read_log r
              where r.tool <> 'sync_mirror' and r.read_at > w.written and r.read_at <= w.written + interval '7 days'
                and r.fact_key_fps && w.keys)
      or exists (select 1 from ledger.context_packs p
              where p.created_at > w.written and p.created_at <= w.written + interval '7 days' and p.item_ids && w.ids))::int as hits
  from (select e.id, min(c.first_known_at) as written, array_agg(c.id::text) as ids, array_agg(c.fact_key_fp::text) as keys
        from knowledge.captures k join vault.evidence_items e on e.id = k.evidence_id
        join knowledge.claims c on c.evidence_id = e.id
        where k.kind = 'moment' and e.ingested_at >= $1 and e.ingested_at < $2
          and k.compartments <@ $3::text[] and c.compartments <@ $3::text[] and ${MODEL_FACT}
        group by e.id) w`;

export async function momentFactReadBack(query: Query, range: Range, window: OutcomeWindow): Promise<OutcomeMetric> {
  const [row] = await query<{ sample: number; hits: number }>(MOMENT_READ_BACK, range);
  const sample = row?.sample ?? 0;
  return outcomeMetric("moment_fact_read_back_7d", { value: shareOf(row?.hits ?? 0, sample), sample, window });
}

// How many active projects hold a status or decision read from a chat in the window.
export const PROJECT_CHAT = `
  select count(*)::int as sample, count(*) filter (where exists (
      select 1 from knowledge.claim_entities n
      join knowledge.claims c on c.id = n.claim_id
      join knowledge.captures k on k.evidence_id = c.evidence_id and k.kind = 'moment'
      where n.entity_id = p.id and c.type in ('project.status', 'project.decision')
        and c.valid_from >= $1 and c.valid_from < $2 and c.compartments <@ $3::text[]))::int as hits
  from knowledge.projects p where p.status = 'active' and p.compartments <@ $3::text[]`;
