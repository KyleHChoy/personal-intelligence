import { describe, expect, it } from "vitest";
import { cardHead, cardShape } from "./cards.ts";
import { lastSeen } from "./rooms/settings.tsx";
import { RAW_CARDS } from "./test-support/raw-cards.ts";
import { sameWords } from "./words.ts";
import { stepHow, stepWords } from "./work-parts.tsx";

// What a pure function holds, checked without rendering.
const raw = (kind: string) => {
  const found = RAW_CARDS.find((one) => one.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} card`);
  return found;
};
const step = (kind: string, tool: string | null = null, status: string | null = null, code: string | null = null) => ({
  attempt: 1,
  ordinal: 1,
  kind,
  tool,
  status,
  code,
  cost_microusd: null,
  input_tokens: null,
  output_tokens: null,
  ms: null,
  result_code_points: null,
});

describe("the words of cards, run steps and last-seen times, without rendering", () => {
  it("a result titled in an agent's words says so as well as who asked", () => {
    const results = RAW_CARDS.filter((one) => one.kind === "outcome").map((card) => cardShape(card));
    const asked = results.filter((one) => /asked for|Asked by/.test(one.sub));
    expect(asked.length).toBeGreaterThan(0);
    for (const one of asked) if (/\bagent$/.test(one.from)) expect(one.sub).toContain(one.from);
  });

  it("on the desk the row says when, so the opened card says who without it", () => {
    const card = raw("idea");
    const shape = cardShape(card);
    expect(cardHead(card, shape, true).some((row) => row.k === "When" || row.v.includes(" · "))).toBe(false);
    expect(cardHead(card, shape)).toHaveLength(1);
  });

  it("a run's steps in the owner's words, a model's call never counted as a tool's", () => {
    expect(stepWords(step("model_call"))).toBe("Asked a model");
    expect(stepHow(step("model_call"))).toBe("");
    expect(stepWords(step("tool_call", "find_messages", "ok"))).not.toMatch(/_/);
    expect(stepHow(step("tool_call", "find_messages", "ok"))).toBe("Done");
    expect(stepWords(step("web_search"))).toBe("Searched the web");
    expect(stepWords(step("output_check", null, null, "external_action"))).toBe("A check refused its answer");
    expect(stepHow(step("output_check", null, "refused", "external_action"))).toBe("");
    expect(stepHow(step("tool_call", "find_messages", "refused", "not_found"))).toBe(
      "Refused · What it asked for was not found",
    );
    expect(stepHow(step("tool_call", "find_messages", "refused", "some_new_code"))).toBe("Refused");
  });

  it("the owner's question names where Skip is", () => {
    const shape = cardShape(raw("owner_question"));
    expect([...shape.rows.map((row) => row.v), ...shape.notes].join(" ")).toContain("Skip, under ···");
  });

  it("a line that repeats its title is found, whatever its case or closing stop", () => {
    expect(sameWords("No agency work.", " no agency work")).toBe(true);
    expect(sameWords("No agency work", "No agency work, only in-house")).toBe(false);
  });

  it("an agent's last-seen time never breaks across lines", () => {
    const seen = lastSeen({ lastCallAt: "2026-10-28T10:02:00.000Z" } as Parameters<typeof lastSeen>[0]);
    expect(seen.replaceAll(" ", " ").startsWith("Last seen ")).toBe(true);
    expect(seen).not.toContain(" ");
  });
});
