import { type ClientView, instantOf, type PersonalReadTool } from "@intelligence/contracts/personal";
import type { Ctx, Found } from "./read-ctx.ts";

// One read tool as the reader runs it (read.ts): its name, its arguments' parse, and its work under
// the call's context and client. Each tool's definition lives beside the read it runs; the reader
// takes it whole, so the budget and the read log are written once in read.ts, and the token, the
// view check and the call log once in read-db.ts.
//   `env.now` is the reader's clock, which the work calls where it needs the time. `isolation` is a repeatable-read snapshot unless the tool names another:
// "committed" is get_changes', for what waits on a lock of its own; "under_taint" is sync_memory's,
// read committed with the shared taint lock first.
export type ReadTool<A, T> = {
  tool: PersonalReadTool;
  parse(args: unknown): A | null;
  work(
    ctx: Ctx,
    args: A,
    client: ClientView,
    env: ReadEnv,
  ): Promise<Found<T> | "not_permitted" | "invalid_request" | "subject_unknown" | null>;
  isolation?: "committed" | "under_taint";
};

type ReadEnv = { now: () => Date };

// A schema's parse, as its value or null. The reader names no schema library.
export const parsed = <A>(result: { success: true; data: A } | { success: false }): A | null =>
  result.success ? result.data : null;

// A time argument must be an instant: one that is not is refused like any other bad argument. A
// date alone is kept as it is here, and read as the owner's local day, UTC's while they have set no
// zone, by the call itself (zonedBounds).
const isInstant = (value: string | undefined): boolean =>
  value === undefined || !Number.isNaN(new Date(value).getTime());
export const timed = <A extends { from?: string | undefined; to?: string | undefined }>(args: A | null): A | null =>
  args === null || !isInstant(instantOf(args.from, "from")) || !isInstant(instantOf(args.to, "to")) ? null : args;
