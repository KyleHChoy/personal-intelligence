import {
  CorrectValueBody,
  EntityId,
  FactId,
  OWNER_WORDS_MOST,
  type OwnerNoteRole,
  PersonalCompartment,
} from "@intelligence/contracts/personal";
import type { CommandContext } from "../command-types.ts";
import { refusal } from "../env.ts";
import { print, requestId, stdinBytes, withAdmin, withNamed } from "./owner-kit.ts";

// The owner's notes and bios about a person, as
// pi_admin through withAdmin. The owner's words come from stdin, never an argument, and are printed only by
// `note list`, to a terminal. Every argument is checked before the key file is read.

function parsed<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw refusal("usage");
  return result.data;
}

// The owner's words, read from stdin to its end: one trailing line break is dropped.
async function wordsOf(context: CommandContext): Promise<string> {
  const text = (await stdinBytes(context)).toString("utf8").replace(/\r?\n$/, "");
  if (text.trim() === "" || [...text].length > OWNER_WORDS_MOST) throw refusal("usage");
  return text;
}

const roleOf = (context: CommandContext): OwnerNoteRole => (context.values.bio === true ? "bio" : "note");
// An edit keeps the role of the note it replaces unless `--bio` or `--note` names one.
const editRoleOf = (context: CommandContext, replaced: OwnerNoteRole | undefined): OwnerNoteRole => {
  if (context.values.bio === true && context.values.note === true) throw refusal("usage");
  if (context.values.bio === true) return "bio";
  if (context.values.note === true) return "note";
  if (replaced === undefined) throw refusal("not_found");
  return replaced;
};
const compartmentOf = (context: CommandContext): PersonalCompartment | undefined =>
  context.values.compartment === undefined ? undefined : parsed(PersonalCompartment, context.values.compartment);

// `note add PERSON [--bio] [--compartment C] < WORDS`: prints the note's id.
export const noteAdd = async (context: CommandContext): Promise<0> => {
  const person = parsed(EntityId, context.positionals[0]);
  const compartment = compartmentOf(context);
  const text = await wordsOf(context);
  return withAdmin(context, async (admin) => {
    print(
      context,
      await admin.notes.addNote(
        { person, role: roleOf(context), text, ...(compartment === undefined ? {} : { compartment }) },
        { requestId: requestId() },
      ),
    );
  });
};

// `note edit PERSON NOTE [--bio | --note] [--compartment C] < WORDS`: a new note, and the retire of
// the one it replaces, in one transaction, in that one's role unless a flag names another. Prints
// the new note's id.
export const noteEdit = async (context: CommandContext): Promise<0> => {
  const person = parsed(EntityId, context.positionals[0]);
  const replaces = parsed(FactId, context.positionals[1]);
  const compartment = compartmentOf(context);
  const text = await wordsOf(context);
  return withAdmin(context, async (admin) => {
    const replaced = (await admin.notes.listNotes(person)).find((one) => one.note === replaces)?.role;
    print(
      context,
      await admin.notes.addNote(
        {
          person,
          role: editRoleOf(context, replaced),
          text,
          replaces,
          ...(compartment === undefined ? {} : { compartment }),
        },
        { requestId: requestId() },
      ),
    );
  });
};

// `note retire NOTE`: prints the ruling's id, which `correct lift` lifts.
export const noteRetire = (context: CommandContext): Promise<0> => {
  const note = parsed(FactId, context.positionals[0]);
  return withAdmin(context, async (admin) =>
    print(context, await admin.notes.retireNote(note, { requestId: requestId() })),
  );
};

// `correct value FACT FIELD [NAME=VALUE ...] < VALUE`: the wrong claim's
// reject and the owner's claim with the true value, the owner's value from stdin; a status's other
// fields, which its correction names too, as NAME=VALUE. Prints the reject's ruling, which
// `correct lift` lifts with the owner's claim.
export const correctValue = async (context: CommandContext): Promise<0> => {
  const fact = parsed(FactId, context.positionals[0]);
  const [, field, ...more] = context.positionals;
  if (field === undefined || more.some((one) => !/^[a-zA-Z]\w*=./.test(one))) throw refusal("usage");
  const others = Object.fromEntries(
    more.map((one) => [one.slice(0, one.indexOf("=")), one.slice(one.indexOf("=") + 1)]),
  );
  const value = parsed(CorrectValueBody.shape.value, { ...others, [field]: await wordsOf(context) });
  return withAdmin(context, async (admin) =>
    print(context, await admin.notes.correctValue(fact, value, { requestId: requestId() })),
  );
};

// `note list PERSON`, to a terminal only: the notes in force, bios first, one JSON line each.
export const noteList = (context: CommandContext): Promise<0> => {
  return withNamed(context, EntityId, async (admin, person) => {
    for (const note of await admin.notes.listNotes(person)) print(context, JSON.stringify(note));
  });
};
