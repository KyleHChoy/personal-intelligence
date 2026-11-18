import { testId } from "./clients.ts";

// One stretch of the owner's own for the seeder: a ruling of none, as pi_admin writes it. Its
// decision is under the row's label, or `own` for the empty label a check refuses.
const AT = "2026-01-01T00:00:00.000Z";
const END = "2026-01-01T00:01:00.000Z";

export const timeRulingSeed =
  (
    insert: (table: string, row: Record<string, unknown>) => Promise<unknown>,
    decision: (compartments: string[]) => Promise<string>,
  ) =>
  async (compartments: string[]): Promise<void> => {
    await insert("knowledge.time_rulings", {
      id: testId("tru"),
      from_at: AT,
      to_at: END,
      source: "owner",
      ruling_id: await decision(compartments.length === 0 ? ["own"] : compartments),
      created_at: AT,
      compartments,
    });
  };

// One agent anchor and one agent ruling, as the definers write them: ids, a keyed
// fingerprint, times and a label, of a project of the same label, by a client.
export const agentTimeSeed =
  (
    insert: (table: string, row: Record<string, unknown>) => Promise<unknown>,
    project: (compartments: string[]) => Promise<string>,
    client: (compartments: string[]) => Promise<string>,
    table: "knowledge.agent_anchors" | "knowledge.agent_time_rulings",
  ) =>
  async (compartments: string[]): Promise<void> => {
    const label = compartments.length === 0 ? ["own"] : compartments;
    const row = {
      project_id: await project(label),
      client_id: await client(label),
      request_id: testId("req").slice(4),
      created_at: AT,
      compartments,
    };
    if (table === "knowledge.agent_anchors")
      await insert(table, {
        ...row,
        id: testId("aan"),
        kind: "repository",
        anchor_fp: "a".repeat(64),
        value_enc: { sealed: "seed" },
      });
    else await insert(table, { ...row, id: testId("atr"), from_at: AT, to_at: END, tool: "rule_time", reach: label });
  };

// The seeder's rows of the time tables.
export const timeSeeds = (
  insert: (table: string, row: Record<string, unknown>) => Promise<unknown>,
  decision: (compartments: string[]) => Promise<string>,
  project: (compartments: string[]) => Promise<string>,
  client: (compartments: string[]) => Promise<string>,
): Record<string, (compartments: string[]) => Promise<void>> => ({
  "knowledge.time_rulings": timeRulingSeed(insert, decision),
  "knowledge.agent_anchors": agentTimeSeed(insert, project, client, "knowledge.agent_anchors"),
  "knowledge.agent_time_rulings": agentTimeSeed(insert, project, client, "knowledge.agent_time_rulings"),
});
