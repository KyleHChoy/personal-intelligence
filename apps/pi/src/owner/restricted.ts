import type { CommandContext } from "../command-types.ts";
import { refusal } from "../env.ts";
import { printJson, withAdmin } from "./owner-kit.ts";

// The restricted categories' commands. The lift is refused as not built.

// The on categories, each with how many items carry it, its pending requests and its lifts.
// Counts only.
export async function restrictedList(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    printJson(context, { categories: await admin.restricted.counts() });
  });
}

// The one-time reclassification of stored mail by the term screen (admin-restricted.ts): how many
// items of each on category would be asked for, and with `--apply` the requests written and those
// items' messages kept from every client until sync's relabel. Counts only.
export async function restrictedReclassify(context: CommandContext): Promise<0> {
  const apply = context.values.apply === true;
  return withAdmin(context, async (admin) => {
    printJson(context, { applied: apply, categories: await admin.restricted.reclassify(apply) });
  });
}

export function restrictedLift(_context: CommandContext): Promise<0> {
  return Promise.reject(refusal("not_built"));
}
