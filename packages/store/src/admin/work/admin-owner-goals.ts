import {
  ClaimRecord,
  canonicalTimeZone,
  GOAL_STATES,
  type GoalSource,
  type GoalState,
  LifeDomain,
  OWNER_PAGE_MOST,
  type OwnerGoal,
  type OwnerGoals,
  type OwnerGoalsArgs,
} from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { ownerAudience } from "../../core/audience.ts";
import { byText, type Query, stamp } from "../../core/db.ts";
import { goalReview, isStale } from "../../core/goal-review.ts";
import type { Sealed } from "../../core/seal.ts";
import { openedUnder, type Tx } from "../../core/tx.ts";
import { OWNER_TIME_ZONE } from "../../core/zone.ts";
import { claimRecordUnder, ownerBeliefs, ownerWho } from "../admin-owner.ts";

// The owner's goals and the work that names one (R-T3), as pi_admin inside the owner's own
// audience, the one owner audience.
//
// The reversal rule is read from the stored belief: computedGoals builds the belief again without the
// mail's reversals and serves it open if that opens it; a stored belief cannot be built again here, so a
// closed goal belief is served open and disputed when its key's claims hold the owner's own command, the
// latest of them is a reversal of another origin (so the reversal is what closed it), and no retire or
// veto of the owner's is in force on the key, the only rulings that close a goal a command keeps open.
//
// The reader's filters it keeps, stated, not inherited: every goal_ids, goal_state, outcome link,
// move and opportunity row within the owner's audience, as pi_reader's policies keep a client's clearance;
// an outcome link applied and untainted on work, a move and its opportunity untainted. Held items
// and releases are the belief build's own holds. Withheld people are no goal's subject; a target is
// named whatever its hold, as `ownerWho` names every id.

// The fact keys of the goal claims within the owner's audience.
const GOAL_KEYS = `
  select distinct c.fact_key_fp from knowledge.claims c
  where c.type = 'goal' and c.compartments <@ $1::text[]
  order by c.fact_key_fp`;

// The beliefs' support claims, and every claim within the owner's audience on a closed belief's key (the
// reversal rule reads the key's claims, as computedGoals reads the key's group), opened for origin,
// subject kind, time and words.
const CLAIMS = `
  select c.id, c.fact_key_fp, c.compartments, c.content_enc from knowledge.claims c
  where c.id = any ($1::text[]) or (c.fact_key_fp = any ($2::text[]) and c.compartments <@ $3::text[])
  order by c.id`;

// Each goal id whose rows name one of the keys, with its latest key and that row's claim, as
// GOAL_MAPPINGS; and every key any goal id's rows name, as GOAL_NAMED_KEYS. A goal whose adoption
// the owner undid is no goal, and names the source goal's key no longer (goal-beliefs.ts).
const GOAL_MAPPINGS = `
  select distinct on (m.goal_id) m.goal_id, m.fact_key_fp, m.claim_id
  from knowledge.goal_ids m
  where m.compartments <@ $2::text[]
    and m.goal_id in (select n.goal_id from knowledge.goal_ids n where n.compartments <@ $2::text[] and n.fact_key_fp = any ($1::text[]))
    and not exists (select 1 from knowledge.goal_key_rulings u where u.goal_id = m.goal_id and u.verdict = 'adopt' and u.lifted_at is not null)
  order by m.goal_id, m.created_at desc, m.claim_id collate "C" desc`;

const GOAL_NAMED_KEYS = `
  select distinct n.fact_key_fp from knowledge.goal_ids n
  where n.compartments <@ $2::text[] and n.fact_key_fp = any ($1::text[])
    and not exists (select 1 from knowledge.goal_key_rulings u where u.goal_id = n.goal_id and u.fact_key_fp = n.fact_key_fp and u.verdict = 'adopt' and u.lifted_at is not null)
  order by n.fact_key_fp`;

