import { cardKindRow, kindRank } from "./card-kinds.ts";

// The order Waiting and Today's Needs you list the waiting cards in: by each kind's group, then its
// rank (card-kinds.ts).

export const kindOf = (kind: string): { group: string; title: string; claim: string } =>
  cardKindRow(kind) ?? { group: "Other", title: "A card for you", claim: "Card" };
export const cardGroup = (kind: string): string => kindOf(kind).group;

// Waiting's groups by what needs the owner's decision most (the design's order): what is said about the
// owner and what waits on their approval first, then questions and checks, then what only tells them
// something. A group not named here goes after the named ones. A few groups the owner reads at a glance,
// each kind in one, never a heading a card or two long.
const GROUP_ORDER: readonly string[] = [
  "About you",
  "To approve",
  "Facts to check",
  "Work to check",
  "Reminders",
  "Other",
  "Notices",
];
const groupRank = (group: string): number => {
  const at = GROUP_ORDER.indexOf(group);
  return at === -1 ? GROUP_ORDER.indexOf("Other") : at;
};
// Cards in Waiting's order: by group, by kind within one, newest first within a kind.
export function waitingOrder<T extends { kind: string; createdAt: string }>(cards: readonly T[]): T[] {
  return [...cards].sort(
    (a, b) =>
      groupRank(cardGroup(a.kind)) - groupRank(cardGroup(b.kind)) ||
      kindRank(a.kind) - kindRank(b.kind) ||
      Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
}
