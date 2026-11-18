import { EntityId, GoalId } from "@intelligence/contracts/personal";
import type { WorkAnchor } from "@intelligence/personal-store";
import type { CommandContext } from "../command-types.ts";
import { refusal } from "../env.ts";
import { parsed } from "../owner/owner-kit.ts";

// What the owner commands of durable work share: their body type, and the readers of their
// arguments and of the owner's words on stdin, each checked before any connection.

export type Body = (context: CommandContext) => Promise<0 | 1>;
export type Value = CommandContext["values"][string];

const STATEMENT_MOST = 1000;
export const LESSON_MOST = 600;

// A whole number of at most nine digits, or undefined when the option is absent.
export function count(value: Value): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{1,9}$/.test(value)) throw refusal("usage");
  return Number(value);
}

// `--goal ID | --entity ID`: at most one.
export function anchorOf(values: CommandContext["values"]): WorkAnchor {
  if (values.goal !== undefined && values.entity !== undefined) throw refusal("usage");
  if (values.goal !== undefined) return { goal: parsed(GoalId, values.goal) };
  if (values.entity !== undefined) return { entity: parsed(EntityId, values.entity) };
  return {};
}

// The statement, read from stdin to its end: one trailing line break is dropped.
export async function textOf({ io }: CommandContext, most: number): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of io.stdin)
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer));
  const text = Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
  if (text.trim() === "" || [...text].length > most) throw refusal("usage");
  return text;
}

export const statementOf = (context: CommandContext): Promise<string> => textOf(context, STATEMENT_MOST);
