import {
  AgentSettlementMark,
  CardId,
  CardLabel,
  DeclineReason,
  declineAnswersOfCard,
  EntityId,
  FactSettlementId,
  isDeclineAnswer,
  OpportunityKind,
  OwnerNote,
  RulingId,
} from "@intelligence/contracts/personal";
import type { CommandContext } from "../command-types.ts";
import { found, refusal } from "../env.ts";
import { print, printJson, requestId, withAdmin, withNamed } from "./owner-kit.ts";

// The owner's queue and vetoes: `pi review`,
// `pi show`, `pi decide` and `pi veto`, each a thin call into the Admin through `withAdmin`.
// Every argument is checked before the key file is read or a connection is made.

type Value = CommandContext["values"][string];

const WORD = /^[a-z][a-z0-9_]{0,31}$/;

// A word argument, or a usage error.
function word(value: Value): string {
  if (typeof value !== "string" || !WORD.test(value)) throw refusal("usage");
  return value;
}

// `review`: the pending cards, to a terminal only (`commands.ts` refuses any other stdout).
export async function review(context: CommandContext): Promise<0> {
  const { kind, limit } = context.values;
  const options = {
    ...(kind === undefined ? {} : { kind: word(kind) }),
    ...(limit === undefined
      ? {}
      : { limit: typeof limit === "string" && /^[1-9]\d?$/.test(limit) ? Number(limit) : Number.NaN }),
  };
  if (Number.isNaN(options.limit) || (options.limit ?? 0) > 50) throw refusal("usage");
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.cards.listPending(options));
  });
}

// `show CARD`: each line after a mark of who wrote it; a code line has none.
export async function show(context: CommandContext): Promise<0> {
  return withNamed(context, CardId, async (admin, id) => {
    const card = found(await admin.cards.card(id, { view: "cli" }));
    for (const line of card.lines) print(context, line.from === "code" ? line.text : `${line.from}: ${line.text}`);
    const nos = declineAnswersOfCard(card);
    if (nos.length > 0 && (card.state === "pending" || card.state === "deferred"))
      print(context, `why ${nos.join(", ")}: --reason ${DeclineReason.options.join("|")}`);
  });
}

// `decide CARD... --answer A [--labels L,...]`: one request id for each run, so the same
// command run again is refused as not_pending. Prints each card's
// ruling id.
export async function decide(context: CommandContext): Promise<0> {
  const cards = context.positionals.map((one) => CardId.safeParse(one));
  const labels = context.values.labels;
  const parsed = typeof labels === "string" ? labels.split(",").map((one) => CardLabel.safeParse(one)) : [];
  if (
    !cards.every((one) => one.success) ||
    !parsed.every((one) => one.success) ||
    (labels !== undefined && typeof labels !== "string")
  )
    throw refusal("usage");
  // The owner's one-line note (the planner's learning loop): sealed with the decision, and read by
  // the planner's next runs. Over 300 code points, two lines or empty is a usage error.
  const note = context.values.note;
  if (note !== undefined && !OwnerNote.safeParse(note).success) throw refusal("usage");
  // The owner's decline reason, one of the list, on a no only; a no without one stands.
  const reason = context.values.reason === undefined ? undefined : DeclineReason.safeParse(context.values.reason);
  if (reason !== undefined && (!reason.success || !isDeclineAnswer(String(context.values.answer))))
    throw refusal("usage");
  // Where an accepted goal proposal's goal is sealed.
  const compartment = context.values.compartment;
  if (compartment !== undefined && typeof compartment !== "string") throw refusal("usage");
  const args = {
    cards: cards.map((one) => one.data as CardId),
    answer: word(context.values.answer),
    ...(labels === undefined ? {} : { labels: parsed.map((one) => one.data as CardLabel) }),
    ...(typeof note === "string" ? { note } : {}),
    ...(reason === undefined ? {} : { reason: reason.data as DeclineReason }),
    ...(typeof compartment === "string" ? { compartment } : {}),
    requestId: requestId(),
  };
  if (new Set(args.cards).size !== args.cards.length) throw refusal("usage");
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.cards.decide(args));
  });
}

