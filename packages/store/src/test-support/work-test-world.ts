import type { GoalId, ReadOutcome, RulingId } from "@intelligence/contracts/personal";
import pg from "pg";
import { writeGoalClaim } from "../admin/goals/goal-claims.ts";
import { createWork, type Work } from "../agent-work/work.ts";
import type { Keys } from "../core/keys.ts";
import { sealUnder } from "../core/seal.ts";
import { Reader } from "../read/read.ts";
import { testId } from "./clients.ts";
import { asClaimsOwner, one, type Query, session } from "./connections.ts";
import { queryAs, type TestDatabase } from "./database.ts";
import { eventLogger } from "./recording.ts";
import { seeder } from "./seeder.ts";
import { withDatabase } from "./store.ts";
import { insertWorkClient, type WorkClient } from "./work-clients.ts";

// For the work tools' tests only: a database with a Reader and the Work built from it, as `pi mcp`
// builds them, and the rows the owner and the tick write (intents, harness modes, decisions, runs,
// the kill switch, vetoes, goals) in SQL as pi_admin and pi_work. Hand-written, reserved domains
// only.

export type Message = { id: string; evidence: string };

export type WorkWorld = {
  db: TestDatabase;
  admin: Query;
  // A statement that updates or deletes a claim or its entity rows, which pi_admin may not: as the
  // claims' owner, committed.
  claims: Query;
  pool: pg.Pool;
  reader: Reader;
  work: Work;
  log: ReturnType<typeof eventLogger>;
  seed: ReturnType<typeof seeder>;
  keys: Keys;
  // A Reader and its Work on the same database with keys of the caller's choosing.
  workWith(keys: Keys): { reader: Reader; work: Work };
  client(
    name: string,
    compartments?: string[],
    options?: { kind?: "agent" | "reasoner"; tools?: readonly string[]; views?: readonly string[] },
  ): Promise<WorkClient>;
  intent(kinds: string[], clients: WorkClient[], mode?: "owner_decides" | "policy_decides"): Promise<string>;
  harness(client: WorkClient, kind: string, stage: string, mode?: string): Promise<string>;
  message(compartments?: string[], options?: { held?: boolean }): Promise<Message>;
  // The owner's go under an intent: the decision row and the status event, as pi_work.
  decideGo(opportunity: string, intent: string): Promise<void>;
  // A status event on a row, as pi_work writes one: no body, the row's own label.
  status(rowKind: string, rowId: string, event: string, by?: string): Promise<void>;
  killSwitch(state: "on" | "off"): Promise<void>;
  vetoKind(workKind: string): Promise<string>;
  goal(compartments: string[], statement: string): Promise<string>;
  // A queued run, as the tick queues one, with its anchors as basis rows.
  queuedRun(compartments?: string[], anchors?: [kind: string, id: string][]): Promise<string>;
  latest(rowKind: string, rowId: string): Promise<string>;
  label(table: string, id: string): Promise<string[]>;
};

export const ok = <T>(outcome: ReadOutcome<T>): T => {
  if (!outcome.ok) throw new Error(`expected ok, got ${outcome.code}`);
  return outcome.value;
};

const labelOf = (compartments: readonly string[]): string[] => [...new Set(compartments)].sort();

