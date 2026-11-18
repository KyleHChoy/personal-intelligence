import {
  type AdoptChange,
  EntityId,
  FactKeyFp,
  GoalId,
  GoalKey,
  GoalState,
  LIFE_DOMAINS,
  LifeDomain,
  PersonalCompartment,
} from "@intelligence/contracts/personal";
import { GOAL_STATUSES, type GoalStatus } from "@intelligence/personal-store";
import type { CommandContext } from "../command-types.ts";
import { found, refusal } from "../env.ts";
import { parsed, print, printJson, requestId, withAdmin, withNamed } from "../owner/owner-kit.ts";

import { type Body, statementOf } from "./work-args.ts";

// The owner's goals, as pi_admin, through withAdmin.

// `goal add --domain D [--compartment C]`: the statement from stdin, never an argument. Prints the
// id. `--domain`, one life domain, is required. It keys the goal as the owner's mail's goal on the same
// objective is keyed (a version 4 goal always carries a domain), so the two are one belief; without
// it the command is a usage error naming the domains, before any connection.
const GOAL_ADD_USAGE = `pi goal add --domain ${LIFE_DOMAINS.join("|")} [--compartment C]`;
export const goalAdd: Body = async (context) => {
  const domain = LifeDomain.safeParse(context.values.domain);
  if (!domain.success) throw refusal("usage", GOAL_ADD_USAGE);
  const compartment =
    context.values.compartment === undefined ? "own" : parsed(PersonalCompartment, context.values.compartment);
  const statement = await statementOf(context);
  return withAdmin(context, async (admin) => {
    print(context, await admin.work.addGoal(statement, compartment, { requestId: requestId(), domain: domain.data }));
  });
};

// `goals backfill`: every stored goal's owner_command item, claim and mapping row. Prints counts
// and goal ids only, then how many goals have no life domain, which keys them by their words alone,
// and how one is restated with one.
export const goalsBackfill: Body = (context) =>
  withAdmin(context, async (admin) => {
    const report = await admin.work.backfillGoals();
    printJson(context, report);
    if (report.withoutDomain > 0)
      print(context, `${report.withoutDomain} goals have no life domain; pi goal add --domain D restates one`);
  });

// `goal list`: statements, to a terminal only (commands.ts refuses any other stdout).
export const goalList: Body = (context) =>
  withAdmin(context, async (admin) => {
    printJson(context, await admin.work.listGoals());
  });

export const goalSet: Body = async (context) => {
  const goal = parsed(GoalId, context.positionals[0]);
  const status = context.values.status;
  if (typeof status !== "string" || !GOAL_STATUSES.includes(status as GoalStatus)) throw refusal("usage");
  return withAdmin(context, async (admin) => {
    found(await admin.work.setGoalStatus(goal, status as GoalStatus, { requestId: requestId() }));
  });
};

// `goal edit ID < WORDS`: the goal in the owner's new words, from stdin, never an argument.
export const goalEdit: Body = async (context) => {
  const goal = parsed(GoalId, context.positionals[0]);
  const statement = await statementOf(context);
  return withAdmin(context, async (admin) => {
    found(await admin.work.editGoal(goal, statement, { requestId: requestId() }));
  });
};

// `goal rank ID --after ID | --first`: the owner's goal placed right after another of theirs in its life
// domain, or first in it.
export const goalRank: Body = async (context) => {
  const goal = parsed(GoalId, context.positionals[0]);
  const { values } = context;
  if ((values.after === undefined) === (values.first !== true)) throw refusal("usage");
  // After any goal of the domain, the owner's by its id or one from a source by its key.
  const after = values.after === undefined ? null : parsed(GoalKey, values.after);
  if (after === goal) throw refusal("usage");
  return withAdmin(context, async (admin) => {
    found(await admin.work.rankGoal(goal, after, { requestId: requestId() }));
  });
};

// `goal adopt FACT` and one change: `--words` (the owner's words, from stdin), `--status S`,
// `--entity ENTITY`, or `--after ID | --first`. Prints the id of the goal it makes the owner's.
export const goalAdopt: Body = async (context) => {
  const fact = parsed(FactKeyFp, context.positionals[0]);
  const { values } = context;
  const given = [
    values.words === true,
    values.status !== undefined,
    values.entity !== undefined,
    values.after !== undefined || values.first === true,
  ];
  if (given.filter(Boolean).length !== 1 || (values.after !== undefined && values.first === true))
    throw refusal("usage");
  const change: AdoptChange =
    values.words === true
      ? { statement: await statementOf(context) }
      : values.status !== undefined
        ? { status: parsed(GoalState, values.status) }
        : values.entity !== undefined
          ? { entity: parsed(EntityId, values.entity) }
          : { after: values.after === undefined ? null : parsed(GoalKey, values.after) };
  return withAdmin(context, async (admin) => {
    const goal = found(await admin.work.adoptGoal(fact, change, { requestId: requestId() }));
    print(context, goal);
  });
};

export const goalUnadopt: Body = async (context) => {
  return withNamed(context, GoalId, async (admin, goal) => {
    found(await admin.work.unadoptGoal(goal, { requestId: requestId() }));
  });
};

export const goalHide: Body = async (context) => {
  return withNamed(context, FactKeyFp, async (admin, fact) => {
    found(await admin.work.hideGoal(fact, { requestId: requestId() }));
  });
};

export const goalUnhide: Body = async (context) => {
  return withNamed(context, FactKeyFp, async (admin, fact) => {
    found(await admin.work.unhideGoal(fact, { requestId: requestId() }));
  });
};

// Without `--entity`, the people holding it under the goal's label are printed, one JSON line each (ids
// only), for the owner to pick with `--entity`; with none, the target waits on the name, which the next
// `pi sync` binds or makes a named person of, and `pending` is printed. A person's name of one word is
// refused (`one_word_name`) before any connection.
function goalNameOf(
  values: CommandContext["values"],
): { name: string; organization: boolean; entity?: EntityId } | null {
  const organization = values.org === true;
  if (values.name === undefined) {
    if (organization) throw refusal("usage");
    return null;
  }
  if (typeof values.name !== "string" || values.none === true) throw refusal("usage");
  const name = values.name.trim();
  if (name === "" || [...name].length > 200) throw refusal("usage");
  if (!organization && !/\s/u.test(name)) throw refusal("one_word_name");
  return { name, organization, ...(values.entity === undefined ? {} : { entity: parsed(EntityId, values.entity) }) };
}

export const goalTarget: Body = async (context) => {
  const goal = parsed(GoalId, context.positionals[0]);
  const { values } = context;
  const named = goalNameOf(values);
  if (named !== null) {
    return withAdmin(context, async (admin) => {
      const answer = found(
        await admin.work.targetGoalByName(goal, named.name, {
          requestId: requestId(),
          organization: named.organization,
          ...(named.entity === undefined ? {} : { entity: named.entity }),
        }),
      );
      if (answer.kind === "holders") for (const holder of answer.holders) printJson(context, holder);
      else if (answer.kind === "pending") print(context, "pending");
    });
  }
  if ((values.entity === undefined) === (values.none !== true)) throw refusal("usage");
  const entity = values.entity === undefined ? null : parsed(EntityId, values.entity);
  return withAdmin(context, async (admin) => {
    found(await admin.work.setGoalTarget(goal, entity, { requestId: requestId() }));
  });
};
