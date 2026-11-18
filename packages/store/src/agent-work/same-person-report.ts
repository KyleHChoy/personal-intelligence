import type { SamePersonAnswer, SamePersonBriefPair, SamePersonRefused } from "@intelligence/contracts/personal";
import { maskedSpans, phonesIn } from "@intelligence/personal-core";
import { againstSame, quoteRefusal, recordsRefusal } from "@intelligence/personal-core/planner";
import { answerId } from "../core/ids.ts";
import { open, type Sealed } from "../core/seal.ts";
import { derivedId } from "../core/work-refs.ts";
import {
  asValue,
  factsOf,
  type Held,
  type Loaded,
  openerOf,
  personOf,
  recordsOf,
} from "../identity/same-person-facts.ts";
import type { Ctx } from "../read/read-ctx.ts";
import { loadGroups } from "../read/read-groups.ts";

// A same_person task's side of report_move and of its brief: what an agent is asked, the check that
// its answer rests on more than a shared name, and the writes. Code checks; the agent only says.

const MESSAGE = "select id, compartments, body_enc, evidence_id from knowledge.messages where id = $1 and not held";

// A pair waiting on agents that the caller has not answered under its present print: the caller's token reads its own
// answers alone, so another agent's answer leaves the pair to it.
const UNANSWERED = `q.state = 'agents'
    and not exists (select 1 from ledger.identity_answers a where a.question_id = q.id and a.evidence_fp = q.evidence_fp)`;
const QUESTIONS = `
  select q.id, q.a_entity, q.b_entity, q.basis, q.compartments from ledger.identity_questions q
  join ledger.opportunities o on o.id = $1 and o.gap_subject = q.batch
  where ${UNANSWERED}
  order by q.id`;
// Of these tasks, the same-person ones whose batch holds such a pair: the rest have nothing for the
// caller to answer, and ledger.claimable_by does not offer them to it.
const LEFT = `
  select o.id from ledger.opportunities o
  where o.id = any($1::text[]) and o.gap_trigger = 'same_person'
    and exists (select 1 from ledger.identity_questions q where q.batch = o.gap_subject and ${UNANSWERED})`;

// Of these same-person tasks, those with a pair left for the caller to answer.
export async function samePersonLeft(ctx: Ctx, opportunities: readonly string[]): Promise<Set<string>> {
  if (opportunities.length === 0) return new Set();
  const rows = await ctx.run<{ id: string }>(LEFT, [[...opportunities]]);
  return new Set(rows.map((row) => row.id));
}

// The pairs of the task's batch the caller has not answered, with what each person's records hold, under its
// own token, the evidence shown and the evidence bound, as get_entity binds a contact's links.
export async function samePersonBrief(
  ctx: Ctx,
  opportunity: string,
): Promise<{ pairs: SamePersonBriefPair[]; shown: string[]; bound: string[] }> {
  const rows = await ctx.run<{ id: string; a_entity: string; b_entity: string; basis: string; compartments: string[] }>(
    QUESTIONS,
    [opportunity],
  );
  const groups = await loadGroups(ctx);
  const loaded = await recordsOf(
    ctx.run,
    rows.flatMap((row) => [...groups.membersOf(row.a_entity), ...groups.membersOf(row.b_entity)]),
  );
  const pairs: SamePersonBriefPair[] = [];
  const shown: string[] = [];
  const bound: string[] = [];
  for (const row of rows) {
    const a = personOf(openerOf(ctx.keys), loaded, groups.membersOf(row.a_entity), row.compartments);
    const b = personOf(openerOf(ctx.keys), loaded, groups.membersOf(row.b_entity), row.compartments);
    shown.push(...a.shown, ...b.shown);
    bound.push(...a.bound, ...b.bound);
    pairs.push({
      question: row.id,
      a: row.a_entity,
      b: row.b_entity,
      basis: row.basis,
      records: { a: a.records, b: b.records },
    });
  }
  return { pairs, shown: [...new Set(shown)], bound: [...new Set(bound)] };
}

type Pair = { id: string; a_entity: string; b_entity: string; compartments: string[] };
type Groups = Awaited<ReturnType<typeof loadGroups>>;

