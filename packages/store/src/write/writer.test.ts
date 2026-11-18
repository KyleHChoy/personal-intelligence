import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { keys, log, thrown } from "../test-support/unit.ts";
import { createWriter } from "./writer.ts";

// The one part of the writer that needs no database: what it does with a URL that does not
// parse. Its database tests are in writer.db.test.ts.

describe("createWriter", () => {
  it("a malformed URL is refused without its password", async () => {
    const secret = `canary-${randomBytes(6).toString("hex")}`;
    const malformed = [
      `postgres://pi_writer:${secret}@127.0.0.1:notaport/personal`,
      `postgres://pi_writer:${secret}@[::1/personal`,
      `pi_writer:${secret}@127.0.0.1/personal`,
      `http://pi_writer:${secret}@127.0.0.1:54329/personal`,
      `not a url ${secret}`,
      "",
    ];
    for (const url of malformed) {
      const error = thrown(() => createWriter({ url, keys, log }));
      expect(error).toBeInstanceOf(Error);
      expect(error?.code).toBe("bad_url");
      // No part of the URL, in the message, the stack, or any property, shown or hidden.
      const shown = `${inspect(error, { depth: 8, showHidden: true })}\n${String(error?.stack)}\n${JSON.stringify(Object.getOwnPropertyDescriptors(error))}`;
      for (const part of [secret, "pi_writer", "127.0.0.1", "notaport", "not a url"]) expect(shown).not.toContain(part);
    }
    // The positive control: a well-formed URL makes a writer. Nothing connects until it is used.
    const writer = createWriter({ url: `postgres://pi_writer:${secret}@127.0.0.1:54329/personal`, keys, log });
    await writer.close();
  });
});
