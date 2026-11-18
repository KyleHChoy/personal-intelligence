import type { FactView } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { GOAL_SOURCE_WORDS } from "./enum-words.ts";
import { factFromWords } from "./facts.ts";

const fact = (over: Partial<FactView>): FactView =>
  ({
    tier: "owner",
    provenance: "source",
    agentReported: false,
    capture: "cap_x",
    document: null,
    page: null,
    ...over,
  }) as FactView;

describe("the own-lines mark", () => {
  it("reads as a chat with an agent, and only with its mark", () => {
    expect(factFromWords(fact({ sourceMark: "agent_chat" }))).toBe("From your chats with agents");
    expect(factFromWords(fact({}))).toBe("You said");
    expect(GOAL_SOURCE_WORDS.agent_chat).toBe("From your chats with agents");
  });
});
