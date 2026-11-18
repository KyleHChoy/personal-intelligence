import {
  defectRoleOf,
  healthJobOf,
  holdOf,
  improvementCloseOf,
  improvementRoleOf,
  leverKeyOf,
  leverSetOf,
  loopsDaysOf,
  outcomesDaysOf,
  redOf,
  supervisedOf,
} from "../command-args.ts";
import type { CommandContext } from "../command-types.ts";
import { print, printJson, withAdmin } from "../owner/owner-kit.ts";

// The box's health: the commands the timer runs as pi with
// admin.env, and the owner's `pia backup taken`. Each prints ids or one word, never a value.

// The run recorded; prints the box health cards it raised, `{ cards: [...] }`.
export async function healthJob(context: CommandContext): Promise<0> {
  const run = healthJobOf(context);
  return withAdmin(context, async (admin) => printJson(context, { cards: await admin.box.recordJob(run) }));
}

// The hold's card; prints `{ card }`, null when one already stood. With `--off`, the hold was
// lifted: its open card is closed, and `{ card }` is the one closed, or null.
export async function healthHold(context: CommandContext): Promise<0> {
  const hold = holdOf(context);
  return withAdmin(context, async (admin) =>
    printJson(context, { card: await admin.box.recordHold(hold, context.values.off === true) }),
  );
}

// A supervised process that keeps ending within a minute of its start.
export async function healthRestarting(context: CommandContext): Promise<0> {
  const name = supervisedOf(context);
  return withAdmin(context, async (admin) => printJson(context, { card: await admin.box.recordRestarting(name) }));
}

// The page not joined to the owner's tailnet for 15 minutes; `--off`, joined again.
export async function healthDashboardDown(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) =>
    printJson(context, { card: await admin.box.recordDashboardDown(context.values.off === true) }),
  );
}

// `due YYYY-MM-DD`, the owner's day whose sweep hour has come, or `not_due`: one line the timer reads.
export async function healthDreamDue(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    const { due, day } = await admin.box.dreamDue();
    print(context, due ? `due ${day}` : "not_due");
  });
}

// How many box health cards wait: the timer's `heartbeat` reads it when the owner turned that on.
export async function healthOpen(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => print(context, String(await admin.box.openHealthCount())));
}

// The key file against its recorded identity, at each start of the box: one word, `recorded`,
// `same`, `added` or `changed`. A changed file is a box health card; no key and no name is printed.
export async function healthKeys(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => print(context, await admin.box.checkKeys()));
}

// `pia keys accept-fingerprint`: the owner changed the key file on purpose; the record becomes the
// keys held now.
export async function keysAcceptFingerprint(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    await admin.box.acceptKeys();
    print(context, "recorded");
  });
}

// `pia backup taken`: the owner's word that they took a dump; the backup reminder counts its days
// from it.
export async function backupTaken(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    await admin.box.backupTaken();
    print(context, "recorded");
  });
}

// `pia backtest record`, the timer's: what `next` and the open items show now, by id. Counts on stdout.
export async function backtestRecord(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => printJson(context, await admin.box.backtestRecord()));
}

// `pia ledger`: the capability ledger, each scheduled job's runs over 14 days and its last run, as
// one JSON document of ids, counts, times and codes. Read-only.
export async function ledger(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => printJson(context, await admin.box.capabilities()));
}

// `pia outcomes`: whether each feature does what it is for and whether it is used, one JSON document
// of ids, counts and codes. It recommends nothing: a low count is a feature not yet tried.
export async function outcomes(context: CommandContext): Promise<0> {
  const days = outcomesDaysOf(context.values);
  return withAdmin(context, async (admin) => printJson(context, await admin.box.outcomes(days)));
}

// `pia loops`: what each autonomous loop produced in the window and the one before, counts only.
export async function loops(context: CommandContext): Promise<0> {
  const days = loopsDaysOf(context.values);
  return withAdmin(context, async (admin) => printJson(context, await admin.box.loops(days)));
}

// `pia improvements`: the improvement store in ids, counts and codes. `--owners`: the open defects
// an agent marked the owner's to change, alone, the one place the owner reads what waits on them.
export async function improvements(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    const view = await admin.box.improvements();
    if (context.values.owners !== true) return printJson(context, view);
    printJson(context, {
      at: view.at,
      defectRole: view.defectRole,
      ownersToChange: view.ownersToChange,
      defects: view.defects.filter((one) => one.ownersToChange),
    });
  });
}

// `pia improvements default-role ROLE|--none`: the role defects go to. Unset, no agent is assigned
// any, and no defect raises a task.
export async function improvementsDefaultRole(context: CommandContext): Promise<0> {
  const role = defectRoleOf(context);
  return withAdmin(context, async (admin) => {
    await admin.box.setDefectRole(role);
    print(context, role === null ? "unset" : "set");
  });
}

// `pia improvements file`: one filing pass; the timer runs it daily when the service turns it on.
export async function improvementsFile(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => printJson(context, await admin.box.fileImprovements()));
}

// `pia improvements close IMPROVEMENT --as wont_do|duplicate [--of IMPROVEMENT]`: the owner's
// dismissal. A defect the system filed closes no other way but by its measure.
export async function improvementsClose(context: CommandContext): Promise<0> {
  const { improvement, status, duplicateOf } = improvementCloseOf(context);
  return withAdmin(context, async (admin) => {
    await admin.box.closeImprovement(improvement, status, duplicateOf);
    print(context, "closed");
  });
}

// `pia improvements role IMPROVEMENT ROLE|--none`: the role whose agents work a defect.
export async function improvementsRole(context: CommandContext): Promise<0> {
  const { improvement, role } = improvementRoleOf(context);
  return withAdmin(context, async (admin) => {
    await admin.box.setImprovementRole(improvement, role);
    print(context, "set");
  });
}

// `pia levers`: every registered lever, with its range, its value now, who may move it, the
// measure that judges it and its last change. Numbers and codes only.
export async function levers(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => printJson(context, await admin.box.levers()));
}

// `pia levers set KEY VALUE`: the owner's change to any registered lever, inside its range.
export async function leversSet(context: CommandContext): Promise<0> {
  const { key, value } = leverSetOf(context);
  return withAdmin(context, async (admin) => printJson(context, await admin.box.setLever(key, value)));
}

// `pia levers undo KEY`: back to the value before the lever's last change.
export async function leversUndo(context: CommandContext): Promise<0> {
  const key = leverKeyOf(context);
  return withAdmin(context, async (admin) => printJson(context, await admin.box.undoLever(key)));
}

// `pia improvements nightly --red N`: how many test files last night's run found failing. A count.
export async function improvementsNightly(context: CommandContext): Promise<0> {
  const red = redOf(context.values);
  return withAdmin(context, async (admin) => {
    await admin.box.recordNightly(red);
    print(context, "recorded");
  });
}
