import { dreamFindingsOf } from "../command-args.ts";
import type { CommandContext } from "../command-types.ts";
import { refusal } from "../env.ts";
import { printJson, withAdmin } from "../owner/owner-kit.ts";

// The owner's dreaming commands, as pi_admin: the owner's line for a kind and the owner's gate on the
// checker, the week's sample and the owner's mark on one of it, the owner's lift of an agent's settlement, and the
// trial nights' rows. Ids, codes, counts and times only.

const RATE = /^(0(\.[0-9]{1,4})?|1(\.0{1,4})?)$/;

// `pia dream line KIND (VALUE | --unset) [--marks N]`.
export async function dreamLine(context: CommandContext): Promise<0> {
  const [kind, value] = context.positionals;
  const unset = context.values.unset === true;
  if (kind === undefined || unset === (value !== undefined)) throw refusal("usage");
  if (value !== undefined && !RATE.test(value)) throw refusal("usage");
  const marks = context.values.marks;
  if (marks !== undefined && (typeof marks !== "string" || !/^[1-9][0-9]{0,5}$/.test(marks))) throw refusal("usage");
  return withAdmin(context, async (admin) =>
    printJson(
      context,
      await admin.extraction.setDreamLine(
        kind,
        value === undefined ? null : Number(value),
        marks === undefined ? null : Number(marks),
      ),
    ),
  );
}

export const dreamLines = (context: CommandContext): Promise<0> =>
  withAdmin(context, async (admin) => printJson(context, await admin.extraction.dreamLines()));

export const dreamSample = (context: CommandContext): Promise<0> =>
  withAdmin(context, async (admin) => printJson(context, await admin.extraction.dreamSample()));

// `pia dream mark CHECK (right | wrong) [--new]`.
export async function dreamMark(context: CommandContext): Promise<0> {
  const [check, mark] = context.positionals;
  if (check === undefined || (mark !== "right" && mark !== "wrong")) throw refusal("usage");
  return withAdmin(context, async (admin) =>
    printJson(context, await admin.extraction.markDreamCheck(check, mark, context.values.new === true)),
  );
}

// `pia dream settlements lift ID`.
export async function dreamSettlementLift(context: CommandContext): Promise<0> {
  const [id] = context.positionals;
  if (id === undefined) throw refusal("usage");
  return withAdmin(context, async (admin) => printJson(context, await admin.extraction.liftSettlement(id)));
}

// `pia dream findings [--kind KIND] [--limit N] [--effective]`: the findings themselves, newest first.
export const dreamFindings = (context: CommandContext): Promise<0> =>
  withAdmin(context, async (admin) =>
    printJson(context, await admin.extraction.dreamFindings(dreamFindingsOf(context.values))),
  );

export const dreamNights = (context: CommandContext): Promise<0> =>
  withAdmin(context, async (admin) => printJson(context, await admin.extraction.dreamNights()));

// `pia dream model (check | screen) (ID | --unset)`: the second model that checks every finding, or the
// cheap screen. The checker is never the judge's model: the pass checks nothing with one.
export async function dreamModel(context: CommandContext): Promise<0> {
  const [role, model] = context.positionals;
  const unset = context.values.unset === true;
  if ((role !== "check" && role !== "screen") || unset === (model !== undefined)) throw refusal("usage");
  return withAdmin(context, async (admin) =>
    printJson(context, await admin.extraction.setDreamModel(role, model === undefined ? null : model)),
  );
}

export const dreamTrial = (context: CommandContext): Promise<0> =>
  withAdmin(context, async (admin) => printJson(context, await admin.extraction.dreamTrial()));
