import { RetentionClass, SourceAccountId } from "@intelligence/contracts/personal";
import type { CommandContext } from "../command-types.ts";
import { refusal } from "../env.ts";
import { printJson, requestId, withAdmin } from "./owner-kit.ts";

// Built for Lens's three capture classes; any other class is refused `not_supported`. Ids, classes,
// days and counts only.

// `pi retain set CLASS (--days N | --keep) [--account ACC]`: prints the rule's id.
export const retainSet = (context: CommandContext): Promise<0> => {
  const { values, positionals } = context;
  const parsed = RetentionClass.safeParse(positionals[0]);
  const days = values.days;
  const keep = values.keep === true;
  if (!parsed.success || (days === undefined) === !keep) throw refusal("usage");
  if (days !== undefined && !(typeof days === "string" && /^[1-9]\d{0,4}$/.test(days))) throw refusal("usage");
  const account = values.account;
  if (account !== undefined && !SourceAccountId.safeParse(account).success) throw refusal("usage");
  return withAdmin(context, async (admin) => {
    const id = await admin.retention.setRetention(
      {
        class: parsed.data,
        days: keep ? null : Number(days),
        account: account === undefined ? null : SourceAccountId.parse(account),
      },
      { requestId: requestId(12) },
    );
    context.io.stdout.write(`${id}\n`);
  });
};

// `pi retain adopt`: RETENTION_DEFAULTS as rules; prints their ids.
export const retainAdopt = (context: CommandContext): Promise<0> =>
  withAdmin(context, async (admin) => {
    printJson(context, await admin.retention.adoptRetention({ requestId: requestId(12) }));
  });

export const retainList = (context: CommandContext): Promise<0> =>
  withAdmin(context, async (admin) => {
    printJson(context, await admin.retention.listRetention());
  });

export const retainPlan = (context: CommandContext): Promise<0> =>
  withAdmin(context, async (admin) => {
    printJson(context, await admin.retention.plan());
  });

export const retainRun = (context: CommandContext): Promise<0> =>
  withAdmin(context, async (admin) => {
    printJson(context, await admin.retention.runRetention());
  });
