// Refusals with their positive controls, as probes for each role.

import {
  AGENT_REST_TABLES,
  EXPOSURE_TABLES,
  LEARNING_TABLES,
  MEMORY_TABLES,
  OWNER_ONLY,
  SEND_TABLES,
  TABLES,
  WORK_TABLES,
} from "./catalogue.ts";
import {
  COVERAGE_TABLES,
  ERASURE_TABLES,
  MIRROR_TABLES,
  NAMED_ORG_TABLES,
  ORGANIZATION_TABLES,
  OWNER_REST_TABLES,
  QUERY_TIME_TABLES,
  tablesIn,
  WARMTH_TABLES,
} from "./catalogue-grants.ts";
import { WORK_TABLE_GRANTS } from "./catalogue-work.ts";
import { session, sqlState, withOwner, withToken } from "./connections.ts";
import { sealRow, type TestDatabase } from "./database.ts";
import { OWNER_ONLY_TABLES } from "./snapshot.ts";

// One statement: what it gave the role under test, and what it gave a role that may.
export type Probe = { sql: string; refused: string | null; control: string | null };

// The owner alone may write these; pi_admin only reads them. The owner surface's five tables join
// them: pi_admin may not update or delete any of them, and pi_owner, who owns them, runs each
// statement (it touches no row). The erasure's three join them too: pi_admin may not update an
// erasure's id, nor update the other two. So do the belief rulings' two: pi_admin may not delete a
// ruling, nor update a declassified fact. The durable-work tables join them too, but for the four
// pi_admin holds all of.
const OWNER_WRITES = [
  // pi_admin selects and inserts claims and their entity rows, and updates or deletes neither.
  "knowledge.claims",
  "knowledge.claim_entities",
  // pi_admin inserts into neither warmth table and updates one column of a build.
  ...WARMTH_TABLES,
  // pi_admin only reads the fact rulings' marks.
  "policy.fact_ruling_marks",
  // pi_admin selects, inserts and deletes holds, never updates one.
  "ledger.card_name_holds",
  // pi_admin deletes no settlement and updates one column; pi_owner holds all.
  "ledger.fact_settlements",
  // pi_admin only reads and inserts reopens; pi_owner holds all.
  "ledger.commitment_reopens",
  // pi_admin only reads goal proposals; pi_owner holds all.
  "ledger.goal_proposals",
  // pi_admin only reads agent messages, their reads and the improvement store.
  "ledger.agent_messages",
  "ledger.agent_message_reads",
  "ledger.improvements",
  "ledger.improvement_events",
  // pi_admin only reads the agents' learnings; the owner's veto is a definer.
  "ledger.agent_learnings",
  // pi_admin only reads what an agent loop spent.
  "ledger.agent_spend",
  // pi_admin only reads session taint's counts.
  "ledger.session_taint_counts",
  // pi_admin only reads the outcome test.
  "ledger.outcome_test_runs",
  "ledger.outcome_test_tasks",
  "ledger.held_out_questions",
  // pi_admin only inserts and reads what a filing pass read.
  "ledger.measure_readings",
  // Same-person questions, answers and rules: the sweep's, the agents' through a definer, the tick's.
  "ledger.identity_answers",
  "ledger.identity_questions",
  "ledger.question_rules",
  // pi_admin reads an agent's answer on a card and marks a settled one: its one write is a definer's.
  "ledger.card_answers",
  // pi_admin only reads an agent's ruling: its one write is a definer's.
  "ledger.agent_rulings",
  // pi_admin reads and deletes an agent's report of a wrong merge, and reads a relayed answer and
  // marks what became of it: each row's one write is a definer's.
  "ledger.wrong_merge_reports",
  "ledger.card_relays",
  // pi_admin reads and deletes an agent's report of a wrong relation: its one write is a definer's.
  "ledger.relation_reports",
  // pi_admin only reads the settings and their history: its writes are a definer's.
  "policy.settings",
  "policy.setting_changes",
  "policy.migrations",
  "policy.calls",
  "policy.tool_names",
  "ledger.sessions",
  "ledger.read_log",
  "ledger.agent_writes",
  "policy.record_quota",
  "ledger.context_packs",
  ...OWNER_ONLY,
  ...ERASURE_TABLES,
  ...OWNER_REST_TABLES,
  // The owner's names for organizations: pi_admin inserts a name and updates only its two lift
  // columns.
  ...ORGANIZATION_TABLES,
  ...WORK_TABLES.filter((table) => !WORK_TABLE_GRANTS[table]?.pi_admin?.includes("all")),
  // The send proxy's four: pi_admin only reads them.
  ...SEND_TABLES,
  // The memory adapters' two: pi_admin only reads them. The agent records' further two: pi_admin
  // reads them, and updates two columns of one.
  ...MEMORY_TABLES,
  // The saved decision calls: pi_admin selects, inserts and deletes, and never updates.
  "vault.decision_calls",
  // pi_admin updates the owner's settings' zone alone.
  "policy.owner_settings",
  // The decision tables' three ledger ones: append-only for the admin, but for two columns of a
  // verdict.
  "ledger.point_verdicts",
  "ledger.calibration_reports",
  "ledger.threshold_proposals",
  ...AGENT_REST_TABLES,
  // The learning item's five: pi_admin never updates or deletes a row of them.
  ...LEARNING_TABLES,
  // The exposure tables: pi_admin reads both and inserts only the links.
  ...EXPOSURE_TABLES,
  // The retention rules and seals: pi_admin never deletes either, and updates only a seal's lift.
  "policy.retention_rules",
  "knowledge.seals",
  // The research ledger tables: append-only for the admin, but for a fetch's body_enc.
  "ledger.research_requests",
  "ledger.research_fetches",
  "policy.oauth_registrations",
  "policy.oauth_approvals",
  "policy.oauth_codes",
  "policy.oauth_tokens",
  // Lens's inbox and erased keys: written by the definer functions as pi_owner, the drain and
  // `pi erase settle`; pi_admin never inserts into either.
  "ledger.capture_inbox",
  "ledger.capture_erasures",
  "policy.capture_push_refusals",
  // Lens's mirror: written by the definer functions as pi_owner; pi_admin only reads them.
  ...MIRROR_TABLES,
  // The same-fact sweep's judgments, written by pi_pipeline; pi_admin selects and deletes, and
  // never inserts or updates.
  "knowledge.same_fact_judgments",
  // The labels in use, pi_owner's alone.
  "policy.labels",
  // The coverage migration's three: pi_admin never updates or deletes an outcome or a run, inserts
  // no outcome, and updates only three columns of a state.
  ...COVERAGE_TABLES,
  // pi_admin reads the notices and the declines, and writes neither.
  "ledger.work_notices",
  "ledger.work_declines",
  // pi_admin reads what work waits on, which ledger.place_work writes as pi_owner.
  "ledger.work_dependencies",
  // pi_admin reads the health notices and writes them only through
  // ledger.health_notice.
  "ledger.health_notices",
  "ledger.batch_notices",
  "ledger.ping_walks",
  "ledger.signal_marks",
  "ledger.change_log",
  "ledger.change_cursors",
  // pi_admin selects and deletes chat lines, and never inserts or updates.
  "knowledge.chat_lines",
  // pi_admin never updates a value row or a relation.
  ...QUERY_TIME_TABLES,
  // pi_admin selects both and deletes a named organization's names.
  ...NAMED_ORG_TABLES,
  // pi_admin never deletes a list; a deleted one is marked.
  "knowledge.owner_lists",
  // pi_admin never deletes an area; a retired one is marked.
  "knowledge.areas",
  // Dreaming: pi_admin inserts the owner's lines and models and updates or deletes neither; reads
  // the subjects and nights the pipeline writes; deletes findings, settlements and candidates on
  // erasure and updates only their state columns.
  "policy.dream_lines",
  "policy.dream_models",
  "ledger.dream_subjects",
  "ledger.dream_findings",
  "ledger.belief_settlements",
  "ledger.dream_identity_candidates",
  "ledger.dream_nights",
  // The promotion gate and its intake: pi_admin never deletes a promotion and updates only its
  // revoke, and never updates a taken claim.
  "ledger.promotions",
  "knowledge.promoted_claims",
];

