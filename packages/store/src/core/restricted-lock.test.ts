import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PASSKEY_CATEGORIES, RESTRICTED_COMPARTMENTS, UNLOCK_WINDOW_MS } from "@intelligence/contracts/personal";
import { afterEach, describe, expect, it } from "vitest";
import {
  addCompartmentKey,
  generateKeyFile,
  KeyFileRefused,
  type Keys,
  loadKeys,
  saveWrapped,
  wrappedAt,
  wrapRestrictedFile,
} from "./keys.ts";
import { createRestrictedUnlock, unwrap, withPrf, withUnlock } from "./restricted-lock.ts";
import { open, type Sealed, sealUnder } from "./seal.ts";
import { openedUnder } from "./tx.ts";

// The passkey lock on the restricted key file: the keys are on disk only wrapped, open only with the
// recovery secret or the passkey's PRF output, and held in memory for the window alone.

const LOCKED = PASSKEY_CATEGORIES.map((category) => `restricted:${category}`);
const HEALTH = ["own", "restricted:health"];
const AT = { table: "knowledge.claims", id: "clm_01", column: "content_enc" };
const opened = (keys: Keys, compartments: string[], sealed: Sealed): string =>
  open(keys, { id: AT.id, compartments, content_enc: sealed }, "knowledge.claims.content_enc", "throw");

const folders: string[] = [];
afterEach(async () => {
  for (const one of folders.splice(0)) await rm(one, { recursive: true, force: true });
});

// A general file and a wrapped restricted file beside it, and the recovery secret.
async function wrappedPair(): Promise<{ general: string; restricted: string; recovery: Buffer }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-restricted-lock-"));
  folders.push(dir);
  const general = join(dir, "keys.json");
  const restricted = join(dir, "restricted-keys.json");
  await generateKeyFile(general);
  const recovery = Buffer.from(await wrapRestrictedFile(restricted, LOCKED), "base64url");
  return { general, restricted, recovery };
}

const refusedWith = (code: string) => expect.objectContaining({ code });

describe("the restricted set", () => {
  it("is every restricted category, and the passkey's categories are health, money and legal", () => {
    expect([...RESTRICTED_COMPARTMENTS].sort()).toEqual([
      "restricted:health",
      "restricted:intimate",
      "restricted:legal",
      "restricted:money",
    ]);
    expect(LOCKED).toEqual(["restricted:health", "restricted:money", "restricted:legal"]);
  });
});

describe("a wrapped restricted key file", () => {
  it("holds no key in the clear: loading it gives the general keys and names the restricted ones locked", async () => {
    const { general, restricted } = await wrappedPair();
    const keys = await loadKeys(general, restricted);
    expect([...keys.compartments.keys()]).toEqual(["own"]);
    expect([...(keys.locked ?? [])].sort()).toEqual([...LOCKED].sort());
    expect((await stat(restricted)).mode & 0o777).toBe(0o600);
  });

  it("opens with its recovery secret, and with nothing else", async () => {
    const { restricted, recovery } = await wrappedPair();
    const file = await wrappedAt(restricted);
    if (file === undefined) throw new Error("not wrapped");
    const { keys } = unwrap(file, { recovery });
    expect([...keys.keys()].sort()).toEqual([...LOCKED].sort());
    const text = await readFile(restricted, "utf8");
    for (const key of keys.values()) {
      expect(text).not.toContain(key);
      expect(text).not.toContain(Buffer.from(key, "base64").toString("base64url"));
    }
    expect(() => unwrap(file, { recovery: randomBytes(32) })).toThrow(refusedWith("restricted_unlock_refused"));
    // No PRF slot yet: a PRF output opens nothing.
    expect(() => unwrap(file, { prf: randomBytes(32), credential: "cred" })).toThrow(
      refusedWith("restricted_unlock_refused"),
    );
  });

  it("opens with the passkey's PRF output once it has a slot, only for that credential and that output", async () => {
    const { restricted, recovery } = await wrappedPair();
    const file = (await wrappedAt(restricted)) as NonNullable<Awaited<ReturnType<typeof wrappedAt>>>;
    const { keys, fileKey } = unwrap(file, { recovery });
    const prf = randomBytes(32);
    await saveWrapped(restricted, withPrf(file, fileKey, "cred-1", prf));
    const slotted = (await wrappedAt(restricted)) as typeof file;
    expect(unwrap(slotted, { prf, credential: "cred-1" }).keys).toEqual(keys);
    expect(() => unwrap(slotted, { prf, credential: "cred-2" })).toThrow(refusedWith("restricted_unlock_refused"));
    expect(() => unwrap(slotted, { prf: randomBytes(32), credential: "cred-1" })).toThrow(
      refusedWith("restricted_unlock_refused"),
    );
    // The recovery secret still opens it.
    expect(unwrap(slotted, { recovery }).keys).toEqual(keys);
  });

  it("wraps the keys of a plain restricted file, so what was sealed under them still opens", async () => {
    const dir = await mkdtempFolder();
    const general = join(dir, "keys.json");
    const restricted = join(dir, "restricted-keys.json");
    await generateKeyFile(general);
    await addCompartmentKey(general, "restricted:health", restricted);
    const before = await loadKeys(general, restricted);
    const sealed = sealUnder(before, HEALTH, AT, "a lab result");
    const recovery = Buffer.from(await wrapRestrictedFile(restricted, LOCKED), "base64url");
    const file = (await wrappedAt(restricted)) as NonNullable<Awaited<ReturnType<typeof wrappedAt>>>;
    const { keys } = unwrap(file, { recovery });
    expect(keys.get("restricted:health")).toBe(before.compartments.get("restricted:health"));
    const unlock = createRestrictedUnlock(() => new Date(0));
    unlock.unlock(keys);
    expect(opened(withUnlock(await loadKeys(general, restricted), unlock), HEALTH, sealed)).toBe("a lab result");
  });

  it("takes no key once wrapped, and is not wrapped twice", async () => {
    const { general, restricted } = await wrappedPair();
    await expect(addCompartmentKey(general, "restricted:intimate", restricted)).rejects.toEqual(
      expect.objectContaining({ name: "KeyFileRefused", code: "wrapped" }),
    );
    await expect(wrapRestrictedFile(restricted, LOCKED)).rejects.toEqual(
      expect.objectContaining({ name: "KeyFileRefused", code: "exists" }),
    );
    await expect(wrapRestrictedFile(restricted, ["own"])).rejects.toBeInstanceOf(KeyFileRefused);
  });

  it("may be read by its group, being sealed, and is refused when anyone else may read it", async () => {
    const { general, restricted } = await wrappedPair();
    await chmod(restricted, 0o640);
    expect((await loadKeys(general, restricted)).locked?.size).toBe(3);
    await chmod(restricted, 0o644);
    await expect(loadKeys(general, restricted)).rejects.toEqual(
      expect.objectContaining({ name: "KeyFileRefused", code: "mode" }),
    );
  });

  it("is refused when its shape is not a wrapped file's", async () => {
    const { general, restricted } = await wrappedPair();
    const file = JSON.parse(await readFile(restricted, "utf8")) as Record<string, unknown>;
    for (const change of [
      { compartments: ["own"] },
      { compartments: [] },
      { prfSalt: "short" },
      { keys: { v: 1 } },
      { prf: { credential: "", key: file.recovery } },
    ]) {
      await writeFile(restricted, JSON.stringify({ ...file, ...change }), { mode: 0o600 });
      await expect(loadKeys(general, restricted), JSON.stringify(change)).rejects.toEqual(
        expect.objectContaining({ name: "KeyFileRefused", code: "format" }),
      );
    }
  });
});

