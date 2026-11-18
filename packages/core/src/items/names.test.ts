import { describe, expect, it } from "vitest";
import { headerBlock } from "./builders.ts";
import { namesOf } from "./names.ts";

// Made-up values on reserved domains. "Renée Example" in the three forms a header may carry.
const B = "=?UTF-8?B?UmVuw6llIEV4YW1wbGU=?=";
const Q = "=?UTF-8?Q?Ren=C3=A9e_Example?=";
const LATIN = "=?ISO-8859-1?Q?Ren=E9e_Example?=";

const block = (headers: [string, string][]): Uint8Array =>
  headerBlock(headers.map(([name, value]) => ({ name, value })));

describe("namesOf", () => {
  it("an encoded-word name is decoded", async () => {
    for (const encoded of [B, Q, LATIN]) {
      const read = await namesOf(
        block([
          ["From", `${encoded} <renee@example.com>`],
          ["To", "owner@example.org"],
        ]),
      );
      expect(read.names, encoded).toEqual([{ address: "renee@example.com", name: "Renée Example" }]);
    }
    // A plain name is kept as it is written, and an address with no name has none.
    const plain = await namesOf(
      block([
        ["From", '"Example, Alex" <Alex@Example.com>'],
        ["CC", "Casey Example <casey@example.com>"],
        ["bcc", "blair@example.org"],
      ]),
    );
    expect(plain.names).toEqual([
      { address: "alex@example.com", name: "Example, Alex" },
      { address: "casey@example.com", name: "Casey Example" },
    ]);
  });

  it("an encoded-word subject is decoded", async () => {
    for (const encoded of [B, Q, LATIN]) {
      const read = await namesOf(
        block([
          ["From", "alex@example.com"],
          ["Subject", `Re: ${encoded}`],
        ]),
      );
      expect(read.subject, encoded).toBe("Re: Renée Example");
    }
    expect(
      (
        await namesOf(
          block([
            ["From", "alex@example.com"],
            ["SUBJECT", "Notes"],
          ]),
        )
      ).subject,
    ).toBe("Notes");
    // No Subject header is no subject.
    expect((await namesOf(block([["From", "alex@example.com"]]))).subject).toBeNull();
  });

  it("a group yields its members and not its name", async () => {
    const read = await namesOf(
      block([
        ["From", "alex@example.com"],
        ["To", "Board: Sam Example <sam@example.org>, robin@lab.test;, Casey Example <casey@example.com>"],
      ]),
    );
    expect(read.names).toEqual([
      { address: "sam@example.org", name: "Sam Example" },
      { address: "casey@example.com", name: "Casey Example" },
    ]);
    expect(JSON.stringify(read)).not.toContain("Board");
  });

  it("a name equal to its address is no name", async () => {
    const read = await namesOf(
      block([
        ["From", '"ALEX@Example.com" <alex@example.com>'],
        ["To", " Casey@Example.COM  <casey@example.com>, Sam Example <sam@example.org>"],
      ]),
    );
    expect(read.names).toEqual([{ address: "sam@example.org", name: "Sam Example" }]);
    // Each address once, with the first name it carries that is one.
    const twice = await namesOf(
      block([
        ["From", "alex@example.com"],
        ["To", "alex@example.com <alex@example.com>, Alex Example <ALEX@example.com>"],
        ["Cc", "Alexander Example <alex@example.com>"],
      ]),
    );
    expect(twice.names).toEqual([{ address: "alex@example.com", name: "Alex Example" }]);
  });
});
