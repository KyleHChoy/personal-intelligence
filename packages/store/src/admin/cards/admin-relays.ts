import {
  CARD_RELAY_SAMPLE,
  type CardId,
  type CardRelayView,
  isCardRelayKind,
  type RulingId,
} from "@intelligence/contracts/personal";
import { DAY_MS } from "@intelligence/personal-core";
import { isoWeek } from "@intelligence/personal-core/planner";
import { relaySample, relayState } from "../../cards/questions-through-agent.ts";
import type { AdminContext, TxAt } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, stamp } from "../../core/db.ts";
import { requestIdOf } from "../../core/ids.ts";
import type { Sealed } from "../../core/seal.ts";
import { openUnder } from "../../core/seal.ts";
import { unrestrictedOf } from "../admin-time-base.ts";
import { cardsShown, decide } from "./admin-queue.ts";
import { ownerReopenCard, type ReopenLeft } from "./admin-reopen.ts";

// Relayed answers, on the owner's side: each relay an agent's call left is applied as an answer of
// the owner's through `decide`, the one path the page's answer takes, and the owner's list of them,
// with a week's sample and its quotes. The agent's process holds no right to run a card's effect;
// this one does. Logs carry ids, codes and counts.

// How many relays one pass applies; the next pass takes the rest.
const APPLY_MOST = 20;

// The request id of the decision a relay makes, from the relay's own id: a repeat finds it.
const relayRequestId = (relay: string): string => requestIdOf(`relay:${relay}`);

// One relay applied: `decide`, marked relayed, with the relay's card and option, and in the same
// transaction the relay given the decision it made. `decide` runs its steps as transactions of the
// context it is handed, so it is handed one whose every transaction is this one: the answer, its
// effect and the relay's mark commit together or not at all. `decide` refuses a card that no
// longer waits (`not_pending`). A card that waits is refused here too (`owner_answered`) when the
// owner acted on it after the relay was taken: deferred it, or answered it and took the answer
// back. The relay was taken only on a card the owner had never touched, so any event of the
// owner's on the card but this answer's own came after it, and the owner's own word stands
// (invariant 11). Read under `decide`'s locks, so no act of the owner's crosses it; the refusal
// rolls the answer back. A card whose kind is no longer asked through an agent is refused before
// anything is decided (`kind_not_relayed`). On a claim's card (RELAYED_CONFIRM_KINDS) the answer
// runs no effect and settles no other card: a relayed confirm releases nothing, and
// policy.relayed_claims, not policy.confirmed_claims, reads it. Null for a relay already settled.
export async function decideRelayed(admin: AdminContext, relay: string): Promise<RulingId | null> {
  return admin.transaction(async (query) => {
    const [row] = await query<{ card_id: CardId; option: string }>(
      "select card_id, option from ledger.card_relays where id = $1 and ruling_id is null and failed_code is null",
      [relay],
    );
    if (row === undefined) return null;
    // Only a card of a kind asked through an agent now: a relay taken while its kind was one, and
    // not applied before the kind left the list, is the owner's to answer on the page.
    const [card] = await query<{ kind: string }>("select kind from ledger.cards where id = $1", [row.card_id]);
    if (card !== undefined && !isCardRelayKind(card.kind)) throw new AdminError("kind_not_relayed");
    const [made] = await decide(
      { ...admin, transaction: (fn) => fn(query) },
      { cards: [row.card_id], answer: row.option, requestId: relayRequestId(relay) },
      { relayed: true },
    );
    if (made === undefined) throw new AdminError("not_pending");
    const [touched] = await query(
      `select 1 from ledger.record_events r
       where r.row_kind = 'card' and r.row_id = $1 and r.by = 'owner'
         and r.id <> (select max(m.id) from ledger.record_events m
                      where m.row_kind = 'card' and m.row_id = $1 and m.by = 'owner' and m.event = 'decided')
       limit 1`,
      [row.card_id],
    );
    if (touched !== undefined) throw new AdminError("owner_answered");
    const linked = await query(
      `update ledger.card_relays y set ruling_id = d.id, applied_at = d.decided_at
       from knowledge.owner_decisions d
       where y.id = $1 and d.id = $2 and y.ruling_id is null and y.failed_code is null returning y.id`,
      [relay, made.ruling],
    );
    if (linked.length === 0) throw new AdminError("not_pending");
    return made.ruling;
  });
}

// Each relay taken and not yet settled, oldest first. One the page's path refuses (the owner
// answered first, the card expired or was removed, the option is no longer the card's), or one the
// owner acted on the card after (`owner_answered`), is marked with the refusal's code and never tried again: the card is the owner's to
// answer. Any other failure leaves the relay for the next pass.
export async function applyRelays(admin: AdminContext): Promise<{ applied: number; failed: number }> {
  // The owner's stop of all agent work stops this pass too: a relay taken before the stop waits,
  // and is applied once work is started again.
  const waiting = await admin.transaction(async (query) =>
    (await workStopped(query))
      ? []
      : query<{ id: string; card: CardId }>(
          `select id, card_id as card from ledger.card_relays where ruling_id is null and failed_code is null order by created_at, id collate "C" limit ${APPLY_MOST}`,
        ),
  );
  const counts = { applied: 0, failed: 0 };
  for (const { id, card } of waiting) {
    try {
      if ((await decideRelayed(admin, id)) !== null) counts.applied += 1;
    } catch (error) {
      if (!(error instanceof AdminError)) {
        admin.log.warn({ event: "relay_apply_failed", ids: { card } });
        continue;
      }
      await admin.transaction((query) =>
        query("update ledger.card_relays set failed_code = $2 where id = $1 and ruling_id is null", [id, error.code]),
      );
      admin.log.info({ event: "relay_not_applied", ids: { card }, code: error.code });
      counts.failed += 1;
    }
  }
  return counts;
}

