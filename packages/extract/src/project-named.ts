import type { IdentityResolver, LocalEntityId, Timestamp } from "@intelligence/contracts";
import type { ItemProject, OpenedItem, SubjectKind } from "@intelligence/contracts/personal";
import type { Parsed } from "@intelligence/personal-core";
import { codePoints } from "@intelligence/personal-core";
import { ownerSent } from "@intelligence/personal-core/items";
import { ownWords as ownBodyWords } from "@intelligence/personal-core/views";
import type { Prompt } from "@intelligence/personal-models";
import { COMMON_WORDS } from "./common-words.ts";
import { CORRESPONDENCE_PROJECT_VERSIONS } from "./lane-versions.ts";
import { messageData, messageSlot } from "./message.ts";
import { folded, GENERIC, wholePhrase } from "./phrase-words.ts";

// Which of the owner's projects a message is in, decided by code. The owner's anchor of its thread
// wins, whoever wrote. Otherwise only mail the owner sent, by the one test of that (`ownerSent`), is
// read: anyone else's could set a status with no card. In it, the one project whose name, or whose
// uncommon head word, the owner's own words write as a whole phrase; none for two. Quoted and forwarded
// text, a reply's or a forward's subject and attachments are someone else's words and are never read.
// The owner's projects are the only candidates: a message makes none. The model is told the one found
// and proposes which facts are about it. It can only write `project:this`, so nothing it says picks a
// project.

// Words that say what kind of thing a project is, not which: not its head word. Compared folded.
const NOT_A_HEAD = new Set(["build", "company", "course", "phase", "plan", "program", "programme", "startup", "work"]);

// A name's words, split at anything that is no letter or digit.
const nameWords = (name: string): string[] =>
  folded(name)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");

// A name's head word: the last word with a letter that is neither generic nor short. English puts the
// word that says which thing last ("Applied Engineering Rover"), and mail shortens a name to it. None
// when that word is common: "Personal Intelligence" says no more than the word intelligence would, and
// an earlier word is no head of the name.
export function headWord(name: string): string | null {
  for (const word of nameWords(name).toReversed()) {
    if (codePoints(word) >= 4 && /\p{L}/u.test(word) && !GENERIC.has(word) && !NOT_A_HEAD.has(word))
      return COMMON_WORDS.has(word) ? null : word;
  }
  return null;
}

// A whole name counts unless it is short or every word of it is generic.
const usable = (name: string): string | null => {
  const whole = folded(name).trim();
  return codePoints(whole) < 4 || GENERIC.has(whole) || nameWords(name).every((word) => GENERIC.has(word))
    ? null
    : whole;
};

// The whole name beats a head word: a message may use one project's name and another's head word. A
// name inside a longer name also written is no second match: "Alder Kiln" is not also "Kiln".
export function namedIn(projects: readonly ItemProject[], text: string): ItemProject | null {
  const whole = projects.flatMap((one) => {
    const name = usable(one.name);
    return name !== null && wholePhrase(text, name) ? [{ one, name }] : [];
  });
  const longest = whole.filter((a) => !whole.some((b) => b.name !== a.name && wholePhrase(b.name, a.name)));
  if (longest.length > 0) return longest.length === 1 ? (longest[0]?.one as ItemProject) : null;
  const headed = projects.filter((one) => {
    const head = headWord(one.name);
    return head !== null && wholePhrase(text, head);
  });
  return headed.length === 1 ? (headed[0] as ItemProject) : null;
}

// The words the sender wrote for this message: not a quote, a forward or an attachment, and not a
// subject carried over from the message it answers or forwards.
const CARRIED_SUBJECT = /^\s*(?:re|fwd?)\s*:/iu;
const ownWords = ({ span, quoted, text }: Parsed["segments"][number]): boolean =>
  !quoted && !span.startsWith("attachment:") && !(span.startsWith("subject:") && CARRIED_SUBJECT.test(text));

// A project the owner said no to does not stand in another's way. It is found only when no other is,
// so its slot stays and a replay after the no costs nothing, while its mention resolves to nobody.
export function messageProject(opened: OpenedItem, parsed: Parsed): ItemProject | null {
  const projects = opened.projects ?? [];
  const anchored = projects.filter((one) => one.anchored);
  if (anchored.length > 0) return anchored.length === 1 ? (anchored[0] as ItemProject) : null;
  if (!ownerSent(opened.raw)) return null;
  return namedInFolded(
    projects,
    folded(
      parsed.segments
        .filter(ownWords)
        .map((segment) => segment.text)
        .join("\n"),
    ),
  );
}
const namedInFolded = (projects: readonly ItemProject[], text: string): ItemProject | null =>
  namedIn(
    projects.filter((one) => !one.vetoed),
    text,
  ) ??
  namedIn(
    projects.filter((one) => one.vetoed),
    text,
  );

// The same rule over a stored message's subject and body, for a retry choosing what to buy, which holds no parsed item.
export function projectOfWords(
  projects: readonly ItemProject[],
  outbound: boolean,
  subject: string | null,
  body: string | null,
): ItemProject | null {
  const anchored = projects.filter((one) => one.anchored);
  if (anchored.length > 0) return anchored.length === 1 ? (anchored[0] as ItemProject) : null;
  if (!outbound) return null;
  const own = subject === null || CARRIED_SUBJECT.test(subject) ? "" : subject;
  return namedInFolded(projects, folded(`${own}\n${ownBodyWords(body ?? "")}`));
}

const reads = (prompt: Prompt): boolean => CORRESPONDENCE_PROJECT_VERSIONS.includes(prompt.version);

// The version's slot names the project found, whether or not the owner has since said no, so a
// replay after a veto stays free. Every other slot stays as it was, so its saved calls replay. Known
// limit: a project added or closed changes this slot, so a saved call of that item is asked again.
export const messageProjectData = (
  prompt: Prompt,
  parsed: Parsed,
  sentAt: Timestamp,
  project: ItemProject | null,
): Record<string, string> =>
  project === null || !reads(prompt)
    ? messageData(parsed, sentAt)
    : { message: JSON.stringify({ ...messageSlot(parsed, sentAt), project: project.name }) };

// The item as the check reads it: `project:this` also resolves to the project the name rule found, for
// the version told of it, unless the owner said no. An anchor resolves through the store's own port.
export function withMessageProject(opened: OpenedItem, project: ItemProject | null, prompt: Prompt): OpenedItem {
  if (project === null || project.anchored || project.vetoed || !reads(prompt)) return opened;
  return resolvingProject(opened, project.project);
}

// An opened item or moment whose `project:this` is this project.
export function resolvingProject<
  T extends {
    context: { identity: IdentityResolver };
    kindOf(entity: LocalEntityId): SubjectKind | undefined;
  },
>(opened: T, entity: LocalEntityId): T {
  const { identity } = opened.context;
  return {
    ...opened,
    context: {
      ...opened.context,
      identity: {
        ...identity,
        resolve: (mention, ...rest) =>
          mention.key.kind === "source_id" && mention.key.value === "project:this"
            ? Promise.resolve({ outcome: "linked", entity, epoch: 0 })
            : identity.resolve(mention, ...rest),
      },
    },
    kindOf: (one) => (one === entity ? "project" : opened.kindOf(one)),
  };
}
