import type { PersonalReadTool, ToolName } from "@intelligence/contracts/personal";
import { READ_BUDGET, TOOL_NAMES } from "@intelligence/contracts/personal";

// The reply deadline of each tool. Every tools/call is
// answered at a whole multiple of its deadline, never sooner, so how long a reply takes never
// reveals rows the caller cannot see. A tool added later takes its tier's value until it is
// measured.

// Provisional values by tier, for a tool MEASURED does not raise: one
// entity or one message; whole-store reads and packs; a write, and every work, run and propose
// tool.
const ONE = 400;
const WIDE = 1_500;
const WRITE = 600;

// Measured on the box: from the agent API's logged reply times, the smallest multiple of 100 ms
// within which at least 90% of a tool's calls finished and all of them within twice it, so the
// cancel at MAX_MULTIPLES keeps a margin of two. A value is only raised from its tier: a reply time
// bounds its work from above, never from below, so lowering one takes a measurement of the work
// itself.
const MEASURED = {
  get_entity: 800,
  get_timeline: 800,
  get_self: 4_500,
  search: 3_000,
  find_facts: 2_300,
  build_context_pack: 4_500,
  claim_opportunity: 1_200,
  // Its `mine` builds each held item's brief, as a claim does, so the write tier is too short:
  // calls that would finish are cancelled at MAX_MULTIPLES.
  list_opportunities: 1_200,
} as const;

// What next_run may take, a value derived rather than measured: its reply reads what get_self reads
// and the goals, the open work and the cases besides, so its deadline is never below get_self's,
// and it is twice that because a cancel costs the run one of its two attempts. Only the reasoner
// calls it, on a two-minute loop, so a long wait costs nothing.
const NEXT_RUN = 2 * MEASURED.get_self;

// The tools off their tier's value: the measured ones, what is derived from them, and the three list
// tools that read no wider than one item.
const OFF_TIER: Readonly<Partial<Record<ToolName, number>>> = {
  ...MEASURED,
  // A page of rows by a narrow filter, and one record by its id.
  find_messages: ONE,
  find_documents: ONE,
  read_record: ONE,
  // What get_self's `next` reads, at most every five minutes; a poll between takes a few small statements,
  // and replies at this deadline all the same, so what it found shows in no timing.
  get_changes: MEASURED.get_self,
  // The run it takes and that run's brief: the goals, the open opportunities and the closed
  // cases, read across the store in the same call.
  next_run: NEXT_RUN,
};
const isRead = (name: ToolName): name is PersonalReadTool => Object.hasOwn(READ_BUDGET, name);

// Every tool's deadline: a row above, else its tier: a read that serves one item's text ONE, any
// other read WIDE, and every write, work, run and propose tool WRITE (a push until a 1 MiB batch is
// measured).
export const DEADLINE_MS: Readonly<Record<ToolName, number>> = Object.freeze(
  Object.fromEntries(
    TOOL_NAMES.map((name) => [
      name,
      OFF_TIER[name] ?? (isRead(name) ? (READ_BUDGET[name] === "text" ? ONE : WIDE) : WRITE),
    ]),
  ),
) as Record<ToolName, number>;

// A call still working at this multiple of its deadline is cancelled and
// answered `unavailable`, so an over-deadline reply shows a count of 2, 3 or 4 and nothing finer.
export const MAX_MULTIPLES = 4;
