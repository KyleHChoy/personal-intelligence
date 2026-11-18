import { z } from "zod";
import { AgentRecordId, CaptureId, DocumentId, MessageId } from "./ids.ts";
import type { PersonalReadTool } from "./tools.ts";

// A question to the owner pays up front: the agent says what it searched, what it read and why that did not
// settle it, and code checks the first two against its own call and read logs of the last 24 hours. The words
// (each query and `why`) are the agent's and are kept nowhere.

// The read tools that count as a search.
const QUESTION_SEARCH_TOOLS = Object.freeze([
  "search",
  "find_messages",
  "find_facts",
  "find_documents",
  "find_records",
  "find_paths",
  "get_timeline",
  "build_context_pack",
  "context",
] as const satisfies readonly PersonalReadTool[]);
const QuestionSearchTool = z.enum(QUESTION_SEARCH_TOOLS);

const QUESTION_SEARCHES_MOST = 5;
const QUESTION_SOURCES_MOST = 10;

const codePoints = (text: string): number => [...text].length;
const words = (most: number) =>
  z.string().refine((text) => codePoints(text.trim()) >= 1 && codePoints(text) <= most && !text.includes("\u0000"), {
    message: `1 to ${most} code points`,
  });

export const QuestionTried = z
  .strictObject({
    searches: z
      .array(z.strictObject({ tool: QuestionSearchTool, query: words(200) }))
      .min(1)
      .max(QUESTION_SEARCHES_MOST),
    sources: z
      .array(z.union([MessageId, DocumentId, CaptureId, AgentRecordId]))
      .min(1)
      .max(QUESTION_SOURCES_MOST)
      .refine((ids) => new Set(ids).size === ids.length, { message: "each once" }),
    why: words(300),
  })
  .describe(
    "Needed to ask the owner: what you tried first. searches: 1 to 5 search tool calls you made in the last 24 hours, each {tool, query}; sources: 1 to 10 ids of messages, documents, captures or records you read by id in the last 24 hours; why: one sentence on why they did not settle it.",
  );
export type QuestionTried = z.infer<typeof QuestionTried>;
