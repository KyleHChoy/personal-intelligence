import {
  type PersonalView,
  type PersonalWriteTool,
  type ReadOutcome,
  WORK_TOOL_VIEW,
} from "@intelligence/contracts/personal";
import { parseProposeArgs, proposeAboutYou, type Refused } from "../agent-writes/propose.ts";
import { parsePersonArgs, proposePerson } from "../agent-writes/propose-person.ts";
import { appendRecord, parseRecordArgs } from "../agent-writes/record.ts";
import { answerOwnerQuestion, parseAnswerArgs } from "../cards/answer.ts";
import { closeCommitment, parseCloseArgs, parseReopenArgs, reopenCommitment } from "../cards/close.ts";
import type { Ctx } from "../core/read-ctx.ts";
import { importMemory, parseImportArgs } from "../memory/memory-import.ts";
import { asOfOf, beliefsAt } from "./computed-beliefs.ts";

// One write tool as the reader runs it on record's path (read.ts): its name, the view it needs
// beyond its registration, its arguments' parse (which may refuse with a claim check's code), and
// its work under the call's context. Every write runs read committed with the shared taint lock
// first, so the isolation, the lock and the call log are written once, in read.ts.
export type WriteTool<A, T, N extends PersonalWriteTool = PersonalWriteTool> = {
  tool: N;
  view: PersonalView | null;
  parse(args: unknown): A | Refused | null;
  work(ctx: Ctx, args: A): Promise<{ outcome: ReadOutcome<T>; rows: number }>;
};

const writeTool = <A, T, N extends PersonalWriteTool>(row: WriteTool<A, T, N>): WriteTool<A, T, N> => row;

// The catalogue: one row per write tool.
export const WRITE_TOOLS = {
  // One agent record: the cites, the session, the label, the stamps and the sealed body;
  // policy.append_record. It writes no read log row: resolving a cite returns nothing to the client.
  record: writeTool({ tool: "record", view: null, parse: parseRecordArgs, work: appendRecord }),
  // The answer is the same recordId for every scope.
  propose_about_you: writeTool({
    tool: "propose_about_you",
    view: null,
    parse: parseProposeArgs,
    work: proposeAboutYou,
  }),
  // A person, a person's tie to the owner or a typed link, the entities it names checked against the token.
  propose_person: writeTool({ tool: "propose_person", view: null, parse: parsePersonArgs, work: proposePerson }),
  // The owner's reply to an owner_question opportunity the caller holds: each fact's what a slice of
  // the quote, the question, the session, the label, the stamps and the sealed body;
  // ledger.answer_owner_question. It also needs the view work.
  answer_owner_question: writeTool({
    tool: "answer_owner_question",
    view: WORK_TOOL_VIEW,
    parse: parseAnswerArgs,
    work: answerOwnerQuestion,
  }),
  // An agent's close of a commitment it can see: the commitment and the cited items as the token
  // returns them, the session, the label and the sealed body; ledger.close_commitment.
  close_commitment: writeTool({
    tool: "close_commitment",
    view: null,
    parse: parseCloseArgs,
    work: (ctx, args) => closeCommitment(ctx, args, async (one, keys) => beliefsAt(one, keys, await asOfOf(one))),
  }),
  // An agent reopens a close of its own; ledger.reopen_close.
  reopen_commitment: writeTool({
    tool: "reopen_commitment",
    view: null,
    parse: parseReopenArgs,
    work: reopenCommitment,
  }),
  // The memory adapter's import: the session, the label, each change's stamps, line and locator
  // fingerprints and sealed body; policy.import_memory. The answer is the number of changes,
  // whatever was kept.
  import_memory: writeTool({ tool: "import_memory", view: null, parse: parseImportArgs, work: importMemory }),
} satisfies { [K in PersonalWriteTool]: { tool: K } };

export const isWriteTool = (tool: string): tool is PersonalWriteTool => Object.hasOwn(WRITE_TOOLS, tool);
