import {
  CARD_OPTIONS,
  type CardLine,
  type EntityId,
  GOAL_CHANGE_STATUS,
  type GoalChange,
  type GoalId,
  PROPOSAL_DETAIL_FIELDS,
  ProposalDetails,
  type RulingId,
  TARGET_NO_NAME,
  type Who,
} from "@intelligence/contracts/personal";
import type { CardKindRow, CardRead, StoredCard } from "../../cards/card-kind-row.ts";
import { agentLine, basisLine, codeLine, headingLine, headLines, part, unreadableLine } from "../../cards/card-line.ts";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, stamp } from "../../core/db.ts";
import type { Keys } from "../../core/keys.ts";
import { latestOf } from "../../core/queue.ts";
import { open, type Sealed } from "../../core/seal.ts";
import { ownerWho } from "../admin-owner.ts";
import { holdersSince, targetGoalByName, targetHolders } from "../goals/goal-target-names.ts";
import { derivedRequest, writeGoal, writeGoalReword, writeGoalStatus, writeGoalTarget } from "../goals/goal-writes.ts";

// The owner's card on an agent's proposed goal or goal change, and the structured details of a
// proposal as the owner's card shows them. Every heading is code's; every text the agent wrote is an
// `agent` line, never `code`; the owner's own goal's words are `owner` lines.

const HEADINGS: Readonly<Record<(typeof PROPOSAL_DETAIL_FIELDS)[number], string>> = {
  whyNow: "why now",
  plan: "plan",
  decisionNeeded: "decision needed",
  risks: "risks",
};

// A proposal's details, opened: each given part as a code heading and the agent's text. A body
// that does not parse is shown as unreadable, never as text.
export function detailLines(text: string | null): CardLine[] {
  if (text === null) return [];
  let parsed: ReturnType<typeof ProposalDetails.safeParse>;
  try {
    parsed = ProposalDetails.safeParse(JSON.parse(text));
  } catch {
    return [unreadableLine("details")];
  }
  if (!parsed.success) return [unreadableLine("details")];
  const details = parsed.data;
  return PROPOSAL_DETAIL_FIELDS.flatMap((name) =>
    details[name] === undefined ? [] : [headingLine(HEADINGS[name]), agentLine(details[name])],
  );
}

// An opportunity's details as its card shows them (opportunity_decision's detail). With what the
// agent that put it to the owner searched and read first, as code checked it: counts, tool names
// and ids, never the agent's words.
export async function opportunityDetailLines(query: Query, keys: Keys, opportunity: string): Promise<CardLine[]> {
  const [row] = await query<{
    compartments: string[];
    details_enc: Sealed;
    question_tools: string[] | null;
    question_sources: string[] | null;
  }>("select compartments, details_enc, question_tools, question_sources from ledger.opportunities where id = $1", [
    opportunity,
  ]);
  if (row === undefined) return [];
  const checked =
    row.question_tools === null || row.question_sources === null
      ? []
      : [checkedLine(row.question_tools, row.question_sources)];
  if (row.details_enc === null) return checked;
  const text = open(keys, { ...row, id: opportunity }, "ledger.opportunities.details_enc", "withheld");
  return [...checked, ...(text === null ? [unreadableLine("details")] : detailLines(text))];
}

// "checked first: N searches, M sources", with each search's tool and each source's id behind it.
const checkedLine = (tools: readonly string[], sources: readonly string[]): CardLine =>
  codeLine("checked", [
    part.count(tools.length),
    part.count(sources.length),
    ...tools.map((tool) => part.code(tool)),
    ...sources.map((id) => part.id(id.startsWith("rec_") ? "record" : "item", id)),
  ]);

type ProposalRow = {
  id: string;
  change: GoalChange | "target";
  goal_id: GoalId | null;
  target_entity_id: EntityId | null;
  target_org: boolean;
  target_holders: string[] | null;
  statement_enc: Sealed;
  proposed_compartment: string | null;
  body_enc: Sealed;
  details_enc: Sealed;
  compartments: string[];
  tainted_at: Date | null;
};

const proposalOf = async (query: Query, card: StoredCard): Promise<ProposalRow | undefined> =>
  card.target?.kind !== "goal_proposal"
    ? undefined
    : (
        await query<ProposalRow>(
          "select id, change, goal_id, target_entity_id, target_org, target_holders, statement_enc, proposed_compartment, body_enc, details_enc, compartments, tainted_at from ledger.goal_proposals where id = $1",
          [card.target.id],
        )
      )[0];

// What the owner's reads call someone: their name, else their address, else that they have none.
const nameOf = (who: Who | undefined): string => who?.name?.untrusted ?? who?.address?.untrusted ?? TARGET_NO_NAME;

