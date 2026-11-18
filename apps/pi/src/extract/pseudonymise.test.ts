import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrustGroupId } from "@intelligence/contracts";
import { THE_OWNER } from "@intelligence/personal-core";
import { CALLED_PROMPTS } from "@intelligence/personal-extract";
import { generateKeyFile } from "@intelligence/personal-store";
import { afterAll, describe, expect, it } from "vitest";
import { checkWorldOptions } from "../command-args.ts";
import { pseudonymisedDeltaLines } from "./extract-check.ts";
import { clientOf, pseudonymiserFrom, pseudonymiserOf } from "./extract-config.ts";

// PI_PSEUDONYMISE and `pi extract check --world --pseudonymise`, on invented values and a fake
// fetch: no model is called.

const folders: string[] = [];
afterAll(async () => {
  for (const folder of folders) await rm(folder, { recursive: true, force: true });
});
const keyFile = async (): Promise<string> => {
  const folder = await mkdtemp(join(tmpdir(), "pi-pseudonymise-test-"));
  folders.push(folder);
  const path = join(folder, "keys.json");
  await generateKeyFile(path);
  return path;
};
const TEXT = '{"from":"Tamsin Vale <tamsin@example.net>"}';

describe("PI_PSEUDONYMISE", () => {
  it("is off unset or empty, on at 1, and a usage error at any other value", () => {
    expect(pseudonymiserOf({})).toBeUndefined();
    expect(pseudonymiserOf({ PI_PSEUDONYMISE: "" })).toBeUndefined();
    expect(pseudonymiserOf({ PI_PSEUDONYMISE: "1", PI_KEY_FILE: "/nowhere" })).toBeDefined();
    expect(() => pseudonymiserOf({ PI_PSEUDONYMISE: "yes" })).toThrow();
  });

  it("keys its tokens by the box's key file: the same file gives the same tokens, another file others", async () => {
    const one = await keyFile();
    const other = await keyFile();
    const first = await pseudonymiserFrom({ PI_KEY_FILE: one }).outgoing(TEXT);
    expect(first).not.toContain("Tamsin Vale");
    expect(first).not.toContain("tamsin@example.net");
    expect(await pseudonymiserFrom({ PI_KEY_FILE: one }).outgoing(TEXT)).toBe(first);
    expect(await pseudonymiserFrom({ PI_KEY_FILE: other }).outgoing(TEXT)).not.toBe(first);
  });

  it("reaches the extraction client: the request that leaves holds no name or address", async () => {
    const bodies: string[] = [];
    const modelFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response("{}", { status: 400 });
    }) as typeof fetch;
    const env = { PI_PSEUDONYMISE: "1", PI_KEY_FILE: await keyFile() };
    const client = clientOf(
      { deps: { modelFetch }, env },
      { kind: "openrouter" },
      "sk-or-test",
      "vendor/model",
      async () => {},
    );
    const prompt = CALLED_PROMPTS[0];
    if (prompt === undefined) throw new Error("no prompt");
    await client
      .complete({
        promptId: prompt.id,
        promptVersion: prompt.version,
        data: Object.fromEntries(prompt.slots.map((slot) => [slot, TEXT])),
        label: { compartments: ["own"], readers: [THE_OWNER] },
        trustGroup: TrustGroupId.parse("personal-openrouter"),
      })
      .catch(() => undefined);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain("Tamsin Vale");
    expect(bodies[0]).not.toContain("tamsin@example.net");
  });
});

describe("pi extract check --world --pseudonymise", () => {
  it("needs --world", () => {
    expect(() => checkWorldOptions({ pseudonymise: true })).toThrow();
    expect(() => checkWorldOptions({ world: true, lane: "correspondence", pseudonymise: true })).not.toThrow();
  });

  it("shows each line the two runs wrote differently, and how many", () => {
    const plain = ["messages: 12 expected 20 found 19 extra 1", "failed: none", "result: ok"];
    const masked = ["messages: 12 expected 20 found 16 extra 2", "failed: m-4", "result: failed"];
    expect(pseudonymisedDeltaLines(plain, masked)).toEqual([
      "delta messages: 12 expected 20 found 19 extra 1 => 12 expected 20 found 16 extra 2",
      "delta failed: none => m-4",
      "delta result: ok => failed",
      "pseudonymise: lines_changed 3",
    ]);
    expect(pseudonymisedDeltaLines(plain, plain)).toEqual(["pseudonymise: lines_changed 0"]);
    expect(pseudonymisedDeltaLines(["a: 1"], [])).toEqual(["delta a: 1 => absent", "pseudonymise: lines_changed 1"]);
  });
});
