import { AreaKey, EntityId, PROJECT_NAME_MOST, RoleName } from "@intelligence/contracts/personal";
import type { CommandContext } from "../command-types.ts";
import { refusal } from "../env.ts";
import { parsed, printJson, stdinBytes, strictUtf8, withAdmin } from "./owner-kit.ts";

// The owner's areas, `pia areas` and `pia project area`, as pi_admin through the Admin. An area's
// name is the owner's words: read from stdin, never an argument, so it stays out of shell history
// and the process list, and printed by `areas` alone, to a terminal. Its key is the owner's code
// for it, an argument. Every argument is checked before the key file is read or a connection is
// made.

type Body = (context: CommandContext) => Promise<0 | 1>;

// The name, read from stdin to its end: one trailing line break is dropped. One line of 1 to 200
// code points of valid UTF-8, or a usage error. Reading stops past the most bytes such a name and
// its line break can take.
const NAME_MOST_BYTES = PROJECT_NAME_MOST * 4 + 2;
async function nameOf(context: CommandContext): Promise<string> {
  const text = strictUtf8(await stdinBytes(context, NAME_MOST_BYTES));
  const name = text.replace(/\r?\n$/, "");
  if (
    name.trim() === "" ||
    [...name].length > PROJECT_NAME_MOST ||
    ["\n", "\r", "\u0000"].some((one) => name.includes(one))
  )
    throw refusal("usage");
  return name;
}

// A key, or with `--none` and no key, null. Both or neither is a usage error.
function keyOrNone(context: CommandContext, at: number): string | null {
  const key = context.positionals[at];
  if ((key === undefined) !== (context.values.none === true)) throw refusal("usage");
  return key === undefined ? null : parsed(AreaKey, key);
}

// `areas`: every area in the owner's order, with its name, to a terminal only.
export const areas: Body = (context) =>
  withAdmin(context, async (admin) => printJson(context, await admin.areas.list()));

// `areas add KEY < NAME`.
export const areasAdd: Body = async (context) => {
  const key = parsed(AreaKey, context.positionals[0]);
  const name = await nameOf(context);
  return withAdmin(context, (admin) => admin.areas.add(key, name));
};

// `areas rename KEY < NAME`.
export const areasRename: Body = async (context) => {
  const key = parsed(AreaKey, context.positionals[0]);
  const name = await nameOf(context);
  return withAdmin(context, (admin) => admin.areas.rename(key, name));
};

// `areas order KEY...`: the keys named come first, as named; the rest keep their order after them.
export const areasOrder: Body = (context) => {
  const keys = context.positionals.map((key) => parsed(AreaKey, key));
  if (keys.length === 0 || new Set(keys).size !== keys.length) throw refusal("usage");
  return withAdmin(context, (admin) => admin.areas.order(keys));
};

// `areas retire KEY`.
export const areasRetire: Body = (context) => {
  const key = parsed(AreaKey, context.positionals[0]);
  return withAdmin(context, (admin) => admin.areas.retire(key));
};

// `areas default ROLE KEY | ROLE --none`: the area a project takes when an agent holding the role
// creates it and names none.
export const areasDefault: Body = (context) => {
  const role = parsed(RoleName, context.positionals[0]);
  const key = keyOrNone(context, 1);
  return withAdmin(context, (admin) => admin.areas.setDefault(role, key));
};

// `project area PROJECT KEY | PROJECT --none`: the owner's word on a project's area.
export const projectArea: Body = (context) => {
  const project = parsed(EntityId, context.positionals[0]);
  const key = keyOrNone(context, 1);
  return withAdmin(context, (admin) => admin.areas.setProjectArea(project, key));
};
