import type { OpenedMoment } from "@intelligence/contracts/personal";
import { sourceOwnerWord } from "@intelligence/personal-core/lens";

// Lens's `owner` mark on the cited line is the attribution's to check. The window and the vouch are core's
// `sourceOwnerWord`, which the participant step shares.
export function ownWordMoment(opened: OpenedMoment): boolean {
  const { item, capture } = opened;
  if (item.entity !== "chat" || (item.read !== "ax" && item.read !== "db") || item.turns === undefined) return false;
  return sourceOwnerWord(capture.facts, capture.endedAt);
}
