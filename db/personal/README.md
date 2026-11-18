# Database

The SQL migrations of the one Personal Intelligence database, in `migrations/`, applied in order by `pi db migrate`.

- **The baseline.** `0001-baseline.sql` is a single schema dump, as `pg_dump` prints a database that applied the project's whole migration history, with its rows and without its comments. It is the whole schema: every table, index, function, policy and grant, and the rows the system starts with. It runs on an empty database. A database that applied it refuses a changed copy, so a new version of this repository can need a fresh database.
- **A change** is a new file, numbered after the highest here. The runner applies each file once, in one transaction as `pi_owner`, and refuses a file that opens or ends a transaction itself or that changed after it was applied.
- **Line ends.** The runner checksums each file's raw bytes, so the root `.gitattributes` checks every `.sql` file out with LF line ends.
- **Row-level security** is forced on every table, the owner role's included. `pi_owner` holds a policy only where a definer function, a trigger or the runner needs one.
- **Unindexed foreign keys.** Every foreign key has an index led by its columns, or is listed with its reason in `unindexed-foreign-keys.json`. `foreign-key-indexes.db.test.ts` checks that.

## Where to read the security model

Each is named as it appears in `0001-baseline.sql`.

- **The label trigger on claims.** `knowledge.claims_label()`, run by the trigger `claims_label` on `knowledge.claims`, refuses a claim whose label is not its evidence item's, except a released, closing or researched claim, each held to its own rule.
- **A caller's clearance from its token.** `policy.current_client()` finds the active client whose hashed token, or live OAuth access token, matches the session's `pi.client_token`; `policy.client_clearance()` answers that client's compartments, and none for a device.
- **Forced row-level security.** The `ALTER TABLE ... FORCE ROW LEVEL SECURITY` statement for each table, and its policies, named `<role>_<command>`.
- **Erasure's reach.** `ledger.taint_citing(evidence_ids, ref_kinds, ref_ids)` taints every ledger row that cites erased evidence or an erased record: its sealed body dropped and a live one ended.
- **Role grants.** The `GRANT` statements after the tables and functions, and a `REVOKE ALL ... FROM PUBLIC` on each function. The login roles are made outside the migrations.

Claims keep their legacy fact-key fingerprints (`legacy_fact_key_fp`, `legacy_alt_fact_key_fp`) so that an owner's ruling keyed under an earlier fact-key version still reaches a claim made after the key changed.
