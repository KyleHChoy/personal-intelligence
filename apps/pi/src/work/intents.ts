import {
  ClientName,
  GoalId,
  HarnessModeId,
  IntentId,
  OpportunityKind,
  RoleName,
  Stage,
} from "@intelligence/contracts/personal";
import { found, refusal } from "../env.ts";
import { list, parsed, printJson, withAdmin, withNamed } from "../owner/owner-kit.ts";

import { type Body, count } from "./work-args.ts";

// The owner's intents and the harness modes they grant agents, as pi_admin, through withAdmin.

// `intent add`: the owner deciding and five open unless asked otherwise. Prints the id.
export const intentAdd: Body = async (context) => {
  const { values } = context;
  const kinds = list(values.kinds).map((kind) => parsed(OpportunityKind, kind));
  const clients = values.clients === undefined ? [] : list(values.clients).map((name) => parsed(ClientName, name));
  const role = values.role === undefined ? undefined : parsed(RoleName, values.role);
  if (clients.length === 0 && role === undefined) throw refusal("usage");
  const goal = values.goal === undefined ? undefined : parsed(GoalId, values.goal);
  if (values.mode !== undefined && values.mode !== "owner" && values.mode !== "policy") throw refusal("usage");
  const maxOpen = count(values["max-open"]);
  if (maxOpen === 0) throw refusal("usage");
  return withAdmin(context, async (admin) => {
    const intent = await admin.work.addIntent({
      kinds,
      clients,
      ...(goal === undefined ? {} : { goal }),
      mode: values.mode === "policy" ? "policy_decides" : "owner_decides",
      ...(maxOpen === undefined ? {} : { maxOpen }),
      ...(role === undefined ? {} : { role }),
    });
    printJson(context, { intent });
  });
};

// `intent role ID (--set ROLE | --clear)`.
export const intentRole: Body = async (context) => {
  const id = parsed(IntentId, context.positionals[0]);
  const { set, clear } = context.values;
  if ((set === undefined) === (clear !== true)) throw refusal("usage");
  const role = set === undefined ? null : parsed(RoleName, set);
  return withAdmin(context, async (admin) => {
    found(await admin.work.setIntentRole(id, role));
  });
};

export const intentList: Body = (context) =>
  withAdmin(context, async (admin) => {
    printJson(context, await admin.work.listIntents());
  });

export const intentRevoke: Body = async (context) => {
  return withNamed(context, IntentId, async (admin, id) => {
    found(await admin.work.revokeIntent(id));
  });
};

// `harness grant CLIENT --kind K --stage S`: mode act. Prints the id.
export const harnessGrant: Body = async (context) => {
  const client = parsed(ClientName, context.positionals[0]);
  const kind = parsed(OpportunityKind, context.values.kind);
  const stage = parsed(Stage, context.values.stage);
  return withAdmin(context, async (admin) => {
    printJson(context, { harness: await admin.work.grantHarnessMode({ client, kind, stage, mode: "act" }) });
  });
};

export const harnessList: Body = (context) =>
  withAdmin(context, async (admin) => {
    printJson(context, await admin.work.listHarnessModes());
  });

export const harnessRevoke: Body = async (context) => {
  return withNamed(context, HarnessModeId, async (admin, id) => {
    found(await admin.work.revokeHarnessMode(id));
  });
};
