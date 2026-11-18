import { describe, expect, it } from "vitest";
import { CodedError, isCoded } from "./coded-error.ts";
import { faultOf } from "./faults.ts";

describe("CodedError", () => {
  it("is an Error whose message is its code, with an own enumerable code", () => {
    const error = new CodedError("not_found");
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("not_found");
    expect(Object.keys(error)).toContain("code");
    expect(error.cause).toBeUndefined();
    expect("cause" in error).toBe(false);
  });

  it("keeps a given message and cause", () => {
    const cause = { sqlstate: "40001" };
    const error = new CodedError("not_built", { message: "not implemented", cause });
    expect(error.message).toBe("not implemented");
    expect(error.cause).toBe(cause);
  });

  it("reads to faultOf as the error with that code always has", () => {
    expect(faultOf(new CodedError("unavailable"))).toEqual(
      faultOf(Object.assign(new Error("unavailable"), { code: "unavailable" })),
    );
    expect(faultOf(new CodedError("stale", { cause: { sqlstate: "40001" } }))).toEqual({
      expected: true,
      code: "stale",
      reason: "sqlstate_40001",
    });
  });
});

describe("isCoded", () => {
  it("is true for any object with a string code, and for that code alone when given", () => {
    expect(isCoded(new CodedError("a"))).toBe(true);
    expect(isCoded(new CodedError("a"), "a")).toBe(true);
    expect(isCoded(new CodedError("a"), "b")).toBe(false);
    expect(isCoded(Object.assign(new Error("x"), { code: "ENOENT" }), "ENOENT")).toBe(true);
    expect(isCoded({ code: 7 })).toBe(false);
    expect(isCoded(null)).toBe(false);
    expect(isCoded("a", "a")).toBe(false);
  });
});
