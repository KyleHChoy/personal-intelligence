import type { z } from "zod";
import type { ClientView } from "./clients.ts";
import type { SelfView } from "./packs-self.ts";
import type { ResearchAnswer, ResearchArgs } from "./research.ts";
import type { ReadOutcome } from "./tool-errors.ts";
import type { MethodOf, READ_TOOL_WIRE, ToolWire, WORK_TOOL_WIRE, WRITE_TOOL_WIRE } from "./tool-wire.ts";
import type { PersonalProposeTool, PersonalRunTool, PersonalTool, PersonalWorkTool } from "./tools.ts";
import type { GetSelfArgs } from "./tools-args.ts";

// What the agent API hands every port call: a signal it aborts when the call is still working at the fourth
// multiple of its reply deadline. The implementation then cancels its statement and rolls back, so nothing
// is written, and answers "unavailable".
export type CallOptions = { signal?: AbortSignal };
// Why the agent API refused a call before any read, as the call log keeps it: a fixed code, and a
// key of the tool's own schema. Never a value or a name the call sent.
export type RefusalWhy = { reason: string; field?: string };
export type RefusalOptions = CallOptions & { why?: RefusalWhy | undefined };

// A port's methods, one for each row of a wire table (tool-wire.ts): the tool's name in camel case,
// its arguments in and its result out. A method never throws for a refusal; it throws only for a
// programming error, which the agent API answers as "unavailable".
type PortOf<Wire extends Record<string, ToolWire>> = {
  [Tool in keyof Wire & string as MethodOf<Tool>]: (
    token: string,
    args: z.infer<Wire[Tool]["args"]>,
    options?: CallOptions,
  ) => Promise<ReadOutcome<z.infer<Wire[Tool]["result"]>>>;
};

// What the agent API reads through, implemented by the store's reader.
export type PersonalReads = Omit<PortOf<typeof READ_TOOL_WIRE>, "getSelf"> & {
  client(token: string, options?: CallOptions): Promise<ClientView | null>;
  // `args` is optional: a caller that asks for nothing passes none.
  getSelf(token: string, args?: GetSelfArgs, options?: CallOptions): Promise<ReadOutcome<SelfView>>;
  // request_research. A filing answers the new request's id, or one of ResearchRefusal's codes;
  // like every method, also unauthorized or unavailable.
  fileResearch(token: string, args: ResearchArgs, options?: CallOptions): Promise<ReadOutcome<ResearchAnswer>>;
  // Records a call the agent API refused before any read, so the refusal still leaves its one
  // row in the call log. It reads nothing. The caller names the tool and no code: the provider
  // decides the code from the client's registration, "not_permitted" for a tool or view the
  // client lacks and "invalid_request" otherwise, and answers it, or the failure that kept the
  // row from being written. For record it checks the registration only, with no view.
  refused(token: string, tool: PersonalTool, options?: RefusalOptions): Promise<ReadOutcome<never>>;
};

// What the agent API writes agent records through, implemented by the store's reader.
export type PersonalWrites = PortOf<typeof WRITE_TOOL_WIRE>;

// What the agent API's work, run and propose tools call, implemented by the store's
// Work. Each method answers as a read does; refusedWork records a call refused before any work, as
// refused does for reads.
export type PersonalWork = PortOf<typeof WORK_TOOL_WIRE> & {
  refusedWork(
    token: string,
    tool: PersonalWorkTool | PersonalRunTool | PersonalProposeTool,
    options?: RefusalOptions,
  ): Promise<ReadOutcome<never>>;
};
