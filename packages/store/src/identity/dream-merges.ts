import { createHash } from "node:crypto";
import type { PersonalLogger } from "@intelligence/contracts/personal";
import type pg from "pg";
import { AdminError } from "../core/admin-error.ts";
import type { Query } from "../core/db.ts";
import type { Keys } from "../core/keys.ts";
import { SYNC_SESSION } from "../core/locks.ts";
import { dreamLines, linesLive, runIdentitySwitch } from "../pipeline/relation-switch.ts";
import { wholePeople } from "./identity-questions.ts";
import { againstOf } from "./same-person-facts.ts";

// As the identity sweep runs it (pi_admin): for each judge whose candidates
// wait, the identity kind's switch, whose fall below its line lifts every `dream` merge made since it
// last went on; then, only while the owner's lines are live and the kind is on, each `same` whose
// census held is weighed by what stands against any same and merged through
// ledger.dream_ruling, which applies every other check that guards a merge. Ids, counts and codes.

export type DreamMergeCounts = { judges: number; merged: number; refused: number; lifted: number; paused: boolean };

type Admin = { keys: Keys; log: PersonalLogger; transaction<T>(work: (query: Query) => Promise<T>): Promise<T> };

export async function settleDreamMerges(admin: Admin): Promise<DreamMergeCounts> {
  const counts: DreamMergeCounts = { judges: 0, merged: 0, refused: 0, lifted: 0, paused: false };
  const judges = await admin.transaction((query) =>
    query<{ judge: string }>("select distinct judge from ledger.dream_identity_candidates order by judge"),
  );
  for (const { judge } of judges) {
    counts.judges += 1;
    const switched = await admin.transaction((query) => runIdentitySwitch(query, judge, admin.log));
    counts.lifted += switched.lifted;
    // A checker the owner no longer agrees with pauses new merges, and lifts nothing.
    const live = await admin.transaction(async (query) => linesLive(query, await dreamLines(query)));
    if (!live) counts.paused = true;
    if (!live || !switched.on) continue;
    const waiting = await admin.transaction((query) =>
      query<{ id: string; a_entity: string; b_entity: string; compartments: string[] }>(
        `select c.id::text as id, c.a_entity, c.b_entity, c.compartments from ledger.dream_identity_candidates c
         where c.judge = $1 and c.verdict = 'same' and c.state = 'filed' order by c.id`,
        [judge],
      ),
    );
    for (const one of waiting) {
      const against = await admin.transaction(async (query) => {
        const whole = await wholePeople(query);
        return againstOf(admin, query, (entity) => [...whole(entity)], {
          a: one.a_entity,
          b: one.b_entity,
          label: one.compartments,
        });
      });
      if (against !== null) {
        await refuse(admin, one.id, against);
        continue;
      }
      const request = createHash("sha256").update(`dream-merge:${one.id}`, "utf8").digest("base64url").slice(0, 43);
      const code = await admin.transaction(async (query) => {
        const [row] = await query<{ code: string }>("select code from ledger.dream_ruling($1::bigint, $2)", [
          one.id,
          request,
        ]);
        return row?.code ?? "not_found";
      });
      if (code === "ruled") counts.merged += 1;
      // Unchecked or the kind off: it waits as filed. Anything else a rule refused.
      else if (code !== "unchecked" && code !== "kind_off") await refuse(admin, one.id, code);
    }
  }
  if (counts.judges > 0)
    admin.log.info({ event: "dream_merges", counts: { ...counts, paused: counts.paused ? 1 : 0 } });
  return counts;

  async function refuse(of: Admin, id: string, code: string): Promise<void> {
    counts.refused += 1;
    await of.transaction((query) =>
      query(
        "update ledger.dream_identity_candidates set state = 'refused', code = $2, updated_at = now() where id = $1::bigint and state = 'filed'",
        [id, code],
      ),
    );
  }
}

// `pi identity dream-merges`, which the timer runs as pi_admin after each dream pass: the dream
// candidates alone, under the sync lock the whole sweep takes, so no merge of a sync's sweep lands
// beside one of these. A sync running refuses it (`sync_running`), and the next pass tries again.
export async function settleDreamMergesLocked(admin: Admin, pool: pg.Pool): Promise<DreamMergeCounts> {
  const session = await pool.connect();
  try {
    const [lock] = (await session.query<{ held: boolean }>(SYNC_SESSION.try)).rows;
    if (lock?.held !== true) throw new AdminError("sync_running");
    try {
      return await settleDreamMerges(admin);
    } finally {
      await session.query(SYNC_SESSION.give);
    }
  } finally {
    session.release();
  }
}
