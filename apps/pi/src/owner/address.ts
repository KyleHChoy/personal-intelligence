import type { CommandContext } from "../command-types.ts";
import { compartments, printJson, withAdmin } from "./owner-kit.ts";

// Whether a person held the address, and so was re-pointed to the owner now. Its
// re-derive reads every stored item as sync's does, the standing check's too, so it walks with every key, as
// an erasure does; it serves none of what it opens.
export async function ownerAddAddress(context: CommandContext): Promise<0> {
  const { values, positionals } = context;
  // One compartment, never a list.
  const [compartment = "own"] = compartments([typeof values.compartment === "string" ? values.compartment : "own"]);
  return withAdmin(
    context,
    async (admin) => {
      printJson(context, await admin.accounts.addOwnerAddress(positionals[0] ?? "", compartment));
    },
    { everyKey: true },
  );
}
