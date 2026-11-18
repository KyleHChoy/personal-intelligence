import { describe, it } from "vitest";
import { ADMIN, ENTITY, expectRefused, REAL, useRealKeyFile, WRITER } from "../test-support/commands-fixtures.ts";

// What the owner commands that read stdin do with input past their byte limit, or input that is
// not UTF-8: each is refused before the key file is read or a connection is made.

useRealKeyFile();

const NOT_UTF8 = Buffer.from([0x4e, 0x61, 0xff, 0x6d, 0x65]) as unknown as string;

describe("stdin limits of the owner commands", () => {
  it("lists create and rename refuse a name past its byte limit, or not UTF-8, with usage", async () => {
    for (const argv of [
      ["lists", "create"],
      ["lists", "rename", "lst_01JABCDEFGHJKMNPQRSTVWXYZ0"],
    ]) {
      for (const name of ["x".repeat(403), NOT_UTF8]) {
        await expectRefused(argv, { ...ADMIN, ...REAL }, "usage", 2, { stdin: [name] });
      }
    }
  });

  it("areas add and rename refuse a name past its byte limit, or not UTF-8, with usage", async () => {
    for (const argv of [
      ["areas", "add", "field-work"],
      ["areas", "rename", "field-work"],
    ]) {
      for (const name of ["x".repeat(803), NOT_UTF8]) {
        await expectRefused(argv, { ...ADMIN, ...REAL }, "usage", 2, { stdin: [name] });
      }
    }
  });

  it("project add refuses a name past its byte limit with usage", async () => {
    await expectRefused(["project", "add"], { ...ADMIN, ...REAL }, "usage", 2, { stdin: ["x".repeat(803)] });
  });

  it("note add refuses a note past its length with usage, however it arrives", async () => {
    await expectRefused(["note", "add", ENTITY], { ...ADMIN, ...REAL }, "usage", 2, {
      stdin: ["x".repeat(10_000), "x".repeat(10_000)],
    });
  });

  it("import contacts refuses a file past its byte limit with too_large", async () => {
    const mib = "x".repeat(1024 * 1024);
    await expectRefused(
      ["import", "contacts", "--adapter", "linkedin-connections", "--name", "linkedin"],
      { ...WRITER, ...REAL },
      "too_large",
      1,
      { stdin: Array.from({ length: 21 }, () => mib) },
    );
  });
});
