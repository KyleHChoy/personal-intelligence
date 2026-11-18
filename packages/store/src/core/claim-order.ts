import type { ClaimRecord } from "@intelligence/contracts/personal";

// The latest of two claims by valid_from, then id (pipeline-restatement.ts, grouping.ts). By time,
// never by the string: a source moment's claim may hold its message's time with the Mac's offset,
// every other claim a time in UTC.
export const laterClaim = (a: ClaimRecord, b: ClaimRecord): ClaimRecord => {
  const after = Date.parse(b.claim.validFrom) - Date.parse(a.claim.validFrom);
  return after > 0 || (after === 0 && b.claim.id > a.claim.id) ? b : a;
};
