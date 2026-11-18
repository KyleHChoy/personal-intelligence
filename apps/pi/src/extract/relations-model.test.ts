import { describe, expect, it } from "vitest";
import { relationsOn } from "./relations.ts";

// `pia relations on|off`'s model reads as `pi extract` reads PI_JUDGE_MODEL: an id no run could judge
// under is refused, so no switch is written for a judge that can never exist. No database: the id is
// refused before a connection.
const on = (model: string) =>
  relationsOn({ positionals: ["contradicts"], values: { model }, env: {} } as never).then(
    () => "ran",
    (error: { code?: unknown }) => error.code,
  );

describe("the relation switch's model", () => {
  it("is refused when it is not an id a run takes", async () => {
    expect(await on("Vendor/Model")).toBe("usage");
    expect(await on("no-slash")).toBe("usage");
  });
});
