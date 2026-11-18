// Mail and rows for the read quotas.

import type { Timestamp } from "@intelligence/contracts";
import type { Writer } from "../write/writer.ts";
import { connect, OWNER_PERSONAL, OWNER_WORK, QUENTIN, WORK_ONLY } from "./cast.ts";
import { session } from "./connections.ts";
import type { TestDatabase } from "./database.ts";
import { ingestMail, type MailFixture } from "./items.ts";
import { hoursFrom, iso } from "./values.ts";

// ---------------------------------------------------------------------------------------------
// Read quotas
// ---------------------------------------------------------------------------------------------

// The text of the n-th quota message, with one character outside the basic plane.
const quotaText = (label: string, n: number): string =>
  `quota-${label}-${String(n).padStart(3, "0")} \u{1F600}`.padEnd(60, "x");

// `own` messages from Quentin to the owner and, under `employer:example`, messages from Wren,
// each with text and a thread of its own, an hour apart, the newest an hour before `now`. The
// employer's are interleaved in time with the owner's, so a client that cannot see them would
// find them between its own if they leaked.
export async function seedQuotaMail(
  writer: Writer,
  now: Date,
  counts: { own: number; employer: number },
): Promise<void> {
  const accounts = await connect(writer);
  const at = (hours: number): Timestamp => iso(hoursFrom(now, -hours));
  for (let n = 0; n < counts.own; n += 1) {
    const fixture: MailFixture = {
      id: `quota-own-${n}`,
      threadId: `quota-own-thread-${n}`,
      at: at(2 * n + 1),
      from: QUENTIN,
      to: [OWNER_PERSONAL],
      subject: `quota-own-${n}`,
      labels: ["INBOX"],
      text: quotaText("own", n),
    };
    if ((await ingestMail(writer, accounts.personalMail, fixture)) !== "stored")
      throw new Error("a quota message was not stored");
  }
  for (let n = 0; n < counts.employer; n += 1) {
    const fixture: MailFixture = {
      id: `quota-work-${n}`,
      threadId: `quota-work-thread-${n}`,
      at: at(2 * n + 2),
      from: WORK_ONLY,
      to: [OWNER_WORK],
      subject: `quota-work-${n}`,
      labels: ["INBOX"],
      text: quotaText("work", n),
    };
    if ((await ingestMail(writer, accounts.workMail, fixture)) !== "stored")
      throw new Error("a quota message was not stored");
  }
}

// Moves every policy.calls and ledger.read_log row of a client back by 24 hours and a second,
// as pi_owner with row security not forced for the one statement: what no runtime role can do.
export async function ageQuotaRows(db: TestDatabase, clientId: string): Promise<void> {
  await session(db.urls.bootstrap, async (query) => {
    await query("set role pi_owner");
    for (const [table, column] of [
      ["policy.calls", "at"],
      ["ledger.read_log", "read_at"],
    ] as const) {
      await query(`alter table ${table} no force row level security`);
      try {
        await query(`update ${table} set ${column} = ${column} - interval '24 hours 1 second' where client_id = $1`, [
          clientId,
        ]);
      } finally {
        await query(`alter table ${table} force row level security`);
      }
    }
  });
}
