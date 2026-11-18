import type { PersonalLogger, SessionId, SubjectKind, UntrustedString } from "@intelligence/contracts/personal";
import { byText } from "./db.ts";
import type { Keys } from "./keys.ts";
import { openAt, type Sealed as SealedValue } from "./seal.ts";

// What every read module shares and nothing else: the call's context, a sealed column and how it
// opens, the one failure a read answers with, and what a call read. Stable, and imports no read.

// One statement on the transaction's connection. Every value is a bind parameter.
export type Run = <Row>(text: string, values: unknown[]) => Promise<Row[]>;

// `session()` answers the client's session, opening it in this transaction the first time it is
// asked: the one way a session is had. `served`: what a shared part of a read served that its
// tool's read set does not name, added to the call's read log by `logRead` (whoOf's organization
// names, from claims the tool may never return itself). Only a client's call has one; the owner's
// reads log nothing. `groups`: the call's groups, read once by loadGroups (read-groups.ts), the
// owner's apart. Made fresh with each call's Ctx and never shared by two calls, so a new call or
// token reads again. `now`: the reader's clock, which a read computed as of a time (warmth's
// ranking) reads; the transaction's own `now()` where a call was given none.
export type Ctx = {
  run: Run;
  keys: Keys;
  session: () => Promise<SessionId>;
  log: PersonalLogger;
  served?: Served;
  groups?: GroupsMemo;
  // A pinned clock a belief computed at read is computed as of, given only by a test's reader;
  // without one, the database transaction's (computed-beliefs.ts asOfOf).
  now?: () => Date;
};
type GroupsMemo = { client?: Promise<ClientGroups>; owner?: Promise<ClientGroups> };
type Served = { shown: Set<string>; factKeyFps: Set<string> };

// A database error, or a stored value that does not open. Either reaches the caller as
// `unavailable`, with nothing of the statement, the SQLSTATE or the reason. `sqlstate` and
// `raised` (the error came from a function's own `raise`, not from the server refusing the
// statement) are kept for the store's own code only: Work tells a refusal from a failure by
// them. Neither is ever logged, answered or put in a message.
export class Unavailable extends Error {
  static {
    Unavailable.prototype.name = "Unavailable";
  }

  readonly sqlstate: string | undefined;
  readonly raised: boolean;

  constructor(sqlstate?: string, raised = false) {
    super("unavailable");
    this.sqlstate = sqlstate;
    this.raised = raised;
  }
}

/** @deprecated Use `open(keys, row, column, "withheld")`, answering a fault with `Unavailable`. */
export function servedOrNull(
  keys: Keys,
  compartments: string[] | null,
  at: { table: string; id: string; column: string },
  sealed: unknown,
): UntrustedString | null {
  try {
    const text = openAt(keys, compartments, at, sealed as SealedValue, "withheld");
    return text === null ? null : { untrusted: text };
  } catch {
    throw new Unavailable();
  }
}

/** @deprecated A row with one sealed column: use `SealedRow` (seal.ts), which names its column. */
export type Sealed = { id: string; compartments: string[]; value_enc: unknown };

/** @deprecated Use `open(keys, row, column, "throw")`, answering a failure with `Unavailable`. */
export function untrusted(ctx: Ctx, table: string, column: string, row: Sealed): UntrustedString {
  try {
    return {
      untrusted: openAt(
        ctx.keys,
        row.compartments,
        { table, id: row.id, column },
        row.value_enc as SealedValue,
        "throw",
      ),
    };
  } catch {
    throw new Unavailable();
  }
}

export type ClientGroups = {
  // True when no visible ruling joins or marks anyone: every tool answers as it did before.
  readonly empty: boolean;
  // The visible members of an id's group, the id itself among them, lowest first.
  membersOf(id: string): string[];
  // The id that names the group: its lowest visible member's.
  idOf(id: string): string;
  // Whether a readable shared ruling names an address of a visible member of the group.
  shared(id: string): boolean;
  // Every visible member of a group of two or more, with its group's id.
  readonly joined: readonly (readonly [string, string])[];
};

// What a call read, for the read log: the evidence ids of the text a client asked for by id and was
// given (`bound`), of everything else it returned by id (`shown`, with the agent records it
// returned by their own ids), and the fact key fingerprints of the facts it returned. Required, so
// a tool added later does not compile until it states what it read. `goals`: the goal ids it
// returned, for a tool that returns any.
export type ReadSet = { bound: string[]; shown: string[]; factKeyFps: string[]; goals?: string[] };
// `chars`: the code points of text a text tool served; none for a list tool. A
// text tool's call that returns none answers `unavailable`.
export type Found<T> = { value: T; rows: number; read: ReadSet; chars?: number };

// The union of read sets, each list in the order first seen: one call's parts, so a part left out
// is left out in one visible place. `goals` only when a part has any.
export function mergeReads(...parts: readonly (Partial<ReadSet> | undefined)[]): ReadSet {
  const all = (list: (part: Partial<ReadSet>) => readonly string[] | undefined): string[] => [
    ...new Set(parts.flatMap((part) => (part === undefined ? [] : (list(part) ?? [])))),
  ];
  const goals = parts.some((part) => part?.goals !== undefined) ? { goals: all((part) => part.goals) } : {};
  return {
    bound: all((part) => part.bound),
    shown: all((part) => part.shown),
    factKeyFps: all((part) => part.factKeyFps),
    ...goals,
  };
}

// A read set with each list in text order, as a read that logs in that order states it.
export const sortedRead = (read: ReadSet): ReadSet => ({
  ...read,
  bound: [...read.bound].sort(byText),
  shown: [...read.shown].sort(byText),
  factKeyFps: [...read.factKeyFps].sort(byText),
});

// What one open item rests on, as a read set.
export const readOfRests = (
  rests: readonly { bound: readonly string[]; shown: readonly string[]; fact: string | null }[],
): ReadSet =>
  mergeReads(
    ...rests.map((one) => ({
      bound: [...one.bound],
      shown: [...one.shown],
      factKeyFps: one.fact === null ? [] : [one.fact],
    })),
  );

// What a shared part of a read served that its tool's read set does not name: it joins the call's
// read log (`logRead`), kept or cut later. An owner's read has no `served` and logs nothing.
export function noteServed(ctx: Ctx, part: { shown?: readonly string[]; factKeyFps?: readonly string[] }): void {
  for (const one of part.shown ?? []) ctx.served?.shown.add(one);
  for (const one of part.factKeyFps ?? []) ctx.served?.factKeyFps.add(one);
}

export const shownOnly = (ids: string[]): ReadSet => ({ bound: [], shown: [...new Set(ids)], factKeyFps: [] });

export type Entity = { id: string; kind: SubjectKind };

// A value's size on the wire, in code points, which is what every read's bound is stated in.
export const pointsOf = (value: unknown): number => [...JSON.stringify(value)].length;

// The epoch seconds a statement compares a time with.
export const epochSeconds = (at: Date | string): number => new Date(at).getTime() / 1000;

// A cite's or fact's record, for a read set, when it is an agent's record by its own id.
export const agentRecordIds = (record: string | undefined): string[] =>
  record?.startsWith("rec_") === true ? [record] : [];

// A page token: a value only this server issued and only it reads back. Null for one that is not.
export const pageToken = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
export const pageTokenValue = (text: string): unknown => {
  try {
    return JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    return null;
  }
};
