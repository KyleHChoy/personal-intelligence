import { CARD_OPTIONS, type CardId, type ToolName } from "@intelligence/contracts/personal";
import { raiseCard } from "../core/queue.ts";
import { testId } from "./clients.ts";
import { session } from "./connections.ts";
import { queryAs } from "./database.ts";
import type { Ids, NamedAsk } from "./hidden-rows-every-tool.ts";
import type { WorkInv6 } from "./hidden-rows-work.ts";
import { HIDDEN } from "./hidden-rows-world.ts";
import { recordingLogger } from "./recording.ts";
import { seeder } from "./seeder.ts";

// every-tool-hidden-rows.db.test.ts's asks of the agents' operations tools, mark_health_seen and
// file_learning, and the hidden rows they name: a box health card under employer:example, and a
// learning the scout filed under its clearance (employer:example and its own agent compartment), so
// neither viewer is cleared for either. The scout is each control's client: cleared for both rows,
// and for no learning a viewer files (each holds `own`), so a statement no row has is a new learning
// for it, never a merge. And report_wrong_relation, and the model's relation in effect under
// employer:example it names, which the scout is cleared for and neither viewer is.

export type AgentOpsIds = Pick<Ids, "healthCard" | "learning" | "learningStatement" | "relation">;

// What the asks name where no row is: ids of each form that no row has.
export const ABSENT_AGENT_OPS: AgentOpsIds = {
  healthCard: `crd_7${"Z".repeat(25)}`,
  learning: `lrn_7${"Z".repeat(25)}`,
  learningStatement: "a learning nobody filed",
  relation: "999999999999",
};

const learning = (statement: string) => ({
  statement,
  rule: "ask with after for the next page",
  evidence: "find_messages answered fifty rows and more: true",
  scope: "general",
});

const ask = (name: string, tool: ToolName, args: NamedAsk["args"]): NamedAsk => ({
  ask: name,
  tool,
  args,
  by: "agent",
  wide: "scout",
});

export const AGENT_OPS_ASKS: readonly NamedAsk[] = [
  ask("mark_health_seen", "mark_health_seen", (x) => ({ card: x.healthCard })),
  // A learning merges only into one its caller can see.
  ask("file_learning statement", "file_learning", (x) => learning(x.learningStatement)),
  // A supersedes the caller cannot see answers as one no learning has.
  ask("file_learning supersedes", "file_learning", (x) => ({
    ...learning("find_messages pages stop at fifty rows, then take after"),
    supersedes: x.learning,
  })),
  // A relation the caller cannot see answers as one no relation has.
  ask("report_wrong_relation", "report_wrong_relation", (x) => ({
    relation: x.relation,
    because: "not_same_fact",
    cites: [x.message],
  })),
];

export async function seedHiddenAgentOps(w: WorkInv6): Promise<AgentOpsIds> {
  // A box health card of a kind an agent may mark, as raiseHealth raises one, but under
  // employer:example: the product raises them under `own`, so this is the twin of a row only a later
  // change could write.
  const healthCard = await session(w.s.store.db.urls.admin, async (query) => {
    const raised = await raiseCard(
      query,
      {
        id: testId("crd") as CardId,
        requestId: testId("req"),
        kind: "box_health",
        author: "system:health",
        options: [...CARD_OPTIONS.box_health],
        target: null,
        refs: [],
        compartments: [HIDDEN] as never,
        expiresAt: null,
        expiresAfterDays: null,
        caseKey: "box:failure_streak:extract",
        run: null,
        body: null,
        bodyFrom: null,
      },
      { now: new Date(), log: recordingLogger().log },
    );
    return raised.id as string;
  });
  const learningStatement = "the hidden search tool stops at fifty rows";
  const filed = await w.work.fileLearning(w.scout.token, {
    ...learning(learningStatement),
    requestId: testId("req"),
  } as never);
  if (!filed.ok) throw new Error(`the scout's learning was refused: ${JSON.stringify(filed)}`);
  return { healthCard, learning: filed.value.learning as string, learningStatement, relation: await relation(w) };
}

// A model's relation in effect between two claims under employer:example, as the dream pass leaves
// one: written by the Pipeline, its census check by a second model held, and its kind on.
async function relation(w: WorkInv6): Promise<string> {
  const label = [HIDDEN];
  const keys = await session(w.s.store.db.urls.admin, async (query) => {
    const seed = seeder(w.s.store.db, query);
    return [await seed.claimValue(label), await seed.claimValue(label)];
  });
  const judge = "model:test/judge@personal_claim_relations@1";
  const pipeline = <Row>(text: string, values: unknown[]) => queryAs<Row>(w.s.store.db.urls.pipeline, text, values);
  const [row] = await pipeline<{ id: string }>(
    `insert into knowledge.claim_relations (from_claim_key, to_claim_key, kind, judged_by, version, compartments)
     values ($1, $2, 'same_fact', $3, 1, $4) returning id::text as id`,
    [keys[0], keys[1], judge, label],
  );
  if (row === undefined) throw new Error("no hidden relation");
  await pipeline(
    `insert into ledger.source_checks (target, kind, target_key, relation_id, relation_judge, judge, verdict, on_cited, claim_keys, compartments, census, live)
     values ('relation', 'same_fact', $1, $2::bigint, $3, 'model:test/checker@source_check@1', 'supported', true, $4::text[], $5::text[], true, true)`,
    ["c".repeat(64), row.id, judge, keys, label],
  );
  await pipeline(
    "insert into policy.relation_switches (kind, judge, switched_on, decided_by) values ('same_fact', $1, true, 'system')",
    [judge],
  );
  return row.id;
}
