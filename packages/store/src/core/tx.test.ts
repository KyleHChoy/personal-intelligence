import { CodedError } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { eachInOwnTransaction } from "./tx.ts";

const failing =
  (failures: Record<number, Error>) =>
  async (row: number): Promise<void> => {
    const failure = failures[row];
    if (failure !== undefined) throw failure;
  };

describe("eachInOwnTransaction", () => {
  it.each([
    { name: "none fails", failures: {}, failed: 0 },
    { name: "a row that fails is counted and the rest go on", failures: { 1: new Error("x") }, failed: 1 },
    { name: "a coded failure is counted", failures: { 0: new CodedError("not_found"), 2: new Error("y") }, failed: 2 },
    // job-db codes every SQLSTATE outside classes 22 and 23 `unavailable`, keeping it in the cause.
    ...["42501", "PIW01", "40P01", "40001", "57014"].map((sqlstate) => ({
      name: `a row refused with ${sqlstate} is counted`,
      failures: { 1: new CodedError("unavailable", { cause: { sqlstate } }) },
      failed: 1,
    })),
  ])("$name", async ({ failures, failed }) => {
    const seen: number[] = [];
    const step = failing(failures);
    expect(
      await eachInOwnTransaction([0, 1, 2], async (row) => {
        seen.push(row);
        await step(row);
      }),
    ).toBe(failed);
    expect(seen).toEqual([0, 1, 2]);
  });

  it.each([
    { name: "unavailable with no SQLSTATE", lost: new CodedError("unavailable") },
    { name: "a lost connection, 08006", lost: new CodedError("unavailable", { cause: { sqlstate: "08006" } }) },
    { name: "the server shutting down, 57P01", lost: new CodedError("unavailable", { cause: { sqlstate: "57P01" } }) },
    { name: "a socket reset", lost: Object.assign(new Error("reset"), { code: "ECONNRESET" }) },
  ])("$name ends the loop and is rethrown", async ({ lost }) => {
    const seen: number[] = [];
    await expect(
      eachInOwnTransaction([0, 1, 2], async (row) => {
        seen.push(row);
        if (row === 1) throw lost;
      }),
    ).rejects.toBe(lost);
    expect(seen).toEqual([0, 1]);
  });
});