describe("an unlock", () => {
  it("restricted rows do not open while locked, open after an unlock, and are locked again after the window", async () => {
    const { general, restricted, recovery } = await wrappedPair();
    const file = (await wrappedAt(restricted)) as NonNullable<Awaited<ReturnType<typeof wrappedAt>>>;
    const unwrapped = unwrap(file, { recovery }).keys;
    // A value sealed while open, under own and health.
    const clock = { now: new Date("2026-11-16T12:00:00Z") };
    const unlock = createRestrictedUnlock(() => clock.now);
    const keys = withUnlock(await loadKeys(general, restricted), unlock);

    // Locked: sealing and opening are refused as restricted_locked, and own still works.
    expect(() => sealUnder(keys, HEALTH, AT, "x")).toThrow(refusedWith("restricted_locked"));
    expect(opened(keys, ["own"], sealUnder(keys, ["own"], AT, "plain"))).toBe("plain");

    const until = unlock.unlock(unwrapped);
    expect(until.getTime() - clock.now.getTime()).toBe(UNLOCK_WINDOW_MS);
    const sealed = sealUnder(keys, HEALTH, AT, "a lab result");
    expect(opened(keys, HEALTH, sealed)).toBe("a lab result");
    expect(openedUnder(keys, HEALTH, AT, sealed)).toBe("a lab result");
    expect(keys.locked?.size).toBe(0);

    // A minute before the window ends it is open; at its end the keys are forgotten.
    clock.now = new Date(until.getTime() - 60_000);
    expect(opened(keys, HEALTH, sealed)).toBe("a lab result");
    clock.now = until;
    expect(() => opened(keys, HEALTH, sealed)).toThrow(refusedWith("restricted_locked"));
    expect(() => openedUnder(keys, HEALTH, AT, sealed)).toThrow(refusedWith("restricted_locked"));
    expect(unlock.until()).toBeNull();
    expect([...(keys.locked ?? [])].sort()).toEqual([...LOCKED].sort());

    // Locking by hand forgets them at once.
    unlock.unlock(unwrapped);
    expect(opened(keys, HEALTH, sealed)).toBe("a lab result");
    unlock.lock();
    expect(() => opened(keys, HEALTH, sealed)).toThrow(refusedWith("restricted_locked"));
  });

  it("holds restricted keys alone", () => {
    const unlock = createRestrictedUnlock(() => new Date(0));
    expect(() => unlock.unlock(new Map([["own", "A".repeat(43).concat("=") as never]]))).toThrow(refusedWith("format"));
    expect(unlock.held().size).toBe(0);
  });
});

async function mkdtempFolder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-restricted-lock-"));
  folders.push(dir);
  return dir;
}
