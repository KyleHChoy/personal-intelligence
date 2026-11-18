import type { Timestamp } from "@intelligence/contracts";
import type {
  CardAuthor,
  CardId,
  CardLine,
  ClaimRef,
  DeclineReason,
  LedgerRef,
  LineSource,
  PersonalRef,
  RulingId,
} from "@intelligence/contracts/personal";
import type { Query } from "../core/db.ts";
import type { Keys } from "../core/keys.ts";

// A stored card, as a kind's functions see it: ids, kinds and times, never its body.
export type StoredCard = {
  id: CardId;
  kind: string;
  author: CardAuthor;
  createdAt: Timestamp;
  options: string[];
  target: PersonalRef | LedgerRef | ClaimRef | null;
  requestId: string;
  refs: PersonalRef[];
  compartments: string[];
  caseKey: string | null;
  run: string | null;
  bodyFrom: LineSource | null;
};

// What a kind's `render` may read beyond the card: the admin's transaction and its keys.
export type CardRead = { query: Query; keys: Keys };

// What a kind's `effect` is given. `keys` are the admin's; `note` is the owner's note on their answer,
// when they gave one, which the status event it writes carries. `reason` is the owner's decline
// reason, given only with a no of DECLINE_ANSWERS: the code of the status event that no writes.
// `compartment` is where an accepted goal proposal's added goal is sealed, taken only where
// `takesCompartment` says. `relayed`: the answer is an agent's relay of the owner's words, which the
// owner's process applies; a status it writes carries RELAYED_CODE, so it is never counted as the
// owner's own.
export const RELAYED_CODE = "relayed";
type CardDecision = {
  relayed?: boolean | undefined;
  query: Query;
  card: StoredCard;
  answer: string;
  ruling: RulingId;
  now: Date;
  keys: Keys;
  note?: string | undefined;
  reason?: DeclineReason | undefined;
  compartment?: string | undefined;
};

export type CardKindRow = {
  options: readonly string[];
  // Every ledger row whose status `effect` may change beyond the card and its target, read before
  // the locks from columns that never change.
  lockIds?(query: Query, card: StoredCard): Promise<string[]>;
  // The card's lines for the owner. `open` gives its body opened under the admin's keys, or
  // null when it has none. A line a model or an agent wrote is never marked `code`.
  render(card: StoredCard, open: () => string | null, read: CardRead): CardLine[] | Promise<CardLine[]>;
  // Lines read from the card's target, after `render`'s: a card the tick raised has no body, since
  // the tick holds no key, so what the row says is read here.
  detail?(query: Query, card: StoredCard, keys: Keys): Promise<CardLine[]>;
  // Runs inside `decide`'s transaction, after its locks.
  effect(decision: CardDecision): Promise<void>;
  // Whether `decide`'s compartment is taken with this answer; none is otherwise.
  takesCompartment?(answer: string): boolean;
  // A body code wrote, as its line: its key and parts, where the kind keys it.
  bodyLine?(text: string): CardLine;
};
