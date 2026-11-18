import {
  type CardDetail,
  type CardLineKey,
  type CardLinePart,
  keyedLine,
  linePart,
} from "@intelligence/contracts/personal";

// Ids never reach the owner raw: research results whose agent-written lines hold ids, as
// the store renders them (`RAW_ID_CARDS`), and the same cards as `pi web` serves them, each id in the owner's
// words and what opens listed as `mentions` (`NAMED_ID_CARDS`; apps/pi/src/web/web-names.ts).
// Code's lines keep their ids: they are the page's own headings and opens. Made-up values only.

const ulid = (n: number): string => `01J${String(n).padStart(23, "0")}`;
const hex = (n: number): string => String(n).padStart(64, "0");
const AT = "2026-10-29T09:00:00.000Z";
type Line = ReturnType<typeof keyedLine> | { text: string; from: "code" | "source" | "model" | "agent" | "owner" };
const { text: t, code: c, id } = linePart;
const k = (key: CardLineKey, ...value: CardLinePart[]): Line => keyedLine("code", key, value);
const source = (text: string): Line => ({ text, from: "source" });
const agent = (text: string): Line => ({ text, from: "agent" });
const AUTHOR = `client:cli_${ulid(815)}`;

const person = `ent_${ulid(801)}`;
const unnamed = `ent_${ulid(802)}`;
const record = `rec_${ulid(803)}`;
const work = `opp_${ulid(804)}`;
const message = `msg_${ulid(805)}`;
const fact = hex(806);
const org = `ent_${ulid(807)}`;

// What `pi web` names each id: what the owner can see by its words, the rest by neutral words.
const ID_WORDS: Readonly<Record<string, string>> = {
  [person]: "Dana Example",
  [unnamed]: "someone",
  [record]: 'the finding "The garden newsletter names Dana Example as chair"',
  [work]: "Find out who runs the community garden",
  [message]: "Garden open day",
  [fact]: "Chair at Example Garden Club",
  [org]: "Example Garden Club",
};
const said = (text: string): string =>
  text.replace(/\b(?:[a-z]{3}_[0-9A-Z]{26}|[0-9a-f]{64})\b/g, (token) => ID_WORDS[token] ?? token);

const outcome = (n: number, target: { kind: string; id: string }, lines: Line[]): CardDetail =>
  ({
    id: `crd_${ulid(820 + n)}`,
    kind: "outcome",
    state: "pending",
    author: AUTHOR,
    createdAt: AT,
    expiresAt: null,
    options: ["acknowledge", "dismiss"],
    target,
    refs: [],
    lines,
  }) as unknown as CardDetail;

export const RAW_ID_CARDS: CardDetail[] = [
  // One summary line holds an entity and a record.
  outcome(1, { kind: "move", id: `mov_${ulid(808)}` }, [
    k("work", c("opportunity"), c("investigate")),
    k("task"),
    k("asked_by", c("agent"), t("agent-one")),
    k("heading", c("asked")),
    agent(`Find out who runs the community garden ${person} mentioned`),
    k("move", c("investigate")),
    k("heading", c("found")),
    agent(`${person} chairs it, per ${record}`),
    k("heading", c("deliverable")),
    agent(`${person} is chair (${fact}); the board meets monthly`),
    k("heading", c("next")),
    agent(`Ask ${person} about the spring plot, citing ${message}`),
    k("heading", c("uncertain")),
    agent(`Whether ${unnamed} still sits on the board`),
    k("source", id("agent_record", record)),
    agent("The garden newsletter names Dana Example as chair"),
    k("source", id("entity", person)),
    source("Dana Example"),
  ]),
  // Another holds a piece of work and an entity.
  outcome(2, { kind: "opportunity", id: work }, [
    k("work", c("opportunity"), c("research")),
    k("asked_by", c("agent"), t("agent-one")),
    k("heading", c("asked")),
    agent(`Follow up on ${work} with ${org}`),
    k("move", c("investigate")),
    k("heading", c("found")),
    agent(`${work} is waiting on ${org}`),
    k("heading", c("next")),
    agent(`Ask ${person} to introduce you to ${org}`),
  ]),
  // An agent's claim with the person it names by id in its fields.
  {
    id: `crd_${ulid(830)}`,
    kind: "agent_claim",
    state: "pending",
    author: AUTHOR,
    createdAt: AT,
    expiresAt: null,
    options: ["confirm", "reject"],
    target: { kind: "claim", id: fact },
    refs: [],
    lines: [
      k("type", c("role")),
      k("subject", c("person"), id("entity", person)),
      source("Dana Example"),
      keyedLine("agent", "field", [c("organization"), t(org)]),
      keyedLine("agent", "field", [c("title"), t("Chair")]),
    ],
  } as unknown as CardDetail,
];

const MENTIONS: Readonly<Record<string, CardDetail["mentions"]>> = {
  [`crd_${ulid(821)}`]: [
    { words: "Dana Example", open: { kind: "person", id: person } },
    { words: ID_WORDS[fact] ?? "", open: { kind: "fact", id: fact } },
    { words: ID_WORDS[message] ?? "", open: { kind: "message", id: message } },
  ],
  [`crd_${ulid(822)}`]: [{ words: "Dana Example", open: { kind: "person", id: person } }],
};

export const NAMED_ID_CARDS: CardDetail[] = RAW_ID_CARDS.map((card) => {
  const lines = card.lines.map((line) =>
    line.from === "code"
      ? line
      : {
          ...line,
          text: said(line.text),
          ...(line.value === undefined
            ? {}
            : { value: line.value.map((one) => (one.kind === "text" ? { ...one, text: said(one.text) } : one)) }),
        },
  );
  const mentions = MENTIONS[card.id];
  return { ...card, lines, ...(mentions === undefined ? {} : { mentions }) };
});
