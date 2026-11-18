import type { CallOptions, SessionTaintEntry } from "@intelligence/contracts/personal";
import type { ClientRunner } from "./read-db.ts";

// Session taint's counts, as pi_reader: one more of the caller's refusals, or would-refusals in
// shadow, for a session's label, by tool and code. The definer takes the client from the token and
// writes only that client's row. It reads nothing, and a token with no client counts nothing. Throws
// Unavailable for a database error, as every call does.
const COUNT = "select ledger.count_session_taint($1, $2, $3)";

export async function countSessionTaint(
  reader: ClientRunner,
  token: string,
  { tool, code, enforced }: SessionTaintEntry,
  options: CallOptions = {},
): Promise<void> {
  await reader.withClient(token, { isolation: "read committed", signal: options.signal }, async ({ client, run }) => {
    if (client !== null) await run(COUNT, [tool, code, enforced]);
  });
}
