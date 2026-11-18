import { AboutYouKind, type CardLine, grantCommand, LINE_PARTS } from "@intelligence/contracts/personal";
import { agentName } from "./agent-words.ts";
import { cardKindRow } from "./card-kinds.ts";
import { countAt, wordsAt } from "./card-lines.ts";
import { type CardShape, shapeOfCode } from "./card-shape.ts";
import { GRANT_KIND_WORDS } from "./enum-words.ts";

// The two cards a confirm rate raises (the store's admin-confirm-rates.ts): one proposing a standing
// release for an agent and a kind of fact, one proposing its lift. Each asks one plain question from
// the store's code lines, read by their keys and parts (its agent, the kind and its counts), and shows
// the terminal command that does what it proposes: answering never grants or lifts anything, as fact
// releases stay out of the browser.

export function learnShape(kind: string, lines: readonly CardLine[]): CardShape {
  // A key's line, the last where it is written twice.
  const keyed = (key: string): CardLine | undefined =>
    lines.filter((line) => line.from === "code" && line.key === key).at(-1);
  const word = (key: string): string | null => {
    const line = keyed(key);
    return line === undefined ? null : wordsAt(line);
  };
  const count = (key: string, at: number): number | null => {
    const line = keyed(key);
    return line === undefined ? null : countAt(line, at);
  };
  const granting = keyed("grant_command");
  const at = LINE_PARTS.grant_command;
  const command =
    granting?.value === undefined
      ? null
      : grantCommand(
          wordsAt(granting, at.which) ?? "",
          wordsAt(granting, at.agent) ?? "",
          wordsAt(granting, at.kind) ?? "",
        );
  const grant = kind === "grant_suggestion";
  const agent = agentName(word("client") ?? "your agent");
  const factKind = AboutYouKind.safeParse(word("fact_kind"));
  const about = factKind.success ? GRANT_KIND_WORDS[factKind.data] : "you";
  const [confirmed, answers] = [
    count("confirmed", LINE_PARTS.confirmed.confirmed),
    count("confirmed", LINE_PARTS.confirmed.answers),
  ];
  const right =
    confirmed === null || answers === null ? "" : ` ${grant ? "" : "only "}${confirmed} of the last ${answers} times`;
  // A lift proposed for what the owner marked not true among the facts the grant kept says so.
  const notTrue =
    keyed("not_true") === undefined
      ? null
      : [count("not_true", LINE_PARTS.not_true.marked), count("not_true", LINE_PARTS.not_true.kept)];
  const question = grant
    ? `${agent} was right about ${about}${right}. Keep what it quotes you saying without asking you?`
    : notTrue !== null
      ? `You marked ${notTrue[0]} of the ${notTrue[1]} facts kept from ${agent} about ${about} not true. Ask you again about each?`
      : `${agent} was right about ${about}${right}. Ask you again about each?`;
  return shapeOfCode({
    question,
    replies: cardKindRow(kind)?.replies ?? {},
    commandWhy: grant
      ? "To keep them without asking, in the terminal:"
      : "To ask you again, in the terminal, ending the standing permission:",
    title: question,
    sub: "A suggestion from your own answers",
    rows: [
      { k: "Agent", v: agent },
      { k: "About", v: about },
    ],
    notes: [
      "Your answer only tells the system whether to suggest this again soon. Run the command yourself if you want it; you can turn suggestions off for this agent in Settings, under Learning.",
    ],
    command,
  });
}