// A veto's kind of work: an OpportunityKind, or `proposal`, the send proxy's kind of work for a
// draft with no opportunity. Another word is a usage error, so a mistyped kind never makes a veto
// that covers nothing.
const vetoKind = (value: Value): string => {
  const kind = word(value);
  if (kind !== "proposal" && !OpportunityKind.safeParse(kind).success) throw refusal("usage");
  return kind;
};

// `veto add [--entity ID] [--kind K]`: at least one. Prints the ruling id.
export async function vetoAdd(context: CommandContext): Promise<0> {
  const { entity, kind } = context.values;
  if (entity === undefined && kind === undefined) throw refusal("usage");
  const id = entity === undefined ? undefined : EntityId.safeParse(entity);
  if (id !== undefined && !id.success) throw refusal("usage");
  const args = {
    ...(id === undefined ? {} : { entity: id.data as EntityId }),
    ...(kind === undefined ? {} : { kind: vetoKind(kind) }),
  };
  return withAdmin(context, async (admin) => {
    printJson(context, {
      ruling: await admin.cards.addVeto(args, { requestId: requestId() }),
    });
  });
}

// `veto list`: ids, subjects, kinds and times.
export async function vetoList(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.cards.listVetoes());
  });
}

// `veto lift ID`: prints nothing. An id that is no standing veto is not_found.
export async function vetoLift(context: CommandContext): Promise<0> {
  return withNamed(context, RulingId, async (admin, id) => {
    found(await admin.cards.liftVeto(id, { requestId: requestId() }));
  });
}

// `cards reopen SETTLEMENT`: the card code held back, or the duplicate withdrawn when the owner answered, comes
// back to the queue at the next pipeline run (or at once, for a withdrawn card). Prints nothing;
// one already reopened is `already_reopened`, an unknown id `not_found`.
// `cards reopen CARD`: a card the policy expired comes back deferred, and what its expiry closed
// is given back its status; a card a rule stopped, or an outcome code settled without the owner,
// comes back pending, and so does a card an agent's relayed answer decided, with that answer
// taken back; any other card is `not_found`. Where that answer changed something the reopen does
// not undo, it prints `{ left_in_place }`, a code for each: `lesson_retired`, `changed_since`, `effect_kept`.
export async function cardsReopen(context: CommandContext): Promise<0> {
  const card = CardId.safeParse(context.positionals[0]);
  if (card.success)
    return withAdmin(context, async (admin) => {
      const { left } = await admin.cards.reopenExpiredCard(card.data);
      if (left.length > 0) printJson(context, { left_in_place: left });
    });
  const id = FactSettlementId.safeParse(context.positionals[0]);
  if (!id.success) throw refusal("usage");
  return withAdmin(context, (admin) => admin.facts.reopenSettlement(id.data));
}

// `cards settled [--sample]`: each card an agent's answer settled, newest first, as JSON: card, kind,
// agent, answer, time, the refs its ruling cites, the owner's mark and whether the owner reopened it.
// With `--sample`, this week's fixed sample alone, at most five. `cards mark CARD
// right|wrong` marks one; `cards reopen CARD` takes one back.
export async function cardsSettled(context: CommandContext): Promise<0> {
  const sample = context.values.sample === true;
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.cards.listSettled({ sample }));
  });
}

// `cards mark CARD right|wrong`: the owner's mark on a card an agent's answer settled, replacing an
// earlier one. Prints nothing; a card no agent settled is `not_found`.
export async function cardsMark(context: CommandContext): Promise<0> {
  const card = CardId.safeParse(context.positionals[0]);
  const mark = AgentSettlementMark.safeParse(context.positionals[1]);
  if (!card.success || !mark.success) throw refusal("usage");
  return withAdmin(context, (admin) => admin.cards.markSettled(card.data, mark.data));
}

// `cards relayed [--sample]`: each answer an agent relayed, newest first, as JSON: card, kind,
// agent, option, time and what became of it. With `--sample`, this week's sample alone, at most
// three, each with the owner's words as the agent quoted them. To a terminal only. `cards reopen
// CARD` takes one back.
export async function cardsRelayed(context: CommandContext): Promise<0> {
  const sample = context.values.sample === true;
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.cards.listRelays({ sample }));
  });
}
