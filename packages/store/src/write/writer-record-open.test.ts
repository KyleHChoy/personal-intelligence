import { describe, expect, it } from "vitest";
import type { Query } from "../core/db.ts";
import { takeOne } from "./writer-records.ts";

describe("record intake when its body cannot open", () => {
  it("keeps the sealed body and leaves the record retryable instead of refusing or deleting it", async () => {
    const statements: string[] = [];
    const query: Query = async <Row>(text: string) => {
      statements.push(text);
      if (text.includes("from ledger.agent_writes where id = $1 for update"))
        return [
          {
            id: "record",
            kind: "note",
            body_enc: {},
            compartments: ["own"],
            evidence_id: null,
            refused_code: null,
          },
        ] as Row[];
      return (text.includes("as gone") ? [{ gone: false }] : []) as Row[];
    };
    expect(
      await takeOne({ query, keys: { compartments: new Map(), fingerprintKey: Buffer.alloc(32) } }, "record"),
    ).toBe("waiting");
    expect(
      statements.filter((text) =>
        /^\s*(delete|insert)\b|set\s+(body_enc|evidence_id|refused_code|tainted_at)/i.test(text),
      ),
    ).toEqual([]);
  });
});