// Each goal of the owner's with its latest mapping row and their word on it, so a goal whose latest
// words have no stored belief yet (a reword, a new goal, an adoption in the owner's words, before the next
// rebuild) is served from its own row at once.
const GOAL_LATEST = `
  select distinct on (m.goal_id) m.goal_id, m.fact_key_fp, m.claim_id, c.compartments as claim_compartments, c.content_enc,
    g.status, g.stated_at, g.compartments, g.statement_enc, g.target_entity_id, g.rank
  from knowledge.goal_ids m
  join projections.goal_state g on g.goal_id = m.goal_id
  join knowledge.claims c on c.id = m.claim_id
  where m.compartments <@ $1::text[] and g.compartments <@ $1::text[]
    and not exists (select 1 from knowledge.goal_key_rulings u where u.goal_id = m.goal_id and u.verdict = 'adopt' and u.lifted_at is not null)
  order by m.goal_id, m.created_at desc, m.claim_id collate "C" desc`;

// The keys among them whose goal stated in a source the owner removed, a hide of theirs in force; a
// source goal's place among the owner's, by its key; and the kind of source a claim was read from.
const GOAL_HIDDEN = `
  select distinct r.fact_key_fp from knowledge.goal_key_rulings r
  where r.verdict = 'hide' and r.lifted_at is null and r.fact_key_fp = any ($1::text[]) and r.compartments <@ $2::text[]
  order by r.fact_key_fp`;

const GOAL_KEY_RANKS = `
  select k.fact_key_fp, k.rank from projections.goal_key_ranks k
  where k.fact_key_fp = any ($1::text[]) and k.compartments <@ $2::text[]
  order by k.fact_key_fp`;

const CLAIM_SOURCES = `
  select c.id,
    case when exists (select 1 from knowledge.captures k where k.evidence_id = c.evidence_id and k.agent_app)
      then 'agent_chat' else e.source_kind end as source_kind
  from knowledge.claims c join vault.evidence_items e on e.id = c.evidence_id
  where c.id = any ($1::text[])
  order by c.id`;

// The owner's word on each goal, and its target.
const GOAL_RULINGS = `
  select g.goal_id, g.status, g.stated_at, g.updated_at, g.target_entity_id, g.rank from projections.goal_state g
  where g.goal_id = any ($1::text[]) and g.compartments <@ $2::text[]
  order by g.goal_id`;

// Each goal's last work and last advance, as goal-beliefs.ts GOAL_WORK_SUPPORT reads them, with
// pi_reader's policies stated.
const GOAL_WORK_SUPPORT = `
  select x.goal_id, max(x.at) as last, max(x.at) filter (where x.kind = 'advances') as advanced
  from (
    select l.goal_id, l.judged_at as at, l.kind from ledger.outcome_links l
    where l.goal_id = any ($1::text[]) and l.applied and l.tainted_at is null and l.opportunity_id is not null and l.compartments <@ $2::text[]
    union all
    select o.goal_id, m.created_at, null from ledger.moves m join ledger.opportunities o on o.id = m.opportunity_id
    where o.goal_id = any ($1::text[]) and m.tainted_at is null and o.tainted_at is null and m.compartments <@ $2::text[] and o.compartments <@ $2::text[]
  ) x
  group by x.goal_id
  order by x.goal_id`;

// Goals no mapping row names yet, read from goal_state so a goal stored before mapping rows is not
// hidden.
const GOAL_UNMAPPED = `
  select g.goal_id, g.status, g.stated_at, g.compartments, g.statement_enc, g.target_entity_id, g.rank from projections.goal_state g
  where g.compartments <@ $1::text[] and not exists (select 1 from knowledge.goal_ids m where m.goal_id = g.goal_id and m.compartments <@ $1::text[])
    and not exists (select 1 from knowledge.goal_key_rulings u where u.goal_id = g.goal_id and u.verdict = 'adopt' and u.lifted_at is not null)
  order by g.goal_id`;

