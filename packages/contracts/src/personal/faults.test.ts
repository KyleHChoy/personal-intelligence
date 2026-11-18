import { classCode, faultOf } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";

// What an edge expects and what is a bug, read from an error's code, SQLSTATE, errno or class
// only, never its message.

class Refusal extends Error {
  constructor(readonly code: string) {
    super("Alex Example wrote this");
  }
}

describe("faultOf", () => {
  it("a refusal or a store error keeps its own code, and a store error's SQLSTATE is its reason", () => {
    expect(faultOf(new Refusal("usage"))).toEqual({ expected: true, code: "usage" });
    expect(faultOf(Object.assign(new Error("x", { cause: { sqlstate: undefined } }), { code: "unavailable" }))).toEqual(
      {
        expected: true,
        code: "unavailable",
      },
    );
    const store = Object.assign(new Error("unavailable", { cause: { sqlstate: "40001" } }), { code: "unavailable" });
    expect(faultOf(store)).toEqual({ expected: true, code: "unavailable", reason: "sqlstate_40001" });
  });

  it("a driver's error, a socket's and an abort are unavailable, by SQLSTATE, errno or class", () => {
    expect(faultOf(Object.assign(new Error("duplicate key Alex"), { code: "23505" }))).toEqual({
      expected: true,
      code: "unavailable",
      reason: "sqlstate_23505",
    });
    expect(faultOf(Object.assign(new Error("connect"), { code: "ECONNREFUSED" }))).toEqual({
      expected: true,
      code: "unavailable",
      reason: "econnrefused",
    });
    expect(faultOf(new DOMException("stopped", "AbortError"))).toEqual({
      expected: true,
      code: "unavailable",
      reason: "abort_error",
    });
    expect(faultOf(new DOMException("late", "TimeoutError")).reason).toBe("timeout_error");
  });

  it("anything else is a bug, named by its class and never its message", () => {
    expect(faultOf(new TypeError("Cannot read Alex Example"))).toEqual({
      expected: false,
      code: "bug",
      reason: "type_error",
    });
    expect(faultOf(Object.assign(new TypeError("x"), { code: "ERR_INVALID_ARG_TYPE" }))).toEqual({
      expected: false,
      code: "bug",
      reason: "type_error",
    });
    expect(faultOf(new Error("Connection terminated"))).toEqual({ expected: false, code: "bug", reason: "error" });
    expect(faultOf("Alex Example")).toEqual({ expected: false, code: "bug", reason: "non_error" });
    expect(faultOf(null)).toEqual({ expected: false, code: "bug", reason: "non_error" });
    for (const fault of [faultOf(new RangeError("Alex")), faultOf(new Refusal("usage"))])
      expect(JSON.stringify(fault)).not.toContain("Alex");
  });

  it("a class name becomes a log code, or `unknown` when it makes none", () => {
    expect(classCode(new SyntaxError("x"))).toBe("syntax_error");
    class ZodLikeError extends Error {}
    expect(classCode(new ZodLikeError())).toBe("zod_like_error");
    expect(classCode(Object.create(null))).toBe("unknown");
    expect(classCode(new (class $$ {})())).toBe("unknown");
  });
});