const workStopped = async (query: Query): Promise<boolean> =>
  (await query<{ state: string }>("select state from ledger.kill_switch order by id desc limit 1"))[0]?.state === "on";

type RelayRow = {
  id: string;
  card_id: CardId;
  kind: string;
  client_name: string;
  option: string;
  created_at: Date;
  ruling_id: string | null;
  failed_code: string | null;
  reopened_at: Date | null;
  compartments: string[];
  quote_enc: Sealed;
};

// `pia cards relayed`: every relayed answer, newest first, at most 200: card, agent, option, time and what became of it. With
// `quotes`, the owner's page's list: each with the owner's words as the agent quoted them, opened under the owner's keys. With
// `sample`, this ISO week's sample alone, at most three chosen by a hash of the relay's id and the week, each with the owner's
// words as the agent quoted them, so drift is seen. A quote that does not open is null.
export async function listRelays(
  admin: AdminContext,
  options: { sample?: boolean; quotes?: boolean } = {},
): Promise<CardRelayView[]> {
  const now = admin.now();
  return admin.transaction(async (query) => {
    const rows = await query<RelayRow>(
      `select y.id, y.card_id, c.kind, y.client_name, y.option, y.created_at, y.ruling_id, y.failed_code, y.reopened_at,
         y.compartments, y.quote_enc
       from ledger.card_relays y join ledger.cards c on c.id = y.card_id and c.tainted_at is null
       where $1::timestamptz is null or y.created_at >= $1::timestamptz
       order by y.created_at desc, y.id collate "C" desc limit 200`,
      [options.sample === true ? stamp(new Date(now.getTime() - 8 * DAY_MS)) : null],
    );
    const week = isoWeek(now, "-W");
    const chosen =
      options.sample === true
        ? new Set(
            relaySample(
              rows.filter((row) => isoWeek(row.created_at, "-W") === week).map((row) => row.id),
              week,
              CARD_RELAY_SAMPLE,
            ),
          )
        : null;
    // The page's list says which question each answered: the card with its lines, as the cards
    // list shows one, within the key file's compartments but the restricted ones, as the ledger's feed.
    const questions =
      options.quotes === true
        ? new Map(
            (
              await cardsShown(
                admin,
                query,
                rows.map((row) => row.card_id),
                unrestrictedOf(admin.keys),
              )
            ).map((one) => [one.id as string, one] as const),
          )
        : null;
    return rows
      .filter((row) => chosen === null || chosen.has(row.id))
      .map((row) => ({
        id: row.id,
        card: row.card_id,
        kind: row.kind,
        agent: row.client_name,
        option: row.option,
        at: stamp(row.created_at),
        state: relayState(row),
        ruling: row.ruling_id,
        code: row.failed_code,
        ...(chosen === null && options.quotes !== true ? {} : { quote: quoteOf(admin, row) }),
        ...(questions === null ? {} : { question: questions.get(row.card_id) ?? null }),
      }));
  });
}

function quoteOf(admin: AdminContext, row: RelayRow): string | null {
  try {
    return openUnder(
      admin.keys,
      row.compartments,
      { table: "ledger.card_relays", id: row.id, column: "quote_enc" },
      row.quote_enc,
    );
  } catch {
    return null;
  }
}

// The page's undo of a relayed answer: the card comes back pending, by the owner, exactly as `pi cards reopen CARD` gives
// it back, and what the reopen left as it was is answered as codes. Only a card an applied relay decided and the owner
// has not taken back: any other is `not_found`, so this write reopens nothing else. The request and what it left are kept
// on the relay, so a repeat of the request answers as the first did and writes nothing.
export async function reopenRelayed(
  tx: TxAt,
  card: CardId,
  request: { requestId: string },
): Promise<{ left: ReopenLeft[] }> {
  const [relay] = await tx.query<{ id: string; reopened: boolean; request: string | null; left: ReopenLeft[] | null }>(
    `select id, reopened_at is not null as reopened, reopen_request as request, reopen_left as left
     from ledger.card_relays where card_id = $1 and ruling_id is not null`,
    [card],
  );
  if (relay?.reopened === true && relay.request === request.requestId) return { left: relay.left ?? [] };
  if (relay === undefined || relay.reopened) throw new AdminError("not_found");
  const reopened = await ownerReopenCard(tx, card);
  await tx.query("update ledger.card_relays set reopen_request = $2, reopen_left = $3 where id = $1", [
    relay.id,
    request.requestId,
    reopened.left,
  ]);
  return reopened;
}