// The owner's retires and vetoes in force, of the keys asked; and their domain rulings in force.
const CLOSING_RULINGS = `
  select distinct r.fact_key_fp from knowledge.belief_rulings r
  where r.fact_key_fp = any ($1::text[]) and r.verdict in ('retire', 'veto') and r.lifted_at is null
  order by r.fact_key_fp`;

const DOMAIN_RULINGS = `
  select r.ruling_id, r.fact_key_fp, r.compartments, r.value_enc from knowledge.belief_rulings r
  where r.fact_key_fp = any ($1::text[]) and r.verdict = 'domain' and r.lifted_at is null
  order by r.created_at, r.ruling_id collate "C"`;

// The words the page says a source goal came from.
const SOURCE_OF: Readonly<Record<string, GoalSource>> = {
  email: "mail",
  transcript: "meeting",
  calendar: "calendar",
  chat: "chat",
  agent_chat: "agent_chat",
  document: "document",
  agent_record: "agent",
  research_note: "agent",
  web_research: "agent",
};

type Opened = {
  factKey: string;
  origin: string;
  owner: boolean;
  reversal: boolean;
  at: number;
  words: string | null;
  domain: LifeDomain | null;
};

const statusOf = (value: string): GoalState =>
  (GOAL_STATES as readonly string[]).includes(value) ? (value as GoalState) : "active";

export function ownerGoals(admin: AdminContext, args: OwnerGoalsArgs = {}): Promise<OwnerGoals> {
  return admin.transaction((query) => goalsOf({ query, keys: admin.keys }, args, admin.now()));
}

type Goal = Omit<OwnerGoal, "from"> & { targetId: string | null; order: string; fromClaim?: string };
type GoalBelief = Awaited<ReturnType<typeof ownerBeliefs>>[number];

// The page's goals, at most `most` of them; `pi goal rank` reads them all. Read in one transaction,
// in this order: the owner's time zone, the goal beliefs and their claims and rulings, the goals'
// rows, the goals with no mapping, the goals whose latest key has no belief, then the targets and
// sources of the page.
export async function goalsOf(tx: Tx, args: OwnerGoalsArgs, at: Date, most = OWNER_PAGE_MOST): Promise<OwnerGoals> {
  const { query } = tx;
  const audience = await ownerAudience(query);
  const now = at.getTime();
  const [setting] = await query<{ time_zone: string | null }>(OWNER_TIME_ZONE);
  const zone = setting?.time_zone == null ? null : canonicalTimeZone(setting.time_zone);
  const { beliefs, claims, closing, ruledDomain } = await goalBeliefs(tx, audience);
  const shown = shownBeliefs(beliefs, claims, closing);
  const rows = await goalRows(
    query,
    shown.map((one) => one.belief.factKey),
    audience,
  );
  const goals = beliefGoals(shown, rows, claims, ruledDomain, now, zone);
  goals.push(...(await unmappedGoals(tx, audience)));
  goals.push(...(await latestGoals(tx, audience, new Set(beliefs.map((one) => one.factKey)), goals, ruledDomain)));

  // list_goals' order: newest set first, then id descending. A stale goal only when asked. Then
  // the owner's order within each life domain: the places a domain's goals hold in that order are
  // given to them by the owner's rank, ranked first, the rest as they were, so with no rank the order
  // is list_goals'. The owner's order before the page is cut, so a goal they ranked first is never cut
  // for being old.
  const listed = byRank(
    goals
      .filter((one) => args.stale === true || one.goal.stale !== true)
      .sort((a, b) => (a.goal.setAt < b.goal.setAt ? 1 : a.goal.setAt > b.goal.setAt ? -1 : byText(b.order, a.order))),
  ).slice(0, most);
  return { goals: await withTargets(tx, listed) };
}