// A proposed target: who it names, by id, or the name as the agent gave it and each one holding it
// under the goal's label, for the owner's eye alone. Their names are the owner's to read.
async function targetLines(read: CardRead, row: ProposalRow): Promise<CardLine[]> {
  if (row.target_entity_id !== null) {
    const who = await ownerWho(read, [row.target_entity_id]);
    return [
      codeLine(
        "target_proposed",
        [part.id("entity", row.target_entity_id)],
        [{ kind: "entity", id: row.target_entity_id }],
      ),
      headingLine("proposed target"),
      { text: nameOf(who.get(row.target_entity_id)), from: "source" },
    ];
  }
  const name = open(read.keys, row, "ledger.goal_proposals.statement_enc", "withheld");
  if (name === null || row.goal_id === null) return [headingLine("proposed target"), unreadableLine("statement")];
  const holders = await targetHolders(read.query, read.keys, { goal: row.goal_id, name, organization: row.target_org });
  const who = await ownerWho(
    read,
    holders.map((one) => one.entity),
  );
  const since = await holdersSince(read.query, read.keys, {
    goal: row.goal_id,
    name,
    organization: row.target_org,
    raisedWith: row.target_holders ?? [],
  });
  const [goal] = await read.query<{ compartments: string[] }>(
    "select compartments from projections.goal_state where goal_id = $1",
    [row.goal_id],
  );
  return [
    headingLine("proposed target"),
    agentLine(name),
    // The agent read this name under its whole clearance; accepted, it stays with the goal.
    codeLine(
      "target_name_label",
      (goal?.compartments ?? []).map((one) => part.code(one)),
    ),
    ...(since.length === 0 ? [] : [codeLine("target_holders_changed")]),
    ...holders.map((one) => {
      const named = who.get(one.entity)?.name?.untrusted ?? who.get(one.entity)?.address?.untrusted;
      return codeLine(
        "target_held_by",
        [
          part.id("entity", one.entity),
          one.lastSeen === null ? part.code("never") : part.time(one.lastSeen),
          ...(named === undefined ? [] : [part.text(named)]),
        ],
        [{ kind: "entity", id: one.entity }],
      );
    }),
    ...(since.length > 0 || holders.length > 1 ? [codeLine("target_pick")] : []),
  ];
}

// The owner's yes on a proposed target, by the code `pia goal target` runs. A name someone came to
// hold since the card was raised is refused, the card saying so, until the owner picks. A name one holds is that
// one; a name several hold is theirs to pick, on their terminal, unless their pick is already in force;
// a name none holds waits on the next sync. False for a goal or an entity that went.
async function acceptTarget(
  query: Query,
  keys: Keys,
  row: ProposalRow,
  goal: GoalId,
  requestId: string,
  now: Date,
): Promise<boolean> {
  if (row.target_entity_id !== null)
    return writeGoalTarget(query, { goal, entity: row.target_entity_id, requestId, now });
  const name = open(keys, row, "ledger.goal_proposals.statement_enc", "withheld");
  if (name === null) throw new AdminError("invalid_argument");
  const input = { goal, name, organization: row.target_org, requestId, now };
  const answer = await targetGoalByName(query, keys, input);
  if (answer === null) return false;
  if (answer.kind !== "holders") return true;
  const [state] = await query<{ target: string | null }>(
    "select target_entity_id as target from projections.goal_state where goal_id = $1",
    [goal],
  );
  if (answer.holders.some((one) => one.entity === state?.target)) return true;
  // Someone who came to hold the name after the card was raised is not who it asked about.
  const raisedWith = row.target_holders ?? [];
  if ((await holdersSince(query, keys, { goal, name, organization: row.target_org, raisedWith })).length > 0)
    throw new AdminError("holders_changed");
  const [only, second] = answer.holders;
  if (only === undefined || second !== undefined) throw new AdminError("name_held_by_several");
  await targetGoalByName(query, keys, { ...input, entity: only.entity });
  return true;
}

