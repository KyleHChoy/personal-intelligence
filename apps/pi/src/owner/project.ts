import {
  CaptureId,
  EntityId,
  MessageId,
  PersonalCompartment,
  TITLE_PREFIXES_MOST,
  ULID_PATTERN,
} from "@intelligence/contracts/personal";
import { deviceAnchorKey, titleTooDeep } from "@intelligence/personal-core/lens";
import type { CommandContext } from "../command-types.ts";
import { found, refusal } from "../env.ts";
import { parsed, print, requestId, stdinBytes, withAdmin, withNamed } from "./owner-kit.ts";

// The owner's project commands, as pi_admin:
// each a thin call into the store's admin.projects, through withAdmin. Every argument is checked
// before the key file is read or a connection is made. No merge or undo: neither is
// built; a series anchor is --series-of.

type Body = (context: CommandContext) => Promise<0 | 1>;

const NAME_MOST = 200;
// The most bytes `--title` reads, ample for TITLE_ANCHOR_MOST code
// points with the whitespace the normal form collapses; past it the title is bad_anchor at once.
const TITLE_STDIN_MOST = 4096;
// Why a long title is refused, and what to anchor instead.
const TOO_DEEP = `a window title is matched at its first ${TITLE_PREFIXES_MOST} word ends at most: anchor the title's first words`;
const ANCHOR = new RegExp(`^pan_${ULID_PATTERN}$`);

// Stdin read to its end, one trailing line break dropped; past `most` bytes, refused with `code`.
const stdinText = async (context: CommandContext, most: number, code: string): Promise<string> =>
  (await stdinBytes(context, most, code)).toString("utf8").replace(/\r?\n$/, "");

// The name, read from stdin. Never an argument.
async function nameOf(context: CommandContext): Promise<string> {
  const name = await stdinText(context, NAME_MOST * 4 + 2, "usage");
  if (name.trim() === "" || [...name].length > NAME_MOST) throw refusal("usage");
  return name;
}

// `project add [--compartment C]`: prints the project's id.
export const projectAdd: Body = async (context) => {
  const compartment =
    context.values.compartment === undefined ? "own" : parsed(PersonalCompartment, context.values.compartment);
  const name = await nameOf(context);
  return withAdmin(context, async (admin) => {
    print(context, await admin.projects.add(name, { compartment, requestId: requestId() }));
  });
};

// The device kinds' flags: each value as the owner gives it,
// checked here by core's normal forms before any connection, and again in the store.
const DEVICE_FLAGS = { app: "app", host: "host", url: "url_prefix", repo: "repository", document: "document" } as const;

// `--document ~/PATH` unquoted reaches pi as the shell expanded it: an absolute path under a home
// directory, which would be stored as itself and never meet an item's `~/` path.
// Refused, with the quoting to use.
const QUOTE_DOCUMENT = "quote the path so the shell leaves ~ alone: --document '~/PATH'";
function expandedHome(path: string, home: string | undefined): boolean {
  const under = (root: string): boolean => path === root || path.startsWith(`${root}/`);
  return (
    /^\/(Users|home)\/[^/]+(\/|$)/.test(path) ||
    (home !== undefined && home !== "" && home !== "/" && under(home.replace(/\/+$/, "")))
  );
}

// `project anchor PROJECT (--thread MESSAGE | --app BUNDLE | --host HOST | --url PREFIX | --repo
// REPOSITORY | --document '~/PATH' | --series-of CAPTURE | --title)`, exactly one: prints the
// anchor's id. `--title` takes no value; the window title is read from stdin, as a
// project's name is, since a title may be sensitive: never an argument, never printed.
export const projectAnchor: Body = async (context) => {
  const project = parsed(EntityId, context.positionals[0]);
  const given = ["thread", "series-of", "title", ...Object.keys(DEVICE_FLAGS)].filter(
    (flag) => context.values[flag] !== undefined && context.values[flag] !== false,
  );
  const [flag] = given;
  if (flag === undefined || given.length > 1) throw refusal("usage");
  if (flag === "title") {
    const title = await stdinText(context, TITLE_STDIN_MOST, "bad_anchor");
    const answer = deviceAnchorKey("window_title", title);
    if ("refused" in answer)
      throw refusal(answer.refused, answer.refused === "bad_anchor" && titleTooDeep(title) ? TOO_DEEP : undefined);
    return withAdmin(context, async (admin) => {
      print(
        context,
        await admin.projects.anchor(project, { kind: "window_title", value: title }, { requestId: requestId() }),
      );
    });
  }
  const value = context.values[flag];
  if (typeof value !== "string") throw refusal("usage");
  let target:
    | MessageId
    | { seriesOf: CaptureId }
    | { kind: (typeof DEVICE_FLAGS)[keyof typeof DEVICE_FLAGS]; value: string };
  if (flag === "thread") target = parsed(MessageId, value);
  else if (flag === "series-of") target = { seriesOf: parsed(CaptureId, value) };
  else {
    if (flag === "document" && expandedHome(value, context.env.HOME)) throw refusal("usage", QUOTE_DOCUMENT);
    const kind = DEVICE_FLAGS[flag as keyof typeof DEVICE_FLAGS];
    const answer = deviceAnchorKey(kind, value);
    if ("refused" in answer) throw refusal(answer.refused);
    target = { kind, value };
  }
  return withAdmin(context, async (admin) => {
    print(context, await admin.projects.anchor(project, target, { requestId: requestId() }));
  });
};

export const projectUnanchor: Body = async (context) => {
  const anchor = context.positionals[0];
  if (anchor === undefined || !ANCHOR.test(anchor)) throw refusal("usage");
  return withAdmin(context, async (admin) => {
    found(await admin.projects.unanchor(anchor, { requestId: requestId() }));
  });
};

export const projectClose: Body = async (context) => {
  return withNamed(context, EntityId, async (admin, project) => {
    found(await admin.projects.close(project, { requestId: requestId() }));
  });
};

// `project list`: names, to a terminal only (commands.ts refuses any other stdout). A window title
// anchor lists with its value null: its title is not stored.
export const projectList: Body = (context) =>
  withAdmin(context, async (admin) => {
    print(context, JSON.stringify(await admin.projects.list()));
  });
