import { EntityId, RulingId } from "@intelligence/contracts/personal";
import { PERSONAL_LIMITS } from "@intelligence/personal-core";
import { deriveItem } from "@intelligence/personal-core/items";
import { createWriter, journalPath, loadKeys } from "@intelligence/personal-store";
import type { CommandContext } from "../command-types.ts";
import { refusal, restrictedKeyFile } from "../env.ts";
import { printJson, requestId, withAdmin } from "./owner-kit.ts";

// The naming commands: the owner's names for people, below, and the
// organization commands. `pi org name ORG NAME` is the owner's name for an
// organization, through the Admin. `pi org refold [--dry-run]` joins, by a re-derive, the
// organizations minted from subdomains before subdomains were folded into their registrable domain,
// through the writer, which alone re-derives: run it as `pi-sync org refold`. Each prints ids,
// counts and code words.

export const orgName = (context: CommandContext): Promise<0> => {
  const organization = EntityId.safeParse(context.positionals[0]);
  const name = context.positionals[1];
  if (!organization.success || name === undefined) throw refusal("usage");
  return withAdmin(context, async (admin) =>
    printJson(context, {
      ruling: await admin.identity.nameOrganization(organization.data, name, {
        requestId: requestId(12),
      }),
    }),
  );
};

// The owner's name for a person, by the same rule: `pia person name
// PERSON NAME`, or `PERSON --clear` to name them by their aliases again; `pia person name lift
// RULING` undoes either, putting back the name it replaced.
export const personName = (context: CommandContext): Promise<0> => {
  const person = EntityId.safeParse(context.positionals[0]);
  const clear = context.values.clear === true;
  const name = context.positionals[1];
  if (!person.success || clear === (name !== undefined)) throw refusal("usage");
  return withAdmin(context, async (admin) =>
    printJson(context, {
      ruling: await admin.identity.namePerson(person.data, clear ? null : (name as string), {
        requestId: requestId(12),
      }),
    }),
  );
};

export const personNameLift = (context: CommandContext): Promise<0> => {
  const ruling = RulingId.safeParse(context.positionals[0]);
  if (!ruling.success) throw refusal("usage");
  return withAdmin(context, async (admin) =>
    printJson(context, {
      ruling: await admin.identity.liftPersonName(ruling.data, { requestId: requestId(12) }),
    }),
  );
};

export async function orgRefold(context: CommandContext): Promise<0> {
  const { env, log, values } = context;
  const keyFile = env.PI_KEY_FILE ?? "";
  const keys = await loadKeys(keyFile, restrictedKeyFile(env));
  const writer = createWriter({ url: env.PI_DATABASE_URL_WRITER ?? "", keys, log, journal: journalPath(keyFile) });
  try {
    // Nothing is derived before the erasures made since a restore are
    // applied.
    if ((await writer.erasureLevel()) === "behind") throw refusal("erasure_replay_needed");
    // Under the sync lock, as sync's own re-derive is: never beside a sync that ingests.
    const done = await writer.withSyncLock(() =>
      writer.refoldOrganizations((raw, ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS), {
        dryRun: values["dry-run"] === true,
      }),
    );
    if (done === "already_running") throw refusal("sync_running");
    if (done.rederived) log.info({ event: "rederived", counts: { items: done.items } });
    // Names kept on their old keys and domain ignores narrowed to their addresses.
    if (done.ignores.coarser + done.names.coarser > 0)
      log.warn({ event: "rekey_coarser", counts: { kept: done.ignores.coarser + done.names.coarser } });
    printJson(context, done);
    return 0;
  } finally {
    await writer.close();
  }
}
