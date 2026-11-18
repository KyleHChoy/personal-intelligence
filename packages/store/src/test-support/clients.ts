// Ids, tokens, clients and secrets, written in SQL as pi_admin.

import { createHmac, randomBytes } from "node:crypto";
import type { RequestId } from "@intelligence/contracts/personal";
import { sha256 } from "@intelligence/personal-core";
import type { Keys } from "../core/keys.ts";
import { queryAs, sealRow, type TestDatabase } from "./database.ts";

// ---------------------------------------------------------------------------------------------
// Ids, tokens, clients and secrets, written in SQL as pi_admin
// ---------------------------------------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// A row id for a row a test inserts itself: the table's prefix and a ULID. The store's own
// `newId` is under test, so the fixtures do not lean on it.
export function testId(prefix: string): string {
  let time = Date.now();
  let head = "";
  for (let index = 0; index < 10; index += 1) {
    head = `${CROCKFORD[time % 32] ?? "0"}${head}`;
    time = Math.floor(time / 32);
  }
  const tail = [...randomBytes(16)].map((byte) => CROCKFORD[byte % 32] ?? "0").join("");
  return `${prefix}_${head}${tail}`;
}

// A request id no other call used.
export const request = (): RequestId => testId("req") as RequestId;

// The hex SHA-256 of a text's UTF-8 bytes: a token's stored form, and a seed's made-up hash.
export { sha256 as sha256Hex } from "@intelligence/personal-core";

// For the two hash kinds (`content_hash`, `body_hash`), whose value is a hash's 64 hexadecimal
// characters, unchanged. Any other kind is given only as a control: it must equal what
// `fingerprint` returns for a value that is already normalized.
export const hashFingerprint = (
  keys: Keys,
  kind: "content_hash" | "body_hash" | "thread" | "source_id",
  value: string,
): string =>
  createHmac("sha256", keys.fingerprintKey)
    .update(kind, "utf8")
    .update(Buffer.from([0]))
    .update(value, "utf8")
    .digest("hex");

export const ALL_VIEWS = ["self", "people", "work"];
export const ALL_TOOLS = ["get_self", "search", "get_entity", "get_timeline"];
// The names the migrations put in `policy.tool_names`: the core's six, the extraction's find_facts,
// the agent records' record, and the read tools' build_context_pack and get_commitments; and durable
// work's twelve work and run tools (WORK_TOOLS, below, which a constant here cannot name before it is
// made); and the Drive's two document tools.
export const TOOL_NAMES = [
  "read_record",
  "find_records",
  "get_open_items",
  "get_changes",
  "get_self",
  "search",
  "get_entity",
  "get_timeline",
  "find_messages",
  "read_message",
  "find_facts",
  "record",
  "build_context_pack",
  "get_commitments",
  "list_opportunities",
  "claim_opportunity",
  "release_opportunity",
  "propose_hypothesis",
  "record_test",
  "propose_opportunity",
  "plan_move",
  "report_move",
  "set_intention",
  "next_run",
  "append_step",
  "finish_run",
  "draft_message",
  "sync_memory",
  "find_documents",
  "get_document",
  // The read quotas migration: the six further read tools.
  "get_evidence_span",
  "read_item",
  "get_decision_history",
  "find_paths",
  "fetch_template",
  "get_suggestions",
  // The two further agent-lane writes.
  "propose_about_you",
  "import_memory",
  "get_beliefs",
  "request_research",
  "answer_owner_question",
  "list_goals",
  "push_capture",
  "sync_mirror",
  "context",
  "propose_person",
  "propose_task",
  "hand_off",
  "write_back",
  "propose_goal",
  "propose_goal_target",
  "record_reads",
  "list_people",
  "close_commitment",
  "reopen_commitment",
  "about",
  "post_agent_message",
  "read_agent_inbox",
  "submit_improvement",
  "list_improvements",
  "update_improvement",
  "record_spend",
  "start_outcome_test",
  "record_held_out_question",
  "record_outcome_task",
] as const;

export type TestClient = { id: string; name: string; token: string; compartments: string[] };

// A client, inserted as pi_admin, not through `Admin`. Its token is made here unless one is given.
export async function insertClient(
  db: TestDatabase,
  name: string,
  compartments: string[],
  token?: string,
): Promise<TestClient> {
  const client = {
    id: testId("cli"),
    name,
    token: token ?? `pit_test-token-${name}-${randomBytes(8).toString("hex")}`,
    compartments,
  };
  await queryAs(
    db.urls.admin,
    `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools)
     values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6)`,
    [client.id, client.name, sha256(client.token), compartments, ALL_VIEWS, ALL_TOOLS],
  );
  return client;
}

export const revokeClient = (db: TestDatabase, client: TestClient): Promise<unknown> =>
  queryAs(db.urls.admin, "update policy.clients set status = 'revoked', revoked_at = now() where id = $1", [client.id]);

// A secret, sealed as the store seals one: under the `own` key, bound to its name.
export const insertSecret = (db: TestDatabase, name: string, value: string): Promise<unknown> =>
  queryAs(db.urls.admin, "insert into policy.secrets (name, value_enc) values ($1, $2)", [
    name,
    sealRow(db.keys, "own", { table: "policy.secrets", id: name, column: "value_enc" }, value),
  ]);
