// Work clients and their sessions, written in SQL.

import { randomBytes } from "node:crypto";
import { ALL_TOOLS, ALL_VIEWS, sha256Hex, type TestClient, testId } from "./clients.ts";
import { readAs } from "./connections.ts";
import { queryAs, type TestDatabase } from "./database.ts";

// ---------------------------------------------------------------------------------------------
// Work clients and their sessions, in SQL
// ---------------------------------------------------------------------------------------------

export const WORK_TOOLS = [
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
] as const;
export const AGENT_WORK_TOOLS = WORK_TOOLS.slice(0, 9);
export const RUN_TOOLS = WORK_TOOLS.slice(9);
// An agent that proposes tasks, hands work off and records what it found.
export const TASK_AGENT_TOOLS = [...AGENT_WORK_TOOLS, "propose_task", "hand_off", "record"];
// An agent that reads, works and records.
export const READING_AGENT_TOOLS = [...ALL_TOOLS, ...AGENT_WORK_TOOLS, "record"];

export type WorkClient = TestClient & { kind: "agent" | "reasoner"; session: string };

// A session of a client's, opened as pi mcp opens one: policy.open_session under its token.
export async function openWorkSession(db: TestDatabase, token: string): Promise<string> {
  const id = testId("ses");
  await readAs(db, token, (query) => query("select policy.open_session($1)", [id]));
  return id;
}

// A client of a kind, inserted as pi_admin with the tools and views given (by default every
// read tool and the kind's work or run tools, and every view), with one session opened.
export async function insertWorkClient(
  db: TestDatabase,
  name: string,
  compartments: string[],
  options: { kind?: "agent" | "reasoner"; tools?: readonly string[]; views?: readonly string[] } = {},
): Promise<WorkClient> {
  const kind = options.kind ?? "agent";
  const tools = options.tools ?? [
    ...ALL_TOOLS,
    "find_messages",
    "read_message",
    ...(kind === "reasoner" ? RUN_TOOLS : AGENT_WORK_TOOLS),
  ];
  const client = {
    id: testId("cli"),
    name,
    token: `pit_test-token-${name}-${randomBytes(8).toString("hex")}`,
    compartments,
  };
  await queryAs(
    db.urls.admin,
    `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind)
     values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6, $7)`,
    [client.id, client.name, sha256Hex(client.token), compartments, options.views ?? ALL_VIEWS, tools, kind],
  );
  return { ...client, kind, session: await openWorkSession(db, client.token) };
}
