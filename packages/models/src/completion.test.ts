import { InterpreterOutput } from "@intelligence/contracts";
import { describe, expect, it } from "vitest";
import { type Prompt, promptTextHash, renderPrompt } from "./client/prompts.ts";
import { messagesOf } from "./completion.ts";

const bare = {
  id: "test_prompt",
  version: "1",
  instructions: "You read the slot.\n\nThen you answer.",
  slots: ["message"],
  outputSchemaId: "InterpreterOutput",
  outputSchema: InterpreterOutput,
  tools: "none",
} as const;
const PROMPT: Prompt = { ...bare, textHash: promptTextHash(bare) } as Prompt;

describe("messagesOf", () => {
  it("cuts what the shared render gives into the instructions and the data, and the two joined are the text hashed", () => {
    const { text } = renderPrompt(PROMPT, { message: "a < b" }, [PROMPT]);
    const { system, user } = messagesOf(PROMPT, text);
    expect(system).toBe(PROMPT.instructions);
    expect(user).toBe('<data slot="message">\na &lt; b\n</data>');
    expect(`${system}\n\n${user}`).toBe(text);
  });

  it("refuses a text of any other layout rather than split it wrong", () => {
    expect(() => messagesOf(PROMPT, `${PROMPT.instructions}\n<data>`)).toThrow("bad_request");
    expect(() => messagesOf(PROMPT, "other words")).toThrow("bad_request");
  });
});
