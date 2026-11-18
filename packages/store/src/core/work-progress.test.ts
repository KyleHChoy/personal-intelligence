import { MoveReportBody, WorkProgress } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { openedProgress, progressBody, progressLines } from "./work-progress.ts";

describe("a progress report's lines", () => {
  it("keeps the lines done, the next step, what it waits on and when it resumes", () => {
    expect(
      progressLines({
        done: ["read the three contracts", "  "],
        next: " compare the renewal terms ",
        waitingOn: "the supplier's reply",
        resumeAt: "2026-03-04T09:00:00.000Z",
        deliverable: "not kept",
      }),
    ).toEqual({
      done: ["read the three contracts"],
      next: "compare the renewal terms",
      waitingOn: "the supplier's reply",
      resumeAt: "2026-03-04T09:00:00.000Z",
    });
  });

  it("needs what is done or what comes next", () => {
    expect(progressLines(undefined)).toBeNull();
    expect(progressLines({ waitingOn: "a reply" })).toBeNull();
    expect(progressLines({ done: [" "], next: "" })).toBeNull();
    expect(progressLines({ next: "call back" })).toEqual({ next: "call back" });
    expect(progressLines({ done: ["one"] })).toEqual({ done: ["one"] });
  });

  it("takes a next step of one line of at most 500 code points", () => {
    expect(progressLines({ next: "one\ntwo" })).toBeNull();
    expect(progressLines({ next: "x".repeat(501) })).toBeNull();
    expect(progressLines({ next: "x".repeat(500) })).toEqual({ next: "x".repeat(500) });
  });
});

describe("a progress report's body", () => {
  it("is a move report body with the request that made it, so a reader of reports opens it as one", () => {
    const body = progressBody({ done: ["one"], next: "two" }, "req_progress_1");
    expect(MoveReportBody.parse(JSON.parse(body))).toEqual({
      v: 1,
      report: { done: ["one"], next: "two" },
      marks: [],
      request: "req_progress_1",
    });
  });

  it("is served with every line untrusted, and null where a line was not given", () => {
    const at = new Date("2026-03-03T10:00:00.000Z");
    const served = openedProgress(progressBody({ done: ["one", "two"], next: "three" }, "req_progress_2"), at, "scout");
    expect(served).toEqual({
      done: [{ untrusted: "one" }, { untrusted: "two" }],
      next: { untrusted: "three" },
      waitingOn: null,
      resumeAt: null,
      at: "2026-03-03T10:00:00.000Z",
      by: "scout",
    });
    expect(WorkProgress.safeParse(served).success).toBe(true);
    expect(
      openedProgress(
        progressBody({ next: "n", waitingOn: "w", resumeAt: "2026-03-04T09:00:00.000Z" }, "req_progress_3"),
        at,
        "scout",
      ),
    ).toMatchObject({ done: [], waitingOn: { untrusted: "w" }, resumeAt: "2026-03-04T09:00:00.000Z" });
  });
});
