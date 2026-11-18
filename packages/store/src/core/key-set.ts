import type { DataKey } from "@intelligence/contracts";

// The key file: one data key per compartment and one fingerprint key. Held in memory only; never
// logged, never stored in the database. A second file, the restricted root, holds the key of each
// `restricted:<category>` and nothing else; `Keys` holds both files' keys when both are read. A
// restricted file that is wrapped (restricted-lock.ts) gives no key: its compartments are `locked`,
// and only an unlock opens them.
export type Keys = { compartments: ReadonlyMap<string, DataKey>; fingerprintKey: Buffer; locked?: ReadonlySet<string> };
