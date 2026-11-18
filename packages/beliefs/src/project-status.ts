import type {
  ProjectStanding,
  ProjectStandingValue,
  ProjectStatusBy,
  ProjectStatusTier,
} from "@intelligence/contracts/personal";

// A project's current status, built at each read from the status claims one caller can see: the
// owner's word first, then a source's, then an agent's, the latest within a tier. Pure: the store
// gives each claim's tier and speaker as it read them, and nothing here reads a model's words.

// One statement of where the project stands: a status claim, with the tier code gave it.
export type StatusWord = { tier: ProjectStatusTier; value: ProjectStandingValue; at: string; by: ProjectStatusBy };

const RANK: readonly ProjectStatusTier[] = ["owner", "source", "agent"];

// The later of two words; at one instant, by value and then speaker, so the answer never depends on
// the order the rows came in.
const speaker = (by: ProjectStatusBy): string =>
  by.kind === "owner" ? "" : by.kind === "agent" ? (by.client ?? "") : (by.who?.id ?? "");
const later = (a: StatusWord, b: StatusWord): StatusWord => {
  const [ta, tb] = [Date.parse(a.at), Date.parse(b.at)];
  if (ta !== tb) return ta > tb ? a : b;
  if (a.value !== b.value) return a.value < b.value ? a : b;
  return speaker(a.by) <= speaker(b.by) ? a : b;
};
const said = (word: StatusWord) => ({ value: word.value, asOf: word.at, by: word.by });

// `created`: when the project was made and by whom; with no word on it yet, it is active since
// then. `closed`: the owner's close, which outranks every claim (invariant 11); only a word said
// after it is shown beside it. Otherwise the highest tier that has spoken decides by its latest
// word, and the latest word of each lower tier that says something else is shown as `disputedBy`,
// the higher tier first.
export function projectStanding(input: {
  created: { at: string; by: ProjectStatusBy };
  closed?: { at: string };
  words: readonly StatusWord[];
}): ProjectStanding {
  const latest = new Map<ProjectStatusTier, StatusWord>();
  for (const word of input.words) {
    const held = latest.get(word.tier);
    latest.set(word.tier, held === undefined ? word : later(held, word));
  }
  const spoken = RANK.flatMap((tier) => latest.get(tier) ?? []);
  if (input.closed !== undefined) {
    const closedAt = Date.parse(input.closed.at);
    const since = spoken.filter((word) => Date.parse(word.at) > closedAt).map(said);
    return {
      value: "closed",
      asOf: input.closed.at,
      by: { kind: "owner" },
      ...(since.length === 0 ? {} : { disputedBy: since }),
    };
  }
  const [winner, ...rest] = spoken;
  if (winner === undefined) return { value: "active", asOf: input.created.at, by: input.created.by };
  const disputes = rest.filter((word) => word.value !== winner.value).map(said);
  return { ...said(winner), ...(disputes.length === 0 ? {} : { disputedBy: disputes }) };
}