// `compartments`: the key file's, for a test whose agents write records under `agent:<name>`.
export async function withWorkWorld<T>(fn: (world: WorkWorld) => Promise<T>, compartments?: string[]): Promise<T> {
  return withDatabase(
    (db) =>
      session(db.urls.admin, async (admin) => {
        const pool = new pg.Pool({ connectionString: db.urls.reader, max: 4, connectionTimeoutMillis: 20_000 });
        const pools: pg.Pool[] = [pool];
        try {
          const log = eventLogger();
          const reader = new Reader({ pool, keys: db.keys, log });
          const work = createWork({ reader, log });
          const seed = seeder(db, admin);
          const asWork = (text: string, values: unknown[] = []): Promise<unknown> =>
            queryAs(db.urls.work, text, values);
          const labelOfRow = async (table: string, id: string): Promise<string[]> =>
            one(await admin<{ compartments: string[] }>(`select compartments from ${table} where id = $1`, [id]))
              .compartments;
          const status = async (rowKind: string, rowId: string, event: string, by = "owner"): Promise<void> => {
            const table =
              rowKind === "run"
                ? "ledger.runs"
                : `ledger.${rowKind === "opportunity" ? "opportunities" : rowKind === "hypothesis" ? "hypotheses" : `${rowKind}s`}`;
            await asWork(
              "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ($1, $2, $3, clock_timestamp(), $4, $5)",
              [rowKind, rowId, event, by, await labelOfRow(table, rowId)],
            );
          };
          const world: WorkWorld = {
            db,
            admin,
            claims: <Row>(text: string, values?: unknown[]) => asClaimsOwner(db, (query) => query<Row>(text, values)),
            pool,
            reader,
            work,
            log,
            seed,
            keys: db.keys,
            workWith(keys) {
              const own = new pg.Pool({ connectionString: db.urls.reader, max: 2, connectionTimeoutMillis: 20_000 });
              pools.push(own);
              const other = new Reader({ pool: own, keys, log });
              return { reader: other, work: createWork({ reader: other, log }) };
            },
            client: (name, compartments = ["own"], options = {}) => insertWorkClient(db, name, compartments, options),
            async intent(kinds, clients, mode = "owner_decides") {
              const id = testId("int");
              await admin(
                `insert into policy.intents (id, goal_id, opportunity_kinds, recipient_classes, client_ids, mode, max_open, confirmed_at)
               values ($1, null, $2, '{none}', $3, $4, 5, now())`,
                [id, kinds, clients.map((client) => client.id), mode],
              );
              return id;
            },
            async harness(client, kind, stage, mode = "act") {
              const id = testId("hrn");
              await admin(
                "insert into policy.harness_modes (id, client_id, opportunity_kind, stage, mode, granted_at) values ($1, $2, $3, $4, $5, now())",
                [id, client.id, kind, stage, mode],
              );
              return id;
            },
            async message(compartments = ["own"], options = {}) {
              const evidence = await seed.evidence(compartments, await seed.sourceAccount(compartments.slice(0, 1)));
              return { id: await seed.message(compartments, evidence, { held: options.held ?? false }), evidence };
            },
            async decideGo(opportunity, intent) {
              await asWork(
                `insert into ledger.opportunity_decisions (request_id, created_by, compartments, opportunity_id, decision, decided_by, rung, reason, intent_id)
               values ($1, 'owner', $2, $3, 'go', 'owner', 4, 'owner_answer', $4)`,
                [testId("req"), await labelOfRow("ledger.opportunities", opportunity), opportunity, intent],
              );
              await status("opportunity", opportunity, "go");
            },
            status,
            async killSwitch(state) {
              await admin(
                "insert into ledger.kill_switch (request_id, created_by, compartments, state) values ($1, 'owner', '{own}', $2)",
                [testId("req"), state],
              );
            },
            async vetoKind(workKind) {
              const id = testId("rul");
              await admin(
                "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'veto', 0, '{}', '{}', now(), '{own}')",
                [id, testId("req")],
              );
              await admin(
                "insert into knowledge.vetoes (ruling_id, subject, value_fps, work_kind, created_at, compartments) values ($1, 'any', '{}', $2, now(), '{own}')",
                [id, workKind],
              );
              return id;
            },
            async goal(compartments, statement) {
              const ruling = testId("rul");
              await admin(
                "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'goal_set', 0, '{}', '{}', now(), $3)",
                [ruling, testId("req"), compartments],
              );
              const id = testId("gol");
              await admin(
                "insert into projections.goal_state (goal_id, status, ruling_id, stated_at, updated_at, compartments, statement_enc) values ($1, 'active', $2, now(), now(), $3, $4)",
                [
                  id,
                  ruling,
                  labelOf(compartments),
                  JSON.stringify(
                    sealUnder(
                      db.keys,
                      labelOf(compartments),
                      { table: "projections.goal_state", id, column: "statement_enc" },
                      statement,
                    ),
                  ),
                ],
              );
              // And its owner_command claim and goal id row, as `pi goal add` writes them, so the
              // goal is a belief its readers compute.
              await session(db.urls.admin, (query) =>
                writeGoalClaim(query, db.keys, {
                  goal: id as GoalId,
                  ruling: ruling as RulingId,
                  statement,
                  compartments: labelOf(compartments),
                  at: new Date(),
                }),
              );
              return id;
            },
            async queuedRun(compartments = ["own"], anchors = []) {
              const id = testId("run");
              await asWork(
                `insert into ledger.runs (id, request_id, created_by, compartments, wake_source, wake_key, decision_point, definition_version, prompt_id, prompt_version)
               values ($1, $2, 'system:tick', $3, 'owner_request', $4, 'run_outcome', 1, 'reasoning_run', '1')`,
                [id, testId("req"), labelOf(compartments), `owner_request:${id}`],
              );
              if (anchors.length > 0) {
                await queryAs(db.urls.work, "select ledger.add_basis('run', $1, $2, $3, $4, null)", [
                  id,
                  labelOf(compartments),
                  anchors.map(([kind]) => kind),
                  anchors.map(([, ref]) => ref),
                ]);
              }
              await status("run", id, "queued", "system:tick");
              return id;
            },
            async latest(rowKind, rowId) {
              return one(
                await admin<{ event: string }>(
                  "select event from ledger.record_events where row_kind = $1 and row_id = $2 and event <> 'reported' order by id desc limit 1",
                  [rowKind, rowId],
                ),
              ).event;
            },
            label: labelOfRow,
          };
          return await fn(world);
        } finally {
          for (const one of pools) await one.end().catch(() => {});
        }
      }),
    compartments === undefined ? {} : { compartments },
  );
}
