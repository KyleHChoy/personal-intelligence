import type { ModelCallKey, ModelCallRecord, ModelCallStore } from "@intelligence/contracts";

// Calls saved for one evaluation only, as every lane's evaluation keeps them: an item asked twice
// in one run is answered once. One copy, so a change to the call's key is made in one place.
export function callsInMemory(): ModelCallStore {
  const saved: ModelCallRecord[] = [];
  const same = (a: ModelCallKey, b: ModelCallKey): boolean =>
    a.evidenceId === b.evidenceId &&
    a.revision === b.revision &&
    a.promptId === b.promptId &&
    a.promptVersion === b.promptVersion &&
    a.inputHash === b.inputHash;
  return {
    find: async (key) => saved.find((one) => same(one.key, key)) ?? null,
    save: async (record) => void saved.push(record),
  };
}