export const goalProposal: CardKindRow = {
  options: CARD_OPTIONS.goal_proposal,
  takesCompartment: (answer) => answer === "accept",
  async render(card, _body, read) {
    const lines = headLines(card);
    const row = await proposalOf(read.query, card);
    if (row === undefined) return [...lines, codeLine("removed", [part.code("proposal")])];
    if (row.tainted_at !== null) return [...lines, codeLine("proposal_tainted")];
    lines.push(codeLine("change", [part.code(row.change)]));
    if (row.goal_id !== null) {
      lines.push(codeLine("goal", [part.id("goal", row.goal_id)], [{ kind: "goal", id: row.goal_id }]));
      const [goal] = await read.query<{ status: string; statement_enc: Sealed; compartments: string[] }>(
        "select status, statement_enc, compartments from projections.goal_state where goal_id = $1",
        [row.goal_id],
      );
      if (goal !== undefined) {
        lines.push(codeLine("goal_status", [part.code(goal.status)]));
        const words = open(read.keys, { ...goal, id: row.goal_id }, "projections.goal_state.statement_enc", "withheld");
        lines.push(words === null ? unreadableLine("goal") : { text: words, from: "owner" });
      }
    }
    if (row.change === "target") lines.push(...(await targetLines(read, row)));
    else if (row.statement_enc !== null) {
      const statement = open(read.keys, row, "ledger.goal_proposals.statement_enc", "withheld");
      lines.push(
        headingLine("proposed words"),
        statement === null ? unreadableLine("statement") : agentLine(statement),
      );
    }
    if (row.proposed_compartment !== null)
      lines.push(codeLine("compartment_proposed", [part.code(row.proposed_compartment)]));
    const summary = open(read.keys, row, "ledger.goal_proposals.body_enc", "withheld");
    lines.push(headingLine("why"), summary === null ? unreadableLine("summary") : agentLine(summary));
    lines.push(
      ...(row.details_enc === null
        ? []
        : (() => {
            const text = open(read.keys, row, "ledger.goal_proposals.details_enc", "withheld");
            return text === null ? [unreadableLine("details")] : detailLines(text);
          })()),
    );
    // The target is a ref of the proposal's so an erasure reaches it; the card names it above.
    const refs = (
      await read.query<{ ref_kind: string; ref_id: string }>(
        "select ref_kind, ref_id from ledger.basis where row_kind = 'goal_proposal' and row_id = $1 order by id",
        [row.id],
      )
    ).filter((ref) => ref.ref_kind !== "target_name" && ref.ref_id !== row.target_entity_id);
    lines.push(...refs.map((ref) => basisLine(ref)), codeLine("goal_effect", [part.code(row.change)]));
    return lines;
  },
  // The owner's accept makes the change the owner's, by the commands' own code; their reject binds this
  // agent's same change (ledger.propose_goal). A proposal tainted or no longer open records the owner's
  // answer alone. The owner's reject carries their decline reason as its code, as their other noes do.
  async effect({ query, card, answer, ruling, now, keys, reason, compartment }) {
    const row = await proposalOf(query, card);
    if (row === undefined) return;
    if (compartment !== undefined && row.change !== "add") throw new AdminError("invalid_argument");
    if (row.tainted_at !== null || (await latestOf(query, "goal_proposal", row.id)) !== "proposed") return;
    const done = (event: string, code: string | null = null): Promise<unknown> =>
      query(
        "insert into ledger.record_events (row_kind, row_id, event, at, by, code, compartments) values ('goal_proposal', $1, $2, $3, 'owner', $4, ledger.label($5))",
        [row.id, event, stamp(now), code, row.compartments],
      );
    if (answer === "reject") {
      await done("rejected", reason ?? null);
      return;
    }
    if (answer !== "accept") return;
    const requestId = derivedRequest(ruling as RulingId, "goal");
    if (row.change === "add") {
      const statement = open(keys, row, "ledger.goal_proposals.statement_enc", "withheld");
      const sealIn = compartment ?? row.proposed_compartment;
      if (statement === null || sealIn === null) throw new AdminError("invalid_argument");
      await writeGoal(query, keys, { statement, compartment: sealIn, requestId, now });
      await done("accepted");
      return;
    }
    // A change to a goal that is gone records the answer from the owner and changes nothing: `withdrawn`.
    const goal =
      row.goal_id === null
        ? undefined
        : (
            await query<{ status: string }>("select status from projections.goal_state where goal_id = $1", [
              row.goal_id,
            ])
          )[0];
    if (row.goal_id === null || goal === undefined) {
      await done("withdrawn");
      return;
    }
    if (row.change === "target") {
      await done((await acceptTarget(query, keys, row, row.goal_id, requestId, now)) ? "accepted" : "withdrawn");
      return;
    }
    if (row.change === "reword") {
      const statement = open(keys, row, "ledger.goal_proposals.statement_enc", "withheld");
      if (statement === null) throw new AdminError("invalid_argument");
      await done(
        (await writeGoalReword(query, keys, { goal: row.goal_id, statement, requestId, now }))
          ? "accepted"
          : "withdrawn",
      );
      return;
    }
    // A status the owner already set since the proposal is in force: no second decision supersedes theirs.
    const status = GOAL_CHANGE_STATUS[row.change as keyof typeof GOAL_CHANGE_STATUS];
    if (goal.status !== status && !(await writeGoalStatus(query, { goal: row.goal_id, status, requestId, now }))) {
      await done("withdrawn");
      return;
    }
    await done("accepted");
  },
};
