import { createHmac } from "node:crypto";
import { chmod, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fingerprint } from "./fingerprint.ts";
import {
  addCompartmentKey,
  forSending,
  generateKeyFile,
  KeyFileRefused,
  loadKeys,
  narrowKeyFile,
  narrowKeyText,
  reloadingKeys,
} from "./keys.ts";

// biome-ignore lint/suspicious/noExplicitAny: these tests reshape key files into malformed ones, deleting and retyping nested fields no real type allows.
type KeyFileJson = Record<string, any>;

const folders: string[] = [];

async function folder(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), "pi-keys-"));
  folders.push(made);
  return made;
}

// A key file's JSON, changed, written beside it under another name with the right mode.
async function rewritten(from: string, name: string, change: (file: KeyFileJson) => void): Promise<string> {
  const file = JSON.parse(await readFile(from, "utf8")) as KeyFileJson;
  change(file);
  const path = join(await folder(), name);
  await writeFile(path, JSON.stringify(file), { mode: 0o600 });
  return path;
}

const refusal = (code: KeyFileRefused["code"]) => expect.objectContaining({ name: "KeyFileRefused", code });

afterEach(async () => {
  for (const made of folders.splice(0)) await rm(made, { recursive: true, force: true });
});

describe("the key file", () => {
  it("the key file is written 0600 and never overwritten", async () => {
    const path = join(await folder(), "keys.json");
    await generateKeyFile(path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const before = await readFile(path, "utf8");
    const keys = await loadKeys(path);
    expect([...keys.compartments.keys()]).toEqual(["own"]);
    expect(keys.fingerprintKey).toHaveLength(32);

    await expect(generateKeyFile(path)).rejects.toEqual(refusal("exists"));
    await expect(generateKeyFile(path)).rejects.toBeInstanceOf(KeyFileRefused);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("a key file readable by others is refused", async () => {
    const path = join(await folder(), "keys.json");
    await generateKeyFile(path);
    await expect(loadKeys(path)).resolves.toBeDefined();

    for (const mode of [0o604, 0o620, 0o601, 0o660, 0o650, 0o644]) {
      await chmod(path, mode);
      await expect(loadKeys(path)).rejects.toEqual(refusal("mode"));
      await expect(addCompartmentKey(path, "employer:example")).rejects.toEqual(refusal("mode"));
    }
    await chmod(path, 0o600);
    await expect(loadKeys(path)).resolves.toBeDefined();
  });

  it("a wrong key file is refused", async () => {
    const dir = await folder();
    const [one, two] = [join(dir, "one.json"), join(dir, "two.json")];
    await generateKeyFile(one, ["own", "employer:example"]);
    await generateKeyFile(two, ["own", "employer:example"]);
    const other = JSON.parse(await readFile(two, "utf8")) as KeyFileJson;
    // The positive control: the same rewrite with nothing changed still loads.
    await expect(loadKeys(await rewritten(one, "same.json", () => {}))).resolves.toBeDefined();

    const swappedKey = await rewritten(one, "key.json", (file) => {
      file.compartments.own = other.compartments.own;
    });
    await expect(loadKeys(swappedKey)).rejects.toEqual(refusal("check"));

    const swappedFingerprint = await rewritten(one, "fingerprint.json", (file) => {
      file.fingerprint = other.fingerprint;
    });
    await expect(loadKeys(swappedFingerprint)).rejects.toEqual(refusal("check"));

    // One compartment's check moved to another compartment does not open there.
    const movedCheck = await rewritten(one, "check.json", (file) => {
      file.check.own = file.check["employer:example"];
    });
    await expect(loadKeys(movedCheck)).rejects.toEqual(refusal("check"));

    const notJson = join(dir, "not-json.json");
    await writeFile(notJson, "{", { mode: 0o600 });
    await expect(loadKeys(notJson)).rejects.toEqual(refusal("format"));
    for (const change of [
      (file: KeyFileJson) => void (file.version = 2),
      (file: KeyFileJson) => void (file.compartments.own = "short"),
      (file: KeyFileJson) => void delete file.fingerprint,
      (file: KeyFileJson) => void delete file.check.own,
      (file: KeyFileJson) => void delete file.fingerprintCheck,
    ]) {
      await expect(loadKeys(await rewritten(one, "format.json", change))).rejects.toEqual(refusal("format"));
    }
  });

  it("adding a compartment keeps the existing keys", async () => {
    const path = join(await folder(), "keys.json");
    await generateKeyFile(path);
    const before = await loadKeys(path);
    const fileBefore = JSON.parse(await readFile(path, "utf8")) as KeyFileJson;

    await addCompartmentKey(path, "employer:example");
    const after = await loadKeys(path);
    const fileAfter = JSON.parse(await readFile(path, "utf8")) as KeyFileJson;

    expect([...after.compartments.keys()]).toEqual(["own", "employer:example"]);
    expect(after.compartments.get("own")).toBe(before.compartments.get("own"));
    expect(after.compartments.get("employer:example")).not.toBe(before.compartments.get("own"));
    expect(after.fingerprintKey.equals(before.fingerprintKey)).toBe(true);
    expect(fileAfter.compartments.own).toBe(fileBefore.compartments.own);
    expect(fileAfter.check.own).toEqual(fileBefore.check.own);
    expect(fileAfter.fingerprint).toBe(fileBefore.fingerprint);
    expect(fileAfter.fingerprintCheck).toBe(fileBefore.fingerprintCheck);
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const stored = await readFile(path, "utf8");
    await expect(addCompartmentKey(path, "employer:example")).rejects.toEqual(refusal("exists"));
    await expect(addCompartmentKey(path, "own")).rejects.toEqual(refusal("exists"));
    expect(await readFile(path, "utf8")).toBe(stored);
  });
});

describe("the key file, missing or being changed", () => {
  it("a missing key file is refused as missing", async () => {
    const dir = await folder();
    const path = join(dir, "keys.json");
    await expect(loadKeys(path)).rejects.toEqual(refusal("missing"));
    await expect(addCompartmentKey(path, "employer:example")).rejects.toEqual(refusal("missing"));
    await expect(loadKeys(join(dir, "no-such-folder", "keys.json"))).rejects.toEqual(refusal("missing"));
    await expect(addCompartmentKey(join(dir, "no-such-folder", "keys.json"), "employer:example")).rejects.toEqual(
      refusal("missing"),
    );
    // A refused add leaves nothing behind.
    expect(await readdir(dir)).toEqual([]);

    // The positive control: once it is generated, the same calls work.
    await generateKeyFile(path);
    await expect(loadKeys(path)).resolves.toBeDefined();
    await expect(addCompartmentKey(path, "employer:example")).resolves.toBeUndefined();
  });

  it("a second add at once is refused as locked", async () => {
    const dir = await folder();
    const path = join(dir, "keys.json");
    await generateKeyFile(path);

    // Two at once: one adds its key, the other is refused, and neither loses the other's work.
    const outcomes = await Promise.allSettled([
      addCompartmentKey(path, "employer:one"),
      addCompartmentKey(path, "employer:two"),
    ]);
    const refused = outcomes.flatMap((outcome, index) =>
      outcome.status === "rejected" ? [{ index, reason: outcome.reason as unknown }] : [],
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]?.reason).toEqual(refusal("locked"));
    const added = refused[0]?.index === 0 ? "employer:two" : "employer:one";
    const waiting = refused[0]?.index === 0 ? "employer:one" : "employer:two";
    expect([...(await loadKeys(path)).compartments.keys()]).toEqual(["own", added]);
    // The lock went with the add that held it, and no temporary file is left.
    expect(await readdir(dir)).toEqual(["keys.json"]);

    // A lock that is there is respected, and the key file is not touched.
    const before = await readFile(path, "utf8");
    await writeFile(`${path}.lock`, "");
    await expect(addCompartmentKey(path, waiting)).rejects.toEqual(refusal("locked"));
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await readdir(dir)).sort()).toEqual(["keys.json", "keys.json.lock"]);
    // Reading needs no lock.
    await expect(loadKeys(path)).resolves.toBeDefined();

    // The positive control: with the lock gone, the same add works.
    await rm(`${path}.lock`);
    await addCompartmentKey(path, waiting);
    expect([...(await loadKeys(path)).compartments.keys()]).toEqual(["own", added, waiting]);
    expect(await readdir(dir)).toEqual(["keys.json"]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("an add that is refused releases its lock", async () => {
    const dir = await folder();
    const path = join(dir, "keys.json");
    await generateKeyFile(path);
    await expect(addCompartmentKey(path, "own")).rejects.toEqual(refusal("exists"));
    await chmod(path, 0o604);
    await expect(addCompartmentKey(path, "employer:example")).rejects.toEqual(refusal("mode"));
    await chmod(path, 0o600);
    expect(await readdir(dir)).toEqual(["keys.json"]);
    await expect(addCompartmentKey(path, "employer:example")).resolves.toBeUndefined();
  });
});

// A long-running process (`pi http`) holds the key file's keys as they are on disk now: a client
// given record after it started (`pia clients add`, `set-tools`) has its key in the next call.
describe("the key file, read again when it changes", () => {
  it("a key added after the first read is held by the next call, and an unchanged file is not read again", async () => {
    const path = join(await folder(), "keys.json");
    await generateKeyFile(path);
    const current = await reloadingKeys(path);
    const first = await current();
    expect([...first.compartments.keys()]).toEqual(["own"]);
    // Unchanged: the same keys, not a second read.
    expect(await current()).toBe(first);

    await addCompartmentKey(path, "agent:scribe");
    const after = await current();
    expect([...after.compartments.keys()]).toEqual(["own", "agent:scribe"]);
    expect(after.compartments.get("own")).toBe(first.compartments.get("own"));
    expect(after.fingerprintKey.equals(first.fingerprintKey)).toBe(true);
    expect(await current()).toBe(after);
  });

  it("a file that would be refused at the start is refused when read again, and read once it holds again", async () => {
    const path = join(await folder(), "keys.json");
    await expect(reloadingKeys(path)).rejects.toEqual(refusal("missing"));
    await generateKeyFile(path);
    const current = await reloadingKeys(path);
    const first = await current();

    await chmod(path, 0o604);
    await expect(current()).rejects.toEqual(refusal("mode"));
    await chmod(path, 0o600);
    expect([...(await current()).compartments.keys()]).toEqual(["own"]);

    await rm(path);
    await expect(current()).rejects.toEqual(refusal("missing"));
    // A file there again with other keys is refused: a reload adds keys and changes none.
    await generateKeyFile(path, ["own", "agent:scribe"]);
    await expect(current()).rejects.toEqual(refusal("changed"));
    expect(first.compartments.has("agent:scribe")).toBe(false);
  });

  it("a key it holds that changes, or goes, is refused; only added keys are taken", async () => {
    const path = join(await folder(), "keys.json");
    await generateKeyFile(path, ["own", "employer:example"]);
    const current = await reloadingKeys(path);
    await current();
    // Another file's `own` key, with its check, in place of this one's.
    const other = join(await folder(), "other.json");
    await generateKeyFile(other);
    const otherFile = JSON.parse(await readFile(other, "utf8")) as KeyFileJson;
    const swap = async (change: (file: KeyFileJson) => void): Promise<void> => {
      const file = JSON.parse(await readFile(path, "utf8")) as KeyFileJson;
      change(file);
      await writeFile(path, JSON.stringify(file), { mode: 0o600 });
    };
    const original = await readFile(path, "utf8");
    await swap((file) => {
      file.compartments.own = otherFile.compartments.own;
      file.check.own = otherFile.check.own;
    });
    await expect(current()).rejects.toEqual(refusal("changed"));
    await writeFile(path, original, { mode: 0o600 });
    await swap((file) => {
      delete file.compartments["employer:example"];
      delete file.check["employer:example"];
    });
    await expect(current()).rejects.toEqual(refusal("changed"));
    // The control: the file as it was is taken again.
    await writeFile(path, original, { mode: 0o600 });
    expect([...(await current()).compartments.keys()]).toEqual(["own", "employer:example"]);
  });

  it("a file is read once per change, by every caller at once, and a refused one is not read again until it changes", async () => {
    const path = join(await folder(), "keys.json");
    await generateKeyFile(path);
    const current = await reloadingKeys(path);
    await addCompartmentKey(path, "agent:scribe");
    const all = await Promise.all([current(), current(), current()]);
    expect(all[1]).toBe(all[0]);
    expect(all[2]).toBe(all[0]);

    await chmod(path, 0o604);
    const first = await current().catch((error: unknown) => error);
    expect(first).toEqual(refusal("mode"));
    // The same refusal, not a second read of the file.
    expect(await current().catch((error: unknown) => error)).toBe(first);
    await chmod(path, 0o600);
    expect([...(await current()).compartments.keys()]).toEqual(["own", "agent:scribe"]);
  });
});

// The two key files: the general file, which never holds a restricted key, and the restricted root,
// which holds restricted keys and nothing else.
describe("the restricted key file", () => {
  // A general file and a restricted file with health's key, in a fresh folder.
  async function both(): Promise<{ dir: string; general: string; restricted: string }> {
    const dir = await folder();
    const general = join(dir, "keys.json");
    const restricted = join(dir, "restricted-keys.json");
    await generateKeyFile(general);
    await addCompartmentKey(general, "restricted:health", restricted);
    return { dir, general, restricted };
  }

  it("a general file with a restricted key is refused", async () => {
    const { general } = await both();
    // The control: the general file as written loads, and holds no restricted key.
    expect([...(await loadKeys(general)).compartments.keys()]).toEqual(["own"]);
    const withRestricted = await rewritten(general, "keys.json", (file) => {
      file.compartments["restricted:health"] = file.compartments.own;
      file.check["restricted:health"] = file.check.own;
    });
    await expect(loadKeys(withRestricted)).rejects.toEqual(refusal("format"));
    await expect(generateKeyFile(join(await folder(), "keys.json"), ["own", "restricted:health"])).rejects.toEqual(
      refusal("format"),
    );
  });

  it("a restricted file with an own key or a fingerprint key is refused", async () => {
    const { general, restricted } = await both();
    // The control: both load, and the keys are the two files' together.
    const keys = await loadKeys(general, restricted);
    expect([...keys.compartments.keys()].sort()).toEqual(["own", "restricted:health"]);
    expect(keys.fingerprintKey.equals((await loadKeys(general)).fingerprintKey)).toBe(true);
    const generalFile = JSON.parse(await readFile(general, "utf8")) as KeyFileJson;
    for (const change of [
      (file: KeyFileJson) => {
        file.compartments.own = generalFile.compartments.own;
        file.check.own = generalFile.check.own;
      },
      (file: KeyFileJson) => void (file.fingerprint = generalFile.fingerprint),
      (file: KeyFileJson) => void (file.fingerprintCheck = generalFile.fingerprintCheck),
    ]) {
      await expect(loadKeys(general, await rewritten(restricted, "restricted-keys.json", change))).rejects.toEqual(
        refusal("format"),
      );
    }
    // A restricted key whose check fails is refused as the general file's would be.
    const swapped = await rewritten(restricted, "restricted-keys.json", (file) => {
      file.compartments["restricted:health"] = generalFile.compartments.own;
    });
    await expect(loadKeys(general, swapped)).rejects.toEqual(refusal("check"));
  });

  it("a restricted file readable by its group is refused", async () => {
    const { general, restricted } = await both();
    await expect(loadKeys(general, restricted)).resolves.toBeDefined();
    for (const mode of [0o640, 0o604, 0o620, 0o660]) {
      await chmod(restricted, mode);
      await expect(loadKeys(general, restricted)).rejects.toEqual(refusal("mode"));
      await expect(addCompartmentKey(general, "restricted:money", restricted)).rejects.toEqual(refusal("mode"));
    }
    await chmod(restricted, 0o600);
    await expect(loadKeys(general, restricted)).resolves.toBeDefined();
  });

  it("the general file readable by group pi is accepted, and by others refused", async () => {
    const { general, restricted } = await both();
    await chmod(general, 0o640);
    await expect(loadKeys(general)).resolves.toBeDefined();
    await expect(loadKeys(general, restricted)).resolves.toBeDefined();
    for (const mode of [0o644, 0o660, 0o604]) {
      await chmod(general, mode);
      await expect(loadKeys(general)).rejects.toEqual(refusal("mode"));
    }
  });

  it("add-compartment restricted:health creates the restricted file with its check, and refuses with restricted_key_file_unset when no path is given", async () => {
    const dir = await folder();
    const general = join(dir, "keys.json");
    const restricted = join(dir, "restricted-keys.json");
    await generateKeyFile(general);
    const before = await readFile(general, "utf8");
    await expect(addCompartmentKey(general, "restricted:health")).rejects.toEqual(refusal("restricted_key_file_unset"));
    expect(await readdir(dir)).toEqual(["keys.json"]);

    await addCompartmentKey(general, "restricted:health", restricted);
    // The general file is untouched, and the restricted file is new, 0600, with its own check.
    expect(await readFile(general, "utf8")).toBe(before);
    expect((await readdir(dir)).sort()).toEqual(["keys.json", "restricted-keys.json"]);
    expect((await stat(restricted)).mode & 0o777).toBe(0o600);
    const file = JSON.parse(await readFile(restricted, "utf8")) as KeyFileJson;
    expect(Object.keys(file).sort()).toEqual(["check", "compartments", "version"]);
    expect(Object.keys(file.compartments)).toEqual(["restricted:health"]);
    expect(Object.keys(file.check)).toEqual(["restricted:health"]);
    expect([...(await loadKeys(general, restricted)).compartments.keys()].sort()).toEqual(["own", "restricted:health"]);
    // A key that is not restricted still goes to the general file, with or without the path.
    await addCompartmentKey(general, "employer:example", restricted);
    expect([...(await loadKeys(general)).compartments.keys()]).toEqual(["own", "employer:example"]);
    expect(Object.keys((JSON.parse(await readFile(restricted, "utf8")) as KeyFileJson).compartments)).toEqual([
      "restricted:health",
    ]);
  });

  it("a restricted path with no file yet gives the general file's keys alone", async () => {
    // Every category is off until the owner adds the first key, which makes the file.
    const dir = await folder();
    const general = join(dir, "keys.json");
    await generateKeyFile(general);
    const keys = await loadKeys(general, join(dir, "restricted-keys.json"));
    expect([...keys.compartments.keys()]).toEqual(["own"]);
    expect(keys.fingerprintKey.equals((await loadKeys(general)).fingerprintKey)).toBe(true);
    // A restricted file that is there but refused is still refused.
    await writeFile(join(dir, "restricted-keys.json"), "{", { mode: 0o600 });
    await expect(loadKeys(general, join(dir, "restricted-keys.json"))).rejects.toEqual(refusal("format"));
  });

  it("a second add to the restricted file keeps the first key", async () => {
    const { general, restricted } = await both();
    const first = (await loadKeys(general, restricted)).compartments.get("restricted:health");
    await addCompartmentKey(general, "restricted:money", restricted);
    const keys = await loadKeys(general, restricted);
    expect([...keys.compartments.keys()].sort()).toEqual(["own", "restricted:health", "restricted:money"]);
    expect(keys.compartments.get("restricted:health")).toBe(first);
    expect((await stat(restricted)).mode & 0o777).toBe(0o600);
    await expect(addCompartmentKey(general, "restricted:money", restricted)).rejects.toEqual(refusal("exists"));
  });

  // pirestricted rewrites the general file but is not in its group, pi: with the folder
  // giving a new file that group, the rewrite asks for no change of group, which it could not make.
  it("a rewrite whose new file already has the old file's group changes no group", async () => {
    const { general } = await both();
    await chmod(general, 0o640);
    const handle = await open(general, "r");
    const prototype = Object.getPrototypeOf(handle) as { chown: (...args: unknown[]) => Promise<void> };
    await handle.close();
    const chown = vi.spyOn(prototype, "chown").mockRejectedValue(Object.assign(new Error("EPERM"), { code: "EPERM" }));
    try {
      await addCompartmentKey(general, "employer:example");
      expect(chown).not.toHaveBeenCalled();
    } finally {
      chown.mockRestore();
    }
    expect((await stat(general)).mode & 0o777).toBe(0o640);
    expect([...(await loadKeys(general)).compartments.keys()]).toEqual(["own", "employer:example"]);
  });

  it("a rewrite of the general file keeps its group and its mode 0640", async () => {
    const { general } = await both();
    await chmod(general, 0o640);
    const before = await stat(general);
    await addCompartmentKey(general, "employer:example");
    const after = await stat(general);
    expect(after.mode & 0o777).toBe(0o640);
    expect(after.gid).toBe(before.gid);
    expect([...(await loadKeys(general)).compartments.keys()]).toEqual(["own", "employer:example"]);
  });
});

describe("fingerprint", () => {
  it("a fingerprint is stable, keyed, and differs by kind", async () => {
    const dir = await folder();
    const [one, two] = [join(dir, "one.json"), join(dir, "two.json")];
    await generateKeyFile(one);
    await generateKeyFile(two);
    const keys = await loadKeys(one);
    const otherKeys = await loadKeys(two);
    const address = "canary.person@example.test";

    // Stable: HMAC-SHA-256 under the fingerprint key over the kind, a zero byte and the value.
    const expected = createHmac("sha256", keys.fingerprintKey).update(`address\0${address}`, "utf8").digest("hex");
    expect(fingerprint(keys, "address", address)).toBe(expected);
    expect(fingerprint(await loadKeys(one), "address", address)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);

    expect(fingerprint(otherKeys, "address", address)).not.toBe(expected);

    // By kind: the same text under each kind gives six fingerprints.
    const kinds = ["address", "domain", "name", "source_id", "revision_tag", "thread"] as const;
    expect(new Set(kinds.map((kind) => fingerprint(keys, kind, "example.test"))).size).toBe(kinds.length);

    expect(fingerprint(keys, "address", "  Canary.Person@Example.TEST ")).toBe(expected);
    expect(fingerprint(keys, "domain", " Example.TEST. ")).toBe(fingerprint(keys, "domain", "example.test"));
    expect(fingerprint(keys, "name", "  Canary \t  PERSON\n")).toBe(fingerprint(keys, "name", "canary person"));
    expect(fingerprint(keys, "name", "Ｃanary Person")).toBe(fingerprint(keys, "name", "canary person"));
    for (const kind of ["source_id", "revision_tag", "thread"] as const) {
      expect(fingerprint(keys, kind, "Id-1")).not.toBe(fingerprint(keys, kind, "id-1"));
      expect(fingerprint(keys, kind, " id-1")).not.toBe(fingerprint(keys, kind, "id-1"));
    }
  });

  it("capture_scope fingerprints a bundle id and a host case-folded, the host without its trailing dot", async () => {
    const dir = await folder();
    const path = join(dir, "keys.json");
    await generateKeyFile(path);
    const keys = await loadKeys(path);
    const made = (value: string): string => fingerprint(keys, "capture_scope", value);
    expect(made("test.Example.Notes")).toBe(made("test.example.notes"));
    expect(made("Calendar.Example.TEST.")).toBe(made("calendar.example.test"));
    expect(made("calendar.example.test")).toBe(
      createHmac("sha256", keys.fingerprintKey).update("capture_scope\0calendar.example.test", "utf8").digest("hex"),
    );
    // The control: another value, and the same value under another kind, differ.
    expect(made("calendar.example.org")).not.toBe(made("calendar.example.test"));
    expect(fingerprint(keys, "host", "calendar.example.test")).not.toBe(made("calendar.example.test"));
  });

  // The payload kind and the reveal kind, each normalized unchanged. A sealed Gmail label, over the
  // account id, a space and the label id, taken as it is.
  it("the gmail_label fingerprint takes its value unchanged and differs from the same text under another kind", async () => {
    const dir = await folder();
    const path = join(dir, "keys.json");
    await generateKeyFile(path);
    const keys = await loadKeys(path);
    const value = "acc_01JABCDEFGHJKMNPQRSTVWXYZ0 Label_12";
    const expected = createHmac("sha256", keys.fingerprintKey).update(`gmail_label\0${value}`, "utf8").digest("hex");
    expect(fingerprint(keys, "gmail_label", value)).toBe(expected);
    expect(fingerprint(keys, "gmail_label", value.toLowerCase())).not.toBe(expected);
    expect(fingerprint(keys, "gmail_label", ` ${value}`)).not.toBe(expected);
    expect(fingerprint(keys, "source_id", value)).not.toBe(expected);
  });

  it("the payload fingerprint of a value differs from its content_hash fingerprint, and is the same on every call", async () => {
    const dir = await folder();
    const path = join(dir, "keys.json");
    await generateKeyFile(path);
    const keys = await loadKeys(path);
    const hash = "ab".repeat(32);
    const payload = fingerprint(keys, "payload", hash);
    expect(payload).toMatch(/^[0-9a-f]{64}$/);
    expect(payload).not.toBe(fingerprint(keys, "content_hash", hash));
    expect(fingerprint(keys, "payload", hash)).toBe(payload);
    expect(fingerprint(await loadKeys(path), "payload", hash)).toBe(payload);
    expect(payload).toBe(createHmac("sha256", keys.fingerprintKey).update(`payload\0${hash}`, "utf8").digest("hex"));
  });

  it("the reveal fingerprint is its own kind and normalizes nothing", async () => {
    const dir = await folder();
    const path = join(dir, "keys.json");
    await generateKeyFile(path);
    const keys = await loadKeys(path);
    const text = "reveal\nab\nclm_1,clm_2";
    const reveal = fingerprint(keys, "reveal", text);
    expect(reveal).not.toBe(fingerprint(keys, "payload", text));
    expect(reveal).toBe(createHmac("sha256", keys.fingerprintKey).update(`reveal\0${text}`, "utf8").digest("hex"));
    expect(fingerprint(keys, "reveal", ` ${text}`)).not.toBe(reveal);
    expect(fingerprint(keys, "reveal", text.toUpperCase())).not.toBe(reveal);
  });

  it("one value under the four new kinds gives four fingerprints", async () => {
    const dir = await folder();
    const path = join(dir, "keys.json");
    await generateKeyFile(path);
    const keys = await loadKeys(path);
    const value = "0f".repeat(32);
    const kinds = ["claim", "fact", "model_input", "belief_state"] as const;
    const made = kinds.map((kind) => fingerprint(keys, kind, value));
    expect(new Set(made).size).toBe(4);
    // Each is the formula's, over the value unchanged: no kind normalizes it.
    for (const kind of kinds) {
      expect(fingerprint(keys, kind, value)).toBe(
        createHmac("sha256", keys.fingerprintKey).update(`${kind}\0${value}`, "utf8").digest("hex"),
      );
      expect(fingerprint(keys, kind, ` ${value.toUpperCase()}`)).not.toBe(fingerprint(keys, kind, value));
    }
    // And none is the fingerprint of the same value under a stage 1 kind.
    expect(made).not.toContain(fingerprint(keys, "content_hash", value));
  });

  // The memory_projection kind.
  it("the memory_projection fingerprint takes its value unchanged and differs from every other kind's", async () => {
    const dir = await folder();
    const path = join(dir, "keys.json");
    await generateKeyFile(path);
    const keys = await loadKeys(path);
    const value = `cli_0000000000000000000000001\n${"0f".repeat(32)}\n{"kind":"commitment"}\nactive_memory@1`;
    const made = fingerprint(keys, "memory_projection", value);
    expect(made).toBe(
      createHmac("sha256", keys.fingerprintKey).update(`memory_projection\0${value}`, "utf8").digest("hex"),
    );
    expect(fingerprint(keys, "memory_projection", ` ${value}`)).not.toBe(made);
    for (const kind of ["fact", "belief_state", "claim", "content_hash"] as const)
      expect(fingerprint(keys, kind, value)).not.toBe(made);
  });

  it("mirror_projection fingerprints as memory-adapters's memory projection does, under its own kind", async () => {
    const dir = await folder();
    const path = join(dir, "keys.json");
    await generateKeyFile(path);
    const keys = await loadKeys(path);
    const value = `cli_0000000000000000000000001\nemployer:example,own\nlens_mirror@1\nentities\nent_0000000000000000000000001`;
    const made = fingerprint(keys, "mirror_projection", value);
    expect(made).toBe(
      createHmac("sha256", keys.fingerprintKey).update(`mirror_projection\0${value}`, "utf8").digest("hex"),
    );
    expect(made).toMatch(/^[0-9a-f]{64}$/);
    // Unchanged: no case folding, trimming or other normalization, as memory_projection's.
    expect(fingerprint(keys, "mirror_projection", ` ${value}`)).not.toBe(made);
    expect(fingerprint(keys, "mirror_projection", value.toUpperCase())).not.toBe(made);
    // Its own kind: the same value under memory_projection, or any other kind, differs.
    expect(fingerprint(keys, "memory_projection", value)).not.toBe(made);
    for (const kind of ["fact", "belief_state", "claim", "content_hash", "anchor"] as const)
      expect(fingerprint(keys, kind, value)).not.toBe(made);
    // The control: the same value under the same kind is the same on every call and every load.
    expect(fingerprint(await loadKeys(path), "mirror_projection", value)).toBe(made);
  });

  it("phone fingerprints an E.164 number unchanged, under its own kind", async () => {
    const dir = await folder();
    const path = join(dir, "keys.json");
    await generateKeyFile(path);
    const keys = await loadKeys(path);
    const made = fingerprint(keys, "phone", "+15555550101");
    expect(made).toBe(createHmac("sha256", keys.fingerprintKey).update("phone\0+15555550101", "utf8").digest("hex"));
    for (const kind of ["address", "name", "source_id"] as const)
      expect(fingerprint(keys, kind, "+15555550101")).not.toBe(made);
    expect(fingerprint(keys, "phone", " +15555550101")).not.toBe(made);
  });

  // memory_line and memory_locator: identity normalization, since the store normalizes a line before it
  // is fingerprinted, and a locator is taken as it is.
  it("the memory_line and memory_locator fingerprints take their values unchanged and differ from each other's and memory_projection's", async () => {
    const dir = await folder();
    const path = join(dir, "keys.json");
    await generateKeyFile(path);
    const keys = await loadKeys(path);
    const value = "- Commitment, open. Owed to the owner by someone not named. Due 2026-10-09.";
    for (const kind of ["memory_line", "memory_locator"] as const) {
      expect(fingerprint(keys, kind, value), kind).toBe(
        createHmac("sha256", keys.fingerprintKey).update(`${kind}\0${value}`, "utf8").digest("hex"),
      );
      expect(fingerprint(keys, kind, ` ${value}`), kind).not.toBe(fingerprint(keys, kind, value));
    }
    const made = ["memory_line", "memory_locator", "memory_projection"].map((kind) =>
      fingerprint(keys, kind as "memory_line", value),
    );
    expect(new Set(made).size).toBe(3);
  });
});

// The copy `pi send` is handed.
describe("the narrowed key file", () => {
  it("the narrowed copy's names are own and the key file's agent: names and no other", async () => {
    const dir = await folder();
    const path = join(dir, "keys.json");
    // No restricted key: the general file never holds one, and narrowKeyFile reads that file alone.
    await generateKeyFile(path, ["own", "public", "employer:acme", "agent:jev", "agent:luna"]);
    const copy = join(dir, "send-keys.json");
    await narrowKeyFile(path, copy, forSending);
    expect((await stat(copy)).mode & 0o777).toBe(0o600);
    const whole = await loadKeys(path);
    const narrowed = await loadKeys(copy);
    expect([...narrowed.compartments.keys()].sort()).toEqual(["agent:jev", "agent:luna", "own"]);
    // The same keys, and the same fingerprint key, so a fingerprint made with either is equal.
    for (const name of narrowed.compartments.keys())
      expect(narrowed.compartments.get(name)).toBe(whole.compartments.get(name));
    expect(fingerprint(narrowed, "address", "a@example.com")).toBe(fingerprint(whole, "address", "a@example.com"));
  });

  it("a narrowed copy is never written over a file that exists", async () => {
    const dir = await folder();
    const path = join(dir, "keys.json");
    await generateKeyFile(path);
    const copy = join(dir, "send-keys.json");
    await writeFile(copy, "", { mode: 0o600 });
    await expect(narrowKeyFile(path, copy, forSending)).rejects.toEqual(refusal("exists"));
  });

  it("narrowKeyText refuses a text whose checks fail, as loadKeys does", async () => {
    const dir = await folder();
    const [one, two] = [join(dir, "one.json"), join(dir, "two.json")];
    await generateKeyFile(one, ["own", "agent:jev"]);
    await generateKeyFile(two, ["own", "agent:jev"]);
    const whole = await readFile(one, "utf8");
    const other = JSON.parse(await readFile(two, "utf8")) as KeyFileJson;
    // The positive control: the text itself narrows.
    expect(() => narrowKeyText(whole, forSending)).not.toThrow();
    const changed = (change: (file: KeyFileJson) => void): string => {
      const file = JSON.parse(whole) as KeyFileJson;
      change(file);
      return JSON.stringify(file);
    };
    for (const [text, code] of [
      [changed((file) => void (file.compartments.own = other.compartments.own)), "check"],
      [changed((file) => void (file.fingerprint = other.fingerprint)), "check"],
      [changed((file) => void (file.check.own = file.check["agent:jev"])), "check"],
      // A compartment the narrowing drops is still checked: a bad key anywhere refuses the file.
      [changed((file) => void (file.compartments["agent:jev"] = other.compartments["agent:jev"])), "check"],
      ["", "format"],
      ["{", "format"],
      [changed((file) => void (file.version = 2)), "format"],
      [changed((file) => void delete file.fingerprintCheck), "format"],
    ] as const) {
      expect(() => narrowKeyText(text, forSending)).toThrow(expect.objectContaining({ name: "KeyFileRefused", code }));
      // loadKeys refuses the same text, written as a file, with the same code.
      const path = join(dir, "same.json");
      await writeFile(path, text, { mode: 0o600 });
      await expect(loadKeys(path)).rejects.toEqual(refusal(code));
      await rm(path);
    }
  });

  it("narrowKeyText gives the copy narrowKeyFile writes", async () => {
    const dir = await folder();
    const path = join(dir, "keys.json");
    await generateKeyFile(path, ["own", "public", "employer:acme", "agent:jev"]);
    const copy = join(dir, "send-keys.json");
    await narrowKeyFile(path, copy, forSending);
    expect(narrowKeyText(await readFile(path, "utf8"), forSending)).toBe(await readFile(copy, "utf8"));
  });

  it("only own and names beginning agent: are kept for sending", () => {
    expect(
      ["own", "agent:jev", "public", "employer:acme", "restricted:x", "agent", "owner"].filter(forSending),
    ).toEqual(["own", "agent:jev"]);
  });
});
