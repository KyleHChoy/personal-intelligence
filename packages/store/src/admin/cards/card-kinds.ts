import {
  CARD_OPTIONS,
  type CardLine,
  type KnownCardKind,
  type LineSource,
  SendPayload,
} from "@intelligence/contracts/personal";
import type { CardKindRow, StoredCard } from "../../cards/card-kind-row.ts";
import { aboutYou, agentClaim, clientPreference } from "../../cards/card-kinds-claims.ts";
import {
  codeLine,
  codeLines,
  headLines,
  part,
  rulingLostLine,
  saidLine,
  unreadableLine,
} from "../../cards/card-line.ts";
import { driftPoint, ignoreNarrowedRuling, staleCase } from "../../cards/case-keys.ts";
import { HEALTH_CASE } from "../../core/box-health.ts";
import { stamp } from "../../core/db.ts";
import type { Sealed } from "../../core/seal.ts";
import { open } from "../../core/seal.ts";
import { latestEvent, latestRow } from "../../core/statements.ts";
import { sameFact } from "./card-kinds-facts.ts";
import { goalProposal } from "./card-kinds-goals.ts";
import { samePerson, sharedAddress } from "./card-kinds-identity.ts";
import { questionRule, samePersonBatch } from "./card-kinds-questions.ts";
import { rateSuggestion } from "./card-kinds-rates.ts";
import { relationAudit } from "./card-kinds-relations.ts";
import { researchRequest } from "./card-kinds-research.ts";
import { tierProposal } from "./card-kinds-tier.ts";
import { timeEffort } from "./card-kinds-time.ts";
import { cardLines, idea, lesson, opportunityDecision, outcome, ownerQuestion, reminder } from "./card-kinds-work.ts";

// The card kinds: a table in code, a row for each kind of the contract's CARD_OPTIONS, so a kind with
// no row fails to compile, and one not in the table is `not_built`. What else a new kind needs is
// listed above CARD_OPTIONS.

// A card that tells the owner something and asks only that the owner saw it. Its lines are code's:
// the card's kind, author, time and refs; about a run, the code its run ended with. The time pass's
// notice with no ref says a yes made no project (card-kinds-time.ts).
const notice: CardKindRow = {
  options: CARD_OPTIONS.notice,
  render: (card) => [
    ...codeLines(card),
    ...(card.author === "system:time" && card.refs.length === 0 ? [codeLine("time_yes_lost")] : []),
  ],
  detail: async (query, card) => {
    if (card.target?.kind !== "run") return [];
    const [last] = await query<{ code: string | null }>(`${latestRow("code", "run", "$1", { alias: "" })}`, [
      card.target.id,
    ]);
    return [codeLine("run_failed", [part.code(last?.code ?? "none")])];
  },
  effect: async () => {},
};

// The waiting draft: a card of a kind with no decision point, raised by the tick. Its lines are
// code's and name the draft and the command that shows it; it opens nothing. `reject` ends a draft
// that is made and that no send has begun; once one has, the decision alone is recorded.
// `acknowledge` changes nothing: the draft waits until it is sent or expires.
const draftOf = (card: StoredCard): string | null =>
  card.target !== null && card.target.kind === "draft" ? card.target.id : null;

