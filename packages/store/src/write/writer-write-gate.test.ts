import { describe, expect, it } from "vitest";
import { storeText } from "../test-support/sources.ts";

// A writer that has lost its sync lock writes nothing: every writing method and every transaction a
// pass opens goes through `write`, which refuses once the lock's connection has gone. Nothing but
// the behavior test exercises the shared transaction and direct-query guards too.

// The two methods that only read, each its own transaction.
const READS = ["confirmedPeople", "previewImport"];
// These passes use the writer's shared guarded transaction wrapper rather than a local write helper.
const WRAPPED_WHOLE = ["chat-lines.ts", "participant-binding.ts"];
const PASSES = ["capture-drain.ts", "capture-catch-up.ts", "capture-retention.ts", "capture-contacts.ts"];

describe("the writer's lost lock", () => {
  it("every method of the writer that opens a transaction goes through write", () => {
    const text = storeText("writer.ts");
    const methods = text.slice(text.indexOf("export function createWriter")).split(/^ {4}(?=\w+: )/m);
    const bare = methods
      .filter((method) => /\btransaction\(/.test(method) && !/\bwrite\(/.test(method))
      .map((method) => /^(\w+):/.exec(method)?.[1] ?? "");
    expect(bare.filter((name) => name !== "").sort()).toEqual(READS);
  });

  it.each(PASSES)("%s opens no transaction outside write", (file) => {
    const lines = storeText(file).split("\n");
    const bare = lines.flatMap((line, at) =>
      /\btransaction\(/.test(line) && !/write\(/.test(`${lines[at - 1] ?? ""} ${line}`) ? [at + 1] : [],
    );
    expect(bare).toEqual([]);
  });

  it("the passes share the writer transaction wrapper", () => {
    expect(WRAPPED_WHOLE.every((file) => /\bwriter\.transaction\(/.test(storeText(file)))).toBe(true);
  });
});
