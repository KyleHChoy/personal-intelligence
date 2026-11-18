import { sha256 } from "@intelligence/personal-core";
import type { Query } from "./db.ts";

// The read measurement (`pia extract measure-reads`): every statement a read path sends,
// timed by a stable id, and the time of each call the statements did not take (decryption,
// beliefs computed in memory, matching), as `other`. A statement's text is code, never data: its
// values are bind parameters, so its id and its first words name nothing of the owner's.

// The first 8 hex characters of sha256 of the text with its whitespace collapsed, and its first
// six words.
export function statementId(text: string): { id: string; words: string } {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return {
    id: sha256(collapsed).slice(0, 8),
    words: collapsed.split(" ").slice(0, 6).join(" "),
  };
}

export type StatementTimer = {
  // The query, timed: what the read path is given in place of its own.
  run: Query;
  // One call of the read path, timed whole; what of it no statement took is added to `other`.
  call<T>(fn: () => Promise<T>): Promise<T>;
  // Each call's milliseconds, and each call's milliseconds outside any statement, in call order.
  calls: number[];
  other: number[];
  // Each statement's milliseconds by its id, in the order first sent.
  statements: Map<string, { words: string; ms: number[] }>;
};

// The read paths send one statement at a time on one connection, so a call's statement time is
// the sum of its statements'.
export function statementTimer(query: Query, clock: () => number = () => performance.now()): StatementTimer {
  const statements = new Map<string, { words: string; ms: number[] }>();
  const calls: number[] = [];
  const other: number[] = [];
  let sql = 0;
  const run: Query = async <Row>(text: string, values?: unknown[]): Promise<Row[]> => {
    const start = clock();
    try {
      return await query<Row>(text, values);
    } finally {
      const ms = clock() - start;
      sql += ms;
      const { id, words } = statementId(text);
      const known = statements.get(id) ?? { words, ms: [] };
      known.ms.push(ms);
      statements.set(id, known);
    }
  };
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    const start = clock();
    const before = sql;
    try {
      return await fn();
    } finally {
      const ms = clock() - start;
      calls.push(ms);
      other.push(ms - (sql - before));
    }
  };
  return { run, call, calls, other, statements };
}
