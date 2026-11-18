// The shape of one table's security surface: its row-level security, its policies and its grants.
// A generator turns the declarations into the statements of the schema dump, and a structure test
// fails on any difference between the two.

export type Role =
  | "pi_owner"
  | "pi_admin"
  | "pi_writer"
  | "pi_pipeline"
  | "pi_restricted"
  | "pi_reader"
  | "pi_work"
  | "pi_proxy"
  | "pi_notify";

export type Command = "all" | "select" | "insert" | "update" | "delete";

// A named row rule, read against the table's label columns:
// - `open`: every row (`true`).
// - `shared`: rows in no restricted compartment, written as the pipeline's half of the restricted
//   split, `true AND not restricted` for each label column.
// - `restricted`: rows in a restricted compartment, the restricted worker's half of the split, read
//   on the last label column.
// - `unrestricted`: rows whose compartments are not restricted, without the split's `true AND`.
// - `restrictedOnly`: rows whose compartments are restricted, without the split's `true AND`.
// - `cleared`: rows within the calling client's clearance and keys; on a table with an audience,
//   rows whose audience is exactly the caller's clearance.
// - `unlifted`: rows whose `lifted_at` is null.
// - `lift`: an update that may only lift a row not yet lifted.
export type Rule =
  | "open"
  | "shared"
  | "restricted"
  | "unrestricted"
  | "restrictedOnly"
  | "cleared"
  | "unlifted"
  | "lift";

// A policy that fits no named rule, written out whole, with the reason it differs. `using` and
// `check` are the expressions as `pg_dump` prints them, without their outer parentheses.
export interface Exception {
  readonly using?: string;
  readonly check?: string;
  readonly why: string;
}

// A named rule with more conditions, joined with `and` before (`first`) or after (`after`) its own,
// each as `pg_dump` prints one term of an `and`.
export interface Narrowed {
  readonly rule: Rule;
  readonly first?: string | readonly string[];
  readonly after?: string | readonly string[];
  readonly why: string;
}

export type Policy = Rule | Narrowed | Exception;

// Column grants by privilege list, as `pg_dump` prints them (`SELECT` or `SELECT,UPDATE`), each
// with its columns separated by spaces; a name `pg_dump` quotes is written quoted.
export type ColumnGrants = Readonly<Record<string, string>>;

export interface Grant {
  // The table-level privileges, as `pg_dump` prints them, such as `SELECT,INSERT`.
  readonly table?: string;
  readonly columns?: ColumnGrants;
}

export interface TableSurface {
  // The label columns, compartments first, when the table's rows carry a label.
  readonly label?: readonly string[];
  // True when only the owner's own roles, `pi_owner` and `pi_admin`, hold a policy or grant on it.
  readonly ownerOnly?: true;
  // True for a view: it has grants but no row-level security of its own.
  readonly view?: true;
  readonly policies?: Partial<Record<Role, Partial<Record<Command, Policy>>>>;
  readonly grants?: Partial<Record<Role, Grant | string>>;
}

// One schema's tables, by name without the schema.
export type SchemaSurface = Readonly<Record<string, TableSurface>>;
