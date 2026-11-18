import { isCoded } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { fixed, type Sql, sql, sqlWords } from "./sql.ts";

const takes = (text: Sql): string => text;

describe("sql", () => {
  it("joins a template's text and its fragments in order", () => {
    const table = sql`ledger.cards`;
    expect(sql`select id from ${table} where kind in (${sqlWords(["a", "b_2"])})`).toBe(
      "select id from ledger.cards where kind in ('a', 'b_2')",
    );
    expect(sql``).toBe("");
  });

  it("makes a fragment of a literal, and the type checker refuses a run-time string", () => {
    const kind: "card" | "run" = "card";
    expect(takes(fixed(kind))).toBe("card");
    const read = String(Date.now());
    // @ts-expect-error a string known only at run time is no fragment
    fixed(read);
    // @ts-expect-error a plain string is no fragment
    takes(read);
    // @ts-expect-error a value is a parameter, never a piece of a fragment
    sql`select ${read}`;
  });

  it("refuses a word that is not a code word", () => {
    for (const word of ["x'); drop table t; --", "Upper", "", "a b"]) {
      let thrown: unknown;
      try {
        sqlWords([word]);
      } catch (error) {
        thrown = error;
      }
      expect(isCoded(thrown, "not_a_code_word")).toBe(true);
    }
  });
});
