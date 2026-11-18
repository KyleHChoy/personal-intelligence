// A pack's second degree: the people each attendee shown, or the person, reaches by a hop the
// caller can see or a relation claim heard in an unlinked meeting or chat, ordered with an active
// goal's target first and rendered by code from claims and beliefs, never from model text.

import {
  ClaimRecord,
  type ClientView,
  type EntityId,
  FactId,
  type GoalId,
  IntroOffer,
  type PackItem,
  RelationshipRelation,
  type SecondDegreeLine,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import {
  MAX_LINKS,
  type PackTemplate,
  type PrepCandidate,
  prepOrder,
  secondDegreeRules,
} from "@intelligence/personal-core/views";
import { stamp } from "../core/db.ts";
import { type Ctx, Unavailable } from "../core/read-ctx.ts";
import type { SealedRow } from "../core/seal.ts";
import { servedJson } from "../core/served.ts";
import { OWNER as OWNER_ACCOUNT } from "./read-fact-rows.ts";
import { RELATION_SEEN, RELATION_TYPES } from "./read-fragments.ts";
import { computedGoals } from "./read-goal-beliefs.ts";
import { SHOWN as GOALS_SHOWN } from "./read-goals.ts";
import { groupWho } from "./read-group-who.ts";
import { loadGroups } from "./read-groups.ts";
import { sectionOf } from "./read-pack-items.ts";
import { loadPathHops, OWN_TIES } from "./read-paths.ts";

// The relation claims naming any of `$1` heard in a meeting or a chat not
// linked to an event, which make no hop, newest first, at most `$5`: read as get_entity's
// `mentionedBy` reads them (RELATION_SEEN), in force and of the last `introOfferDays`, as the
// paths loader's relation claims are.
const HEARD = `
  select c.id, c.compartments, c.content_enc, c.valid_from, c.fact_key_fp
  from knowledge.claims c
  left join knowledge.messages m on m.evidence_id = c.evidence_id
  left join knowledge.documents d on d.evidence_id = c.evidence_id
  left join knowledge.captures k on k.evidence_id = c.evidence_id
  where c.id in (select n.claim_id from knowledge.claim_entities n where n.entity_id = any($1::text[]))
    and k.id is not null and k.event_id is null
    and c.valid_from >= $3 and (c.valid_to is null or c.valid_to > $4)
    and ${RELATION_SEEN}
  order by c.valid_from desc, c.id, m.id, d.id, k.id
  limit $5`;

// The date of each claim a line may cite, as the token returns it.
const CLAIM_DATES = `
  select c.id, c.valid_from from knowledge.claims c
  where c.id = any($1::text[])
  order by c.id`;

// The person each goal targets, as the token's goal_state policy returns it.
const GOAL_TARGETS = `
  select g.goal_id, g.target_entity_id from projections.goal_state g
  where g.goal_id = any($1::text[]) and g.target_entity_id is not null
  order by g.goal_id`;

type Candidate = PrepCandidate & { relation?: RelationshipRelation; key: string };
type HeardRow = SealedRow<"knowledge.claims.content_enc"> & { valid_from: Date; fact_key_fp: string };

const relationOf = (value: unknown): RelationshipRelation | undefined => RelationshipRelation.safeParse(value).data;

// An active goal the caller can see (list_goals' gate and goals), newest set first, by the group of
// the person it targets.
async function goalsByTarget(
  ctx: Ctx,
  asOf: string,
  group: (id: string) => string,
): Promise<Map<string, { id: GoalId; statement: string }>> {
  const [gate] = await ctx.run<{ shown: boolean | null; clearance: string[] }>(GOALS_SHOWN, []);
  const goals = gate?.shown === true ? await computedGoals(ctx, gate.clearance, asOf) : [];
  const active = goals.filter((goal) => goal.goal !== null && goal.status === "active");
  const targets =
    active.length === 0
      ? []
      : await ctx.run<{ goal_id: string; target_entity_id: string }>(GOAL_TARGETS, [active.map((goal) => goal.goal)]);
  const targetOf = new Map(targets.map((row) => [row.goal_id, group(row.target_entity_id)]));
  const goalFor = new Map<string, { id: GoalId; statement: string }>();
  for (const goal of active) {
    const target = targetOf.get(goal.goal as string);
    if (target !== undefined && !goalFor.has(target))
      goalFor.set(target, { id: goal.goal as GoalId, statement: goal.statement });
  }
  return goalFor;
}

// The lines each relation claim heard in a meeting or a chat makes, each way between the two people
// it names that `admits`: marked `heard`, never a hop.
function heardLines(
  ctx: Ctx,
  rows: readonly HeardRow[],
  group: (id: string) => string,
  admits: (one: string, other: string) => boolean,
  goalFor: ReadonlyMap<string, unknown>,
): (Candidate & { through: string })[] {
  const lines: (Candidate & { through: string })[] = [];
  for (const row of rows) {
    const parsed = ClaimRecord.safeParse(servedJson(ctx, row, "knowledge.claims.content_enc"));
    if (!parsed.success) throw new Unavailable();
    const { claim, lane } = parsed.data;
    if (lane !== "meeting" && lane !== "moment") continue;
    const { subject, fields } = claim.content;
    const offer = claim.content.type === "intro_offer" ? IntroOffer.safeParse(fields.offer) : undefined;
    const relation = claim.content.type === "relationship" ? relationOf(fields.relation) : undefined;
    const named = claim.content.type === "intro_offer" ? fields.person : fields.counterparty;
    const usable = typeof named === "string" && (offer === undefined ? relation !== undefined : offer.success);
    if (!usable) continue;
    const ends = [group(subject), group(named)];
    for (const [at, one] of ends.entries()) {
      const other = ends[1 - at] as string;
      if (!admits(one, other)) continue;
      lines.push({
        through: one,
        person: other,
        tie: offer !== undefined ? "intro_offer" : relation === "acquaintance" ? "acquaintance" : "relationship",
        ...(offer?.success === true ? { offer: offer.data } : {}),
        ...(relation === undefined ? {} : { relation }),
        heard: true,
        goal: goalFor.has(other),
        at: stamp(row.valid_from),
        fact: row.id,
        key: row.fact_key_fp,
      });
    }
  }
  return lines;
}

// The second degree of a pack, a required inclusion chosen by code. For each of `through` (the attendees shown, or the person), the people they reach by a hop
// the caller can see (the paths loader: a relationship or acquaintance belief, an intro_offer
// claim, a confirmed connection, a reported relation) whom the owner has no own tie with and who
// are not among `beside` (the meeting's participants, or the person), and each relation claim
// naming them heard in a meeting or a chat not linked to an event, marked `heard` and never a hop.
// At most `prepPerAttendee` each, in `prepOrder`'s order: first those an active goal the
// caller can see targets (list_goals' gate and goals), then by kind, then newest, then the lower
// cited id. Each line is rendered by code from the claims and beliefs; no model text. Every
// statement reads under the caller's token, and one is sent only for rows it returned.
export async function secondDegreeSection(
  ctx: Ctx,
  client: ClientView,
  template: PackTemplate,
  through: readonly string[],
  beside: readonly string[],
  now: Date,
): Promise<{ items: PackItem[]; factKeyOf: Map<string, string> }> {
  const section = sectionOf(template, "second_degree");
  if (!client.views.includes(section.view) || through.length === 0) return { items: [], factKeyOf: new Map() };
  const rules = secondDegreeRules();
  const asOf = stamp(now);
  const groups = await loadGroups(ctx);
  const group = (id: string): string => groups.idOf(id);
  const [owner] = await ctx.run<{ entity_id: string }>(OWNER_ACCOUNT, []);
  const ownTies = new Set(
    (await ctx.run<{ entity_id: string }>(OWN_TIES, [now.toISOString()])).map((row) => group(row.entity_id)),
  );
  const ends = new Set([...beside, ...through].map(group));
  const reached = (other: string): boolean => other !== owner?.entity_id && !ownTies.has(other) && !ends.has(other);
  const hops = await loadPathHops(ctx, (id) => group(id) as EntityId, now);

  const members = [...new Set(through.flatMap((id) => groups.membersOf(id)))];
  const since = new Date(now.getTime() - rules.introOfferDays * DAY_MS).toISOString();
  const heardRows = await ctx.run<HeardRow>(HEARD, [members, RELATION_TYPES, since, now.toISOString(), MAX_LINKS]);

  const goalFor = await goalsByTarget(ctx, asOf, group);

  const pending: { through: string; person: string; tie: Candidate["tie"]; offer?: IntroOffer; facts: string[] }[] = [];
  for (const one of through.map(group)) {
    for (const tie of hops.ties) {
      const other = tie.a === one ? tie.b : tie.b === one ? tie.a : undefined;
      if (other === undefined || !reached(other)) continue;
      pending.push({
        through: one,
        person: other,
        tie: tie.via ?? "relationship",
        ...(tie.offer === undefined ? {} : { offer: tie.offer }),
        facts: tie.facts,
      });
    }
  }
  const cites = [...new Set(pending.flatMap((one) => one.facts))];
  const dated = pending.length === 0 ? [] : await ctx.run<{ id: string; valid_from: Date }>(CLAIM_DATES, [cites]);
  const dates = new Map(dated.map((row) => [row.id, stamp(row.valid_from)]));
  const byThrough = new Map<string, Candidate[]>();
  const add = (at: string, candidate: Candidate): void => {
    byThrough.set(at, [...(byThrough.get(at) ?? []), candidate]);
  };
  for (const one of pending) {
    // A belief's newest supporting claim the token returns is its cite.
    const cited = one.facts
      .flatMap((fact) => (dates.has(fact) ? [{ fact, at: dates.get(fact) as string }] : []))
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.fact < b.fact ? -1 : 1))[0];
    if (cited === undefined) continue;
    const relation = relationOf(hops.relationOf.get(FactId.parse(cited.fact)));
    add(one.through, {
      person: one.person,
      tie: one.tie,
      ...(one.offer === undefined ? {} : { offer: one.offer }),
      ...(relation === undefined ? {} : { relation }),
      goal: goalFor.has(one.person),
      at: cited.at,
      fact: cited.fact,
      key: hops.factKeyOf.get(FactId.parse(cited.fact)) ?? "",
    });
  }
  const inThrough = new Set(through.map(group));
  const admits = (one: string, other: string): boolean => inThrough.has(one) && reached(other);
  for (const { through: one, ...candidate } of heardLines(ctx, heardRows, group, admits, goalFor)) add(one, candidate);

  const chosen = [...inThrough].flatMap((one) =>
    prepOrder(byThrough.get(one) ?? [], rules.prepPerAttendee).map((line) => ({ through: one, line })),
  );
  const who = await groupWho(ctx, groups, [...new Set(chosen.flatMap(({ through: one, line }) => [one, line.person]))]);
  const factKeyOf = new Map<string, string>();
  const items = chosen
    .flatMap(({ through: one, line }) => {
      const from = who.get(one);
      const person = who.get(line.person);
      return from === undefined || person === undefined ? [] : [{ from, person, line }];
    })
    .map(({ from, person, line }, n): PackItem => {
      const id = `second_degree:${n}`;
      if (line.key !== "") factKeyOf.set(id, line.key);
      const goal = goalFor.get(line.person);
      const served: SecondDegreeLine = {
        through: from,
        person,
        tie: line.tie,
        ...(line.relation === undefined ? {} : { relation: line.relation }),
        ...(line.offer === undefined ? {} : { offer: line.offer }),
        fact: line.fact as SecondDegreeLine["fact"],
        at: line.at as SecondDegreeLine["at"],
        ...(line.heard === true ? { heard: true as const } : {}),
        ...(goal === undefined ? {} : { goal: { id: goal.id, statement: { untrusted: goal.statement } } }),
      };
      // A confirmed connection is the owner's release; every other line a source's claim or belief.
      return {
        id,
        section: "second_degree",
        required: section.required,
        provenance: line.tie === "connection" ? "owner" : "source",
        asOf,
        kind: "second_degree",
        line: served,
      };
    });
  return { items, factKeyOf };
}