// Each table's insert, update and delete as the reader under a client's token, and as pi_admin
// or, for the tables above, pi_owner. The statements touch no row.
export async function readerWriteProbes(db: TestDatabase, token: string): Promise<Probe[]> {
  return session(db.urls.reader, (reader) =>
    session(db.urls.admin, (admin) =>
      session(db.urls.bootstrap, async (bootstrap) => {
        const probes: Probe[] = [];
        for (const { name, column } of TABLES) {
          const statements = [
            `insert into ${name} (${column}) select ${column} from ${name} where false`,
            `update ${name} set ${column} = ${column} where false`,
            `delete from ${name} where false`,
          ];
          for (const sql of statements) {
            probes.push({
              sql,
              refused: await sqlState(() => withToken(reader, token, (run) => run(sql))),
              control: await sqlState(() =>
                OWNER_WRITES.includes(name) ? withOwner(bootstrap, (run) => run(sql)) : admin(sql),
              ),
            });
          }
        }
        return probes;
      }),
    ),
  );
}

// A select of a column of each `policy` and `vault` table as the reader under a client's token,
// and as pi_admin, who reads them all but policy.capture_push_refusals, which pi_owner alone
// reads. The column, not count(*): pi_reader holds select of one column of
// policy.research_settings, which count(*) needs and the table's probe column is not.
export async function readerReadProbes(db: TestDatabase, token: string): Promise<Probe[]> {
  return session(db.urls.reader, (reader) =>
    session(db.urls.admin, (admin) =>
      session(db.urls.bootstrap, async (bootstrap) => {
        const probes: Probe[] = [];
        for (const { name, column } of tablesIn("policy", "vault")) {
          const sql = `select count(${column}) from ${name}`;
          probes.push({
            sql,
            refused: await sqlState(() => withToken(reader, token, (run) => run(sql))),
            control: await sqlState(() =>
              OWNER_ONLY_TABLES.includes(name) ? withOwner(bootstrap, (run) => run(sql)) : admin(sql),
            ),
          });
        }
        return probes;
      }),
    ),
  );
}

export async function writerPolicyProbes(db: TestDatabase): Promise<Probe[]> {
  const name = "google/probe/refresh_token";
  const envelope = sealRow(db.keys, "own", { table: "policy.secrets", id: name, column: "value_enc" }, "probe-secret");
  const statements: [string, unknown[]][] = [
    ["select count(*) from policy.clients", []],
    ["select count(*) from policy.calls", []],
    ["insert into policy.secrets (name, value_enc) values ($1, $2)", [name, envelope]],
    ["update policy.secrets set updated_at = now() where name = $1", [name]],
    ["delete from policy.secrets where name = $1", [name]],
  ];
  return session(db.urls.writer, (writer) =>
    session(db.urls.admin, async (admin) => {
      const probes: Probe[] = [];
      for (const [sql, values] of statements) {
        probes.push({
          sql,
          refused: await sqlState(() => writer(sql, values)),
          control: await sqlState(() => admin(sql, values)),
        });
      }
      return probes;
    }),
  );
}
