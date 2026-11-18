import type { ToolName } from "@intelligence/contracts/personal";
import { deviceAnchorKey } from "@intelligence/personal-core/lens";
import { testId } from "./clients.ts";
import { session } from "./connections.ts";
import { fingerprint } from "./database.ts";
import type { Ids, NamedAsk } from "./hidden-rows-every-tool.ts";
import type { WorkInv6 } from "./hidden-rows-work.ts";
import { HIDDEN } from "./hidden-rows-world.ts";
import { seeder } from "./seeder.ts";

// The hidden-rows tests' asks of the tools agents sort time with: get_work_time over
// a fixed window, and the five writes, each naming a row of the hidden twin's: a system proposal, an
// agent's anchor and ruling, all under employer:example on a project of that label, the anchor and
// the ruling the scout's. No block lies under either label here: the reads' twins of blocks are
// agent-time.db.test.ts's.

export type AgentTimeIds = Pick<Ids, "timeProposal" | "agentAnchor" | "agentRuling" | "anchorPlace">;

// get_work_time's window, and the hidden rows' hour inside it.
export const WORK_TIME_WINDOW = { from: "2026-01-04", to: "2026-01-06" } as const;
const FROM = "2026-01-05T10:00:00.000Z";
const TO = "2026-01-05T11:00:00.000Z";
// The place the scout anchored, and one nobody did.
export const HIDDEN_PLACE = "forge.example.org/kestrel/hidden-anchor";
export const ABSENT_PLACE = "forge.example.org/kestrel/nobody-anchored";
const PROJECT_PLACE = "forge.example.org/kestrel/project-anchor";

const ask = (name: string, tool: ToolName, args: NamedAsk["args"], wide: NamedAsk["wide"] = "both"): NamedAsk => ({
  ask: name,
  tool,
  args,
  by: "agent",
  wide,
});

export const AGENT_TIME_ASKS: readonly NamedAsk[] = [
  // A project the caller cannot see answers as one that does not exist.
  ask("set_anchor project", "set_anchor", (x) => ({ project: x.project, kind: "repository", value: PROJECT_PLACE })),
  // A place another agent anchored under a label the caller cannot see is free to it: anchor_taken
  // only from an anchor it can see.
  ask("set_anchor place", "set_anchor", (x, v) => ({ project: v.project, kind: "repository", value: x.anchorPlace })),
  ask("rule_time project", "rule_time", (x) => ({ from: FROM, to: TO, project: x.project })),
  ask("judge_time_proposal", "judge_time_proposal", (x) => ({ proposal: x.timeProposal })),
  // The scout's own anchor and ruling: only it may lift them.
  ask("lift_anchor", "lift_anchor", (x) => ({ anchor: x.agentAnchor }), "scout"),
  ask("lift_time_ruling", "lift_time_ruling", (x) => ({ ruling: x.agentRuling }), "scout"),
];

// A live system proposal of `project` under `label`, as the daily pass writes one.
export async function addHiddenProposal(w: WorkInv6, project: string, label: readonly string[]): Promise<string> {
  const proposal = testId("tpr");
  await session(w.s.store.db.urls.admin, (query) =>
    query(
      `insert into knowledge.time_rulings (id, project_id, from_at, to_at, source, proposal_id, created_at, compartments)
       values ($1, $2, $3, $4, 'system', $5, now(), $6)`,
      [testId("tru"), project, FROM, TO, proposal, label],
    ),
  );
  return proposal;
}

export async function seedHiddenAgentTime(w: WorkInv6): Promise<AgentTimeIds> {
  const label = [HIDDEN];
  const project = await session(w.s.store.db.urls.admin, (query) => seeder(w.s.store.db, query).project(label));
  const timeProposal = await addHiddenProposal(w, project, label);
  const answer = deviceAnchorKey("repository", HIDDEN_PLACE);
  if (!("key" in answer)) throw new Error("the hidden place is no anchor");
  const agentAnchor = testId("aan");
  const agentRuling = testId("atr");
  await session(w.s.store.db.urls.admin, async (query) => {
    await query(
      `insert into knowledge.agent_anchors (id, project_id, kind, anchor_fp, value_enc, client_id, request_id, created_at, compartments)
       values ($1, $2, 'repository', $3, '{"sealed":"hidden"}', $4, $5, now(), $6)`,
      [agentAnchor, project, fingerprint(w.keys, "anchor", answer.key), w.scout.id, testId("req"), label],
    );
    await query(
      `insert into knowledge.agent_time_rulings (id, project_id, from_at, to_at, tool, client_id, request_id, created_at, compartments, reach)
       values ($1, $2, $3, $4, 'rule_time', $5, $6, now(), $7, $8)`,
      [agentRuling, project, FROM, TO, w.scout.id, testId("req"), label, [...w.scout.compartments].sort()],
    );
  });
  return { timeProposal, agentAnchor, agentRuling, anchorPlace: HIDDEN_PLACE };
}
