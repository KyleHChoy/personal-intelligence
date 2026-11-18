// What a card's case key says, stated once: each raiser writes it with the function here and its kind
// reads it back with the other. A stale restatement's is written by ledger.stale_restatements().

export const driftCase = (point: string, version: number | string): string => `drift:${point}@${version}`;
export const driftPoint = (caseKey: string): string => caseKey.replace(/^drift:/, "");

export const ignoreNarrowedCase = (ruling: string): string => `ignore_narrowed:${ruling}`;
export const ignoreNarrowedRuling = (caseKey: string | null): string | undefined => caseKey?.split(":")[1];

// `<client>:<first 33 of the fact key>`.
export const staleCase = (caseKey: string | null): { client: string; fact: string } => {
  const [client = "", fact = ""] = (caseKey ?? "").split(":");
  return { client, fact };
};
