import { byText, type Query } from "../core/db.ts";
import { createDb } from "../core/job-db.ts";
import { audienceGroups } from "../identity/warmth-build.ts";
import { buildLabelDays, clearWarmthMemo, LABELS, type RankedWarmth, rankWarmth } from "../identity/warmth-days.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { testId } from "./clients.ts";
import { session } from "./connections.ts";
import { fingerprint, queryAs, sealRow, type TestDatabase } from "./database.ts";
import { recordingLogger } from "./recording.ts";
import { seeder } from "./seeder.ts";
import { interactionId } from "./values.ts";

// The warmth database tests' world: a small synthetic world of people, direct mail
// and meetings, written as pi_admin with the seeder's rows, reserved domains and made-up ids only.
// Each mail is one evidence row, its message and its interaction rows; each meeting one event,
// its details and its participants.

export type WarmthWorld = {
  // A person with one account and a name of their own under the label (a person with no
  // name is in no owner read); `named: false` for one known by an address alone.
  person(label: string[], options?: { named?: boolean }): Promise<string>;
  // Mail the owner sent to `to` (out), or `from` sent the owner with `to` beside them (in). The evidence id.
  mail(
    label: string[],
    options: { at: string; to?: string[]; from?: string; thread?: string; bulk?: boolean; held?: boolean },
  ): Promise<string>;
  // A meeting the owner kept with these people.
  meeting(
    label: string[],
    people: string[],
    at: string,
    options?: { response?: "accepted" | "declined" | "needsAction" | "tentative" | null; cancelled?: boolean },
  ): Promise<string>;
  // The evidence row's source account and item fingerprint, for removeSourceItem.
  source(evidenceId: string): Promise<{ account: { id: string; compartment: string }; fp: string }>;
};

export function warmthWorld(db: TestDatabase): WarmthWorld {
  const admin = <T>(fn: (query: Query, seed: ReturnType<typeof seeder>) => Promise<T>): Promise<T> =>
    session(db.urls.admin, (query) => fn(query, seeder(db, query)));
  let serial = 0;
  return {
    person: (label, options = {}) =>
      admin(async (query, seed) => {
        const entity = await seed.entity("person");
        await seed.account(label, entity);
        if (options.named !== false) {
          const id = testId("als");
          const name = `Warmth Person ${id.slice(-8)}`;
          await query(
            "insert into knowledge.aliases (id, entity_id, value_fp, evidence_id, value_enc, compartments) values ($1, $2, $3, $4, $5, $6)",
            [
              id,
              entity,
              fingerprint(db.keys, "name", name),
              await seed.evidence(label, await seed.sourceAccount(label)),
              sealRow(db.keys, label[0] ?? "own", { table: "knowledge.aliases", id, column: "value_enc" }, name),
              label,
            ],
          );
        }
        return entity;
      }),
    mail: (label, options) =>
      admin(async (query, seed) => {
        serial += 1;
        const evidence = await seed.evidence(label, await seed.sourceAccount(label));
        const message = await seed.message(label, evidence, { held: options.held ?? false });
        const outbound = options.from === undefined;
        const thread = fingerprint(db.keys, "thread", options.thread ?? `warmth-thread-${serial}`);
        await query(
          "update knowledge.messages set sent_at = $2, direction = $3, thread_fp = $4, bulk = $5 where id = $1",
          [message, options.at, outbound ? "outbound" : "inbound", thread, options.bulk ?? false],
        );
        const rows: [string, string, string][] = outbound
          ? (options.to ?? []).map((entity) => [entity, "outbound", "recipient"])
          : [
              [options.from ?? "", "inbound", "sender"],
              ...(options.to ?? []).map((entity): [string, string, string] => [entity, "inbound", "recipient"]),
            ];
        for (const [entity, direction, role] of rows) {
          await query(
            `insert into knowledge.interaction_log (id, evidence_id, member_id, entity_id, direction, channel, occurred_at, entity_role, compartments, readers)
             values ($1, $2, 'm-owner', $3, $4, 'email', $5, $6, $7, '{m-owner}')`,
            [interactionId(evidence, entity), evidence, entity, direction, options.at, role, label],
          );
        }
        return evidence;
      }),
    meeting: (label, people, at, options = {}) =>
      admin(async (query, seed) => {
        const account = await seed.sourceAccount(label);
        const evidence = await seed.evidence(label, account);
        const event = await seed.event(label, evidence);
        await seed.eventDetails(label, event, account);
        await query(
          "update knowledge.event_details set starts_at = $2, ends_at = $2::timestamptz + interval '1 hour', owner_response = $3, cancelled = $4 where event_id = $1",
          [event, at, options.response === undefined ? "accepted" : options.response, options.cancelled ?? false],
        );
        for (const entity of people) {
          await query(
            "insert into knowledge.event_participants (event_id, entity_id, participant_role, compartments) values ($1, $2, 'participant', $3)",
            [event, entity, label],
          );
        }
        return evidence;
      }),
    async source(evidenceId) {
      const [row] = await queryAs<{ source_account_id: string; source_item_fp: string; compartments: string[] }>(
        db.urls.admin,
        "select source_account_id, source_item_fp, compartments from vault.evidence_items where id = $1",
        [evidenceId],
      );
      if (row === undefined) throw new Error("no such evidence row");
      return {
        account: { id: row.source_account_id, compartment: row.compartments[0] ?? "own" },
        fp: row.source_item_fp,
      };
    },
  };
}

