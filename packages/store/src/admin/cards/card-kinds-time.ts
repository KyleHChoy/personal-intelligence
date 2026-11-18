import type { CardId } from "@intelligence/contracts/personal";
import { CARD_OPTIONS, dayIn } from "@intelligence/contracts/personal";
import { THE_OWNER } from "@intelligence/personal-core";
import type { CardKindRow } from "../../cards/card-kind-row.ts";
import { codeLine, headLines, part } from "../../cards/card-line.ts";
import { byText, type Query, stamp } from "../../core/db.ts";
import { newId, requestIdOf } from "../../core/ids.ts";
import type { Keys } from "../../core/keys.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import { raiseCard } from "../../core/queue.ts";
import { sealUnder } from "../../core/seal.ts";
import { ownerZoneOf } from "../../core/zone.ts";
import { proposalText } from "../../lens/time-group-text.ts";

// The daily pass's card: a group of the owner's time that fits no project.
// Its time sits in knowledge.time_rulings with this card's id, crediting nothing, until the owner answers.
// Yes makes the project, named by code from what the group's evidence says now, and the stretches
// credit it. The project keeps which items named it, so the erasure hook can replace the name when
// they go. No keeps them as stretches the pass never proposes again. A card whose evidence was
// erased holds nothing: yes then makes nothing. A yes with no stretch left that names anything, since a
// later revision of the day dropped them all, takes its rows off and withdraws the card, so the time is
// asked about again if it comes back, and a notice tells the owner: a yes is never silently lost.

const NAME_MOST = 200;

type Stretch = { id: string; from_at: Date; to_at: Date; evidence_ids: string[] };

// What the first stretch that still has any words says, so one dropped stretch costs no other's name.
async function wordsOf(query: Query, keys: Keys, stretches: readonly Stretch[]) {
  for (const one of stretches) {
    const text = await proposalText(query, keys, one.evidence_ids, one.from_at.getTime());
    if (text !== null && text.trim() !== "") return { text, evidence: one.evidence_ids };
  }
  return null;
}

export const timeEffort: CardKindRow = {
  options: CARD_OPTIONS.time_effort,
  async render(card, _open, { query, keys }) {
    const stretches = await query<Stretch>(
      "select id, from_at, to_at, evidence_ids from knowledge.time_rulings where pending_card = $1 order by from_at, id",
      [card.id],
    );
    const head = headLines(card);
    const first = stretches[0];
    if (first === undefined) return [...head, codeLine("proposal_none")];
    const minutes = stretches.reduce((sum, one) => sum + (one.to_at.getTime() - one.from_at.getTime()) / 60_000, 0);
    const zone = await ownerZoneOf(query);
    const days = new Set(stretches.map((one) => dayIn(one.from_at, zone))).size;
    const text = (await wordsOf(query, keys, stretches))?.text;
    return [
      ...head,
      codeLine("time_effort", [part.code(String(Math.round(minutes))), part.code(String(days))]),
      { text: text ?? "", from: "source" },
      codeLine("time_effort_note"),
    ];
  },
  effect: async ({ query, card, answer, ruling, now, keys }) => {
    const stretches = await query<Stretch>(
      "select id, from_at, to_at, evidence_ids from knowledge.time_rulings where pending_card = $1 order by from_at, id",
      [card.id],
    );
    const first = stretches[0];
    if (first === undefined) return;
    if (answer !== "confirm") {
      await query(
        "update knowledge.time_rulings set lifted_at = $2, lift_ruling_id = $3, pending_card = null where pending_card = $1",
        [card.id, stamp(now), ruling],
      );
      return;
    }
    const words = await wordsOf(query, keys, stretches);
    if (words === null) {
      await query("delete from knowledge.time_rulings where pending_card = $1", [card.id]);
      await query(
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'withdrawn', $2, 'system:time', ledger.label($3))",
        [card.id, stamp(now), card.compartments],
      );
      await raiseCard(
        query,
        {
          id: newId("crd") as CardId,
          requestId: `time_yes_lost_${card.id.slice(4)}`,
          kind: "notice",
          author: "system:time",
          options: [...CARD_OPTIONS.notice],
          target: null,
          refs: [],
          compartments: card.compartments,
          expiresAt: null,
          expiresAfterDays: null,
          caseKey: null,
          run: null,
          body: null,
          bodyFrom: null,
        },
        { now },
      );
      return;
    }
    const name = words.text.trim().slice(0, NAME_MOST);
    const project = newId("ent");
    const label = [...card.compartments].sort(byText);
    await ownerDecision(
      query,
      {
        requestId: requestIdOf(`${card.requestId}\nproject`),
        kind: "project_add",
        target: { kind: "entity", id: project },
        compartments: label,
      },
      now,
    );
    await query("insert into knowledge.entities (id, kind) values ($1, 'project')", [project]);
    await query(
      "insert into knowledge.projects (id, status, name_enc, compartments, readers, named_from) values ($1, 'active', $2, $3, $4, $5)",
      [
        project,
        sealUnder(keys, label, { table: "knowledge.projects", id: project, column: "name_enc" }, name),
        label,
        [THE_OWNER],
        words.evidence,
      ],
    );
    await query("update knowledge.time_rulings set project_id = $2, pending_card = null where pending_card = $1", [
      card.id,
      project,
    ]);
  },
};