// The owner's goal beliefs, the claims they rest on (and a closed one's), each opened, the keys a
// closing ruling holds, and the owner's domain ruling on each key.
async function goalBeliefs(tx: Tx, audience: string[]) {
  const { query, keys } = tx;
  const goalKeys =
    audience.length === 0
      ? []
      : (await query<{ fact_key_fp: string }>(GOAL_KEYS, [audience])).map((row) => row.fact_key_fp);
  const beliefs = (await ownerBeliefs(tx, goalKeys)).filter((one) => one.belief.kind === "goal");
  const support = [...new Set(beliefs.flatMap((one) => one.support))];
  const closed = beliefs.filter((one) => one.belief.status === "closed").map((one) => one.factKey);
  const claims = new Map<string, Opened>();
  const claimRows =
    support.length === 0 && closed.length === 0
      ? []
      : await query<{ id: string; fact_key_fp: string; compartments: string[]; content_enc: Sealed }>(CLAIMS, [
          support,
          closed,
          audience,
        ]);
  for (const row of claimRows) {
    const record = claimRecordUnder(keys, row);
    const fields = record.claim.content.fields;
    const words =
      typeof fields.objective === "string" ? fields.objective : typeof fields.what === "string" ? fields.what : null;
    const domain = LifeDomain.safeParse(fields.domain);
    claims.set(row.id, {
      factKey: row.fact_key_fp,
      origin: record.origin,
      owner: record.subjectKind === "owner",
      reversal: record.claim.statementKind === "reversal",
      at: Date.parse(record.claim.validFrom),
      words,
      domain: domain.success ? domain.data : null,
    });
  }
  const keysOf = beliefs.map((one) => one.factKey);
  const closing = new Set(
    keysOf.length === 0
      ? []
      : (await query<{ fact_key_fp: string }>(CLOSING_RULINGS, [keysOf])).map((row) => row.fact_key_fp),
  );
  const ruledDomain = new Map<string, LifeDomain>();
  for (const row of keysOf.length === 0
    ? []
    : await query<{ ruling_id: string; fact_key_fp: string; compartments: string[]; value_enc: Sealed }>(
        DOMAIN_RULINGS,
        [keysOf],
      )) {
    const parsed = LifeDomain.safeParse(
      openedUnder(
        keys,
        row.compartments,
        { table: "knowledge.belief_rulings", id: row.ruling_id, column: "value_enc" },
        row.value_enc,
      ),
    );
    if (parsed.success) ruledDomain.set(row.fact_key_fp, parsed.data);
  }
  return { beliefs, claims, closing, ruledDomain };
}

// The owner's goal beliefs, open, or reopened by the reversal rule with the reversal cited.
function shownBeliefs(
  beliefs: GoalBelief[],
  claims: Map<string, Opened>,
  closing: Set<string>,
): { belief: GoalBelief; reversal: string | null }[] {
  const shown: { belief: GoalBelief; reversal: string | null }[] = [];
  for (const one of beliefs) {
    if (!one.support.some((id) => claims.get(id)?.owner === true)) continue;
    if (one.belief.status !== "closed") {
      shown.push({ belief: one, reversal: null });
      continue;
    }
    if (closing.has(one.factKey)) continue;
    const group = [
      ...new Set([
        ...one.support,
        ...[...claims].flatMap(([id, claim]) => (claim.factKey === one.factKey ? [id] : [])),
      ]),
    ].sort((a, b) => (claims.get(b)?.at ?? 0) - (claims.get(a)?.at ?? 0));
    const latest = claims.get(group[0] ?? "");
    if (
      !group.some((id) => claims.get(id)?.origin === "owner_command") ||
      latest === undefined ||
      latest.origin === "owner_command" ||
      !latest.reversal
    )
      continue;
    shown.push({ belief: one, reversal: group[0] as string });
  }
  return shown;
}