// One run of the pipeline's warmth step, as `pi extract` runs it: each due label's days built.
export async function runWarmth(
  db: TestDatabase,
): Promise<{ built: number; failed: number; days: number; ms: number }> {
  const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: recordingLogger().log });
  try {
    const run = await pipeline.buildWarmth?.();
    if (run === undefined) throw new Error("the pipeline builds no warmth");
    return run;
  } finally {
    await pipeline.close();
  }
}

// The days of every label within the clearance built as pi_pipeline, each in a transaction of its
// own, whatever their state: what the reads rank from. How many days were written.
export async function buildAs(db: TestDatabase, clearance: string[]): Promise<number> {
  const pipeline = createDb(db.urls.pipeline, recordingLogger().log);
  try {
    let days = 0;
    const labels = await pipeline.transaction((query) => query<{ compartments: string[] }>(LABELS));
    for (const { compartments } of labels)
      if (compartments.every((one) => clearance.includes(one)))
        days += (await pipeline.transaction((query) => buildLabelDays({ query, keys: db.keys }, compartments))).days;
    return days;
  } finally {
    await pipeline.close();
  }
}

// A clearance's ranking as the owner reads it (pi_admin), computed afresh as of `today` with no memo:
// each line by its person's id, or null while it is being rebuilt.
export async function rowsOf(db: TestDatabase, clearance: string[], today: Date): Promise<RankedWarmth[] | null> {
  clearWarmthMemo();
  const ranked = await session(db.urls.admin, async (query) =>
    rankWarmth({ query, keys: db.keys }, { kind: "owner" }, clearance, await audienceGroups(query, clearance), {
      today,
    }),
  );
  return ranked === "rebuilding" ? null : [...ranked.values()].sort((a, b) => byText(a.entity_id, b.entity_id));
}

// A label's day build row: how many days, whether a removal emptied it, when, and by which rule table.
export async function buildRowOf(
  db: TestDatabase,
  label: string[],
): Promise<{ days: number; removed: boolean; built_at: Date; rule_version: number } | undefined> {
  const [row] = await queryAs<{ days: number; removed: boolean; built_at: Date; rule_version: number }>(
    db.urls.admin,
    "select days, removed_at is not null as removed, built_at, rule_version from projections.warmth_day_builds where compartments = $1::text[]",
    [[...label].sort()],
  );
  return row;
}

// Moves the clock back on what the cadence compares, as pi_owner with the tables' row security
// lifted for the statement's transaction: every build `minutes` older, and every evidence row and
// ruling older still, so a test can tell "changed since" from "built within ten minutes".
export async function age(db: TestDatabase, minutes: number): Promise<void> {
  await session(db.urls.bootstrap, async (query) => {
    await query("begin");
    await query("set local role pi_owner");
    // And every chat line, which the cadence compares by created_at.
    const tables = ["projections.warmth_day_builds", "vault.evidence_items", "knowledge.chat_lines"];
    for (const table of tables) await query(`alter table ${table} no force row level security`);
    await query("update projections.warmth_day_builds set built_at = built_at - make_interval(mins => $1)", [minutes]);
    await query("update vault.evidence_items set ingested_at = ingested_at - make_interval(mins => $1 * 2)", [minutes]);
    await query("update knowledge.chat_lines set created_at = created_at - make_interval(mins => $1 * 2)", [minutes]);
    for (const table of tables) await query(`alter table ${table} force row level security`);
    await query("commit");
  });
}
