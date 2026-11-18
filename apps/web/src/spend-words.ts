// Spend today, every lane's (`spendToday`, which the Ledger's day counts the same way): the one
// figure Today, the Ledger and Settings' Health show for it, by one definition.
const spendTotal = (found: { lanes: readonly { spentUsd: number }[] }): number =>
  found.lanes.reduce((sum, lane) => sum + lane.spentUsd, 0);
export const usd = (value: number): string => `$${value.toFixed(2)}`;
export const spentWords = (found: { lanes: readonly { spentUsd: number }[] }): string => usd(spendTotal(found));
// Under it, the capped lanes against their caps, so lane spend with no cap (extraction's is the
// host's) never reads as budget used.
export function spendNote(found: { lanes: readonly { spentUsd: number; capUsd: number | null }[] }): string {
  const capped = found.lanes.filter((lane) => lane.capUsd !== null);
  if (capped.length === 0) return "No cap";
  const cap = usd(capped.reduce((sum, lane) => sum + (lane.capUsd ?? 0), 0));
  const cappedSpent = capped.reduce((sum, lane) => sum + lane.spentUsd, 0);
  return cappedSpent === spendTotal(found) ? `of ${cap}` : `${usd(cappedSpent)} of a ${cap} cap`;
}
// Spend in one plain line: the day's total, then the capped part against its cap, so two amounts
// never run together ("$8.30 today, $5.44 of it against the $32.00 cap").
export const spendLine = (found: Parameters<typeof spendNote>[0]): string => {
  const note = spendNote(found);
  if (note.startsWith("of ")) return `${spentWords(found)} ${note}`;
  return `${spentWords(found)} today, ${note.replace(/^(\$[\d.,]+) of a? ?/, "$1 of it against the ")}`;
};
