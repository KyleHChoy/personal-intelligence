import { describe, expect, it } from "vitest";
import {
  AboutYouKind,
  agentCallOf,
  isLegacy,
  isStatement,
  KIND_REGISTRY,
  kindsWhere,
  ProposeAboutYouArgs,
  parseProposalBody,
  proposalScope,
  STATEMENT_PHRASES,
  storedBodyOf,
} from "./index.ts";

// Agents state, the classifier types. Old callers keep working.
describe("statement proposals", () => {
  const requestId = "statement-0001";
  it("a statement alone, with a quote, is taken and stored as a statement proposal", () => {
    const args = ProposeAboutYouArgs.parse({
      statement: "The owner prefers meetings before 10am",
      quote: "I like to meet before ten",
      requestId,
    });
    const body = storedBodyOf(args);
    expect(body).toEqual({ statement: "The owner prefers meetings before 10am", quote: "I like to meet before ten" });
    expect(isStatement(body)).toBe(true);
    expect(proposalScope(body)).toBe("all");
    const parsed = parseProposalBody(JSON.stringify(body));
    expect(parsed).toEqual(body);
    expect(parsed === null ? null : isLegacy(parsed)).toBe(false);
  });

  it("an agent's call in the old shape is still taken: its kind kept as a hint, its fields worded as a statement, never stored", () => {
    const old = ProposeAboutYouArgs.parse({
      kind: "preference",
      fields: { domain: "career", object: "morning meetings", polarity: "prefers" },
      scope: "all",
      requestId,
    });
    const call = agentCallOf(old);
    expect(call).toEqual({ statement: "The owner prefers morning meetings (career)", kind: "preference", requestId });
    const body = storedBodyOf(call);
    expect(isStatement(body)).toBe(true);
    expect(body).toEqual({ statement: "The owner prefers morning meetings (career)", kind: "preference" });
    // The store's own callers' fields-only call keeps working.
    expect(isStatement(storedBodyOf(old))).toBe(false);
    // An interpretation's quotes become its quote.
    const read = ProposeAboutYouArgs.parse({
      kind: "situation",
      fields: { domain: "home", state: "moving to a new flat" },
      scope: "all",
      interpretation: true,
      statement: "The owner is moving flats",
      quotes: ["we move", "next month"],
      requestId,
    });
    expect(storedBodyOf(agentCallOf(read))).toEqual({
      statement: "The owner is moving flats",
      quote: "we move\n\nnext month",
      kind: "situation",
    });
  });

  it("a client-scoped preference with a statement keeps its fields body, its scope and none of the statement", () => {
    const scoped = ProposeAboutYouArgs.parse({
      statement: "The owner wants short replies",
      kind: "preference",
      fields: { domain: "career", object: "short replies", polarity: "prefers" },
      scope: "this_client",
      requestId,
    });
    const body = storedBodyOf(scoped);
    expect(isStatement(body)).toBe(false);
    expect(proposalScope(body)).toBe("this_client");
    expect(body).not.toHaveProperty("statement");
    expect(ProposeAboutYouArgs.safeParse({ ...scoped, quote: "x".repeat(1001) }).success).toBe(false);
  });

  it("a client-scoped preference keeps its fields body, which builds no claim", () => {
    const scoped = ProposeAboutYouArgs.parse({
      kind: "preference",
      fields: { domain: "career", object: "short replies", polarity: "prefers" },
      scope: "this_client",
      requestId,
    });
    const body = storedBodyOf(scoped);
    expect(isStatement(body)).toBe(false);
    expect(proposalScope(body)).toBe("this_client");
  });

  it("goal is no about-you kind in the registry; a statement worded from fields names each kind's own phrase field", () => {
    expect(kindsWhere("aboutYou")).not.toContain("goal");
    expect(AboutYouKind.options).not.toContain("goal");
    for (const [kind, phrase] of Object.entries(STATEMENT_PHRASES))
      expect(KIND_REGISTRY.kinds[kind as keyof typeof KIND_REGISTRY.kinds].phrase, kind).toBe(phrase);
  });

  it("a call with neither a statement nor kind and fields is refused, and so are fields of another kind", () => {
    expect(ProposeAboutYouArgs.safeParse({ requestId }).success).toBe(false);
    expect(ProposeAboutYouArgs.safeParse({ kind: "preference", requestId }).success).toBe(false);
    expect(
      ProposeAboutYouArgs.safeParse({ kind: "preference", fields: { domain: "career", state: "x" }, requestId })
        .success,
    ).toBe(false);
    expect(
      ProposeAboutYouArgs.safeParse({ statement: "The owner runs", scope: "this_client", requestId }).success,
    ).toBe(false);
  });
});
