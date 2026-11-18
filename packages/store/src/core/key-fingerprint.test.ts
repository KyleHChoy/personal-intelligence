import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyChanges, keyIdentity } from "./key-fingerprint.ts";
import { addCompartmentKey, generateKeyFile, type Keys, loadKeys } from "./keys.ts";

// The key file's identity: which keys a file holds, with no key in it.

let dir = "";
let path = "";
let keys: Keys;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-key-identity-"));
  path = join(dir, "keys.json");
  await generateKeyFile(path, ["own", "agent:alpha"]);
  keys = await loadKeys(path);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("the key file's identity", () => {
  it("is the same for the same keys, one 64 hex mark a key, and holds no key or part of one", async () => {
    const identity = keyIdentity(keys);
    expect(identity).toEqual(keyIdentity(await loadKeys(path)));
    expect(Object.keys(identity.compartments)).toEqual(["agent:alpha", "own"]);
    for (const mark of [identity.fingerprint, ...Object.values(identity.compartments)])
      expect(mark).toMatch(/^[0-9a-f]{64}$/);
    const said = JSON.stringify(identity);
    const file = JSON.parse(await readFile(path, "utf8")) as {
      fingerprint: string;
      compartments: Record<string, string>;
    };
    for (const key of [file.fingerprint, ...Object.values(file.compartments)]) {
      const raw = Buffer.from(key, "base64");
      expect(said).not.toContain(key);
      expect(said).not.toContain(raw.toString("hex"));
      // No eight bytes of a key, in either form the identity could carry them.
      for (let at = 0; at + 8 <= raw.length; at += 8) {
        expect(said).not.toContain(raw.subarray(at, at + 8).toString("hex"));
        expect(said).not.toContain(
          raw
            .subarray(at, at + 8)
            .toString("base64")
            .replace(/=+$/, ""),
        );
      }
    }
  });

  it("gives two keys two marks, and one key under two names two marks", () => {
    const identity = keyIdentity(keys);
    expect(identity.compartments.own).not.toBe(identity.compartments["agent:alpha"]);
    const renamed = keyIdentity({
      ...keys,
      compartments: new Map([["other", keys.compartments.get("own") as never]]),
    });
    expect(renamed.compartments.other).not.toBe(identity.compartments.own);
  });

  it("leaves the restricted root's keys out, whichever files were read", () => {
    const withRestricted = keyIdentity({
      ...keys,
      compartments: new Map([...keys.compartments, ["restricted:health", keys.compartments.get("own") as never]]),
    });
    expect(withRestricted).toEqual(keyIdentity(keys));
  });

  it("an added key is no change; another file's key, a key gone and another fingerprint key each are", async () => {
    const recorded = keyIdentity(keys);
    await addCompartmentKey(path, "employer:example");
    const added = keyIdentity(await loadKeys(path));
    expect(keyChanges(recorded, added)).toEqual([]);
    expect(Object.keys(added.compartments)).toContain("employer:example");
    // Put back from an older copy: the key added since is gone.
    expect(keyChanges(added, recorded)).toEqual(["employer:example"]);

    const otherPath = join(dir, "other.json");
    await generateKeyFile(otherPath, ["own", "agent:alpha"]);
    const other = keyIdentity(await loadKeys(otherPath));
    expect(keyChanges(recorded, other)).toEqual(["fingerprint", "agent:alpha", "own"]);
    expect(keyChanges(recorded, { ...recorded, fingerprint: other.fingerprint })).toEqual(["fingerprint"]);
    expect(
      keyChanges(recorded, {
        ...recorded,
        compartments: { ...recorded.compartments, own: other.compartments.own as string },
      }),
    ).toEqual(["own"]);
  });
});