// One same or different: the rows its sources stand on, or why code won't take it. Code compares; it cannot judge
// meaning, which is why either also takes two agents.
async function oneChecked(
  ctx: Ctx,
  groups: Groups,
  loaded: Loaded,
  pair: Pair,
  answer: Exclude<SamePersonAnswer, { verdict: "cant_tell" }>,
): Promise<{ refused: SamePersonRefused["code"] } | { ids: string[] }> {
  const [sideA, sideB] = [groups.membersOf(pair.a_entity), groups.membersOf(pair.b_entity)];
  const a = personOf(openerOf(ctx.keys), loaded, sideA, pair.compartments);
  const b = personOf(openerOf(ctx.keys), loaded, sideB, pair.compartments);
  const cited: { a: Held[]; b: Held[] } = { a: [], b: [] };
  const quotes = [];
  const quoted: { a: string[]; b: string[] } = { a: [], b: [] };
  const ids: string[] = [];
  for (const source of answer.sources) {
    if ("record" in source) {
      const side = sideA.includes(source.record) ? "a" : sideB.includes(source.record) ? "b" : null;
      if (side === null) return { refused: "not_on_record" };
      const [mine, other] = side === "a" ? [a, b] : [b, a];
      const found = mine.held.filter((one) => one.field === source.field && asValue(one) === asValue(source));
      // A value on a card of this person's own before one on a card listing both.
      const row = found.find((one) => !other.held.some((held) => held.row === one.row)) ?? found[0];
      if (row === undefined) return { refused: "not_on_record" };
      cited[side].push(row);
      ids.push(row.row);
      continue;
    }
    const [row] = await ctx.run<{ id: string; compartments: string[]; body_enc: Sealed | null; evidence_id: string }>(
      MESSAGE,
      [source.message],
    );
    const body = row === undefined ? null : open(ctx.keys, row, "knowledge.messages.body_enc", "null");
    const on =
      row === undefined
        ? []
        : await ctx.run<{ entity_id: string }>(
            "select distinct entity_id from knowledge.interaction_log where evidence_id = $1 and entity_id = any($2::text[])",
            [row.evidence_id, [...sideA, ...sideB]],
          );
    const [onA, onB] = [
      on.some((one) => sideA.includes(one.entity_id)),
      on.some((one) => sideB.includes(one.entity_id)),
    ];
    // A message on neither person's log says nothing of them, and one on both can't tell them apart.
    if (onA === onB) return { refused: "not_on_one_log" };
    const side = onA ? ("a" as const) : ("b" as const);
    quotes.push({
      quote: source.quote,
      text: body === null ? null : maskedSpans(body).text,
      side,
      row: source.message,
    });
    quoted[side].push(...phonesIn(source.quote));
    ids.push(source.message);
  }
  if (quotes.length > 0) {
    const names = [...a.held, ...b.held].filter((one) => one.field === "name").map((one) => one.value);
    const addressesOf = (held: Held[]): string[] =>
      held.filter((one) => one.field === "address").map((one) => one.value);
    const claim = { because: answer.because, addresses: { a: addressesOf(a.held), b: addressesOf(b.held) } };
    const refusal = quoteRefusal(quotes, names, claim);
    if (refusal !== null) return { refused: refusal };
  }
  if (answer.verdict !== "same") {
    // A person's own name says nothing of how they differ from anyone.
    const onlyNames = quotes.length === 0 && [...cited.a, ...cited.b].every((one) => one.field === "name");
    return onlyNames ? { refused: "no_agreement" } : { ids };
  }
  const facts = await factsOf(ctx.run, groups.idOf, pair, a, b, quoted);
  if (cited.a.length + cited.b.length === 0) {
    // Quotes prove someone wrote something; they can't join two people who don't even share a name.
    if (!facts.sharedName) return { refused: "no_agreement" };
    const against = againstSame(facts);
    return against === null ? { ids } : { refused: against };
  }
  const refusal = recordsRefusal(answer.because, cited.a, cited.b, facts);
  return refusal === null ? { ids } : { refused: refusal };
}

// Which answers can be taken, the rows each one's sources stand on, and which can't and why: one bad answer
// costs only itself. A question outside the task's batch is refused here.
export async function answersChecked(
  call: { ctx: Ctx },
  batch: string,
  answers: readonly SamePersonAnswer[],
): Promise<{ taken: SamePersonAnswer[]; rows: ReadonlyMap<string, string[]>; refused: SamePersonRefused[] }> {
  const { ctx } = call;
  const people = new Map(
    (
      await ctx.run<Pair>(
        "select id, a_entity, b_entity, compartments from ledger.identity_questions where batch = $1 and state = 'agents'",
        [batch],
      )
    ).map((row) => [row.id, row]),
  );
  const groups = await loadGroups(ctx);
  const asked = answers.flatMap((one) => {
    const pair = one.verdict === "cant_tell" ? undefined : people.get(one.question);
    return pair === undefined ? [] : [...groups.membersOf(pair.a_entity), ...groups.membersOf(pair.b_entity)];
  });
  const loaded = await recordsOf(ctx.run, asked);
  const taken: SamePersonAnswer[] = [];
  const rows = new Map<string, string[]>();
  const refused: SamePersonRefused[] = [];
  for (const answer of answers) {
    const pair = people.get(answer.question);
    if (pair === undefined) {
      refused.push({ question: answer.question, code: "not_asked" });
      continue;
    }
    if (answer.verdict !== "cant_tell") {
      const one = await oneChecked(ctx, groups, loaded, pair, answer);
      if ("refused" in one) {
        refused.push({ question: answer.question, code: one.refused });
        continue;
      }
      rows.set(answer.question, one.ids);
    }
    taken.push(answer);
  }
  return { taken, rows, refused };
}

// The answers, in the report's transaction, through the one definer. `stop` is a refusal that ends them all: the
// lease is gone, or the switch went off. The definer writes nothing on a refusal, so one that is this answer's own
// costs only it, and the rest stand. The request id is the report's, so a retried report replays them.
export async function writeAnswers(
  ctx: Ctx,
  checked: { opportunity: string; answers: readonly SamePersonAnswer[]; rows: ReadonlyMap<string, string[]> },
  requestId: string,
): Promise<{ stop: string | null; taken: number; refused: SamePersonRefused[] }> {
  const refused: SamePersonRefused[] = [];
  let taken = 0;
  for (const answer of checked.answers) {
    const request = derivedId(`${requestId}\n${answer.question}`, 43);
    const cites = [...new Set(checked.rows.get(answer.question) ?? [])];
    const because = answer.verdict === "cant_tell" ? answer.why : answer.because;
    const [row] = await ctx.run<{ code: string }>(
      "select ledger.answer_same_person($1, $2, $3, $4, $5, $6, $7::text[]) as code",
      [answerId(), request, answer.question, checked.opportunity, answer.verdict, because, cites],
    );
    if (row?.code === "no_evidence" || row?.code === "cite_label") {
      refused.push({ question: answer.question, code: row.code });
      continue;
    }
    if (row?.code !== "ok" && row?.code !== "already_answered")
      return { stop: row?.code ?? "not_found", taken, refused };
    taken += 1;
  }
  return { stop: null, taken, refused };
}