// The rows of the shown keys' goals: their mappings to goal ids, the keys named or hidden, the
// keys' ranks, and each goal's ruling and work.
async function goalRows(query: Query, factKeys: string[], audience: string[]) {
  const mapped =
    factKeys.length === 0
      ? []
      : await query<{ goal_id: string; fact_key_fp: string; claim_id: string }>(GOAL_MAPPINGS, [factKeys, audience]);
  const goalsOn = new Map<string, { goal: string; claim: string }[]>();
  for (const row of mapped)
    goalsOn.set(row.fact_key_fp, [...(goalsOn.get(row.fact_key_fp) ?? []), { goal: row.goal_id, claim: row.claim_id }]);
  const named = new Set(
    factKeys.length === 0
      ? []
      : (await query<{ fact_key_fp: string }>(GOAL_NAMED_KEYS, [factKeys, audience])).map((row) => row.fact_key_fp),
  );
  const hidden = new Set(
    factKeys.length === 0
      ? []
      : (await query<{ fact_key_fp: string }>(GOAL_HIDDEN, [factKeys, audience])).map((row) => row.fact_key_fp),
  );
  const keyRanks = new Map(
    (factKeys.length === 0
      ? []
      : await query<{ fact_key_fp: string; rank: number }>(GOAL_KEY_RANKS, [factKeys, audience])
    ).map((row) => [row.fact_key_fp, row.rank]),
  );
  const goalIds = mapped.map((row) => row.goal_id);
  const rulings = new Map(
    (goalIds.length === 0
      ? []
      : await query<{
          goal_id: string;
          status: string;
          stated_at: Date;
          updated_at: Date;
          target_entity_id: string | null;
          rank: number | null;
        }>(GOAL_RULINGS, [goalIds, audience])
    ).map((row) => [row.goal_id, row]),
  );
  const work = new Map(
    (goalIds.length === 0
      ? []
      : await query<{ goal_id: string; last: Date | null; advanced: Date | null }>(GOAL_WORK_SUPPORT, [
          goalIds,
          audience,
        ])
    ).map((row) => [row.goal_id, row]),
  );
  return { goalsOn, named, hidden, keyRanks, rulings, work };
}

