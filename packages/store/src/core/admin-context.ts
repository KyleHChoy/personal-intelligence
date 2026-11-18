import type { PersonalLogger } from "@intelligence/contracts/personal";
import type { Now } from "@intelligence/personal-core";
import type { Query } from "./db.ts";
import type { Keys } from "./keys.ts";
import type { Tx } from "./tx.ts";

// What every admin function is handed: one transaction at a time, the key file, the logger and the
// clock; the deployment's record setting; and, for the erasure, the journal's path.

export type AdminContext = {
  transaction<T>(fn: (query: Query) => Promise<T>): Promise<T>;
  keys: Keys;
  log: PersonalLogger;
  now: Now;
  journal?: string;
  // The deployment's PI_RECORD_ENABLED: until it is set, no client may be given record.
  recordEnabled?: boolean;
  // Whether the admin's own connection reaches the database checking no certificate (db.ts,
  // `tlsUnverified`): the coverage record raises a `tls_unverified` box health card while it does.
  tlsUnverified?: boolean;
};

// One transaction's statements, the key file and its clock, as a function a group binds with
// `boundTx` takes them.
export type TxAt = Tx & { now: Date };