const sendPayloadOf = (text: string | null): SendPayload | null => {
  if (text === null) return null;
  try {
    const parsed = SendPayload.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const draftWaiting: CardKindRow = {
  options: CARD_OPTIONS.draft_waiting,
  lockIds: async (_query, card) => {
    const draft = draftOf(card);
    return draft === null ? [] : [draft];
  },
  render: (card) => {
    const draft = draftOf(card);
    return [
      ...headLines(card),
      ...(draft === null
        ? []
        : [codeLine("draft", [part.id("draft", draft)]), codeLine("read_draft", [part.id("draft", draft)])]),
    ];
  },
  // Its subject and recipients, as the agent wrote them, so the card is named by what it sends.
  // None for a tainted draft, one under a key the file lacks, or one whose
  // body does not parse: `pi send show` says why.
  detail: async (query, card, keys) => {
    const draft = draftOf(card);
    if (draft === null) return [];
    const [row] = await query<{ compartments: string[]; body_enc: Sealed }>(
      "select compartments, body_enc from ledger.drafts where id = $1 and tainted_at is null and body_enc is not null",
      [draft],
    );
    if (row === undefined) return [];
    const text = open(keys, { ...row, id: draft }, "ledger.drafts.body_enc", "withheld");
    const payload = sendPayloadOf(text);
    if (payload === null) return [];
    return [
      saidLine("agent", "draft_subject", [part.text(payload.subject)]),
      saidLine("agent", "draft_to", [part.text(payload.to.join(", "))]),
    ];
  },
  effect: async ({ query, card, answer, now }) => {
    const draft = draftOf(card);
    if (answer !== "reject" || draft === null) return;
    await query(
      `insert into ledger.record_events (row_kind, row_id, event, at, by, compartments)
       select 'draft', d.id, 'rejected', $2, 'owner', d.compartments from ledger.drafts d
       where d.id = $1
         and (${latestEvent("draft", "d.id")}) = 'made'
         and not exists (select 1 from ledger.sent_messages s where s.draft_id = d.id
           and (${latestEvent("send", "s.id")}) in ('sending', 'unknown', 'sent'))`,
      [draft, stamp(now)],
    );
  },
};

// The drift card: raised by `pi ladder calibrate` when a point version drifts, with no body; its
// case key names the point and version, and its target the report. `seen` changes nothing: a
// suspension is lifted by `pi ladder resume`, and a hold point's threshold is the owner's to move.
const calibrationDrift: CardKindRow = {
  options: CARD_OPTIONS.calibration_drift,
  render: (card) => [
    ...headLines(card),
    ...(card.caseKey === null ? [] : [codeLine("point", pointParts(driftPoint(card.caseKey)))]),
    ...(card.target === null ? [] : [codeLine("report", [part.id(card.target.kind, card.target.id)])]),
    codeLine("see_it", [part.code("ladder calibrate")]),
  ],
  effect: async () => {},
};

// A box health card (box-health.ts), raised by the coverage record, the timer's `pia health` calls
// or the backup reminder, as system:health, with no body. Every line is code's: what went wrong
// (`health:`) and what it is about (`about:`), both from its case key, and where to read it whole.
// `seen` changes nothing.
const boxHealth: CardKindRow = {
  options: CARD_OPTIONS.box_health,
  render: (card) => {
    const [, kind, about] = HEALTH_CASE.exec(card.caseKey ?? "") ?? [];
    return [
      ...headLines(card),
      ...(kind === undefined ? [] : [codeLine("health", [part.code(kind)])]),
      ...(about === undefined ? [] : [codeLine("about", [part.code(about)])]),
      kind !== "backup_due"
        ? codeLine("see_it", [part.code("status")])
        : about === "restore"
          ? codeLine("see_it", [part.code("outcomes")])
          : codeLine("record_dump"),
    ];
  },
  effect: async () => {},
};

// The rewrite card: raised by the tick, as system:memory, with no body, when one
// client restated one superseded fact three times. Its case key is the client's id and the fact key
// fingerprint's first 33 characters. Every line is code's: the client's name, the count of
// uncleared stale marks of records that still have a body since the pair's latest decided card, the
// first and last times, the fact key's first 16 characters and the latest claim under that fact
// key, which the owner's page opens, so the notice names the fact by its words. `acknowledge`
// changes nothing: the next count starts after it. The count is ledger.stale_restatements()'s, read
// again here as pi_admin, which holds no grant on that function.
const STALE_MARKS = `
  with marks as (
    select r.checked_at as at from ledger.restatement_checks r join ledger.agent_writes w on w.id = r.record_id
    where r.client_id = $1 and left(r.matched_fact_key_fp, 33) = $2 and r.answer = 'stale' and r.cleared_at is null and w.body_enc is not null
    union all
    select m.created_at from ledger.memory_imports m join ledger.agent_writes w on w.id = m.record_id
    where m.client_id = $1 and m.mark = 'stale' and w.body_enc is not null
      and exists (select 1 from ledger.memory_projections q where q.id = any (m.matched_projection_ids) and left(q.fact_key_fp, 33) = $2)
  ),
  decided as (
    select max(e.at) as at from ledger.cards c join ledger.record_events e on e.row_kind = 'card' and e.row_id = c.id and e.event = 'decided'
    where c.kind = 'stale_restatement' and c.created_by = 'system:memory' and c.case_key = $3 and c.id <> $4
  )
  select (select name from policy.clients where id = $1) as name, count(*)::int as n, min(k.at) as first_at, max(k.at) as last_at
  from marks k, decided d where d.at is null or k.at > d.at`;

const staleRestatement: CardKindRow = {
  options: CARD_OPTIONS.stale_restatement,
  render: (card) => headLines(card),
  detail: async (query, card) => {
    const { client, fact } = staleCase(card.caseKey);
    const [row] = await query<{ name: string | null; n: number; first_at: Date | null; last_at: Date | null }>(
      STALE_MARKS,
      [client, fact, card.caseKey, card.id],
    );
    const [claim] =
      fact === ""
        ? []
        : await query<{ id: string }>(
            "select c.id from knowledge.claims c where left(c.fact_key_fp, 33) = $1 order by c.valid_from desc, c.id desc limit 1",
            [fact],
          );
    const when = (at: Date | null | undefined) => (at === null || at === undefined ? [] : [part.time(stamp(at))]);
    return [
      codeLine("client", [row?.name == null ? part.code("none") : part.text(row.name)]),
      codeLine("restated", [part.count(row?.n ?? 0)]),
      codeLine("first", when(row?.first_at)),
      codeLine("last", when(row?.last_at)),
      codeLine("fact_key", fact === "" ? [] : [part.code(fact.slice(0, 16))]),
      ...(claim === undefined
        ? []
        : [codeLine("claim", [part.id("fact", claim.id)], [{ kind: "fact", id: claim.id }])]),
    ];
  },
  effect: async () => {},
};

// A refold whose new fold was coarser than a domain ignore's key narrowed the ignore to the
// addresses it covered (ignore-rekey.ts), raised by system:identity. Its lines are code's and name
// the ruling by id; its body, after them, the new domains to ignore, one a line. It asks only that
// the owner saw it, and changes nothing.
const ignoreNarrowed: CardKindRow = {
  options: CARD_OPTIONS.ignore_narrowed,
  render: (card) => [
    ...cardLines(card),
    codeLine("ruling", rulingParts(ignoreNarrowedRuling(card.caseKey))),
    codeLine("refold"),
  ],
  effect: async () => {},
};

// A drifted point by its name and version (`name@3`), or its words when it is not one.
const pointParts = (point: string) => {
  const named = /^(.+)@(\d+)$/.exec(point);
  return named === null ? [part.code(point)] : [part.code(named[1] ?? ""), part.count(Number(named[2]))];
};
// The ignore a narrowed card names, by its ruling, or "none".
const rulingParts = (ruling: string | undefined) =>
  ruling === undefined || ruling === "" || ruling === "none" ? [part.code("none")] : [part.id("ruling", ruling)];

// A ruling of the owner's that the carry-over sweep could not re-attach by code after a generation
// raise, raised by system:carry (admin-reattach.ts). Its body is one line of code's, which the
// card's view shows after these: the ruling, its verdict, the generation and each candidate claim
// by id, or that none was found. It asks which claim the ruling applies to. The owner answers by
// ruling again with the ruling's own command, so the new ruling is the owner's; `acknowledge` changes
// nothing.
const rulingCarry: CardKindRow = {
  options: CARD_OPTIONS.ruling_carry,
  render: (card) => [...cardLines(card), codeLine("case", [part.code(card.caseKey ?? "none")])],
  // Its stored body, code's question, as its parts: a body this store did not write so is its words.
  bodyLine: (text) => rulingLostLine(text),
  effect: async () => {},
};

// A card's stored body as its line: `body_unreadable` when the key file cannot open it, a body code
// wrote as its kind keys it, else its words marked with who wrote them.
export function bodyLineOf(
  kind: CardKindRow | undefined,
  body: string | null,
  from: LineSource | null,
  unreadable: boolean,
): CardLine[] {
  if (unreadable) return [unreadableLine("body")];
  if (body === null || from === null) return [];
  return [from === "code" && kind?.bodyLine !== undefined ? kind.bodyLine(body) : { text: body, from }];
}

const ROWS = {
  notice,
  opportunity_decision: opportunityDecision,
  owner_question: ownerQuestion,
  outcome: outcome,
  reminder: reminder,
  agent_claim: agentClaim,
  // A proposal about the owner and a client-scoped preference.
  about_you: aboutYou,
  client_preference: clientPreference,
  draft_waiting: draftWaiting,
  // Contacts and identity's two kinds.
  same_person: samePerson,
  shared_address: sharedAddress,
  // What agents could not settle, on one card, and a rule proposed from the owner's own answers.
  same_person_batch: samePersonBatch,
  question_rule: questionRule,
  // Two fact keys that may state one fact.
  same_fact: sameFact,
  ignore_narrowed: ignoreNarrowed,
  ruling_carry: rulingCarry,
  calibration_drift: calibrationDrift,
  // The box's health.
  box_health: boxHealth,
  stale_restatement: staleRestatement,
  // A client's research request.
  research_request: researchRequest,
  // The planner's idea and lesson cards.
  idea: idea,
  lesson: lesson,
  // An agent's proposed goal or goal change.
  goal_proposal: goalProposal,
  // The owner's audit of a switched-on model relation.
  relation_audit: relationAudit,
  // The tier proposer's card.
  tier_proposal: tierProposal,
  // The daily time pass's proposal of a new project.
  time_effort: timeEffort,
  // A confirm rate's proposals: a standing release, and its lift.
  grant_suggestion: rateSuggestion,
  grant_lift_suggestion: rateSuggestion,
} satisfies Record<KnownCardKind, CardKindRow>;
export const CARD_KINDS: Record<string, CardKindRow> = ROWS;
