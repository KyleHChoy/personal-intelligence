import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SendPayload } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { generateKeyFile, loadKeys } from "../core/keys.ts";
import { storeFiles, storeText } from "../test-support/sources.ts";
import { draftValues } from "./draft-values.ts";

// One maker of a draft's four values: `pi mcp` stores them through work-draft.ts and `pi send`
// makes them again through sender.ts, so both import draft-values.ts, and no other file of the
// store defines them.
describe("draftValues", () => {
  it("is defined in draft-values.ts alone, and work-draft.ts and sender.ts both import it", async () => {
    const files = storeFiles().filter((name) => !name.endsWith(".test.ts"));
    const defining: string[] = [];
    for (const name of files)
      if (/function draftValues\b|const draftValues\b/.test(storeText(name))) defining.push(name);
    expect(defining).toEqual(["draft-values.ts"]);
    for (const name of ["work-draft.ts", "sender.ts"])
      expect(storeText(name), name).toMatch(
        /import \{[^}]*\bdraftValues\b[^}]*\} from "(?:\.{1,2}\/)+(?:[\w-]+\/)*draft-values\.ts"/,
      );
  });
});

describe("a draft's recipient domains", () => {
  it("are each recipient's whole domain and its registrable domain, once each", async () => {
    const dir = await mkdtemp(join(tmpdir(), "draft-values-"));
    try {
      await generateKeyFile(join(dir, "keys.json"));
      const keys = await loadKeys(join(dir, "keys.json"));
      const payload = (to: string[]): SendPayload => ({
        v: 1,
        account: `acc_${"0".repeat(25)}1` as SendPayload["account"],
        to,
        cc: [],
        subject: "Hello",
        body: "Hello there.",
        thread: null,
      });
      const fp = (domain: string): string => fingerprint(keys, "domain", domain);
      const folded = await draftValues(keys, payload(["sam@mail.example.co.uk"]));
      expect([...folded.recipientDomainFps].sort()).toEqual([fp("mail.example.co.uk"), fp("example.co.uk")].sort());
      // A recipient on the registrable domain itself has the one fingerprint, as before.
      const plain = await draftValues(keys, payload(["sam@example.co.uk", "lee@mail.example.co.uk"]));
      expect([...plain.recipientDomainFps].sort()).toEqual([fp("mail.example.co.uk"), fp("example.co.uk")].sort());
      expect((await draftValues(keys, payload(["sam@alder.example"]))).recipientDomainFps).toEqual([
        fp("alder.example"),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
