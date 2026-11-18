import type { Query } from "../core/db.ts";

// A declassified copy ends with its claim: every statement of the
// store that deletes from knowledge.claims calls this before that delete, in its
// transaction, with the ids it deletes. Answers how many copies went.
export async function dropDeclassified(query: Query, claimFps: string[]): Promise<number> {
  const [row] = await query<{ dropped: number }>("select projections.drop_declassified($1) as dropped", [claimFps]);
  return row?.dropped ?? 0;
}

// The re-derive's form: every claim's id, read by the database and never held by the process.
export const DROP_EVERY_DECLASSIFIED =
  "select projections.drop_declassified(array(select id from knowledge.claims)) as dropped";