// A goal for each shown belief: one stated in a source, by its key, when no goal id maps it; else
// one for each goal id that does and has a ruling.
function beliefGoals(
  shown: { belief: GoalBelief; reversal: string | null }[],
  { goalsOn, named, hidden, keyRanks, rulings, work }: Awaited<ReturnType<typeof goalRows>>,
  claims: Map<string, Opened>,
  ruledDomain: Map<string, LifeDomain>,
  now: number,
  zone: string | null,
): Goal[] {
  const { set, stated } = goalReview();
  const goals: Goal[] = [];
  // A goal's domain: the owner's ruling in force on its key, else its latest mapped claim's, else the
  // phrase claim's. A goal id's latest claim may be outside the belief's support (a reworded
  // goal's earlier words): opened with the rest only when it is in it.
  const domainOf = (factKey: string, ...ids: (string | null | undefined)[]): LifeDomain | null =>
    ruledDomain.get(factKey) ??
    ids.map((id) => (id == null ? null : (claims.get(id)?.domain ?? null))).find((domain) => domain !== null) ??
    null;

  for (const { belief: one, reversal } of shown) {
    const { belief, factKey } = one;
    const ids = goalsOn.get(factKey) ?? [];
    if (named.has(factKey) && ids.length === 0) continue;
    const times = one.support.flatMap((id) => {
      const time = claims.get(id)?.at;
      return time === undefined || Number.isNaN(time) ? [] : [time];
    });
    const command = one.support
      .filter((id) => claims.get(id)?.origin === "owner_command")
      .sort((a, b) => (claims.get(b)?.at ?? 0) - (claims.get(a)?.at ?? 0))[0];
    const statement = { untrusted: claims.get(command ?? one.phraseClaim ?? one.support[0] ?? "")?.words ?? "" };
    const disputed = reversal !== null || belief.disputed;
    const marks = { ...(disputed ? { disputed: true as const } : {}), ...(reversal === null ? {} : { reversal }) };
    if (ids.length === 0) {
      // A goal stated in a source that the owner removed.
      if (hidden.has(factKey)) continue;
      const stale = isStale(Math.max(0, ...times), now, stated, zone);
      const rank = keyRanks.get(factKey);
      const from = one.phraseClaim ?? one.support[0];
      goals.push({
        goal: {
          id: factKey,
          statement,
          status: "active",
          setAt: new Date(Math.min(now, ...times)).toISOString(),
          ...(stale ? { stale: true as const } : {}),
          ...marks,
        },
        domain: domainOf(factKey, one.phraseClaim ?? one.support[0]),
        target: null,
        setBy: "stated",
        targetId: null,
        ...(rank === undefined ? {} : { rank }),
        order: factKey,
        ...(from === undefined ? {} : { fromClaim: from }),
      });
      continue;
    }
    for (const { goal, claim } of ids) {
      const ruled = rulings.get(goal);
      if (ruled === undefined) continue;
      const done = work.get(goal);
      const stale = isStale(
        Math.max(0, ...times, ruled.updated_at.getTime(), done?.last?.getTime() ?? 0),
        now,
        set,
        zone,
      );
      goals.push({
        goal: {
          id: goal as OwnerGoal["goal"]["id"],
          statement,
          status: statusOf(ruled.status),
          setAt: stamp(ruled.stated_at),
          ...(stale ? { stale: true as const } : {}),
          ...marks,
          ...(done?.advanced == null ? {} : { advancedAt: stamp(done.advanced) }),
        },
        domain: domainOf(factKey, claim, one.phraseClaim, one.support[0]),
        target: null,
        setBy: "owner",
        targetId: ruled.target_entity_id,
        ...(ruled.rank === null ? {} : { rank: ruled.rank }),
        order: goal,
      });
    }
  }
  return goals;
}

// A goal with no mapping row yet, the owner's words from goal_state, never stale.
async function unmappedGoals({ query, keys }: Tx, audience: string[]): Promise<Goal[]> {
  const goals: Goal[] = [];
  const unmapped =
    audience.length === 0
      ? []
      : await query<{
          goal_id: string;
          status: string;
          stated_at: Date;
          compartments: string[];
          statement_enc: Sealed;
          target_entity_id: string | null;
          rank: number | null;
        }>(GOAL_UNMAPPED, [audience]);
  for (const row of unmapped) {
    if (row.statement_enc === null || !row.compartments.every((one) => keys.compartments.has(one))) continue;
    const statement = openedUnder(
      keys,
      row.compartments,
      { table: "projections.goal_state", id: row.goal_id, column: "statement_enc" },
      row.statement_enc,
    );
    goals.push({
      goal: {
        id: row.goal_id as OwnerGoal["goal"]["id"],
        statement: { untrusted: statement },
        status: statusOf(row.status),
        setAt: stamp(row.stated_at),
      },
      domain: null,
      target: null,
      setBy: "owner",
      targetId: row.target_entity_id,
      ...(row.rank === null ? {} : { rank: row.rank }),
      order: row.goal_id,
    });
  }
  return goals;
}

