import type { CommandContext } from "./command-types.ts";

// While no restricted category is on, nothing is kept from `own`: a message about the owner's health,
// money or legal matters is stored and extracted under `own` like any other
//. So a client cleared for `own` (`--own`
// or `--broad`) reads those facts. The owner commands that clear a client for `own` say so, on
// stderr, beside their result: one fixed JSON line and one fixed line of words. Never a name or a fact.
// It names no command to turn a category on: the box sets no restricted key file, so that command
// refuses there (restricted_key_file_unset) until the restricted worker is built.
export const RESTRICTED_OFF_HINT =
  "warning: no restricted category is on, so this client can read the owner's health, money and legal facts under own; restricted categories are not yet available on the box";

export function warnRestrictedOff(
  { io, log }: Pick<CommandContext, "io" | "log">,
  compartments: readonly string[],
  onCategories: number,
): void {
  if (!compartments.includes("own") || onCategories > 0) return;
  log.warn({ event: "client_restricted_off", code: "no_restricted_category" });
  io.stderr.write(`${RESTRICTED_OFF_HINT}\n`);
}

// `--own` clears an agent for `own`. `--isolated` is its earlier name, still accepted: it read as
// the cautious choice, and it is the wider one, so using it prints one fixed line saying so.
export const ISOLATED_NOTE = "note: --isolated is deprecated; it is --own, which clears the agent for own";

export function ownFlag({ io, values }: Pick<CommandContext, "io" | "values">): boolean {
  if (values.isolated === true) io.stderr.write(`${ISOLATED_NOTE}\n`);
  return values.own === true || values.isolated === true;
}
