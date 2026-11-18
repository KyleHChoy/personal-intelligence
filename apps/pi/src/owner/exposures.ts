import { ErasureId } from "@intelligence/contracts/personal";
import type { Admin } from "@intelligence/personal-store";
import type { CommandContext } from "../command-types.ts";
import { printJson, withAdmin, withNamed } from "./owner-kit.ts";

// Each prints one JSON document of ids, routes, days and counts; on a terminal, and only there,
// each client recipient also carries its name.

type Named = { kind: "model" | "client"; id: string };

// The recipients, with each client's name when the output is a terminal.
async function named<T extends Named>(
  context: CommandContext,
  admin: Admin,
  recipients: T[],
): Promise<(T & { name?: string })[]> {
  if (!context.io.stdoutIsTTY) return recipients;
  const names = new Map(
    (await admin.clients.listClients()).map((client) => [client.id as string, client.name as string]),
  );
  return recipients.map((one) => {
    const name = one.kind === "client" ? names.get(one.id) : undefined;
    return name === undefined ? one : { ...one, name };
  });
}

export const eraseExposures = (context: CommandContext): Promise<0> => {
  return withNamed(context, ErasureId, async (admin, id) => {
    const view = await admin.erasure.listExposures(id);
    printJson(context, { ...view, recipients: await named(context, admin, view.recipients) });
  });
};

export const exposuresStatus = (context: CommandContext): Promise<0> =>
  withAdmin(context, async (admin) => {
    const view = await admin.erasure.exposureStatus();
    printJson(context, { ...view, recipients: await named(context, admin, view.recipients) });
  });
