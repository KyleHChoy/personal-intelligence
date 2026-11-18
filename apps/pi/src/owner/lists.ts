import { ListCreateBody, OWNER_LIST_NAME_MOST, OwnerListId } from "@intelligence/contracts/personal";
import type { CommandContext } from "../command-types.ts";
import { found, refusal } from "../env.ts";
import { printJson, requestId, stdinBytes, strictUtf8, withAdmin } from "./owner-kit.ts";

// The owner's lists of people, `pia lists`, as
// pi_admin through the Admin. A list's name is read from stdin, never an argument, so it stays out
// of shell history and the process list; it is printed only by `lists`, to a terminal. Every other
// command prints ids and codes only.

const listOf = (context: CommandContext): OwnerListId => {
  const list = OwnerListId.safeParse(context.positionals[0]);
  if (!list.success) throw refusal("usage");
  return list.data;
};

// The name, read from stdin to its end: one trailing line break is dropped. One line of 1 to 100
// code points (OWNER_LIST_NAME_MOST) of valid UTF-8, or a usage error before any connection. Reading
// stops past the most bytes such a name and its line break can take.
const NAME_MOST_BYTES = OWNER_LIST_NAME_MOST * 4 + 2;
async function nameOf(context: CommandContext): Promise<string> {
  const text = strictUtf8(await stdinBytes(context, NAME_MOST_BYTES));
  const name = text.replace(/\r?\n$/, "");
  if (!ListCreateBody.shape.name.safeParse(name).success) throw refusal("usage");
  return name;
}

// `lists`: every list not deleted, with its name and its members' entity ids.
export const lists = (context: CommandContext): Promise<0> =>
  withAdmin(context, async (admin) => printJson(context, await admin.lists.all()));

// `lists create`: prints `{"list": ID}`.
export async function listsCreate(context: CommandContext): Promise<0> {
  const name = await nameOf(context);
  return withAdmin(context, async (admin) =>
    printJson(context, { list: await admin.lists.createList(name, { requestId: requestId(12) }) }),
  );
}

// `lists rename LIST`: prints `{"ruling": ID}`.
export async function listsRename(context: CommandContext): Promise<0> {
  const list = listOf(context);
  const name = await nameOf(context);
  return withAdmin(context, async (admin) =>
    printJson(context, { ruling: await admin.lists.renameList(list, name, { requestId: requestId(12) }) }),
  );
}

// `lists delete LIST`: prints `{"ruling": ID}`.
export const listsDelete = (context: CommandContext): Promise<0> => {
  const list = listOf(context);
  return withAdmin(context, async (admin) =>
    printJson(context, { ruling: await admin.lists.deleteList(list, { requestId: requestId(12) }) }),
  );
};

// `lists add LIST ID|ADDRESS`: prints `{"ruling": ID}`, or `{"code": "already_settled", "rulings":
// [ID]}` when the person is a member by every fingerprint already (nothing is written).
export const listsAdd = (context: CommandContext): Promise<0> => {
  const list = listOf(context);
  const person = context.positionals[1] ?? "";
  if (person === "") throw refusal("usage");
  return withAdmin(context, async (admin) => {
    try {
      printJson(context, { ruling: await admin.lists.addToList(list, person, { requestId: requestId(12) }) });
    } catch (error) {
      const { code, rulings } = error as { code?: unknown; rulings?: unknown };
      if (code !== "already_settled" || !Array.isArray(rulings)) throw error;
      printJson(context, { code, rulings });
    }
  });
};

// `lists remove LIST ID|ADDRESS`: prints `{"removed": true}`; a person who is no member exits 1
// with `not_found`.
export const listsRemove = (context: CommandContext): Promise<0> => {
  const list = listOf(context);
  const person = context.positionals[1] ?? "";
  if (person === "") throw refusal("usage");
  return withAdmin(context, async (admin) => {
    found(await admin.lists.removeFromList(list, person, { requestId: requestId(12) }));
    printJson(context, { removed: true });
  });
};