// A goal of the owner's whose latest words' key has no stored belief yet, from its own row, the
// owner's words sealed on it, never stale. The reader builds beliefs when asked, so list_goals serves it
// already; the stored beliefs wait for the next rebuild. A key with a belief, open or closed, is
// the belief's to show or close, as above.
async function latestGoals(
  { query, keys }: Tx,
  audience: string[],
  built: Set<string>,
  before: Goal[],
  ruledDomain: Map<string, LifeDomain>,
): Promise<Goal[]> {
  const goals: Goal[] = [];
  const served = new Set(before.map((one) => one.goal.id as string));
  type Latest = {
    goal_id: string;
    fact_key_fp: string;
    claim_id: string;
    claim_compartments: string[];
    content_enc: Sealed;
    status: string;
    stated_at: Date;
    compartments: string[];
    statement_enc: Sealed;
    target_entity_id: string | null;
    rank: number | null;
  };
  for (const row of audience.length === 0 ? [] : await query<Latest>(GOAL_LATEST, [audience])) {
    if (
      served.has(row.goal_id) ||
      built.has(row.fact_key_fp) ||
      row.statement_enc === null ||
      !row.compartments.every((one) => keys.compartments.has(one))
    )
      continue;
    const statement = openedUnder(
      keys,
      row.compartments,
      { table: "projections.goal_state", id: row.goal_id, column: "statement_enc" },
      row.statement_enc,
    );
    const fields = ClaimRecord.parse(
      JSON.parse(
        openedUnder(
          keys,
          row.claim_compartments,
          { table: "knowledge.claims", id: row.claim_id, column: "content_enc" },
          row.content_enc,
        ),
      ),
    ).claim.content.fields;
    const domain = LifeDomain.safeParse(fields.domain);
    goals.push({
      goal: {
        id: row.goal_id as OwnerGoal["goal"]["id"],
        statement: { untrusted: statement },
        status: statusOf(row.status),
        setAt: stamp(row.stated_at),
      },
      domain: ruledDomain.get(row.fact_key_fp) ?? (domain.success ? domain.data : null),
      target: null,
      setBy: "owner",
      targetId: row.target_entity_id,
      ...(row.rank === null ? {} : { rank: row.rank }),
      order: row.goal_id,
    });
  }
  return goals;
}

// The page's goals with their targets named, a removed target marked, and where each stated goal
// was said.
async function withTargets(tx: Tx, listed: Goal[]): Promise<OwnerGoal[]> {
  const { query } = tx;
  const targets = listed.flatMap((one) => (one.targetId === null ? [] : [one.targetId]));
  const who = await ownerWho(tx, targets);
  // A target the owner removed keeps its name, marked, since a removal is undoable: their hides in force.
  const removed = new Set(
    targets.length === 0
      ? []
      : (
          await query<{ id: string }>(
            "select distinct m.id from knowledge.person_hides h cross join unnest(h.entity_ids) as m (id) where h.lifted_at is null and m.id = any ($1::text[]) order by 1",
            [targets],
          )
        ).map((row) => row.id),
  );
  const fromClaims = listed.flatMap((one) => (one.fromClaim === undefined ? [] : [one.fromClaim]));
  const sources = new Map(
    (fromClaims.length === 0 ? [] : await query<{ id: string; source_kind: string }>(CLAIM_SOURCES, [fromClaims])).map(
      (row) => [row.id, SOURCE_OF[row.source_kind] ?? "other"],
    ),
  );
  return listed.map(({ targetId, order: _order, fromClaim, ...one }) => {
    const from = fromClaim === undefined ? undefined : sources.get(fromClaim);
    return {
      ...one,
      target: targetId === null ? null : (who.get(targetId) ?? null),
      ...(targetId !== null && removed.has(targetId) ? { targetRemoved: true } : {}),
      ...(from === undefined ? {} : { from }),
    };
  });
}

// Goals in their order, each domain's places refilled in the owner's rank order: a ranked goal before an
// unranked one, lower rank first, else as they came.
function byRank<T extends { domain: LifeDomain | null; rank?: number | undefined }>(goals: readonly T[]): T[] {
  const places = new Map<string, number[]>();
  goals.forEach((one, at) => {
    places.set(String(one.domain), [...(places.get(String(one.domain)) ?? []), at]);
  });
  const out = [...goals];
  for (const at of places.values()) {
    const ordered = at
      .map((index) => goals[index] as T)
      .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER));
    at.forEach((index, n) => {
      out[index] = ordered[n] as T;
    });
  }
  return out;
}
