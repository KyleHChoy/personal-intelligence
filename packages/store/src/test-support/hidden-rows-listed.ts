// The asks of every-tool-hidden-rows.db.test.ts that name no row, and those of them that have no
// positive control yet.

import { OUTCOME_SUITE, type ToolName } from "@intelligence/contracts/personal";

type Args = Record<string, unknown>;

// One ask that names no row: asked before the hidden rows are added and after. `own`, what in its
// reply counts the caller's own calls, or is computed from that count, left out of the comparison.
export type ListedAsk = { ask: string; tool: ToolName; by: "agent" | "reasoner"; args: Args; own?: RegExp };

const listed = (
  ask: string,
  tool: ToolName,
  args: Args,
  more: Partial<Pick<ListedAsk, "by" | "own">> = {},
): ListedAsk => ({
  ask,
  tool,
  args,
  by: more.by ?? "agent",
  ...(more.own === undefined ? {} : { own: more.own }),
});

export const LISTED: readonly ListedAsk[] = [
  listed("sync_memory", "sync_memory", { have: [], canDelete: false }),
  listed("find_documents", "find_documents", {}),
  listed("get_suggestions", "get_suggestions", { state: "any" }),
  listed("get_beliefs", "get_beliefs", { state: "any", limit: 50 }),
  // Each call with no cursor starts the session's next pass, so its number counts the calls, and the
  // page's hash is over the page with that number: the rest of the page is compared as it is.
  listed(
    "sync_mirror",
    "sync_mirror",
    { templates: ["lens_mirror@1"], cursor: null },
    { own: /"pass":\d+|"hash":"[0-9a-f]{64}"/ },
  ),
  listed("list_goals", "list_goals", { status: "any", stated: true }),
  listed("context", "context", { task: "plan the week" }),
  listed("record_reads", "record_reads", {}),
  listed("list_people", "list_people", {}),
  listed("find_records", "find_records", {}),
  listed("find_records text", "find_records", { text: "hidden" }),
  listed("start_outcome_test", "start_outcome_test", {
    suite: OUTCOME_SUITE,
    tasks: 3,
    answerModel: "model-a",
    judgeModel: "model-b",
  }),
  listed("next_run", "next_run", {}, { by: "reasoner" }),
];

// The listed asks whose wide client's reply does not change with the hidden rows, each with why: a
// gap, since their viewers' unchanged replies prove nothing until the world gives them a hidden row.
export const NO_CONTROL: Readonly<Record<string, string>> = {
  get_suggestions: "the hidden rows raise no suggestion, so the wide client's reply is empty before and after",
  start_outcome_test:
    "the hidden rows hold no outcome test or held-out task, so every client is given a fresh run and nothing held out",
  next_run:
    "asked by the reasoner, cleared for own until widenReasoner runs after the listed asks, so no client of it can see the hidden run",
};
