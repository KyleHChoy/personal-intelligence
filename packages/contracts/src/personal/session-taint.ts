import { z } from "zod";
import { isRestricted, PersonalCompartment } from "./compartments.ts";
import type { CallOptions } from "./tool-ports.ts";
import type { PersonalReadTool, PersonalWorkTool, ToolName } from "./tools.ts";
import { BUDGETED_TOOLS, READ_BUDGET, WORK_READ_BUDGET } from "./tools.ts";

export const SessionTaintCode = z.enum(["tainted_session", "private_session"]);
export type SessionTaintCode = z.infer<typeof SessionTaintCode>;

// A label as a session carries it: the compartments read, sorted and each once, and the integrity
// mark. `untrusted` only ever turns on; a fresh session starts trusted with nothing read.
export const SessionLabel = z.strictObject({
  compartments: z.array(PersonalCompartment),
  untrusted: z.boolean(),
});
export type SessionLabel = z.infer<typeof SessionLabel>;

export const FRESH_LABEL: SessionLabel = Object.freeze({ compartments: [], untrusted: false }) as SessionLabel;

// The join of two labels, as a run's output takes the union of what it read: compartments united,
// untrusted if either is.
export const joinLabels = (a: SessionLabel, b: SessionLabel): SessionLabel => ({
  compartments: [...new Set([...a.compartments, ...b.compartments])].sort(),
  untrusted: a.untrusted || b.untrusted,
});

// The one place the restricted set is read. A compartment is restricted when its name is a
// restricted one (`restricted:<category>`, compartments.ts); the passkey compartments are named that
// way, so marking a compartment restricted there is all it takes for taint to treat it so.
export const isTaintRestricted = (compartment: string): boolean => isRestricted(compartment);
// Private: anything but what is public to every client.
const NOT_PRIVATE = ["public", "declassified"];
export const isTaintPrivate = (compartment: string): boolean => !NOT_PRIVATE.includes(compartment);

// The tools that read under the caller's clearance: every tool a read budget counts.
const TAINT_READ_TOOLS: readonly ToolName[] = BUDGETED_TOOLS;
// The raw-text tools: those that serve the text of one item asked for by id (a `text` budget). Their
// text is a source's own words, inside { untrusted }, so a session that reads one is untrusted.
export const RAW_TEXT_TOOLS: readonly ToolName[] = Object.freeze(
  BUDGETED_TOOLS.filter(
    (tool) => READ_BUDGET[tool as PersonalReadTool] === "text" || WORK_READ_BUDGET[tool as PersonalWorkTool] === "text",
  ),
);
// The tools that carry an agent's free text to other agents, with the arguments that hold it. A call
// that sends none of them carries typed values only, and is not counted.
export const FREE_TEXT_ARGS: Readonly<Partial<Record<ToolName, readonly string[]>>> = Object.freeze({
  post_agent_message: ["subject", "body"],
  propose_task: ["summary", "details"],
  write_back: ["note", "tried"],
});

export const isRawTextTool = (tool: ToolName): boolean => RAW_TEXT_TOOLS.includes(tool);
export const isTaintReadTool = (tool: ToolName): boolean => TAINT_READ_TOOLS.includes(tool);
// Whether a call sends free text: a free-text argument present in what the call sent.
export const sendsFreeText = (tool: ToolName, args: unknown): boolean => {
  const keys = FREE_TEXT_ARGS[tool];
  if (keys === undefined || typeof args !== "object" || args === null) return false;
  return keys.some((key) => (args as Record<string, unknown>)[key] !== undefined);
};

// One line each, for the tools' descriptions and the refusals' hints.
export const RAW_TEXT_RULE = "Your session then gets no restricted facts.";
export const SESSION_TAINT_HINTS: Readonly<Record<SessionTaintCode, string>> = Object.freeze({
  tainted_session:
    "This session read raw source text, so it may not read restricted facts. Read them from a fresh session.",
  private_session:
    "This session read restricted facts, so it may not read raw source text. Read the text from a fresh session.",
});

// What the agent API records of each taint decision: the tool, the code, and whether it was refused
// (enforced) or only counted (a would-refuse in shadow). Ids and codes only.
export type SessionTaintEntry = { tool: ToolName; code: SessionTaintCode; enforced: boolean };
// Where those counts go, implemented by the store's reader: one counted row per client, day, tool,
// code and enforced, under the client's own token.
export type SessionTaintLedger = {
  countSessionTaint(token: string, entry: SessionTaintEntry, options?: CallOptions): Promise<void>;
};
