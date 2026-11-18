import type { ClientName } from "@intelligence/contracts/personal";
import type { CommandContext } from "../command-types.ts";
import { printJson, withAdmin } from "../owner/owner-kit.ts";

// Each prints one JSON document of ids, names, counts, times and states, and never an entry's line.
// The arguments were checked before any connection.

const clientOf = (context: CommandContext): ClientName | undefined =>
  typeof context.values.client === "string" ? (context.values.client as ClientName) : undefined;

export const memoryStatus = (context: CommandContext): Promise<0> =>
  withAdmin(context, async (admin) => printJson(context, await admin.agents.memoryStatus(clientOf(context))));

export const memoryExposures = (context: CommandContext): Promise<0> => {
  const client = clientOf(context);
  const limit = typeof context.values.limit === "string" ? Number(context.values.limit) : undefined;
  return withAdmin(context, async (admin) =>
    printJson(
      context,
      await admin.agents.memoryExposures({
        ...(client === undefined ? {} : { client }),
        ...(limit === undefined ? {} : { limit }),
      }),
    ),
  );
};

export const memoryImports = (context: CommandContext): Promise<0> =>
  withAdmin(context, async (admin) => printJson(context, await admin.agents.memoryImports(clientOf(context))));

// Every memory change of one client removed; prints the count. Exits 1 with not_found for a name
// that is no client.
export const memoryPurge = (context: CommandContext): Promise<0> =>
  withAdmin(context, async (admin) => printJson(context, await admin.agents.purgeMemory(context.positionals[0] ?? "")));
