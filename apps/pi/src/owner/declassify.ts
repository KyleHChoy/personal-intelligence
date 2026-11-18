import { FactId, RulingId } from "@intelligence/contracts/personal";
import type { CommandContext } from "../command-types.ts";
import { printJson, requestId, withAdmin, withNamed } from "./owner-kit.ts";

// The owner's declassification of one claim and its revocation: `pi declassify add`, `pi declassify
// list` and `pi declassify revoke`, each a thin call into the Admin. An argument that does not
// parse is a usage error, before the key file is read or a connection is made. Each prints ids and
// counts, never content or a client's name.

// `declassify add FACT`: the ruling id.
export async function declassifyAdd(context: CommandContext): Promise<0> {
  return withNamed(context, FactId, async (admin, id) => {
    printJson(context, { ruling: await admin.releases.declassify(id, { requestId: requestId() }) });
  });
}

// `declassify list`: ids, claim ids, types, states and times.
export async function declassifyList(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.releases.listDeclassified());
  });
}

// `declassify revoke RULING`: how many clients may have read the fact.
export async function declassifyRevoke(context: CommandContext): Promise<0> {
  return withNamed(context, RulingId, async (admin, id) => {
    printJson(context, await admin.releases.revokeDeclassified(id, { requestId: requestId() }));
  });
}
